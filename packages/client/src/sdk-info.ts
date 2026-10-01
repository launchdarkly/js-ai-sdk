import type { LDClientInterface, LDContext } from './types.js';

/**
 * Reports which LaunchDarkly AI packages an application runs.
 *
 * Each package records its own name and version when it is imported. The
 * records are held until a LaunchDarkly client exists, then sent as one
 * `$ld:ai:sdk:info` event per package. A package reports at most once per
 * client.
 */

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

const SDK_INFO_LANGUAGE = 'javascript';

type PackageIdentity = { name: string; version: string };

type SdkInfoState = {
  known: Map<string, PackageIdentity>;
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
 * Marks every known package as unreported. Pass `{ clearKnown: true }` in tests
 * to empty the registered set as well.
 */
export function resetAiSdkInfo(options?: { clearKnown?: boolean }): void {
  const state = getState();
  state.reported.clear();
  if (options?.clearKnown) {
    state.known.clear();
  }
}
