import {
  type AiConfigRep,
  type ContentCaptureOptions,
  config,
  createHandler,
  endSpanOnce,
  type LDContext,
  type Message,
  type NativeTool,
  type ProviderHandler,
  parseTemplate,
  type SpanMessage,
  type SpanMessagePart,
  type SpanUsage,
  setInputContentAttributes,
  setLdSpanAttributes,
  setModelIdentityAttributes,
  setOutputContentAttributes,
  setToolCallContentAttributes,
  setUsageSpanAttributes,
  type Tool,
  type ToolDefinitionInput,
  type ToolHandlerFn,
} from '@launchdarkly/ai-server';
import type {
  Model,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  RunRawModelStreamEvent,
  StreamEvent,
  StreamedRunResult,
} from '@openai/agents';
import { Agent, Runner, tool } from '@openai/agents';
import { type Context, context, type Span, SpanStatusCode, trace } from '@opentelemetry/api';
import { buildOutputType } from './utils.js';

const TRACER_NAME = '@launchdarkly/ai-openai-agents';

/**
 * Coerces a provider-reported token count to a finite number, defaulting to 0.
 *
 * Provider SDKs report usage as loosely-typed bags where a field may be absent, null, or a
 * partially-populated streaming value. An emitted `NaN` is worse than an emitted 0: `trackTokens`
 * guards on `total > 0`, and `NaN > 0` is false, so the metric is dropped silently rather than
 * reported low.
 *
 * Deliberately local rather than imported from the core package. It carries no LaunchDarkly or AI
 * meaning, so exporting it would make a generic numeric coercion part of that package's published
 * API and bind it to semver for the life of the SDK.
 */
function numberOrZero(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * The semantic conventions name an inference span `{gen_ai.operation.name} {gen_ai.request.model}`,
 * so the model belongs in the name and not only in `gen_ai.request.model`. A bare `chat` — which
 * this emitted for a while — aggregates more neatly but tells a reader nothing about which model
 * ran, which matters most in exactly the case this span exists for: a multi-turn run that switches
 * models partway through.
 */
function startModelSpan(config: AiConfigRep, parentContext: Context): Span {
  const span = trace.getTracer(TRACER_NAME).startSpan(`chat ${config.model.name}`, undefined, parentContext);
  span.setAttribute('gen_ai.operation.name', 'chat');
  setModelIdentityAttributes(span, 'openai', config.model.name);
  return span;
}

/**
 * Writes the run-level identity and token totals onto the `invoke_agent` root.
 *
 * The root is the only span carrying `launchdarkly.*` and the `feature_flag` event, so it is the
 * span a config-scoped query finds; without the totals such a query returns nothing at all, and
 * the run-level aggregate exists on no span — summing children requires already having found them.
 */
function finishRootSpan(span: Span, config: AiConfigRep, usage: Record<string, unknown> | undefined): void {
  span.setAttribute('gen_ai.response.model', config.model.name);
  setUsageSpanAttributes(span, toSpanUsage(usage));
}

/**
 * The run aggregate the Agents SDK attaches to its own errors.
 *
 * `AgentsError` carries the `RunState` it failed in, and that state holds the same `usage` object
 * the success path reads off `result.state`. A run that throws has therefore already reported what
 * it spent — those tokens were really billed — and dropping it leaves a config-scoped cost query
 * reporting zero for the whole run, because the root is the only span carrying
 * `launchdarkly.config.key`. A live `MaxTurnsExceededError` run spent ~155k input tokens and
 * reported none of them.
 *
 * Read structurally rather than with `instanceof`: a tool handler's own error propagates unwrapped
 * and carries no state, and that case has to yield `undefined` so nothing is written. Writing zeros
 * instead would assert that the run spent nothing, which is a different claim and a false one.
 */
function usageFromError(error: unknown): Record<string, unknown> | undefined {
  const usage = (error as { state?: { usage?: unknown } } | null | undefined)?.state?.usage;
  return usage !== null && typeof usage === 'object' ? (usage as Record<string, unknown>) : undefined;
}

// OpenAI reports cached tokens *within* the input total (a subset), so — unlike Anthropic — they are
// not added on top. `inputTokensDetails` may be a single record or an array of them.
function sumCachedTokens(details: unknown): number {
  if (!details) return 0;
  const entries = Array.isArray(details) ? details : [details];
  return entries.reduce(
    (sum: number, entry) => sum + numberOrZero((entry as Record<string, unknown>)?.cached_tokens),
    0,
  );
}

/**
 * Reads the Agents SDK `Usage` object (camelCase: inputTokens/outputTokens/…) into `SpanUsage`.
 * OpenAI has no cache-creation category, so that count is always 0.
 *
 * The SDK's own `totalTokens` is deliberately ignored: it can include tokens that appear in
 * neither input nor output, which would make `total` derivable on every other handler and
 * not on this one.
 */
function toSpanUsage(usage: Record<string, unknown> | undefined): SpanUsage {
  return {
    input: numberOrZero(usage?.inputTokens),
    output: numberOrZero(usage?.outputTokens),
    cacheRead: sumCachedTokens(usage?.inputTokensDetails),
    cacheCreation: 0,
  };
}

/**
 * Maps one turn onto semconv's `finish_reasons` vocabulary.
 *
 * The value has to be derived, because neither the Agents SDK's `ModelResponse` nor the Responses
 * API underneath it has a per-message finish reason. What the Responses API reports is a *run*
 * `status`, plus a machine-readable cause when a run was cut short. `openai-messages` derives the
 * same three cases from the same two fields; this is deliberately the same mapping, since both
 * packages sit on the same API and a reader comparing their spans should not have to know which
 * handler produced one.
 *
 * Passing `status` straight through, as this used to, made the attribute worthless: a live
 * seven-turn capture put `"completed"` on all seven `chat` spans, including the six that stopped to
 * call a tool. Not only is `"completed"` absent from the semconv vocabulary, it was constant across
 * the run — the one thing a finish reason exists to distinguish is exactly what it hid.
 *
 * The output items are the authority on `tool_calls`, and the SDK normalises them on both the
 * blocking and the streaming path, so that case survives even when the raw object does not reach
 * us. Only when a turn reports neither a function call nor a recognised status is the attribute
 * left off, rather than guessing at `stop`.
 */
interface FinishedTurn {
  output?: ReadonlyArray<unknown>;
  providerData?: Record<string, unknown>;
}

/**
 * The terminal `response_done` event's payload — the only place a streamed turn reports its totals.
 * `providerData` is part of it for the same reason as above: the protocol carries it here too, and
 * reading only `output` would leave the streaming path unable to report anything but `tool_calls`.
 */
interface StreamedTurn extends FinishedTurn {
  usage?: Record<string, unknown>;
}

function finishReasons(turn: FinishedTurn | undefined): string[] | undefined {
  if (turn?.output?.some((item) => (item as { type?: unknown }).type === 'function_call')) return ['tool_calls'];
  const provider = turn?.providerData;
  if (!provider) return undefined;
  if (provider.status === 'incomplete') {
    const incomplete = (provider.incomplete_details ?? {}) as Record<string, unknown>;
    return [incomplete.reason === 'max_output_tokens' ? 'length' : 'content_filter'];
  }
  return provider.status === 'completed' ? ['stop'] : undefined;
}

function finishModelSpan(
  span: Span,
  config: AiConfigRep,
  usage: Record<string, unknown> | undefined,
  reasons?: string[],
): void {
  span.setAttribute('gen_ai.response.model', config.model.name);
  // An array because one response may hold several choices; the Responses API returns one.
  if (reasons?.length) span.setAttribute('gen_ai.response.finish_reasons', reasons);
  setUsageSpanAttributes(span, toSpanUsage(usage));
  span.setStatus({ code: SpanStatusCode.OK });
  span.end();
}

function startToolSpan(toolName: string, toolCallId: string, parentContext: Context): Span {
  const span = trace.getTracer(TRACER_NAME).startSpan(`execute_tool ${toolName}`, undefined, parentContext);
  span.setAttribute('gen_ai.operation.name', 'execute_tool');
  span.setAttribute('gen_ai.tool.name', toolName);
  span.setAttribute('gen_ai.tool.call.id', toolCallId);
  return span;
}

/**
 * `endedSpans` is passed from paths where a `finally` may race this to the same span; elsewhere
 * there is exactly one end and the tracker is unnecessary.
 */
function failSpan(span: Span, error: unknown, endedSpans?: Set<Span>): void {
  const exception = error instanceof Error ? error : new Error(String(error));
  span.recordException(exception);
  span.setStatus({ code: SpanStatusCode.ERROR, message: exception.message });
  if (endedSpans) endSpanOnce(span, endedSpans);
  else span.end();
}

/**
 * Converts one Agents-SDK item into canonical span message parts.
 *
 * The SDK's `AgentInputItem` / output item unions overlap with the Responses API shapes but are not
 * identical, so narrowing is structural. Item kinds a span has no part for are dropped rather than
 * emitted malformed.
 */
function itemParts(item: Record<string, unknown>): SpanMessagePart[] {
  if (item.type === 'function_call') {
    return [
      {
        type: 'tool_call',
        id: typeof item.callId === 'string' ? item.callId : undefined,
        name: String(item.name ?? ''),
        arguments: item.arguments,
      },
    ];
  }
  if (item.type === 'function_call_result') {
    return [
      {
        type: 'tool_call_response',
        id: typeof item.callId === 'string' ? item.callId : undefined,
        result: item.output,
      },
    ];
  }
  if (item.type === 'reasoning') {
    const content = Array.isArray(item.content)
      ? (item.content as Array<Record<string, unknown>>).map((entry) => String(entry.text ?? '')).join('\n')
      : '';
    return content ? [{ type: 'reasoning', content }] : [];
  }
  if (typeof item.content === 'string') return [{ type: 'text', content: item.content }];
  if (!Array.isArray(item.content)) return [];
  return (item.content as Array<Record<string, unknown>>)
    .filter((block) => block.type === 'input_text' || block.type === 'output_text' || block.type === 'text')
    .map((block) => ({ type: 'text' as const, content: String(block.text ?? '') }));
}

/** A model request's input, whether the SDK passed a bare string or a list of items. */
function requestMessages(input: string | ReadonlyArray<unknown> | undefined): SpanMessage[] {
  if (typeof input === 'string') return input ? [{ role: 'user', parts: [{ type: 'text', content: input }] }] : [];
  if (!Array.isArray(input)) return [];
  return (input as Array<Record<string, unknown>>).map((item) => ({
    role: typeof item.role === 'string' ? item.role : item.type === 'function_call_result' ? 'tool' : 'assistant',
    parts: itemParts(item),
  }));
}

const responseMessages = (output: ReadonlyArray<unknown>): SpanMessage[] =>
  (output as Array<Record<string, unknown>>).map((item) => ({
    role: typeof item.role === 'string' ? item.role : 'assistant',
    parts: itemParts(item),
  }));

/**
 * The tool catalog as the Runner serialized it for this turn.
 *
 * Read off the request rather than off the AI Config: the Agents SDK owns the loop and may add or
 * withhold tools (handoffs, hosted tools), so the request is the only accurate record of what the
 * model was offered.
 */
const toToolDefinitions = (tools: ReadonlyArray<unknown>): ToolDefinitionInput[] =>
  (tools as Array<Record<string, unknown>>)
    .filter((tool) => typeof tool.name === 'string')
    .map((tool) => ({
      name: String(tool.name),
      description: typeof tool.description === 'string' ? tool.description : undefined,
      parameters: tool.parameters,
    }));

/**
 * Wraps a resolved Agents-SDK model so each provider turn (`getResponse` / `getStreamedResponse`)
 * is bracketed by a `chat` child span with that turn's usage. The Agents SDK runs the loop
 * internally and exposes no per-turn hook, so intercepting the model is the reliable seam.
 */
class SpanningModel implements Model {
  constructor(
    private readonly inner: Model,
    private readonly config: AiConfigRep,
    private readonly parentContext: Context,
    private readonly captureContent: boolean,
  ) {}

  /** The request is the only place a `chat` span can learn what this turn actually saw. */
  private recordRequest(span: Span, request: ModelRequest): void {
    if (!this.captureContent) return;
    setInputContentAttributes(span, this.captureContent, {
      systemInstructions: request.systemInstructions,
      messages: requestMessages(request.input),
      toolDefinitions: toToolDefinitions(request.tools ?? []),
    });
  }

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    const span = startModelSpan(this.config, this.parentContext);
    this.recordRequest(span, request);
    try {
      const response = await this.inner.getResponse(request);
      if (this.captureContent) {
        setOutputContentAttributes(span, this.captureContent, responseMessages(response.output ?? []));
      }
      finishModelSpan(span, this.config, response.usage as unknown as Record<string, unknown>, finishReasons(response));
      return response;
    } catch (err) {
      failSpan(span, err);
      throw err;
    }
  }

  getStreamedResponse(request: ModelRequest): AsyncIterable<StreamEvent> {
    const { inner, config, parentContext, captureContent } = this;
    const recordRequest = (span: Span) => this.recordRequest(span, request);
    return (async function* () {
      const span = startModelSpan(config, parentContext);
      recordRequest(span);
      const endedSpans = new Set<Span>();
      let usage: Record<string, unknown> | undefined;
      let output: ReadonlyArray<unknown> | undefined;
      let reasons: string[] | undefined;
      try {
        for await (const event of inner.getStreamedResponse(request)) {
          // The terminal `response_done` event carries this turn's usage and its output items.
          if ((event as { type?: string }).type === 'response_done') {
            const response = (event as { response?: StreamedTurn }).response;
            usage = response?.usage;
            output = response?.output;
            reasons = finishReasons(response);
          }
          yield event;
        }
        if (captureContent) setOutputContentAttributes(span, captureContent, responseMessages(output ?? []));
        finishModelSpan(span, config, usage, reasons);
        endedSpans.add(span);
      } catch (err) {
        failSpan(span, err, endedSpans);
        throw err;
      } finally {
        // `StreamedRunResult.cancel()`, or a Runner that stops consuming, resumes this generator
        // at `return` — which runs `finally` without ever entering `catch`. Without this the chat
        // span would stay open and never be exported. `response_done` may already have arrived, so
        // whatever usage was captured is still worth recording.
        if (!endedSpans.has(span)) {
          if (captureContent) setOutputContentAttributes(span, captureContent, responseMessages(output ?? []));
          setUsageSpanAttributes(span, toSpanUsage(usage));
        }
        endSpanOnce(span, endedSpans, true);
      }
    })();
  }
}

/**
 * Reads the model provider the Agents SDK would use on its own.
 *
 * A bare `new Runner()` exposes it on its public `config`, and that is the only public way to
 * observe what `setDefaultModelProvider()` installed — the SDK exports the setter but no getter.
 * Hard-coding `new OpenAIProvider()` here instead, as this handler previously did, silently
 * redirected anyone routing through Azure, LiteLLM, Ollama or another custom `ModelProvider` back
 * to api.openai.com. Resolving per invocation also keeps late registration working and reuses the
 * SDK's own provider — and with it the model cache and OpenAI client — rather than building a
 * fresh one per request.
 */
function defaultModelProvider(): ModelProvider {
  return new Runner().config.modelProvider;
}

/** Resolves models via the SDK's own provider, then wraps each in a SpanningModel. */
class SpanningModelProvider {
  constructor(
    private readonly inner: ModelProvider,
    private readonly config: AiConfigRep,
    private readonly parentContext: Context,
    private readonly captureContent: boolean,
  ) {}

  async getModel(modelName?: string): Promise<Model> {
    const resolved = await this.inner.getModel(modelName);
    return new SpanningModel(resolved, this.config, this.parentContext, this.captureContent);
  }
}

/**
 * Attaches agent-level tool lifecycle listeners that emit one `execute_tool` child span per tool
 * call, keyed by the tool call id. Returns a cleanup that fails any spans still open on a crash.
 */
function attachToolSpanHooks(
  // biome-ignore lint/suspicious/noExplicitAny: Agent generic params are irrelevant to tool hooks
  agent: Agent<any, any>,
  parentContext: Context,
  captureContent: boolean,
) {
  const toolSpans = new Map<string, Span>();
  const callId = (details: { toolCall?: { callId?: string; id?: string; name?: string } }) =>
    details?.toolCall?.callId ?? details?.toolCall?.id ?? details?.toolCall?.name ?? 'tool';

  // biome-ignore lint/suspicious/noExplicitAny: Agents SDK tool hook argument types are not exported
  agent.on('agent_tool_start', (_context: unknown, tool: any, details: any) => {
    const span = startToolSpan(tool?.name ?? 'tool', callId(details), parentContext);
    setToolCallContentAttributes(span, captureContent, { arguments: details?.toolCall?.arguments });
    toolSpans.set(callId(details), span);
  });
  // biome-ignore lint/suspicious/noExplicitAny: Agents SDK tool hook argument types are not exported
  agent.on('agent_tool_end', (_context: unknown, _tool: any, result: any, details: any) => {
    const span = toolSpans.get(callId(details));
    if (!span) return;
    toolSpans.delete(callId(details));
    setToolCallContentAttributes(span, captureContent, { result });
    span.setStatus({ code: SpanStatusCode.OK });
    span.end();
  });

  return {
    closeOpenSpans(error: unknown) {
      for (const span of toolSpans.values()) failSpan(span, error);
      toolSpans.clear();
    },
  };
}

const buildAgentTools = (configTools: Record<string, Tool>, toolHandlers: Record<string, ToolHandlerFn | NativeTool>) =>
  Object.entries(configTools)
    .filter(([name]) => typeof toolHandlers[name] === 'function')
    .map(([name, toolConfig]) =>
      tool({
        name,
        description: toolConfig.description ?? '',
        strict: false,
        // biome-ignore lint/suspicious/noExplicitAny: OpenAI Agents SDK tool parameters type does not accept Record<string, unknown>
        parameters: toolConfig.parameters as any,
        execute: async (args) => {
          const handler = toolHandlers[name] as (...args: unknown[]) => unknown;
          const result = await handler(args);
          return String(result);
        },
      }),
    );

function formatHistory(history: Message[]): string {
  return history.map((m) => `${m.role}: ${m.content}`).join('\n');
}

function buildAgentAndPrompt(
  config: AiConfigRep,
  userInput: string,
  toolHandlers: Record<string, ToolHandlerFn | NativeTool>,
  variables: Record<string, unknown>,
  { includeOutputType = true }: { includeOutputType?: boolean } = {},
  history?: Message[],
) {
  let instructions: string | undefined;
  let prompt = userInput;

  if (config.instructions) {
    instructions = parseTemplate(config.instructions, variables);
  } else if (config.messages && config.messages.length > 0) {
    const systemMessages = config.messages.filter((m) => m.role === 'system');
    const conversationMessages = config.messages.filter((m) => m.role !== 'system');
    if (systemMessages.length > 0) {
      instructions = parseTemplate(systemMessages.map((m) => m.content).join('\n'), variables);
    }
    const configHistory = conversationMessages.map((m) => parseTemplate(m.content, variables)).join('\n');
    prompt = configHistory ? `${configHistory}\n\n${userInput}` : userInput;
  }

  if (history && history.length > 0) {
    const formatted = formatHistory(history);
    instructions = instructions
      ? `${instructions}\n\nConversation History:\n\n${formatted}`
      : `Conversation History:\n\n${formatted}`;
  }

  const tools = config.tools ? buildAgentTools(config.tools, toolHandlers) : [];

  const outputType = includeOutputType ? buildOutputType(config.outputFormat) : undefined;

  const agent = new Agent({
    name: 'assistant',
    model: config.model.name,
    ...(instructions ? { instructions } : {}),
    ...(tools.length > 0 ? { tools } : {}),
    ...(outputType ? { outputType } : {}),
  });

  return { agent, prompt, instructions };
}

export function createOpenAIAgentHandler({ captureContent = false }: ContentCaptureOptions = {}): ProviderHandler {
  return createHandler(
    ['OpenAI', 'agent'],
    async (
      config: AiConfigRep,
      userInput = '',
      toolHandlers: Record<string, ToolHandlerFn | NativeTool> = {},
      variables: Record<string, unknown> = {},
      history?: Message[],
    ) => {
      return trace.getTracer(TRACER_NAME).startActiveSpan('invoke_agent', async (span) => {
        span.setAttribute('gen_ai.operation.name', 'invoke_agent');
        setModelIdentityAttributes(span, 'openai', config.model.name);
        setLdSpanAttributes(span, variables);
        // Explicit rather than a bare `context.active()`: the active context only carries this
        // span while an OTel ContextManager is registered, so a host app that installs its own
        // TracerProvider without one would otherwise get a flat trace.
        const parentContext = trace.setSpan(context.active(), span);

        const { agent, prompt, instructions } = buildAgentAndPrompt(
          config,
          userInput,
          toolHandlers,
          variables,
          undefined,
          history,
        );
        setInputContentAttributes(span, captureContent, {
          systemInstructions: instructions,
          messages: [{ role: 'user', parts: [{ type: 'text', content: prompt }] }],
        });

        const toolTelemetry = attachToolSpanHooks(agent, parentContext, captureContent);
        const runner = new Runner({
          modelProvider: new SpanningModelProvider(defaultModelProvider(), config, parentContext, captureContent),
        });
        try {
          const result = await runner.run(agent, prompt);
          const finalOutput = result.finalOutput ?? '';
          const { inputTokens, outputTokens } = result.state.usage;

          setOutputContentAttributes(span, captureContent, [
            { role: 'assistant', parts: [{ type: 'text', content: String(finalOutput) }] },
          ]);
          finishRootSpan(span, config, result.state.usage as unknown as Record<string, unknown>);
          span.setStatus({ code: SpanStatusCode.OK });
          span.end();
          // When outputFormat is set the Agents SDK returns a parsed object; pass it through directly.
          const output = config.outputFormat ? finalOutput : String(finalOutput);
          return { output, usage: { input_tokens: inputTokens, output_tokens: outputTokens } };
        } catch (err) {
          toolTelemetry.closeOpenSpans(err);
          // The tokens a failed run already spent are still owed to whoever reads its cost.
          const spent = usageFromError(err);
          if (spent) finishRootSpan(span, config, spent);
          failSpan(span, err);
          throw err;
        }
      });
    },
    async function* streamHandler(
      config: AiConfigRep,
      userInput = '',
      toolHandlers: Record<string, ToolHandlerFn | NativeTool> = {},
      variables: Record<string, unknown> = {},
      history?: Message[],
    ) {
      const span = trace.getTracer(TRACER_NAME).startSpan('invoke_agent');
      span.setAttribute('gen_ai.operation.name', 'invoke_agent');
      setModelIdentityAttributes(span, 'openai', config.model.name);
      setLdSpanAttributes(span, variables);
      const parentContext = trace.setSpan(context.active(), span);

      // A consumer that `break`s out of `for await`, or throws inside the loop body, makes this
      // generator run `finally` without ever entering `catch`. Without the cleanup there the root
      // span is never ended, so it is never exported, and the whole run disappears from AI Config
      // Monitoring along with the `feature_flag` event it carries.
      const endedSpans = new Set<Span>();
      // Breaking out of `for await` only stops *us* reading — the agent run keeps going and keeps
      // spending tokens, and its chat spans would end after the root had already closed. The SDK's
      // cancellation mechanism is an abort signal on `run()`, so abandonment aborts it.
      const abortRun = new AbortController();

      const { agent, prompt, instructions } = buildAgentAndPrompt(
        config,
        userInput,
        toolHandlers,
        variables,
        {
          includeOutputType: false,
        },
        history,
      );
      setInputContentAttributes(span, captureContent, {
        systemInstructions: instructions,
        messages: [{ role: 'user', parts: [{ type: 'text', content: prompt }] }],
      });

      const toolTelemetry = attachToolSpanHooks(agent, parentContext, captureContent);
      const runner = new Runner({
        modelProvider: new SpanningModelProvider(defaultModelProvider(), config, parentContext, captureContent),
      });
      try {
        // biome-ignore lint/suspicious/noExplicitAny: Agents SDK run() stream overload requires an any-cast option
        const streamed = await runner.run(agent, prompt, { stream: true, signal: abortRun.signal } as any);
        // biome-ignore lint/suspicious/noExplicitAny: StreamedRunResult generics are irrelevant to this handler
        const streamedResult = streamed as StreamedRunResult<any, any>;
        let fullOutput = '';

        for await (const event of streamedResult) {
          if (event.type === 'raw_model_stream_event') {
            // biome-ignore lint/suspicious/noExplicitAny: OpenAI Agents SDK raw event data type does not expose delta field
            const rawEvent = (event as RunRawModelStreamEvent).data as any;
            if (rawEvent?.type === 'response.output_text.delta' && typeof rawEvent?.delta === 'string') {
              yield { type: 'chunk' as const, text: rawEvent.delta };
              fullOutput += rawEvent.delta;
            }
          }
        }

        const { inputTokens, outputTokens } = streamedResult.state.usage;
        const finalOutput = streamedResult.finalOutput;
        const output =
          typeof finalOutput === 'string'
            ? finalOutput
            : finalOutput != null
              ? JSON.stringify(finalOutput)
              : fullOutput;

        setOutputContentAttributes(span, captureContent, [
          { role: 'assistant', parts: [{ type: 'text', content: output }] },
        ]);
        finishRootSpan(span, config, streamedResult.state.usage as unknown as Record<string, unknown>);
        span.setStatus({ code: SpanStatusCode.OK });
        endSpanOnce(span, endedSpans);

        yield {
          type: 'done' as const,
          output,
          usage: { input_tokens: inputTokens, output_tokens: outputTokens },
        };
      } catch (err) {
        toolTelemetry.closeOpenSpans(err);
        // Same as the non-streaming path: a throw does not un-bill the calls already made.
        const spent = usageFromError(err);
        if (spent) finishRootSpan(span, config, spent);
        failSpan(span, err, endedSpans);
        throw err;
      } finally {
        // A no-op on the success and failure paths; on abandonment it is the only chance to close
        // the tree, including any tool span the SDK never reported an end for.
        if (!endedSpans.has(span)) {
          abortRun.abort();
          toolTelemetry.closeOpenSpans(new Error('stream abandoned before completion'));
        }
        endSpanOnce(span, endedSpans, true);
      }
    },
  );
}

export const openaiAgents = (
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
  config({ ...options, key: configKey, handler: createOpenAIAgentHandler({ captureContent }) }).invoke(
    userInput,
    context,
    variables,
  );
