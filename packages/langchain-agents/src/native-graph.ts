import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { type AIMessage, type BaseMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { Annotation, addMessages, Command, END, START, StateGraph } from '@langchain/langgraph';
import { ToolNode, toolsCondition } from '@langchain/langgraph/prebuilt';
import { ChatOpenAI } from '@langchain/openai';
import type { LDContext } from '@launchdarkly/ai-server';
import {
  type GraphDefinition,
  type GraphNode,
  getClient,
  type NativeTool,
  type ProviderGraphResponse,
  parseTemplate,
  type ToolHandlerFn,
  type TrackData,
} from '@launchdarkly/ai-server';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import { z } from 'zod';

// ─── helpers ─────────────────────────────────────────────────────────────────

const sanitizeName = (key: string) => key.replace(/[^a-z0-9_-]/gi, '_');

const StateAnnotation = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: addMessages,
    default: () => [],
  }),
});
type WorkflowState = typeof StateAnnotation.State;

const buildSystemPrompt = (node: GraphNode, variables: Record<string, unknown>): string | undefined => {
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
    tool(
      async (args: Record<string, unknown>) => {
        const handler = toolHandlers[name];
        if (!handler || (handler instanceof Object && 'id' in handler)) {
          return '';
        }
        const result = await (handler as (...args: unknown[]) => unknown)(args);
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

const trackNode = (
  node: GraphNode,
  startTime: number,
  usage: { input: number; output: number; total: number },
  ldContext: LDContext | undefined,
  def: GraphDefinition,
  runId: string,
) => {
  if (!ldContext) return;
  const trackData = makeNodeTrackData(node, def.key, runId);
  const duration = Date.now() - startTime;
  getClient().track('$ld:ai:duration:total', ldContext, trackData, duration);
  getClient().track('$ld:ai:generation:success', ldContext, trackData, 1);
  if (usage.total > 0) getClient().track('$ld:ai:tokens:total', ldContext, trackData, usage.total);
  if (usage.input > 0) getClient().track('$ld:ai:tokens:input', ldContext, trackData, usage.input);
  if (usage.output > 0) getClient().track('$ld:ai:tokens:output', ldContext, trackData, usage.output);
};

const extractUsage = (msg: AIMessage) => {
  // biome-ignore lint/suspicious/noExplicitAny: LangChain AIMessage does not expose usage_metadata in public types
  const meta = (msg as any).usage_metadata;
  if (!meta) return { input: 0, output: 0, total: 0 };
  const input = meta.input_tokens ?? 0;
  const output = meta.output_tokens ?? 0;
  return { input, output, total: input + output };
};

// ─── toLangGraph ──────────────────────────────────────────────────────────────

/**
 * Converts a resolved `GraphDefinition` into a compiled LangGraph `StateGraph`
 * and returns a caller that runs it via `compiled.invoke`.
 *
 * @example
 * ```ts
 * import { resolveGraph } from '@launchdarkly/ai-server';
 * import { toLangGraph } from '@launchdarkly/ai-langchain-agents';
 *
 * const result = await toLangGraph(
 *   resolveGraph('support-graph', { context }),
 *   { toolHandlers: registry.tools, context }
 * ).invoke('I was double charged');
 * ```
 */
export const toLangGraph = (
  defPromise: Promise<GraphDefinition>,
  opts?: {
    toolHandlers?: Record<string, ToolHandlerFn | NativeTool>;
    /** Factory to create the chat model for a node. Defaults to `ChatOpenAI`. */
    modelFactory?: (node: GraphNode) => BaseChatModel;
    /** LaunchDarkly context used for tracking events. Required for LD telemetry. */
    context?: LDContext;
  },
): { invoke: (input?: string, variables?: Record<string, unknown>) => Promise<ProviderGraphResponse> } => {
  type ContentBlock = { type: string; text?: string };

  const invoke = async (input = '', variables: Record<string, unknown> = {}): Promise<ProviderGraphResponse> => {
    const def = await defPromise;
    if (!def.enabled) {
      throw new Error(`Agent graph "${def.key}" is disabled`);
    }
    if (!def.root) {
      throw new Error(`Graph "${def.key}" has no root node`);
    }

    const toolHandlers = opts?.toolHandlers ?? {};
    const modelFactory = opts?.modelFactory ?? ((node) => new ChatOpenAI({ model: node.config.model.name }));
    const ldContext = opts?.context;

    return trace.getTracer('@launchdarkly/ai-langchain-agents').startActiveSpan('launchdarkly.graph', async (span) => {
      span.setAttribute('launchdarkly.graph.key', def.key);
      const startTime = Date.now();
      const runId = crypto.randomUUID();

      const path: string[] = [];
      const totalUsage = { input: 0, output: 0, total: 0 };

      const builder = new StateGraph(StateAnnotation);

      // Walk root → leaves, registering each node in the StateGraph
      await def.traverse(async (node) => {
        const nodeKey = sanitizeName(node.key);
        const outgoing = def.edgesFrom(node.key);
        const isTerminal = node.isTerminal();
        const isMultiChild = outgoing.length > 1;

        const chatModel = modelFactory(node);
        const regularTools = buildNodeTools(node, toolHandlers);

        // Handoff tools for each child edge — returning Command routes the graph
        const handoffTools = outgoing.map((edge) =>
          tool(
            async (): Promise<Command> => {
              const targetKey = sanitizeName(edge.targetKey);
              if (ldContext) {
                const trackData = makeNodeTrackData(node, def.key, runId);
                getClient().track('$ld:ai:graph:handoff_success', ldContext, trackData, 1);
              }
              return new Command({ goto: targetKey });
            },
            {
              name: `transfer_to_${sanitizeName(edge.targetKey)}`,
              description: `Transfer control to the ${edge.targetKey} agent`,
              schema: z.object({}),
            },
          ),
        );

        const allTools = [...regularTools, ...handoffTools];

        // Node function: run the model, track LD events, return state update
        const nodeFunction = async (state: WorkflowState) => {
          path.push(node.key);
          const nodeStartTime = Date.now();

          const systemPrompt = buildSystemPrompt(node, variables);
          const conversationMessages = state.messages;
          const fullMessages: BaseMessage[] = [
            ...(systemPrompt ? [new SystemMessage(systemPrompt)] : []),
            ...conversationMessages,
          ];

          const boundModel =
            allTools.length > 0
              ? // biome-ignore lint/suspicious/noExplicitAny: LangChain BaseChatModel.bindTools is not typed in the base class
                (chatModel as any).bindTools(allTools, {
                  ...(isMultiChild ? { parallel_tool_calls: false } : {}),
                })
              : chatModel;

          const result = (await boundModel.invoke(fullMessages)) as AIMessage;
          const usage = extractUsage(result);
          totalUsage.input += usage.input;
          totalUsage.output += usage.output;
          totalUsage.total += usage.total;

          const _text =
            typeof result.content === 'string'
              ? result.content
              : Array.isArray(result.content)
                ? result.content
                    .filter((c: ContentBlock) => c.type === 'text')
                    .map((c: ContentBlock) => c.text)
                    .join('')
                : '';

          trackNode(node, nodeStartTime, usage, ldContext, def, runId);

          return { messages: [result] };
        };

        builder.addNode(nodeKey, nodeFunction);

        if (allTools.length > 0) {
          builder.addNode(`${nodeKey}_tools`, new ToolNode(allTools));
        }

        // Edge wiring
        // biome-ignore lint/suspicious/noExplicitAny: LangGraph StateGraph addEdge/addConditionalEdges require literal types; cast builder to bypass
        const b = builder as any;
        if (node.key === def.root?.key) {
          b.addEdge(START, nodeKey);
        }

        if (isTerminal) {
          if (allTools.length > 0) {
            // tool loop → END
            b.addConditionalEdges(nodeKey, toolsCondition, { tools: `${nodeKey}_tools`, __end__: END });
            b.addEdge(`${nodeKey}_tools`, nodeKey);
          } else {
            b.addEdge(nodeKey, END);
          }
        } else if (isMultiChild) {
          // Handoff tools in allTools return Command; ToolNode propagates it
          if (allTools.length > 0) {
            b.addConditionalEdges(nodeKey, toolsCondition, { tools: `${nodeKey}_tools`, __end__: END });
            b.addEdge(`${nodeKey}_tools`, nodeKey);
          } else {
            b.addEdge(nodeKey, END);
          }
        } else {
          // Single child: tool loop, then go to child
          const childKey = sanitizeName(outgoing[0].targetKey);
          if (allTools.length > 0) {
            b.addConditionalEdges(nodeKey, toolsCondition, { tools: `${nodeKey}_tools`, __end__: childKey });
            b.addEdge(`${nodeKey}_tools`, nodeKey);
          } else {
            b.addEdge(nodeKey, childKey);
          }
        }
      });

      const compiled = builder.compile();

      // biome-ignore lint/suspicious/noImplicitAnyLet: assigned immediately in try; catch always re-throws
      let result;
      try {
        result = await compiled.invoke({ messages: [new HumanMessage(input)] });
        span.setStatus({ code: SpanStatusCode.OK });
      } catch (err) {
        span.recordException(err instanceof Error ? err : new Error(String(err)));
        span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
        if (ldContext) {
          // biome-ignore lint/style/noNonNullAssertion: def.root is asserted non-null earlier in this function
          const trackData = makeNodeTrackData(def.root!, def.key, runId);
          getClient().track('$ld:ai:graph:invocation_failure', ldContext, trackData, 1);
        }
        throw err;
      }

      const duration = Date.now() - startTime;

      // Extract final output from last AI message
      const lastMsg: BaseMessage | undefined = result.messages?.[result.messages.length - 1];
      const finalOutput = lastMsg
        ? typeof lastMsg.content === 'string'
          ? lastMsg.content
          : Array.isArray(lastMsg.content)
            ? lastMsg.content
                .filter((c: ContentBlock) => c.type === 'text')
                .map((c: ContentBlock) => c.text)
                .join('')
            : ''
        : '';

      span.setAttribute('launchdarkly.graph.path', path.join('->'));
      span.setAttribute('gen_ai.usage.input_tokens', totalUsage.input);
      span.setAttribute('gen_ai.usage.output_tokens', totalUsage.output);
      span.setAttribute('gen_ai.usage.total_tokens', totalUsage.total);

      if (ldContext) {
        // biome-ignore lint/style/noNonNullAssertion: def.root is asserted non-null earlier in this function
        const rootTrackData = makeNodeTrackData(def.root!, def.key, runId);
        getClient().track('$ld:ai:graph:duration:total', ldContext, rootTrackData, duration);
        getClient().track('$ld:ai:graph:total_tokens', ldContext, rootTrackData, totalUsage.total);
        getClient().track('$ld:ai:graph:path', ldContext, rootTrackData, path.length);
        getClient().track('$ld:ai:graph:invocation_success', ldContext, rootTrackData, 1);
      }

      return { response: finalOutput, usage: totalUsage };
    });
  };

  return { invoke };
};
