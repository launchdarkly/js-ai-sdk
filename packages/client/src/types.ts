import { extractBlock, parseBlock } from './frontmatter.js';
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
  /**
   * Optional version-pinned references to Agent Skills attached to this
   * variation. Project them into typed values with `skillRefs(config)`.
   */
  skills?: SkillReference[];
};

type ParseResult<T> = { success: true; data: T } | { success: false; error: { message: string } };

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// ---------------------------------------------------------------------------
// Agent Skills — value types
// ---------------------------------------------------------------------------

/** A version-pinned pointer to a skill, as attached to an AI Config variation. */
export type SkillReference = {
  /** Immutable skill key — `^[a-z0-9][a-z0-9-]*$`, at most 256 characters. */
  readonly key: string;
  /** Immutable skill version — an integer >= 1. */
  readonly version: number;
};

/**
 * A single verbatim `SKILL.md` document.
 *
 * Only ever constructed after integrity verification passes, so `content` is the
 * exact byte sequence LaunchDarkly delivered and `contentHash` is its sha256.
 * Instances are frozen.
 */
export type Skill = {
  readonly key: string;
  readonly version: number;
  /** Verbatim `SKILL.md` — YAML frontmatter plus markdown body. */
  readonly content: string;
  /** sha256, lowercase hex, over the verbatim UTF-8 bytes of `content`. */
  readonly contentHash: string;
  /** Display name from LaunchDarkly metadata; never parsed from the markdown. */
  readonly name: string | null;
  /** Description from LaunchDarkly metadata; never parsed from the markdown. */
  readonly description: string | null;
  /**
   * Parses the leading `---` frontmatter block, if any.
   *
   * A lazy convenience, never part of the integrity path. Parsing is bounded on
   * every axis a hostile document could exploit: the block must be at most 8 KB,
   * nesting at most 10 levels deep, alias/anchor resolution is disabled
   * outright, and unresolved tags are refused so no object can be constructed.
   *
   * Resolves to `null` — never rejects — when the block is absent, unterminated,
   * oversize, too deeply nested, not a mapping, unparseable, or when no safe
   * YAML parser is available.
   *
   * Asynchronous where the Python equivalent is synchronous, and unavoidably so:
   * the YAML library is a development-only dependency, and dynamic `import()` is
   * the only lazy load an ESM package has. Every observable outcome is identical
   * across the two languages.
   */
  frontmatter(): Promise<Record<string, unknown> | null>;
};

/** The closed set of outcomes `writeSkills` reports. */
export type ReconcileActionKind = 'written' | 'updated' | 'skipped_current' | 'removed' | 'error';

/** How `writeSkills` reacts to content it could not retrieve. */
export type OnUnavailable = 'keep' | 'raise';

/** What `writeSkills` did — or refused to do — for one skill. */
export type ReconcileAction = {
  /**
   * The skill key, or the **empty string** for a failure that belongs to the run
   * rather than to one skill — a corrupt manifest, a manifest that could not be
   * rewritten, a retrieval that failed before any key was known. Callers
   * grouping a report by key need to expect that sentinel; a report may carry
   * both kinds.
   */
  readonly key: string;
  readonly action: ReconcileActionKind;
  readonly version: number | null;
  /** Canonical resolved path, when one was determined. */
  readonly path: string | null;
  /** Failure detail, set only when `action === 'error'`. */
  readonly error: string | null;
};

/** The result of a `writeSkills` run — every outcome is visible here. */
export type ReconcileReport = {
  readonly actions: readonly ReconcileAction[];
  /** `true` iff no action is an `error`. Always agrees with `errors`. */
  readonly ok: boolean;
  /**
   * The `error` actions, in `actions` order.
   *
   * Exposed so callers never re-derive it — filtering `actions` is boilerplate
   * that otherwise reappears in every consumer. Computed at construction rather
   * than exposed as a getter, because a report is a frozen plain object.
   */
  readonly errors: readonly ReconcileAction[];
};

/**
 * The wire-level shape a `SkillStore` serves, before verification.
 *
 * Field names are camelCase and identical across language implementations.
 * Every field is optional and typed loosely on purpose: this is untrusted input,
 * and the accessor boundary is what proves any of it.
 */
export type RawSkillObject = {
  key?: unknown;
  version?: unknown;
  content?: unknown;
  contentHash?: unknown;
  name?: unknown;
  description?: unknown;
  [field: string]: unknown;
};

/**
 * Structural interface every source of skill content satisfies.
 *
 * Structurally typed on purpose, mirroring how {@link LDClientInterface} works in
 * this package: pass any object carrying these methods. The future real transport
 * — a poller against the FDv2 delivery route — drops in behind this interface
 * without touching the public API.
 *
 * `addListener` is part of the seam but **optional**: a store
 * without it must still be accepted. Nothing in this SDK calls it today; it is
 * declared so the delivery transport and both language implementations agree on
 * the callback shape when it lands.
 *
 * Everything a store serves is untrusted input. The transport is not part of the
 * trust boundary — key, version, size, and content hash are revalidated at the
 * accessor boundary on every pass.
 */
export type SkillStore = {
  getObject(kind: string, key: string): RawSkillObject | null | undefined;
  allObjects(kind: string): Record<string, RawSkillObject>;
  addListener?(kind: string, fn: (raw: RawSkillObject) => unknown): void;
};

/** Builds a frozen {@link SkillReference}. */
export function createSkillReference(init: { key: string; version: number }): SkillReference {
  return Object.freeze({ key: init.key, version: init.version });
}

/**
 * Builds a frozen {@link Skill}.
 *
 * Construction does **not** verify anything — the accessors do that, and
 * `writeSkills` re-verifies immediately before writing precisely because a
 * `Skill` can also be built here by a caller.
 */
export function createSkill(init: {
  key: string;
  version: number;
  content: string;
  contentHash: string;
  name?: string | null;
  description?: string | null;
}): Skill {
  const { content } = init;
  return Object.freeze({
    key: init.key,
    version: init.version,
    content,
    contentHash: init.contentHash,
    name: init.name ?? null,
    description: init.description ?? null,
    async frontmatter(): Promise<Record<string, unknown> | null> {
      const block = extractBlock(content);
      return block === null ? null : parseBlock(block);
    },
  });
}

/** Builds a frozen {@link ReconcileAction}. Internal to the reconcile. */
export function createReconcileAction(init: {
  key: string;
  action: ReconcileActionKind;
  version?: number | null;
  path?: string | null;
  error?: string | null;
}): ReconcileAction {
  return Object.freeze({
    key: init.key,
    action: init.action,
    version: init.version ?? null,
    path: init.path ?? null,
    error: init.error ?? null,
  });
}

/** Builds a frozen {@link ReconcileReport}, deriving `ok` and `errors`. */
export function createReconcileReport(actions: readonly ReconcileAction[]): ReconcileReport {
  const frozenActions = Object.freeze([...actions]);
  const errors = Object.freeze(frozenActions.filter((a) => a.action === 'error'));
  // `ok` is defined in terms of `errors` so the two can never disagree.
  return Object.freeze({ actions: frozenActions, ok: errors.length === 0, errors });
}

// ---------------------------------------------------------------------------
// Agent Skills — validation
// ---------------------------------------------------------------------------

/**
 * Skill keys are `^[a-z0-9][a-z0-9-]*$`. Anchored explicitly with `^`/`$` and
 * *without* the `m` flag, so a trailing newline cannot slip through as it would
 * in a multiline match — `'pdf-extraction\n'` must never become a directory name.
 */
const SKILL_KEY_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Longest key the data model permits. Note that no mainstream filesystem allows
 * a 256-byte path component, so `writeSkills` applies a tighter bound of its own.
 */
export const SKILL_KEY_MAX_LENGTH = 256;

/** Skill keys are untrusted input everywhere they appear — validate every time. */
export function isValidSkillKey(key: unknown): key is string {
  return typeof key === 'string' && key.length <= SKILL_KEY_MAX_LENGTH && SKILL_KEY_PATTERN.test(key);
}

/**
 * Skill versions are integers >= 1.
 *
 * `Number.isInteger` rejects `NaN`, `Infinity`, and non-integral values, and a
 * `typeof` check rejects a boolean — which is not an acceptable integer even
 * though JavaScript will happily coerce it.
 */
export function isValidSkillVersion(version: unknown): version is number {
  return typeof version === 'number' && Number.isInteger(version) && version >= 1;
}

/**
 * Validates the optional `skills` array. Returns an error message or `null`.
 *
 * Fail closed: a malformed reference makes the whole config malformed, because an
 * SDK that silently dropped a bad reference would materialize a partial skill set
 * without telling anyone.
 */
function parseSkills(raw: unknown): string | null {
  if (!Array.isArray(raw)) return 'skills must be an array of {key, version} objects';

  for (const [index, entry] of raw.entries()) {
    if (!isObject(entry)) return `skills[${index}] must be an object with key and version`;
    if (!isValidSkillKey(entry.key)) {
      return `skills[${index}].key must be a string matching ^[a-z0-9][a-z0-9-]*$ of at most ${SKILL_KEY_MAX_LENGTH} characters`;
    }
    if (!isValidSkillVersion(entry.version)) return `skills[${index}].version must be an integer >= 1`;
  }
  return null;
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

  if (raw.skills !== undefined) {
    const err = parseSkills(raw.skills);
    if (err) return { success: false, error: { message: err } };
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
  /**
   * The store the Agent Skills accessors read content from. Absent by default,
   * in which case they throw an actionable error.
   *
   * Unlike every other option here, this one is applied on **every**
   * `initClient` call rather than only the first, so a client that was lazily
   * auto-initialized — or initialized without a store — can be given one
   * afterwards. A nullish value never clears an already-configured store; use
   * `shutdown()` for that.
   */
  skillStore?: SkillStore;
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
