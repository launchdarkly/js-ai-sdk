import {
  type AiConfigRep,
  type ContentCaptureOptions,
  composeHistory,
  config,
  contentToText,
  createHandler,
  endSpanOnce,
  imageBlockToUrl,
  type LDContext,
  type Message,
  type MessageContent,
  type ProviderHandler,
  parseTemplate,
  setLdSpanAttributes,
  setModelIdentityAttributes,
  setToolCallContentAttributes,
  setUsageSpanAttributes,
  type Tool,
  type ToolHandlerFn,
} from '@launchdarkly/ai-server';
import { type Context, context, type Span, SpanStatusCode, trace } from '@opentelemetry/api';
import OpenAI from 'openai';

const TRACER_NAME = '@launchdarkly/ai-litellm-messages';
const MAX_STEPS = 10;

type TokenUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
};

type ToolCallDelta = {
  index: number;
  id?: string;
  function?: { name?: string; arguments?: string };
};

type ToolCall = {
  id: string;
  function: { name: string; arguments: string };
};

type ChatCompletion = {
  model?: string;
  usage?: TokenUsage;
  choices?: Array<{
    message?: { content?: string | null; tool_calls?: ToolCall[] };
    delta?: { content?: string; tool_calls?: ToolCallDelta[] };
  }>;
};

type ChatStream = AsyncIterable<ChatCompletion> & {
  controller?: { abort?: () => void };
};

type CompatibleClient = {
  chat: {
    completions: {
      create: (request: Record<string, unknown>) => Promise<ChatCompletion | ChatStream>;
    };
  };
};

export interface LiteLLMMessagesOptions extends ContentCaptureOptions {
  apiKey?: string;
  baseURL?: string;
  client?: CompatibleClient;
  clientFactory?: (config: AiConfigRep) => CompatibleClient;
}

const proxyApiKey = (apiKey?: string) => (apiKey ?? process.env.LITELLM_API_KEY) || 'not-needed';

const toUsage = (usage: TokenUsage | undefined) => ({
  input_tokens: Number(usage?.prompt_tokens ?? 0),
  output_tokens: Number(usage?.completion_tokens ?? 0),
});

const addUsage = (total: { input_tokens: number; output_tokens: number }, usage: TokenUsage | undefined) => {
  const next = toUsage(usage);
  total.input_tokens += next.input_tokens;
  total.output_tokens += next.output_tokens;
};

function parseToolArguments(name: string, value: string): Record<string, unknown> {
  try {
    return JSON.parse(value || '{}') as Record<string, unknown>;
  } catch (error) {
    throw new Error(`Invalid arguments for tool "${name}"`, { cause: error });
  }
}

function failSpan(span: Span, error: unknown): void {
  const exception = error instanceof Error ? error : new Error(String(error));
  span.recordException(exception);
  span.setStatus({ code: SpanStatusCode.ERROR, message: exception.message });
  span.end();
}

const servingProvider = (configRep: AiConfigRep) => (configRep.provider?.name || 'openai').toLowerCase();

function setIdentity(span: Span, configRep: AiConfigRep): void {
  setModelIdentityAttributes(span, servingProvider(configRep), configRep.model.name, 'litellm');
}

function startModelSpan(configRep: AiConfigRep, parentContext: Context): Span {
  const span = trace.getTracer(TRACER_NAME).startSpan(`chat ${configRep.model.name}`, undefined, parentContext);
  span.setAttribute('gen_ai.operation.name', 'chat');
  setIdentity(span, configRep);
  return span;
}

function startToolSpan(name: string, id: string, parentContext: Context): Span {
  const span = trace.getTracer(TRACER_NAME).startSpan(`execute_tool ${name}`, undefined, parentContext);
  span.setAttribute('gen_ai.operation.name', 'execute_tool');
  span.setAttribute('gen_ai.tool.name', name);
  span.setAttribute('gen_ai.tool.call.id', id);
  return span;
}

const HANDLER_OWNED_MODEL_PARAMETERS = [
  'api_key',
  'base_url',
  'messages',
  'model',
  'output_format',
  'response_format',
  'stream',
  'stream_options',
  'tools',
] as const;

function mapContent(content: MessageContent): unknown {
  if (typeof content === 'string') return content;
  return content.map((block) =>
    block.type === 'text'
      ? { type: 'text', text: block.text }
      : { type: 'image_url', image_url: { url: imageBlockToUrl(block) } },
  );
}

function buildMessages(
  configRep: AiConfigRep,
  userInput: string,
  variables: Record<string, unknown>,
  history?: Message[],
): Array<Record<string, unknown>> {
  const system = configRep.messages?.length
    ? configRep.messages
        .filter((message) => message.role === 'system')
        .map((message) => ({
          role: message.role,
          content: parseTemplate(message.content, variables),
        }))
    : configRep.instructions
      ? [{ role: 'system', content: parseTemplate(configRep.instructions, variables) }]
      : [];
  const configMessages = (configRep.messages ?? [])
    .filter((message) => message.role !== 'system')
    .map((message) => ({
      role: message.role as 'user' | 'assistant',
      content: parseTemplate(message.content, variables),
    }));

  if (history?.length) {
    return [
      ...system,
      ...composeHistory({ configMessages, history, userInput }).map((message) => ({
        role: message.role,
        content: mapContent(message.content),
      })),
    ];
  }

  const messages: Array<Record<string, unknown>> = [...system, ...configMessages];
  if (messages.at(-1)?.role !== 'user') messages.push({ role: 'user', content: userInput });
  return messages;
}

function buildTools(configTools: Record<string, Tool>, handlers: Record<string, ToolHandlerFn>) {
  return Object.entries(configTools)
    .filter(([name]) => typeof handlers[name] === 'function')
    .map(([name, definition]) => ({
      type: 'function',
      function: {
        name,
        description: definition.description ?? '',
        parameters: definition.parameters,
      },
    }));
}

function resolveClient(options: LiteLLMMessagesOptions, configRep: AiConfigRep): CompatibleClient {
  if (options.clientFactory) return options.clientFactory(configRep);
  if (options.client) return options.client;
  const baseURL = options.baseURL ?? process.env.LITELLM_BASE_URL;
  if (!baseURL) throw new Error('LiteLLM proxy baseURL is required (pass baseURL or set LITELLM_BASE_URL)');
  return new OpenAI({
    apiKey: proxyApiKey(options.apiKey),
    baseURL,
  }) as unknown as CompatibleClient;
}

function checkedOptions(options: LiteLLMMessagesOptions): LiteLLMMessagesOptions {
  if (
    options.apiKey &&
    !options.client &&
    !options.clientFactory &&
    !(options.baseURL ?? process.env.LITELLM_BASE_URL)
  ) {
    throw new Error('LiteLLM proxy baseURL is required (pass baseURL or set LITELLM_BASE_URL)');
  }
  return options;
}

function jsonSchema(outputFormat: Record<string, unknown>): Record<string, unknown> {
  const type = outputFormat.type;
  return {
    ...outputFormat,
    type: type === 'json_schema' || type === 'json' || type == null ? 'object' : type,
  };
}

function ownedRequest(
  configRep: AiConfigRep,
  messages: Array<Record<string, unknown>>,
  tools: unknown[],
  stream: boolean,
): Record<string, unknown> {
  const parameters = { ...(configRep.model.parameters ?? {}) } as Record<string, unknown>;
  for (const key of HANDLER_OWNED_MODEL_PARAMETERS) delete parameters[key];
  return {
    ...parameters,
    model: configRep.model.name,
    messages,
    ...(tools.length ? { tools } : {}),
    ...(configRep.outputFormat && !stream
      ? {
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: 'output',
              schema: jsonSchema(configRep.outputFormat as Record<string, unknown>),
              strict: false,
            },
          },
        }
      : {}),
    stream,
    ...(stream ? { stream_options: { include_usage: true } } : {}),
  };
}

function setInputContent(span: Span, capture: boolean, messages: Array<Record<string, unknown>>): void {
  if (!capture) return;
  messages.forEach((message, index) => {
    span.setAttribute(`gen_ai.prompt.${index}.role`, String(message.role));
    span.setAttribute(`gen_ai.prompt.${index}.content`, contentToText(message.content as MessageContent));
  });
}

function setOutputContent(span: Span, capture: boolean, output: string): void {
  if (!capture) return;
  span.setAttribute('gen_ai.completion.0.role', 'assistant');
  span.setAttribute('gen_ai.completion.0.content', output);
}

export function createLiteLLMMessagesHandler(options: LiteLLMMessagesOptions = {}): ProviderHandler {
  const resolvedOptions = checkedOptions(options);
  const captureContent = resolvedOptions.captureContent ?? false;

  return createHandler(
    ['*', 'messages'],
    async (
      configRep: AiConfigRep,
      userInput = '',
      toolHandlers: Record<string, ToolHandlerFn> = {},
      variables: Record<string, unknown> = {},
      history?: Message[],
    ) =>
      trace.getTracer(TRACER_NAME).startActiveSpan('invoke_agent', async (span) => {
        span.setAttribute('gen_ai.operation.name', 'invoke_agent');
        setIdentity(span, configRep);
        setLdSpanAttributes(span, variables);
        const parentContext = trace.setSpan(context.active(), span);
        const messages = buildMessages(configRep, userInput, variables, history);
        setInputContent(span, captureContent, messages);
        const tools = configRep.tools ? buildTools(configRep.tools, toolHandlers) : [];
        const usage = { input_tokens: 0, output_tokens: 0 };

        try {
          const client = resolveClient(resolvedOptions, configRep);
          let output = '';
          for (let step = 0; step <= MAX_STEPS; step++) {
            const chatSpan = startModelSpan(configRep, parentContext);
            setInputContent(chatSpan, captureContent, messages);
            let response: ChatCompletion;
            try {
              response = (await client.chat.completions.create(
                ownedRequest(configRep, messages, tools, false),
              )) as ChatCompletion;
            } catch (error) {
              failSpan(chatSpan, error);
              throw error;
            }
            addUsage(usage, response.usage);
            chatSpan.setAttribute('gen_ai.response.model', response.model ?? configRep.model.name);
            setUsageSpanAttributes(chatSpan, {
              input: toUsage(response.usage).input_tokens,
              output: toUsage(response.usage).output_tokens,
              cacheRead: 0,
              cacheCreation: 0,
            });
            const choice = response.choices?.[0]?.message ?? {};
            setOutputContent(chatSpan, captureContent, choice.content ?? '');
            chatSpan.setStatus({ code: SpanStatusCode.OK });
            chatSpan.end();

            const calls = choice.tool_calls ?? [];
            if (!calls.length) {
              output = choice.content ?? '';
              break;
            }
            if (step === MAX_STEPS) throw new Error(`Tool loop exceeded the maximum number of steps (${MAX_STEPS})`);
            messages.push({ role: 'assistant', content: choice.content ?? null, tool_calls: calls });
            const results = await Promise.all(
              calls.map(async (call: ToolCall) => {
                const toolSpan = startToolSpan(call.function.name, call.id, parentContext);
                setToolCallContentAttributes(toolSpan, captureContent, { arguments: call.function.arguments });
                const handler = toolHandlers[call.function.name] as unknown as (
                  args: Record<string, unknown>,
                ) => unknown;
                try {
                  if (typeof handler !== 'function')
                    throw new Error(`No handler registered for tool "${call.function.name}"`);
                  const result = await handler(parseToolArguments(call.function.name, call.function.arguments));
                  setToolCallContentAttributes(toolSpan, captureContent, { result });
                  toolSpan.setStatus({ code: SpanStatusCode.OK });
                  toolSpan.end();
                  return {
                    role: 'tool',
                    tool_call_id: call.id,
                    content: typeof result === 'string' ? result : JSON.stringify(result),
                  };
                } catch (error) {
                  failSpan(toolSpan, error);
                  throw error;
                }
              }),
            );
            messages.push(...results);
          }

          setOutputContent(span, captureContent, output);
          span.setAttribute('gen_ai.response.model', configRep.model.name);
          setUsageSpanAttributes(span, {
            input: usage.input_tokens,
            output: usage.output_tokens,
            cacheRead: 0,
            cacheCreation: 0,
          });
          span.setStatus({ code: SpanStatusCode.OK });
          span.end();
          return { output, usage };
        } catch (error) {
          failSpan(span, error);
          throw error;
        }
      }),
    async function* streamHandler(
      configRep: AiConfigRep,
      userInput = '',
      toolHandlers: Record<string, ToolHandlerFn> = {},
      variables: Record<string, unknown> = {},
      history?: Message[],
    ) {
      const span = trace.getTracer(TRACER_NAME).startSpan('invoke_agent');
      span.setAttribute('gen_ai.operation.name', 'invoke_agent');
      setIdentity(span, configRep);
      setLdSpanAttributes(span, variables);
      const parentContext = trace.setSpan(context.active(), span);
      const messages = buildMessages(configRep, userInput, variables, history);
      setInputContent(span, captureContent, messages);
      const tools = configRep.tools ? buildTools(configRep.tools, toolHandlers) : [];
      const usage = { input_tokens: 0, output_tokens: 0 };
      let client: CompatibleClient;
      let activeStream: ChatStream | undefined;
      let output = '';
      let completed = false;
      let ended = false;
      const endedSpans = new Set<Span>();
      let activeModelSpan: Span | undefined;

      try {
        client = resolveClient(resolvedOptions, configRep);
        for (let step = 0; step <= MAX_STEPS; step++) {
          activeModelSpan = startModelSpan(configRep, parentContext);
          setInputContent(activeModelSpan, captureContent, messages);
          activeStream = (await client.chat.completions.create(
            ownedRequest(configRep, messages, tools, true),
          )) as ChatStream;
          const calls = new Map<number, { id: string; name: string; arguments: string }>();
          const turnUsage = { input_tokens: 0, output_tokens: 0 };
          let turnContent = '';
          for await (const event of activeStream) {
            addUsage(usage, event.usage);
            addUsage(turnUsage, event.usage);
            const delta = event.choices?.[0]?.delta;
            if (typeof delta?.content === 'string') {
              turnContent += delta.content;
              output += delta.content;
              yield { type: 'chunk' as const, text: delta.content };
            }
            for (const part of delta?.tool_calls ?? []) {
              const call = calls.get(part.index) ?? { id: '', name: '', arguments: '' };
              call.id += part.id ?? '';
              call.name += part.function?.name ?? '';
              call.arguments += part.function?.arguments ?? '';
              calls.set(part.index, call);
            }
          }

          activeModelSpan.setAttribute('gen_ai.response.model', configRep.model.name);
          setOutputContent(activeModelSpan, captureContent, turnContent);
          setUsageSpanAttributes(activeModelSpan, {
            input: turnUsage.input_tokens,
            output: turnUsage.output_tokens,
            cacheRead: 0,
            cacheCreation: 0,
          });
          activeModelSpan.setStatus({ code: SpanStatusCode.OK });
          endSpanOnce(activeModelSpan, endedSpans);
          activeModelSpan = undefined;

          if (!calls.size) break;
          if (step === MAX_STEPS) throw new Error(`Tool loop exceeded the maximum number of steps (${MAX_STEPS})`);
          const toolCalls = [...calls.values()].map((call) => ({
            id: call.id,
            type: 'function',
            function: { name: call.name, arguments: call.arguments },
          }));
          messages.push({ role: 'assistant', content: turnContent || null, tool_calls: toolCalls });
          for (const call of calls.values()) {
            const toolSpan = startToolSpan(call.name, call.id, parentContext);
            setToolCallContentAttributes(toolSpan, captureContent, { arguments: call.arguments });
            const handler = toolHandlers[call.name] as unknown as (args: Record<string, unknown>) => unknown;
            try {
              if (typeof handler !== 'function') throw new Error(`No handler registered for tool "${call.name}"`);
              const result = await handler(parseToolArguments(call.name, call.arguments));
              setToolCallContentAttributes(toolSpan, captureContent, { result });
              messages.push({
                role: 'tool',
                tool_call_id: call.id,
                content: typeof result === 'string' ? result : JSON.stringify(result),
              });
              toolSpan.setStatus({ code: SpanStatusCode.OK });
              toolSpan.end();
            } catch (error) {
              failSpan(toolSpan, error);
              throw error;
            }
          }
        }

        completed = true;
        setOutputContent(span, captureContent, output);
        span.setAttribute('gen_ai.response.model', configRep.model.name);
        setUsageSpanAttributes(span, {
          input: usage.input_tokens,
          output: usage.output_tokens,
          cacheRead: 0,
          cacheCreation: 0,
        });
        span.setStatus({ code: SpanStatusCode.OK });
        span.end();
        ended = true;
        yield { type: 'done' as const, output, usage };
      } catch (error) {
        if (activeModelSpan && !endedSpans.has(activeModelSpan)) {
          const exception = error instanceof Error ? error : new Error(String(error));
          activeModelSpan.recordException(exception);
          activeModelSpan.setStatus({ code: SpanStatusCode.ERROR, message: exception.message });
          endSpanOnce(activeModelSpan, endedSpans);
        }
        failSpan(span, error);
        ended = true;
        completed = true;
        throw error;
      } finally {
        if (!completed) {
          activeStream?.controller?.abort?.();
          span.setAttribute('launchdarkly.stream.abandoned', true);
          if (activeModelSpan) endSpanOnce(activeModelSpan, endedSpans, true);
          if (!ended) span.end();
        }
      }
    },
    captureContent,
  );
}

export const litellmMessages = (
  configKey: string,
  userInput: string,
  context: LDContext,
  {
    apiKey,
    baseURL,
    captureContent,
    client,
    clientFactory,
    variables,
    ...options
  }: Omit<Parameters<typeof config>[0], 'handler' | 'key'> &
    LiteLLMMessagesOptions & { variables?: Record<string, unknown> } = {},
) =>
  config({
    ...options,
    key: configKey,
    handler: createLiteLLMMessagesHandler({ apiKey, baseURL, captureContent, client, clientFactory }),
  }).invoke(userInput, context, variables);
