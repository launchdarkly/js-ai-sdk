import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, type BaseMessage, HumanMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { ChatOpenAI } from '@langchain/openai';
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
import { createAgent } from 'langchain';

const TRACER_NAME = '@launchdarkly/ai-langchain-agents';

/**
 * The provider that actually serves the model.
 *
 * `gen_ai.provider.name` names who served the request, and its semconv enum has no `langchain`
 * member — LangChain is the framework, not the provider. This mirrors the choice
 * `makeDefaultChatModel` makes, so the attribute agrees with the client that is really used.
 * `gen_ai.system` keeps the `langchain` value the handler shipped, so existing dashboards do not
 * break.
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

function finishRootSpan(span: Span, config: AiConfigRep, runUsage: SpanUsage): void {
  span.setAttribute('gen_ai.response.model', config.model.name);
  setUsageSpanAttributes(span, runUsage);
}

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

function startToolSpan(toolName: string, toolCallId: string, parentContext: Context): Span {
  const span = trace.getTracer(TRACER_NAME).startSpan(`execute_tool ${toolName}`, undefined, parentContext);
  span.setAttribute('gen_ai.operation.name', 'execute_tool');
  span.setAttribute('gen_ai.tool.name', toolName);
  span.setAttribute('gen_ai.tool.call.id', toolCallId);
  return span;
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

// LangChain's LLMResult carries usage either on each generation's message (`usage_metadata`) or,
// for some providers, in `llmOutput.tokenUsage`. Prefer the former, fall back to the latter.
// biome-ignore lint/suspicious/noExplicitAny: LangChain LLMResult usage fields are not fully typed
function extractLLMUsage(output: any): Record<string, unknown> {
  const generations = (output?.generations ?? []).flat?.() ?? [];
  for (const gen of generations) {
    const usageMetadata = gen?.message?.usage_metadata;
    if (usageMetadata) return usageMetadata as Record<string, unknown>;
  }
  const tokenUsage = output?.llmOutput?.tokenUsage ?? output?.llmOutput?.usage;
  if (tokenUsage) {
    return {
      input_tokens: tokenUsage.promptTokens ?? tokenUsage.prompt_tokens ?? tokenUsage.input_tokens,
      output_tokens: tokenUsage.completionTokens ?? tokenUsage.completion_tokens ?? tokenUsage.output_tokens,
    };
  }
  return {};
}

/**
 * Builds a LangChain callback handler that maps the agent's LLM and tool lifecycle onto OTel spans:
 * one `chat` child span per model turn, one `execute_tool` child span per tool call. Spans are keyed
 * by the callback `runId` so concurrent tools don't collide.
 */
export function buildSpanCallbacks(
  config: AiConfigRep,
  parentContext: Context,
  captureContent = false,
  toolDefinitions: ReadonlyArray<ToolDefinitionInput> = [],
) {
  const modelSpans = new Map<string, Span>();
  const toolSpans = new Map<string, Span>();
  /**
   * The run total, accumulated per completed model turn.
   *
   * The success path sums `usage_metadata` over `result.messages` instead, which is the same set of
   * numbers reached from the other side. This exists for the path where there is no `result`: when
   * `invoke()` throws, the turns that did complete were still billed, and `handleLLMEnd` is the only
   * place their usage was ever visible.
   */
  const runUsage = createRunUsage();

  const startModel = (runId: string, messages?: unknown) => {
    if (modelSpans.has(runId)) return;
    const span = startModelSpan(config, parentContext);
    if (captureContent) {
      // `handleChatModelStart` hands over `BaseMessage[][]` — one list per generation. The agent
      // graph sends a single list, and flattening keeps a multi-generation caller from losing turns.
      const flat = Array.isArray(messages) ? (messages as unknown[]).flat() : [];
      const turnInput = langChainSpanMessages(flat);
      setInputContentAttributes(span, captureContent, {
        systemInstructions: turnInput.systemInstructions,
        messages: turnInput.messages,
        toolDefinitions,
      });
    }
    modelSpans.set(runId, span);
  };

  /** The generated messages of an `LLMResult`, which is where a turn's real output lives. */
  const generatedMessages = (output: unknown): unknown[] => {
    const generations = (output as { generations?: unknown } | undefined)?.generations;
    if (!Array.isArray(generations)) return [];
    return generations
      .flat()
      .map((generation) => (generation as { message?: unknown } | undefined)?.message)
      .filter(Boolean);
  };

  return {
    callbacks: [
      {
        // Every callback below must stay synchronous. LangChain wraps a plain callbacks object via
        // `BaseCallbackHandler.fromMethods`, where `awaitHandlers` defaults to false, so callbacks
        // are dispatched onto a queue the caller never awaits. That queue is `autoStart: true`, so a
        // synchronous callback still runs to completion before the surrounding `invoke()` resolves —
        // an `async` one would not, and its span could be lost when a short-lived process exits.
        // `__tests__/callbacks.test.ts` pins this against LangChain's real callback machinery.
        handleChatModelStart: (_llm: unknown, messages: unknown, runId: string) => startModel(runId, messages),
        handleLLMStart: (_llm: unknown, _prompts: unknown, runId: string) => startModel(runId),
        // biome-ignore lint/suspicious/noExplicitAny: LLMResult shape handled by extractLLMUsage
        handleLLMEnd: (output: any, runId: string) => {
          const span = modelSpans.get(runId);
          if (!span) return;
          modelSpans.delete(runId);
          if (captureContent) {
            setOutputContentAttributes(span, captureContent, langChainSpanMessages(generatedMessages(output)).messages);
          }
          const turnUsage = extractLLMUsage(output);
          runUsage.add(langChainSpanUsage(turnUsage));
          finishModelSpan(span, config, turnUsage, langChainFinishReasons(output));
        },
        handleLLMError: (err: Error, runId: string) => {
          const span = modelSpans.get(runId);
          if (!span) return;
          modelSpans.delete(runId);
          failSpan(span, err);
        },
        handleToolStart: (
          tool: { name?: string; id?: string[] },
          input: string,
          runId: string,
          _parentRunId?: string,
          _tags?: string[],
          _metadata?: Record<string, unknown>,
          runName?: string,
          toolCallId?: string,
        ) => {
          const toolName = runName ?? tool?.name ?? tool?.id?.at(-1) ?? 'tool';
          const span = startToolSpan(toolName, toolCallId ?? runId, parentContext);
          setToolCallContentAttributes(span, captureContent, { arguments: input });
          toolSpans.set(runId, span);
        },
        handleToolEnd: (output: unknown, runId: string) => {
          const span = toolSpans.get(runId);
          if (!span) return;
          toolSpans.delete(runId);
          setToolCallContentAttributes(span, captureContent, { result: output });
          span.setStatus({ code: SpanStatusCode.OK });
          span.end();
        },
        handleToolError: (err: Error, runId: string) => {
          const span = toolSpans.get(runId);
          if (!span) return;
          toolSpans.delete(runId);
          failSpan(span, err);
        },
      },
    ],
    closeOpenSpans(error: unknown) {
      for (const span of modelSpans.values()) failSpan(span, error);
      for (const span of toolSpans.values()) failSpan(span, error);
      modelSpans.clear();
      toolSpans.clear();
    },
    runUsage,
  };
}

async function makeDefaultChatModel(aiConfig: AiConfigRep): Promise<BaseChatModel> {
  const provider = (aiConfig.provider?.name ?? '').toLowerCase();
  const modelName = aiConfig.model?.name ?? '';
  if (provider === 'anthropic') {
    const { ChatAnthropic } = await import('@langchain/anthropic');
    return new ChatAnthropic({ model: modelName || 'claude-3-5-sonnet-20241022' });
  }
  return new ChatOpenAI({ model: modelName || 'gpt-4o' });
}

const buildAgentTools = (configTools: Record<string, Tool>, toolHandlers: Record<string, ToolHandlerFn>) =>
  Object.entries(configTools)
    .filter(([name]) => typeof toolHandlers[name] === 'function')
    .map(([name, toolConfig]) =>
      tool(
        async (args: Record<string, unknown>) => {
          const result = await (toolHandlers[name] as (...args: unknown[]) => unknown)(args);
          return String(result);
        },
        {
          name,
          description: toolConfig.description ?? '',
          // biome-ignore lint/suspicious/noExplicitAny: LangChain tool schema type does not accept Record<string, unknown>
          schema: toolConfig.parameters as any,
        },
      ),
    );

function formatHistory(history: Message[]): string {
  return history.map((m) => `${m.role}: ${m.content}`).join('\n');
}

const extractSystemPrompt = (
  config: AiConfigRep,
  variables: Record<string, unknown>,
  history?: Message[],
): string | undefined => {
  let systemPrompt: string | undefined;
  if (config.instructions) {
    systemPrompt = parseTemplate(config.instructions, variables);
  } else if (config.messages) {
    const systemMessages = config.messages.filter((m) => m.role === 'system');
    if (systemMessages.length > 0) {
      systemPrompt = parseTemplate(systemMessages.map((m) => m.content).join('\n'), variables);
    }
  }

  if (history && history.length > 0) {
    const formatted = formatHistory(history);
    systemPrompt = systemPrompt
      ? `${systemPrompt}\n\nConversation History:\n\n${formatted}`
      : `Conversation History:\n\n${formatted}`;
  }

  return systemPrompt;
};

const buildInitialMessages = (
  config: AiConfigRep,
  userInput: string,
  variables: Record<string, unknown>,
): BaseMessage[] => {
  const messages: BaseMessage[] = [];

  // system-role messages are passed via systemPrompt to createAgent; only
  // include user/assistant history here
  if (config.messages) {
    const conversationMessages = config.messages.filter((m) => m.role !== 'system');
    for (const msg of conversationMessages) {
      const content = parseTemplate(msg.content, variables);
      messages.push(msg.role === 'user' ? new HumanMessage(content) : new AIMessage(content));
    }
  }

  const lastNonSystem = [...messages].reverse().find((m) => m._getType() !== 'system');
  if (lastNonSystem?._getType() !== 'human') {
    messages.push(new HumanMessage(userInput));
  }
  return messages;
};

/** The catalog handed to `createAgent`, so a `chat` span reports what the model could call. */
const toToolDefinitions = (configTools: Record<string, Tool> | undefined): ToolDefinitionInput[] =>
  Object.entries(configTools ?? {}).map(([name, tool]) => ({
    name: tool.name ?? name,
    description: tool.description,
    parameters: tool.parameters,
  }));

export function createLangChainAgentsHandler(
  llm?: BaseChatModel,
  { captureContent = false }: ContentCaptureOptions = {},
): ProviderHandler {
  return createHandler(
    ['*', 'agent'],
    async (
      config: AiConfigRep,
      userInput = '',
      toolHandlers: Record<string, ToolHandlerFn> = {},
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

        const baseModel = llm ?? (await makeDefaultChatModel(config));
        let systemPrompt = extractSystemPrompt(config, variables, history);
        if (config.outputFormat) {
          const schemaInstruction = `Respond with valid JSON matching this schema:\n${JSON.stringify(config.outputFormat)}`;
          systemPrompt = systemPrompt ? `${systemPrompt}\n\n${schemaInstruction}` : schemaInstruction;
        }
        const initialMessages = buildInitialMessages(config, userInput, variables);
        if (captureContent) {
          setInputContentAttributes(span, captureContent, {
            systemInstructions: systemPrompt,
            messages: langChainSpanMessages(initialMessages).messages,
          });
        }

        const spanCallbacks = buildSpanCallbacks(
          config,
          parentContext,
          captureContent,
          toToolDefinitions(config.tools),
        );
        try {
          const tools = config.tools ? buildAgentTools(config.tools, toolHandlers) : [];
          const agent = createAgent({ model: baseModel, tools, ...(systemPrompt ? { systemPrompt } : {}) });
          const result = await agent.invoke({ messages: initialMessages }, { callbacks: spanCallbacks.callbacks });

          const runUsage = createRunUsage();
          for (const msg of result.messages as BaseMessage[]) {
            // biome-ignore lint/suspicious/noExplicitAny: LangChain BaseMessage does not expose usage_metadata in public types
            const usage = (msg as any).usage_metadata;
            if (usage) {
              runUsage.add(langChainSpanUsage(usage));
            }
          }

          const lastMessage: BaseMessage = result.messages[result.messages.length - 1];
          const output: unknown = typeof lastMessage.content === 'string' ? lastMessage.content : '';

          const outputStr = typeof output === 'string' ? output : JSON.stringify(output);
          setOutputContentAttributes(span, captureContent, [
            { role: 'assistant', parts: [{ type: 'text', content: outputStr }] },
          ]);
          finishRootSpan(span, config, runUsage.total);
          span.setStatus({ code: SpanStatusCode.OK });
          span.end();
          return { output, usage: { input_tokens: runUsage.total.input, output_tokens: runUsage.total.output } };
        } catch (err) {
          spanCallbacks.closeOpenSpans(err);
          // There is no `result` to sum, so the run total comes from the callbacks, which saw every
          // turn that did complete. Those tokens were billed and the root is the only span a
          // config-scoped cost query can find them on.
          if (spanCallbacks.runUsage.reported) {
            finishRootSpan(span, config, spanCallbacks.runUsage.total);
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

      const baseModel = llm ?? (await makeDefaultChatModel(config));
      const systemPrompt = extractSystemPrompt(config, variables, history);
      const initialMessages = buildInitialMessages(config, userInput, variables);
      if (captureContent) {
        setInputContentAttributes(span, captureContent, {
          systemInstructions: systemPrompt,
          messages: langChainSpanMessages(initialMessages).messages,
        });
      }

      const spanCallbacks = buildSpanCallbacks(config, parentContext, captureContent, toToolDefinitions(config.tools));
      try {
        const tools = config.tools ? buildAgentTools(config.tools, toolHandlers) : [];
        const agent = createAgent({ model: baseModel, tools, ...(systemPrompt ? { systemPrompt } : {}) });

        const runUsage = createRunUsage();
        let fullOutput = '';

        // agent.stream() yields state updates per graph step
        for await (const stepState of await agent.stream(
          { messages: initialMessages },
          { callbacks: spanCallbacks.callbacks },
        )) {
          // Each step yields { [nodeName]: { messages: BaseMessage[] } }
          // biome-ignore lint/suspicious/noExplicitAny: LangChain agent stream step state type is not publicly typed
          for (const stepMessages of Object.values(stepState) as any[]) {
            const msgs: BaseMessage[] = stepMessages?.messages ?? [];
            for (const msg of msgs) {
              // biome-ignore lint/suspicious/noExplicitAny: LangChain BaseMessage does not expose usage_metadata in public types
              const usage = (msg as any).usage_metadata;
              runUsage.add(langChainSpanUsage(usage));
              // Yield text content from AI messages (complete turns)
              if (msg._getType() === 'ai') {
                const text = typeof msg.content === 'string' ? msg.content : '';
                if (text) {
                  yield { type: 'chunk' as const, text };
                  fullOutput = text;
                }
              }
            }
          }
        }

        setOutputContentAttributes(span, captureContent, [
          { role: 'assistant', parts: [{ type: 'text', content: fullOutput }] },
        ]);
        finishRootSpan(span, config, runUsage.total);
        span.setStatus({ code: SpanStatusCode.OK });
        endSpanOnce(span, endedSpans);

        yield {
          type: 'done' as const,
          output: fullOutput,
          usage: { input_tokens: runUsage.total.input, output_tokens: runUsage.total.output },
        };
      } catch (err) {
        spanCallbacks.closeOpenSpans(err);
        if (spanCallbacks.runUsage.reported) finishRootSpan(span, config, spanCallbacks.runUsage.total);
        failSpan(span, err, endedSpans);
        throw err;
      } finally {
        // A no-op on the success and failure paths; on abandonment it is the only chance to close
        // the tree, including any chat span whose LangChain end-callback never fired. An abandoned
        // stream still spent whatever its completed turns cost, and nothing else will report it.
        if (!endedSpans.has(span)) {
          spanCallbacks.closeOpenSpans(new Error('stream abandoned before completion'));
          if (spanCallbacks.runUsage.reported) finishRootSpan(span, config, spanCallbacks.runUsage.total);
        }
        endSpanOnce(span, endedSpans, true);
      }
    },
    captureContent,
  );
}

export const langchainAgents = (
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
  config({ ...options, key: configKey, handler: createLangChainAgentsHandler(undefined, { captureContent }) }).invoke(
    userInput,
    context,
    variables,
  );
