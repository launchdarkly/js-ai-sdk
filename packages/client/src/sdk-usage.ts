import { AsyncLocalStorage } from 'node:async_hooks';
import { SDK_INFO_CONTEXT } from './sdk-info.js';
import type { LDClientInterface } from './types.js';
import { LD_AI_PACKAGE_NAME, LD_AI_PACKAGE_VERSION } from './version.js';

/**
 * Records which public AI SDK helpers an application calls.
 *
 * One `$ld:ai:sdk:usage` event per helper per client. A call made before a
 * client exists is held and sent on the next init, on the same path as
 * sdk-info. A call made from inside another helper does not report.
 */

const USAGE_KEY = Symbol.for('@launchdarkly/ai-server:sdk-usage');
const SINGLETON_KEY = Symbol.for('@launchdarkly/ai-server:singleton');

export const SDK_USAGE_EVENT = '$ld:ai:sdk:usage';

const SDK_USAGE_LANGUAGE = 'javascript';

type UsageState = {
  pending: Set<string>;
  reported: Set<string>;
};

const depthStore = new AsyncLocalStorage<number>();

function getState(): UsageState {
  // biome-ignore lint/suspicious/noExplicitAny: symbol-keyed property on globalThis has no typed accessor
  const g = globalThis as any;
  if (!g[USAGE_KEY]) {
    g[USAGE_KEY] = { pending: new Set(), reported: new Set() };
  }
  return g[USAGE_KEY];
}

function peekClient(): LDClientInterface | null {
  // biome-ignore lint/suspicious/noExplicitAny: symbol-keyed property on globalThis has no typed accessor
  const g = globalThis as any;
  return g[SINGLETON_KEY]?.client ?? null;
}

function deliver(client: LDClientInterface, helper: string): void {
  try {
    client.track(
      SDK_USAGE_EVENT,
      SDK_INFO_CONTEXT,
      {
        aiSdkName: LD_AI_PACKAGE_NAME,
        aiSdkVersion: LD_AI_PACKAGE_VERSION,
        aiSdkLanguage: SDK_USAGE_LANGUAGE,
        helper,
      },
      1,
    );
  } catch {
    // A throw from track, or from building the payload, must not fail the helper.
  }
}

/**
 * Records a public helper. Sends immediately when a client exists, otherwise
 * holds the helper until {@link flushSdkUsage}. No-ops when already reported
 * or when called from inside {@link withinSdk}.
 */
export function reportUsage(helper: string): void {
  try {
    if ((depthStore.getStore() ?? 0) > 0) return;
    const state = getState();
    if (state.reported.has(helper) || state.pending.has(helper)) return;
    const client = peekClient();
    if (!client) {
      state.pending.add(helper);
      return;
    }
    deliver(client, helper);
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

/**
 * Runs `fn` as an internal SDK call. `reportUsage` inside `fn` does not emit.
 * Handler wrappers and factories use this so a nested helper is not counted
 * as if the application had called it.
 */
export function withinSdk<T>(fn: () => T): T {
  return depthStore.run((depthStore.getStore() ?? 0) + 1, fn);
}

/** Sends every helper that was recorded before a client existed. */
export function flushSdkUsage(client: LDClientInterface): void {
  const state = getState();
  if (state.pending.size === 0) return;
  for (const helper of state.pending) {
    deliver(client, helper);
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
