/**
 * Compiles a LaunchDarkly agent graph into an ADK workflow.
 */
import { FunctionTool, InMemoryRunner, isFinalResponse, LlmAgent, START, Workflow } from '@google/adk';
import { getClient, makeNodeTrackData, parseTemplate } from '@launchdarkly/ai-server';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import { historyContents } from './handler.js';
import { usageCounts } from './spans.js';

const TRACER = '@launchdarkly/ai-google-adk-agents';

export interface AdkGraphNode {
  key: string;
  config?: {
    model?: { name?: string };
    provider?: { name?: string };
    instructions?: string;
    tools?: Record<string, { name?: string; description?: string; parameters?: unknown }>;
  };
  meta?: { variationKey?: string; version?: number };
  edges?: Array<{ targetKey?: string; target_key?: string }>;
  isTerminal?: boolean | (() => boolean);
}

export interface AdkGraphDefinition {
  enabled?: boolean;
  key: string;
  root: AdkGraphNode | null;
  getNode: (key: string) => AdkGraphNode;
}

export interface AdkGraphOptions {
  toolHandlers?: Record<string, (input: unknown) => unknown>;
}

export interface AdkGraphCallOptions {
  context?: Record<string, unknown>;
  variables?: Record<string, unknown>;
  history?: Array<{ role: string; content: unknown }>;
}

export function toAdkAgents(definition: AdkGraphDefinition, options: AdkGraphOptions = {}) {
  return {
    async call(
      userInput: string,
      callOptions: AdkGraphCallOptions = {},
    ): Promise<{ response: string; usage: { input: number; output: number; total: number } }> {
      if (definition.enabled === false) {
        throw new Error(`Graph ${definition.key} is disabled`);
      }
      if (!definition.root) throw new Error('Graph has no root');

      const ldContext = callOptions.context;
      const span = trace.getTracer(TRACER).startSpan('launchdarkly.graph');
      span.setAttribute('launchdarkly.graph.key', definition.key);
      const started = Date.now();
      const runId = crypto.randomUUID();
      const handoff: { target?: string } = {};
      const agents = buildAgents(definition, callOptions.variables ?? {}, options.toolHandlers ?? {}, handoff);
      const rootAgent = agents.get(definition.root.key);
      new Workflow({ name: 'graph', edges: [[START, rootAgent as never]] });

      const path: string[] = [];
      const usage = { input: 0, output: 0, total: 0 };
      let response = '';
      try {
        let current: AdkGraphNode | null = definition.root;
        const seen = new Set<string>();
        let history = callOptions.history;
        while (current && !seen.has(current.key)) {
          seen.add(current.key);
          path.push(current.key);
          handoff.target = undefined;
          const step = await runAgent(agents.get(current.key) as LlmAgent, userInput, history);
          history = undefined;
          response = step.response;
          usage.input += step.usage.input;
          usage.output += step.usage.output;
          usage.total += step.usage.total;
          const target = handoff.target;
          if (target && ldContext) {
            getClient().track(
              '$ld:ai:graph:handoff_success',
              ldContext as never,
              trackData(current, definition.key, runId),
              1,
            );
          }
          current = target ? definition.getNode(target) : null;
        }
        span.setAttribute('launchdarkly.graph.path', path.join('->'));
        span.setStatus({ code: SpanStatusCode.OK });
        if (ldContext) trackSuccess(definition.root, definition.key, runId, ldContext, path, usage, started);
        return { response, usage };
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        span.recordException(err);
        span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
        if (ldContext && definition.root) {
          getClient().track(
            '$ld:ai:graph:invocation_failure',
            ldContext as never,
            trackData(definition.root, definition.key, runId),
            1,
          );
        }
        throw error;
      } finally {
        span.end();
      }
    },
  };
}

function trackData(node: AdkGraphNode, graphKey: string, runId: string) {
  return makeNodeTrackData(
    {
      key: node.key,
      config: {
        model: { name: node.config?.model?.name ?? '' },
        provider: { name: node.config?.provider?.name ?? '' },
        instructions: node.config?.instructions ?? '',
      },
      meta: { variationKey: node.meta?.variationKey ?? '', version: node.meta?.version ?? 1 },
      edges: [],
      isTerminal: false,
    } as never,
    graphKey,
    runId,
  );
}

function trackSuccess(
  root: AdkGraphNode,
  graphKey: string,
  runId: string,
  ldContext: unknown,
  path: string[],
  usage: { total: number },
  started: number,
): void {
  const client = getClient();
  const data = trackData(root, graphKey, runId);
  client.track('$ld:ai:graph:duration:total', ldContext as never, data, Date.now() - started);
  client.track('$ld:ai:graph:total_tokens', ldContext as never, data, usage.total);
  client.track('$ld:ai:graph:path', ldContext as never, data, path.length);
  client.track('$ld:ai:graph:invocation_success', ldContext as never, data, 1);
}

function buildAgents(
  definition: AdkGraphDefinition,
  variables: Record<string, unknown>,
  toolHandlers: Record<string, (input: unknown) => unknown>,
  handoff: { target?: string },
): Map<string, LlmAgent> {
  const agents = new Map<string, LlmAgent>();
  if (definition.root) visit(definition, definition.root, agents, variables, toolHandlers, handoff);
  return agents;
}

function visit(
  definition: AdkGraphDefinition,
  node: AdkGraphNode,
  agents: Map<string, LlmAgent>,
  variables: Record<string, unknown>,
  toolHandlers: Record<string, (input: unknown) => unknown>,
  handoff: { target?: string },
): void {
  if (agents.has(node.key)) return;
  const tools: FunctionTool[] = [];
  const targets: string[] = [];
  for (const [name, spec] of Object.entries(node.config?.tools ?? {})) {
    const toolName = spec.name || name;
    const fn = toolHandlers[toolName] ?? toolHandlers[name];
    if (!fn) continue;
    tools.push(
      new FunctionTool({
        name: toolName,
        description: spec.description ?? '',
        parameters: spec.parameters as never,
        execute: async (input: unknown) => fn(input),
      }),
    );
  }
  for (const edge of node.edges ?? []) {
    const targetKey = edge.targetKey ?? edge.target_key;
    if (!targetKey) continue;
    targets.push(targetKey);
    tools.push(
      new FunctionTool({
        name: `transfer_to_${targetKey}`,
        description: `Transfer to ${targetKey}`,
        execute: () => {
          handoff.target = targetKey;
          return targetKey;
        },
      }),
    );
  }
  agents.set(
    node.key,
    new LlmAgent({
      name: node.key.replace(/[^A-Za-z0-9_]/g, '_') || 'agent',
      model: node.config?.model?.name ?? '',
      instruction: parseTemplate(node.config?.instructions ?? '', variables),
      tools,
    }),
  );
  for (const targetKey of targets)
    visit(definition, definition.getNode(targetKey), agents, variables, toolHandlers, handoff);
}

async function runAgent(
  agent: LlmAgent,
  userInput: string,
  history: Array<{ role: string; content: unknown }> | undefined,
): Promise<{ response: string; usage: { input: number; output: number; total: number } }> {
  const runner = new InMemoryRunner({ agent, appName: 'launchdarkly' });
  const sessionId = await sessionIdOf(runner);
  if (history?.length && runner.sessionService?.appendEvent) {
    const session = { id: sessionId, appName: 'launchdarkly', userId: 'user' };
    for (const content of historyContents(history)) {
      await runner.sessionService.appendEvent({
        session,
        event: { author: content.role, content },
      } as never);
    }
  }
  let response = '';
  const usage = { input: 0, output: 0, total: 0 };
  const message = { role: 'user', parts: [{ text: userInput }] } as never;
  for await (const event of runner.runAsync({ userId: 'user', sessionId, newMessage: message })) {
    if (!isFinalResponse(event)) continue;
    response = (event.content?.parts ?? []).map((part) => part.text ?? '').join('');
    const counts = usageCounts(event.usageMetadata);
    usage.input += counts.input;
    usage.output += counts.output;
    usage.total += counts.total;
  }
  return { response, usage };
}

async function sessionIdOf(runner: InMemoryRunner): Promise<string> {
  if (!runner.sessionService?.createSession) return 'session';
  const session = await runner.sessionService.createSession({ appName: 'launchdarkly', userId: 'user' });
  return session.id;
}
