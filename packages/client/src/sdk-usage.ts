import { SDK_INFO_CONTEXT } from './sdk-info.js';
import type { LDClientInterface } from './types.js';
import { LD_AI_PACKAGE_NAME, LD_AI_PACKAGE_VERSION } from './version.js';

/**
 * Records which public AI SDK helpers an application calls.
 *
 * One `$ld:ai:sdk:usage` event per helper per client. A call made before a
 * client exists is held and sent on the next init, on the same path as
 * sdk-info. SDK code calls the non-reporting internal versions of each helper,
 * so only a call from the application reports.
 */

const USAGE_KEY = Symbol.for('@launchdarkly/ai-server:sdk-usage');
const SINGLETON_KEY = Symbol.for('@launchdarkly/ai-server:singleton');

export const SDK_USAGE_EVENT = '$ld:ai:sdk:usage';

const SDK_USAGE_LANGUAGE = 'javascript';

/** The package a helper belongs to, as that package registers with `$ld:ai:sdk:info`. */
type HelperPackage = {
  name: string;
  version: string;
};

type UsageState = {
  /** Helpers called before a client existed, with the package each belongs to. */
  pending: Map<string, HelperPackage>;
  reported: Set<string>;
};

function getState(): UsageState {
  // biome-ignore lint/suspicious/noExplicitAny: symbol-keyed property on globalThis has no typed accessor
  const g = globalThis as any;
  if (!g[USAGE_KEY]) {
    g[USAGE_KEY] = { pending: new Map(), reported: new Set() };
  }
  return g[USAGE_KEY];
}

function peekClient(): LDClientInterface | null {
  // biome-ignore lint/suspicious/noExplicitAny: symbol-keyed property on globalThis has no typed accessor
  const g = globalThis as any;
  return g[SINGLETON_KEY]?.client ?? null;
}

function deliver(client: LDClientInterface, helper: string, helperPackage: HelperPackage): void {
  try {
    client.track(
      SDK_USAGE_EVENT,
      SDK_INFO_CONTEXT,
      {
        aiSdkName: LD_AI_PACKAGE_NAME,
        aiSdkVersion: LD_AI_PACKAGE_VERSION,
        aiSdkLanguage: SDK_USAGE_LANGUAGE,
        helper,
        helperPackageName: helperPackage.name,
        helperPackageVersion: helperPackage.version,
      },
      1,
    );
  } catch {
    // A throw from track, or from building the payload, must not fail the helper.
  }
}

/**
 * Records a public helper. Sends immediately when a client exists, otherwise
 * holds the helper until {@link flushSdkUsage}. No-ops when already reported.
 *
 * A handler package passes its own name and version, the same values it gives
 * `registerAiSdkPackage`, because handler packages are versioned separately
 * from the core. A `client.*` helper omits both and reports the core identity.
 * The package is not part of the dedupe key: once per client per helper.
 */
export function reportUsage(helper: string): void;
export function reportUsage(helper: string, packageName: string, packageVersion: string): void;
export function reportUsage(helper: string, packageName?: string, packageVersion?: string): void {
  try {
    const state = getState();
    if (state.reported.has(helper) || state.pending.has(helper)) return;
    const helperPackage: HelperPackage = {
      name: packageName ?? LD_AI_PACKAGE_NAME,
      version: packageVersion ?? LD_AI_PACKAGE_VERSION,
    };
    const client = peekClient();
    if (!client) {
      state.pending.set(helper, helperPackage);
      return;
    }
    deliver(client, helper, helperPackage);
    state.reported.add(helper);
  } catch {
    try {
      const state = getState();
      state.pending.delete(helper);
      state.reported.add(helper);
    } catch {
      // Reporting a helper must never break the call that asked.
    }
  }
}

/** Sends every helper that was recorded before a client existed. */
export function flushSdkUsage(client: LDClientInterface): void {
  const state = getState();
  if (state.pending.size === 0) return;
  for (const [helper, helperPackage] of state.pending) {
    deliver(client, helper, helperPackage);
    state.reported.add(helper);
  }
  state.pending.clear();
}

/** Drops the reported set so the next client hears each helper again. */
export function resetSdkUsage(): void {
  const state = getState();
  state.reported.clear();
  state.pending.clear();
}
