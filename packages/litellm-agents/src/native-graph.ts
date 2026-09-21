import {
  composeHistory,
  contentToText,
  type GraphDefinition,
  type GraphNode,
  imageBlockToUrl,
  type Message,
  type MessageContent,
  type NativeTool,
  type ProviderGraphResponse,
  parseTemplate,
  type ToolHandlerFn,
} from '@launchdarkly/ai-server';
import {
  Agent,
  handoff,
  type Model,
  OpenAIChatCompletionsModel,
  Runner,
  setTracingDisabled,
  tool,
} from '@openai/agents';
import OpenAI from 'openai';
import type { LiteLLMAgentOptions } from './handler.js';

type AgentConfig = ConstructorParameters<typeof Agent>[0];
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

export interface LiteLLMNativeGraphOptions extends LiteLLMAgentOptions {
  toolHandlers?: Record<string, ToolHandlerFn | NativeTool>;
}

const sanitizeName = (name: string) => name.replace(/[^a-z0-9_-]/gi, '_').slice(0, 64);

function instructionsFor(node: GraphNode, variables: Record<string, unknown>): string | undefined {
  if (node.config.instructions) return parseTemplate(node.config.instructions, variables);
  const system = node.config.messages?.filter((message) => message.role === 'system') ?? [];
  return system.length ? parseTemplate(system.map((message) => message.content).join('\n'), variables) : undefined;
}

function buildTools(node: GraphNode, handlers: Record<string, ToolHandlerFn | NativeTool>) {
  if (!node.config.tools) return [];
  return Object.entries(node.config.tools)
    .filter(([name]) => typeof handlers[name] === 'function')
    .map(([name, definition]) =>
      tool({
        name,
        description: definition.description ?? '',
        strict: false,
        parameters: definition.parameters,
        execute: async (args: unknown) => (handlers[name] as unknown as (args: unknown) => unknown)(args),
      } as unknown as Parameters<typeof tool>[0]),
    );
}

function resolveClient(options: LiteLLMNativeGraphOptions, root: GraphNode): OpenAI {
  if (options.clientFactory) return options.clientFactory(root.config);
  if (options.client) return options.client;
  const baseURL = options.baseURL ?? process.env.LITELLM_BASE_URL;
  if (!baseURL) throw new Error('LiteLLM proxy baseURL is required (pass baseURL or set LITELLM_BASE_URL)');
  const apiKey = (options.apiKey ?? process.env.LITELLM_API_KEY) || 'not-needed';
  return new OpenAI({ apiKey, baseURL });
}

function modelFor(client: OpenAI, node: GraphNode) {
  return new OpenAIChatCompletionsModel(client, node.config.model.name);
}

function nodeSettings(node: GraphNode) {
  const parameters = { ...(node.config.model.parameters ?? {}) } as Record<string, unknown>;
  for (const key of HANDLER_OWNED_MODEL_PARAMETERS) delete parameters[key];
  delete parameters.maxTurns;
  delete parameters.max_turns;
  return parameters;
}

function userParts(content: MessageContent) {
  if (typeof content === 'string') return [{ type: 'input_text' as const, text: content }];
  return content.map((block) =>
    block.type === 'text'
      ? { type: 'input_text' as const, text: block.text }
      : { type: 'input_image' as const, image: imageBlockToUrl(block) },
  );
}

function buildInput(input: string, root: GraphNode, variables: Record<string, unknown>, history?: Message[]) {
  if (!history?.length) return input;
  const configMessages = root.config.instructions
    ? []
    : (root.config.messages ?? [])
        .filter((message) => message.role !== 'system')
        .map((message) => ({
          role: message.role as 'user' | 'assistant',
          content: parseTemplate(message.content, variables),
        }));
  return composeHistory({ configMessages, history, userInput: input }).map((message) =>
    message.role === 'assistant'
      ? {
          role: 'assistant' as const,
          content: [{ type: 'output_text' as const, text: contentToText(message.content) }],
        }
      : { role: 'user' as const, content: userParts(message.content) },
  );
}

/**
 * Converts a resolved LaunchDarkly graph into OpenAI Agents SDK handoffs while
 * binding every node model to the same user-owned LiteLLM proxy client.
 */
export const toLiteLLMAgents = (
  definition: Promise<GraphDefinition>,
  options: LiteLLMNativeGraphOptions = {},
): {
  invoke: (input?: string, variables?: Record<string, unknown>, history?: Message[]) => Promise<ProviderGraphResponse>;
} => ({
  invoke: async (input = '', variables = {}, history) => {
    const graph = await definition;
    if (!graph.enabled) throw new Error(`LiteLLM agent graph "${graph.key}" is disabled`);
    if (!graph.root) throw new Error(`LiteLLM agent graph "${graph.key}" has no root node`);

    setTracingDisabled(true);
    const client = resolveClient(options, graph.root);
    const agents: Record<string, Agent> = {};
    const models: Record<string, Model> = {};

    await graph.reverseTraverse(async (node, context) => {
      const childHandoffs = node.edges.map((edge) => {
        const child = agents[edge.targetKey];
        if (!child) throw new Error(`Child agent "${edge.targetKey}" was not built`);
        return handoff(child);
      });
      const model = modelFor(client, node);
      models[node.key] = model;
      const instructions = instructionsFor(node, variables);
      const nodeTools = buildTools(node, options.toolHandlers ?? {});
      const agent = new Agent({
        name: sanitizeName(node.key),
        model,
        modelSettings: nodeSettings(node) as unknown as AgentConfig['modelSettings'],
        handoffs: childHandoffs,
        ...(instructions ? { instructions } : {}),
        ...(nodeTools.length ? { tools: nodeTools } : {}),
      });
      agents[node.key] = agent;
      context[node.key] = agent;
    });

    const rootAgent = agents[graph.root.key];
    if (!rootAgent) throw new Error(`Root agent "${graph.root.key}" was not built`);
    const rootModel = models[graph.root.key];
    if (!rootModel) throw new Error(`Root model "${graph.root.key}" was not built`);
    const runner = new Runner({ modelProvider: { getModel: async () => rootModel } });
    const runnerInput = buildInput(input, graph.root, variables, history);
    const result = await runner.run(rootAgent, runnerInput as unknown as string);
    const response =
      typeof result.finalOutput === 'string'
        ? result.finalOutput
        : result.finalOutput == null
          ? ''
          : JSON.stringify(result.finalOutput);
    const inputTokens = Number(result.state.usage.inputTokens ?? 0);
    const outputTokens = Number(result.state.usage.outputTokens ?? 0);
    return {
      response,
      usage: {
        input: inputTokens,
        output: outputTokens,
        total: Number(result.state.usage.totalTokens ?? inputTokens + outputTokens),
      },
    };
  },
});
