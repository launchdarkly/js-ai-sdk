/**
 * Hooks that `config().invoke()` and `.stream()` run before the handler.
 *
 * A feature module registers a hook, and core runs whatever is registered, so
 * core never imports, names or calls a feature module. Same shape as
 * `shutdown-hooks.ts`, and held on a `globalThis` symbol slot for the same
 * reason: a hook registered from the experimental bundle is run by the root
 * bundle's `config()`.
 */
import type { LDContext, Message, ProviderHandler } from './types.js';

/** What a hook sees: one `config()` call, after routing and before the handler runs. */
export interface InvocationEvent {
  configKey: string;
  value: Record<string, unknown>;
  reason: unknown;
  context: LDContext;
  userInput: string | undefined;
  history: Message[] | undefined;
  variables: Record<string, unknown> | undefined;
  handlers: ProviderHandler[];
  runId: string;
  variationKey: string;
}

type InvocationHook = (event: InvocationEvent) => void;

const INVOCATION_HOOKS_KEY = Symbol.for('@launchdarkly/ai-server:invocation-hooks');

function getHooks(): Map<string, InvocationHook> {
  // biome-ignore lint/suspicious/noExplicitAny: symbol-keyed property on globalThis has no typed accessor
  const g = globalThis as any;
  if (!g[INVOCATION_HOOKS_KEY]) {
    g[INVOCATION_HOOKS_KEY] = new Map();
  }
  return g[INVOCATION_HOOKS_KEY];
}

/** Registers `hook` under `name`, replacing an earlier one. `undefined` removes it. */
export function registerInvocationHook(name: string, hook: InvocationHook | undefined): void {
  if (hook) {
    getHooks().set(name, hook);
  } else {
    getHooks().delete(name);
  }
}

export function hasInvocationHooks(): boolean {
  return getHooks().size > 0;
}

/** Runs every hook. A hook that throws is logged and must not break the call. */
export function runInvocationHooks(event: InvocationEvent): void {
  for (const [name, hook] of getHooks()) {
    try {
      hook(event);
    } catch (err) {
      // biome-ignore lint/suspicious/noConsole: this package has no logger abstraction; a failed hook must be visible
      console.warn(`[LaunchDarkly] The ${name} invocation hook failed; continuing.`, err);
    }
  }
}
