/**
 * Process-wide behavior defaults: {@link configure} and the resolvers the SDK reads them through.
 *
 * The state lives on the lifecycle singleton (the `Symbol.for('@launchdarkly/ai-server:singleton')`
 * slot on `globalThis` that also holds the LaunchDarkly client), not on `globalRegistry`, so every
 * module instance of this package in one process sees the same options. It is kept in its own
 * module, rather than in `lifecycle.ts`, so the handler paths that read it do not depend on the
 * client lifecycle. `shutdown()` restores the built-in defaults through {@link resetSdkOptions}.
 */

import type { ProviderHandler, SDKOptions } from './types.js';

const SINGLETON_KEY = Symbol.for('@launchdarkly/ai-server:singleton');

/** {@link SDKOptions} with every default filled in. */
type ResolvedSDKOptions = Required<SDKOptions>;

interface OptionsState {
  /** The options from the latest accepted `configure`, or the built-in defaults. */
  sdkOptions?: ResolvedSDKOptions;
  /**
   * Latches on the first AI invocation, so a later `configure` cannot change what a running process
   * already started using.
   */
  aiInvoked?: boolean;
}

const BUILT_IN_OPTIONS: ResolvedSDKOptions = Object.freeze({ captureContent: true });

function state(): OptionsState {
  // biome-ignore lint/suspicious/noExplicitAny: symbol-keyed property on globalThis has no typed accessor
  const g = globalThis as any;
  // Same initial shape `lifecycle.ts` creates, so whichever module touches the slot first, the
  // other finds what it expects.
  if (!g[SINGLETON_KEY]) g[SINGLETON_KEY] = { client: null, initPromise: null };
  return g[SINGLETON_KEY];
}

const currentOptions = (): ResolvedSDKOptions => state().sdkOptions ?? BUILT_IN_OPTIONS;

/**
 * Sets process-wide SDK behavior defaults.
 *
 * Call once from process startup, before the first AI invocation, with an {@link SDKOptions} value
 * the process owns. Do not build it from request data. Handlers built without an explicit
 * `captureContent` read the configured value when they run, including handlers built before this
 * call.
 *
 * A later call may replace the options until the first AI invocation (a handler call, or the start
 * of a handler's stream). After that, identical options are accepted and different ones throw.
 * `shutdown()` restores the built-in defaults and allows configuration again.
 *
 * `initClient` is unchanged: it only initializes the LaunchDarkly client and telemetry.
 *
 * @example
 * ```ts
 * import { configure } from '@launchdarkly/ai-server';
 *
 * // Keep prompts, model output and tool payloads off every span unless a handler opts in.
 * configure({ options: { captureContent: false } });
 * ```
 */
export function configure({ options }: { options: SDKOptions }): void {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('configure() options must be an SDKOptions object');
  }
  const { captureContent = BUILT_IN_OPTIONS.captureContent } = options;
  if (typeof captureContent !== 'boolean') {
    throw new TypeError('SDKOptions.captureContent must be a boolean');
  }
  const next: ResolvedSDKOptions = Object.freeze({ captureContent });
  const s = state();
  if (s.aiInvoked && next.captureContent !== currentOptions().captureContent) {
    throw new Error(
      'SDK options cannot change after the first AI invocation. shutdown() restores the built-in defaults.',
    );
  }
  s.sdkOptions = next;
}

/**
 * Resolves content capture for one invocation.
 *
 * An explicit `true` or `false` (from a convenience wrapper, then from the handler factory) wins.
 * `undefined` reads the configured default, which itself defaults to `true`. An explicit `false`
 * removes conversation content everywhere, including on offline evaluation spans.
 *
 * Internal: not exported from an entry point.
 */
export function effectiveCaptureContent(override: boolean | undefined): boolean {
  return typeof override === 'boolean' ? override : currentOptions().captureContent;
}

/**
 * Content capture for a call made through `handler`: its own effective value when it has one
 * (anything built with `createHandler` does), otherwise the process default. A plain function has
 * no handler flag, so it follows the process default.
 *
 * Internal: not exported from an entry point.
 */
export const captureContentFor = (handler: ProviderHandler | undefined): boolean =>
  effectiveCaptureContent(typeof handler?.captureContent === 'boolean' ? handler.captureContent : undefined);

/**
 * Latches the process so `configure` can no longer change options. Every handler built with
 * `createHandler` calls it when invoked, its stream calls it when the stream starts, and the SDK
 * calls it before each handler invocation it makes, so a plain function handler latches too.
 *
 * Internal: not exported from an entry point.
 */
export function noteAiInvocation(): void {
  state().aiInvoked = true;
}

/**
 * Restores the built-in defaults and clears the invocation lock. Called by `shutdown()`.
 *
 * Internal: not exported from an entry point.
 */
export function resetSdkOptions(): void {
  const s = state();
  s.sdkOptions = BUILT_IN_OPTIONS;
  s.aiInvoked = false;
}
