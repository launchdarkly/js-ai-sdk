import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, type BaseMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import {
  type AiConfigRep,
  type ContentCaptureOptions,
  config,
  createHandler,
  createRunUsage,
  endSpanOnce,
  type LDContext,
  langChainFinishReasons,
  langChainSpanMessages,
  langChainSpanUsage,
  type Message,
  type NativeTool,
  type ProviderHandler,
  parseTemplate,
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
import { type Context, context, type Span, SpanStatusCode, trace } from '@opentelemetry/api';

const TRACER_NAME = '@launchdarkly/ai-langchain-messages';

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
 * The provider that actually serves the model.
 *
 * `gen_ai.provider.name` names who served the request, and its semconv enum has no `langchain`
 * member — LangChain is the framework, not the provider. This mirrors the choice `resolveBaseModel`
 * makes, so the attribute agrees with the client that is really used. `gen_ai.system` keeps the
 * `langchain` value the handler shipped, so existing dashboards do not break.
 */
function servingProvider(config: AiConfigRep): string {
  return (config.provider?.name ?? '').toLowerCase() === 'anthropic' ? 'anthropic' : 'openai';
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
  setModelIdentityAttributes(span, servingProvider(config), config.model.name, 'langchain');
  return span;
}

// LangChain normalizes provider usage into `usage_metadata`, where `input_tokens` is the total input
// (cached tokens already included, as with OpenAI). We surface the cache breakdown from
// `input_token_details` for cross-handler parity, but never add it on top of the input total.
function finishModelSpan(
  span: Span,
  config: AiConfigRep,
  usage: Record<string, unknown>,
  finishReasons?: string[],
): void {
  span.setAttribute('gen_ai.response.model', config.model.name);
  // An array because one response may hold several choices; the providers used here return one.
  if (finishReasons?.length) span.setAttribute('gen_ai.response.finish_reasons', finishReasons);
  // Zeros when the provider reported nothing, unlike the run accumulator: a span always carries the
  // complete attribute set, because an absent one drops it from the queries that group on them.
  setUsageSpanAttributes(span, langChainSpanUsage(usage) ?? { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 });
  span.setStatus({ code: SpanStatusCode.OK });
  span.end();
}

function finishRootSpan(span: Span, config: AiConfigRep, runUsage: SpanUsage): void {
  span.setAttribute('gen_ai.response.model', config.model.name);
  setUsageSpanAttributes(span, runUsage);
}

function startToolSpan(toolName: string, toolCallId: string, parentContext: Context): Span {
  const span = trace.getTracer(TRACER_NAME).startSpan(`execute_tool ${toolName}`, undefined, parentContext);
  span.setAttribute('gen_ai.operation.name', 'execute_tool');
  span.setAttribute('gen_ai.tool.name', toolName);
  span.setAttribute('gen_ai.tool.call.id', toolCallId);
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

type LangChainToolDef = {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

/**
 * Normalizes a config outputFormat schema for use with LangChain.
 * The flag may store outputFormat with `type: "json_schema"` (the OpenAI Responses API
 * format descriptor), which is not a valid JSON Schema type. We replace it with "object"
 * when properties are present so LangChain's schema validator accepts it.
 */
function normalizeOutputSchema(schema: Record<string, unknown>): Record<string, unknown> {
  if (schema.type === 'json_schema' && schema.properties) {
    return { ...schema, type: 'object' };
  }
  return schema;
}

/**
 * Resolves the LangChain chat model to use for a request.
 * If the caller supplied an explicit `llm`, it is used as-is.
 * Otherwise, the provider and model name from the AI config are used to
 * instantiate the appropriate model via a dynamic import, so that neither
 * @langchain/openai nor @langchain/anthropic is a hard dependency.
 */
async function resolveBaseModel(config: AiConfigRep, llm?: BaseChatModel): Promise<BaseChatModel> {
  if (llm) return llm;
  const providerName = (config.provider?.name ?? '').toLowerCase();
  const modelName = config.model?.name;
  if (providerName === 'anthropic') {
    // biome-ignore lint/suspicious/noExplicitAny: @langchain/anthropic loaded via dynamic import with no static types
    let mod: any;
    try {
      mod = await import('@langchain/anthropic');
    } catch {
      throw new Error(
        'Using Anthropic models requires @langchain/anthropic. Install it with: npm install @langchain/anthropic',
      );
    }
    return new mod.ChatAnthropic({ model: modelName ?? 'claude-3-5-sonnet-20241022' });
  }
  // biome-ignore lint/suspicious/noExplicitAny: @langchain/openai loaded via dynamic import with no static types
  let mod: any;
  try {
    mod = await import('@langchain/openai');
  } catch {
    throw new Error('Using OpenAI models requires @langchain/openai. Install it with: npm install @langchain/openai');
  }
  return new mod.ChatOpenAI({ model: modelName ?? 'gpt-4o' });
}

const buildTools = (
  configTools: Record<string, Tool>,
  toolHandlers: Record<string, ToolHandlerFn | NativeTool>,
): LangChainToolDef[] =>
  Object.entries(configTools)
    .filter(([name]) => typeof toolHandlers[name] === 'function')
    .map(([name, toolConfig]) => ({
      type: 'function',
      function: {
        name,
        description: toolConfig.description ?? '',
        parameters: toolConfig.parameters as Record<string, unknown>,
      },
    }));

const buildMessages = (
  config: AiConfigRep,
  userInput: string,
  variables: Record<string, unknown>,
  history?: Message[],
): BaseMessage[] => {
  const messages: BaseMessage[] = [];

  if (config.messages && config.messages.length > 0) {
    const systemMessages = config.messages.filter((m) => m.role === 'system');
    const conversationMessages = config.messages.filter((m) => m.role !== 'system');

    if (systemMessages.length > 0) {
      messages.push(new SystemMessage(parseTemplate(systemMessages.map((m) => m.content).join('\n'), variables)));
    }

    for (const msg of conversationMessages) {
      const content = parseTemplate(msg.content, variables);
      if (msg.role === 'user') {
        messages.push(new HumanMessage(content));
      } else if (msg.role === 'assistant') {
        messages.push(new AIMessage(content));
      }
    }
  } else if (config.instructions) {
    messages.push(new SystemMessage(parseTemplate(config.instructions, variables)));
  }

  if (history) {
    for (const msg of history) {
      if (msg.role === 'user') {
        messages.push(new HumanMessage(msg.content));
      } else if (msg.role === 'assistant') {
        messages.push(new AIMessage(msg.content));
      }
    }
  }

  const lastNonSystem = [...messages].reverse().find((m) => m._getType() !== 'system');
  if (lastNonSystem?._getType() !== 'human') {
    messages.push(new HumanMessage(userInput));
  }
  return messages;
};

/** The catalog as bound to the model, so the span reports what it could actually call. */
const toToolDefinitions = (tools: LangChainToolDef[]): ToolDefinitionInput[] =>
  tools.map((tool) => ({
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters,
  }));

/** One assistant reply as a canonical output message, tool calls included. */
const assistantOutput = (content: unknown, toolCalls: ReadonlyArray<unknown> | undefined) =>
  langChainSpanMessages([{ _getType: () => 'ai', content, tool_calls: toolCalls ?? [] }]).messages;

export function createLangChainHandler(
  llm?: BaseChatModel,
  { captureContent = false }: ContentCaptureOptions = {},
): ProviderHandler {
  const MAX_STEPS = 10;

  return createHandler(
    ['*', 'messages'],
    async (
      config: AiConfigRep,
      userInput = '',
      toolHandlers: Record<string, ToolHandlerFn | NativeTool> = {},
      variables: Record<string, unknown> = {},
      history?: Message[],
    ) => {
      return trace.getTracer(TRACER_NAME).startActiveSpan('invoke_agent', async (span) => {
        span.setAttribute('gen_ai.operation.name', 'invoke_agent');
        setModelIdentityAttributes(span, servingProvider(config), config.model.name, 'langchain');
        setLdSpanAttributes(span, variables);
        // Explicit rather than a bare `context.active()`: the active context only carries this
        // span while an OTel ContextManager is registered, so a host app that installs its own
        // TracerProvider without one would otherwise get a flat trace.
        const parentContext = trace.setSpan(context.active(), span);

        const initialMessages = buildMessages(config, userInput, variables, history);
        if (captureContent) {
          const rootInput = langChainSpanMessages(initialMessages);
          setInputContentAttributes(span, captureContent, {
            systemInstructions: rootInput.systemInstructions,
            messages: rootInput.messages,
          });
        }

        const runUsage = createRunUsage();
        try {
          // Resolved per-request so the correct provider/model from the AI config is used.
          const baseModel = await resolveBaseModel(config, llm);

          const toolDefs = config.tools ? buildTools(config.tools, toolHandlers) : [];
          const outputFormat = config.outputFormat;
          const normalizedSchema = outputFormat ? normalizeOutputSchema(outputFormat) : undefined;

          // Runs one structured-output turn under its own `chat` child span and returns the raw usage.
          const runStructuredTurn = async (messages: BaseMessage[]) => {
            const modelSpan = startModelSpan(config, parentContext);
            if (captureContent) {
              const turnInput = langChainSpanMessages(messages);
              setInputContentAttributes(modelSpan, captureContent, {
                systemInstructions: turnInput.systemInstructions,
                messages: turnInput.messages,
              });
            }
            try {
              // biome-ignore lint/suspicious/noExplicitAny: LangChain BaseChatModel.withStructuredOutput is not in base class types
              const structuredModel = (baseModel as any).withStructuredOutput(normalizedSchema, { includeRaw: true });
              const result = await structuredModel.invoke(messages);
              // biome-ignore lint/suspicious/noExplicitAny: LangChain structured output raw response type is not public
              const rawUsage = ((result.raw as any)?.usage_metadata ?? {}) as Record<string, unknown>;
              if (captureContent) {
                setOutputContentAttributes(modelSpan, captureContent, [
                  { role: 'assistant', parts: [{ type: 'text', content: JSON.stringify(result.parsed) }] },
                ]);
              }
              finishModelSpan(modelSpan, config, rawUsage, langChainFinishReasons(result.raw));
              return { result, rawUsage };
            } catch (err) {
              failSpan(modelSpan, err);
              throw err;
            }
          };

          // CASE 1: outputFormat only, no tools → withStructuredOutput (all providers)
          if (normalizedSchema && toolDefs.length === 0) {
            const { result, rawUsage } = await runStructuredTurn(initialMessages);
            runUsage.add(langChainSpanUsage(rawUsage));
            setOutputContentAttributes(span, captureContent, [
              { role: 'assistant', parts: [{ type: 'text', content: JSON.stringify(result.parsed) }] },
            ]);
            finishRootSpan(span, config, runUsage.total);
            span.setStatus({ code: SpanStatusCode.OK });
            span.end();
            return {
              output: result.parsed as unknown,
              usage: { input_tokens: runUsage.total.input, output_tokens: runUsage.total.output },
            };
          }

          // CASE 2: tools present → agentic loop, then withStructuredOutput for the final
          // response when outputFormat is set. withStructuredOutput is provider-agnostic and
          // reliable; the preceding tool calls give the model the context it needs.
          // biome-ignore lint/suspicious/noExplicitAny: LangChain BaseChatModel.bindTools is not typed in the base class
          const toolModel: any = toolDefs.length > 0 ? (baseModel as any).bindTools(toolDefs) : baseModel;
          const toolDefinitions = toToolDefinitions(toolDefs);
          const conversationMessages: BaseMessage[] = [...initialMessages];
          let output: unknown = '';
          let steps = 0;

          while (true) {
            const modelSpan = startModelSpan(config, parentContext);
            if (captureContent) {
              const turnInput = langChainSpanMessages(conversationMessages);
              setInputContentAttributes(modelSpan, captureContent, {
                systemInstructions: turnInput.systemInstructions,
                messages: turnInput.messages,
                toolDefinitions,
              });
            }
            let response: AIMessage;
            try {
              response = (await toolModel.invoke(conversationMessages)) as AIMessage;
            } catch (err) {
              failSpan(modelSpan, err);
              throw err;
            }
            const usage = (response.usage_metadata ?? {}) as Record<string, unknown>;
            if (captureContent) {
              setOutputContentAttributes(
                modelSpan,
                captureContent,
                assistantOutput(response.content, response.tool_calls),
              );
            }
            finishModelSpan(modelSpan, config, usage, langChainFinishReasons(response));
            runUsage.add(langChainSpanUsage(usage));

            const toolCalls = response.tool_calls ?? [];

            if (toolCalls.length === 0) {
              if (normalizedSchema) {
                const { result, rawUsage } = await runStructuredTurn(conversationMessages);
                runUsage.add(langChainSpanUsage(rawUsage));
                output = result.parsed;
              } else {
                output = typeof response.content === 'string' ? response.content : '';
              }
              break;
            }

            if (steps++ >= MAX_STEPS) {
              throw new Error(`Tool loop exceeded the maximum number of steps (${MAX_STEPS})`);
            }

            conversationMessages.push(response);

            const toolResults = await Promise.all(
              toolCalls.map(async (tc) => {
                const toolSpan = startToolSpan(tc.name, tc.id ?? tc.name, parentContext);
                setToolCallContentAttributes(toolSpan, captureContent, { arguments: tc.args });
                try {
                  const handlerFn = toolHandlers[tc.name];
                  if (!handlerFn || typeof handlerFn !== 'function') {
                    throw new Error(`No handler registered for tool "${tc.name}"`);
                  }
                  const result = await (handlerFn as (...args: unknown[]) => unknown)(tc.args);
                  setToolCallContentAttributes(toolSpan, captureContent, { result });
                  toolSpan.setStatus({ code: SpanStatusCode.OK });
                  toolSpan.end();
                  return new ToolMessage({ tool_call_id: tc.id ?? tc.name, content: String(result) });
                } catch (err) {
                  failSpan(toolSpan, err);
                  throw err;
                }
              }),
            );
            conversationMessages.push(...toolResults);
          }

          const outputStr = typeof output === 'string' ? output : JSON.stringify(output);
          setOutputContentAttributes(span, captureContent, [
            { role: 'assistant', parts: [{ type: 'text', content: outputStr }] },
          ]);
          finishRootSpan(span, config, runUsage.total);
          span.setStatus({ code: SpanStatusCode.OK });
          span.end();
          return { output, usage: { input_tokens: runUsage.total.input, output_tokens: runUsage.total.output } };
        } catch (err) {
          // The turns that completed were billed, and the root is the only span a config-scoped
          // cost query can find them on.
          if (runUsage.reported) finishRootSpan(span, config, runUsage.total);
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
      setModelIdentityAttributes(span, servingProvider(config), config.model.name, 'langchain');
      setLdSpanAttributes(span, variables);
      const parentContext = trace.setSpan(context.active(), span);

      // A consumer that `break`s out of `for await`, or throws inside the loop body, makes this
      // generator run `finally` without ever entering `catch`. Without the cleanup there the root
      // span is never ended, so it is never exported, and the whole run disappears from AI Config
      // Monitoring along with the `feature_flag` event it carries.
      const endedSpans = new Set<Span>();
      let openModelSpan: Span | undefined;
      const runUsage = createRunUsage();

      const initialMessages = buildMessages(config, userInput, variables, history);
      if (captureContent) {
        const rootInput = langChainSpanMessages(initialMessages);
        setInputContentAttributes(span, captureContent, {
          systemInstructions: rootInput.systemInstructions,
          messages: rootInput.messages,
        });
      }

      try {
        // Resolved per-request so the correct provider/model from the AI config is used.
        const baseModel = await resolveBaseModel(config, llm);

        const toolDefs = config.tools ? buildTools(config.tools, toolHandlers) : [];
        const outputFormat = config.outputFormat;
        const normalizedSchema = outputFormat ? normalizeOutputSchema(outputFormat) : undefined;

        // biome-ignore lint/suspicious/noExplicitAny: LangChain BaseChatModel.bindTools is not typed in the base class
        const toolModel: any = toolDefs.length > 0 ? (baseModel as any).bindTools(toolDefs) : baseModel;
        const toolDefinitions = toToolDefinitions(toolDefs);
        const conversationMessages: BaseMessage[] = [...initialMessages];
        let fullOutput: unknown = '';
        let steps = 0;

        while (true) {
          const modelSpan = startModelSpan(config, parentContext);
          if (captureContent) {
            const turnInput = langChainSpanMessages(conversationMessages);
            setInputContentAttributes(modelSpan, captureContent, {
              systemInstructions: turnInput.systemInstructions,
              messages: turnInput.messages,
              toolDefinitions,
            });
          }
          openModelSpan = modelSpan;
          let accumulatedContent = '';
          // biome-ignore lint/suspicious/noExplicitAny: LangChain tool call objects are not publicly typed
          let accumulatedToolCalls: any[] = [];
          // The cache breakdown has to be accumulated alongside the scalars. LangChain reports it
          // per chunk in `usage_metadata.input_token_details`, and synthesizing a usage bag without
          // it made the streaming span emit `cache_read = 0` where the blocking path emitted the
          // real figure — a zero that reads as "no cached tokens" rather than "not reported".
          // `SpanUsage` rather than `Record<string, number>`: the loose type let a misspelled field
          // compile and silently sum into a key nothing reads.
          const turnUsage: SpanUsage = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
          // Carried forward chunk by chunk for the same reason as the cache breakdown above: only
          // the terminal chunk reports it, and dropping it would make the streaming span omit a
          // finish reason where the blocking path emits the real one.
          let finishReasons: string[] | undefined;

          try {
            const chunkStream = await toolModel.stream(conversationMessages);
            for await (const chunk of chunkStream) {
              const text = typeof chunk.content === 'string' ? chunk.content : '';
              if (text && !normalizedSchema) {
                // Only stream text chunks when there is no structured output schema;
                // structured output is delivered as a whole in the done event.
                yield { type: 'chunk' as const, text };
              }
              accumulatedContent += text;
              if (chunk.usage_metadata) {
                const details = (chunk.usage_metadata.input_token_details ?? {}) as Record<string, unknown>;
                turnUsage.input += numberOrZero(chunk.usage_metadata.input_tokens);
                turnUsage.output += numberOrZero(chunk.usage_metadata.output_tokens);
                turnUsage.cacheRead += numberOrZero(details.cache_read);
                turnUsage.cacheCreation += numberOrZero(details.cache_creation);
              }
              if (chunk.tool_calls?.length) {
                accumulatedToolCalls = chunk.tool_calls;
              }
              finishReasons = langChainFinishReasons(chunk) ?? finishReasons;
            }
          } catch (err) {
            // The tracker matters here: the outer `catch` also fails `openModelSpan`, which still
            // points at this span because the line that clears it is unreachable on this path.
            failSpan(modelSpan, err, endedSpans);
            throw err;
          }
          const turnUsageBag = {
            input_tokens: turnUsage.input,
            output_tokens: turnUsage.output,
            input_token_details: { cache_read: turnUsage.cacheRead, cache_creation: turnUsage.cacheCreation },
          };
          if (captureContent) {
            setOutputContentAttributes(
              modelSpan,
              captureContent,
              assistantOutput(accumulatedContent, accumulatedToolCalls),
            );
          }
          finishModelSpan(modelSpan, config, turnUsageBag, finishReasons);
          openModelSpan = undefined;
          // The already-mapped figures, not the bag rebuilt from them: this path summed the chunks
          // into a `SpanUsage` to begin with, so re-parsing its own output would be a round trip
          // whose only effect is another chance to disagree with itself.
          runUsage.add(turnUsage);

          if (accumulatedToolCalls.length === 0) {
            if (normalizedSchema) {
              // Use withStructuredOutput on the accumulated conversation for the final response.
              const structuredSpan = startModelSpan(config, parentContext);
              if (captureContent) {
                const turnInput = langChainSpanMessages(conversationMessages);
                setInputContentAttributes(structuredSpan, captureContent, {
                  systemInstructions: turnInput.systemInstructions,
                  messages: turnInput.messages,
                });
              }
              try {
                // biome-ignore lint/suspicious/noExplicitAny: LangChain BaseChatModel.withStructuredOutput is not in base class types
                const structuredModel = (baseModel as any).withStructuredOutput(normalizedSchema, { includeRaw: true });
                const result = await structuredModel.invoke(conversationMessages);
                // biome-ignore lint/suspicious/noExplicitAny: LangChain structured output raw response type is not public
                const rawUsage = ((result.raw as any)?.usage_metadata ?? {}) as Record<string, unknown>;
                if (captureContent) {
                  setOutputContentAttributes(structuredSpan, captureContent, [
                    { role: 'assistant', parts: [{ type: 'text', content: JSON.stringify(result.parsed) }] },
                  ]);
                }
                finishModelSpan(structuredSpan, config, rawUsage, langChainFinishReasons(result.raw));
                runUsage.add(langChainSpanUsage(rawUsage));
                fullOutput = result.parsed;
              } catch (err) {
                failSpan(structuredSpan, err);
                throw err;
              }
            } else {
              fullOutput = (fullOutput as string) + accumulatedContent;
            }
            break;
          }

          if (steps++ >= MAX_STEPS) {
            throw new Error(`Tool loop exceeded the maximum number of steps (${MAX_STEPS})`);
          }

          fullOutput = (fullOutput as string) + accumulatedContent;
          const assistantMsg = new AIMessage({ content: accumulatedContent, tool_calls: accumulatedToolCalls });
          conversationMessages.push(assistantMsg);

          const toolResults = await Promise.all(
            // biome-ignore lint/suspicious/noExplicitAny: LangChain tool call objects are not publicly typed
            accumulatedToolCalls.map(async (tc: any) => {
              const toolSpan = startToolSpan(tc.name, tc.id ?? tc.name, parentContext);
              setToolCallContentAttributes(toolSpan, captureContent, { arguments: tc.args });
              try {
                const handlerFn = toolHandlers[tc.name];
                if (!handlerFn || typeof handlerFn !== 'function') {
                  throw new Error(`No handler registered for tool "${tc.name}"`);
                }
                const result = await (handlerFn as (...args: unknown[]) => unknown)(tc.args);
                setToolCallContentAttributes(toolSpan, captureContent, { result });
                toolSpan.setStatus({ code: SpanStatusCode.OK });
                toolSpan.end();
                return new ToolMessage({ tool_call_id: tc.id ?? tc.name, content: String(result) });
              } catch (err) {
                failSpan(toolSpan, err);
                throw err;
              }
            }),
          );
          conversationMessages.push(...toolResults);
        }

        const fullOutputStr = typeof fullOutput === 'string' ? fullOutput : JSON.stringify(fullOutput);
        setOutputContentAttributes(span, captureContent, [
          { role: 'assistant', parts: [{ type: 'text', content: fullOutputStr }] },
        ]);
        finishRootSpan(span, config, runUsage.total);
        span.setStatus({ code: SpanStatusCode.OK });
        endSpanOnce(span, endedSpans);

        yield {
          type: 'done' as const,
          output: fullOutputStr,
          usage: { input_tokens: runUsage.total.input, output_tokens: runUsage.total.output },
        };
      } catch (err) {
        if (openModelSpan) failSpan(openModelSpan, err, endedSpans);
        if (runUsage.reported) finishRootSpan(span, config, runUsage.total);
        failSpan(span, err, endedSpans);
        throw err;
      } finally {
        // A no-op on the success and failure paths; on abandonment it is the only chance to
        // close the tree — and to report what the completed turns already cost.
        if (openModelSpan) endSpanOnce(openModelSpan, endedSpans, true);
        if (!endedSpans.has(span) && runUsage.reported) finishRootSpan(span, config, runUsage.total);
        endSpanOnce(span, endedSpans, true);
      }
    },
    captureContent,
  );
}

export const langchainMessages = (
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
  config({ ...options, key: configKey, handler: createLangChainHandler(undefined, { captureContent }) }).invoke(
    userInput,
    context,
    variables,
  );
