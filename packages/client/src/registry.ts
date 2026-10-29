import type { NativeTool, ProviderHandler, ToolHandlerFn } from './types.js';
import { normalizeMode, selectModeHandler } from './utils.js';

/**
 * Handler identity for {@link Registry} and the evaluations duplicate check.
 *
 * Normalized `providesFor` (`completion` and `judge` are `messages`), plus the
 * allowlist as a set on a `'*'` handler. Order and repeated names do not make a
 * new identity. Routing ignores the list on an exact handler, so it is not part
 * of that handler's identity.
 */
export function registrationKey(handler: ProviderHandler): string | undefined {
  if (!handler.providesFor) return undefined;
  const [provider, mode] = handler.providesFor;
  const normalizedMode = normalizeMode(mode);
  if (provider !== '*' || handler.providers === undefined) return JSON.stringify([provider, normalizedMode]);
  return JSON.stringify([provider, normalizedMode, [...new Set(handler.providers)].sort()]);
}

export class Registry {
  handlers: ProviderHandler[] = [];
  tools: Record<string, ToolHandlerFn | NativeTool> = {};

  constructor(config?: { handlers?: ProviderHandler[]; tools?: Record<string, ToolHandlerFn | NativeTool> }) {
    if (config) {
      this.register(config);
    }
  }

  register(config: { handlers?: ProviderHandler[]; tools?: Record<string, ToolHandlerFn | NativeTool> }): void {
    for (const handler of config.handlers ?? []) {
      const key = registrationKey(handler);
      const index = key ? this.handlers.findIndex((h) => registrationKey(h) === key) : -1;
      if (index !== -1) {
        // biome-ignore lint/suspicious/noConsole: intentional warning for user misconfiguration
        console.warn(`Multiple handlers registered for ${key}. This may be unintended. The last one will be used.`);
        // In place, so a replacement keeps the registration order that breaks wildcard ties.
        this.handlers[index] = handler;
        continue;
      }
      this.handlers.push(handler);
    }

    for (const [toolKey, fn] of Object.entries(config.tools ?? {})) {
      if (toolKey in this.tools) {
        // biome-ignore lint/suspicious/noConsole: intentional warning for user misconfiguration
        console.warn(`Multiple tools registered for "${toolKey}". This may be unintended. The last one will be used.`);
      }
      this.tools[toolKey] = fn;
    }
  }
}

export const globalRegistry = new Registry();

/**
 * Combines two registries into a new one. `b` takes precedence over `a` on
 * any handler or tool key conflict (last-writer-wins, same as `register()`).
 * Neither input registry is mutated.
 */
export function compose(a: Registry, b: Registry): Registry {
  const result = new Registry();
  result.register({ handlers: a.handlers, tools: a.tools });
  result.register({ handlers: b.handlers, tools: b.tools });
  return result;
}

/**
 * The handler selection rule `config()` uses, shared by every caller that picks
 * a handler for a provider and mode: a handler whose `providesFor` names the
 * provider wins, then the shortest `'*'` allowlist containing it, then an
 * unscoped `'*'` handler. The mode must match exactly. Pass the mode already
 * normalized. Returns `undefined` when nothing matches.
 */
export function findHandler(
  handlers: readonly ProviderHandler[] | undefined,
  provider: string,
  mode: 'agent' | 'messages',
): ProviderHandler | undefined {
  return handlers ? selectModeHandler(handlers, provider, mode) : undefined;
}

/**
 * Merges registry handlers with local handlers. Local handlers are prepended
 * so that selectHandler finds them first (highest precedence).
 */
export function resolveHandlers(
  registry: Registry | undefined,
  localHandlers: ProviderHandler[] | undefined,
): ProviderHandler[] | undefined {
  if (!registry) return localHandlers;

  const registryHandlers = registry.handlers;
  if (!localHandlers?.length) return registryHandlers.length ? registryHandlers : undefined;
  return [...localHandlers, ...registryHandlers];
}

/**
 * Merges registry tools with local toolHandlers. Local toolHandlers are
 * overlaid on top of the registry (highest precedence).
 */
export function resolveTools(
  registry: Registry | undefined,
  localTools: Record<string, ToolHandlerFn | NativeTool> | undefined,
): Record<string, ToolHandlerFn | NativeTool> | undefined {
  if (!registry) return localTools;

  const registryTools = registry.tools;
  if (!localTools) return Object.keys(registryTools).length ? registryTools : undefined;
  return { ...registryTools, ...localTools };
}
