/**
 * Cleanup hooks that `shutdown()` runs.
 *
 * This is how core reaches experimental state without importing it: an
 * experimental module registers its own cleanup when it loads, and `shutdown()`
 * runs whatever is registered. The root entry point never imports experimental
 * code, so it neither bundles it nor names it.
 *
 * Hooks live on a `globalThis` symbol slot, so a hook registered through the
 * experimental bundle is run by the root bundle's `shutdown()`.
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
 * Runs every registered hook. Experimental code must not break a core call, so
 * a hook that throws is logged and the rest still run.
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
