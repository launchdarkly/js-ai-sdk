/**
 * Agent Skills — re-reconcile on delivery, so revocation does not wait for a restart.
 *
 * `writeSkills` is a one-shot reconcile: it materializes what the store holds
 * now. This module re-runs it whenever the store reports a change, so a
 * `delete-object` that reaches a live connection takes a skill's `SKILL.md` off
 * disk within a debounce interval rather than at the next process restart.
 *
 * `onUnavailable: 'keep'` stays the default: an outage must not read as
 * "everything was revoked". A watcher that pruned on a failed retrieval would
 * convert every transport blip into deletion of a customer's skill files.
 *
 * Layering: this module sits *above* `skills-fs.ts` and calls `writeSkills`
 * without modifying it. Nothing in the reconcile, the accessors, or verification
 * knows this file exists.
 */

import { getStore, SKILL_OBJECT_KIND } from './skills-core.js';
import { type WriteSkillsOptions, writeSkills } from './skills-fs.js';
import type { ReconcileReport, Skill, SkillReference, SkillStore } from './types.js';

/**
 * How long a change waits for its neighbours before a reconcile runs.
 *
 * A full payload transfer commits many objects at once and the listener fires per
 * object, so without coalescing a payload of forty skills would run forty
 * reconciles against one root. Half a second is far below the seconds-scale
 * latency this feature is trying to achieve and far above the microseconds a
 * commit's listener calls take.
 */
export const DEFAULT_DEBOUNCE_MS = 500;

export type WatchSkillsOptions = WriteSkillsOptions & {
  /** Coalescing window, in **milliseconds**. Default {@link DEFAULT_DEBOUNCE_MS}. */
  debounceMs?: number;
  /**
   * Called with each re-reconcile's report — the ones delivery triggers, not
   * the initial reconcile, whose report `watchSkills` returns directly. May be
   * `async`; a throw or a rejection is logged, not thrown, and does not stop
   * the watcher.
   */
  onReconcile?: (report: ReconcileReport) => unknown;
};

function error(message: string): void {
  // biome-ignore lint/suspicious/noConsole: this package has no logger abstraction; a failing reconcile must be visible
  console.error(`[LaunchDarkly] ${message}`);
}

/**
 * A running re-reconcile. Returned by {@link watchSkills}; stop it with `close`.
 *
 * One watcher owns one root. **Do not point two watchers at the same root**, and
 * do not run `writeSkills` against a watched root concurrently: the reconcile's
 * own contract is one root, one reconcile at a time, because two interleaved runs
 * lose the loser's manifest entries and leave the files it wrote unmanaged. This
 * class enforces that for its *own* reconciles — they are chained, never
 * overlapped — and cannot enforce it against a caller who reconciles the same
 * root by hand.
 */
export class SkillWatcher {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> = Promise.resolve();
  private pending = false;
  private closed = false;
  private completed = 0;

  constructor(
    private readonly store: SkillStore,
    private readonly request: ReadonlyArray<Skill | SkillReference | string> | '*',
    private readonly root: string,
    private readonly options: WriteSkillsOptions,
    private readonly debounceMs: number,
    private readonly onReconcile?: (report: ReconcileReport) => unknown,
  ) {}

  /**
   * The store's change listener. Schedules a reconcile; runs nothing inline.
   *
   * Deliberately trivial. It is called from the delivery task, where a reconcile
   * — which does filesystem I/O, an fsync per file, and a manifest rewrite —
   * would stall event processing for the duration and, on a stream, let the
   * connection's read buffer back up behind a disk write. The argument is
   * ignored: a put's raw object and a revocation's tombstone both mean the same
   * thing here, which is "the store is not what it was".
   */
  readonly notify = (): void => {
    if (this.closed) return;
    // Restarting the timer rather than letting the first one win is what makes a
    // burst collapse into one reconcile that sees the *settled* state.
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.schedule();
    }, this.debounceMs);
    (this.timer as unknown as { unref?: () => void }).unref?.();
  };

  private schedule(): void {
    if (this.closed) return;
    if (this.pending) return;
    this.pending = true;
    // Chained onto whatever is already running: two concurrent reconciles of one
    // root interleave on the manifest and lose entries.
    this.running = this.running.then(async () => {
      this.pending = false;
      await this.reconcileOnce();
    });
  }

  /**
   * Runs the first reconcile inside the watcher's own chain, and returns its report.
   *
   * Sharing the chain lets {@link watchSkills} register the change listener
   * *before* this runs: a payload that commits during the reconcile's filesystem
   * I/O still reaches the watcher, and queues behind this run rather than
   * reconciling the same root concurrently.
   *
   * Unlike {@link reconcileOnce} the failure propagates — a bad root or a corrupt
   * manifest is `watchSkills`'s to throw — and does not count toward
   * {@link reconciles}, which reports re-reconciles only.
   */
  async runInitial(): Promise<ReconcileReport> {
    const run = this.running.then(() => writeSkills(this.request, this.root, this.options));
    // The chain itself must survive a rejection: a rejected `running` would
    // reject every reconcile chained after it. The caller still gets `run`.
    this.running = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async reconcileOnce(): Promise<void> {
    if (this.closed) return;
    let report: ReconcileReport;
    try {
      report = await writeSkills(this.request, this.root, this.options);
    } catch (cause) {
      // A watcher that died on one bad reconcile would silently stop tracking
      // revocations, which is worse than a noisy one.
      error(
        `A skill re-reconcile threw; the watcher continues: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
      return;
    }
    this.completed += 1;
    if (this.onReconcile) {
      try {
        // Awaited inside the try, so an `async` callback that rejects is logged
        // like a synchronous throw rather than left as an unhandled rejection.
        await Promise.resolve(this.onReconcile(report));
      } catch (cause) {
        error(`A watchSkills callback threw: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
    }
  }

  /**
   * How many re-reconciles have completed since the watcher started.
   *
   * Excludes the initial reconcile {@link watchSkills} awaits, which is the
   * caller's own result.
   */
  get reconciles(): number {
    return this.completed;
  }

  /**
   * Stops watching. Idempotent. Does not undo anything already on disk.
   *
   * Awaits an in-flight reconcile rather than abandoning one, because a reconcile
   * interrupted between its content writes and its manifest rewrite is the one
   * case the manifest format has to recover from — worth avoiding when we control
   * the timing.
   *
   * Marks the watcher closed and disarms the timer *before* detaching, so a
   * `removeListener` that throws cannot leave a watcher that is half-closed with
   * a reconcile still scheduled. Detaching is best effort: a failure is logged,
   * not thrown, and a store without the optional `removeListener` is left as it
   * is rather than failing the close. Either way no further change reaches a
   * watcher that is shutting down, because `notify` checks `closed` first.
   */
  async close(): Promise<void> {
    if (this.closed) {
      await this.running;
      return;
    }
    this.closed = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.detach();
    await this.running;
  }

  private detach(): void {
    if (typeof this.store.removeListener !== 'function') return;
    try {
      this.store.removeListener(SKILL_OBJECT_KIND, this.notify);
    } catch (cause) {
      error(
        `The skill store's removeListener threw while a watcher was closing; the watcher is closed regardless: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      );
    }
  }
}

/**
 * Reconciles now, then re-reconciles whenever delivery changes.
 *
 * Every option `writeSkills` takes means the same thing here and is passed
 * straight through; the reconcile's semantics are untouched. Resolves to the
 * initial reconcile's report — so a caller can fail fast on a bad root or a
 * corrupt manifest exactly as they would with `writeSkills` — paired with a
 * {@link SkillWatcher} to close when the process is done:
 *
 * ```ts
 * const { report, watcher } = await watchSkills('*', '.claude/skills');
 * try {
 *   // ...
 * } finally {
 *   await watcher.close();
 * }
 * ```
 *
 * A revocation delivered over a streaming connection then prunes the skill's
 * files within `debounceMs` of arriving, rather than at the next restart.
 *
 * Requires a store that implements the optional `addListener` half of the seam.
 * Throws when no store is configured, and when the configured store has no
 * `addListener` — the second case failing loudly rather than degrading to a
 * one-shot reconcile, because a watcher that silently never fires looks exactly
 * like a watcher whose skills never changed. The optional `removeListener` lets
 * `SkillWatcher.close` detach; a store without it keeps working, at the cost of
 * a listener that lives as long as the store does.
 */
export async function watchSkills(
  skills: ReadonlyArray<Skill | SkillReference | string> | '*',
  root: string,
  options: WatchSkillsOptions = {},
): Promise<{ report: ReconcileReport; watcher: SkillWatcher }> {
  const store = getStore();
  if (store === null) {
    throw new Error(
      'watchSkills needs a configured skill store. Configure one with initClient({ skillStore: store }).',
    );
  }
  if (typeof store.addListener !== 'function') {
    throw new Error(
      'watchSkills needs a skill store that implements addListener(kind, fn); the configured store does not, so ' +
        'delivery changes cannot be observed. Use writeSkills for a one-shot reconcile, or configure a store with a ' +
        'delivery transport (FDv2SkillStore).',
    );
  }

  // `NaN` is the case a `< 0` guard misses — `NaN < 0` is false — and it is not a
  // harmless one: `setTimeout(fn, NaN)` fires at 1 ms, which collapses the
  // coalescing window to nothing and reconciles once per *delivered object*. A
  // twelve-skill payload would then run twelve reconciles of one root. Guarded
  // the way `writeSkills` already guards its own `timeout`.
  const { debounceMs = DEFAULT_DEBOUNCE_MS, onReconcile, ...writeOptions } = options;
  if (typeof debounceMs !== 'number' || !Number.isFinite(debounceMs) || debounceMs < 0) {
    // `String` rather than `JSON.stringify` for the number case: the latter
    // serializes `NaN` as `null`, which names the wrong mistake.
    const shown = typeof debounceMs === 'number' ? String(debounceMs) : JSON.stringify(debounceMs);
    throw new Error(`debounceMs must be a non-negative, finite number of milliseconds, got ${shown}`);
  }

  const watcher = new SkillWatcher(store, skills, root, writeOptions, debounceMs, onReconcile);

  // The listener goes on before the first reconcile, so a payload committing
  // during that reconcile's filesystem I/O still reaches the watcher.
  store.addListener(SKILL_OBJECT_KIND, watcher.notify);

  // The initial reconcile is awaited, so its report is the caller's to inspect
  // and a bad root throws out of `watchSkills`. Nothing is left watching a root
  // that never reconciled, hence the close on the way out.
  let report: ReconcileReport;
  try {
    report = await watcher.runInitial();
  } catch (cause) {
    await watcher.close();
    throw cause;
  }
  return { report, watcher };
}
