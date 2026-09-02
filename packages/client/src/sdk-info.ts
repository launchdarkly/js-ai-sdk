import type { LDClientInterface, LDContext } from './types.js';

/**
 * Reports which LaunchDarkly AI packages an application runs.
 *
 * Each package records its own name and version when it is imported. The
 * records are held until a LaunchDarkly client exists, then sent as one
 * `$ld:ai:sdk:info` event per package. A package reports at most once per
 * client.
 */

// Use a Symbol.for key so the state is shared across all module instances of
// this package in the same process. Several packages each import
// @launchdarkly/ai-server through their own symlink and resolve separate module
// instances, but Symbol.for and globalThis cross those boundaries. The client
// singleton in `lifecycle.ts` uses the same approach for the same reason.
const SDK_INFO_KEY = Symbol.for('@launchdarkly/ai-server:sdk-info');

/** The event name that carries AI SDK package identity. */
export const SDK_INFO_EVENT = '$ld:ai:sdk:info';

/**
 * The context every sdk-info event is attributed to. It is anonymous and
 * identical for all applications, so these events never create a context in
 * the customer's environment.
 */
export const SDK_INFO_CONTEXT: LDContext = {
  kind: 'ld_ai',
  key: 'ld-internal-tracking',
  anonymous: true,
};

/** The language reported by every package in this repository. */
const SDK_INFO_LANGUAGE = 'javascript';

type PackageIdentity = { name: string; version: string };

type SdkInfoState = {
  /**
   * Every package registered in this process, keyed by `name@version`. A
   * package registers when it is imported, and an import runs once, so entries
   * are never removed.
   */
  known: Map<string, PackageIdentity>;
  /** Keys of the packages already sent to the current client. */
  reported: Set<string>;
};

function getState(): SdkInfoState {
  // biome-ignore lint/suspicious/noExplicitAny: symbol-keyed property on globalThis has no typed accessor
  const g = globalThis as any;
  if (!g[SDK_INFO_KEY]) {
    g[SDK_INFO_KEY] = { known: new Map(), reported: new Set() };
  }
  return g[SDK_INFO_KEY];
}

/**
 * Records a LaunchDarkly AI package so that its name and version reach
 * LaunchDarkly the next time a client is available.
 *
 * Call this once at module scope in a package's entry point. It is safe to
 * call more than once: a name and version pair produces at most one event per
 * client. Two different versions of the same package both report, which is
 * what a duplicated dependency looks like.
 */
export function registerAiSdkPackage(name: string, version: string): void {
  const state = getState();
  const id = `${name}@${version}`;
  if (state.known.has(id)) return;
  state.known.set(id, { name, version });
}

/**
 * Sends one `$ld:ai:sdk:info` event for every package that has not reported to
 * this client yet.
 *
 * `initClient()` calls this on every path that produces a client, including
 * the path that returns an already-initialized one. That path runs on every
 * AI call, so the common case must stay cheap — when every known package has
 * reported, this function compares two sizes and returns.
 */
export function flushAiSdkInfo(client: LDClientInterface): void {
  const state = getState();
  if (state.known.size === state.reported.size) return;

  for (const [id, { name, version }] of state.known) {
    if (state.reported.has(id)) continue;
    try {
      client.track(
        SDK_INFO_EVENT,
        SDK_INFO_CONTEXT,
        { aiSdkName: name, aiSdkVersion: version, aiSdkLanguage: SDK_INFO_LANGUAGE },
        1,
      );
    } catch {
      // Reporting which packages are installed must never break an AI call.
    }
    state.reported.add(id);
  }
}

/**
 * Marks every known package as unreported, so they report again on the next
 * flush. The set of known packages is kept, because module-scope registration
 * does not run a second time.
 *
 * `shutdown()` calls this. A shutdown ends the life of a client, so the next
 * client is a new one and deserves its own report. Note that `initClient()`
 * accepts a pre-initialized client and replaces the current one without a
 * shutdown; that path deliberately does not reset, because an edge runtime may
 * pass a fresh client on every request and must not report on every request.
 */
export function resetAiSdkInfo(): void {
  getState().reported.clear();
}
