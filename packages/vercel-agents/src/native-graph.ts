import {
  composeHistory,
  type GraphDefinition,
  type GraphNode,
  getClient,
  type LDContext,
  type Message,
  type MessageContent,
  makeNodeTrackData,
  type NativeTool,
  type ProviderGraphResponse,
  parseTemplate,
  type ToolHandlerFn,
} from '@launchdarkly/ai-server';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import { jsonSchema, type LanguageModel, type ModelMessage, stepCountIs, ToolLoopAgent, type ToolSet, tool } from 'ai';
import type { VercelAgentsOptions } from './handler.js';
import { gatewayModelId } from './model-id.js';

const TRACER_NAME = '@launchdarkly/ai-vercel-agents';
const MAX_STEPS = 10;
const OWNED_PARAMETER_NAMES = new Set([
  'model',
  'messages',
  'prompt',
  'system',
  'instructions',
  'tools',
  'stream',
  'output',
  'outputformat',
  'stopwhen',
  'maxsteps',
  'apikey',
  'baseurl',
]);

export interface VercelNativeGraphOptions extends VercelAgentsOptions {
  toolHandlers?: Record<string, ToolHandlerFn | NativeTool>;
  context?: LDContext;
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

function modelSettings(node: GraphNode): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(node.config.model.parameters ?? {}).filter(([key]) => {
      const normalized = key.replaceAll('_', '').replaceAll('-', '').toLowerCase();
      return !OWNED_PARAMETER_NAMES.has(normalized);
    }),
  );
}

async function resolveModel(node: GraphNode, options: VercelNativeGraphOptions): Promise<LanguageModel | string> {
  if (options.modelFactory) return options.modelFactory(node.config);
  if (options.model) return options.model;
  return gatewayModelId(node.config);
}

function nodeInstructions(node: GraphNode, variables: Record<string, unknown>): string | undefined {
  if (node.config.instructions) return parseTemplate(node.config.instructions, variables);
  const system = (node.config.messages ?? []).filter((message) => message.role === 'system');
  return system.length > 0 ? parseTemplate(system.map((message) => message.content).join('\n'), variables) : undefined;
}

function toAiContent(content: MessageContent): ModelMessage['content'] {
  if (typeof content === 'string') return content;
  return content.map((block) => {
    if (block.type === 'text') return { type: 'text' as const, text: block.text };
    if (block.source.type === 'url') return { type: 'image' as const, image: new URL(block.source.url) };
    return {
      type: 'image' as const,
      image: Uint8Array.from(Buffer.from(block.source.data, 'base64')),
      mediaType: block.source.media_type,
    };
  });
}

function rootMessages(input: string, history?: Message[]): ModelMessage[] {
  if (!history?.length) return [{ role: 'user', content: input }];
  return composeHistory({ history, userInput: input }).map(
    (turn) => ({ role: turn.role, content: toAiContent(turn.content) }) as ModelMessage,
  );
}

function trackNodeUsage(
  node: GraphNode,
  graphKey: string,
  runId: string,
  context: LDContext | undefined,
  duration: number,
  usage: Usage,
): void {
  if (!context) return;
  const trackData = makeNodeTrackData(node, graphKey, runId);
  const client = getClient();
  client.track('$ld:ai:duration:total', context, trackData, duration);
  client.track('$ld:ai:generation:success', context, trackData, 1);
  client.track('$ld:ai:tokens:input', context, trackData, usage.input);
  client.track('$ld:ai:tokens:output', context, trackData, usage.output);
  client.track('$ld:ai:tokens:total', context, trackData, usage.total);
}

export const toVercelAgents = (
  definition: Promise<GraphDefinition>,
  options: VercelNativeGraphOptions = {},
): {
  invoke: (input?: string, variables?: Record<string, unknown>, history?: Message[]) => Promise<ProviderGraphResponse>;
} => ({
  invoke: async (input = '', variables = {}, history) => {
    const def = await definition;
    if (!def.enabled) throw new Error(`Agent graph "${def.key}" is disabled`);
    if (!def.root) throw new Error(`Graph "${def.key}" has no root node`);
    const root = def.root;

    return trace.getTracer(TRACER_NAME).startActiveSpan('ld.ai.graph', async (span) => {
      span.setAttribute('ld.ai.graph.key', def.key);
      const startedAt = Date.now();
      const runId = crypto.randomUUID();
      const context = options.context;
      const handlers = options.toolHandlers ?? {};
      const selectedTargets = new Map<string, string>();
      const nodes = new Map<string, GraphNode>();
      const agents = new Map<string, ToolLoopAgent>();
      const path: string[] = [];

      try {
        await def.traverse(async (node) => {
          nodes.set(node.key, node);
          const regularTools = Object.entries(node.config.tools ?? {}).filter(
            ([name]) => typeof handlers[name] === 'function',
          );
          const tools: ToolSet = Object.fromEntries(
            regularTools.map(([name, definition]) => [
              name,
              tool({
                description: definition.description ?? '',
                inputSchema: jsonSchema(definition.parameters),
                execute: async (args) => (handlers[name] as (...args: unknown[]) => unknown)(args),
              }),
            ]),
          );

          for (const edge of def.edgesFrom(node.key)) {
            const handoffName = `transfer_to_${edge.targetKey}`;
            tools[handoffName] = tool({
              description:
                typeof edge.handoff?.description === 'string'
                  ? edge.handoff.description
                  : `Transfer the conversation to ${edge.targetKey}`,
              inputSchema: jsonSchema({ type: 'object', properties: {}, additionalProperties: false }),
              execute: async () => {
                selectedTargets.set(node.key, edge.targetKey);
                if (context) {
                  getClient().track(
                    '$ld:ai:graph:handoff_success',
                    context,
                    makeNodeTrackData(node, def.key, runId),
                    1,
                  );
                }
                return { target: edge.targetKey };
              },
            });
          }

          agents.set(
            node.key,
            new ToolLoopAgent({
              ...modelSettings(node),
              model: await resolveModel(node, options),
              ...(nodeInstructions(node, variables) ? { instructions: nodeInstructions(node, variables) } : {}),
              ...(Object.keys(tools).length > 0 ? { tools } : {}),
              stopWhen: stepCountIs(MAX_STEPS),
            }),
          );
        });

        let current: GraphNode = root;
        let messages = rootMessages(input, history);
        const total: Usage = { input: 0, output: 0, total: 0 };
        let response = '';
        const visited = new Set<string>();

        while (current && !visited.has(current.key)) {
          visited.add(current.key);
          path.push(current.key);
          const agent = agents.get(current.key);
          if (!agent) throw new Error(`Vercel agent "${current.key}" was not built`);
          selectedTargets.delete(current.key);
          const nodeStartedAt = Date.now();
          const result = await agent.generate({ messages });
          const usage = normalizeUsage(result.usage);
          total.input += usage.input;
          total.output += usage.output;
          total.total += usage.total;
          response = result.text;
          trackNodeUsage(current, def.key, runId, context, Date.now() - nodeStartedAt, usage);

          const target = selectedTargets.get(current.key);
          if (!target || visited.has(target)) break;
          const next = nodes.get(target) ?? def.getNode(target);
          if (!next) throw new Error(`Handoff target "${target}" was not found in graph "${def.key}"`);
          current = next;
          messages = [{ role: 'user', content: response }];
        }

        span.setAttribute('ld.ai.graph.path', path.join(','));
        span.setAttribute('gen_ai.usage.input_tokens', total.input);
        span.setAttribute('gen_ai.usage.output_tokens', total.output);
        span.setAttribute('gen_ai.usage.total_tokens', total.total);

        if (context) {
          const trackData = makeNodeTrackData(root, def.key, runId);
          const client = getClient();
          client.track('$ld:ai:graph:duration:total', context, trackData, Date.now() - startedAt);
          client.track('$ld:ai:graph:total_tokens', context, trackData, total.total);
          client.track('$ld:ai:graph:path', context, trackData, path.length);
          client.track('$ld:ai:graph:invocation_success', context, trackData, 1);
        }
        span.setStatus({ code: SpanStatusCode.OK });
        return { response, usage: total };
      } catch (error) {
        const exception = error instanceof Error ? error : new Error(String(error));
        span.recordException(exception);
        span.setStatus({ code: SpanStatusCode.ERROR, message: exception.message });
        if (context) {
          getClient().track('$ld:ai:graph:invocation_failure', context, makeNodeTrackData(root, def.key, runId), 1);
        }
        throw error;
      } finally {
        span.end();
      }
    });
  },
});
