/**
 * Agent Skills — re-reconcile on delivery, so revocation does not wait for a restart.
 *
 * `writeSkills` is a one-shot reconcile: it materializes what the store holds
 * now. That was the whole story while the only transport was a hand-populated
 * store, and the design accordingly deferred an eager re-reconcile — revocation
 * would take effect at the next process restart, which the security review filed
 * as AV-1.
 *
 * A streaming FDv2 connection changes the premise. A `delete-object` reaches a
 * live connection in **seconds**, and the store already publishes a change
 * listener, so the gap between "LaunchDarkly revoked this skill" and "its
 * `SKILL.md` is off the agent's disk" collapses from a process lifetime to a
 * debounce interval. That is the single largest resilience improvement available
 * at this layer, which is why it is here rather than in a later phase.
 *
 * `onUnavailable: 'keep'` stays the default, deliberately and per the review: an
 * outage must not read as "everything was revoked". A watcher that pruned on a
 * failed retrieval would convert every transport blip into deletion of a
 * customer's skill files.
 *
 * Layering: this module sits *above* `skills-fs.ts` and calls `writeSkills`
 * without modifying it. Nothing in the reconcile, the accessors, or verification
 * knows this file exists.
 */

import { getStore, SKILL_OBJECT_KIND } from './skills-core.js';
import { type WriteSkillsOptions, writeSkills } from './skills-fs.js';
import type { ReconcileReport, Skill, SkillReference } from './types.js';

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
  /** Called with each re-reconcile's report. Exceptions are logged, not thrown. */
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
        this.onReconcile(report);
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
   */
  async close(): Promise<void> {
    this.closed = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.running;
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
 * like a watcher whose skills never changed.
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

  const { debounceMs = DEFAULT_DEBOUNCE_MS, onReconcile, ...writeOptions } = options;
  if (debounceMs < 0) throw new Error(`debounceMs must not be negative, got ${JSON.stringify(debounceMs)}`);

  // The initial reconcile runs first, so its report is the caller's to inspect
  // and a bad root throws out of `watchSkills` rather than into a log line.
  const report = await writeSkills(skills, root, writeOptions);

  const watcher = new SkillWatcher(skills, root, writeOptions, debounceMs, onReconcile);
  store.addListener(SKILL_OBJECT_KIND, watcher.notify);
  return { report, watcher };
}
