import {
  type Message as BedrockMessage,
  BedrockRuntimeClient,
  type BedrockRuntimeClientConfig,
  type Tool as BedrockTool,
  type ContentBlock,
  ConverseCommand,
  type ConverseCommandInput,
  type ConverseCommandOutput,
  ConverseStreamCommand,
  type ConverseStreamCommandInput,
  type SystemContentBlock,
  type ToolUseBlock,
} from '@aws-sdk/client-bedrock-runtime';
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
  type ToolDefinitionInput,
  type ToolHandlerFn,
  toSemconvFinishReason,
} from '@launchdarkly/ai-server';
import { type Context, context, type Span, SpanStatusCode, trace } from '@opentelemetry/api';

const TRACER_NAME = '@launchdarkly/ai-bedrock-messages';
const MAX_STEPS = 10;

export interface BedrockMessagesHandlerOptions extends ContentCaptureOptions {
  /** An existing client. It remains owned by the caller and is never destroyed. */
  client?: BedrockRuntimeClient;
  /** Bedrock API key. Takes precedence over AWS_BEARER_TOKEN_BEDROCK. */
  apiKey?: string;
  /** AWS endpoint region. This is separate from the model inference-profile prefix. */
  region?: string;
  /** Additional Converse fields, evaluated once for every provider turn. */
  converseOptions?: (config: AiConfigRep) => Partial<ConverseCommandInput>;
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

function emptyUsage(): RawUsage {
  return {
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  };
}

function mapUsage(usage: Record<string, unknown> | undefined): RawUsage {
  const input = numberOrZero(usage?.inputTokens);
  const output = numberOrZero(usage?.outputTokens);
  const cacheRead = numberOrZero(usage?.cacheReadInputTokens);
  const cacheCreation = numberOrZero(usage?.cacheWriteInputTokens);
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: numberOrZero(usage?.totalTokens) || input + output,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheCreation,
  };
}

function addUsage(total: RawUsage, turn: RawUsage): void {
  total.input_tokens += turn.input_tokens;
  total.output_tokens += turn.output_tokens;
  total.total_tokens += turn.total_tokens;
  total.cache_read_input_tokens += turn.cache_read_input_tokens;
  total.cache_creation_input_tokens += turn.cache_creation_input_tokens;
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

function createClient(options: BedrockMessagesHandlerOptions): BedrockRuntimeClient {
  if (options.client) return options.client;
  const token = options.apiKey ?? process.env.AWS_BEARER_TOKEN_BEDROCK;
  const clientConfig: BedrockRuntimeClientConfig = {
    ...(options.region ? { region: options.region } : {}),
    ...(token ? { token: { token } } : {}),
  };
  return new BedrockRuntimeClient(clientConfig);
}

function inferenceConfig(parameters: Record<string, unknown> | undefined): ConverseCommandInput['inferenceConfig'] {
  if (!parameters) return undefined;
  const config: NonNullable<ConverseCommandInput['inferenceConfig']> = {};
  if (typeof parameters.maxTokens === 'number') config.maxTokens = parameters.maxTokens;
  else if (typeof parameters.max_tokens === 'number') config.maxTokens = parameters.max_tokens;
  if (typeof parameters.temperature === 'number') config.temperature = parameters.temperature;
  if (typeof parameters.topP === 'number') config.topP = parameters.topP;
  else if (typeof parameters.top_p === 'number') config.topP = parameters.top_p;
  if (Array.isArray(parameters.stopSequences)) config.stopSequences = parameters.stopSequences as string[];
  else if (Array.isArray(parameters.stop_sequences)) config.stopSequences = parameters.stop_sequences as string[];
  return Object.keys(config).length > 0 ? config : undefined;
}

function mapHistoryContent(content: unknown): ContentBlock[] {
  if (typeof content === 'string') return [{ text: content }];
  if (!Array.isArray(content)) return [];
  return (
    content as Array<{
      type?: unknown;
      text?: unknown;
      source?: { type?: unknown; media_type?: unknown; data?: unknown };
    }>
  ).flatMap((block): ContentBlock[] => {
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
                format: format as 'png' | 'jpeg' | 'gif' | 'webp',
                source: { bytes: Uint8Array.from(Buffer.from(String(block.source.data ?? ''), 'base64')) },
              },
            },
          ]
        : [];
    }
    return [];
  });
}

function buildConversation(
  config: AiConfigRep,
  userInput: string,
  variables: Record<string, unknown>,
  history?: Message[],
  includeOutputFormat = true,
): { messages: BedrockMessage[]; system?: SystemContentBlock[] } {
  const messages: BedrockMessage[] = [];
  let systemText: string | undefined;

  if (config.messages?.length) {
    const system = config.messages.filter((message) => message.role === 'system');
    if (system.length) systemText = parseTemplate(system.map((message) => message.content).join('\n'), variables);
    for (const message of config.messages) {
      if (message.role !== 'user' && message.role !== 'assistant') continue;
      messages.push({ role: message.role, content: [{ text: parseTemplate(message.content, variables) }] });
    }
  } else if (config.instructions) {
    systemText = parseTemplate(config.instructions, variables);
  }

  for (const message of history ?? []) {
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    messages.push({ role: message.role, content: mapHistoryContent(message.content) });
  }

  if (userInput || messages.at(-1)?.role !== 'user') {
    messages.push({ role: 'user', content: [{ text: userInput }] });
  }

  if (includeOutputFormat && config.outputFormat) {
    const instruction = `Respond with valid JSON matching this schema:\n${JSON.stringify(config.outputFormat)}`;
    systemText = systemText ? `${systemText}\n\n${instruction}` : instruction;
  }

  return { messages, ...(systemText ? { system: [{ text: systemText }] } : {}) };
}

function buildTools(
  configTools: Record<string, Tool>,
  handlers: Record<string, ToolHandlerFn | NativeTool>,
): BedrockTool[] {
  return Object.entries(configTools)
    .filter(([name]) => typeof handlers[name] === 'function')
    .map(
      ([name, definition]) =>
        ({
          toolSpec: {
            name,
            description: definition.description ?? '',
            inputSchema: { json: definition.parameters },
          },
        }) as BedrockTool,
    );
}

function toSpanParts(content: ContentBlock[] | undefined): SpanMessagePart[] {
  return (content ?? []).flatMap((block): SpanMessagePart[] => {
    if ('text' in block) return [{ type: 'text', content: block.text ?? '' }];
    if ('toolUse' in block && block.toolUse) {
      return [
        {
          type: 'tool_call',
          id: block.toolUse.toolUseId,
          name: block.toolUse.name ?? '',
          arguments: block.toolUse.input,
        },
      ];
    }
    if ('toolResult' in block && block.toolResult) {
      return [{ type: 'tool_call_response', id: block.toolResult.toolUseId, result: block.toolResult.content }];
    }
    return [];
  });
}

const toSpanMessages = (messages: BedrockMessage[]): SpanMessage[] =>
  messages.map((message) => ({ role: message.role ?? 'user', parts: toSpanParts(message.content) }));

const toToolDefinitions = (tools: BedrockTool[]): ToolDefinitionInput[] =>
  tools.flatMap((tool) =>
    tool.toolSpec?.name
      ? [
          {
            name: tool.toolSpec.name,
            description: tool.toolSpec.description,
            parameters: tool.toolSpec.inputSchema?.json,
          },
        ]
      : [],
  );

function startModelSpan(
  modelId: string,
  parentContext: Context,
  captureContent: boolean,
  request: ConverseCommandInput,
) {
  const span = trace.getTracer(TRACER_NAME).startSpan(`chat ${modelId}`, undefined, parentContext);
  span.setAttribute('gen_ai.operation.name', 'chat');
  setModelIdentityAttributes(span, 'aws.bedrock', modelId);
  setInputContentAttributes(span, captureContent, {
    systemInstructions: request.system?.flatMap((block) => ('text' in block ? [block.text ?? ''] : [])).join('\n'),
    messages: toSpanMessages(request.messages ?? []),
    toolDefinitions: toToolDefinitions(request.toolConfig?.tools ?? []),
  });
  return span;
}

function finishModelSpan(
  span: Span,
  modelId: string,
  usage: RawUsage,
  responseContent: ContentBlock[],
  stopReason?: string,
  captureContent = false,
) {
  span.setAttribute('gen_ai.response.model', modelId);
  const finishReason = toSemconvFinishReason(stopReason);
  if (finishReason) span.setAttribute('gen_ai.response.finish_reasons', [finishReason]);
  setUsageSpanAttributes(span, addCachedTokensToInput(usage));
  setOutputContentAttributes(span, captureContent, [{ role: 'assistant', parts: toSpanParts(responseContent) }]);
  span.setStatus({ code: SpanStatusCode.OK });
  span.end();
}

function failSpan(span: Span, error: unknown, ended?: Set<Span>) {
  const exception = error instanceof Error ? error : new Error(String(error));
  span.recordException(exception);
  span.setStatus({ code: SpanStatusCode.ERROR, message: exception.message });
  if (ended) endSpanOnce(span, ended);
  else span.end();
}

function buildRequest(
  options: BedrockMessagesHandlerOptions,
  config: AiConfigRep,
  modelId: string,
  conversation: BedrockMessage[],
  system: SystemContentBlock[] | undefined,
  tools: BedrockTool[],
): ConverseCommandInput {
  const commonInferenceConfig = inferenceConfig(config.model.parameters);
  const extra = options.converseOptions?.(config) ?? {};
  return {
    ...(commonInferenceConfig ? { inferenceConfig: commonInferenceConfig } : {}),
    ...extra,
    modelId,
    messages: conversation,
    ...(system ? { system } : {}),
    ...(tools.length ? { toolConfig: { tools } } : {}),
  };
}

async function executeTools(
  content: ContentBlock[],
  handlers: Record<string, ToolHandlerFn | NativeTool>,
  parentContext: Context,
  captureContent: boolean,
): Promise<ContentBlock[]> {
  return Promise.all(
    content
      .filter((block): block is { toolUse: ToolUseBlock } => 'toolUse' in block && block.toolUse !== undefined)
      .map(async ({ toolUse }) => {
        const name = toolUse.name ?? '';
        const span = trace.getTracer(TRACER_NAME).startSpan(`execute_tool ${name}`, undefined, parentContext);
        span.setAttribute('gen_ai.operation.name', 'execute_tool');
        span.setAttribute('gen_ai.tool.name', name);
        span.setAttribute('gen_ai.tool.call.id', toolUse.toolUseId ?? '');
        setToolCallContentAttributes(span, captureContent, { arguments: toolUse.input });
        try {
          const handler = handlers[name];
          if (typeof handler !== 'function') throw new Error(`No handler registered for tool "${name}"`);
          const result = await (handler as (input: unknown) => unknown)(toolUse.input);
          setToolCallContentAttributes(span, captureContent, { result });
          span.setStatus({ code: SpanStatusCode.OK });
          span.end();
          return {
            toolResult: {
              toolUseId: toolUse.toolUseId ?? '',
              content: typeof result === 'object' && result !== null ? [{ json: result }] : [{ text: String(result) }],
            },
          } as ContentBlock;
        } catch (error) {
          failSpan(span, error);
          throw error;
        }
      }),
  );
}

export function createBedrockMessagesHandler(options: BedrockMessagesHandlerOptions = {}): ProviderHandler {
  const client = createClient(options);
  const captureContent = options.captureContent ?? false;

  return createHandler(
    ['Bedrock', 'messages'],
    async (config, userInput = '', toolHandlers = {}, variables = {}, history) =>
      trace.getTracer(TRACER_NAME).startActiveSpan('invoke_agent', async (root) => {
        const modelId = resolveBedrockModelId(config);
        root.setAttribute('gen_ai.operation.name', 'invoke_agent');
        setModelIdentityAttributes(root, 'aws.bedrock', modelId);
        setLdSpanAttributes(root, variables);
        const parentContext = trace.setSpan(context.active(), root);
        const built = buildConversation(config, userInput, variables, history);
        const conversation = [...built.messages];
        const tools = config.tools ? buildTools(config.tools, toolHandlers) : [];
        const totalUsage = emptyUsage();
        let output = '';

        try {
          for (let step = 0; step <= MAX_STEPS; step++) {
            const request = buildRequest(options, config, modelId, conversation, built.system, tools);
            const modelSpan = startModelSpan(modelId, parentContext, captureContent, request);
            let response: ConverseCommandOutput;
            try {
              response = await client.send(new ConverseCommand(request));
            } catch (error) {
              failSpan(modelSpan, error);
              throw error;
            }
            const content = response.output?.message?.content ?? [];
            const usage = mapUsage(response.usage as Record<string, unknown> | undefined);
            addUsage(totalUsage, usage);
            finishModelSpan(modelSpan, modelId, usage, content, response.stopReason, captureContent);

            if (response.stopReason !== 'tool_use') {
              output = content.flatMap((block) => ('text' in block ? [block.text ?? ''] : [])).join('');
              break;
            }
            if (step === MAX_STEPS) throw new Error(`Tool loop exceeded the maximum number of steps (${MAX_STEPS})`);
            conversation.push(response.output?.message ?? { role: 'assistant', content });
            conversation.push({
              role: 'user',
              content: await executeTools(content, toolHandlers, parentContext, captureContent),
            });
          }

          root.setAttribute('gen_ai.response.model', modelId);
          setUsageSpanAttributes(root, addCachedTokensToInput(totalUsage));
          setOutputContentAttributes(root, captureContent, [
            { role: 'assistant', parts: [{ type: 'text', content: output }] },
          ]);
          root.setStatus({ code: SpanStatusCode.OK });
          root.end();
          return { output, usage: responseUsage(totalUsage) };
        } catch (error) {
          if (totalUsage.total_tokens > 0) setUsageSpanAttributes(root, addCachedTokensToInput(totalUsage));
          failSpan(root, error);
          throw error;
        }
      }),
    async function* streamHandler(config, userInput = '', toolHandlers = {}, variables = {}, history) {
      const root = trace.getTracer(TRACER_NAME).startSpan('invoke_agent');
      const ended = new Set<Span>();
      const modelId = resolveBedrockModelId(config);
      root.setAttribute('gen_ai.operation.name', 'invoke_agent');
      setModelIdentityAttributes(root, 'aws.bedrock', modelId);
      setLdSpanAttributes(root, variables);
      const parentContext = trace.setSpan(context.active(), root);
      const built = buildConversation(config, userInput, variables, history, false);
      const conversation = [...built.messages];
      const tools = config.tools ? buildTools(config.tools, toolHandlers) : [];
      const totalUsage = emptyUsage();
      let output = '';
      let openModelSpan: Span | undefined;

      try {
        for (let step = 0; step <= MAX_STEPS; step++) {
          const request = buildRequest(options, config, modelId, conversation, built.system, tools);
          const modelSpan = startModelSpan(modelId, parentContext, captureContent, request);
          openModelSpan = modelSpan;
          const response = await client.send(new ConverseStreamCommand(request as ConverseStreamCommandInput));
          const content: ContentBlock[] = [];
          const toolInputs = new Map<number, { toolUseId: string; name: string; input: string }>();
          let stopReason: string | undefined;
          let turnUsage = emptyUsage();
          let turnText = '';

          for await (const event of response.stream ?? []) {
            if (event.contentBlockStart?.start?.toolUse) {
              toolInputs.set(event.contentBlockStart.contentBlockIndex ?? 0, {
                toolUseId: event.contentBlockStart.start.toolUse.toolUseId ?? '',
                name: event.contentBlockStart.start.toolUse.name ?? '',
                input: '',
              });
            }
            const delta = event.contentBlockDelta?.delta;
            if (delta?.text) {
              output += delta.text;
              turnText += delta.text;
              yield { type: 'chunk' as const, text: delta.text };
            }
            if (delta?.toolUse?.input) {
              const pending = toolInputs.get(event.contentBlockDelta?.contentBlockIndex ?? 0);
              if (pending) pending.input += delta.toolUse.input;
            }
            if (event.messageStop?.stopReason) stopReason = event.messageStop.stopReason;
            if (event.metadata?.usage) {
              turnUsage = mapUsage(event.metadata.usage as unknown as Record<string, unknown>);
            }
          }

          if (turnText) content.push({ text: turnText });
          for (const pending of toolInputs.values()) {
            let input: unknown = {};
            try {
              input = pending.input ? JSON.parse(pending.input) : {};
            } catch {
              input = pending.input;
            }
            content.push({
              toolUse: {
                toolUseId: pending.toolUseId,
                name: pending.name,
                input: input as ToolUseBlock['input'],
              },
            });
          }
          addUsage(totalUsage, turnUsage);
          finishModelSpan(modelSpan, modelId, turnUsage, content, stopReason, captureContent);
          openModelSpan = undefined;
          if (stopReason !== 'tool_use') break;
          if (step === MAX_STEPS) throw new Error(`Tool loop exceeded the maximum number of steps (${MAX_STEPS})`);
          conversation.push({ role: 'assistant', content });
          conversation.push({
            role: 'user',
            content: await executeTools(content, toolHandlers, parentContext, captureContent),
          });
        }

        root.setAttribute('gen_ai.response.model', modelId);
        setUsageSpanAttributes(root, addCachedTokensToInput(totalUsage));
        setOutputContentAttributes(root, captureContent, [
          { role: 'assistant', parts: [{ type: 'text', content: output }] },
        ]);
        root.setStatus({ code: SpanStatusCode.OK });
        endSpanOnce(root, ended);
        yield { type: 'done' as const, output, usage: responseUsage(totalUsage) };
      } catch (error) {
        if (openModelSpan) failSpan(openModelSpan, error, ended);
        if (totalUsage.total_tokens > 0) setUsageSpanAttributes(root, addCachedTokensToInput(totalUsage));
        failSpan(root, error, ended);
        throw error;
      } finally {
        if (openModelSpan) endSpanOnce(openModelSpan, ended, true);
        endSpanOnce(root, ended, true);
      }
    },
    captureContent,
  );
}

export const bedrockMessages = (
  configKey: string,
  userInput: string,
  contextValue: LDContext,
  {
    captureContent,
    client,
    apiKey,
    region,
    converseOptions,
    variables,
    ...options
  }: Omit<Parameters<typeof config>[0], 'handler' | 'key'> &
    BedrockMessagesHandlerOptions & { variables?: Record<string, unknown> } = {},
) =>
  config({
    ...options,
    key: configKey,
    handler: createBedrockMessagesHandler({ captureContent, client, apiKey, region, converseOptions }),
  }).invoke(userInput, contextValue, variables);
