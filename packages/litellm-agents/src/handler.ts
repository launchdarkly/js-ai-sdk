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
  type ToolHandlerFn,
} from '@launchdarkly/ai-server';
import type { JsonSchemaDefinition, ModelRequest, ModelResponse, StreamEvent } from '@openai/agents';
import { Agent, type Model, OpenAIChatCompletionsModel, Runner, setTracingDisabled, tool } from '@openai/agents';
import { type Context, context, type Span, SpanStatusCode, trace } from '@opentelemetry/api';
import OpenAI from 'openai';

const TRACER_NAME = '@launchdarkly/ai-litellm-agents';
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

type CompatibleClient = OpenAI;

export interface LiteLLMAgentOptions extends ContentCaptureOptions {
  apiKey?: string;
  baseURL?: string;
  client?: CompatibleClient;
  clientFactory?: (config: AiConfigRep) => CompatibleClient;
}

const proxyApiKey = (apiKey?: string) => (apiKey ?? process.env.LITELLM_API_KEY) || 'not-needed';

function checkedOptions(options: LiteLLMAgentOptions): LiteLLMAgentOptions {
  if (!options.client && !options.clientFactory && !(options.baseURL ?? process.env.LITELLM_BASE_URL)) {
    throw new Error('LiteLLM proxy baseURL is required (pass baseURL or set LITELLM_BASE_URL)');
  }
  return options;
}

export function resolveLiteLLMClient(options: LiteLLMAgentOptions, configRep: AiConfigRep): CompatibleClient {
  if (options.clientFactory) return options.clientFactory(configRep);
  if (options.client) return options.client;
  return new OpenAI({
    apiKey: proxyApiKey(options.apiKey),
    baseURL: options.baseURL ?? process.env.LITELLM_BASE_URL,
  });
}

function modelFor(client: CompatibleClient, configRep: AiConfigRep): Model {
  const original = { ...(configRep.model.parameters ?? {}) } as Record<string, unknown>;
  const parameters = { ...original };
  for (const key of HANDLER_OWNED_MODEL_PARAMETERS) delete parameters[key];
  delete parameters.maxTurns;
  delete parameters.max_turns;
  // The current SDK constructor accepts client + model. Keep the compatibility
  // options argument only when rejecting a colliding model default; this also
  // supports SDK builds that accept per-model defaults in that position.
  return 'model' in original
    ? new OpenAIChatCompletionsModel(client, configRep.model.name, parameters)
    : new OpenAIChatCompletionsModel(client, configRep.model.name);
}

const servingProvider = (configRep: AiConfigRep) => (configRep.provider?.name || 'openai').toLowerCase();

function setIdentity(span: Span, configRep: AiConfigRep): void {
  setModelIdentityAttributes(span, servingProvider(configRep), configRep.model.name, 'litellm');
}

function spanUsage(usage: Record<string, unknown> | undefined) {
  return {
    input: Number(usage?.inputTokens ?? 0),
    output: Number(usage?.outputTokens ?? 0),
    cacheRead: 0,
    cacheCreation: 0,
  };
}

function startModelSpan(configRep: AiConfigRep, parentContext: Context): Span {
  const span = trace.getTracer(TRACER_NAME).startSpan(`chat ${configRep.model.name}`, undefined, parentContext);
  span.setAttribute('gen_ai.operation.name', 'chat');
  setIdentity(span, configRep);
  return span;
}

class SpanningModel implements Model {
  constructor(
    private readonly inner: Model,
    private readonly configRep: AiConfigRep,
    private readonly parentContext: Context,
    private readonly captureContent: boolean,
  ) {}

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    const span = startModelSpan(this.configRep, this.parentContext);
    if (this.captureContent) {
      setInputContentAttributes(span, true, {
        systemInstructions: request.systemInstructions,
        messages:
          typeof request.input === 'string'
            ? [{ role: 'user', parts: [{ type: 'text', content: request.input }] }]
            : [],
      });
    }
    try {
      const response = await this.inner.getResponse(request);
      if (this.captureContent) {
        setOutputContentAttributes(span, true, [
          {
            role: 'assistant',
            parts: [{ type: 'text', content: JSON.stringify(response.output ?? '') }],
          },
        ]);
      }
      span.setAttribute('gen_ai.response.model', this.configRep.model.name);
      setUsageSpanAttributes(span, spanUsage(response.usage as unknown as Record<string, unknown>));
      span.setStatus({ code: SpanStatusCode.OK });
      span.end();
      return response;
    } catch (error) {
      failSpan(span, error);
      throw error;
    }
  }

  getStreamedResponse(request: ModelRequest): AsyncIterable<StreamEvent> {
    const { captureContent, configRep, inner, parentContext } = this;
    return (async function* () {
      const span = startModelSpan(configRep, parentContext);
      if (captureContent) {
        setInputContentAttributes(span, true, {
          systemInstructions: request.systemInstructions,
          messages:
            typeof request.input === 'string'
              ? [{ role: 'user', parts: [{ type: 'text', content: request.input }] }]
              : [],
        });
      }
      const ended = new Set<Span>();
      let usage: Record<string, unknown> | undefined;
      try {
        for await (const event of inner.getStreamedResponse(request)) {
          const terminal = event as { type?: string; response?: { usage?: Record<string, unknown> } };
          if (terminal.type === 'response_done') usage = terminal.response?.usage;
          yield event;
        }
        span.setAttribute('gen_ai.response.model', configRep.model.name);
        setUsageSpanAttributes(span, spanUsage(usage));
        span.setStatus({ code: SpanStatusCode.OK });
        endSpanOnce(span, ended);
      } catch (error) {
        const exception = error instanceof Error ? error : new Error(String(error));
        span.recordException(exception);
        span.setStatus({ code: SpanStatusCode.ERROR, message: exception.message });
        endSpanOnce(span, ended);
        throw error;
      } finally {
        endSpanOnce(span, ended, true);
      }
    })();
  }
}

function fixedProvider(model: Model) {
  return { getModel: async () => model };
}

type ToolCallDetails = {
  toolCall?: {
    callId?: string;
    id?: string;
    name?: string;
    arguments?: unknown;
  };
};

type NamedTool = { name?: string };

type AgentRunUsage = {
  finalOutput?: unknown;
  state?: { usage?: { inputTokens?: number; outputTokens?: number } };
};

type StreamedAgentRun = AgentRunUsage &
  AsyncIterable<{ type?: string; data?: { type?: string; delta?: unknown } }> & {
    cancel?: () => void | Promise<void>;
  };

type AgentEventSink = {
  on: (event: 'agent_tool_start' | 'agent_tool_end', listener: (...args: unknown[]) => void) => unknown;
};

function attachToolSpans(agent: AgentEventSink, parentContext: Context, captureContent: boolean) {
  const spans = new Map<string, Span>();
  const callId = (details: ToolCallDetails | undefined) =>
    details?.toolCall?.callId ?? details?.toolCall?.id ?? details?.toolCall?.name ?? 'tool';
  agent.on('agent_tool_start', (...args: unknown[]) => {
    const sdkTool = args[1] as NamedTool;
    const details = args[2] as ToolCallDetails;
    const id = callId(details);
    const name = sdkTool?.name ?? details?.toolCall?.name ?? 'tool';
    const span = trace.getTracer(TRACER_NAME).startSpan(`execute_tool ${name}`, undefined, parentContext);
    span.setAttribute('gen_ai.operation.name', 'execute_tool');
    span.setAttribute('gen_ai.tool.name', name);
    span.setAttribute('gen_ai.tool.call.id', id);
    setToolCallContentAttributes(span, captureContent, { arguments: details?.toolCall?.arguments });
    spans.set(id, span);
  });
  agent.on('agent_tool_end', (...args: unknown[]) => {
    const result = args[2];
    const details = args[3] as ToolCallDetails;
    const id = callId(details);
    const span = spans.get(id);
    if (!span) return;
    spans.delete(id);
    setToolCallContentAttributes(span, captureContent, { result });
    span.setStatus({ code: SpanStatusCode.OK });
    span.end();
  });
  return {
    close(error: unknown) {
      for (const span of spans.values()) failSpan(span, error);
      spans.clear();
    },
  };
}

function runSettings(configRep: AiConfigRep) {
  const parameters = { ...(configRep.model.parameters ?? {}) } as Record<string, unknown>;
  const rawMaxTurns = parameters.maxTurns ?? parameters.max_turns;
  for (const key of HANDLER_OWNED_MODEL_PARAMETERS) delete parameters[key];
  delete parameters.maxTurns;
  delete parameters.max_turns;
  const maxTurns = Number(rawMaxTurns);
  return {
    modelSettings: parameters,
    runOptions: Number.isFinite(maxTurns) && maxTurns > 0 ? { maxTurns } : {},
  };
}

function buildTools(configTools: Record<string, Tool>, handlers: Record<string, ToolHandlerFn | NativeTool>) {
  return Object.entries(configTools)
    .filter(([name]) => typeof handlers[name] === 'function')
    .map(([name, definition]) =>
      tool({
        name,
        description: definition.description ?? '',
        strict: false,
        parameters: definition.parameters,
        execute: async (args: unknown) => {
          const handler = handlers[name] as unknown as (args: unknown) => unknown;
          return handler(args);
        },
      } as unknown as Parameters<typeof tool>[0]),
    );
}

type RunnerInput =
  | string
  | Array<
      | { role: 'user'; content: Array<{ type: 'input_text'; text: string } | { type: 'input_image'; image: string }> }
      | { role: 'assistant'; content: Array<{ type: 'output_text'; text: string }> }
    >;

function userParts(content: MessageContent) {
  if (typeof content === 'string') return [{ type: 'input_text' as const, text: content }];
  return content.map((block) =>
    block.type === 'text'
      ? { type: 'input_text' as const, text: block.text }
      : { type: 'input_image' as const, image: imageBlockToUrl(block) },
  );
}

function toRunnerItems(turns: Array<{ role: 'user' | 'assistant'; content: MessageContent }>): RunnerInput {
  return turns.map((message) =>
    message.role === 'assistant'
      ? {
          role: 'assistant' as const,
          content: [{ type: 'output_text' as const, text: contentToText(message.content) }],
        }
      : { role: 'user' as const, content: userParts(message.content) },
  );
}

function runnerInput(
  configRep: AiConfigRep,
  userInput: string,
  variables: Record<string, unknown>,
  history?: Message[],
): RunnerInput {
  const configMessages = (configRep.messages ?? [])
    .filter((message) => message.role !== 'system')
    .map((message) => ({
      role: message.role as 'user' | 'assistant',
      content: parseTemplate(message.content, variables),
    }));
  if (history?.length) {
    return toRunnerItems(
      composeHistory({
        configMessages: configRep.instructions ? [] : configMessages,
        history,
        userInput,
      }),
    );
  }
  if (!configRep.instructions && configMessages.length) {
    const turns = [...configMessages];
    if (turns.at(-1)?.role !== 'user') turns.push({ role: 'user', content: userInput });
    return toRunnerItems(turns);
  }
  return userInput;
}

function instructionsFor(configRep: AiConfigRep, variables: Record<string, unknown>): string | undefined {
  if (configRep.instructions) return parseTemplate(configRep.instructions, variables);
  const system = configRep.messages?.filter((message) => message.role === 'system') ?? [];
  return system.length ? parseTemplate(system.map((message) => message.content).join('\n'), variables) : undefined;
}

function jsonSchema(outputFormat: Record<string, unknown>): JsonSchemaDefinition['schema'] {
  const type = outputFormat.type;
  return {
    ...outputFormat,
    type: type === 'json_schema' || type === 'json' || type == null ? 'object' : type,
  } as JsonSchemaDefinition['schema'];
}

function outputType(configRep: AiConfigRep): JsonSchemaDefinition | undefined {
  if (!configRep.outputFormat) return undefined;
  return {
    type: 'json_schema',
    name: 'output',
    schema: jsonSchema(configRep.outputFormat as Record<string, unknown>),
    strict: false,
  };
}

function buildAgent(
  configRep: AiConfigRep,
  client: CompatibleClient,
  handlers: Record<string, ToolHandlerFn | NativeTool>,
  variables: Record<string, unknown>,
  parentContext: Context,
  captureContent: boolean,
  includeOutput = true,
) {
  const tools = configRep.tools ? buildTools(configRep.tools, handlers) : [];
  const instructions = instructionsFor(configRep, variables);
  const model = new SpanningModel(modelFor(client, configRep), configRep, parentContext, captureContent);
  const settings = runSettings(configRep);
  const agent = new Agent({
    name: 'assistant',
    model,
    modelSettings: settings.modelSettings as unknown as NonNullable<
      ConstructorParameters<typeof Agent>[0]
    >['modelSettings'],
    ...(instructions ? { instructions } : {}),
    ...(tools.length ? { tools } : {}),
    ...(includeOutput && configRep.outputFormat ? { outputType: outputType(configRep) } : {}),
  });
  return { agent, model, instructions, runOptions: settings.runOptions };
}

function usageOf(result: AgentRunUsage) {
  return {
    input_tokens: Number(result?.state?.usage?.inputTokens ?? 0),
    output_tokens: Number(result?.state?.usage?.outputTokens ?? 0),
  };
}

function failSpan(span: Span, error: unknown): void {
  const exception = error instanceof Error ? error : new Error(String(error));
  span.recordException(exception);
  span.setStatus({ code: SpanStatusCode.ERROR, message: exception.message });
  span.end();
}

function setCapturedInput(span: Span, capture: boolean, input: RunnerInput, instructions?: string): void {
  if (!capture) return;
  if (instructions) span.setAttribute('gen_ai.prompt.0.content', instructions);
  const text = typeof input === 'string' ? input : JSON.stringify(input);
  span.setAttribute('gen_ai.prompt.1.content', text);
}

export function createLiteLLMAgentHandler(options: LiteLLMAgentOptions = {}): ProviderHandler {
  const resolvedOptions = checkedOptions(options);
  const captureContent = resolvedOptions.captureContent ?? false;
  setTracingDisabled(true);

  return createHandler(
    ['*', 'agent'],
    async (
      configRep: AiConfigRep,
      userInput = '',
      toolHandlers: Record<string, ToolHandlerFn | NativeTool> = {},
      variables: Record<string, unknown> = {},
      history?: Message[],
    ) =>
      trace.getTracer(TRACER_NAME).startActiveSpan('invoke_agent', async (span) => {
        span.setAttribute('gen_ai.operation.name', 'invoke_agent');
        setIdentity(span, configRep);
        setLdSpanAttributes(span, variables);
        const parentContext = trace.setSpan(context.active(), span);
        const client = resolveLiteLLMClient(resolvedOptions, configRep);
        const { agent, model, instructions, runOptions } = buildAgent(
          configRep,
          client,
          toolHandlers,
          variables,
          parentContext,
          captureContent,
        );
        const input = runnerInput(configRep, userInput, variables, history);
        setCapturedInput(span, captureContent, input, instructions);
        const runner = new Runner({ modelProvider: fixedProvider(model) });
        const toolSpans = attachToolSpans(agent as unknown as AgentEventSink, parentContext, captureContent);

        try {
          const result =
            Object.keys(runOptions).length > 0
              ? await runner.run(agent, input as unknown as string, runOptions)
              : await runner.run(agent, input as unknown as string);
          const finalOutput = result.finalOutput ?? '';
          const usage = usageOf(result);
          if (captureContent) span.setAttribute('gen_ai.completion.0.content', String(finalOutput));
          span.setAttribute('gen_ai.response.model', configRep.model.name);
          setUsageSpanAttributes(span, {
            input: usage.input_tokens,
            output: usage.output_tokens,
            cacheRead: 0,
            cacheCreation: 0,
          });
          span.setStatus({ code: SpanStatusCode.OK });
          span.end();
          return { output: configRep.outputFormat ? finalOutput : String(finalOutput), usage };
        } catch (error) {
          toolSpans.close(error);
          failSpan(span, error);
          throw error;
        }
      }),
    async function* streamHandler(
      configRep: AiConfigRep,
      userInput = '',
      toolHandlers: Record<string, ToolHandlerFn | NativeTool> = {},
      variables: Record<string, unknown> = {},
      history?: Message[],
    ) {
      const span = trace.getTracer(TRACER_NAME).startSpan('invoke_agent');
      span.setAttribute('gen_ai.operation.name', 'invoke_agent');
      setIdentity(span, configRep);
      setLdSpanAttributes(span, variables);
      const parentContext = trace.setSpan(context.active(), span);
      const client = resolveLiteLLMClient(resolvedOptions, configRep);
      const { agent, model, instructions, runOptions } = buildAgent(
        configRep,
        client,
        toolHandlers,
        variables,
        parentContext,
        captureContent,
        false,
      );
      const input = runnerInput(configRep, userInput, variables, history);
      setCapturedInput(span, captureContent, input, instructions);
      const runner = new Runner({ modelProvider: fixedProvider(model) });
      const toolSpans = attachToolSpans(agent as unknown as AgentEventSink, parentContext, captureContent);
      let run: StreamedAgentRun | undefined;
      let completed = false;

      try {
        run = (await runner.run(agent, input as unknown as string, {
          ...runOptions,
          stream: true,
        })) as unknown as StreamedAgentRun;
        let streamedOutput = '';
        for await (const event of run) {
          const data = event?.type === 'raw_model_stream_event' ? event.data : undefined;
          if (data?.type === 'response.output_text.delta' && typeof data.delta === 'string') {
            streamedOutput += data.delta;
            yield { type: 'chunk' as const, text: data.delta };
          }
        }
        const finalOutput = run.finalOutput;
        const output =
          typeof finalOutput === 'string'
            ? finalOutput
            : finalOutput == null
              ? streamedOutput
              : JSON.stringify(finalOutput);
        const usage = usageOf(run);
        if (captureContent) span.setAttribute('gen_ai.completion.0.content', output);
        span.setAttribute('gen_ai.response.model', configRep.model.name);
        setUsageSpanAttributes(span, {
          input: usage.input_tokens,
          output: usage.output_tokens,
          cacheRead: 0,
          cacheCreation: 0,
        });
        span.setStatus({ code: SpanStatusCode.OK });
        span.end();
        completed = true;
        yield { type: 'done' as const, output, usage };
      } catch (error) {
        toolSpans.close(error);
        failSpan(span, error);
        completed = true;
        throw error;
      } finally {
        if (!completed) {
          await run?.cancel?.();
          toolSpans.close(new Error('stream abandoned before completion'));
          span.setAttribute('launchdarkly.stream.abandoned', true);
          span.end();
        }
      }
    },
    captureContent,
  );
}

export const litellmAgents = (
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
    LiteLLMAgentOptions & { variables?: Record<string, unknown> } = {},
) =>
  config({
    ...options,
    key: configKey,
    handler: createLiteLLMAgentHandler({ apiKey, baseURL, captureContent, client, clientFactory }),
  }).invoke(userInput, context, variables);
