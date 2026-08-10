import {
  type AiConfigRep,
  type CanonicalTurn,
  type ContentCaptureOptions,
  composeHistory,
  config,
  contentToText,
  createHandler,
  createRunUsage,
  endSpanOnce,
  imageBlockToUrl,
  isContentBlocks,
  type LDContext,
  type Message,
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
} from '@launchdarkly/ai-server';
import { type Context, context, type Span, SpanStatusCode, trace } from '@opentelemetry/api';
import OpenAI from 'openai';

const TRACER_NAME = '@launchdarkly/ai-openai-messages';

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
 * OpenAI reports cached tokens *within* the input total (a subset), so — unlike Anthropic —
 * they are not added on top; `cached_tokens` is surfaced as cache_read for cross-handler parity
 * only. OpenAI has no cache-creation concept, so that count is always 0.
 */
function toSpanUsage(usage: OpenAI.Responses.ResponseUsage | undefined): SpanUsage {
  return {
    input: numberOrZero(usage?.input_tokens),
    output: numberOrZero(usage?.output_tokens),
    cacheRead: numberOrZero(usage?.input_tokens_details?.cached_tokens),
    cacheCreation: 0,
  };
}

function finishModelSpan(span: Span, responseModel: string, usage: OpenAI.Responses.ResponseUsage | undefined): void {
  span.setAttribute('gen_ai.response.model', responseModel);
  setUsageSpanAttributes(span, toSpanUsage(usage));
  span.setStatus({ code: SpanStatusCode.OK });
  span.end();
}

function finishRootSpan(span: Span, responseModel: string, runUsage: SpanUsage): void {
  // The model that answered, not the one requested: OpenAI resolves an alias like `gpt-4o` to a
  // dated snapshot, and the chat children already report the real value. A root copying
  // `config.model.name` would contradict its own children.
  span.setAttribute('gen_ai.response.model', responseModel);
  setUsageSpanAttributes(span, runUsage);
}

function startToolSpan(toolName: string, callId: string, parentContext: Context): Span {
  const span = trace.getTracer(TRACER_NAME).startSpan(`execute_tool ${toolName}`, undefined, parentContext);
  span.setAttribute('gen_ai.operation.name', 'execute_tool');
  span.setAttribute('gen_ai.tool.name', toolName);
  span.setAttribute('gen_ai.tool.call.id', callId);
  return span;
}

/**
 * `endedSpans` is passed only from the streaming path, where a `finally` may race this to the
 * same span; elsewhere there is exactly one end and the tracker is unnecessary.
 */
function failSpan(span: Span, error: unknown, endedSpans?: Set<Span>): void {
  const exception = error instanceof Error ? error : new Error(String(error));
  span.recordException(exception);
  span.setStatus({ code: SpanStatusCode.ERROR, message: exception.message });
  if (endedSpans) endSpanOnce(span, endedSpans);
  else span.end();
}

type FunctionTool = {
  type: 'function';
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  strict: boolean;
};

const buildTools = (
  configTools: Record<string, Tool>,
  toolHandlers: Record<string, (...args: unknown[]) => unknown>,
): FunctionTool[] =>
  Object.entries(configTools)
    .filter(([name]) => typeof toolHandlers[name] === 'function')
    .map(([name, toolConfig]) => ({
      type: 'function',
      name,
      description: toolConfig.description ?? '',
      parameters: toolConfig.parameters,
      strict: false,
    }));

function mapConversationTurn(turn: CanonicalTurn): OpenAI.Responses.ResponseInputItem {
  if (turn.role === 'assistant') {
    return { role: 'assistant', content: contentToText(turn.content) };
  }

  if (!isContentBlocks(turn.content)) {
    return { role: 'user', content: turn.content };
  }

  return {
    role: 'user',
    content: turn.content.map((block) =>
      block.type === 'text'
        ? { type: 'input_text' as const, text: block.text }
        : { type: 'input_image' as const, image_url: imageBlockToUrl(block), detail: 'auto' as const },
    ),
  };
}

function buildInputMessages(
  config: AiConfigRep,
  userInput: string,
  variables: Record<string, unknown>,
  history?: Message[],
): OpenAI.Responses.ResponseInputItem[] {
  if (config.messages && config.messages.length > 0) {
    const mapped = config.messages.map((m) => ({
      role: m.role as 'system' | 'user' | 'assistant',
      content: parseTemplate(m.content, variables),
    }));
    if (history && history.length > 0) {
      const systemMessages = mapped.filter((message) => message.role === 'system');
      const configMessages = mapped
        .filter(
          (message): message is { role: 'user' | 'assistant'; content: string } =>
            message.role === 'user' || message.role === 'assistant',
        )
        .map(({ role, content }) => ({ role, content }));
      return [...systemMessages, ...composeHistory({ configMessages, history, userInput }).map(mapConversationTurn)];
    }
    const lastMsg = mapped[mapped.length - 1];
    if (lastMsg?.role !== 'user') {
      mapped.push({ role: 'user' as const, content: userInput });
    }
    return mapped;
  }
  const instructions = config.instructions ? parseTemplate(config.instructions, variables) : '';
  if (history && history.length > 0) {
    return [
      ...(instructions ? [{ role: 'system' as const, content: instructions }] : []),
      ...composeHistory({ history, userInput }).map(mapConversationTurn),
    ];
  }
  return [
    ...(instructions ? [{ role: 'system' as const, content: instructions }] : []),
    { role: 'user' as const, content: userInput },
  ];
}

/**
 * Splits the Responses input list into system instructions and conversation turns.
 *
 * The system message is lifted out so it lands on `gen_ai.system_instructions` rather than being
 * buried mid-conversation; `setInputContentAttributes` puts it back as message 0 of the flat
 * carrier, which has no separate slot for it.
 */
function splitInputMessages(items: ReadonlyArray<unknown>): {
  systemInstructions?: string;
  messages: SpanMessage[];
} {
  const system: string[] = [];
  const messages: SpanMessage[] = [];

  for (const raw of items as Array<Record<string, unknown>>) {
    if (raw.role === 'system' || raw.role === 'developer') {
      system.push(String(raw.content ?? ''));
      continue;
    }
    if (raw.type === 'function_call_output') {
      messages.push({
        role: 'tool',
        parts: [
          {
            type: 'tool_call_response',
            id: typeof raw.call_id === 'string' ? raw.call_id : undefined,
            result: raw.output,
          },
        ],
      });
      continue;
    }
    if (raw.type === 'function_call') {
      messages.push({
        role: 'assistant',
        parts: [
          {
            type: 'tool_call',
            id: typeof raw.call_id === 'string' ? raw.call_id : undefined,
            name: String(raw.name ?? ''),
            arguments: raw.arguments,
          },
        ],
      });
      continue;
    }
    messages.push({
      role: typeof raw.role === 'string' ? raw.role : 'user',
      parts: [{ type: 'text', content: typeof raw.content === 'string' ? raw.content : JSON.stringify(raw.content) }],
    });
  }

  return { systemInstructions: system.length > 0 ? system.join('\n') : undefined, messages };
}

/** Converts one Responses output item into canonical span message parts. */
function outputItemParts(item: Record<string, unknown>): SpanMessagePart[] {
  if (item.type === 'function_call') {
    return [
      {
        type: 'tool_call',
        id: typeof item.call_id === 'string' ? item.call_id : undefined,
        name: String(item.name ?? ''),
        arguments: item.arguments,
      },
    ];
  }
  if (item.type === 'reasoning') {
    const summary = Array.isArray(item.summary)
      ? (item.summary as Array<Record<string, unknown>>).map((entry) => String(entry.text ?? '')).join('\n')
      : '';
    return summary ? [{ type: 'reasoning', content: summary }] : [];
  }
  if (!Array.isArray(item.content)) return [];
  return (item.content as Array<Record<string, unknown>>)
    .filter((block) => block.type === 'output_text')
    .map((block) => ({ type: 'text' as const, content: String(block.text ?? '') }));
}

/**
 * Maps a Responses result onto semconv's `finish_reasons` vocabulary.
 *
 * The Responses API has no per-message finish reason of its own — it reports a run `status` plus, on
 * an incomplete run, a machine-readable cause — so the three cases a reader cares about are derived
 * here rather than passed through.
 */
function finishReasonOf(response: OpenAI.Responses.Response): string | undefined {
  if (response.output.some((item) => item.type === 'function_call')) return 'tool_calls';
  if (response.status === 'incomplete') {
    return response.incomplete_details?.reason === 'max_output_tokens' ? 'length' : 'content_filter';
  }
  return response.status === 'completed' ? 'stop' : undefined;
}

function setResponseOutputContent(span: Span, capture: boolean, response: OpenAI.Responses.Response): void {
  if (!capture) return;
  const finishReason = finishReasonOf(response);
  const messages: SpanMessage[] = (response.output as unknown as Array<Record<string, unknown>>).map((item) => ({
    role: typeof item.role === 'string' ? item.role : 'assistant',
    parts: outputItemParts(item),
    finishReason,
  }));
  setOutputContentAttributes(span, capture, messages);
}

/**
 * The `json_schema` text format for a structured-output request.
 *
 * Cast because the SDK types `schema` as a closed shape and does not admit the freeform JSON Schema
 * an AI Config's `outputFormat` is.
 */
// biome-ignore lint/suspicious/noExplicitAny: OpenAI SDK does not expose json_schema format with a freeform schema field
const jsonSchemaFormat = (schema: Record<string, unknown>): any => ({
  type: 'json_schema',
  name: 'output',
  schema,
  strict: false,
});

/** The catalog as sent, so the span reports what the model could actually call. */
const toToolDefinitions = (tools: FunctionTool[]): ToolDefinitionInput[] =>
  tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters }));

export function createOpenAIHandler({ captureContent = false }: ContentCaptureOptions = {}): ProviderHandler {
  const openai = new OpenAI();

  const MAX_STEPS = 10;

  return createHandler(
    ['OpenAI', 'messages'],
    async (
      config: AiConfigRep,
      userInput = '',
      toolHandlers: Record<string, (...args: unknown[]) => unknown> = {},
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

        // Declared out here, not inside the `try`, so the failure path can still report the tokens
        // the run had already spent. Each turn is added by `runModelTurn` at the moment the provider
        // reports it, which is also the only place that can count a turn twice or forget one.
        const runUsage = createRunUsage();

        // Runs one provider turn under its own `chat` child span.
        const runModelTurn = async (
          params: OpenAI.Responses.ResponseCreateParamsNonStreaming,
          toolDefinitions: ToolDefinitionInput[],
        ): Promise<OpenAI.Responses.Response> => {
          const modelSpan = startModelSpan(config, parentContext);
          // Written before the call, so an in-flight or failed turn still shows what it was asked.
          if (captureContent) {
            const { systemInstructions, messages } = splitInputMessages(
              Array.isArray(params.input) ? params.input : [{ role: 'user', content: params.input }],
            );
            setInputContentAttributes(modelSpan, captureContent, { systemInstructions, messages, toolDefinitions });
          }
          let response: OpenAI.Responses.Response;
          try {
            response = (await openai.responses.create(params)) as OpenAI.Responses.Response;
          } catch (err) {
            failSpan(modelSpan, err);
            throw err;
          }
          setResponseOutputContent(modelSpan, captureContent, response);
          const finishReason = finishReasonOf(response);
          // Not content, so it is emitted regardless of the capture gate.
          if (finishReason) modelSpan.setAttribute('gen_ai.response.finish_reasons', [finishReason]);
          finishModelSpan(modelSpan, response.model, response.usage);
          // `toSpanUsage` of an absent bag is still a real object, so a turn that completed without
          // reported usage counts as reported — the call happened, whatever the provider said.
          runUsage.add(toSpanUsage(response.usage));
          return response;
        };

        try {
          const tools = config.tools ? buildTools(config.tools, toolHandlers) : [];
          const inputMessages = buildInputMessages(config, userInput, variables, history);
          const toolDefinitions = toToolDefinitions(tools);

          const rootInput = splitInputMessages(inputMessages);
          setInputContentAttributes(span, captureContent, {
            systemInstructions: rootInput.systemInstructions,
            messages: rootInput.messages,
          });

          let response = await runModelTurn(
            {
              model: config.model.name,
              input: inputMessages,
              ...(tools.length > 0 ? { tools } : {}),
              ...(config.outputFormat ? { text: { format: jsonSchemaFormat(config.outputFormat) } } : {}),
            },
            toolDefinitions,
          );

          let steps = 0;

          while (true) {
            const toolCalls = response.output.filter(
              (item): item is OpenAI.Responses.ResponseFunctionToolCall => item.type === 'function_call',
            );
            if (toolCalls.length === 0) break;

            if (steps++ >= MAX_STEPS) {
              throw new Error(`Tool loop exceeded the maximum number of steps (${MAX_STEPS})`);
            }

            const toolOutputs = await Promise.all(
              toolCalls.map(async (tc) => {
                const toolSpan = startToolSpan(tc.name, tc.call_id, parentContext);
                setToolCallContentAttributes(toolSpan, captureContent, { arguments: tc.arguments });
                try {
                  const args = JSON.parse(tc.arguments) as Record<string, unknown>;
                  const handler = toolHandlers[tc.name];
                  if (!handler) throw new Error(`No handler registered for tool "${tc.name}"`);
                  const result = await handler(args);
                  setToolCallContentAttributes(toolSpan, captureContent, { result });
                  toolSpan.setStatus({ code: SpanStatusCode.OK });
                  toolSpan.end();
                  return { type: 'function_call_output' as const, call_id: tc.call_id, output: String(result) };
                } catch (err) {
                  failSpan(toolSpan, err);
                  throw err;
                }
              }),
            );

            response = await runModelTurn(
              {
                model: config.model.name,
                previous_response_id: response.id,
                input: toolOutputs,
              },
              toolDefinitions,
            );
          }

          const output = response.output_text ?? '';
          setOutputContentAttributes(span, captureContent, [
            { role: 'assistant', parts: [{ type: 'text', content: output }] },
          ]);
          finishRootSpan(span, response.model ?? config.model.name, runUsage.total);
          span.setStatus({ code: SpanStatusCode.OK });
          span.end();
          // Cache keys are deliberately omitted: OpenAI's input already includes them, and
          // `parseUsage` would otherwise fold them in a second time.
          return { output, usage: { input_tokens: runUsage.total.input, output_tokens: runUsage.total.output } };
        } catch (err) {
          // Report what the turns that did complete already cost; those tokens were billed and the
          // root is the only span a config-scoped cost query can find them on. Nothing is written
          // when no turn ever reported usage — see `reported`.
          if (runUsage.reported) finishRootSpan(span, config.model.name, runUsage.total);
          failSpan(span, err);
          throw err;
        }
      });
    },
    async function* streamHandler(
      config: AiConfigRep,
      userInput = '',
      toolHandlers: Record<string, (...args: unknown[]) => unknown> = {},
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
      let openModelSpan: Span | undefined;
      // Outside the `try` for the same reason as the non-streaming path: the failure path has to be
      // able to report the tokens the completed turns already spent, and the model that answered.
      const runUsage = createRunUsage();
      let lastResponseModel = config.model.name;

      try {
        const tools = config.tools ? buildTools(config.tools, toolHandlers) : [];
        const inputMessages = buildInputMessages(config, userInput, variables, history);
        const toolDefinitions = toToolDefinitions(tools);
        const rootInput = splitInputMessages(inputMessages);
        setInputContentAttributes(span, captureContent, {
          systemInstructions: rootInput.systemInstructions,
          messages: rootInput.messages,
        });

        let fullOutput = '';
        let previousResponseId: string | undefined;
        let currentInput: OpenAI.Responses.ResponseInputItem[] = inputMessages;
        let steps = 0;

        while (true) {
          const modelSpan = startModelSpan(config, parentContext);
          if (captureContent) {
            const turnInput = splitInputMessages(currentInput);
            setInputContentAttributes(modelSpan, captureContent, {
              systemInstructions: turnInput.systemInstructions,
              messages: turnInput.messages,
              toolDefinitions,
            });
          }
          openModelSpan = modelSpan;
          let finalResp: OpenAI.Responses.Response;
          try {
            const streamParams = previousResponseId
              ? { model: config.model.name, previous_response_id: previousResponseId, input: currentInput }
              : { model: config.model.name, input: currentInput, ...(tools.length > 0 ? { tools } : {}) };

            // biome-ignore lint/suspicious/noExplicitAny: streamParams union type does not match the SDK's overloaded stream() signature
            const responseStream = openai.responses.stream(streamParams as any);

            type ResponseTextDeltaEvent = { type: 'response.output_text.delta'; delta: string };

            // Yield text deltas for this turn
            for await (const event of responseStream) {
              if (event.type === 'response.output_text.delta') {
                yield { type: 'chunk' as const, text: (event as ResponseTextDeltaEvent).delta };
                fullOutput += (event as ResponseTextDeltaEvent).delta;
              }
            }

            finalResp = (await responseStream.finalResponse()) as OpenAI.Responses.Response;
          } catch (err) {
            // The tracker matters here: the outer `catch` also fails `openModelSpan`, which still
            // points at this span because the line that clears it is unreachable on this path.
            failSpan(modelSpan, err, endedSpans);
            throw err;
          }
          lastResponseModel = finalResp.model ?? config.model.name;
          setResponseOutputContent(modelSpan, captureContent, finalResp);
          const finishReason = finishReasonOf(finalResp);
          if (finishReason) modelSpan.setAttribute('gen_ai.response.finish_reasons', [finishReason]);
          finishModelSpan(modelSpan, lastResponseModel, finalResp.usage);
          openModelSpan = undefined;
          runUsage.add(toSpanUsage(finalResp.usage));

          const toolCalls = finalResp.output.filter(
            (item): item is OpenAI.Responses.ResponseFunctionToolCall => item.type === 'function_call',
          );
          if (toolCalls.length === 0) break;

          if (steps++ >= MAX_STEPS) {
            throw new Error(`Tool loop exceeded the maximum number of steps (${MAX_STEPS})`);
          }

          previousResponseId = finalResp.id;
          currentInput = await Promise.all(
            toolCalls.map(async (tc: OpenAI.Responses.ResponseFunctionToolCall) => {
              const toolSpan = startToolSpan(tc.name, tc.call_id, parentContext);
              setToolCallContentAttributes(toolSpan, captureContent, { arguments: tc.arguments });
              try {
                const args = JSON.parse(tc.arguments) as Record<string, unknown>;
                const handler = toolHandlers[tc.name];
                if (!handler) throw new Error(`No handler registered for tool "${tc.name}"`);
                const result = await handler(args);
                setToolCallContentAttributes(toolSpan, captureContent, { result });
                toolSpan.setStatus({ code: SpanStatusCode.OK });
                toolSpan.end();
                return { type: 'function_call_output' as const, call_id: tc.call_id, output: String(result) };
              } catch (err) {
                failSpan(toolSpan, err);
                throw err;
              }
            }),
          );
        }

        setOutputContentAttributes(span, captureContent, [
          { role: 'assistant', parts: [{ type: 'text', content: fullOutput }] },
        ]);
        finishRootSpan(span, lastResponseModel, runUsage.total);
        span.setStatus({ code: SpanStatusCode.OK });
        endSpanOnce(span, endedSpans);

        yield {
          type: 'done' as const,
          output: fullOutput,
          usage: { input_tokens: runUsage.total.input, output_tokens: runUsage.total.output },
        };
      } catch (err) {
        if (openModelSpan) failSpan(openModelSpan, err, endedSpans);
        if (runUsage.reported) finishRootSpan(span, lastResponseModel, runUsage.total);
        failSpan(span, err, endedSpans);
        throw err;
      } finally {
        // A no-op on the success and failure paths; on abandonment it is the only chance to
        // close the tree. An abandoned stream still spent whatever its completed turns cost, and
        // unlike the `catch` path nothing else will write it, so it is reported here too.
        if (openModelSpan) endSpanOnce(openModelSpan, endedSpans, true);
        if (!endedSpans.has(span) && runUsage.reported) {
          finishRootSpan(span, lastResponseModel, runUsage.total);
        }
        endSpanOnce(span, endedSpans, true);
      }
    },
  );
}

export const openaiMessages = (
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
  config({ ...options, key: configKey, handler: createOpenAIHandler({ captureContent }) }).invoke(
    userInput,
    context,
    variables,
  );
