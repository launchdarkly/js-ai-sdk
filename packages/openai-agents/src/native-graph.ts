import type { LDContext } from '@launchdarkly/ai-server';
import {
  composeHistory,
  contentToText,
  type GraphDefinition,
  type GraphNode,
  getClient,
  imageBlockToUrl,
  type Message,
  type MessageContent,
  type NativeTool,
  type ProviderGraphResponse,
  parseTemplate,
  type ToolHandlerFn,
  type TrackData,
} from '@launchdarkly/ai-server';
import { Agent, handoff, Runner, tool } from '@openai/agents';
import { SpanStatusCode, trace } from '@opentelemetry/api';

// ─── helpers ─────────────────────────────────────────────────────────────────

const sanitizeName = (key: string) => key.replace(/[^a-z0-9_-]/gi, '_').slice(0, 64);

const buildInstructions = (node: GraphNode, variables: Record<string, unknown>): string | undefined => {
  if (node.config.instructions) {
    return parseTemplate(node.config.instructions, variables);
  }
  if (node.config.messages) {
    const sys = node.config.messages.filter((m) => m.role === 'system');
    if (sys.length > 0) {
      return parseTemplate(sys.map((m) => m.content).join('\n'), variables);
    }
  }
  return undefined;
};

const buildNodeTools = (node: GraphNode, toolHandlers: Record<string, ToolHandlerFn | NativeTool>) => {
  if (!node.config.tools) return [];
  return Object.entries(node.config.tools).map(([name, toolConfig]) =>
    tool({
      name,
      description: toolConfig.description ?? '',
      strict: false,
      // biome-ignore lint/suspicious/noExplicitAny: OpenAI Agents SDK tool parameters type does not accept Record<string, unknown>
      parameters: toolConfig.parameters as any,
      execute: async (args) => {
        const handler = toolHandlers[name];
        if (!handler || (handler instanceof Object && 'id' in handler)) {
          // NativeTool — native to provider; return empty
          return '';
        }
        const result = await (handler as (...args: unknown[]) => unknown)(args);
        return String(result);
      },
    }),
  );
};

// The Agents SDK names the image source `image` (URL / data URL), unlike the raw
// Responses API's `image_url`; using `image_url` here makes the SDK drop it.
// Assistant turns need an `output_text` part array, not a bare string.
type OpenAIUserContentPart = { type: 'input_text'; text: string } | { type: 'input_image'; image: string };
type OpenAIInputItem =
  | { role: 'user'; content: OpenAIUserContentPart[] }
  | { role: 'assistant'; content: Array<{ type: 'output_text'; text: string }> };

/** Maps composed history + userInput into the Agents-SDK input item list. */
const toRunnerInput = (history: Message[], userInput: string): OpenAIInputItem[] =>
  composeHistory({ history, userInput }).map((turn) =>
    turn.role === 'assistant'
      ? { role: 'assistant', content: [{ type: 'output_text', text: contentToText(turn.content) }] }
      : { role: 'user', content: toUserContentParts(turn.content) },
  );

const toUserContentParts = (content: MessageContent): OpenAIUserContentPart[] => {
  if (typeof content === 'string') return [{ type: 'input_text', text: content }];
  return content.map((block) =>
    block.type === 'text'
      ? { type: 'input_text' as const, text: block.text }
      : { type: 'input_image' as const, image: imageBlockToUrl(block) },
  );
};

const makeNodeTrackData = (node: GraphNode, graphKey: string, runId: string): TrackData => ({
  runId,
  configKey: node.key,
  variationKey: node.meta.variationKey ?? '',
  version: node.meta.version ?? 1,
  modelName: node.config.model.name,
  providerName: node.config.provider.name,
  graphKey,
});

// ─── toOpenAIAgents ───────────────────────────────────────────────────────────

/**
 * Converts a resolved `GraphDefinition` into an OpenAI Agents SDK agent tree
 * and returns a caller that runs the graph natively via `Runner.run`.
 *
 * @example
 * ```ts
 * import { resolveGraph } from '@launchdarkly/ai-server';
 * import { toOpenAIAgents } from '@launchdarkly/ai-openai-agents';
 *
 * const result = await toOpenAIAgents(
 *   resolveGraph('support-graph', { context }),
 *   { toolHandlers: registry.tools, context }
 * ).invoke('I was double charged');
 * ```
 */
export const toOpenAIAgents = (
  defPromise: Promise<GraphDefinition>,
  opts?: {
    toolHandlers?: Record<string, ToolHandlerFn | NativeTool>;
    /** LaunchDarkly context used for tracking events. Required for LD telemetry. */
    context?: LDContext;
  },
): {
  invoke: (input?: string, variables?: Record<string, unknown>, history?: Message[]) => Promise<ProviderGraphResponse>;
} => {
  const invoke = async (
    input = '',
    variables: Record<string, unknown> = {},
    history?: Message[],
  ): Promise<ProviderGraphResponse> => {
    const def = await defPromise;
    if (!def.enabled) {
      throw new Error(`Agent graph "${def.key}" is disabled`);
    }
    if (!def.root) {
      throw new Error(`Graph "${def.key}" has no root node`);
    }

    const toolHandlers = opts?.toolHandlers ?? {};
    const ldContext = opts?.context;

    return trace.getTracer('@launchdarkly/ai-openai-agents').startActiveSpan('ld.ai.graph', async (span) => {
      span.setAttribute('ld.ai.graph.key', def.key);
      const startTime = Date.now();
      const runId = crypto.randomUUID();

      const path: string[] = [];
      // Map from sanitized agent name → original node key (for hook callbacks)
      const agentNameToKey = new Map<string, string>();
      // Built Agent instances, keyed by node key
      const agentCtx: Record<string, Agent> = {};

      // Build leaves → root so children exist before parents reference them as handoffs
      await def.reverseTraverse<void>(async (node, ctx) => {
        const childHandoffs = node.edges.map((edge) => {
          const childAgent = agentCtx[edge.targetKey];
          if (!childAgent) {
            throw new Error(`Child agent "${edge.targetKey}" was not built before parent "${node.key}"`);
          }
          return handoff(childAgent);
        });

        const instructions = buildInstructions(node, variables);
        const tools = buildNodeTools(node, toolHandlers);
        const agentName = sanitizeName(node.key);
        agentNameToKey.set(agentName, node.key);

        const agent = new Agent({
          name: agentName,
          model: node.config.model.name,
          ...(instructions ? { instructions } : {}),
          ...(tools.length > 0 ? { tools } : {}),
          ...(childHandoffs.length > 0 ? { handoffs: childHandoffs } : {}),
        });

        agentCtx[node.key] = agent;
        ctx[node.key] = agent;
      });

      const root = def.root;
      if (!root) throw new Error(`Graph "${def.key}" has no root node`);

      const rootAgent = agentCtx[root.key];
      if (!rootAgent) {
        throw new Error(`Root agent "${root.key}" was not built`);
      }

      // Attach run-level lifecycle hooks for LD tracking
      const runner = new Runner();

      runner.on('agent_start', (_runCtx: unknown, agent: { name: string }) => {
        const nodeKey = agentNameToKey.get(agent.name);
        if (nodeKey && !path.includes(nodeKey)) {
          path.push(nodeKey);
        }
      });

      runner.on('agent_end', (_runCtx: unknown, agent: { name: string }, _output: string) => {
        const nodeKey = agentNameToKey.get(agent.name);
        if (!nodeKey) return;
        if (ldContext) {
          const node = def.getNode(nodeKey);
          if (node) {
            const trackData = makeNodeTrackData(node, def.key, runId);
            getClient().track('$ld:ai:generation:success', ldContext, trackData, 1);
          }
        }
      });

      runner.on('agent_handoff', (_runCtx: unknown, fromAgent: { name: string }, toAgent: { name: string }) => {
        if (!ldContext) return;
        const fromKey = agentNameToKey.get(fromAgent.name);
        if (fromKey) {
          const fromNode = def.getNode(fromKey);
          if (fromNode) {
            const trackData = makeNodeTrackData(fromNode, def.key, runId);
            getClient().track('$ld:ai:graph:handoff_success', ldContext, trackData, 1);
          }
        }
        // Ensure the target node appears in path if agent_start doesn't fire for it
        const toKey = agentNameToKey.get(toAgent.name);
        if (toKey && !path.includes(toKey)) {
          path.push(toKey);
        }
      });

      // History is a root-only concern: it seeds the entry agent's input via the
      // framework-native item list. Downstream agents are reached through
      // handoffs and receive their context from the Runner, not from `history`.
      const rootInput = history && history.length > 0 ? toRunnerInput(history, input) : input;

      // biome-ignore lint/suspicious/noImplicitAnyLet: assigned immediately in try; catch always re-throws
      let result;
      try {
        // biome-ignore lint/suspicious/noExplicitAny: Runner.run accepts string | AgentInputItem[]; our item shape is structurally compatible
        result = await runner.run(rootAgent, rootInput as any);
        span.setStatus({ code: SpanStatusCode.OK });
      } catch (err) {
        span.recordException(err instanceof Error ? err : new Error(String(err)));
        span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
        if (ldContext) {
          const trackData = makeNodeTrackData(root, def.key, runId);
          getClient().track('$ld:ai:graph:invocation_failure', ldContext, trackData, 1);
        }
        span.end();
        throw err;
      }

      const finalOutput = String(result.finalOutput ?? '');
      const usage = result.state.usage;
      const inputTokens = usage.inputTokens ?? 0;
      const outputTokens = usage.outputTokens ?? 0;
      const totalTokens = usage.totalTokens ?? inputTokens + outputTokens;

      const totalUsage = { input: inputTokens, output: outputTokens, total: totalTokens };
      const duration = Date.now() - startTime;

      span.setAttribute('ld.ai.graph.path', path.join('->'));
      span.setAttribute('gen_ai.usage.input_tokens', inputTokens);
      span.setAttribute('gen_ai.usage.output_tokens', outputTokens);
      span.setAttribute('gen_ai.usage.total_tokens', totalTokens);

      if (ldContext) {
        const rootTrackData = makeNodeTrackData(root, def.key, runId);
        getClient().track('$ld:ai:graph:duration:total', ldContext, rootTrackData, duration);
        getClient().track('$ld:ai:graph:total_tokens', ldContext, rootTrackData, totalTokens);
        getClient().track('$ld:ai:graph:path', ldContext, rootTrackData, path.length);
        getClient().track('$ld:ai:graph:invocation_success', ldContext, rootTrackData, 1);
      }

      span.setStatus({ code: SpanStatusCode.OK });
      span.end();
      return { response: finalOutput, usage: totalUsage };
    });
  };

  return { invoke };
};
