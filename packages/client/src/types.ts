import type { Registry } from './registry.js';

// ---------------------------------------------------------------------------
// LDContext — owned definition, structurally compatible with all LD SDKs.
// All LD server/edge SDKs share this same shape via @launchdarkly/js-sdk-common;
// defining it here removes the hard dependency on any specific LD SDK package
// for the public type surface.
// ---------------------------------------------------------------------------

export type LDSingleKindContext = {
  kind: string;
  key: string;
  anonymous?: boolean;
  name?: string;
  [attribute: string]: unknown;
};

export type LDMultiKindContext = {
  kind: 'multi';
  [kind: string]: LDSingleKindContext | 'multi';
};

/** @deprecated Use LDSingleKindContext instead. Kept for backward compatibility. */
export type LDUser = {
  key: string;
  anonymous?: boolean;
  name?: string;
  [attribute: string]: unknown;
};

export type LDContext = LDUser | LDSingleKindContext | LDMultiKindContext;

// ---------------------------------------------------------------------------
// LDClientInterface — minimal surface we need from any LD SDK client.
// Both @launchdarkly/node-server-sdk and all edge SDKs satisfy this interface
// structurally, so no casting is required when passing an initialized client.
// ---------------------------------------------------------------------------

export interface LDClientInterface {
  variation(key: string, context: LDContext, defaultValue: unknown): Promise<unknown>;
  track(eventName: string, context: LDContext, data?: unknown, metricValue?: number): void;
  flush(): Promise<void>;
  close(): Promise<void>;
}

export type RegistryInput = Registry;

/**
 * Symbol key used to attach the original `NativeTool` instance to the tracking
 * stub that `wrapToolHandlers` produces. Handler packages read this to recover
 * the provider tool name without needing a separate data channel.
 */
export const NATIVE_TOOL_KEY = Symbol('ld:native_tool');

/**
 * Top-level type for any tool handler function.
 * Equivalent to `(...args: never) => unknown` — any specific function is assignable to this type,
 * but it cannot be called directly without an explicit cast, avoiding the unsafety of `Function`.
 */
export type ToolHandlerFn = (...args: never) => unknown;

/**
 * Marker for a provider built-in tool. Place as a value in `toolHandlers` to
 * signal that the named tool is a native provider capability rather than a
 * user-supplied function. The handler package wires it to the provider SDK's
 * built-in implementation and emits `$ld:ai:tool_call` tracking when the model
 * invokes it (typically via a PreToolUse hook or equivalent provider callback).
 */
export class NativeTool {
  constructor(
    public readonly id: symbol,
    /** Exact tool name the provider SDK uses in tool_use events (e.g. 'WebSearch'). */
    public readonly toolName: string,
  ) {}
}

export type VariationMeta = {
  enabled?: boolean;
  variationKey?: string;
  version?: number;
  mode?: 'agent' | 'completion' | 'judge';
};

export type Tool = {
  name: string;
  parameters: Record<string, unknown>;
  type: 'function';
  customParameters?: Record<string, unknown>;
  description?: string;
};

/**
 * A single message in a conversation. Used both by `AiConfigRep.messages`
 * (config-time prompts) and the `history` parameter (runtime conversation state).
 */
export type Message = { role: 'user' | 'assistant' | 'system'; content: string };

export type AiConfigRep = {
  instructions?: string;
  messages?: Message[];
  model: {
    name: string;
    region?: string;
    parameters?: Record<string, unknown>;
    custom?: Record<string, unknown>;
  };
  tools?: Record<string, Tool>;
  judgeConfiguration?: {
    judges?: Array<{ key: string; samplingRate: number }>;
  };
  evaluationMetricKey?: string;
  provider: { name: string };
  /**
   * Optional JSON Schema (type: 'object' at root) that the model output must
   * conform to. Handlers use this to enforce structured output via their
   * provider's native API where supported, or via system-prompt injection as a
   * best-effort fallback. Ignored in streaming mode.
   */
  outputFormat?: Record<string, unknown>;
};

type ParseResult<T> = { success: true; data: T } | { success: false; error: { message: string } };

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseTool(raw: unknown, key: string): string | null {
  if (!isObject(raw)) return `tools.${key} must be an object`;
  if (typeof raw.name !== 'string') return `tools.${key}.name must be a string`;
  if (raw.type !== 'function') return `tools.${key}.type must be "function"`;
  if (!isObject(raw.parameters)) return `tools.${key}.parameters must be an object`;
  return null;
}

/** Validates a raw LD flag variation as an AiConfigRep. */
export function parseAiConfig(raw: unknown): ParseResult<AiConfigRep> {
  if (!isObject(raw)) return { success: false, error: { message: 'Config must be an object' } };

  if (!isObject(raw.model) || typeof raw.model.name !== 'string') {
    return { success: false, error: { message: 'model.name is required and must be a string' } };
  }
  if (!isObject(raw.provider) || typeof raw.provider.name !== 'string') {
    return { success: false, error: { message: 'provider.name is required and must be a string' } };
  }

  const hasInstructions = typeof raw.instructions === 'string';
  const hasMessages = Array.isArray(raw.messages) && raw.messages.length > 0;
  if (!hasInstructions && !hasMessages) {
    return {
      success: false,
      error: { message: 'AiConfigRep must have either instructions or a non-empty messages array' },
    };
  }

  if (Array.isArray(raw.messages)) {
    const validRoles = new Set(['user', 'assistant', 'system']);
    for (const msg of raw.messages) {
      if (!isObject(msg) || !validRoles.has(msg.role as string)) {
        return { success: false, error: { message: `Invalid message role: ${isObject(msg) ? msg.role : msg}` } };
      }
    }
  }

  if (raw.tools !== undefined) {
    if (!isObject(raw.tools)) {
      return { success: false, error: { message: 'tools must be an object' } };
    }
    for (const [k, v] of Object.entries(raw.tools)) {
      const err = parseTool(v, k);
      if (err) return { success: false, error: { message: err } };
    }
  }

  if (raw.outputFormat !== undefined && !isObject(raw.outputFormat)) {
    return { success: false, error: { message: 'outputFormat must be an object (JSON Schema)' } };
  }

  return { success: true, data: raw as AiConfigRep };
}

/**
 * Topology of an agent graph, as delivered in a graph flag variation.
 * Pure structure: a root config key and a map of source config key -> outgoing
 * edges. The agent configs themselves are resolved separately, per node key.
 */
export type GraphTopology = {
  root: string;
  edges?: Record<string, Array<{ key: string; handoff?: Record<string, unknown> }>>;
};

function parseGraphTopology(raw: unknown): ParseResult<GraphTopology> {
  if (!isObject(raw)) return { success: false, error: { message: 'Topology must be an object' } };
  if (typeof raw.root !== 'string') return { success: false, error: { message: 'root must be a string' } };
  return { success: true, data: raw as GraphTopology };
}

/** Exported as a public API; exposes the same safeParse/parse surface as the former zod schema. */
export const GraphTopologySchema = {
  safeParse: parseGraphTopology,
  parse(raw: unknown): GraphTopology {
    const result = parseGraphTopology(raw);
    if (!result.success) throw new Error(result.error.message);
    return result.data;
  },
};

export type TokenUsage = {
  /** Total input tokens, including uncached, cache-read, and cache-creation input. */
  input: number;
  output: number;
  total: number;
  /**
   * Provider-reported input breakdown.
   *
   * Only present for providers that report cache tokens *alongside* their input figure
   * (Anthropic, Bedrock Converse), because that is the only shape from which the split can
   * be recovered. OpenAI and LangChain count cache tokens inside `input`, so their handlers
   * must omit the cache fields to avoid double-counting — the breakdown is unavailable here
   * even though the same numbers do reach the span attributes. Read an absent `inputDetails`
   * as "not recoverable", never as "no cached tokens".
   */
  inputDetails?: {
    uncached: number;
    cacheRead: number;
    cacheCreation: number;
  };
};

/**
 * The result of a single judge evaluation — score, reasoning text, and token usage.
 * Matches the per-judge entry shape inside `ProviderResponse.judgeResults`.
 */
export type JudgeCallResult = {
  score: number;
  response: string;
  usage: { total: number; input: number; output: number };
};

export type ProviderResponse<T = string> = {
  response: T;
  usage: TokenUsage;
  /**
   * Judge evaluation results. Populated when `skipJudges` is `false` (the
   * default) and at least one judge ran during `invoke()` / `stream()`.
   */
  judgeResults?: Record<string, JudgeCallResult>;
  /**
   * Pre-packaged judge tasks produced when `skipJudges: true`. Each task is a
   * plain JSON-serialisable object that can be passed directly as `workerData`
   * to a `worker_threads.Worker` running `runJudge(task, handlers)`.
   *
   * `undefined` when `skipJudges` is `false` (judges ran inline).
   */
  judgeTasks?: JudgeTask[];
  /**
   * Tracking payload from this invocation. Carried inside each {@link JudgeTask}
   * so that background judge results are attributed to the originating request
   * (run ID, config key, graph key, etc.).
   */
  trackData: TrackData;
};

/**
 * A fully-resolved, JSON-serializable snapshot of everything needed to execute
 * a judge evaluation in a worker thread or background process, without
 * re-fetching the variation from LaunchDarkly or re-running the main invocation.
 *
 * Produced by `config().prepareJudge()` on the main thread and passed to
 * `runJudge()` in the worker via `workerData`.
 */
export type JudgeTask = {
  /** The flag key that was used for the judge config variation. */
  configKey: string;
  /** The already-fetched judge AI config variation (plain JSON). */
  judgeConfig: AiConfigRep;
  /** Variation metadata for the judge config. */
  judgeMeta: VariationMeta;
  /** The LLM response to evaluate. */
  actualOutput: string;
  /** The LaunchDarkly context from the originating invocation. */
  userContext: LDContext;
  /** Optional template variables to pass to the judge handler. */
  variables?: Record<string, unknown>;
  /** Provider name from the judge config (pre-resolved for handler selection). */
  judgeProvider: string | undefined;
  /** Effective mode after normalisation (pre-resolved for handler selection). */
  judgeMode: 'agent' | 'messages';
  /**
   * When `true`, the worker must collapse the judge config's `messages` array
   * into a single `instructions` string before calling the handler. Pre-computed
   * on the main thread so the worker doesn't need to replicate the selection logic.
   */
  collapseMessages: boolean;
  /** LD metric key to track the score against. */
  evaluationMetricKey?: string;
  /**
   * Track data from the parent invocation (run ID, config key, graph key, etc.).
   * Included in the LD track call so the judge result is attributed to the
   * originating request.
   */
  parentTrackData: TrackData;
};

/**
 * Result returned by `runJudge()` — the judge score, reasoning text, token
 * usage, and the merged track data ready to pass directly to `getClient().track()`.
 */
export type JudgeRunResult = JudgeCallResult & {
  /**
   * Track data with `judgeConfigKey` merged in. Pass this directly to
   * `getClient().track(task.evaluationMetricKey, task.userContext, trackData, score)`
   * from the main thread after the worker posts its result.
   */
  trackData: TrackData & { judgeConfigKey: string };
};

export type ProviderSetupFn = () => ProviderHandler;

/**
 * A single text-delta event emitted by a handler's streaming implementation.
 * Handlers yield these through their `stream` function; the client accumulates
 * them and re-emits them as the public {@link StreamEvent} shape.
 */
export type HandlerStreamEvent =
  | { type: 'chunk'; text: string }
  | { type: 'done'; output?: string; usage: Record<string, unknown> };

/**
 * Public stream event emitted by `model().stream()` and `routedModel().stream()`.
 * Callers iterate an `AsyncGenerator<StreamEvent>` to receive text chunks as
 * they arrive, then handle the final `done` event for usage and judge results.
 */
export type StreamEvent =
  | { type: 'chunk'; text: string }
  | {
      type: 'done';
      response: string;
      usage: TokenUsage;
      judgeResults?: ProviderResponse['judgeResults'];
    };

export type ProviderHandler = ((
  config: AiConfigRep,
  userInput?: string,
  toolHandlers?: Record<string, ToolHandlerFn | NativeTool>,
  variables?: Record<string, unknown>,
  history?: Message[],
) => Promise<{
  output?: unknown;
  usage?: Record<string, unknown>;
}>) & {
  providesFor?: [provider: string, type: 'agent' | 'messages'];
  /**
   * Optional streaming implementation. When present, `model().stream()` calls
   * this instead of the blocking handler and forwards `chunk` events to the
   * caller in real time. When absent, `model().stream()` falls back to calling
   * the blocking handler and emitting its output as a single chunk.
   *
   * toolHandlers uses Record<string, any> to avoid a contravariant mismatch
   * when handler implementations narrow to Record<string, Function>.
   */
  stream?: (
    config: AiConfigRep,
    userInput?: string,
    // biome-ignore lint/suspicious/noExplicitAny: avoids contravariant mismatch with narrowed handler implementations
    toolHandlers?: Record<string, any>,
    variables?: Record<string, unknown>,
    history?: Message[],
  ) => AsyncGenerator<HandlerStreamEvent>;
};

/** @deprecated Use `ConfigArgs` with the `config()` function instead. */
export type ModelArgs = {
  key: string;
  handler: ProviderHandler;
  toolHandlers?: Record<string, ToolHandlerFn | NativeTool>;
};

/** Instantiation args for {@link config}. */
export type ConfigArgs = {
  key: string;
  /** One handler or an ordered array of handlers. Routing selects the match by provider + mode. */
  handler?: ProviderHandler | ProviderHandler[];
  toolHandlers?: Record<string, ToolHandlerFn | NativeTool>;
  /**
   * One or more registries to source handlers and tools from. Local
   * `handler`/`toolHandlers` take precedence over registry values.
   */
  registry?: RegistryInput;
  /**
   * When `true`, automatic judge evaluations configured via `judgeConfiguration`
   * are skipped during `invoke()` and `stream()`. Use this when you intend to
   * run judges manually and asynchronously via `config().judge()` after the main
   * response has been returned to the caller.
   */
  skipJudges?: boolean;
};

/**
 * Payload attached to every LaunchDarkly tracking event. `graphKey` is present
 * only when the event was produced while executing inside an agent graph.
 */
export type TrackData = {
  runId: string;
  configKey: string;
  variationKey: string;
  version: number;
  modelName: string;
  providerName: string;
  graphKey?: string;
  toolName?: string;
  judgeConfigKey?: string;
  /** LD environment MongoDB ObjectId — used to set feature_flag.set.id on OTel spans. */
  environmentId?: string;
};

// ============================================================================
// Agent graph types
// ============================================================================

/** A single directed edge between two agent configs in a graph. */
export type GraphEdge = {
  /** Stable edge identifier, of the form `${sourceKey}-${targetKey}`. */
  key: string;
  sourceKey: string;
  targetKey: string;
  /** Optional handoff data attached to the edge in the graph definition. */
  handoff?: Record<string, unknown>;
};

/** A node in a resolved agent graph: an evaluated agent config plus its edges. */
export type GraphNode = {
  key: string;
  config: AiConfigRep;
  meta: VariationMeta;
  /** Outgoing edges from this node. */
  edges: GraphEdge[];
  /** True when the node has no outgoing edges. */
  isTerminal: () => boolean;
};

/** Per-node options for {@link GraphDefinition.runNode}. */
export type RunNodeOptions = {
  variables?: Record<string, unknown>;
  toolHandlers?: Record<string, ToolHandlerFn | NativeTool>;
  /**
   * The node we are handing off from. When provided, `runNode` emits
   * `$ld:ai:graph:handoff_success` / `handoff_failure` for the transition.
   */
  from?: GraphNode;
};

/**
 * Result of {@link GraphDefinition.route}: a normal node response plus the
 * edge the model chose to hand off to (`next`). `next` is undefined when the
 * model produced a terminal answer without selecting a transfer.
 */
export type RouteResult = ProviderResponse & {
  next?: GraphNode;
};

/** A visitor invoked per node by {@link GraphDefinition.traverse}. */
// biome-ignore lint/suspicious/noExplicitAny: T = any default keeps existing call-sites working without type annotations
export type TraverseVisitor<T = any> = (node: GraphNode, ctx: Record<string, unknown>) => T | Promise<T>;

/**
 * A resolved agent graph. Exposes topology accessors (parity with the Python
 * SDK), a tracked per-node executor, and the ordered-walk primitives that
 * framework packages build upon.
 */
export type GraphDefinition = {
  key: string;
  enabled: boolean;
  root: GraphNode | null;
  getNode: (key: string) => GraphNode | undefined;
  getChildNodes: (key: string) => GraphNode[];
  getParentNodes: (key: string) => GraphNode[];
  terminalNodes: () => GraphNode[];
  edgesFrom: (key: string) => GraphEdge[];
  /** Execute a single node through the tracked `config().invoke()` path. */
  runNode: (node: GraphNode, input?: string, opts?: RunNodeOptions) => Promise<ProviderResponse>;
  /**
   * Execute a node, presenting its outgoing edges to the model as handoff
   * choices, and return the response plus the chosen `next` node (if any).
   * Emits `$ld:ai:graph:handoff_*` for the edge the model actually selected.
   */
  route: (node: GraphNode, input?: string, opts?: RunNodeOptions) => Promise<RouteResult>;
  /** Walk root -> leaves (deepest last), awaiting each visitor result. */
  // biome-ignore lint/suspicious/noExplicitAny: T = any default keeps existing call-sites working without type annotations
  traverse: <T = any>(fn: TraverseVisitor<T>, ctx?: Record<string, unknown>) => Promise<T | undefined>;
  /** Walk leaves -> root (root last), awaiting each visitor result. */
  // biome-ignore lint/suspicious/noExplicitAny: T = any default keeps existing call-sites working without type annotations
  reverseTraverse: <T = any>(fn: TraverseVisitor<T>, ctx?: Record<string, unknown>) => Promise<T | undefined>;
};

/**
 * Options for {@link graph}. Context is passed per-call rather than at
 * instantiation, so each `.invoke()` can use a different LDContext.
 */
export type GraphOptions = {
  /**
   * Candidate handlers; each node is routed by its provider + mode.
   * Required when using `graph()` or `def.runNode()`. May be omitted when
   * passing the result of `resolveGraph` to a framework-native runner
   * (`toOpenAIAgents`, `toLangGraph`, `toClaudeAgents`) that handles
   * execution without going through `runNode`.
   */
  handlers?: ProviderHandler[];
  toolHandlers?: Record<string, ToolHandlerFn | NativeTool>;
  /** Optional graph-level judge config key, evaluated against the final output. */
  graphJudge?: string;
  /**
   * One or more registries to source handlers and tools from. Local
   * `handlers`/`toolHandlers` take precedence over registry values; when an
   * array is given, later entries override earlier ones on conflict.
   */
  registry?: RegistryInput;
};

/** Options for {@link resolveGraph}. Requires a context at resolution time. */
export type GraphArgs = GraphOptions & {
  context: LDContext;
};

/** Aggregate result returned by `graph(...).invoke()`. */
export type ProviderGraphResponse = {
  response: string;
  usage: TokenUsage;
  judgeResults?: ProviderResponse['judgeResults'];
  /** Node keys in the order they were executed, starting at the root. */
  path: string[];
  /**
   * Each executed node's own response, keyed by node key. Populated by
   * `graph()`; native runners that delegate traversal to a framework omit it.
   */
  nodes?: Record<string, ProviderResponse>;
};

export type InitBaseClientOptions = {
  sdkKey?: string;
  baseUri?: string;
  streamUri?: string;
  eventsUri?: string;
  // Telemetry-related options
  serviceName?: string;
  environment?: string;
  otlpEndpoint?: string;
};

/** Instantiation args for {@link routedModel}. */
export type RoutedModelArgs = {
  key: string;
  handlers?: ProviderHandler[];
  toolHandlers?: Record<string, ToolHandlerFn | NativeTool>;
  /**
   * One or more registries to source handlers and tools from. Local
   * `handlers`/`toolHandlers` take precedence over registry values.
   */
  registry?: RegistryInput;
};
