import { getClient } from './lifecycle.js';
import { exposedToolKeys, HANDOFF_TOOL_PREFIX, renderTrajectory, TrajectoryRecorder } from './trajectory.js';
import type {
  AiConfigRep,
  GraphNode,
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
  /** The invocation's rendered tool-call trajectory, for its judges' `message_history`. `''` with no tools. */
  trajectory: string;
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
  if (!toolHandlers) return Object.create(null);
  // Null prototype: a config tool named `toString` or `constructor` resolves to no handler.
  return Object.assign(
    Object.create(null),
    Object.fromEntries(
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
            if (!name.startsWith(HANDOFF_TOOL_PREFIX)) {
              getClient().track('$ld:ai:tool_call', userContext, { ...trackData, toolKey: name }, 1);
            }
            return (fn as (...args: unknown[]) => unknown)(...args);
          },
        ];
      }),
    ),
  );
};

/**
 * Narrows `toolHandlers` to the tools attached to the active variation: own
 * properties whose key is in `config.tools`. A registry holds the tools of every
 * variation, so this is the authorization boundary (SEC-9507): a tool name the
 * model returns can only reach a handler this variation was given.
 */
export const scopeToolHandlers = (
  config: Pick<AiConfigRep, 'tools'>,
  toolHandlers: Record<string, ToolHandlerFn | NativeTool> | undefined,
): Record<string, ToolHandlerFn | NativeTool> | undefined => {
  if (!toolHandlers) return undefined;
  return Object.fromEntries(
    Object.keys(config.tools ?? {})
      .filter((key) => Object.hasOwn(toolHandlers, key))
      .map((key) => [key, toolHandlers[key]]),
  );
};

/**
 * Wraps the tool map for one invocation: trajectory recording inside the
 * `$ld:ai:tool_call` wrapper, on the original map. That order matters. The
 * tracking wrapper turns a `NativeTool` into a callable stub that returns
 * nothing, so recording outside it would show a judge a native call with an
 * empty result; inside it, the recorder still sees the tool as native and
 * skips it. Neither wrapper disables the other.
 */
function instrumentTools(
  config: AiConfigRep,
  toolHandlers: Record<string, ToolHandlerFn | NativeTool> | undefined,
  userContext: LDContext,
  trackData: TrackData,
): { tools: Record<string, ToolHandlerFn>; recorder: TrajectoryRecorder } {
  // One recorder per invocation: invocations run concurrently against one map.
  const recorder = new TrajectoryRecorder();
  const scoped = scopeToolHandlers(config, toolHandlers);
  if (!scoped) return { tools: {}, recorder };
  const recorded = recorder.wrap(scoped, exposedToolKeys(config, scoped));
  return { tools: wrapToolHandlers(recorded, userContext, trackData), recorder };
}

/**
 * Copies the pinned model-config identity (`modelKey`, `modelVersion`) from a
 * variation's `_ldMeta` into a shape that can be spread into `TrackData`.
 * Keys are omitted (not set to `undefined`) when absent; an empty `modelKey`
 * is treated as absent. `_ldMeta` is an untyped flag payload, so a
 * `modelVersion` that does not coerce to a finite integer is omitted rather
 * than emitted as `NaN`. Gonfalon's cost attribution reads these two fields
 * from every `$ld:ai:*` event payload.
 *
 * @internal Exported for the client package's own tests; adapters should use
 * {@link makeRunTrackData} or {@link makeNodeTrackData} instead.
 */
export const modelStampsFromMeta = (
  meta: VariationMeta | null | undefined,
): Pick<TrackData, 'modelKey' | 'modelVersion'> => {
  const stamps: Pick<TrackData, 'modelKey' | 'modelVersion'> = {};
  const modelKey: unknown = meta?.modelKey;
  if (typeof modelKey === 'string' && modelKey.length > 0) stamps.modelKey = modelKey;
  const raw: unknown = meta?.modelVersion;
  // `Number('')` and `Number('  ')` are 0, so blank strings must be rejected before coercion.
  if (typeof raw === 'number' || (typeof raw === 'string' && raw.trim().length > 0)) {
    const version = Number(raw);
    if (Number.isInteger(version)) stamps.modelVersion = version;
  }
  return stamps;
};

/**
 * Builds the standard tracking payload for a graph node event. Shared by all
 * native graph adapters (openai-agents, claude-agents, langchain-agents) so the
 * payload shape — including the `_ldMeta` model stamps — is defined once.
 */
export const makeNodeTrackData = (node: GraphNode, graphKey: string, runId: string): TrackData => ({
  runId,
  configKey: node.key,
  variationKey: node.meta.variationKey ?? '',
  version: node.meta.version ?? 1,
  modelName: node.config.model.name,
  providerName: node.config.provider.name,
  ...modelStampsFromMeta(node.meta),
  graphKey,
  environmentId: tryGetEnvironmentId(),
});

/**
 * Builds the tracking payload for a native graph run as a whole. The graph flag
 * is itself the AI Config the trace belongs to, so its key is both the config
 * key and the graph key — the same choice the client's own graph runner makes in
 * `graph.ts`. There is no model or variation to report: a graph flag carries a
 * topology, and `GraphDefinition` does not expose its `_ldMeta`.
 *
 * Native graph adapters pass this to `setLdSpanAttributes` so the
 * `launchdarkly.graph` span can be found by an AI Config Monitoring query, and
 * use it for their graph-level `$ld:ai:graph:*` events.
 *
 * @internal Exported for the native graph adapter packages only; not part of
 * the public API. The signature changes if `GraphDefinition` gains the graph
 * flag's variation metadata.
 */
export const makeGraphTrackData = (graphKey: string, runId: string): TrackData => ({
  runId,
  configKey: graphKey,
  variationKey: '',
  version: 1,
  modelName: '',
  providerName: '',
  graphKey,
  environmentId: tryGetEnvironmentId(),
});

/**
 * Reads the LaunchDarkly environment MongoDB ObjectId from the SDK's internal
 * feature store init metadata. This mirrors what the official OTel hook does
 * when it emits `feature_flag` events; we need it to set `feature_flag.set.id`
 * so the AI Config Monitoring tab can correlate traces to their config.
 *
 * Uses a private API that is stable across minor SDK versions. Returns
 * `undefined` gracefully on any failure (edge runtimes, custom clients, etc.).
 *
 * @internal Exported for this package's own modules (`graph.ts`); not part of
 * the public API.
 */
export function tryGetEnvironmentId(): string | undefined {
  try {
    // biome-ignore lint/suspicious/noExplicitAny: private LD SDK internals mirror what the SDK's own OTel hook accesses
    const featureStore = (getClient() as any)._featureStore;
    return featureStore?.getInitMetaData?.()?.environmentId as string | undefined;
  } catch {
    return undefined;
  }
}

/**
 * Builds the tracking payload for one run of an AI Config: a fresh run ID, the
 * variation identity, `_ldMeta` model stamps, and the environment ID that the
 * Monitoring tab needs to correlate traces. Adapters that run a config outside
 * `config().invoke()` (e.g. `vercelEvaluate`) use this so their events and spans
 * match the SDK's own.
 */
export const makeRunTrackData = ({
  configKey,
  config,
  meta,
  graphKey,
  runId,
  extraTrackData,
}: {
  configKey: string;
  config: AiConfigRep;
  meta: VariationMeta | null | undefined;
  graphKey?: string;
  runId?: string;
  extraTrackData?: Partial<TrackData>;
}): TrackData => ({
  runId: runId ?? crypto.randomUUID(),
  configKey,
  variationKey: meta?.variationKey ?? '',
  version: meta?.version ?? 1,
  modelName: config.model.name ?? '',
  providerName: config.provider?.name ?? '',
  ...modelStampsFromMeta(meta),
  ...(graphKey ? { graphKey } : {}),
  environmentId: tryGetEnvironmentId(),
  ...extraTrackData,
});

/** Root-span attributes go under `__ld_span`, which only the SDK sets; a template variable of that name is dropped. */
function mergeVariables(
  variables: Record<string, unknown> | undefined,
  userContext: LDContext,
  trackData: TrackData,
  spanAttributes?: Record<string, string | boolean>,
): Record<string, unknown> {
  const { __ld_span: _dropped, ...rest } = variables ?? {};
  return {
    ...rest,
    ldContext: { ...userContext },
    __ld: trackData,
    ...(spanAttributes ? { __ld_span: { ...spanAttributes } } : {}),
  };
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
  runId,
  extraTrackData,
  spanAttributes,
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
  runId?: string;
  extraTrackData?: Partial<TrackData>;
  spanAttributes?: Record<string, string | boolean>;
}): Promise<{ usage: TokenUsage; response: unknown; trackData: TrackData; trajectory: string }> => {
  const trackData = makeRunTrackData({ configKey, config, meta, graphKey, runId, extraTrackData });

  const { tools: trackedToolHandlers, recorder } = instrumentTools(config, toolHandlers, userContext, trackData);

  const startTime = Date.now();
  let response: Awaited<ReturnType<ProviderHandler>>;

  try {
    response = await handler(
      config,
      userInput,
      trackedToolHandlers,
      mergeVariables(variables, userContext, trackData, spanAttributes),
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
  return {
    usage,
    response: rawOutput !== undefined && rawOutput !== null ? rawOutput : '',
    trackData,
    // Rendered, not structural: `message_history` is the only consumer, and a
    // JudgeTask must survive structured clone.
    trajectory: renderTrajectory(recorder),
  };
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
  runId,
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
  runId?: string;
}): AsyncGenerator<ExecuteStreamEvent> {
  const trackData = makeRunTrackData({ configKey, config, meta, graphKey, runId });

  const { tools: trackedToolHandlers, recorder } = instrumentTools(config, toolHandlers, userContext, trackData);
  const mergedVariables = mergeVariables(variables, userContext, trackData);

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

  yield { type: 'done', response: fullText, usage, trackData, trajectory: renderTrajectory(recorder) };
}
