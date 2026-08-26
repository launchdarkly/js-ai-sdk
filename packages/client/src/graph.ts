import { SpanStatusCode, trace } from '@opentelemetry/api';
import { runJudges } from './judges.js';
import { extractVariation, getClient, initClient } from './lifecycle.js';
import { resolveHandlers, resolveTools } from './registry.js';
import { executeAndTrack } from './tracking.js';
import type { LDContext, Message, ToolHandlerFn } from './types.js';
import {
  type AiConfigRep,
  type GraphArgs,
  type GraphDefinition,
  type GraphEdge,
  type GraphNode,
  type GraphOptions,
  type GraphTopology,
  GraphTopologySchema,
  type ProviderGraphResponse,
  type ProviderHandler,
  type ProviderResponse,
  type RouteResult,
  type RunNodeOptions,
  type Tool,
  type TrackData,
  type TraverseVisitor,
  type VariationMeta,
} from './types.js';
import { normalizeMode } from './utils.js';

// Cycle protection: cap how many BFS layers a traversal will expand.
const MAX_TRAVERSAL_DEPTH = 100;

// Provider tool/function names allow only a restricted character set.
const sanitizeName = (key: string): string => key.replace(/[^a-zA-Z0-9_]/g, '_');

/**
 * Selects the handler responsible for a node from the candidate `handlers`,
 * matching on the node config's provider and the variation mode. Falls back to
 * a provider-only match, then to a sole handler, before giving up.
 */
const selectHandler = (config: AiConfigRep, meta: VariationMeta, handlers: ProviderHandler[]): ProviderHandler => {
  const provider = config.provider?.name;
  if (!provider) {
    throw new Error('Provider not found for graph node');
  }

  const mode = normalizeMode(meta.mode);

  const exact = handlers.find((h) => h.providesFor?.[0] === provider && h.providesFor?.[1] === mode);
  if (exact) return exact;

  const wildcard = handlers.find((h) => h.providesFor?.[0] === '*' && h.providesFor?.[1] === mode);
  if (wildcard) return wildcard;

  const byProvider = handlers.find((h) => h.providesFor?.[0] === provider);
  if (byProvider) return byProvider;

  if (handlers.length === 1) return handlers[0];

  throw new Error(`Handler for provider ${provider} not found`);
};

const disabledDefinition = (key: string): GraphDefinition => ({
  key,
  enabled: false,
  root: null,
  getNode: () => undefined,
  getChildNodes: () => [],
  getParentNodes: () => [],
  terminalNodes: () => [],
  edgesFrom: () => [],
  runNode: async () => {
    throw new Error(`Agent graph "${key}" is disabled`);
  },
  route: async () => {
    throw new Error(`Agent graph "${key}" is disabled`);
  },
  traverse: async () => undefined,
  reverseTraverse: async () => undefined,
});

const fetchGraphVariation = async (
  key: string,
  context: LDContext,
): Promise<{ enabled: boolean; topology?: GraphTopology; meta: VariationMeta }> => {
  await initClient();
  const variation: unknown = await getClient().variation(key, context, {});

  // Graph flags don't carry _ldMeta — use the presence of `root` as the
  // enabled signal, matching the Python SDK's behaviour.
  // biome-ignore lint/suspicious/noExplicitAny: accessing LaunchDarkly private metadata field not in public types
  const meta = ((variation as any)?._ldMeta ?? {}) as VariationMeta;

  const parsed = GraphTopologySchema.safeParse(variation);
  if (!parsed.success || !parsed.data.root) {
    return { enabled: false, meta };
  }

  return { enabled: true, topology: parsed.data, meta };
};

/**
 * Resolves a graph flag into a {@link GraphDefinition}: fetches topology,
 * eagerly evaluates each referenced agent config, and exposes topology
 * accessors plus a tracked per-node executor and the ordered-walk primitives.
 *
 * Internal builder also returns the graph-level {@link TrackData} so `graph()`
 * can emit `$ld:ai:graph:*` events with a shared run id.
 */
const buildGraph = async (
  key: string,
  context: LDContext,
  options: GraphOptions,
): Promise<{ def: GraphDefinition; graphTrackData: TrackData }> => {
  const { enabled, topology, meta } = await fetchGraphVariation(key, context);

  const graphTrackData: TrackData = {
    runId: crypto.randomUUID(),
    configKey: key,
    variationKey: meta.variationKey ?? '',
    version: meta.version ?? 1,
    modelName: '',
    providerName: '',
    graphKey: key,
  };

  if (!enabled || !topology) {
    return { def: disabledDefinition(key), graphTrackData };
  }

  const edges: GraphEdge[] = [];
  for (const [sourceKey, outgoing] of Object.entries(topology.edges ?? {})) {
    for (const edge of outgoing) {
      edges.push({
        key: `${sourceKey}-${edge.key}`,
        sourceKey,
        targetKey: edge.key,
        handoff: edge.handoff,
      });
    }
  }

  const allKeys = new Set<string>([topology.root]);
  for (const edge of edges) {
    allKeys.add(edge.sourceKey);
    allKeys.add(edge.targetKey);
  }

  const edgesFrom = (nodeKey: string): GraphEdge[] => edges.filter((e) => e.sourceKey === nodeKey);

  const nodes = new Map<string, GraphNode>();
  try {
    for (const nodeKey of allKeys) {
      const { config, meta: nodeMeta } = await extractVariation(nodeKey, context);
      const nodeEdges = edgesFrom(nodeKey);
      nodes.set(nodeKey, {
        key: nodeKey,
        config,
        meta: nodeMeta,
        edges: nodeEdges,
        isTerminal: () => nodeEdges.length === 0,
      });
    }
  } catch (err) {
    // Any referenced agent resolving to a disabled/invalid variation disables
    // the whole graph (parity with the Python SDK).
    // biome-ignore lint/suspicious/noConsole: intentional error logging
    console.error(err);
    return { def: disabledDefinition(key), graphTrackData };
  }

  const getNode = (nodeKey: string): GraphNode | undefined => nodes.get(nodeKey);
  const getChildNodes = (nodeKey: string): GraphNode[] =>
    edgesFrom(nodeKey)
      .map((e) => nodes.get(e.targetKey))
      .filter((n): n is GraphNode => n !== undefined);
  const getParentNodes = (nodeKey: string): GraphNode[] =>
    edges
      .filter((e) => e.targetKey === nodeKey)
      .map((e) => nodes.get(e.sourceKey))
      .filter((n): n is GraphNode => n !== undefined);
  const terminalNodes = (): GraphNode[] => [...nodes.values()].filter((n) => edgesFrom(n.key).length === 0);
  const rootNode = nodes.get(topology.root) ?? null;

  const runNode = async (node: GraphNode, input = '', opts: RunNodeOptions = {}): Promise<ProviderResponse> => {
    const resolvedHandlersForNode = resolveHandlers(options.registry, options.handlers);
    if (!resolvedHandlersForNode?.length) {
      throw new Error(
        'runNode is not available when no handlers were provided — use a framework-native runner ' +
          '(toOpenAIAgents, toLangGraph, toClaudeAgents) instead.',
      );
    }
    const handler = selectHandler(node.config, node.meta, resolvedHandlersForNode);
    const toolHandlers = opts.toolHandlers ?? options.toolHandlers;
    try {
      const {
        response: rawResponse,
        usage,
        trackData,
      } = await executeAndTrack({
        configKey: node.key,
        config: node.config,
        meta: node.meta,
        userContext: context,
        handler,
        userInput: input,
        toolHandlers,
        variables: opts.variables,
        graphKey: key,
        history: opts.history,
      });
      const response = typeof rawResponse === 'string' ? rawResponse : JSON.stringify(rawResponse);

      const judgeResults = await runJudges({
        config: node.config,
        userContext: context,
        handler,
        handlers: options.handlers,
        userInput: input,
        llmResponse: response,
        baseTrackData: trackData,
        toolHandlers,
        graphKey: key,
      });

      if (opts.from) {
        getClient().track(
          '$ld:ai:graph:handoff_success',
          context,
          { ...graphTrackData, sourceKey: opts.from.key, targetKey: node.key },
          1,
        );
      }

      return { response, usage, judgeResults, trackData };
    } catch (err) {
      if (opts.from) {
        getClient().track(
          '$ld:ai:graph:handoff_failure',
          context,
          { ...graphTrackData, sourceKey: opts.from.key, targetKey: node.key },
          1,
        );
      }
      throw err;
    }
  };

  const route = async (node: GraphNode, input = '', opts: RunNodeOptions = {}): Promise<RouteResult> => {
    if (!options.handlers?.length) {
      throw new Error(
        'route is not available when no handlers were provided — use a framework-native runner ' +
          '(toOpenAIAgents, toLangGraph, toClaudeAgents) instead.',
      );
    }

    const outgoing = edgesFrom(node.key);

    // Nothing to decide: run the node and report its sole child (if any) as next.
    if (outgoing.length <= 1) {
      const res = await runNode(node, input, opts);
      const next = outgoing[0] ? nodes.get(outgoing[0].targetKey) : undefined;
      return { ...res, next };
    }

    const handler = selectHandler(node.config, node.meta, options.handlers);
    const toolHandlers = opts.toolHandlers ?? options.toolHandlers;

    // Present each outgoing edge to the model as a synthetic handoff tool. The
    // model picks one by "calling" it; our handler records the chosen target.
    let chosen: string | undefined;
    const handoffTools: Record<string, Tool> = {};
    const handoffHandlers: Record<string, ToolHandlerFn> = {};

    for (const edge of outgoing) {
      const target = nodes.get(edge.targetKey);
      const toolName = `__handoff_${sanitizeName(edge.targetKey)}`;
      const description =
        (edge.handoff?.description as string | undefined) ??
        target?.config.instructions?.slice(0, 120) ??
        `Transfer control to ${edge.targetKey}`;

      handoffTools[toolName] = {
        name: toolName,
        type: 'function',
        description,
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      };
      handoffHandlers[toolName] = () => {
        if (!chosen) chosen = edge.targetKey;
        return `Transferring to ${edge.targetKey}`;
      };
    }

    const routedConfig: AiConfigRep = {
      ...node.config,
      instructions: `${node.config.instructions ?? ''}\n\nSelect exactly one transfer tool to route to the next agent.`,
      tools: { ...(node.config.tools ?? {}), ...handoffTools },
    };

    try {
      const {
        response: rawRouteResponse,
        usage,
        trackData,
      } = await executeAndTrack({
        configKey: node.key,
        config: routedConfig,
        meta: node.meta,
        userContext: context,
        handler,
        userInput: input,
        toolHandlers: { ...(toolHandlers ?? {}), ...handoffHandlers },
        variables: opts.variables,
        graphKey: key,
        history: opts.history,
      });
      const response = typeof rawRouteResponse === 'string' ? rawRouteResponse : JSON.stringify(rawRouteResponse);

      // Judge against the node's original config, not the routing-augmented one.
      const judgeResults = await runJudges({
        config: node.config,
        userContext: context,
        handler,
        handlers: options.handlers,
        userInput: input,
        llmResponse: response,
        baseTrackData: trackData,
        toolHandlers,
        graphKey: key,
      });

      const next = chosen ? nodes.get(chosen) : undefined;

      if (next) {
        getClient().track(
          '$ld:ai:graph:handoff_success',
          context,
          { ...graphTrackData, sourceKey: node.key, targetKey: next.key },
          1,
        );
      }

      return { response, usage, judgeResults, trackData, next };
    } catch (err) {
      if (chosen) {
        getClient().track(
          '$ld:ai:graph:handoff_failure',
          context,
          { ...graphTrackData, sourceKey: node.key, targetKey: chosen },
          1,
        );
      }
      throw err;
    }
  };

  // biome-ignore lint/suspicious/noExplicitAny: T = any default keeps existing call-sites working without type annotations
  const traverse = async <T = any>(
    fn: TraverseVisitor<T>,
    ctx: Record<string, unknown> = {},
  ): Promise<T | undefined> => {
    if (!rootNode) return undefined;

    const depths = new Map<string, number>([[rootNode.key, 0]]);
    const seen = new Set<string>([rootNode.key]);
    let frontier: string[] = [rootNode.key];
    let iterations = 0;

    while (frontier.length > 0 && iterations < MAX_TRAVERSAL_DEPTH) {
      iterations += 1;
      const next: string[] = [];
      for (const nodeKey of frontier) {
        const depth = depths.get(nodeKey) ?? 0;
        for (const child of getChildNodes(nodeKey)) {
          const childDepth = depth + 1;
          if (!depths.has(child.key) || childDepth > (depths.get(child.key) ?? 0)) {
            depths.set(child.key, childDepth);
          }
          if (!seen.has(child.key)) {
            seen.add(child.key);
            next.push(child.key);
          }
        }
      }
      frontier = next;
    }

    const ordered = [...depths.entries()].sort((a, b) => a[1] - b[1]).map(([nodeKey]) => nodeKey);

    for (const nodeKey of ordered) {
      const node = nodes.get(nodeKey);
      if (node) ctx[nodeKey] = await fn(node, ctx);
    }

    return ctx[rootNode.key] as T | undefined;
  };

  // biome-ignore lint/suspicious/noExplicitAny: T = any default keeps existing call-sites working without type annotations
  const reverseTraverse = async <T = any>(
    fn: TraverseVisitor<T>,
    ctx: Record<string, unknown> = {},
  ): Promise<T | undefined> => {
    if (!rootNode) return undefined;

    const terminals = terminalNodes();
    if (terminals.length === 0) return undefined;

    const visited = new Set<string>();
    let frontier: string[] = terminals.map((n) => n.key);
    let iterations = 0;

    while (frontier.length > 0 && iterations < MAX_TRAVERSAL_DEPTH) {
      iterations += 1;
      const next: string[] = [];
      for (const nodeKey of frontier) {
        if (visited.has(nodeKey)) continue;
        visited.add(nodeKey);

        // Defer the root: it is always visited last in a reverse traversal.
        if (nodeKey === rootNode.key) continue;

        const node = nodes.get(nodeKey);
        if (node) ctx[nodeKey] = await fn(node, ctx);

        for (const parent of getParentNodes(nodeKey)) {
          if (!visited.has(parent.key)) next.push(parent.key);
        }
      }
      frontier = next;
    }

    ctx[rootNode.key] = await fn(rootNode, ctx);
    return ctx[rootNode.key] as T | undefined;
  };

  const def: GraphDefinition = {
    key,
    enabled: true,
    root: rootNode,
    getNode,
    getChildNodes,
    getParentNodes,
    terminalNodes,
    edgesFrom,
    runNode,
    route,
    traverse,
    reverseTraverse,
  };

  return { def, graphTrackData };
};

/**
 * Resolves an agent graph's topology and node configs without executing it.
 * Parity equivalent of the Python SDK's `agent_graph()` / `is_enabled()`, and
 * the entrypoint framework packages compose on. The returned definition carries
 * `.enabled`; callers should branch on it before traversing.
 */
export const resolveGraph = async (key: string, options: GraphArgs): Promise<GraphDefinition> => {
  const resolvedOptions: GraphOptions = {
    ...options,
    handlers: resolveHandlers(options.registry, options.handlers),
    toolHandlers: resolveTools(options.registry, options.toolHandlers),
  };
  return (await buildGraph(key, options.context, resolvedOptions)).def;
};

/**
 * Creates an agent graph caller bound to a graph flag key. Uses a model-driven
 * router: starts at the root and lets the model choose which outgoing edge to
 * follow at each step, threading each node's output into the next. Stops when
 * the model produces a terminal answer, a leaf is reached, a node is revisited
 * (cycle guard), or the step cap is hit.
 *
 * For framework packages that need to walk the topology and build their own
 * execution structure, use `resolveGraph` instead.
 */
export const graph = (
  key: string,
  options: GraphOptions,
): {
  invoke: (
    input: string | undefined,
    context: LDContext,
    variables?: Record<string, unknown>,
    history?: Message[],
  ) => Promise<ProviderGraphResponse>;
} => {
  // Resolution is cached per context reference so multiple invoke() invocations
  // with the same context do not re-evaluate all node configurations from LD.
  const nodeCache = new WeakMap<LDContext, Promise<{ def: GraphDefinition; graphTrackData: TrackData }>>();

  const invoke = async (
    input: string | undefined,
    context: LDContext,
    variables?: Record<string, unknown>,
    history?: Message[],
  ): Promise<ProviderGraphResponse> => {
    const resolvedInput = input ?? '';
    const resolvedOptions: GraphOptions = {
      ...options,
      handlers: resolveHandlers(options.registry, options.handlers),
      toolHandlers: resolveTools(options.registry, options.toolHandlers),
    };
    if (!resolvedOptions.handlers?.length) {
      throw new Error(
        'graph().invoke() requires handlers to be provided. Pass handlers in options, or use ' +
          'resolveGraph() with a framework-native runner (toOpenAIAgents, toLangGraph, toClaudeAgents).',
      );
    }

    let buildPromise = nodeCache.get(context);
    if (!buildPromise) {
      buildPromise = buildGraph(key, context, resolvedOptions);
      nodeCache.set(context, buildPromise);
    }
    const { def, graphTrackData } = await buildPromise;
    if (!def.enabled) {
      throw new Error(`Agent graph "${key}" is disabled`);
    }

    return trace.getTracer('@launchdarkly/ai-server').startActiveSpan('ld.ai.graph', async (span) => {
      span.setAttribute('ld.ai.graph.key', key);
      const startTime = Date.now();

      const path: string[] = [];
      const nodes: Record<string, ProviderResponse> = {};
      const totalUsage = { input: 0, output: 0, total: 0 };

      const accumulate = (node: GraphNode, res: ProviderResponse) => {
        path.push(node.key);
        nodes[node.key] = res;
        totalUsage.input += res.usage.input;
        totalUsage.output += res.usage.output;
        totalUsage.total += res.usage.total;
      };

      try {
        // Model-driven router: follow the path the model selects at each step.
        // After the first node, each subsequent node receives both the original
        // user request and the previous node's full response so it stays oriented
        // without losing the original intent.
        let current: GraphNode | null = def.root;
        let previousNode: GraphNode | null = null;
        let currentInput = resolvedInput;
        let last: ProviderResponse | undefined;
        const visited = new Set<string>();
        let steps = 0;

        while (current && steps < MAX_TRAVERSAL_DEPTH) {
          steps += 1;
          const routeOpts: RunNodeOptions = { variables };
          if (previousNode) routeOpts.from = previousNode;
          // History provides prior conversation context to the entry point only.
          // After the root hop, nodes stay oriented through the string threading
          // built below, so history is not re-sent to downstream handlers.
          else if (history && history.length > 0) routeOpts.history = history;
          const res: RouteResult = await def.route(current, currentInput, routeOpts);
          accumulate(current, res);
          last = res;

          if (!res.next || visited.has(res.next.key)) break;
          visited.add(current.key);
          previousNode = current;
          current = res.next;

          currentInput = [`[Original request]\n${resolvedInput}`, `[Previous agent response]\n${res.response}`].join(
            '\n\n',
          );
        }

        const finalResponse = last?.response ?? '';

        const elapsed = Date.now() - startTime;
        getClient().track('$ld:ai:graph:duration:total', context, graphTrackData, elapsed);
        if (totalUsage.total > 0) {
          getClient().track('$ld:ai:graph:total_tokens', context, graphTrackData, totalUsage.total);
        }
        getClient().track('$ld:ai:graph:path', context, { ...graphTrackData, path }, path.length);
        getClient().track('$ld:ai:graph:invocation_success', context, graphTrackData, 1);

        let judgeResults: ProviderResponse['judgeResults'] | undefined;
        if (resolvedOptions.graphJudge && def.root && resolvedOptions.handlers) {
          judgeResults = await runJudges({
            config: {
              judgeConfiguration: { judges: [{ key: resolvedOptions.graphJudge, samplingRate: 1 }] },
            } as unknown as AiConfigRep,
            userContext: context,
            handler: selectHandler(def.root.config, def.root.meta, resolvedOptions.handlers),
            userInput: resolvedInput,
            llmResponse: finalResponse,
            baseTrackData: graphTrackData,
            toolHandlers: resolvedOptions.toolHandlers,
            graphKey: key,
          });
        }

        span.setStatus({ code: SpanStatusCode.OK });
        span.end();

        return { response: finalResponse, usage: totalUsage, judgeResults };
      } catch (err) {
        const elapsed = Date.now() - startTime;
        getClient().track('$ld:ai:graph:duration:total', context, graphTrackData, elapsed);
        getClient().track('$ld:ai:graph:invocation_failure', context, graphTrackData, 1);
        span.recordException(err instanceof Error ? err : new Error(String(err)));
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: err instanceof Error ? err.message : String(err),
        });
        span.end();
        throw err;
      }
    });
  };

  return { invoke };
};
