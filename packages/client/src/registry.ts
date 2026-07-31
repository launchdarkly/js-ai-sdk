import type { NativeTool, ProviderHandler, ToolHandlerFn } from './types.js';

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
      const key = handler.providesFor ? `${handler.providesFor[0]}:${handler.providesFor[1]}` : undefined;
      if (key) {
        const existing = this.handlers.find((h) => h.providesFor && `${h.providesFor[0]}:${h.providesFor[1]}` === key);
        if (existing) {
          // biome-ignore lint/suspicious/noConsole: intentional warning for user misconfiguration
          console.warn(`Multiple handlers registered for [${key}]. This may be unintended. The last one will be used.`);
          this.handlers = this.handlers.filter(
            (h) => !h.providesFor || `${h.providesFor[0]}:${h.providesFor[1]}` !== key,
          );
        }
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
