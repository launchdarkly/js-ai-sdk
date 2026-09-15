import type { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import {
  type AiConfigRep,
  addCachedTokensToInput,
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
  setInputContentAttributes,
  setLdSpanAttributes,
  setModelIdentityAttributes,
  setOutputContentAttributes,
  setToolCallContentAttributes,
  setUsageSpanAttributes,
  type Tool,
  type ToolHandlerFn,
} from '@launchdarkly/ai-server';
import { type Context, context, INVALID_SPAN_CONTEXT, type Span, SpanStatusCode, trace } from '@opentelemetry/api';
import {
  AfterModelCallEvent,
  AfterToolCallEvent,
  Agent,
  BedrockModel,
  type BedrockModelOptions,
  BeforeModelCallEvent,
  BeforeToolCallEvent,
  type JSONValue,
  type MessageData,
  type ModelStreamUpdateEvent,
  tool,
} from '@strands-agents/sdk';

const TRACER_NAME = '@launchdarkly/ai-bedrock-agents';

export interface BedrockAgentsHandlerOptions extends ContentCaptureOptions {
  /** Existing Bedrock Runtime client. It remains caller-owned. */
  client?: BedrockRuntimeClient;
  /** Bedrock bearer API key. Ignored when client is supplied. */
  apiKey?: string;
  /** AWS endpoint region, not the inference-profile prefix. */
  region?: string;
  /** Additional documented Strands BedrockModel options, evaluated per invocation. */
  modelOptions?: (config: AiConfigRep) => Partial<BedrockModelOptions>;
}

interface RawUsage extends Record<string, unknown> {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

function numberOrZero(value: unknown): number {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function mapUsage(usage: Record<string, unknown> | undefined): RawUsage {
  const input = numberOrZero(usage?.inputTokens);
  const output = numberOrZero(usage?.outputTokens);
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: numberOrZero(usage?.totalTokens) || input + output,
    cache_read_input_tokens: numberOrZero(usage?.cacheReadInputTokens),
    cache_creation_input_tokens: numberOrZero(usage?.cacheWriteInputTokens),
  };
}

function responseUsage(usage: RawUsage): Record<string, number> {
  return {
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    total_tokens: usage.total_tokens,
    ...(usage.cache_read_input_tokens ? { cache_read_input_tokens: usage.cache_read_input_tokens } : {}),
    ...(usage.cache_creation_input_tokens ? { cache_creation_input_tokens: usage.cache_creation_input_tokens } : {}),
  };
}

export function resolveBedrockModelId(config: AiConfigRep): string {
  const prefix = config.model.region?.trim();
  return prefix && !config.model.name.startsWith(`${prefix}.`) ? `${prefix}.${config.model.name}` : config.model.name;
}

function systemPrompt(config: AiConfigRep, variables: Record<string, unknown>): string | undefined {
  let prompt: string | undefined;
  if (config.instructions) {
    prompt = parseTemplate(config.instructions, variables);
  } else if (config.messages?.length) {
    const systemMessages = config.messages.filter((message) => message.role === 'system');
    if (systemMessages.length) {
      prompt = parseTemplate(systemMessages.map((message) => message.content).join('\n'), variables);
    }
  }
  if (config.outputFormat) {
    const format = `Respond with valid JSON matching this schema:\n${JSON.stringify(config.outputFormat)}`;
    prompt = prompt ? `${prompt}\n\n${format}` : format;
  }
  return prompt;
}

function contentData(content: unknown): MessageData['content'] {
  if (typeof content === 'string') return [{ text: content }];
  if (!Array.isArray(content)) return [];
  return (
    content as Array<{
      type?: unknown;
      text?: unknown;
      source?: { type?: unknown; media_type?: unknown; data?: unknown };
    }>
  ).flatMap((block): MessageData['content'] => {
    if (block.type === 'text') return [{ text: String(block.text ?? '') }];
    if (block.type !== 'image') return [];
    if (block.source?.type === 'url') {
      throw new Error('Bedrock URL image history requires an explicit download-to-bytes policy');
    }
    if (block.source?.type === 'base64') {
      const format = String(block.source.media_type ?? '').split('/')[1];
      return format
        ? [
            {
              image: {
                format: format as 'png' | 'jpg' | 'jpeg' | 'gif' | 'webp',
                source: { bytes: Uint8Array.from(Buffer.from(String(block.source.data), 'base64')) },
              },
            },
          ]
        : [];
    }
    return [];
  });
}

function buildInput(config: AiConfigRep, userInput: string, variables: Record<string, unknown>, history?: Message[]) {
  const messages: MessageData[] = [];
  for (const message of config.messages ?? []) {
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    messages.push({ role: message.role, content: [{ text: parseTemplate(message.content, variables) }] });
  }
  for (const message of history ?? []) {
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    messages.push({ role: message.role, content: contentData(message.content) });
  }
  if (userInput || messages.at(-1)?.role !== 'user') messages.push({ role: 'user', content: [{ text: userInput }] });
  return messages.length === 1 && messages[0].role === 'user' && messages[0].content.length === 1
    ? userInput
    : messages;
}

function buildTools(configTools: Record<string, Tool>, handlers: Record<string, ToolHandlerFn | NativeTool>) {
  return Object.entries(configTools)
    .filter(([name]) => typeof handlers[name] === 'function')
    .map(([name, definition]) =>
      tool({
        name,
        description: definition.description ?? '',
        inputSchema: definition.parameters,
        callback: async (input) => {
          const handler = handlers[name];
          if (typeof handler !== 'function') throw new Error(`No handler registered for tool "${name}"`);
          return (await (handler as (input: unknown) => unknown)(input)) as JSONValue;
        },
      }),
    );
}

function modelOptions(config: AiConfigRep, options: BedrockAgentsHandlerOptions, modelId: string): BedrockModelOptions {
  const explicit = options.modelOptions?.(config) ?? {};
  const parameters = config.model.parameters ?? {};
  const documented: Partial<BedrockModelOptions> = {};
  if (typeof parameters.maxTokens === 'number') documented.maxTokens = parameters.maxTokens;
  else if (typeof parameters.max_tokens === 'number') documented.maxTokens = parameters.max_tokens;
  if (typeof parameters.temperature === 'number') documented.temperature = parameters.temperature;
  if (typeof parameters.topP === 'number') documented.topP = parameters.topP;
  else if (typeof parameters.top_p === 'number') documented.topP = parameters.top_p;
  if (Array.isArray(parameters.stopSequences)) documented.stopSequences = parameters.stopSequences as string[];
  else if (Array.isArray(parameters.stop_sequences)) documented.stopSequences = parameters.stop_sequences as string[];

  const endpoint =
    options.client === undefined
      ? {
          ...(options.region ? { region: options.region } : {}),
          ...((options.apiKey ?? process.env.AWS_BEARER_TOKEN_BEDROCK)
            ? { apiKey: options.apiKey ?? process.env.AWS_BEARER_TOKEN_BEDROCK }
            : {}),
        }
      : {};
  return { ...explicit, ...documented, ...endpoint, modelId };
}

function installClient(model: BedrockModel, client: BedrockRuntimeClient | undefined): void {
  if (!client) return;
  const runtime = model as unknown as Record<string, unknown>;
  if ('client' in runtime) runtime.client = client;
  else runtime._client = client;
}

/**
 * Strands always creates its own OTel representation and does not expose a telemetry-off option.
 * Keep its useful in-memory traces while replacing only its private OTel tracer with non-recording
 * spans; the handler emits the repository's provider-neutral span tree through public hooks.
 */
function suppressStrandsOtel(agent: Agent): void {
  const runtime = agent as unknown as {
    _tracer?: { _tracer?: { startSpan(...args: unknown[]): Span } };
  };
  if (!runtime._tracer?._tracer) return;
  runtime._tracer._tracer = {
    startSpan: () => trace.wrapSpanContext(INVALID_SPAN_CONTEXT),
  };
}

function textParts(content: unknown): SpanMessagePart[] {
  if (!Array.isArray(content)) return [];
  return (
    content as Array<{
      text?: unknown;
      toolUse?: { toolUseId?: string; name?: unknown; input?: unknown };
    }>
  ).flatMap((block): SpanMessagePart[] => {
    const text = block.text;
    if (typeof text === 'string') return [{ type: 'text', content: text }];
    if (text && typeof text === 'object' && 'text' in text && typeof text.text === 'string') {
      return [{ type: 'text', content: text.text }];
    }
    if (block.toolUse) {
      return [
        {
          type: 'tool_call',
          id: block.toolUse.toolUseId,
          name: String(block.toolUse.name ?? ''),
          arguments: block.toolUse.input,
        },
      ];
    }
    return [];
  });
}

function messageText(message: unknown): string {
  return textParts((message as { content?: unknown } | undefined)?.content)
    .filter((part): part is Extract<SpanMessagePart, { type: 'text' }> => part.type === 'text')
    .map((part) => part.content)
    .join('');
}

function spanMessages(messages: ReadonlyArray<unknown>): SpanMessage[] {
  return messages.map((message) => ({
    role: String((message as { role?: unknown }).role ?? 'user'),
    parts: textParts((message as { content?: unknown }).content),
  }));
}

function failSpan(span: Span, error: unknown, ended?: Set<Span>): void {
  const exception = error instanceof Error ? error : new Error(String(error));
  span.recordException(exception);
  span.setStatus({ code: SpanStatusCode.ERROR, message: exception.message });
  if (ended) endSpanOnce(span, ended);
  else span.end();
}

function attachSpans(
  agent: Agent,
  modelId: string,
  parentContext: Context,
  captureContent: boolean,
): { close(error: unknown): void; abandon(ended: Set<Span>): void } {
  const modelSpans: Span[] = [];
  const toolSpans = new Map<string, Span>();
  const empty = {
    close() {},
    abandon() {},
  };
  if (typeof agent.addHook !== 'function') return empty;

  agent.addHook(BeforeModelCallEvent, (event) => {
    const span = trace.getTracer(TRACER_NAME).startSpan(`chat ${modelId}`, undefined, parentContext);
    span.setAttribute('gen_ai.operation.name', 'chat');
    setModelIdentityAttributes(span, 'aws.bedrock', modelId);
    setInputContentAttributes(span, captureContent, {
      messages: spanMessages(event.agent.messages),
    });
    modelSpans.push(span);
  });
  agent.addHook(AfterModelCallEvent, (event) => {
    const span = modelSpans.pop();
    if (!span) return;
    if (event.error) {
      failSpan(span, event.error);
      return;
    }
    const usage = mapUsage(event.stopData?.message.metadata?.usage as unknown as Record<string, unknown> | undefined);
    span.setAttribute('gen_ai.response.model', modelId);
    if (event.stopData?.stopReason) {
      span.setAttribute('gen_ai.response.finish_reasons', [
        event.stopData.stopReason === 'toolUse' ? 'tool_calls' : 'stop',
      ]);
    }
    setUsageSpanAttributes(span, addCachedTokensToInput(usage));
    setOutputContentAttributes(span, captureContent, [
      { role: 'assistant', parts: textParts(event.stopData?.message.content) },
    ]);
    span.setStatus({ code: SpanStatusCode.OK });
    span.end();
  });
  agent.addHook(BeforeToolCallEvent, (event) => {
    const span = trace.getTracer(TRACER_NAME).startSpan(`execute_tool ${event.toolUse.name}`, undefined, parentContext);
    span.setAttribute('gen_ai.operation.name', 'execute_tool');
    span.setAttribute('gen_ai.tool.name', event.toolUse.name);
    span.setAttribute('gen_ai.tool.call.id', event.toolUse.toolUseId);
    setToolCallContentAttributes(span, captureContent, { arguments: event.toolUse.input });
    toolSpans.set(event.toolUse.toolUseId, span);
  });
  agent.addHook(AfterToolCallEvent, (event) => {
    const span = toolSpans.get(event.toolUse.toolUseId);
    if (!span) return;
    toolSpans.delete(event.toolUse.toolUseId);
    if (event.error) {
      failSpan(span, event.error);
      return;
    }
    setToolCallContentAttributes(span, captureContent, { result: event.result });
    span.setStatus({ code: SpanStatusCode.OK });
    span.end();
  });
  const drain = () => {
    modelSpans.length = 0;
    toolSpans.clear();
  };

  return {
    close(error) {
      for (const span of modelSpans) failSpan(span, error);
      for (const span of toolSpans.values()) failSpan(span, error);
      drain();
    },
    // Early `break`/`return` from `for await` runs `finally` without `catch`. Ending these
    // spans as abandoned (UNSET + `launchdarkly.stream.abandoned`) matches the rest of the
    // repo: stopping early is not a failure, and ERROR here would disagree with LD metrics.
    abandon(ended) {
      for (const span of modelSpans) endSpanOnce(span, ended, true);
      for (const span of toolSpans.values()) endSpanOnce(span, ended, true);
      drain();
    },
  };
}

function createAgent(
  config: AiConfigRep,
  toolHandlers: Record<string, ToolHandlerFn | NativeTool>,
  variables: Record<string, unknown>,
  options: BedrockAgentsHandlerOptions,
) {
  const modelId = resolveBedrockModelId(config);
  const model = new BedrockModel(modelOptions(config, options, modelId));
  installClient(model, options.client);
  const tools = config.tools ? buildTools(config.tools, toolHandlers) : [];
  const prompt = systemPrompt(config, variables);
  const agent = new Agent({
    model,
    ...(prompt ? { systemPrompt: prompt } : {}),
    ...(tools.length ? { tools } : {}),
    printer: false,
  });
  suppressStrandsOtel(agent);
  return { agent, modelId, prompt };
}

function finishRoot(root: Span, modelId: string, usage: RawUsage, output: string, captureContent: boolean): void {
  root.setAttribute('gen_ai.response.model', modelId);
  setUsageSpanAttributes(root, addCachedTokensToInput(usage));
  setOutputContentAttributes(root, captureContent, [{ role: 'assistant', parts: [{ type: 'text', content: output }] }]);
}

export function createBedrockAgentsHandler(options: BedrockAgentsHandlerOptions = {}): ProviderHandler {
  const captureContent = options.captureContent ?? false;
  return createHandler(
    ['Bedrock', 'agent'],
    async (config, userInput = '', toolHandlers = {}, variables = {}, history) =>
      trace.getTracer(TRACER_NAME).startActiveSpan('invoke_agent', async (root) => {
        const { agent, modelId, prompt } = createAgent(config, toolHandlers, variables, options);
        root.setAttribute('gen_ai.operation.name', 'invoke_agent');
        setModelIdentityAttributes(root, 'aws.bedrock', modelId);
        setLdSpanAttributes(root, variables);
        const input = buildInput(config, userInput, variables, history);
        setInputContentAttributes(root, captureContent, {
          systemInstructions: prompt,
          messages:
            typeof input === 'string'
              ? [{ role: 'user', parts: [{ type: 'text', content: input }] }]
              : spanMessages(input),
        });
        const hooks = attachSpans(agent, modelId, trace.setSpan(context.active(), root), captureContent);
        try {
          const result = await agent.invoke(input);
          const output =
            result.structuredOutput !== undefined ? result.structuredOutput : messageText(result.lastMessage);
          const textOutput = typeof output === 'string' ? output : JSON.stringify(output);
          const usage = mapUsage(result.metrics?.accumulatedUsage as unknown as Record<string, unknown> | undefined);
          finishRoot(root, modelId, usage, textOutput, captureContent);
          root.setStatus({ code: SpanStatusCode.OK });
          root.end();
          return { output, usage: responseUsage(usage) };
        } catch (error) {
          hooks.close(error);
          failSpan(root, error);
          throw error;
        }
      }),
    async function* streamHandler(config, userInput = '', toolHandlers = {}, variables = {}, history) {
      const root = trace.getTracer(TRACER_NAME).startSpan('invoke_agent');
      const ended = new Set<Span>();
      const { agent, modelId, prompt } = createAgent(config, toolHandlers, variables, options);
      root.setAttribute('gen_ai.operation.name', 'invoke_agent');
      setModelIdentityAttributes(root, 'aws.bedrock', modelId);
      setLdSpanAttributes(root, variables);
      const input = buildInput(config, userInput, variables, history);
      setInputContentAttributes(root, captureContent, {
        systemInstructions: prompt,
        messages:
          typeof input === 'string'
            ? [{ role: 'user', parts: [{ type: 'text', content: input }] }]
            : spanMessages(input),
      });
      const hooks = attachSpans(agent, modelId, trace.setSpan(context.active(), root), captureContent);
      let output = '';
      let usage = mapUsage(undefined);
      try {
        for await (const rawEvent of agent.stream(input)) {
          const event = rawEvent as unknown as {
            type?: string;
            result?: {
              lastMessage?: unknown;
              metrics?: { accumulatedUsage?: unknown };
            };
          };
          if (event.type === 'modelStreamUpdateEvent') {
            const modelEvent = (event as unknown as ModelStreamUpdateEvent).event;
            if (modelEvent.type === 'modelContentBlockDeltaEvent' && modelEvent.delta.type === 'textDelta') {
              output += modelEvent.delta.text;
              yield { type: 'chunk' as const, text: modelEvent.delta.text };
            }
          }
          if (event.type === 'agentResultEvent' && event.result) {
            output = messageText(event.result.lastMessage) || output;
            usage = mapUsage(event.result.metrics?.accumulatedUsage as Record<string, unknown> | undefined);
          }
        }
        finishRoot(root, modelId, usage, output, captureContent);
        root.setStatus({ code: SpanStatusCode.OK });
        endSpanOnce(root, ended);
        yield { type: 'done' as const, output, usage: responseUsage(usage) };
      } catch (error) {
        hooks.close(error);
        failSpan(root, error, ended);
        throw error;
      } finally {
        // Success and failure already put `root` in `ended`. Abandonment is the remaining
        // path: cancel the in-flight Strands run and close open children without ERROR.
        if (!ended.has(root)) {
          agent.cancel();
          hooks.abandon(ended);
        }
        endSpanOnce(root, ended, true);
      }
    },
    captureContent,
  );
}

export const bedrockAgents = (
  configKey: string,
  userInput: string,
  contextValue: LDContext,
  {
    captureContent,
    client,
    apiKey,
    region,
    modelOptions: optionsForModel,
    variables,
    ...options
  }: Omit<Parameters<typeof config>[0], 'handler' | 'key'> &
    BedrockAgentsHandlerOptions & { variables?: Record<string, unknown> } = {},
) =>
  config({
    ...options,
    key: configKey,
    handler: createBedrockAgentsHandler({
      captureContent,
      client,
      apiKey,
      region,
      modelOptions: optionsForModel,
    }),
  }).invoke(userInput, contextValue, variables);
