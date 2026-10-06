/**
 * Agent Skills — keep skills on disk in sync as delivery changes.
 *
 * `writeSkills` is a one-shot reconcile of what the store holds now.
 * `watchSkills` re-runs it whenever the store reports a change, so with `'*'` a
 * skill revoked in LaunchDarkly is removed from disk within a debounce interval
 * rather than at the next restart. With an explicit list, an `absent` skill stays
 * requested (an `error` action, not pruned), and flag changes are not watched.
 *
 * `onUnavailable: 'keep'` remains the default, so an outage never deletes the
 * application's skill files.
 */

import { getStore, SKILL_OBJECT_KIND } from './skills-core.js';
import { type WriteSkillsOptions, writeSkills } from './skills-fs.js';
import type { ReconcileReport, Skill, SkillReference, SkillStore } from './types.js';

/**
 * Default debounce, in milliseconds: how long to wait after a change before
 * reconciling, so a payload of many skills triggers one reconcile, not one each.
 */
export const DEFAULT_DEBOUNCE_MS = 500;

/** Options for {@link watchSkills}: every {@link WriteSkillsOptions} field, plus these. */
export type WatchSkillsOptions = WriteSkillsOptions & {
  /**
   * Milliseconds to wait after a change before reconciling. Must be a
   * non-negative finite number. Default {@link DEFAULT_DEBOUNCE_MS}.
   */
  debounceMs?: number;
  /**
   * Called with each re-reconcile's report (not the initial one). May be
   * `async`; a throw or rejection is logged and does not stop the watcher.
   */
  onReconcile?: (report: ReconcileReport) => unknown;
};

function error(message: string): void {
  // biome-ignore lint/suspicious/noConsole: this package has no logger abstraction; a failing reconcile must be visible
  console.error(`[LaunchDarkly] ${message}`);
}

/**
 * A running watch. Returned by {@link watchSkills}; stop it with `close`.
 *
 * **One watcher per root.** Don't point two watchers at the same root or run
 * `writeSkills` on a watched root concurrently: interleaved reconciles can lose
 * manifest entries. The watcher serialises its own reconciles only.
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
   * Called from the delivery task, so it must not block on filesystem work.
   * The argument is ignored: any change triggers a full reconcile.
   */
  readonly notify = (): void => {
    if (this.closed) return;
    // Restart the timer, so a burst collapses into one reconcile of the settled state.
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
    // Chain, never overlap: concurrent reconciles of one root lose manifest entries.
    this.running = this.running.then(async () => {
      this.pending = false;
      await this.reconcileOnce();
    });
  }

  /**
   * Runs the initial reconcile on the watcher's chain and returns its report.
   * Called once by {@link watchSkills}.
   *
   * A change delivered meanwhile queues behind it. Errors propagate, and the run
   * does not count toward {@link reconciles}.
   */
  async runInitial(): Promise<ReconcileReport> {
    const run = this.running.then(() => writeSkills(this.request, this.root, this.options));
    // Keep the chain alive past a rejection; the caller still gets `run`.
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
      // Log and keep watching; dying here would silently stop revocations.
      error(
        `A skill re-reconcile threw; the watcher continues: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
      return;
    }
    this.completed += 1;
    if (this.onReconcile) {
      try {
        // Awaited inside the try, so an async rejection is logged too.
        await Promise.resolve(this.onReconcile(report));
      } catch (cause) {
        error(`A watchSkills callback threw: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
    }
  }

  /** Number of re-reconciles completed, excluding the initial one. */
  get reconciles(): number {
    return this.completed;
  }

  /**
   * Stops watching. Idempotent; leaves files on disk as they are.
   *
   * Detaches from the store (when it has `removeListener`; a throw there is
   * logged, not rethrown), then awaits any in-flight reconcile rather than
   * interrupting it mid-write.
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
 * Takes the same arguments as `writeSkills`, plus `debounceMs` and `onReconcile`
 * (see {@link WatchSkillsOptions}).
 *
 * Errors from the initial `writeSkills` (e.g. a bad root) propagate, so you can
 * fail fast exactly as with `writeSkills`. If the store has no `removeListener`,
 * a closed watcher stays registered with the store for the store's lifetime.
 *
 * @returns The initial reconcile's report and a {@link SkillWatcher} to close
 *   when done:
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
 * @throws Error if no store is configured, or the store has no `addListener`
 *   (use `writeSkills` for a one-shot reconcile).
 * @throws Error if `debounceMs` is negative, `NaN`, or infinite.
 */
export async function watchSkills(
  skills: ReadonlyArray<Skill | SkillReference | string> | '*',
  root: string,
  options: WatchSkillsOptions = {},
): Promise<{ report: ReconcileReport; watcher: SkillWatcher }> {
  const store = getStore();
  if (store === null) {
    throw new Error('watchSkills needs a configured skill store. Configure one with setSkillStore(store).');
  }
  if (typeof store.addListener !== 'function') {
    throw new Error(
      'watchSkills needs a skill store that implements addListener(kind, fn); the configured store does not, so ' +
        'delivery changes cannot be observed. Use writeSkills for a one-shot reconcile, or configure a store with a ' +
        'delivery transport (FDv2SkillStore).',
    );
  }

  // A bare `< 0` check misses `NaN`, which `setTimeout` treats as ~0 (no debouncing).
  const { debounceMs = DEFAULT_DEBOUNCE_MS, onReconcile, ...writeOptions } = options;
  if (typeof debounceMs !== 'number' || !Number.isFinite(debounceMs) || debounceMs < 0) {
    // `String`, because `JSON.stringify(NaN)` is `null`.
    const shown = typeof debounceMs === 'number' ? String(debounceMs) : JSON.stringify(debounceMs);
    throw new Error(`debounceMs must be a non-negative, finite number of milliseconds, got ${shown}`);
  }

  const watcher = new SkillWatcher(store, skills, root, writeOptions, debounceMs, onReconcile);

  // Attach the listener before the initial reconcile, so a change delivered
  // during it is still seen (nothing re-reconciles on a timer).
  store.addListener(SKILL_OBJECT_KIND, watcher.notify);

  // A failed initial reconcile throws to the caller, who gets no watcher to
  // close, so detach the listener here.
  let report: ReconcileReport;
  try {
    report = await watcher.runInitial();
  } catch (cause) {
    await watcher.close();
    throw cause;
  }
  return { report, watcher };
}
