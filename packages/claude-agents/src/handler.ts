import { createSdkMcpServer, type HookInput, query, tool } from '@anthropic-ai/claude-agent-sdk';
import {
  type AiConfigRep,
  addCachedTokensToInput,
  type ContentCaptureOptions,
  config,
  createHandler,
  endSpanOnce,
  type LDContext,
  type Message,
  NATIVE_TOOL_KEY,
  type NativeTool,
  type ProviderHandler,
  parseTemplate,
  type SpanMessage,
  type SpanMessagePart,
  setInputContentAttributes,
  setLdSpanAttributes,
  setModelIdentityAttributes,
  setOutputContentAttributes,
  setToolCallContentAttributes,
  setToolDefinitionAttributes,
  setUsageSpanAttributes,
  type Tool,
  type ToolDefinitionInput,
  type ToolHandlerFn,
  toSemconvFinishReason,
} from '@launchdarkly/ai-server';
import { type Context, context, type Span, SpanStatusCode, trace } from '@opentelemetry/api';
import { z } from 'zod';

const TOOL_MCP_NAME = 'tool-mcp';
const MCP_TOOL_PREFIX = `mcp__${TOOL_MCP_NAME}__`;

/**
 * Span shape: `invoke_agent` root, one `chat` child per model response, `execute_tool`
 * children per tool call — the same three-span vocabulary as the other five handlers.
 *
 * `query()` reports no request boundaries, so this handler derives them from the message
 * stream: an `assistant` message *is* one model response, carrying its own `request_id`,
 * `usage` and `model` from the API.
 *
 * What no message carries is the request the CLI actually sent. That is assembled in another
 * process, from 67-106 KB of context this side never receives, so the CLI's own system prompt
 * and the schemas for its built-in tools stay out of reach. The conversation does not: every
 * user and assistant turn arrives here, in order, so a `chat` span reports the turns that
 * preceded its response as `gen_ai.input.messages`. That is a description of what the model was
 * asked, assembled only from messages this handler watched arrive — never a reconstruction of
 * the CLI's request, and it never claims to be one.
 *
 * Deliberately NOT done here: enabling the CLI's own OTel exporter. Its spans
 * (`claude_code.llm_request`, `claude_code.tool`, `claude_code.tool.execution`,
 * `claude_code.tool.blocked_on_user`) are named outside the semantic conventions and only
 * become `chat`/`execute_tool` after a LaunchDarkly-specific ingest translation. They also
 * duplicate spans this handler already emits — measured on an 8-turn run: 27 extra tool
 * spans and 27 spans with no `gen_ai.operation.name` at all. A trace this SDK produces has
 * to read the same way on any OTel backend, so the CLI's instrumentation stays off.
 */

/**
 * Writes the run-level identity and token totals onto the `invoke_agent` root.
 *
 * The agent SDK's result message reports usage cumulatively for the whole run, which is exactly
 * what the root wants — and the root is the only span carrying `launchdarkly.*` and the
 * `feature_flag` event, so it is the span a config-scoped query finds.
 */
function finishRootSpan(span: Span, config: AiConfigRep, rawUsage: Record<string, unknown>): void {
  span.setAttribute('gen_ai.response.model', config.model.name);
  setUsageSpanAttributes(span, addCachedTokensToInput(rawUsage));
}

/**
 * Coerces a provider-reported token count to a finite number, defaulting to 0.
 *
 * The CLI reports usage as a loosely-typed bag where a field may be absent or null. An emitted
 * `NaN` is worse than an emitted 0: `trackTokens` guards on `total > 0`, and `NaN > 0` is false, so
 * the metric would be dropped silently rather than reported low.
 *
 * Local rather than imported from the core package, matching the other handlers: it carries no
 * LaunchDarkly or AI meaning, so exporting it would bind a generic numeric coercion to that
 * package's published API for the life of the SDK.
 */
function numberOrZero(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * One `assistant` message as the agent SDK delivers it.
 *
 * Structural rather than the SDK's union: several other members carry an unrelated `message`
 * field (a plain string on a permission denial), so a parameter type shaped like this one
 * would reject the union at every call site.
 */
type AssistantResponse = {
  session_id?: string;
  request_id?: string;
  /**
   * The `Task` tool call this response belongs to, or `null` on the main thread.
   *
   * A subagent's own model calls arrive on the parent's stream, interleaved with the main thread's
   * — measured against Agent SDK 0.3.220, a subagent response lands between two main-thread
   * responses. So this is the only thing separating one agent's conversation from another's.
   */
  parent_tool_use_id?: string | null;
  /** The agent definition a subagent is running under, e.g. `general-purpose`. */
  subagent_type?: string;
  message?: {
    content?: unknown;
    model?: string;
    stop_reason?: string | null;
    usage?: Record<string, unknown>;
  };
};

/**
 * One `user` message as the agent SDK delivers it: the tool results, and any context the CLI
 * injected, that the next call is being sent.
 *
 * Structural for the same reason as `AssistantResponse` — other members of the union carry an
 * unrelated `message` field.
 */
type UserTurn = {
  /** Which agent's conversation this turn belongs to — see `AssistantResponse`. */
  parent_tool_use_id?: string | null;
  message?: {
    role?: string;
    content?: unknown;
  };
};

/** One API response, accumulated across every message that reported it. */
type Inference = {
  requestId: string | undefined;
  model: string;
  sessionId: string | undefined;
  usage: Record<string, unknown>;
  finishReason: string | undefined;
  /** When the window that produced this response opened. */
  startTime: number;
  /** When the response arrived. Fixed at first sight — see the class docblock. */
  endTime: number;
  parts: SpanMessagePart[];
  /** The conversation as it stood when this response began: what the model was asked. */
  inputMessages: SpanMessage[];
  /** `null` on the main thread; the `Task` tool call id for a subagent's own calls. */
  parentToolUseId: string | null;
  /** The agent definition a subagent ran under, absent on the main thread. */
  subagentType: string | undefined;
};

/**
 * The tools the model could call, widened as the run reports more.
 *
 * The AI Config's own tools are known before the run starts. The ones Claude Code brings itself
 * (Read, Bash, and the rest) are announced only in the `init` message, and only by name — their
 * schemas stay in that process. A name with no `parameters` says "this tool was offered, its schema
 * is not ours to state", which describes the run better than omitting a tool the model could see.
 *
 * Every entry is keyed on the name the model saw, which is also the name that tool's `execute_tool`
 * span carries. That is what lets a reader join the catalog to the calls made against it, and it is
 * why an AI Config tool cannot simply be catalogued under its AI Config key:
 *
 * | AI Config key | what the model saw          | catalogued as | schema        |
 * |---------------|-----------------------------|---------------|---------------|
 * | `search`      | `mcp__tool-mcp__search`     | `search`      | AI Config's   |
 * | `webSearch`   | `WebSearch` (provider tool) | `WebSearch`   | AI Config's   |
 * | —             | `Read` (CLI's own)          | `Read`        | none reported |
 *
 * The middle row is the one that needs the alias map: a `NativeTool` binds an AI Config key to a
 * provider tool whose name is its own (`webSearch` → `WebSearch`). Catalogued under the AI Config
 * key it would appear twice — once with the schema and once, from `init`, without.
 *
 * Shared between the root and the `chat` spans so the two cannot disagree about the same attribute.
 */
class ToolCatalog {
  private readonly definitions: ToolDefinitionInput[];
  private readonly named: Set<string>;

  /**
   * `nativeNames` maps an AI Config key to the provider tool name it stands for, for the config's
   * native tools. Absent entries are user-defined tools, catalogued under their own name.
   */
  constructor(configTools: Record<string, Tool> | undefined, nativeNames: ReadonlyMap<string, string>) {
    this.definitions = Object.entries(configTools ?? {}).map(([key, tool]) => ({
      name: nativeNames.get(key) ?? tool.name ?? key,
      description: tool.description,
      parameters: tool.parameters,
    }));
    this.named = new Set(this.definitions.map((definition) => definition.name));
  }

  /** A copy, so widening the catalog later cannot alter a span already written from it. */
  get current(): ToolDefinitionInput[] {
    return [...this.definitions];
  }

  /**
   * Absorbs the `init` message's tool list. Reports whether anything was added, so the caller
   * rewrites the root's attribute only when there is something new to say.
   *
   * Compared on display names: the CLI lists an AI Config tool under its MCP name
   * (`mcp__tool-mcp__myTool`), which would otherwise be added a second time alongside the entry
   * that already has its schema.
   */
  widen(names: unknown): boolean {
    if (!Array.isArray(names)) return false;
    let added = false;
    for (const name of names) {
      if (typeof name !== 'string') continue;
      const display = toolDisplayName(name);
      if (this.named.has(display)) continue;
      this.named.add(display);
      this.definitions.push({ name: display });
      added = true;
    }
    return added;
  }
}

/**
 * Whether a non-assistant message marks the end of local work, and so the start of the window that
 * will produce the next response.
 *
 * Only two kinds do. A `user` message carries the tool results the next call is being sent, and a
 * `system` `init` opens the session. Everything else is progress reporting *during* a call:
 * `stream_event` deltas, and `system` messages whose subtype is not `init` — measured against Agent
 * SDK 0.3.220, the CLI emits a burst of `system` `thinking_tokens` messages while a call is in
 * flight, the last of them arriving in the same millisecond as the response. Treating those as
 * boundaries collapsed every window: a live 4-call run reported 34ms, 2ms, 6ms and 3ms for calls
 * that took 2.9s, 1.5s, 1.1s and 12.7s.
 *
 * A whitelist rather than a blocklist, so a subtype added by a future CLI is inert here instead of
 * silently zeroing the timings again.
 */
function marksLocalWork(message: { type: string }): boolean {
  if (message.type === 'user') return true;
  return message.type === 'system' && (message as { subtype?: string }).subtype === 'init';
}

/**
 * Emits the run's `chat` spans, one per API call.
 *
 * `query()` reports no request boundaries, and an `assistant` message is not one. The CLI emits a
 * message per content block of a response and dispatches those blocks one at a time, so a single
 * API call surfaces as several messages that share a `request_id` and repeat the same `usage` bag —
 * with tool executions interleaved between them. Measured on a live 8-turn run, treating each
 * message as a call produced 55 spans for 22 real calls and counted every call's tokens two to four
 * times over.
 *
 * So `request_id` is the unit, accumulated across the whole run rather than only while consecutive:
 * the messages of one response are not adjacent in the stream. Usage and identity are written once,
 * from the first message; later messages contribute only their content blocks.
 *
 * A response's `endTime` is pinned to that first message, because that is when the API returned it —
 * the CLI already held every block by then, and extending the span to the last message would put the
 * intervening tool executions inside the model call. The window opens at the previous response's
 * arrival or the last non-assistant message, whichever is later. What it cannot separate out is a
 * request the CLI retried internally, which lands inside the window instead of beside it.
 *
 * Spans are built at `finish()` rather than as messages arrive, so a response is described once, in
 * full, with explicit start and end timestamps. `finish()` must therefore run even when the run
 * throws: the exporter only receives ended spans.
 */
class InferenceSpans {
  /** When the window that will produce the next response opened. */
  private boundary = Date.now();
  /** Insertion-ordered, so spans are emitted in the order the responses arrived. */
  private readonly inferences: Inference[] = [];
  private readonly byRequestId = new Map<string, Inference>();
  /**
   * One conversation per agent thread, keyed by `parent_tool_use_id` (`null` = the main thread).
   *
   * A subagent's model calls arrive on the same stream as the main thread's and interleave with
   * them, so a single list would hand a main-thread call an input containing turns from a
   * conversation it was never part of.
   */
  private readonly threads = new Map<string | null, SpanMessage[]>();
  /**
   * The run total, in Anthropic's own field names, summed once per response.
   *
   * `finish()` splices the per-response list away as it emits, and the run's `result` message —
   * the only place the CLI reports a run-level total — never arrives when `query()` throws. So
   * without this the tokens a failed run really spent exist nowhere by the time the root is closed.
   *
   * Summed from `absorb`'s new-response branch, which means the usage bag a multi-block response
   * repeats on every message is counted exactly once: the same `request_id` grouping the spans
   * themselves rely on, and the same reason the earlier per-message counting overcounted by 2-4x.
   */
  private readonly totals = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  };
  private responses = 0;

  constructor(
    private readonly config: AiConfigRep,
    private readonly parentContext: Context,
    private readonly captureContent: boolean,
    private readonly catalog: ToolCatalog,
    /**
     * What the run opened with: the system prompt this handler supplied, if any, and the user's
     * message. Every `chat` span repeats them, because every call carried them.
     */
    private readonly opening: { systemInstructions?: string; messages: ReadonlyArray<SpanMessage> },
  ) {}

  /**
   * The conversation for one agent thread, started on first sight.
   *
   * Only the main thread's opening is known here. A subagent is given its prompt by the `Task` tool
   * call that spawned it, and that call's arguments already sit on its own `execute_tool` span — so
   * the thread starts from the turns this side actually saw rather than from a guess.
   */
  private threadFor(parentToolUseId: string | null): SpanMessage[] {
    let thread = this.threads.get(parentToolUseId);
    if (!thread) {
      // Copied, so growing the conversation cannot edit the caller's array.
      thread = parentToolUseId === null ? [...this.opening.messages] : [];
      this.threads.set(parentToolUseId, thread);
    }
    return thread;
  }

  /** Feed every message of the run, in order. */
  record(message: { type: string }): void {
    if (message.type === 'assistant') {
      this.absorb(message as AssistantResponse);
      return;
    }
    if (message.type === 'user') this.absorbUserTurn(message as UserTurn);
    if (marksLocalWork(message)) this.boundary = Date.now();
  }

  /**
   * Adds a user turn to the running conversation.
   *
   * These are the tool results and injected context the next call is being sent, which this handler
   * previously read only as a clock tick. Turns the CLI synthesised itself are kept: the model saw
   * them, and a conversation with them removed is one that never happened.
   */
  private absorbUserTurn(message: UserTurn): void {
    const parts = toSpanParts(message.message?.content);
    // A turn whose blocks are all kinds a span has no part for (images, documents) would otherwise
    // land as an empty message, which reads as a turn that said nothing.
    if (parts.length === 0) return;
    // A subagent's tool results belong to that subagent's conversation, not the main thread's.
    this.threadFor(message.parent_tool_use_id ?? null).push({ role: message.message?.role ?? 'user', parts });
  }

  /**
   * Emits a span per response and clears the accumulator.
   *
   * Idempotent, so it is safe on both the success and the error path — and required on the error
   * path, since a response never turned into a span is a call missing from the trace entirely.
   */
  finish(): void {
    if (this.inferences.length === 0) return;
    const pending = this.inferences.splice(0, this.inferences.length);
    this.byRequestId.clear();
    for (const inference of pending) this.emit(inference);
  }

  private absorb(message: AssistantResponse): void {
    const response = message.message;
    // No response body means no model call to describe.
    if (!response) return;

    const requestId = message.request_id;
    const known = requestId === undefined ? undefined : this.byRequestId.get(requestId);
    if (known) {
      // Another block of a response already recorded. Its usage is the same bag repeated, and its
      // arrival time has passed, so only the content is new.
      known.parts.push(...toSpanParts(response.content));
      if (response.stop_reason) known.finishReason = toSemconvFinishReason(response.stop_reason);
      return;
    }

    const now = Date.now();
    const parentToolUseId = message.parent_tool_use_id ?? null;
    const thread = this.threadFor(parentToolUseId);
    const inference: Inference = {
      requestId,
      parentToolUseId,
      subagentType: message.subagent_type,
      model: response.model ?? this.config.model.name,
      sessionId: message.session_id,
      usage: response.usage ?? {},
      // Mapped at capture rather than at either use, so the span attribute and the output message
      // cannot disagree: Anthropic's `end_turn` is semconv's `stop`.
      finishReason: toSemconvFinishReason(response.stop_reason),
      startTime: this.boundary,
      endTime: now,
      parts: toSpanParts(response.content),
      // Which turns this call was sent, captured before the reply below joins them — so a span never
      // reports its own answer as part of its own question.
      //
      // The list is copied but the turns inside it are shared on purpose. The CLI holds a whole
      // response before dispatching any of its blocks, so the request that followed carried the
      // complete assistant turn; a block still arriving here belonged to it all along. Spans are
      // built at `finish()`, by which point every turn is whole, so sharing reports what was really
      // sent. Copying the turns instead would freeze each one mid-assembly and drop blocks the model
      // demonstrably saw.
      inputMessages: [...thread],
    };
    this.inferences.push(inference);
    // Without a request_id there is nothing to group on, so the message stands alone rather than
    // being merged into an unrelated call.
    if (requestId !== undefined) this.byRequestId.set(requestId, inference);
    // The same array the span will report, so the later blocks of this response grow the turn the
    // next call is sent and the turn this span describes together, rather than only one of them.
    thread.push({ role: 'assistant', parts: inference.parts });
    const usage = inference.usage as Record<string, unknown>;
    this.responses++;
    this.totals.input_tokens += numberOrZero(usage.input_tokens);
    this.totals.output_tokens += numberOrZero(usage.output_tokens);
    this.totals.cache_read_input_tokens += numberOrZero(usage.cache_read_input_tokens);
    this.totals.cache_creation_input_tokens += numberOrZero(usage.cache_creation_input_tokens);
    // The next call cannot have started before this response arrived.
    this.boundary = now;
  }

  /**
   * The run's spend so far, for the paths where the CLI never reported its own total.
   *
   * `reported` is false only when no response was ever absorbed. Writing an all-zero total in that
   * case would assert the run cost nothing, which a run that died before its first response cannot
   * honestly claim, so the caller skips the write entirely.
   */
  get runUsage(): { total: Record<string, number>; reported: boolean } {
    return { total: this.totals, reported: this.responses > 0 };
  }

  private emit(inference: Inference): void {
    // `{operation} {request.model}` per the semantic conventions. `inference.model` rather than
    // `config.model.name`: the CLI reports the model it actually used, which is what this span's
    // `gen_ai.request.model` is set from just below, and the two must not disagree.
    const span = trace
      .getTracer('@launchdarkly/ai-claude-agents')
      .startSpan(`chat ${inference.model}`, { startTime: inference.startTime }, this.parentContext);
    span.setAttribute('gen_ai.operation.name', 'chat');
    setModelIdentityAttributes(span, 'anthropic', inference.model);
    span.setAttribute('gen_ai.response.model', inference.model);
    if (inference.requestId) span.setAttribute('gen_ai.response.id', inference.requestId);
    if (inference.sessionId) span.setAttribute('gen_ai.conversation.id', inference.sessionId);
    // An array because a single response may hold several choices; Anthropic returns one. Already
    // mapped onto the semconv vocabulary where the inference was captured.
    //
    // Absent in practice: measured against Agent SDK 0.3.220, `stop_reason` and `stop_details` are
    // both null on every assistant message and only the run-level `result` message carries one.
    // Written the moment the SDK populates it. Deriving `tool_use` from the presence of a
    // `tool_use` content block would put a value on the span the provider never returned.
    if (inference.finishReason) span.setAttribute('gen_ai.response.finish_reasons', [inference.finishReason]);
    setUsageSpanAttributes(span, addCachedTokensToInput(inference.usage));
    // Names the agent whose call this was, so a reader can tell why a subagent's `chat` spans do not
    // chain onto the main thread's. Absent on the main thread, which is the run itself.
    if (inference.subagentType) span.setAttribute('gen_ai.agent.name', inference.subagentType);
    // The turns that preceded this response, as they stood when it began — not the request the CLI
    // assembled, whose own system prompt and native tool schemas never reach this side. See the
    // file header.
    const mainThread = inference.parentToolUseId === null;
    setInputContentAttributes(span, this.captureContent, {
      // Both only on the main thread. A subagent runs under its own agent definition's prompt and
      // its own subset of tools, neither of which this side is told — so repeating the run's would
      // describe a call that was never made.
      systemInstructions: mainThread ? this.opening.systemInstructions : undefined,
      messages: inference.inputMessages,
      toolDefinitions: mainThread ? this.catalog.current : undefined,
    });
    setOutputContentAttributes(span, this.captureContent, [
      { role: 'assistant', parts: inference.parts, finishReason: inference.finishReason },
    ]);
    span.setStatus({ code: SpanStatusCode.OK });
    span.end(inference.endTime);
  }
}

/**
 * Copies the CLI's session id onto the root span as `gen_ai.conversation.id`.
 *
 * It is the only key LaunchDarkly's trace view groups a conversation on, and the `init` message
 * is where this side first learns it. The `chat` and `execute_tool` children read the same id
 * off their own message and hook input, so one run does not split into several conversations.
 * Set once — the id does not change within a run.
 */
function recordConversationId(span: Span, message: { type: string }): void {
  if (message.type !== 'system') return;
  const init = message as { subtype?: string; session_id?: string };
  if (init.subtype !== 'init' || !init.session_id) return;
  span.setAttribute('gen_ai.conversation.id', init.session_id);
}

/**
 * Widens the root's tool catalog once the CLI names the tools it brought itself.
 *
 * The root's catalog is written before the run starts, so a run that dies before `init` still
 * reports the tools it was configured with. `init` is the first place the CLI's own tools become
 * visible, and rewriting the one attribute keeps the root and the `chat` spans from describing the
 * same catalog differently. Only that attribute is rewritten — the root's messages were already
 * right.
 */
function recordNativeTools(span: Span, message: { type: string }, capture: boolean, catalog: ToolCatalog): void {
  if (message.type !== 'system') return;
  const init = message as { subtype?: string; tools?: unknown };
  if (init.subtype !== 'init') return;
  if (catalog.widen(init.tools)) setToolDefinitionAttributes(span, capture, catalog.current);
}

/**
 * `endedSpans` is passed only from the streaming path, where a `finally` may race this to the same
 * span; elsewhere there is exactly one end and the tracker is unnecessary.
 */
function failSpan(span: Span, error: unknown, endedSpans?: Set<Span>): void {
  const exception = error instanceof Error ? error : new Error(String(error));
  span.recordException(exception);
  span.setStatus({ code: SpanStatusCode.ERROR, message: exception.message });
  if (endedSpans) endSpanOnce(span, endedSpans);
  else span.end();
}

/**
 * Builds the error for a non-success result message.
 *
 * `SDKResultError` has no `result` field, so the old `'result' in message` gate never matched one:
 * the loop simply ended, the run was reported OK with zeroed usage, and the real token spend and
 * `errors` were discarded. A run that hit `error_max_turns` or `error_max_budget_usd` genuinely
 * failed and has to surface as a failure.
 */
function resultError(subtype: string, errors: ReadonlyArray<string> | undefined): Error {
  const detail = errors?.length ? `: ${errors.join('; ')}` : '';
  return new Error(`Claude agent run ended with ${subtype}${detail}`);
}

/**
 * Converts the content blocks of one assistant message into canonical span message parts.
 *
 * Structural narrowing rather than the SDK's union: the agent SDK re-exports Anthropic's beta block
 * types, and block kinds a span has no part for (images, documents) are dropped rather than emitted
 * malformed.
 */
function toSpanParts(content: unknown): SpanMessagePart[] {
  if (typeof content === 'string') return content ? [{ type: 'text', content }] : [];
  if (!Array.isArray(content)) return [];

  const parts: SpanMessagePart[] = [];
  for (const block of content as Array<Record<string, unknown>>) {
    switch (block.type) {
      case 'text':
        parts.push({ type: 'text', content: String(block.text ?? '') });
        break;
      case 'thinking':
        parts.push({ type: 'reasoning', content: String(block.thinking ?? '') });
        break;
      case 'tool_use':
        parts.push({
          type: 'tool_call',
          id: typeof block.id === 'string' ? block.id : undefined,
          name: String(block.name ?? ''),
          arguments: block.input,
        });
        break;
      case 'tool_result':
        parts.push({
          type: 'tool_call_response',
          id: typeof block.tool_use_id === 'string' ? block.tool_use_id : undefined,
          result: block.content,
        });
        break;
    }
  }
  return parts;
}

function toolDisplayName(providerName: string): string {
  return providerName.startsWith(MCP_TOOL_PREFIX) ? providerName.slice(MCP_TOOL_PREFIX.length) : providerName;
}

function buildToolHooks(nativeToolMap: Map<string, ToolHandlerFn>, parentContext: Context, captureContent: boolean) {
  const toolSpans = new Map<string, Span>();
  const finishToolSpan = (input: HookInput, error?: unknown) => {
    if (!('tool_use_id' in input)) return;
    const span = toolSpans.get(input.tool_use_id);
    if (!span) return;
    toolSpans.delete(input.tool_use_id);
    if ('tool_response' in input) {
      setToolCallContentAttributes(span, captureContent, { result: input.tool_response });
    }
    if (error === undefined) {
      span.setStatus({ code: SpanStatusCode.OK });
      span.end();
    } else {
      failSpan(span, error);
    }
  };

  return {
    hooks: {
      PreToolUse: [
        {
          hooks: [
            async (input: HookInput) => {
              if (input.hook_event_name === 'PreToolUse') {
                const stub = nativeToolMap.get(input.tool_name);
                if (stub) (stub as () => void)();

                const toolName = toolDisplayName(input.tool_name);
                const span = trace
                  .getTracer('@launchdarkly/ai-claude-agents')
                  .startSpan(`execute_tool ${toolName}`, undefined, parentContext);
                span.setAttribute('gen_ai.operation.name', 'execute_tool');
                span.setAttribute('gen_ai.tool.name', toolName);
                span.setAttribute('gen_ai.tool.call.id', input.tool_use_id);
                // Same grouping key as the root and as the CLI's own spans; the hook input is
                // where this side sees it without waiting for a message.
                if (input.session_id) span.setAttribute('gen_ai.conversation.id', input.session_id);
                setToolCallContentAttributes(span, captureContent, { arguments: input.tool_input });
                toolSpans.set(input.tool_use_id, span);
              }
              return { continue: true };
            },
          ],
        },
      ],
      PostToolUse: [
        {
          hooks: [
            async (input: HookInput) => {
              if (input.hook_event_name === 'PostToolUse') finishToolSpan(input);
              return { continue: true };
            },
          ],
        },
      ],
      PostToolUseFailure: [
        {
          hooks: [
            async (input: HookInput) => {
              if (input.hook_event_name === 'PostToolUseFailure') finishToolSpan(input, input.error);
              return { continue: true };
            },
          ],
        },
      ],
    },
    closeOpenSpans(error: unknown) {
      for (const span of toolSpans.values()) failSpan(span, error);
      toolSpans.clear();
    },
  };
}

export const buildToolMCP = async (configTools: Record<string, Tool>, handlers: Record<string, ToolHandlerFn>) => {
  const toolRepository = Object.keys(configTools).map((toolName) => {
    return tool(
      toolName,
      configTools[toolName].description ?? '',
      z.fromJSONSchema(configTools[toolName].parameters) as unknown as Record<string, z.ZodType<unknown>>,
      // biome-ignore lint/suspicious/noExplicitAny: Claude SDK tool() callback receives typed args from zod schema at runtime
      async (...args: any[]) => {
        const handler = handlers[toolName];
        if (!handler) {
          throw new Error(`No handler registered for tool "${toolName}"`);
        }
        const result = await (handler as (...args: unknown[]) => unknown)(...args);
        return { content: [{ type: 'text' as const, text: String(result) }] };
      },
    );
  });

  const server = createSdkMcpServer({
    name: TOOL_MCP_NAME,
    version: '1.0.0',
    tools: toolRepository,
  });

  return server;
};

/**
 * Splits wrapped toolHandlers into two buckets:
 * - `nativeToolMap`: provider tool name → tracking stub (for PreToolUse hook)
 * - `userConfigTools`: subset of config.tools that are user-defined (for MCP)
 * - `nativeToolNames`: provider-facing names to pass to `query({ tools: [...] })`
 */
export const partitionTools = (
  configTools: Record<string, Tool> | undefined,
  toolHandlers: Record<string, ToolHandlerFn>,
): {
  nativeToolMap: Map<string, ToolHandlerFn>;
  userConfigTools: Record<string, Tool>;
  nativeToolNames: string[];
  /**
   * AI Config key → provider tool name, for the config's native tools only.
   *
   * `nativeToolMap` is keyed the other way round, by provider name, which loses the AI Config key —
   * and the key is what a config's declared schema is filed under. `ToolCatalog` needs both ends to
   * report one tool once, under the name the model saw, with the schema the config gave it.
   */
  nativeToolAliases: Map<string, string>;
} => {
  const nativeToolMap = new Map<string, ToolHandlerFn>();
  const nativeToolAliases = new Map<string, string>();
  const userConfigTools: Record<string, Tool> = {};

  for (const [ldName, stub] of Object.entries(toolHandlers)) {
    const nativeTool = (stub as unknown as Record<symbol, unknown>)[NATIVE_TOOL_KEY] as NativeTool | undefined;
    if (nativeTool) {
      nativeToolMap.set(nativeTool.toolName, stub);
      nativeToolAliases.set(ldName, nativeTool.toolName);
    } else if (configTools?.[ldName]) {
      userConfigTools[ldName] = configTools[ldName];
    }
  }

  return {
    nativeToolMap,
    userConfigTools,
    nativeToolNames: [...nativeToolMap.keys()],
    nativeToolAliases,
  };
};

function formatHistory(history: Message[]): string {
  return history.map((m) => `${m.role}: ${m.content}`).join('\n');
}

export const buildPrompt = (
  config: AiConfigRep,
  userInput: string,
  variables: Record<string, unknown>,
  history?: Message[],
): { prompt: string; systemPrompt?: string } => {
  let systemPrompt: string | undefined;
  let prompt: string = userInput;

  if (config.instructions) {
    systemPrompt = parseTemplate(config.instructions, variables);
  } else if (config.messages && config.messages.length > 0) {
    const systemMessages = config.messages.filter((m) => m.role === 'system');
    const nonSystemMessages = config.messages.filter((m) => m.role !== 'system');

    systemPrompt =
      systemMessages.length > 0 ? parseTemplate(systemMessages.map((m) => m.content).join('\n'), variables) : undefined;

    const conversationHistory = nonSystemMessages.map((m) => `${parseTemplate(m.content, variables)}`).join('\n');
    prompt = conversationHistory ? `${conversationHistory}\n\n${userInput}` : userInput;
  }

  if (history && history.length > 0) {
    const historyBlock = `Conversation History:\n\n${formatHistory(history)}`;
    systemPrompt = systemPrompt ? `${systemPrompt}\n\n${historyBlock}` : historyBlock;
  }

  return { prompt, systemPrompt };
};

function buildQueryOptions(
  config: AiConfigRep,
  prompt: string,
  systemPrompt: string | undefined,
  nativeToolNames: string[],
  mcpAllowedTools: string[],
  // biome-ignore lint/suspicious/noExplicitAny: Claude SDK MCP server type is not publicly exported
  toolMCP: any,
  // biome-ignore lint/suspicious/noExplicitAny: Claude SDK hooks config type is not publicly exported
  hooks: any,
  extra?: Record<string, unknown>,
) {
  const allAllowedTools = [...mcpAllowedTools, ...nativeToolNames];
  return {
    prompt,
    options: {
      model: config.model.name,
      tools: nativeToolNames.length > 0 ? nativeToolNames : [],
      allowedTools: allAllowedTools.length > 0 ? allAllowedTools : undefined,
      mcpServers: toolMCP ? { [TOOL_MCP_NAME]: toolMCP } : undefined,
      hooks,
      ...(systemPrompt ? { systemPrompt } : {}),
      ...extra,
    },
  };
}

export function createClaudeAgentsHandler({ captureContent = false }: ContentCaptureOptions = {}): ProviderHandler {
  return createHandler(
    ['Anthropic', 'agent'],
    async (
      config: AiConfigRep,
      userInput = '',
      toolHandlers: Record<string, ToolHandlerFn> = {},
      variables: Record<string, unknown> = {},
      history?: Message[],
    ) => {
      return trace.getTracer('@launchdarkly/ai-claude-agents').startActiveSpan('invoke_agent', async (span) => {
        span.setAttribute('gen_ai.operation.name', 'invoke_agent');
        setModelIdentityAttributes(span, 'anthropic', config.model.name);
        setLdSpanAttributes(span, variables);
        // Explicit rather than a bare `context.active()`: the active context only carries this
        // span while an OTel ContextManager is registered, so a host app that installs its own
        // TracerProvider without one would otherwise get a flat trace.
        const parentContext = trace.setSpan(context.active(), span);

        let { prompt, systemPrompt } = buildPrompt(config, userInput, variables, history);
        if (config.outputFormat) {
          const schemaInstruction = `Respond with valid JSON matching this schema:\n${JSON.stringify(config.outputFormat)}`;
          systemPrompt = systemPrompt ? `${systemPrompt}\n\n${schemaInstruction}` : schemaInstruction;
        }
        // One user message, not one per configured role: `query()` takes a single prompt string, so
        // `buildPrompt` really does flatten a configured history into one turn before the model sees
        // it. Reporting the roles separately here would describe a request that was never sent.
        const opening = {
          systemInstructions: systemPrompt,
          messages: [{ role: 'user', parts: [{ type: 'text' as const, content: prompt }] }],
        };
        // Hoisted above the `try` because the catalog needs its alias map to name a native tool the
        // way the model saw it. Pure bookkeeping over two objects already in hand — nothing here can
        // fail in a way the root span would want to report.
        const { nativeToolMap, userConfigTools, nativeToolNames, nativeToolAliases } = partitionTools(
          config.tools,
          toolHandlers,
        );
        const catalog = new ToolCatalog(config.tools, nativeToolAliases);
        setInputContentAttributes(span, captureContent, { ...opening, toolDefinitions: catalog.current });

        // Declared out here so `catch` can end a chat span the throw left open.
        const inference = new InferenceSpans(config, parentContext, captureContent, catalog, opening);
        let toolTelemetry: ReturnType<typeof buildToolHooks> | undefined;
        // Set wherever the root's usage is written, so the failure path can tell whether the CLI
        // already reported an authoritative run-level total and must not be overwritten.
        let rootUsageWritten = false;
        try {
          const toolMCP =
            Object.keys(userConfigTools).length > 0 ? await buildToolMCP(userConfigTools, toolHandlers) : undefined;
          const mcpAllowedTools = Object.keys(userConfigTools).map((n) => MCP_TOOL_PREFIX + n);
          toolTelemetry =
            nativeToolNames.length > 0 || mcpAllowedTools.length > 0
              ? buildToolHooks(nativeToolMap, parentContext, captureContent)
              : undefined;

          const output = '';

          for await (const message of query(
            buildQueryOptions(
              config,
              prompt,
              systemPrompt,
              nativeToolNames,
              mcpAllowedTools,
              toolMCP,
              toolTelemetry?.hooks,
            ),
          )) {
            recordConversationId(span, message);
            recordNativeTools(span, message, captureContent, catalog);
            inference.record(message);

            if (message.type === 'result') {
              // Before the root, so the children it parents are already closed.
              inference.finish();
              const rawUsage = (message.usage ?? {}) as Record<string, unknown>;
              finishRootSpan(span, config, rawUsage);
              // The CLI's own run-level total is authoritative, so the catch below must not
              // overwrite it with the summed-per-response figure on the error-result path.
              rootUsageWritten = true;
              if (message.subtype !== 'success') {
                throw resultError(message.subtype, message.errors);
              }
              setOutputContentAttributes(span, captureContent, [
                {
                  role: 'assistant',
                  parts: [
                    {
                      type: 'text',
                      content: typeof message.result === 'string' ? message.result : JSON.stringify(message.result),
                    },
                  ],
                },
              ]);
              span.setStatus({ code: SpanStatusCode.OK });
              span.end();
              return { output: message.result, usage: rawUsage };
            }
          }

          // The stream ended without a result message, so no message closed the last response —
          // and no message carried a run-level total either. The per-response sum is the only
          // record of what the run spent; this used to report a local that was never incremented,
          // so a run ending this way always claimed zero tokens.
          inference.finish();
          const streamedUsage = inference.runUsage;
          finishRootSpan(span, config, streamedUsage.total);
          rootUsageWritten = true;
          span.setStatus({ code: SpanStatusCode.OK });
          span.end();
          return { output, usage: streamedUsage.total };
        } catch (err) {
          // Before the root: the exporter only receives ended spans, so a chat span left open by
          // the throw would never reach the trace.
          inference.finish();
          toolTelemetry?.closeOpenSpans(err);
          // No `result` message ever arrived, so the run's spend was only ever visible per
          // response. Those tokens were billed, and the root is the only span a config-scoped
          // cost query can find them on.
          if (!rootUsageWritten && inference.runUsage.reported) {
            finishRootSpan(span, config, inference.runUsage.total);
          }
          failSpan(span, err);
          throw err;
        }
      });
    },
    async function* streamHandler(
      config: AiConfigRep,
      userInput = '',
      toolHandlers: Record<string, ToolHandlerFn> = {},
      variables: Record<string, unknown> = {},
      history?: Message[],
    ) {
      const span = trace.getTracer('@launchdarkly/ai-claude-agents').startSpan('invoke_agent');
      span.setAttribute('gen_ai.operation.name', 'invoke_agent');
      setModelIdentityAttributes(span, 'anthropic', config.model.name);
      setLdSpanAttributes(span, variables);
      const parentContext = trace.setSpan(context.active(), span);

      // A consumer that `break`s out of `for await`, or throws inside the loop body, makes this
      // generator run `finally` without ever entering `catch`. Without the cleanup there the root
      // span is never ended, so it is never exported, and the whole run disappears from AI Config
      // Monitoring along with the `feature_flag` event it carries.
      const endedSpans = new Set<Span>();

      const { prompt, systemPrompt } = buildPrompt(config, userInput, variables, history);
      // One user message — see the blocking path for why the configured roles are not split out.
      const opening = {
        systemInstructions: systemPrompt,
        messages: [{ role: 'user', parts: [{ type: 'text' as const, content: prompt }] }],
      };
      // Hoisted above the `try` for the same reason as the blocking path.
      const { nativeToolMap, userConfigTools, nativeToolNames, nativeToolAliases } = partitionTools(
        config.tools,
        toolHandlers,
      );
      const catalog = new ToolCatalog(config.tools, nativeToolAliases);
      setInputContentAttributes(span, captureContent, { ...opening, toolDefinitions: catalog.current });

      // Declared out here so `finally` can end a chat span left open by an error or abandonment.
      const inference = new InferenceSpans(config, parentContext, captureContent, catalog, opening);
      let toolTelemetry: ReturnType<typeof buildToolHooks> | undefined;
      // Set wherever the root's usage is written, so the failure and abandonment paths can tell
      // whether the CLI already reported an authoritative run-level total.
      let rootUsageWritten = false;
      try {
        const toolMCP =
          Object.keys(userConfigTools).length > 0 ? await buildToolMCP(userConfigTools, toolHandlers) : undefined;
        const mcpAllowedTools = Object.keys(userConfigTools).map((n) => MCP_TOOL_PREFIX + n);
        toolTelemetry =
          nativeToolNames.length > 0 || mcpAllowedTools.length > 0
            ? buildToolHooks(nativeToolMap, parentContext, captureContent)
            : undefined;

        let fullOutput = '';

        for await (const message of query(
          buildQueryOptions(
            config,
            prompt,
            systemPrompt,
            nativeToolNames,
            mcpAllowedTools,
            toolMCP,
            toolTelemetry?.hooks,
            {
              includePartialMessages: true,
            },
          ),
        )) {
          recordConversationId(span, message);
          recordNativeTools(span, message, captureContent, catalog);
          inference.record(message);

          // SDKPartialAssistantMessage: { type: 'stream_event', event: BetaRawMessageStreamEvent }
          if (message.type === 'stream_event') {
            // biome-ignore lint/suspicious/noExplicitAny: Claude SDK stream_event shape is not typed in public API
            const event = (message as any).event;
            if (
              event?.type === 'content_block_delta' &&
              event?.delta?.type === 'text_delta' &&
              typeof event?.delta?.text === 'string'
            ) {
              yield { type: 'chunk' as const, text: event.delta.text };
              fullOutput += event.delta.text;
            }
          } else if (message.type === 'result') {
            // Before the root, so the children it parents are already closed.
            inference.finish();
            // biome-ignore lint/suspicious/noExplicitAny: Claude SDK result message usage field is not typed publicly
            const rawUsage = ((message as any).usage ?? {}) as Record<string, unknown>;
            // Cumulative for the run, so it belongs on the root.
            finishRootSpan(span, config, rawUsage);
            // Authoritative: the paths below must not overwrite it with the per-response sum.
            rootUsageWritten = true;
            if (message.subtype !== 'success') {
              throw resultError(message.subtype, message.errors);
            }
            setOutputContentAttributes(span, captureContent, [
              // biome-ignore lint/suspicious/noExplicitAny: Claude SDK result field is not typed publicly
              { role: 'assistant', parts: [{ type: 'text', content: (message as any).result ?? fullOutput }] },
            ]);
            span.setStatus({ code: SpanStatusCode.OK });
            endSpanOnce(span, endedSpans);
            // biome-ignore lint/suspicious/noExplicitAny: Claude SDK result field is not typed publicly
            yield { type: 'done' as const, output: (message as any).result ?? fullOutput, usage: rawUsage };
            return;
          }
        }

        // The stream ended without a result message, so nothing carried a run-level total. The
        // per-response sum is the only record of the spend; this used to write an empty bag, so a
        // run ending this way always reported zero tokens for calls that really happened.
        inference.finish();
        const streamedUsage = inference.runUsage;
        finishRootSpan(span, config, streamedUsage.total);
        rootUsageWritten = true;
        setOutputContentAttributes(span, captureContent, [
          { role: 'assistant', parts: [{ type: 'text', content: fullOutput }] },
        ]);
        span.setStatus({ code: SpanStatusCode.OK });
        endSpanOnce(span, endedSpans);
        yield { type: 'done' as const, output: fullOutput, usage: streamedUsage.total };
      } catch (err) {
        toolTelemetry?.closeOpenSpans(err);
        if (!rootUsageWritten && inference.runUsage.reported) {
          finishRootSpan(span, config, inference.runUsage.total);
          rootUsageWritten = true;
        }
        failSpan(span, err, endedSpans);
        throw err;
      } finally {
        // Idempotent, and a no-op on the success path where the result message already closed the
        // last response. On the error and abandonment paths it is the only thing that ends a chat
        // span still open — and the exporter only receives ended spans.
        inference.finish();
        // A no-op on the success and failure paths; on abandonment it is the only chance to close
        // the tree, including any tool span whose PostToolUse hook never fired — and the only
        // chance to report what the responses that did arrive cost.
        if (!endedSpans.has(span)) {
          toolTelemetry?.closeOpenSpans(new Error('stream abandoned before completion'));
          if (!rootUsageWritten && inference.runUsage.reported) {
            finishRootSpan(span, config, inference.runUsage.total);
          }
        }
        endSpanOnce(span, endedSpans, true);
      }
    },
  );
}

export const claudeAgents = (
  configKey: string,
  userInput: string,
  context: LDContext,
  // Both `captureContent` and `variables` are lifted out of `options`: the first configures the
  // handler, the second belongs to the invocation. Passing either through to `config()` drops it —
  // which is how a `{{user_input}}` placeholder used to reach the model unsubstituted whenever a
  // caller used one of these wrappers instead of `config().invoke()`.
  {
    captureContent,
    variables,
    ...options
  }: Omit<Parameters<typeof config>[0], 'handler' | 'key'> &
    ContentCaptureOptions & {
      /** Template variables for the config's prompt. Forwarded to `invoke`, not to `config`. */
      variables?: Record<string, unknown>;
    } = {},
) =>
  config({ ...options, key: configKey, handler: createClaudeAgentsHandler({ captureContent }) }).invoke(
    userInput,
    context,
    variables,
  );
