/**
 * Cleanup hooks that `shutdown()` runs.
 *
 * A feature module (today, Agent Skills) registers its own cleanup when it
 * loads, and `shutdown()` runs whatever is registered, so `lifecycle.ts` never
 * imports a feature module.
 *
 * Hooks live on a `globalThis` symbol slot, so a hook registered from one
 * bundle (or a second copy of this package) is run by another's `shutdown()`.
 */

const SHUTDOWN_HOOKS_KEY = Symbol.for('@launchdarkly/ai-server:shutdown-hooks');

function getHooks(): Map<string, () => void> {
  // biome-ignore lint/suspicious/noExplicitAny: symbol-keyed property on globalThis has no typed accessor
  const g = globalThis as any;
  if (!g[SHUTDOWN_HOOKS_KEY]) {
    g[SHUTDOWN_HOOKS_KEY] = new Map();
  }
  return g[SHUTDOWN_HOOKS_KEY];
}

/**
 * Registers `hook` to run on every `shutdown()`, including before a client
 * exists. Keyed by `name`, so a second module instance registering the same
 * feature replaces the first hook rather than adding another.
 */
export function registerShutdownHook(name: string, hook: () => void): void {
  getHooks().set(name, hook);
}

/**
 * Runs every registered hook. A feature's cleanup must not break `shutdown()`,
 * so a hook that throws is logged and the rest still run.
 */
export function runShutdownHooks(): void {
  for (const [name, hook] of getHooks()) {
    try {
      hook();
    } catch (err) {
      // biome-ignore lint/suspicious/noConsole: this package has no logger abstraction; a failed cleanup must be visible
      console.warn(`[LaunchDarkly] Clearing ${name} state failed during shutdown; continuing.`, err);
    }
  }
}
