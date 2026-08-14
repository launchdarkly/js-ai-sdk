import { createSdkMcpServer, type HookInput, query, tool } from '@anthropic-ai/claude-agent-sdk';
import type { LDContext } from '@launchdarkly/ai-server';
import {
  type GraphDefinition,
  type GraphNode,
  getClient,
  NATIVE_TOOL_KEY,
  NativeTool,
  type ProviderGraphResponse,
  type ToolHandlerFn,
  type TrackData,
} from '@launchdarkly/ai-server';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import { z } from 'zod';
import { buildPrompt, buildToolMCP, partitionTools } from './handler.js';

const TOOL_MCP_NAME = 'tool-mcp';
const SUBAGENT_MCP_NAME = 'subagents';
const MCP_TOOL_PREFIX = `mcp__${TOOL_MCP_NAME}__`;
const SUBAGENT_TOOL_PREFIX = `mcp__${SUBAGENT_MCP_NAME}__`;

// ─── helpers ─────────────────────────────────────────────────────────────────

const sanitizeName = (key: string) => key.replace(/[^a-z0-9_-]/gi, '_');

const makeNodeTrackData = (node: GraphNode, graphKey: string, runId: string): TrackData => ({
  runId,
  configKey: node.key,
  variationKey: node.meta.variationKey ?? '',
  version: node.meta.version ?? 1,
  modelName: node.config.model.name,
  providerName: node.config.provider.name,
  graphKey,
});

const buildNativeHooks = (nativeToolMap: Map<string, ToolHandlerFn>) => {
  if (nativeToolMap.size === 0) return undefined;
  return {
    PreToolUse: [
      {
        hooks: [
          async (input: HookInput) => {
            if (input.hook_event_name === 'PreToolUse') {
              const stub = nativeToolMap.get(input.tool_name);
              if (stub) (stub as () => void)();
            }
            return { continue: true };
          },
        ],
      },
    ],
  };
};

const wrapNativeTools = (
  toolHandlers: Record<string, ToolHandlerFn | NativeTool>,
  ldContext: LDContext | undefined,
  trackData: TrackData,
): Record<string, ToolHandlerFn> =>
  Object.fromEntries(
    Object.entries(toolHandlers).map(([name, fn]) => {
      if (fn instanceof NativeTool) {
        const stub = () => {
          if (ldContext) {
            getClient().track('$ld:ai:tool_call', ldContext, { ...trackData, toolName: name }, 1);
          }
        };
        (stub as unknown as Record<symbol, unknown>)[NATIVE_TOOL_KEY] = fn;
        return [name, stub];
      }
      return [name, fn as ToolHandlerFn];
    }),
  );

const runQuery = async (
  node: GraphNode,
  input: string,
  variables: Record<string, unknown>,
  toolHandlers: Record<string, ToolHandlerFn | NativeTool>,
  ldContext: LDContext | undefined,
  graphKey: string,
  runId: string,
  childSubAgentTools: ReturnType<typeof tool>[],
): Promise<{ output: string; usage: { input: number; output: number; total: number } }> => {
  const trackData = makeNodeTrackData(node, graphKey, runId);
  const wrappedHandlers = wrapNativeTools(toolHandlers, ldContext, trackData);
  const { prompt, systemPrompt } = buildPrompt(node.config, input, variables);

  const { nativeToolMap, userConfigTools, nativeToolNames } = partitionTools(node.config.tools, wrappedHandlers);

  const toolMCP =
    Object.keys(userConfigTools).length > 0 ? await buildToolMCP(userConfigTools, wrappedHandlers) : undefined;

  const childMCP =
    childSubAgentTools.length > 0
      ? createSdkMcpServer({ name: SUBAGENT_MCP_NAME, version: '1.0.0', tools: childSubAgentTools })
      : undefined;

  const mcpAllowedTools = Object.keys(userConfigTools).map((n) => MCP_TOOL_PREFIX + n);
  // biome-ignore lint/suspicious/noExplicitAny: Claude SDK tool() return type does not expose .name publicly
  const childAllowedTools = childSubAgentTools.map((t) => SUBAGENT_TOOL_PREFIX + (t as any).name);
  const allAllowedTools = [...mcpAllowedTools, ...childAllowedTools, ...nativeToolNames];

  // biome-ignore lint/suspicious/noExplicitAny: mcpServers value type is an opaque SDK type not exported from the package
  const mcpServers: Record<string, any> = {};
  if (toolMCP) mcpServers[TOOL_MCP_NAME] = toolMCP;
  if (childMCP) mcpServers[SUBAGENT_MCP_NAME] = childMCP;

  const hooks = buildNativeHooks(nativeToolMap);

  let output = '';
  let rawUsage: Record<string, unknown> = {};

  for await (const message of query({
    prompt,
    options: {
      model: node.config.model.name,
      tools: nativeToolNames.length > 0 ? nativeToolNames : [],
      allowedTools: allAllowedTools.length > 0 ? allAllowedTools : undefined,
      mcpServers: Object.keys(mcpServers).length > 0 ? mcpServers : undefined,
      hooks,
      ...(systemPrompt ? { systemPrompt } : {}),
    },
  })) {
    if ('result' in message) {
      output = message.result;
      rawUsage = (message.usage as Record<string, unknown>) ?? {};
    }
  }

  const inputTokens = Number(rawUsage.input_tokens ?? rawUsage.input ?? 0);
  const outputTokens = Number(rawUsage.output_tokens ?? rawUsage.output ?? 0);

  return { output, usage: { input: inputTokens, output: outputTokens, total: inputTokens + outputTokens } };
};

const isAnthropicProvider = (node: GraphNode): boolean => {
  const name = (node.config.provider?.name ?? '').toLowerCase();
  return name === 'anthropic' || name === 'claude';
};

// ─── toClaudeAgents ───────────────────────────────────────────────────────────

/**
 * Converts a resolved `GraphDefinition` into a nested `query()` multi-agent
 * execution: each child node is registered as a tool in the parent's MCP
 * server. When Claude calls the tool, a child `query()` is invoked in-process
 * and the result returned to the parent, keeping everything fully in-process
 * and reusing all existing MCP/tool/`NativeTool` infrastructure.
 *
 * @example
 * ```ts
 * import { resolveGraph } from '@launchdarkly/ai-server';
 * import { toClaudeAgents } from '@launchdarkly/ai-claude-agents';
 *
 * const result = await toClaudeAgents(
 *   resolveGraph('support-graph', { context }),
 *   { toolHandlers: registry.tools, context }
 * ).invoke('I was double charged');
 * ```
 */
export const toClaudeAgents = (
  defPromise: Promise<GraphDefinition>,
  opts?: {
    toolHandlers?: Record<string, ToolHandlerFn | NativeTool>;
    /** LaunchDarkly context used for tracking events. Required for LD telemetry. */
    context?: LDContext;
  },
): { invoke: (input?: string, variables?: Record<string, unknown>) => Promise<ProviderGraphResponse> } => {
  const invoke = async (input = '', variables: Record<string, unknown> = {}): Promise<ProviderGraphResponse> => {
    const def = await defPromise;
    if (!def.enabled) {
      throw new Error(`Agent graph "${def.key}" is disabled`);
    }
    if (!def.root) {
      throw new Error(`Graph "${def.key}" has no root node`);
    }

    const ldContext = opts?.context;
    const rawHandlers = opts?.toolHandlers ?? {};

    return trace.getTracer('@launchdarkly/ai-claude-agents').startActiveSpan('launchdarkly.graph', async (span) => {
      span.setAttribute('launchdarkly.graph.key', def.key);
      const startTime = Date.now();
      const runId = crypto.randomUUID();

      const path: string[] = [];
      const totalUsage = { input: 0, output: 0, total: 0 };

      // Runs a single node either via Claude query() (Anthropic nodes) or via
      // def.runNode() (any other provider, using the registry/handlers).
      const runForNode = async (
        node: GraphNode,
        nodeInput: string,
        childSubAgentTools: ReturnType<typeof tool>[],
      ): Promise<{ output: string; usage: { input: number; output: number; total: number } }> => {
        if (isAnthropicProvider(node)) {
          return runQuery(node, nodeInput, variables, rawHandlers, ldContext, def.key, runId, childSubAgentTools);
        }
        const res = await def.runNode(node, nodeInput, { toolHandlers: rawHandlers, variables });
        const outputStr = typeof res.response === 'string' ? res.response : JSON.stringify(res.response);
        return {
          output: outputStr,
          usage: { input: res.usage.input, output: res.usage.output, total: res.usage.total },
        };
      };

      // biome-ignore lint/suspicious/noExplicitAny: sub-agent tool instances are opaque SDK types from tool()
      const subAgentToolCtx: Record<string, any> = {};

      // Build leaves → root: each non-root node becomes a sub-agent tool
      await def.reverseTraverse<void>(async (node) => {
        // Root is handled separately in the run phase — skip building a tool for it
        if (node.key === def.root?.key) return;

        const nodeKey = sanitizeName(node.key);
        const childSubAgentTools = node.edges.map((e) => subAgentToolCtx[e.targetKey]).filter(Boolean);

        // Create a tool that wraps query() (or def.runNode for non-Anthropic) for this node.
        // The Claude SDK tool() takes a raw Zod shape (Record<string, ZodType>),
        // not a ZodObject — pass the shape directly.
        const subAgentTool = tool(
          nodeKey,
          node.config.instructions?.slice(0, 120) ?? node.key,
          { input: z.string().describe('Task or question for this agent') },
          async ({ input: subInput }: { input: string }) => {
            if (ldContext) {
              const trackData = makeNodeTrackData(node, def.key, runId);
              getClient().track('$ld:ai:graph:handoff_success', ldContext, trackData, 1);
            }

            path.push(node.key);
            const nodeStartTime = Date.now();

            const { output, usage } = await runForNode(node, subInput, childSubAgentTools);

            totalUsage.input += usage.input;
            totalUsage.output += usage.output;
            totalUsage.total += usage.total;

            if (ldContext) {
              const trackData = makeNodeTrackData(node, def.key, runId);
              const duration = Date.now() - nodeStartTime;
              getClient().track('$ld:ai:duration:total', ldContext, trackData, duration);
              getClient().track('$ld:ai:generation:success', ldContext, trackData, 1);
              if (usage.total > 0) getClient().track('$ld:ai:tokens:total', ldContext, trackData, usage.total);
              if (usage.input > 0) getClient().track('$ld:ai:tokens:input', ldContext, trackData, usage.input);
              if (usage.output > 0) getClient().track('$ld:ai:tokens:output', ldContext, trackData, usage.output);
            }

            return { content: [{ type: 'text' as const, text: output }] };
          },
        );

        subAgentToolCtx[node.key] = subAgentTool;
      });

      const root = def.root;
      if (!root) throw new Error(`Graph "${def.key}" has no root node`);

      // Run the root with its direct children available as sub-agent tools
      const rootChildSubAgentTools = root.edges.map((e) => subAgentToolCtx[e.targetKey]).filter(Boolean);

      path.push(root.key);
      const rootStartTime = Date.now();

      let finalOutput = '';
      let rootUsage = { input: 0, output: 0, total: 0 };

      try {
        const result = await runForNode(root, input, rootChildSubAgentTools);
        finalOutput = result.output;
        rootUsage = result.usage;
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

      totalUsage.input += rootUsage.input;
      totalUsage.output += rootUsage.output;
      totalUsage.total += rootUsage.total;

      if (ldContext) {
        const trackData = makeNodeTrackData(root, def.key, runId);
        const duration = Date.now() - rootStartTime;
        getClient().track('$ld:ai:duration:total', ldContext, trackData, duration);
        getClient().track('$ld:ai:generation:success', ldContext, trackData, 1);
        if (rootUsage.total > 0) getClient().track('$ld:ai:tokens:total', ldContext, trackData, rootUsage.total);
        if (rootUsage.input > 0) getClient().track('$ld:ai:tokens:input', ldContext, trackData, rootUsage.input);
        if (rootUsage.output > 0) getClient().track('$ld:ai:tokens:output', ldContext, trackData, rootUsage.output);
      }

      const graphDuration = Date.now() - startTime;

      span.setAttribute('launchdarkly.graph.path', path.join('->'));
      span.setAttribute('gen_ai.usage.input_tokens', totalUsage.input);
      span.setAttribute('gen_ai.usage.output_tokens', totalUsage.output);
      span.setAttribute('gen_ai.usage.total_tokens', totalUsage.total);

      if (ldContext) {
        const rootTrackData = makeNodeTrackData(root, def.key, runId);
        getClient().track('$ld:ai:graph:duration:total', ldContext, rootTrackData, graphDuration);
        getClient().track('$ld:ai:graph:total_tokens', ldContext, rootTrackData, totalUsage.total);
        getClient().track('$ld:ai:graph:path', ldContext, rootTrackData, path.length);
        getClient().track('$ld:ai:graph:invocation_success', ldContext, rootTrackData, 1);
      }

      span.end();
      return { response: finalOutput, usage: totalUsage };
    });
  };

  return { invoke };
};
