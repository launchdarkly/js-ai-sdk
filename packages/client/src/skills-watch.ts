/**
 * Agent Skills — keep skills on disk in sync as delivery changes.
 *
 * `writeSkills` is a one-shot reconcile of what the store holds now.
 * `watchSkills` re-runs it whenever the store reports a change, so with `'*'` a
 * skill revoked in LaunchDarkly is removed from disk within a debounce interval
 * rather than at the next restart. With an explicit list, an `absent` skill stays
 * requested (an `error` action, not pruned), and config changes are not watched.
 * With a `SkillSource`, the watcher also re-reads the source whenever one of its
 * `configKeys` changes, so the files follow the config.
 *
 * `onUnavailable: 'keep'` remains the default, so an outage never deletes the
 * application's skill files.
 */

import { getClient } from './lifecycle.js';
import { reportUsage } from './sdk-usage.js';
import { getStore, SKILL_OBJECT_KIND } from './skills-core.js';
import { type WriteSkillsOptions, writeSkillsInternal } from './skills-fs.js';
import type { LDClientInterface, ReconcileReport, Skill, SkillReference, SkillSource, SkillStore } from './types.js';
import { createSkillSource, isSkillSource } from './types.js';

/**
 * Default debounce, in milliseconds: how long to wait after a change before
 * reconciling, so a payload of many skills triggers one reconcile, not one each.
 */
export const SKILLS_DEFAULT_DEBOUNCE_MS = 500;

/** Options for {@link watchSkills}: every {@link WriteSkillsOptions} field, plus these. */
export type WatchSkillsOptions = WriteSkillsOptions & {
  /**
   * Milliseconds to wait after a change before reconciling. Must be a
   * non-negative finite number. Default {@link SKILLS_DEFAULT_DEBOUNCE_MS}.
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
    private readonly request: ReadonlyArray<Skill | SkillReference | string> | '*' | SkillSource,
    private readonly root: string,
    private readonly options: WriteSkillsOptions,
    private readonly debounceMs: number,
    private readonly onReconcile?: (report: ReconcileReport) => unknown,
  ) {}

  /**
   * Schedules a reconcile through the same debounce as a store or config
   * change; runs nothing inline. Safe to call with no argument.
   *
   * The watcher's own store and config listeners call it. Call it yourself to
   * reconcile on a change the watcher cannot see, for example from your own
   * listener when you follow a config with an empty `configKeys`. Any argument
   * is ignored: every trigger runs a full reconcile. No-op once closed.
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
    const run = this.running.then(() => writeSkillsInternal(this.request, this.root, this.options));
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
      report = await writeSkillsInternal(this.request, this.root, this.options);
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
   * Detaches from the store (when it has `removeListener`) and from the base
   * client's config changes (when it has `off`); a throw there is logged, not
   * rethrown. Then awaits any in-flight reconcile rather than interrupting it
   * mid-write.
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
    for (const detach of configDetachers.get(this) ?? []) detach();
    configDetachers.delete(this);
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
 * How each watcher unsubscribes from config changes, run by `close`. Kept off
 * the class so following a config adds nothing to the watcher's public shape.
 */
const configDetachers = new WeakMap<SkillWatcher, Array<() => void>>();

/** The remedy every no-change-signal error names. */
const CONFIG_SIGNAL_REMEDY =
  'Initialize the AI client with a LaunchDarkly server SDK client (initClient()), or pass a SkillSource with an ' +
  'empty configKeys and call watcher.notify() from your own change listener.';

/**
 * The base client a source's `configKeys` are followed through.
 *
 * @throws Error when there is none, it has no `on`, or it reports itself
 *   offline: a watcher that never hears about config changes looks exactly like
 *   one whose config never changed.
 */
function configSignalClient(configKeys: readonly string[]): LDClientInterface {
  const shown = configKeys.map((key) => `'${key}'`).join(', ');
  let client: LDClientInterface;
  try {
    client = getClient();
  } catch {
    throw new Error(
      `watchSkills cannot follow changes to AI Config ${shown}: no AI client is initialized. ${CONFIG_SIGNAL_REMEDY}`,
    );
  }
  if (typeof client.on !== 'function') {
    throw new Error(
      `watchSkills cannot follow changes to AI Config ${shown}: the AI client has no on(event, listener) method, ` +
        `so it cannot report config changes. ${CONFIG_SIGNAL_REMEDY}`,
    );
  }
  let offline: boolean;
  try {
    offline = typeof client.isOffline === 'function' && client.isOffline() === true;
  } catch {
    offline = true;
  }
  if (offline) {
    throw new Error(
      `watchSkills cannot follow changes to AI Config ${shown}: the base client is offline, so it never reports ` +
        `config changes. ${CONFIG_SIGNAL_REMEDY}`,
    );
  }
  return client;
}

/** Subscribes `watcher` to `update:<key>` for each key, and records how to undo it. */
function followConfigs(watcher: SkillWatcher, client: LDClientInterface, configKeys: readonly string[]): void {
  // Only signals: the source is read on the watcher's chain, after the listener returns.
  const listener = (): void => watcher.notify();
  const on = client.on as NonNullable<LDClientInterface['on']>;
  const off = (
    typeof client.off === 'function'
      ? client.off
      : (client as { removeListener?: (event: string, fn: () => void) => unknown }).removeListener
  ) as ((event: string, fn: () => void) => unknown) | undefined;

  const detachers: Array<() => void> = [];
  configDetachers.set(watcher, detachers);
  for (const key of new Set(configKeys)) {
    const event = `update:${key}`;
    // Recorded before `on`, so if a later `on` throws, `close` still detaches this one.
    if (typeof off === 'function') {
      detachers.push(() => {
        try {
          off.call(client, event, listener);
        } catch (cause) {
          error(
            `The AI client's off threw while a watcher was closing; the watcher is closed regardless: ${
              cause instanceof Error ? cause.message : String(cause)
            }`,
          );
        }
      });
    }
    on.call(client, event, listener);
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
 * What reaches disk depends on the form of `skills`:
 *
 * - `'*'` follows the skill library: a deleted skill is pruned, and each key
 *   tracks its newest version.
 * - A fixed list never changes. If an AI Config moves a skill from v2 to v3,
 *   v2 stays on disk reported `error`, and v3 is never written. Use it only for
 *   a set that does not change for the process lifetime.
 * - A `SkillSource` (`configSkills` for one AI Config) is read again on every
 *   reconcile, and a change to one of its `configKeys` triggers one, through the
 *   base client's `update:<key>` events. A new version replaces the old file,
 *   and a skill the config stops referencing is pruned.
 *
 * A source with `configKeys` needs a base client that reports changes, and
 * the watcher subscribes before the initial reconcile. A client in daemon mode
 * (`useLdd: true`) passes that check but never reports changes, so the watcher
 * then follows skill-store changes only.
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
 * @throws Error if `skills` is a source with `configKeys` and no initialized AI
 *   client can report their changes: none is initialized, the client has no
 *   `on`, or `isOffline()` is true.
 * @throws TypeError if `skills` is a source whose `configKeys` is not an array
 *   of non-empty strings.
 */
export async function watchSkills(
  skills: ReadonlyArray<Skill | SkillReference | string> | '*' | SkillSource,
  root: string,
  options: WatchSkillsOptions = {},
): Promise<{ report: ReconcileReport; watcher: SkillWatcher }> {
  reportUsage('client.watchSkills');
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
  const { debounceMs = SKILLS_DEFAULT_DEBOUNCE_MS, onReconcile, ...writeOptions } = options;
  if (typeof debounceMs !== 'number' || !Number.isFinite(debounceMs) || debounceMs < 0) {
    // `String`, because `JSON.stringify(NaN)` is `null`.
    const shown = typeof debounceMs === 'number' ? String(debounceMs) : JSON.stringify(debounceMs);
    throw new Error(`debounceMs must be a non-negative, finite number of milliseconds, got ${shown}`);
  }

  // Re-validated, so a hand-built source with a bare-string `configKeys` fails
  // here rather than following one-character keys.
  const request = isSkillSource(skills) ? createSkillSource(skills) : skills;
  const configKeys = isSkillSource(request) ? request.configKeys : [];
  // Before anything is attached, so a raise leaves nothing registered.
  const configClient = configKeys.length > 0 ? configSignalClient(configKeys) : null;

  const watcher = new SkillWatcher(store, request, root, writeOptions, debounceMs, onReconcile);

  // Attach the listeners before the initial reconcile, so a change delivered
  // during it is still seen (nothing re-reconciles on a timer).
  store.addListener(SKILL_OBJECT_KIND, watcher.notify);
  if (configClient !== null) {
    try {
      followConfigs(watcher, configClient, configKeys);
    } catch (cause) {
      await watcher.close();
      throw cause;
    }
  }

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
