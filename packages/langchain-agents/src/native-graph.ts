import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, type BaseMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { Annotation, addMessages, Command, END, START, StateGraph } from '@langchain/langgraph';
import { ToolNode, toolsCondition } from '@langchain/langgraph/prebuilt';
import { ChatOpenAI } from '@langchain/openai';
import {
  composeHistory,
  type GraphDefinition,
  type GraphNode,
  getClient,
  isFunctionTool,
  type LDContext,
  type Message,
  makeGraphTrackData,
  makeNodeTrackData,
  type NativeTool,
  type ProviderGraphResponse,
  parseTemplate,
  reportUsage,
  setLdSpanAttributes,
  type ToolHandlerFn,
  toolResultString,
} from '@launchdarkly/ai-server';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import { z } from 'zod';
import { toLangChainMessages } from './messages.js';
import { modelConstructorParameters } from './model-parameters.js';
import { LD_AI_PACKAGE_NAME, LD_AI_PACKAGE_VERSION } from './version.js';

// ─── helpers ─────────────────────────────────────────────────────────────────

const sanitizeName = (key: string) => key.replace(/[^a-z0-9_-]/gi, '_');

const HANDOFF_IGNORED = 'Ignored: only the first transfer in a turn routes.';

/** The text parts of a message's content, joined with no separator. */
const contentText = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content
          .filter((c) => c?.type === 'text')
          .map((c) => c.text ?? '')
          .join('')
      : '';

/**
 * Rewrites the history a node finds when it is entered as provider-neutral text, so a
 * target on another provider never sees the previous node's tool or reasoning blocks
 * (spec §2.x.3). Human and system messages pass through. Exported for tests only; the
 * package index does not re-export it.
 */
export const toNeutralHistory = (messages: BaseMessage[]): BaseMessage[] => {
  const out: BaseMessage[] = [];
  let calls: { name: string; id?: string }[] = [];
  let results: ToolMessage[] = [];
  const flush = () => {
    if (results.length === 0) return;
    const order = (r: ToolMessage) => {
      const i = calls.findIndex((c) => c.id === r.tool_call_id);
      return i === -1 ? calls.length : i;
    };
    const lines = [...results]
      .sort((a, b) => order(a) - order(b))
      .map((r) => `[Tool result] ${calls[order(r)]?.name ?? r.name ?? ''}: ${contentText(r.content)}`);
    out.push(new HumanMessage(lines.join('\n')));
    results = [];
  };
  for (const m of messages) {
    if (ToolMessage.isInstance(m)) {
      results.push(m);
      continue;
    }
    flush();
    if (!AIMessage.isInstance(m)) {
      out.push(m);
      continue;
    }
    calls = m.tool_calls ?? [];
    const text = contentText(m.content);
    const lines = [
      ...(text ? [text] : []),
      ...calls.map((c) => `[Tool call] ${c.name} ${JSON.stringify((c as { args?: unknown }).args ?? {})}`),
    ];
    if (lines.length > 0) out.push(new AIMessage(lines.join('\n')));
  }
  flush();
  return out;
};

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
  return Object.entries(node.config.tools)
    .filter(([name]) => Object.hasOwn(toolHandlers, name) && isFunctionTool(name, toolHandlers[name]))
    .map(([name, toolConfig]) =>
      tool(
        async (args: Record<string, unknown>) => {
          const result = await (toolHandlers[name] as (...args: unknown[]) => unknown)(args);
          return toolResultString(result);
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
): {
  invoke: (input?: string, variables?: Record<string, unknown>, history?: Message[]) => Promise<ProviderGraphResponse>;
} => {
  reportUsage('langchain-agents.toLangGraph', LD_AI_PACKAGE_NAME, LD_AI_PACKAGE_VERSION);

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
    const modelFactory =
      opts?.modelFactory ??
      ((node) =>
        new ChatOpenAI({
          ...modelConstructorParameters(node.config.model.parameters, 'openai'),
          model: node.config.model.name,
        }));
    const ldContext = opts?.context;

    return trace.getTracer('@launchdarkly/ai-langchain-agents').startActiveSpan('launchdarkly.graph', async (span) => {
      const startTime = Date.now();
      const runId = crypto.randomUUID();
      // One try covers setup and the run, so a setup error (a graph that fails to compile)
      // is recorded on the span and tracked as an invocation failure, like a run error.
      try {
        setLdSpanAttributes(span, { __ld: makeGraphTrackData(def.key, runId), ldContext });

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

          // The node's last model call sets `first` (its first hand-off call id);
          // the tools step sets `handedOff` when that call routes.
          // `callIds` holds its last model call's tool call ids; `start` is where the
          // node's current visit began.
          const routing: { first?: string; handedOff: boolean; callIds: Set<string | undefined>; start: number } = {
            handedOff: false,
            callIds: new Set(),
            start: 0,
          };

          // Handoff tools for each child edge — returning Command routes the graph
          const handoffTools = outgoing.map((edge) =>
            tool(
              async (_input, config): Promise<Command | string> => {
                const toolCallId = config.toolCall?.id;
                // Only the first hand-off in a model message routes, as in graph().
                // The handedOff check also keeps first-wins when the calls carry no id.
                if (routing.handedOff || toolCallId !== routing.first) return HANDOFF_IGNORED;
                routing.handedOff = true;
                const targetKey = sanitizeName(edge.targetKey);
                if (ldContext) {
                  const trackData = makeNodeTrackData(node, def.key, runId);
                  getClient().track('$ld:ai:graph:handoff_success', ldContext, trackData, 1);
                }
                // The ToolMessage answers the call, so the next model call never sees
                // an unanswered tool call.
                return new Command({
                  goto: targetKey,
                  update: {
                    messages: [
                      new ToolMessage({
                        content: `Handed off to ${edge.targetKey}.`,
                        tool_call_id: toolCallId ?? '',
                        name: `transfer_to_${targetKey}`,
                      }),
                    ],
                  },
                });
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
            if (!path.includes(node.key)) {
              const index = path.length;
              path.push(node.key);
              if (ldContext) {
                const nodeTrackData = makeNodeTrackData(node, def.key, runId);
                getClient().track('$ld:ai:graph:node', ldContext, { ...nodeTrackData, nodeKey: node.key, index }, 1);
              }
            }
            const nodeStartTime = Date.now();

            const systemPrompt = buildSystemPrompt(node, variables);
            const last = state.messages.at(-1);
            // A tool result for this node's own last call continues its tool loop;
            // anything else means the node was just entered.
            if (!(last && ToolMessage.isInstance(last) && routing.callIds.has(last.tool_call_id))) {
              routing.start = state.messages.length;
            }
            const conversationMessages = [
              ...toNeutralHistory(state.messages.slice(0, routing.start)),
              ...state.messages.slice(routing.start),
            ];
            const fullMessages: BaseMessage[] = [
              ...(systemPrompt ? [new SystemMessage(systemPrompt)] : []),
              ...conversationMessages,
            ];

            // No parallel_tool_calls: Bedrock Converse rejects it. The hand-off tools
            // keep only the first hand-off instead.
            const boundModel =
              allTools.length > 0
                ? // biome-ignore lint/suspicious/noExplicitAny: LangChain BaseChatModel.bindTools is not typed in the base class
                  (chatModel as any).bindTools(allTools)
                : chatModel;

            const result = (await boundModel.invoke(fullMessages)) as AIMessage;
            routing.first = result.tool_calls?.find((tc) => tc.name.startsWith('transfer_to_'))?.id;
            routing.handedOff = false;
            routing.callIds = new Set(result.tool_calls?.map((tc) => tc.id));
            const usage = extractUsage(result);
            totalUsage.input += usage.input;
            totalUsage.output += usage.output;
            totalUsage.total += usage.total;

            trackNode(node, nodeStartTime, usage, ldContext, def, runId);

            return { messages: [result] };
          };

          builder.addNode(nodeKey, nodeFunction);

          if (allTools.length > 0) {
            // `ends` declares where a hand-off Command may go; LangGraph rejects other targets.
            builder.addNode(`${nodeKey}_tools`, new ToolNode(allTools), {
              ends: outgoing.map((edge) => sanitizeName(edge.targetKey)),
            });
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
          } else {
            // A non-terminal node always has hand-off tools. Ending the turn without one
            // ends the run (multi-child) or moves to the child.
            const endTarget = isMultiChild ? END : sanitizeName(outgoing[0].targetKey);
            b.addConditionalEdges(nodeKey, toolsCondition, { tools: `${nodeKey}_tools`, __end__: endTarget });
            // No static edge back to the node: after a hand-off the Command routes to the
            // target and the node must not run again.
            b.addConditionalEdges(`${nodeKey}_tools`, () => (routing.handedOff ? END : nodeKey), [nodeKey, END]);
          }
        });

        const compiled = builder.compile();

        // History is a root-only concern: it seeds the initial message state the
        // entry node reads. Downstream nodes are reached through handoffs and see
        // the accumulated graph state, never the original `history` array.
        const initialMessages =
          history && history.length > 0
            ? toLangChainMessages(composeHistory({ history, userInput: input }))
            : [new HumanMessage(input)];

        const result = await compiled.invoke({ messages: initialMessages });

        const duration = Date.now() - startTime;

        // Extract final output from last AI message
        const lastMsg: BaseMessage | undefined = result.messages?.[result.messages.length - 1];
        const finalOutput = contentText(lastMsg?.content);

        span.setAttribute('launchdarkly.graph.path', path.join('->'));
        span.setAttribute('gen_ai.usage.input_tokens', totalUsage.input);
        span.setAttribute('gen_ai.usage.output_tokens', totalUsage.output);
        span.setAttribute('gen_ai.usage.total_tokens', totalUsage.total);

        if (ldContext) {
          const graphTrackData = makeGraphTrackData(def.key, runId);
          getClient().track('$ld:ai:graph:duration:total', ldContext, graphTrackData, duration);
          getClient().track('$ld:ai:graph:total_tokens', ldContext, graphTrackData, totalUsage.total);
          getClient().track('$ld:ai:graph:invocation_success', ldContext, graphTrackData, 1);
        }

        span.setStatus({ code: SpanStatusCode.OK });
        return { response: finalOutput, usage: totalUsage };
      } catch (err) {
        const exception = err instanceof Error ? err : new Error(String(err));
        span.recordException(exception);
        span.setStatus({ code: SpanStatusCode.ERROR, message: exception.message });
        if (ldContext) {
          getClient().track('$ld:ai:graph:invocation_failure', ldContext, makeGraphTrackData(def.key, runId), 1);
        }
        throw err;
      } finally {
        span.end();
      }
    });
  };

  return { invoke };
};
