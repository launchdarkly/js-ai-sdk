import { getClient } from './lifecycle.js';
import type {
  AiConfigRep,
  LDContext,
  Message,
  ProviderHandler,
  TokenUsage,
  ToolHandlerFn,
  TrackData,
  VariationMeta,
} from './types.js';
import { NATIVE_TOOL_KEY, NativeTool } from './types.js';
import { parseUsage } from './utils.js';

/**
 * Internal done event yielded by `executeAndStream`. Carries `trackData` so
 * that `model().stream()` can pass the same run ID to `runJudges`. This type
 * is not part of the public API; callers see the clean `StreamEvent` shape.
 */
export type ExecuteStreamDoneEvent = {
  type: 'done';
  response: string;
  usage: TokenUsage;
  trackData: TrackData;
};

export type ExecuteStreamEvent = { type: 'chunk'; text: string } | ExecuteStreamDoneEvent;

/**
 * Wraps each tool handler so that invoking it emits a `$ld:ai:tool_call` event
 * attributed to the current config/graph via `trackData`. The provider handlers
 * always call tools through the map we hand them, so this captures every tool
 * call with no provider-package changes and no user opt-in.
 *
 * `NativeTool` values are converted to tracking stubs: zero-arg functions that
 * emit `$ld:ai:tool_call` when called. The original `NativeTool` instance is
 * preserved on the stub via `NATIVE_TOOL_KEY` so handler packages can recover
 * the provider tool name (e.g. `'WebSearch'`) to wire up the PreToolUse hook.
 */
export const wrapToolHandlers = (
  toolHandlers: Record<string, ToolHandlerFn | NativeTool> | undefined,
  userContext: LDContext,
  trackData: TrackData,
): Record<string, ToolHandlerFn> => {
  if (!toolHandlers) return {};
  return Object.fromEntries(
    Object.entries(toolHandlers).map(([name, fn]) => {
      if (fn instanceof NativeTool) {
        const stub = () => {
          getClient().track('$ld:ai:tool_call', userContext, { ...trackData, toolKey: name }, 1);
        };
        (stub as unknown as Record<symbol, unknown>)[NATIVE_TOOL_KEY] = fn;
        return [name, stub];
      }
      return [
        name,
        (...args: unknown[]) => {
          // Synthetic handoff tools (graph routing) are not real tool calls;
          // they must not pollute `$ld:ai:tool_call` metrics.
          if (!name.startsWith('__handoff_')) {
            getClient().track('$ld:ai:tool_call', userContext, { ...trackData, toolKey: name }, 1);
          }
          return (fn as (...args: unknown[]) => unknown)(...args);
        },
      ];
    }),
  );
};

/**
 * Reads the LaunchDarkly environment MongoDB ObjectId from the SDK's internal
 * feature store init metadata. This mirrors what the official OTel hook does
 * when it emits `feature_flag` events; we need it to set `feature_flag.set.id`
 * so the AI Config Monitoring tab can correlate traces to their config.
 *
 * Uses a private API that is stable across minor SDK versions. Returns
 * `undefined` gracefully on any failure (edge runtimes, custom clients, etc.).
 */
function tryGetEnvironmentId(): string | undefined {
  try {
    // biome-ignore lint/suspicious/noExplicitAny: private LD SDK internals mirror what the SDK's own OTel hook accesses
    const featureStore = (getClient() as any)._featureStore;
    return featureStore?.getInitMetaData?.()?.environmentId as string | undefined;
  } catch {
    return undefined;
  }
}

export const executeAndTrack = async ({
  configKey,
  config,
  meta,
  userContext,
  handler,
  userInput,
  toolHandlers,
  variables,
  graphKey,
  history,
}: {
  configKey: string;
  config: AiConfigRep;
  meta: VariationMeta;
  userContext: LDContext;
  handler: ProviderHandler;
  userInput?: string;
  toolHandlers?: Record<string, ToolHandlerFn | NativeTool>;
  variables?: Record<string, unknown>;
  graphKey?: string;
  history?: Message[];
}): Promise<{ usage: TokenUsage; response: unknown; trackData: TrackData }> => {
  const trackData: TrackData = {
    runId: crypto.randomUUID(),
    configKey,
    variationKey: meta.variationKey ?? '',
    version: meta.version ?? 1,
    modelName: config.model.name ?? '',
    providerName: config.provider?.name ?? '',
    ...(graphKey ? { graphKey } : {}),
    environmentId: tryGetEnvironmentId(),
  };

  const trackedToolHandlers = wrapToolHandlers(toolHandlers, userContext, trackData);

  const startTime = Date.now();
  let response: Awaited<ReturnType<ProviderHandler>>;

  try {
    response = await handler(
      config,
      userInput,
      trackedToolHandlers,
      {
        ...variables,
        ldContext: { ...userContext },
        __ld: trackData,
      },
      history,
    );
  } catch (err) {
    getClient().track('$ld:ai:duration:total', userContext, trackData, Date.now() - startTime);
    getClient().track('$ld:ai:generation:error', userContext, trackData, 1);
    throw err;
  }

  getClient().track('$ld:ai:duration:total', userContext, trackData, Date.now() - startTime);
  getClient().track('$ld:ai:generation:success', userContext, trackData, 1);

  const usage = response.usage ? parseUsage(response.usage) : { total: 0, input: 0, output: 0 };

  if (usage.total > 0) getClient().track('$ld:ai:tokens:total', userContext, trackData, usage.total);
  if (usage.input > 0) getClient().track('$ld:ai:tokens:input', userContext, trackData, usage.input);
  if (usage.output > 0) getClient().track('$ld:ai:tokens:output', userContext, trackData, usage.output);

  const rawOutput = response.output;
  return { usage, response: rawOutput !== undefined && rawOutput !== null ? rawOutput : '', trackData };
};

/**
 * Streaming counterpart to `executeAndTrack`. Yields `{ type: 'chunk', text }`
 * events as the handler produces them, then emits a single
 * `{ type: 'done', response, usage, trackData }` event once the stream
 * completes and LD telemetry has been flushed.
 *
 * If the handler has no `.stream` implementation the blocking handler is
 * called and its full output is emitted as a single chunk before the done
 * event — callers never need to branch on streaming support.
 */
export async function* executeAndStream({
  configKey,
  config,
  meta,
  userContext,
  handler,
  userInput,
  toolHandlers,
  variables,
  graphKey,
  history,
}: {
  configKey: string;
  config: AiConfigRep;
  meta: VariationMeta;
  userContext: LDContext;
  handler: ProviderHandler;
  userInput?: string;
  toolHandlers?: Record<string, ToolHandlerFn | NativeTool>;
  variables?: Record<string, unknown>;
  graphKey?: string;
  history?: Message[];
}): AsyncGenerator<ExecuteStreamEvent> {
  const trackData: TrackData = {
    runId: crypto.randomUUID(),
    configKey,
    variationKey: meta.variationKey ?? '',
    version: meta.version ?? 1,
    modelName: config.model.name ?? '',
    providerName: config.provider?.name ?? '',
    ...(graphKey ? { graphKey } : {}),
    environmentId: tryGetEnvironmentId(),
  };

  const trackedToolHandlers = wrapToolHandlers(toolHandlers, userContext, trackData);
  const mergedVariables = { ...variables, ldContext: { ...userContext }, __ld: trackData };

  const startTime = Date.now();
  let fullText = '';
  let rawUsage: Record<string, unknown> = {};

  try {
    if (handler.stream) {
      for await (const event of handler.stream(config, userInput, trackedToolHandlers, mergedVariables, history)) {
        if (event.type === 'chunk') {
          fullText += event.text;
          yield { type: 'chunk', text: event.text };
        } else if (event.type === 'done') {
          if (event.output !== undefined) {
            const out = event.output;
            fullText = typeof out === 'string' ? out : out != null ? JSON.stringify(out) : '';
          }
          rawUsage = event.usage;
        }
      }
    } else {
      const result = await handler(config, userInput, trackedToolHandlers, mergedVariables, history);
      const out = result.output;
      // Streaming ignores outputFormat — always produce a string chunk.
      fullText = typeof out === 'string' ? out : out != null ? JSON.stringify(out) : '';
      rawUsage = result.usage ?? {};
      if (fullText) yield { type: 'chunk', text: fullText };
    }
  } catch (err) {
    getClient().track('$ld:ai:duration:total', userContext, trackData, Date.now() - startTime);
    getClient().track('$ld:ai:generation:error', userContext, trackData, 1);
    throw err;
  }

  getClient().track('$ld:ai:duration:total', userContext, trackData, Date.now() - startTime);
  getClient().track('$ld:ai:generation:success', userContext, trackData, 1);

  const usage = parseUsage(rawUsage);
  if (usage.total > 0) getClient().track('$ld:ai:tokens:total', userContext, trackData, usage.total);
  if (usage.input > 0) getClient().track('$ld:ai:tokens:input', userContext, trackData, usage.input);
  if (usage.output > 0) getClient().track('$ld:ai:tokens:output', userContext, trackData, usage.output);

  yield { type: 'done', response: fullText, usage, trackData };
}
