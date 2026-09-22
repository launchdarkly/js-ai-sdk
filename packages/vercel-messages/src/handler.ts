import {
  type AiConfigRep,
  type CanonicalTurn,
  type ConfigTurn,
  type ContentCaptureOptions,
  composeHistory,
  config,
  createHandler,
  type LDContext,
  type Message,
  type MessageContent,
  type NativeTool,
  type ProviderHandler,
  parseTemplate,
  setInputContentAttributes,
  setLdSpanAttributes,
  setModelIdentityAttributes,
  setOutputContentAttributes,
  setToolCallContentAttributes,
  setUsageSpanAttributes,
  type Tool,
  type ToolDefinitionInput,
  type ToolHandlerFn,
  textMessage,
} from '@launchdarkly/ai-server';
import { context, type Span, SpanStatusCode, trace } from '@opentelemetry/api';
import {
  generateText,
  jsonSchema,
  type LanguageModel,
  type ModelMessage,
  Output,
  stepCountIs,
  streamText,
  type ToolSet,
  tool,
} from 'ai';
import { gatewayModelId } from './model-id.js';

const TRACER_NAME = '@launchdarkly/ai-vercel-messages';
const MAX_STEPS = 10;

const OWNED_PARAMETER_NAMES = new Set([
  'model',
  'messages',
  'prompt',
  'system',
  'tools',
  'stream',
  'output',
  'outputformat',
  'stopwhen',
  'maxsteps',
  'apikey',
  'baseurl',
]);

export type VercelModelSource = LanguageModel | ((config: AiConfigRep) => LanguageModel | Promise<LanguageModel>);

export interface VercelMessagesOptions extends ContentCaptureOptions {
  model?: LanguageModel;
  modelFactory?: (config: AiConfigRep) => LanguageModel | Promise<LanguageModel>;
}

type Usage = { input: number; output: number; total: number };

function numberOrZero(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeUsage(usage: unknown): Usage {
  const raw = (usage ?? {}) as Record<string, unknown>;
  const input = numberOrZero(raw.inputTokens ?? raw.input_tokens ?? raw.input);
  const output = numberOrZero(raw.outputTokens ?? raw.output_tokens ?? raw.output);
  return { input, output, total: numberOrZero(raw.totalTokens ?? raw.total_tokens) || input + output };
}

function returnedUsage(usage: Usage): Record<string, number> {
  return {
    input_tokens: usage.input,
    output_tokens: usage.output,
    total_tokens: usage.total,
  };
}

function servingProvider(config: AiConfigRep): string {
  return (config.provider?.name || 'unknown').toLowerCase();
}

function modelSettings(config: AiConfigRep): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(config.model.parameters ?? {}).filter(([key]) => {
      const normalized = key.replaceAll('_', '').replaceAll('-', '').toLowerCase();
      return !OWNED_PARAMETER_NAMES.has(normalized);
    }),
  );
}

async function resolveModel(config: AiConfigRep, options: VercelMessagesOptions): Promise<LanguageModel | string> {
  if (options.modelFactory) return options.modelFactory(config);
  if (options.model) return options.model;
  return gatewayModelId(config);
}

function systemInstructions(config: AiConfigRep, variables: Record<string, unknown>): string | undefined {
  if (config.instructions) return parseTemplate(config.instructions, variables);
  const system = (config.messages ?? []).filter((message) => message.role === 'system');
  return system.length > 0 ? parseTemplate(system.map((message) => message.content).join('\n'), variables) : undefined;
}

function configTurns(config: AiConfigRep, variables: Record<string, unknown>): ConfigTurn[] {
  if (config.instructions) return [];
  return (config.messages ?? [])
    .filter((message) => message.role !== 'system')
    .map((message) => ({
      role: message.role as 'user' | 'assistant',
      content: parseTemplate(message.content, variables),
    }));
}

function toAiContent(content: MessageContent): ModelMessage['content'] {
  if (typeof content === 'string') return content;
  return content.map((block) => {
    if (block.type === 'text') return { type: 'text' as const, text: block.text };
    if (block.source.type === 'url') {
      return { type: 'image' as const, image: new URL(block.source.url) };
    }
    return {
      type: 'image' as const,
      image: Uint8Array.from(Buffer.from(block.source.data, 'base64')),
      mediaType: block.source.media_type,
    };
  });
}

function toModelMessage(turn: CanonicalTurn): ModelMessage {
  return { role: turn.role, content: toAiContent(turn.content) } as ModelMessage;
}

function buildMessages(
  config: AiConfigRep,
  userInput: string,
  variables: Record<string, unknown>,
  history?: Message[],
): ModelMessage[] {
  const configured = configTurns(config, variables);
  if (history?.length) {
    return composeHistory({ configMessages: configured, history, userInput }).map(toModelMessage);
  }
  const turns: CanonicalTurn[] = [...configured];
  if (turns.at(-1)?.role !== 'user') turns.push({ role: 'user', content: userInput });
  return turns.map(toModelMessage);
}

function spanMessages(messages: ModelMessage[]) {
  return messages.map((message) =>
    textMessage(message.role === 'assistant' ? 'assistant' : 'user', messageText(message)),
  );
}

function messageText(message: ModelMessage): string {
  if (typeof message.content === 'string') return message.content;
  return message.content
    .filter((part): part is Extract<(typeof message.content)[number], { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('');
}

function failSpan(span: Span, error: unknown): void {
  const exception = error instanceof Error ? error : new Error(String(error));
  span.recordException(exception);
  span.setStatus({ code: SpanStatusCode.ERROR, message: exception.message });
  span.end();
}

function startChatSpan(config: AiConfigRep, parentSpan: Span): Span {
  const parent = trace.setSpan(context.active(), parentSpan);
  const span = trace.getTracer(TRACER_NAME).startSpan(`chat ${config.model.name}`, undefined, parent);
  span.setAttribute('gen_ai.operation.name', 'chat');
  setModelIdentityAttributes(span, servingProvider(config), config.model.name);
  return span;
}

function finishChatSpan(span: Span, usage: Usage): void {
  setUsageSpanAttributes(span, { input: usage.input, output: usage.output, cacheRead: 0, cacheCreation: 0 });
  span.setStatus({ code: SpanStatusCode.OK });
  span.end();
}

function toolDefinitions(configTools: Record<string, Tool>, handlers: Record<string, ToolHandlerFn | NativeTool>) {
  return Object.entries(configTools)
    .filter(([name]) => typeof handlers[name] === 'function')
    .map(([name, definition]) => ({ name, definition }));
}

function buildTools(
  configTools: Record<string, Tool> | undefined,
  handlers: Record<string, ToolHandlerFn | NativeTool>,
  parentSpan: Span,
  captureContent: boolean,
): { tools: ToolSet; definitions: ToolDefinitionInput[] } {
  const available = toolDefinitions(configTools ?? {}, handlers);
  const tools = Object.fromEntries(
    available.map(({ name, definition }) => [
      name,
      tool({
        description: definition.description ?? '',
        // AI SDK 7 accepts Standard Schema and raw JSON Schema through jsonSchema().
        inputSchema: jsonSchema(definition.parameters),
        execute: async (args, options) => {
          const toolSpan = trace
            .getTracer(TRACER_NAME)
            .startSpan(`execute_tool ${name}`, undefined, trace.setSpan(context.active(), parentSpan));
          toolSpan.setAttribute('gen_ai.operation.name', 'execute_tool');
          toolSpan.setAttribute('gen_ai.tool.name', name);
          toolSpan.setAttribute('gen_ai.tool.call.id', options.toolCallId);
          setToolCallContentAttributes(toolSpan, captureContent, { arguments: args });
          try {
            const result = await (handlers[name] as (...args: unknown[]) => unknown)(args);
            setToolCallContentAttributes(toolSpan, captureContent, { result });
            toolSpan.setStatus({ code: SpanStatusCode.OK });
            toolSpan.end();
            return result;
          } catch (error) {
            failSpan(toolSpan, error);
            throw error;
          }
        },
      }),
    ]),
  );
  return {
    tools,
    definitions: available.map(({ name, definition }) => ({
      name,
      description: definition.description,
      parameters: definition.parameters,
    })),
  };
}

/**
 * Flags may store `outputFormat` with `type: "json_schema"` (the OpenAI response-format
 * descriptor) rather than a JSON Schema type, and commonly declare a partial `required`
 * list. Providers enforcing strict structured output reject an object schema unless
 * `required` names every property and extras are disallowed, so both are set here.
 */
function normalizeOutputSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const properties = schema.properties as Record<string, unknown> | undefined;
  if (!properties) return schema;
  return {
    ...schema,
    ...(schema.type === 'json_schema' ? { type: 'object' } : {}),
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

function requestOutput(schema: Record<string, unknown> | undefined) {
  return schema ? Output.object({ schema: jsonSchema(normalizeOutputSchema(schema)) }) : undefined;
}

function resultUsage(result: { usage?: unknown; steps?: Array<{ usage?: unknown }> }): Usage {
  if (result.usage) return normalizeUsage(result.usage);
  const total = { input: 0, output: 0, total: 0 };
  for (const step of result.steps ?? []) {
    const usage = normalizeUsage(step.usage);
    total.input += usage.input;
    total.output += usage.output;
    total.total += usage.total;
  }
  return total;
}

export function createVercelMessagesHandler(options: VercelMessagesOptions = {}): ProviderHandler {
  const { captureContent = false } = options;
  return createHandler(
    ['*', 'messages'],
    async (configRep, userInput = '', toolHandlers = {}, variables = {}, history) =>
      trace.getTracer(TRACER_NAME).startActiveSpan('invoke_agent', async (rootSpan) => {
        rootSpan.setAttribute('gen_ai.operation.name', 'invoke_agent');
        setModelIdentityAttributes(rootSpan, servingProvider(configRep), configRep.model.name);
        setLdSpanAttributes(rootSpan, variables);
        const system = systemInstructions(configRep, variables);
        const messages = buildMessages(configRep, userInput, variables, history);
        const { tools, definitions } = buildTools(configRep.tools, toolHandlers, rootSpan, captureContent);
        setInputContentAttributes(rootSpan, captureContent, {
          systemInstructions: system,
          messages: spanMessages(messages),
          toolDefinitions: definitions,
        });
        const chatSpan = startChatSpan(configRep, rootSpan);
        setInputContentAttributes(chatSpan, captureContent, {
          systemInstructions: system,
          messages: spanMessages(messages),
          toolDefinitions: definitions,
        });
        try {
          const output = requestOutput(configRep.outputFormat);
          const result = await generateText({
            ...modelSettings(configRep),
            model: await resolveModel(configRep, options),
            messages,
            ...(system ? { system } : {}),
            ...(Object.keys(tools).length > 0 ? { tools, stopWhen: stepCountIs(MAX_STEPS) } : {}),
            ...(output ? { output } : {}),
          });
          const usage = resultUsage(result);
          const resultOutput = output ? JSON.stringify(result.output) : result.text;
          setOutputContentAttributes(chatSpan, captureContent, [textMessage('assistant', resultOutput)]);
          setOutputContentAttributes(rootSpan, captureContent, [textMessage('assistant', resultOutput)]);
          finishChatSpan(chatSpan, usage);
          setUsageSpanAttributes(rootSpan, {
            input: usage.input,
            output: usage.output,
            cacheRead: 0,
            cacheCreation: 0,
          });
          rootSpan.setStatus({ code: SpanStatusCode.OK });
          rootSpan.end();
          return { output: resultOutput, usage: returnedUsage(usage) };
        } catch (error) {
          failSpan(chatSpan, error);
          failSpan(rootSpan, error);
          throw error;
        }
      }),
    async function* streamHandler(configRep, userInput = '', toolHandlers = {}, variables = {}, history) {
      const rootSpan = trace.getTracer(TRACER_NAME).startSpan('invoke_agent');
      rootSpan.setAttribute('gen_ai.operation.name', 'invoke_agent');
      setModelIdentityAttributes(rootSpan, servingProvider(configRep), configRep.model.name);
      setLdSpanAttributes(rootSpan, variables);
      const system = systemInstructions(configRep, variables);
      const messages = buildMessages(configRep, userInput, variables, history);
      const { tools, definitions } = buildTools(configRep.tools, toolHandlers, rootSpan, captureContent);
      setInputContentAttributes(rootSpan, captureContent, {
        systemInstructions: system,
        messages: spanMessages(messages),
        toolDefinitions: definitions,
      });
      const chatSpan = startChatSpan(configRep, rootSpan);
      let chatEnded = false;
      let rootEnded = false;
      let iterator: AsyncIterator<string> | undefined;
      let completed = false;
      let fullOutput = '';
      try {
        const result = streamText({
          ...modelSettings(configRep),
          model: await resolveModel(configRep, options),
          messages,
          ...(system ? { system } : {}),
          ...(Object.keys(tools).length > 0 ? { tools, stopWhen: stepCountIs(MAX_STEPS) } : {}),
        });
        iterator = result.textStream[Symbol.asyncIterator]();
        while (true) {
          const next = await iterator.next();
          if (next.done) {
            completed = true;
            break;
          }
          fullOutput += next.value;
          yield { type: 'chunk' as const, text: next.value };
        }
        const usage = normalizeUsage(await result.usage);
        setOutputContentAttributes(chatSpan, captureContent, [textMessage('assistant', fullOutput)]);
        setOutputContentAttributes(rootSpan, captureContent, [textMessage('assistant', fullOutput)]);
        finishChatSpan(chatSpan, usage);
        chatEnded = true;
        setUsageSpanAttributes(rootSpan, { input: usage.input, output: usage.output, cacheRead: 0, cacheCreation: 0 });
        rootSpan.setStatus({ code: SpanStatusCode.OK });
        rootSpan.end();
        rootEnded = true;
        yield { type: 'done' as const, output: fullOutput, usage: returnedUsage(usage) };
      } catch (error) {
        if (!chatEnded) {
          failSpan(chatSpan, error);
          chatEnded = true;
        }
        if (!rootEnded) {
          failSpan(rootSpan, error);
          rootEnded = true;
        }
        throw error;
      } finally {
        if (!completed) await iterator?.return?.();
        if (!chatEnded) chatSpan.end();
        if (!rootEnded) rootSpan.end();
      }
    },
    captureContent,
  );
}

export const vercelMessages = (
  configKey: string,
  userInput: string,
  context: LDContext,
  {
    captureContent,
    model,
    modelFactory,
    variables,
    ...options
  }: Omit<Parameters<typeof config>[0], 'handler' | 'key'> &
    VercelMessagesOptions & { variables?: Record<string, unknown> } = {},
) =>
  config({
    ...options,
    key: configKey,
    handler: createVercelMessagesHandler({ captureContent, model, modelFactory }),
  }).invoke(userInput, context, variables);
