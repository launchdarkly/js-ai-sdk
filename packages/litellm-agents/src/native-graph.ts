import {
  composeHistory,
  contentToText,
  type GraphDefinition,
  type GraphNode,
  getClient,
  imageBlockToUrl,
  type LDContext,
  type Message,
  type MessageContent,
  makeNodeTrackData,
  type NativeTool,
  type ProviderGraphResponse,
  parseTemplate,
  type ToolHandlerFn,
} from '@launchdarkly/ai-server';
import { Agent, handoff, type Model, OpenAIChatCompletionsModel, Runner, tool } from '@openai/agents';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import OpenAI from 'openai';
import { agentRunSettings, type LiteLLMAgentsOptions } from './handler.js';

type AgentConfig = ConstructorParameters<typeof Agent>[0];

export interface LiteLLMNativeGraphOptions extends LiteLLMAgentsOptions {
  toolHandlers?: Record<string, ToolHandlerFn | NativeTool>;
  /** LaunchDarkly context used for tracking events. Required for LD telemetry. */
  context?: LDContext;
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
    const root = graph.root;
    if (!root) throw new Error(`LiteLLM agent graph "${graph.key}" has no root node`);

    const client = resolveClient(options, root);
    const agents: Record<string, Agent> = {};
    const models: Record<string, Model> = {};
    const ldContext = options.context;

    return trace.getTracer('@launchdarkly/ai-litellm-agents').startActiveSpan('launchdarkly.graph', async (span) => {
      span.setAttribute('launchdarkly.graph.key', graph.key);
      const startTime = Date.now();
      const runId = crypto.randomUUID();
      const path: string[] = [];
      const agentNameToKey = new Map<string, string>();

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
        const agentName = sanitizeName(node.key);
        agentNameToKey.set(agentName, node.key);
        const { modelSettings } = agentRunSettings(node.config.model.parameters as Record<string, unknown> | undefined);
        const agent = new Agent({
          name: agentName,
          model,
          modelSettings: modelSettings as unknown as AgentConfig['modelSettings'],
          handoffs: childHandoffs,
          ...(instructions ? { instructions } : {}),
          ...(nodeTools.length ? { tools: nodeTools } : {}),
        });
        agents[node.key] = agent;
        context[node.key] = agent;
      });

      const rootAgent = agents[root.key];
      if (!rootAgent) throw new Error(`Root agent "${root.key}" was not built`);
      const rootModel = models[root.key];
      if (!rootModel) throw new Error(`Root model "${root.key}" was not built`);
      const runner = new Runner({ modelProvider: { getModel: async () => rootModel }, tracingDisabled: true });
      runner.on('agent_start', (_runCtx: unknown, agent: { name: string }) => {
        const nodeKey = agentNameToKey.get(agent.name);
        if (!nodeKey || path.includes(nodeKey)) return;
        const index = path.length;
        path.push(nodeKey);
        if (!ldContext) return;
        const node = graph.getNode(nodeKey);
        if (!node) return;
        getClient().track(
          '$ld:ai:graph:node',
          ldContext,
          { ...makeNodeTrackData(node, graph.key, runId), nodeKey, index },
          1,
        );
      });
      runner.on('agent_end', (_runCtx: unknown, agent: { name: string }) => {
        if (!ldContext) return;
        const nodeKey = agentNameToKey.get(agent.name);
        const node = nodeKey ? graph.getNode(nodeKey) : undefined;
        if (node)
          getClient().track('$ld:ai:generation:success', ldContext, makeNodeTrackData(node, graph.key, runId), 1);
      });
      runner.on('agent_handoff', (_runCtx: unknown, fromAgent: { name: string }) => {
        if (!ldContext) return;
        const fromKey = agentNameToKey.get(fromAgent.name);
        const fromNode = fromKey ? graph.getNode(fromKey) : undefined;
        if (fromNode)
          getClient().track(
            '$ld:ai:graph:handoff_success',
            ldContext,
            makeNodeTrackData(fromNode, graph.key, runId),
            1,
          );
      });
      const runnerInput = buildInput(input, root, variables, history);
      const rootMaxTurns = agentRunSettings(
        root.config.model.parameters as Record<string, unknown> | undefined,
      ).runOptions;
      const runInput = runnerInput as unknown as string;
      let result: {
        finalOutput?: unknown;
        state: { usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } };
      };
      try {
        result = (
          'maxTurns' in rootMaxTurns
            ? await runner.run(rootAgent, runInput, rootMaxTurns)
            : await runner.run(rootAgent, runInput)
        ) as typeof result;
        span.setStatus({ code: SpanStatusCode.OK });
      } catch (error) {
        span.recordException(error instanceof Error ? error : new Error(String(error)));
        span.setStatus({ code: SpanStatusCode.ERROR, message: String(error) });
        if (ldContext) {
          getClient().track('$ld:ai:graph:invocation_failure', ldContext, makeNodeTrackData(root, graph.key, runId), 1);
        }
        span.end();
        throw error;
      }
      const response =
        typeof result.finalOutput === 'string'
          ? result.finalOutput
          : result.finalOutput == null
            ? ''
            : JSON.stringify(result.finalOutput);
      const inputTokens = Number(result.state.usage.inputTokens ?? 0);
      const outputTokens = Number(result.state.usage.outputTokens ?? 0);
      const totalTokens = Number(result.state.usage.totalTokens ?? inputTokens + outputTokens);
      span.setAttribute('launchdarkly.graph.path', path.join('->'));
      span.setAttribute('gen_ai.usage.input_tokens', inputTokens);
      span.setAttribute('gen_ai.usage.output_tokens', outputTokens);
      span.setAttribute('gen_ai.usage.total_tokens', totalTokens);
      if (ldContext) {
        const rootTrackData = makeNodeTrackData(root, graph.key, runId);
        getClient().track('$ld:ai:graph:duration:total', ldContext, rootTrackData, Date.now() - startTime);
        getClient().track('$ld:ai:graph:total_tokens', ldContext, rootTrackData, totalTokens);
        getClient().track('$ld:ai:graph:invocation_success', ldContext, rootTrackData, 1);
      }
      span.end();
      return {
        response,
        usage: { input: inputTokens, output: outputTokens, total: totalTokens },
      };
    });
  },
});
