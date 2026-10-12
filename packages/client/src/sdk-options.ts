import { reportUsage } from './sdk-usage.js';

/**
 * Process-wide defaults for the AI SDK.
 *
 * `SDKOptions` is the extension point for later defaults. Add a field here when
 * a new process-wide setting exists; do not add a second configure function.
 * A richer-stream setting belongs on this object once that protocol exists.
 */
export interface SDKOptions {
  /**
   * Default for whether prompts, completions, tool arguments, and tool results
   * are written onto spans.
   *
   * Omitted means the built-in default, `false`. This is a default, not a
   * ceiling: a handler factory or a per-call convenience wrapper can still
   * pass `true` or `false`. An explicit `false` overrides a configured `true`.
   */
  captureContent?: boolean;
}

const SINGLETON_KEY = Symbol.for('@launchdarkly/ai-server:singleton');

const SDK_OPTION_KEYS: Record<keyof SDKOptions, true> = {
  captureContent: true,
};

const CHANGED_AFTER_INVOCATION =
  '[LaunchDarkly] configure() cannot change SDK options after the first AI invocation. ' +
  'Call it once at process startup, before any model call, and not from request data. ' +
  'shutdown() restores the built-in defaults.';

interface OptionsState {
  /** Last options passed to `configure`. Absent fields mean the built-in default. */
  options?: SDKOptions;
  /** Set at the start of the first model call. Locks `configure` against changes. */
  aiInvoked?: boolean;
}

function state(): OptionsState {
  // biome-ignore lint/suspicious/noExplicitAny: symbol-keyed property on globalThis has no typed accessor
  const g = globalThis as any;
  // Same object `lifecycle.ts` stores the client on. Create the empty shape if
  // `configure` runs before `initClient`, so neither side clobbers the other.
  if (!g[SINGLETON_KEY]) {
    g[SINGLETON_KEY] = { client: null, initPromise: null };
  }
  return g[SINGLETON_KEY] as OptionsState;
}

function normalize(options: SDKOptions): SDKOptions {
  return options.captureContent === undefined ? {} : { captureContent: options.captureContent };
}

/** Effective content-capture default. New `SDKOptions` fields must be compared here too. */
function sameOptions(current: SDKOptions | undefined, next: SDKOptions): boolean {
  return (current?.captureContent ?? false) === (next.captureContent ?? false);
}

function warnOnUnknownOptions(options: SDKOptions): void {
  const unknown = Object.keys(options)
    .filter((key) => !Object.hasOwn(SDK_OPTION_KEYS, key))
    .sort();
  if (unknown.length > 0) {
    // biome-ignore lint/suspicious/noConsole: this package has no logger; an ignored option must be visible
    console.warn(`[LaunchDarkly] Ignoring unrecognized configure option(s): ${unknown.join(', ')}`);
  }
}

/**
 * Sets process-wide SDK defaults.
 *
 * Call this once at process startup, before the first model call. Handlers
 * that omit `captureContent` read the value here when they are invoked, so
 * `configure` may run before or after the handler is constructed. A different
 * value may replace this one until the first AI invocation. After that, only
 * an identical call is accepted. `shutdown()` restores the built-in defaults.
 *
 * Do not call this from request data. The options apply to every later call
 * in the process, not to one request.
 */
export function configure(options: SDKOptions): void {
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    throw new Error('[LaunchDarkly] configure() expects an SDKOptions object.');
  }
  if (options.captureContent !== undefined && typeof options.captureContent !== 'boolean') {
    throw new Error('[LaunchDarkly] configure() option captureContent must be a boolean.');
  }
  warnOnUnknownOptions(options);
  reportUsage('client.configure');

  const current = state();
  if (current.aiInvoked && !sameOptions(current.options, options)) {
    throw new Error(CHANGED_AFTER_INVOCATION);
  }
  current.options = normalize(options);
}

/**
 * The boolean a handler should pass into the existing content-capture gate.
 *
 * An explicit `true` or `false` is an override. `undefined` reads the
 * configured default, then the built-in `false`. Called at invocation time,
 * not when the handler is constructed, and marks the first AI invocation so
 * a later `configure` cannot change the defaults underneath a live process.
 *
 * @internal Exported for the LaunchDarkly handler packages.
 */
export function resolveCaptureContent(explicit?: boolean): boolean {
  const current = state();
  current.aiInvoked = true;
  if (explicit !== undefined) return explicit;
  return current.options?.captureContent ?? false;
}

/** Marks the first AI invocation without reading content-capture settings. */
export function noteAiInvocation(): void {
  state().aiInvoked = true;
}

/** `shutdown()` restores the built-in defaults and allows `configure` again. */
export function resetSdkOptions(): void {
  const current = state();
  current.options = undefined;
  current.aiInvoked = false;
}
