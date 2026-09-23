import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Hoisted mocks ────────────────────────────────────────────────────────────

const { mockTrack, mockVariation, mockExtractVariation } = vi.hoisted(() => ({
  mockTrack: vi.fn(),
  mockVariation: vi.fn(),
  mockExtractVariation: vi.fn(),
}));

vi.mock('../lifecycle.js', () => ({
  getClient: vi.fn().mockReturnValue({ track: mockTrack, variation: mockVariation }),
  initClient: vi.fn().mockResolvedValue(undefined),
  extractVariation: mockExtractVariation,
  shutdown: vi.fn(),
  waitForTelemetry: vi.fn(),
  shutdownTelemetry: vi.fn(),
}));

vi.mock('../judges.js', () => ({
  runJudges: vi.fn().mockResolvedValue({}),
}));

import { ConversationIdSpanProcessor, GEN_AI_CONVERSATION_ID, withConversationId } from '../conversation.js';
import { graph, resolveGraph } from '../graph.js';
import { getClient } from '../lifecycle.js';
import type { HandlerStreamEvent, ProviderHandler } from '../types.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const mockContext = { kind: 'user' as const, key: 'user-1' };

function makeAgentConfig(instructions = 'You are an agent.') {
  return {
    model: { name: 'gpt-4o' },
    provider: { name: 'OpenAI' },
    instructions,
  };
}

function makeMeta(mode: 'messages' | 'agent' = 'messages') {
  return { enabled: true, variationKey: 'v1', version: 1, mode };
}

function makeHandler(output = 'agent-response'): ProviderHandler {
  const h: ProviderHandler = vi.fn().mockResolvedValue({
    output,
    usage: { input_tokens: 2, output_tokens: 3 },
  });
  h.providesFor = ['OpenAI', 'messages'];
  return h;
}

async function* makeStreamGenerator(
  chunks: string[],
  usage: Record<string, unknown>,
): AsyncGenerator<HandlerStreamEvent> {
  for (const text of chunks) {
    yield { type: 'chunk', text };
  }
  yield { type: 'done', usage };
}

function makeStreamingHandler(
  chunks: string[] = ['hello', ' world'],
  usage: Record<string, unknown> = { input_tokens: 2, output_tokens: 3 },
): ProviderHandler {
  const h: ProviderHandler = vi.fn().mockResolvedValue({ output: chunks.join(''), usage });
  h.providesFor = ['OpenAI', 'messages'];
  h.stream = vi.fn().mockImplementation(() => makeStreamGenerator(chunks, usage));
  return h;
}

async function collectStream<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const events: T[] = [];
  for await (const event of gen) events.push(event);
  return events;
}

/** Sets up a two-node graph topology: root → leaf */
function setupTwoNodeGraph() {
  // Graph topology variation
  mockVariation.mockResolvedValue({
    root: 'root-node',
    edges: { 'root-node': [{ key: 'leaf-node' }] },
  });

  // Node config variations
  mockExtractVariation.mockImplementation(async (key: string) => {
    if (key === 'root-node') return { config: makeAgentConfig('I am root'), meta: makeMeta() };
    if (key === 'leaf-node') return { config: makeAgentConfig('I am leaf'), meta: makeMeta() };
    throw new Error(`Unknown node key: ${key}`);
  });
}

/** Root with two outgoing edges — exercises the multi-edge streamRoute branch. */
function setupBranchingGraph() {
  mockVariation.mockResolvedValue({
    root: 'root-node',
    edges: {
      'root-node': [{ key: 'agent-a' }, { key: 'agent-b' }],
    },
  });
  mockExtractVariation.mockImplementation(async (key: string) => {
    if (key === 'root-node') return { config: makeAgentConfig('I am root'), meta: makeMeta() };
    if (key === 'agent-a') return { config: makeAgentConfig('I am A'), meta: makeMeta() };
    if (key === 'agent-b') return { config: makeAgentConfig('I am B'), meta: makeMeta() };
    throw new Error(`Unknown node key: ${key}`);
  });
}

/**
 * Streaming handler that, when handoff tools are present (multi-edge route), invokes the
 * tool for `pickTarget`. Leaf nodes see no handoff tools and just stream text.
 */
function makeBranchPickingStreamHandler(pickTarget: string): ProviderHandler {
  const usage = { input_tokens: 1, output_tokens: 1 };
  const sanitized = pickTarget.replace(/[^a-zA-Z0-9_]/g, '_');
  const h: ProviderHandler = vi.fn().mockResolvedValue({ output: 'ok', usage });
  h.providesFor = ['OpenAI', 'messages'];
  h.stream = vi.fn().mockImplementation(async function* (
    _config: unknown,
    _input?: string,
    toolHandlers?: Record<string, (...args: unknown[]) => unknown>,
  ): AsyncGenerator<HandlerStreamEvent> {
    const handoff = Object.entries(toolHandlers ?? {}).find(([name]) => name === `__handoff_${sanitized}`);
    if (handoff) handoff[1]();
    yield { type: 'chunk', text: 'ok' };
    yield { type: 'done', usage };
  });
  return h;
}

function makeBranchPickingThenThrowStreamHandler(pickTarget: string, message: string): ProviderHandler {
  const sanitized = pickTarget.replace(/[^a-zA-Z0-9_]/g, '_');
  const h: ProviderHandler = vi.fn().mockResolvedValue({ output: 'ok', usage: { input_tokens: 1, output_tokens: 1 } });
  h.providesFor = ['OpenAI', 'messages'];
  h.stream = vi.fn().mockImplementation(async function* (
    _config: unknown,
    _input?: string,
    toolHandlers?: Record<string, (...args: unknown[]) => unknown>,
  ): AsyncGenerator<HandlerStreamEvent> {
    const handoff = Object.entries(toolHandlers ?? {}).find(([name]) => name === `__handoff_${sanitized}`);
    if (handoff) handoff[1]();
    throw new Error(message);
  });
  return h;
}

// ─── resolveGraph() ───────────────────────────────────────────────────────────

describe('resolveGraph()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTrack.mockReset();
    (getClient as ReturnType<typeof vi.fn>).mockReturnValue({ track: mockTrack, variation: mockVariation });
  });

  it('returns enabled: true when topology has a root', async () => {
    setupTwoNodeGraph();
    const def = await resolveGraph('graph-flag', { context: mockContext });
    expect(def.enabled).toBe(true);
  });

  it('copies modelKey and modelVersion from the graph _ldMeta onto graph-level event payloads', async () => {
    setupTwoNodeGraph();
    mockVariation.mockResolvedValue({
      _ldMeta: { enabled: true, variationKey: 'gv1', version: 2, modelKey: 'graph-model', modelVersion: 5 },
      root: 'root-node',
      edges: { 'root-node': [{ key: 'leaf-node' }] },
    });
    await graph('graph-flag', { handlers: [makeHandler()] }).invoke('hi', mockContext);
    const graphCalls = mockTrack.mock.calls.filter((c) => String(c[0]).startsWith('$ld:ai:graph:'));
    expect(graphCalls.length).toBeGreaterThan(0);
    for (const call of graphCalls) {
      expect(call[2]).toMatchObject({ modelKey: 'graph-model', modelVersion: 5 });
    }
  });

  it('omits modelKey and modelVersion from graph-level event payloads when _ldMeta lacks them', async () => {
    setupTwoNodeGraph();
    await graph('graph-flag', { handlers: [makeHandler()] }).invoke('hi', mockContext);
    const graphCalls = mockTrack.mock.calls.filter((c) => String(c[0]).startsWith('$ld:ai:graph:'));
    expect(graphCalls.length).toBeGreaterThan(0);
    for (const call of graphCalls) {
      expect('modelKey' in call[2]).toBe(false);
      expect('modelVersion' in call[2]).toBe(false);
    }
  });

  it('returns enabled: false when topology has no root', async () => {
    mockVariation.mockResolvedValue({ edges: {} });
    const def = await resolveGraph('graph-flag', { context: mockContext });
    expect(def.enabled).toBe(false);
  });

  it('returns enabled: false when variation is not a valid graph topology', async () => {
    mockVariation.mockResolvedValue({ someOtherField: 'value' });
    const def = await resolveGraph('graph-flag', { context: mockContext });
    expect(def.enabled).toBe(false);
  });

  it('returns enabled: false when a node variation throws', async () => {
    mockVariation.mockResolvedValue({ root: 'root-node' });
    mockExtractVariation.mockRejectedValue(new Error('disabled'));
    const def = await resolveGraph('graph-flag', { context: mockContext });
    expect(def.enabled).toBe(false);
  });

  it('logs the error when a node variation throws', async () => {
    const nodeError = new Error('node-disabled');
    mockVariation.mockResolvedValue({ root: 'root-node' });
    mockExtractVariation.mockRejectedValue(nodeError);
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await resolveGraph('graph-flag', { context: mockContext });
    expect(consoleSpy).toHaveBeenCalledWith(nodeError);
    consoleSpy.mockRestore();
  });

  it('getNode returns the correct GraphNode', async () => {
    setupTwoNodeGraph();
    const def = await resolveGraph('graph-flag', { context: mockContext });
    const root = def.getNode('root-node');
    expect(root).toBeDefined();
    expect(root?.config.instructions).toBe('I am root');
  });

  it('getChildNodes returns children for root', async () => {
    setupTwoNodeGraph();
    const def = await resolveGraph('graph-flag', { context: mockContext });
    const children = def.getChildNodes('root-node');
    expect(children).toHaveLength(1);
    expect(children[0].key).toBe('leaf-node');
  });

  it('getParentNodes returns correct parent', async () => {
    setupTwoNodeGraph();
    const def = await resolveGraph('graph-flag', { context: mockContext });
    const parents = def.getParentNodes('leaf-node');
    expect(parents).toHaveLength(1);
    expect(parents[0].key).toBe('root-node');
  });

  it('terminalNodes returns the leaf', async () => {
    setupTwoNodeGraph();
    const def = await resolveGraph('graph-flag', { context: mockContext });
    const terminals = def.terminalNodes();
    expect(terminals).toHaveLength(1);
    expect(terminals[0].key).toBe('leaf-node');
  });

  it('isTerminal is false for root and true for leaf', async () => {
    setupTwoNodeGraph();
    const def = await resolveGraph('graph-flag', { context: mockContext });
    expect(def.getNode('root-node')?.isTerminal()).toBe(false);
    expect(def.getNode('leaf-node')?.isTerminal()).toBe(true);
  });

  it('edgesFrom returns edges starting from root', async () => {
    setupTwoNodeGraph();
    const def = await resolveGraph('graph-flag', { context: mockContext });
    const edges = def.edgesFrom('root-node');
    expect(edges).toHaveLength(1);
    expect(edges[0].targetKey).toBe('leaf-node');
  });

  it('traverse visits root before leaf', async () => {
    setupTwoNodeGraph();
    const def = await resolveGraph('graph-flag', { context: mockContext });
    const visited: string[] = [];
    await def.traverse(async (node) => {
      visited.push(node.key);
    });
    expect(visited[0]).toBe('root-node');
    expect(visited[1]).toBe('leaf-node');
  });

  it('reverseTraverse visits leaf before root', async () => {
    setupTwoNodeGraph();
    const def = await resolveGraph('graph-flag', { context: mockContext });
    const visited: string[] = [];
    await def.reverseTraverse(async (node) => {
      visited.push(node.key);
    });
    expect(visited[0]).toBe('leaf-node');
    expect(visited[visited.length - 1]).toBe('root-node');
  });
});

// ─── graph().invoke() ───────────────────────────────────────────────────────────

describe('graph().invoke()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTrack.mockReset();
    (getClient as ReturnType<typeof vi.fn>).mockReturnValue({ track: mockTrack, variation: mockVariation });
  });

  it('throws when graph is disabled', async () => {
    mockVariation.mockResolvedValue({ someOtherField: 'value' });
    const handler = makeHandler();
    await expect(graph('graph-flag', { handlers: [handler] }).invoke('hi', mockContext)).rejects.toThrow(/disabled/i);
  });

  it('throws when no handlers are provided', async () => {
    setupTwoNodeGraph();
    await expect(graph('graph-flag', {}).invoke('hi', mockContext)).rejects.toThrow(/handlers/i);
  });

  it('visits all nodes and accumulates usage', async () => {
    setupTwoNodeGraph();
    const handler = makeHandler();
    const result = await graph('graph-flag', { handlers: [handler] }).invoke('hi', mockContext);
    expect(result.usage.total).toBeGreaterThan(0);
    expect(result.response).toBeDefined();
    expect((result as any).path).toBeUndefined();
    expect((result as any).nodes).toBeUndefined();
  });

  it('tracks $ld:ai:graph:invocation_success on success', async () => {
    setupTwoNodeGraph();
    const handler = makeHandler();
    await graph('graph-flag', { handlers: [handler] }).invoke('hi', mockContext);
    const eventNames = mockTrack.mock.calls.map((c: any[]) => c[0]);
    expect(eventNames).toContain('$ld:ai:graph:invocation_success');
  });

  it('tracks $ld:ai:graph:duration:total on success', async () => {
    setupTwoNodeGraph();
    const handler = makeHandler();
    await graph('graph-flag', { handlers: [handler] }).invoke('hi', mockContext);
    const eventNames = mockTrack.mock.calls.map((c: any[]) => c[0]);
    expect(eventNames).toContain('$ld:ai:graph:duration:total');
  });

  it('tracks $ld:ai:graph:path on success', async () => {
    setupTwoNodeGraph();
    const handler = makeHandler();
    await graph('graph-flag', { handlers: [handler] }).invoke('hi', mockContext);
    const pathCall = mockTrack.mock.calls.find((c: any[]) => c[0] === '$ld:ai:graph:path');
    expect(pathCall).toBeDefined();
  });

  it('tracks $ld:ai:graph:invocation_failure and re-throws on error', async () => {
    setupTwoNodeGraph();
    const errorHandler: ProviderHandler = vi.fn().mockRejectedValue(new Error('agent failed'));
    errorHandler.providesFor = ['OpenAI', 'messages'];
    await expect(graph('graph-flag', { handlers: [errorHandler] }).invoke('hi', mockContext)).rejects.toThrow(
      'agent failed',
    );
    const eventNames = mockTrack.mock.calls.map((c: any[]) => c[0]);
    expect(eventNames).toContain('$ld:ai:graph:invocation_failure');
  });

  it('does not revisit a node (cycle guard)', async () => {
    // Single-node graph with no edges — no infinite loop possible
    mockVariation.mockResolvedValue({ root: 'only-node', edges: {} });
    mockExtractVariation.mockResolvedValue({
      config: makeAgentConfig('I am alone'),
      meta: makeMeta(),
    });
    const handler = makeHandler();
    const result = await graph('graph-flag', { handlers: [handler] }).invoke('hi', mockContext);
    expect(result.response).toBeDefined();
  });

  it('tracks $ld:ai:graph:handoff_success when routing from root to leaf', async () => {
    setupTwoNodeGraph();
    const handler = makeHandler();
    await graph('graph-flag', { handlers: [handler] }).invoke('hi', mockContext);
    const handoffCall = mockTrack.mock.calls.find((c: any[]) => c[0] === '$ld:ai:graph:handoff_success');
    expect(handoffCall).toBeDefined();
    expect(handoffCall?.[2]).toMatchObject({ sourceKey: 'root-node', targetKey: 'leaf-node' });
  });

  it('resolves node variations only once per graph() instance across multiple invoke() invocations', async () => {
    setupTwoNodeGraph();
    const handler = makeHandler();
    const g = graph('graph-flag', { handlers: [handler] });
    await g.invoke('first', mockContext);
    const callCountAfterFirst = mockExtractVariation.mock.calls.length;
    await g.invoke('second', mockContext);
    const callCountAfterSecond = mockExtractVariation.mock.calls.length;
    // Variations for graph nodes should only be resolved once (at graph() construction),
    // not again on the second .invoke() invocation.
    expect(callCountAfterSecond).toBe(callCountAfterFirst);
  });

  it('does not leak variables from a prior call when the same context is reused', async () => {
    mockVariation.mockResolvedValue({ root: 'only-node', edges: {} });
    mockExtractVariation.mockResolvedValue({
      config: makeAgentConfig('I am alone'),
      meta: makeMeta(),
    });
    const handler = makeHandler();
    const g = graph('graph-flag', { handlers: [handler] });
    await g.invoke('first', mockContext, { tier: 'pro' });
    await g.invoke('second', mockContext);
    const secondCallVariables = (handler as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[3];
    expect(secondCallVariables?.tier).toBeUndefined();
    expect(secondCallVariables?.ldContext).toMatchObject(mockContext);
  });

  it('includes graphJudge results when graphJudge is configured', async () => {
    const judgeData = { 'graph-judge': { usage: { input: 1, output: 1, total: 2 }, response: 'ok', score: 0.8 } };
    const { runJudges } = await import('../judges.js');
    (runJudges as ReturnType<typeof vi.fn>).mockResolvedValue(judgeData);
    setupTwoNodeGraph();
    const handler = makeHandler();
    const result = await graph('graph-flag', { handlers: [handler], graphJudge: 'graph-judge' }).invoke(
      'hi',
      mockContext,
    );
    expect(runJudges).toHaveBeenCalled();
    expect(result.judgeResults).toEqual(judgeData);
  });

  it('forwards history as the 4th invoke arg to the root handler only', async () => {
    setupTwoNodeGraph();
    const calls: Array<{ input: unknown; history: unknown }> = [];
    const handler: ProviderHandler = vi.fn().mockImplementation(async (_cfg, input, _tools, _vars, history) => {
      calls.push({ input, history });
      return { output: 'ok', usage: { input_tokens: 1, output_tokens: 1 } };
    });
    handler.providesFor = ['OpenAI', 'messages'];

    const history = [
      {
        role: 'user' as const,
        content: [
          { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png', data: 'abc' } },
        ],
      },
    ];
    await graph('graph-flag', { handlers: [handler] }).invoke('hi', mockContext, undefined, history);

    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls[0].history).toEqual(history);
    expect(calls.slice(1).every((c) => c.history == null)).toBe(true);
  });

  it('omitted history leaves root handler history undefined', async () => {
    setupTwoNodeGraph();
    const handler = makeHandler();
    await graph('graph-flag', { handlers: [handler] }).invoke('hi', mockContext);
    expect((handler as ReturnType<typeof vi.fn>).mock.calls[0][4]).toBeUndefined();
  });
});

// ─── conversation id on ld.ai.graph ───────────────────────────────────────────
//
// The telemetry contract claims the conversation id lands on `ld.ai.graph` spans. True by
// construction — the shared processor stamps every span — but a graph span is created by
// `startActiveSpan` / `startSpan` deep inside the await / generator chain, so this guards the
// claim directly. Both invoke and stream tests share one TracerProvider: OTel's
// `setGlobalTracerProvider` ignores subsequent registrations, so a second describe with its
// own provider would never see the spans.

describe('graph() conversation id', () => {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new ConversationIdSpanProcessor(), new SimpleSpanProcessor(exporter)],
  });
  const tracer = provider.getTracer('@launchdarkly/ai-server');
  const contextManager = new AsyncLocalStorageContextManager();

  /**
   * Opens spans the way real handlers do: bare `startSpan` parents off `context.active()`,
   * so a correctly activated `ld.ai.graph` span becomes the parent. Without that activation,
   * these land as disconnected roots.
   */
  function makeSpanCreatingStreamHandler(chunks: string[] = ['ok']): ProviderHandler {
    const usage = { input_tokens: 2, output_tokens: 3 };
    const h: ProviderHandler = vi.fn().mockResolvedValue({ output: chunks.join(''), usage });
    h.providesFor = ['OpenAI', 'messages'];
    h.stream = vi.fn().mockImplementation(async function* (): AsyncGenerator<HandlerStreamEvent> {
      const root = tracer.startSpan('invoke_agent');
      for (const text of chunks) {
        const chat = tracer.startSpan('chat gpt-4o', undefined, trace.setSpan(context.active(), root));
        chat.end();
        yield { type: 'chunk', text };
      }
      root.end();
      yield { type: 'done', usage };
    });
    return h;
  }

  function makeSpanCreatingHandler(output = 'ok'): ProviderHandler {
    const h: ProviderHandler = vi.fn().mockImplementation(async () => {
      const root = tracer.startSpan('invoke_agent');
      const chat = tracer.startSpan('chat gpt-4o', undefined, trace.setSpan(context.active(), root));
      chat.end();
      root.end();
      return { output, usage: { input_tokens: 2, output_tokens: 3 } };
    });
    h.providesFor = ['OpenAI', 'messages'];
    return h;
  }

  beforeAll(() => {
    contextManager.enable();
    context.setGlobalContextManager(contextManager);
    trace.setGlobalTracerProvider(provider);
  });

  afterAll(async () => {
    context.disable();
    await provider.shutdown();
  });

  beforeEach(async () => {
    exporter.reset();
    vi.clearAllMocks();
    mockTrack.mockReset();
    (getClient as ReturnType<typeof vi.fn>).mockReturnValue({ track: mockTrack, variation: mockVariation });
    const { runJudges } = await import('../judges.js');
    (runJudges as ReturnType<typeof vi.fn>).mockReset();
    (runJudges as ReturnType<typeof vi.fn>).mockResolvedValue({});
  });

  it('stamps gen_ai.conversation.id on the ld.ai.graph span', async () => {
    setupTwoNodeGraph();
    const handler = makeHandler();

    await withConversationId('thread-graph', () =>
      graph('graph-flag', { handlers: [handler] }).invoke('hi', mockContext),
    );

    const graphSpan = exporter.getFinishedSpans().find((s) => s.name === 'ld.ai.graph');
    expect(graphSpan).toBeDefined();
    expect(graphSpan?.attributes[GEN_AI_CONVERSATION_ID]).toBe('thread-graph');
  });

  it('leaves the ld.ai.graph span unstamped when no id is bound', async () => {
    setupTwoNodeGraph();
    const handler = makeHandler();

    await graph('graph-flag', { handlers: [handler] }).invoke('hi', mockContext);

    const graphSpan = exporter.getFinishedSpans().find((s) => s.name === 'ld.ai.graph');
    expect(graphSpan?.attributes[GEN_AI_CONVERSATION_ID]).toBeUndefined();
  });

  it('stamps gen_ai.conversation.id on the ld.ai.graph span when stream is bound at call time', async () => {
    setupTwoNodeGraph();
    const handler = makeStreamingHandler(['ok']);

    const gen = withConversationId('thread-graph-stream', () =>
      graph('graph-flag', { handlers: [handler] }).stream('hi', mockContext),
    );
    await collectStream(gen);

    const graphSpan = exporter.getFinishedSpans().find((s) => s.name === 'ld.ai.graph');
    expect(graphSpan).toBeDefined();
    expect(graphSpan?.attributes[GEN_AI_CONVERSATION_ID]).toBe('thread-graph-stream');
  });

  it('nests handler spans under ld.ai.graph on the stream path (single trace)', async () => {
    setupTwoNodeGraph();
    const handler = makeSpanCreatingStreamHandler(['ok']);
    await collectStream(graph('graph-flag', { handlers: [handler] }).stream('hi', mockContext));

    const spans = exporter.getFinishedSpans();
    const graphSpan = spans.find((s) => s.name === 'ld.ai.graph');
    expect(graphSpan).toBeDefined();
    const graphId = graphSpan!.spanContext().spanId;
    const traceId = graphSpan!.spanContext().traceId;

    const byId = new Map(spans.map((s) => [s.spanContext().spanId, s]));
    const isUnderGraph = (span: (typeof spans)[number]): boolean => {
      if (span.name === 'ld.ai.graph') return true;
      let parentId = span.parentSpanContext?.spanId;
      const seen = new Set<string>();
      while (parentId && !seen.has(parentId)) {
        if (parentId === graphId) return true;
        seen.add(parentId);
        parentId = byId.get(parentId)?.parentSpanContext?.spanId;
      }
      return false;
    };

    for (const span of spans) {
      expect(span.spanContext().traceId).toBe(traceId);
      expect(isUnderGraph(span)).toBe(true);
    }
  });

  it('nests handler spans under ld.ai.graph on the invoke path (single trace)', async () => {
    setupTwoNodeGraph();
    const handler = makeSpanCreatingHandler();
    await graph('graph-flag', { handlers: [handler] }).invoke('hi', mockContext);

    const spans = exporter.getFinishedSpans();
    const graphSpan = spans.find((s) => s.name === 'ld.ai.graph');
    expect(graphSpan).toBeDefined();
    const graphId = graphSpan!.spanContext().spanId;
    const traceId = graphSpan!.spanContext().traceId;

    const byId = new Map(spans.map((s) => [s.spanContext().spanId, s]));
    const isUnderGraph = (span: (typeof spans)[number]): boolean => {
      if (span.name === 'ld.ai.graph') return true;
      let parentId = span.parentSpanContext?.spanId;
      const seen = new Set<string>();
      while (parentId && !seen.has(parentId)) {
        if (parentId === graphId) return true;
        seen.add(parentId);
        parentId = byId.get(parentId)?.parentSpanContext?.spanId;
      }
      return false;
    };

    for (const span of spans) {
      expect(span.spanContext().traceId).toBe(traceId);
      expect(isUnderGraph(span)).toBe(true);
    }
  });

  it('marks ld.ai.graph abandoned when the consumer breaks mid-stream', async () => {
    setupTwoNodeGraph();
    const handler = makeSpanCreatingStreamHandler(['a', 'b', 'c']);
    const gen = graph('graph-flag', { handlers: [handler] }).stream('hi', mockContext);

    for await (const event of gen) {
      if (event.type === 'chunk') break;
    }

    const graphSpan = exporter.getFinishedSpans().find((s) => s.name === 'ld.ai.graph');
    expect(graphSpan).toBeDefined();
    expect(graphSpan?.attributes['launchdarkly.stream.abandoned']).toBe(true);
    const eventNames = mockTrack.mock.calls.map((c: unknown[]) => c[0]);
    expect(eventNames).not.toContain('$ld:ai:graph:invocation_success');
  });

  it('parents ld.ai.graph to the caller span when the generator is iterated later', async () => {
    setupTwoNodeGraph();
    const handler = makeStreamingHandler(['ok']);
    const caller = tracer.startSpan('caller');

    // Build the generator inside the caller's scope and iterate after it exits — the shape a
    // request handler produces when it hands the stream off to a renderer.
    const gen = context.with(trace.setSpan(context.active(), caller), () =>
      graph('graph-flag', { handlers: [handler] }).stream('hi', mockContext),
    );
    await collectStream(gen);
    caller.end();

    const graphSpan = exporter.getFinishedSpans().find((s) => s.name === 'ld.ai.graph');
    expect(graphSpan).toBeDefined();
    expect(graphSpan?.parentSpanContext?.spanId).toBe(caller.spanContext().spanId);
    expect(graphSpan?.spanContext().traceId).toBe(caller.spanContext().traceId);
  });

  it('nests graph judge spans under ld.ai.graph on the stream path', async () => {
    setupTwoNodeGraph();
    const { runJudges } = await import('../judges.js');
    (runJudges as ReturnType<typeof vi.fn>).mockImplementation(
      async (args: { config?: { judgeConfiguration?: { judges?: { key: string }[] } } }) => {
        const isGraphJudge = args.config?.judgeConfiguration?.judges?.[0]?.key === 'graph-judge';
        // Judge handlers open spans off context.active(), same as provider handlers.
        const judgeSpan = tracer.startSpan(isGraphJudge ? 'judge_graph' : 'judge_node');
        judgeSpan.end();
        return isGraphJudge ? { 'graph-judge': { score: 1 } } : {};
      },
    );

    await collectStream(
      graph('graph-flag', { handlers: [makeStreamingHandler(['ok'])], graphJudge: 'graph-judge' }).stream(
        'hi',
        mockContext,
      ),
    );

    const spans = exporter.getFinishedSpans();
    const graphSpan = spans.find((s) => s.name === 'ld.ai.graph');
    const judgeSpan = spans.find((s) => s.name === 'judge_graph');
    expect(graphSpan).toBeDefined();
    expect(judgeSpan).toBeDefined();
    expect(judgeSpan?.spanContext().traceId).toBe(graphSpan?.spanContext().traceId);
    expect(judgeSpan?.parentSpanContext?.spanId).toBe(graphSpan?.spanContext().spanId);
  });
});

// ─── graph().stream() ─────────────────────────────────────────────────────────

describe('graph().stream()', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockTrack.mockReset();
    (getClient as ReturnType<typeof vi.fn>).mockReturnValue({ track: mockTrack, variation: mockVariation });
    const { runJudges } = await import('../judges.js');
    (runJudges as ReturnType<typeof vi.fn>).mockReset();
    (runJudges as ReturnType<typeof vi.fn>).mockResolvedValue({});
  });

  it('returns an async generator', () => {
    setupTwoNodeGraph();
    const handler = makeStreamingHandler();
    const gen = graph('graph-flag', { handlers: [handler] }).stream('hi', mockContext);
    expect(typeof gen[Symbol.asyncIterator]).toBe('function');
  });

  it('throws when graph is disabled', async () => {
    mockVariation.mockResolvedValue({ someOtherField: 'value' });
    const handler = makeStreamingHandler();
    const gen = graph('graph-flag', { handlers: [handler] }).stream('hi', mockContext);
    await expect(collectStream(gen)).rejects.toThrow(/disabled/i);
  });

  it('throws when no handlers are provided', async () => {
    setupTwoNodeGraph();
    const gen = graph('graph-flag', {}).stream('hi', mockContext);
    await expect(collectStream(gen)).rejects.toThrow(/handlers/i);
  });

  it('emits node_start for each visited node in order', async () => {
    setupTwoNodeGraph();
    const handler = makeStreamingHandler(['ok']);
    const events = await collectStream(graph('graph-flag', { handlers: [handler] }).stream('hi', mockContext));
    const starts = events.filter((e) => e.type === 'node_start');
    expect(starts.map((e) => (e as { nodeKey: string }).nodeKey)).toEqual(['root-node', 'leaf-node']);
  });

  it('forwards chunk events tagged with the active nodeKey', async () => {
    setupTwoNodeGraph();
    const handler = makeStreamingHandler(['Hi', '!']);
    const events = await collectStream(graph('graph-flag', { handlers: [handler] }).stream('hi', mockContext));
    const chunks = events.filter((e) => e.type === 'chunk');
    expect(chunks).toEqual([
      { type: 'chunk', text: 'Hi', nodeKey: 'root-node' },
      { type: 'chunk', text: '!', nodeKey: 'root-node' },
      { type: 'chunk', text: 'Hi', nodeKey: 'leaf-node' },
      { type: 'chunk', text: '!', nodeKey: 'leaf-node' },
    ]);
  });

  it('emits node_done after each node with response and usage', async () => {
    setupTwoNodeGraph();
    const handler = makeStreamingHandler(['Hi', '!'], { input_tokens: 2, output_tokens: 3 });
    const events = await collectStream(graph('graph-flag', { handlers: [handler] }).stream('hi', mockContext));
    const dones = events.filter((e) => e.type === 'node_done');
    expect(dones).toHaveLength(2);
    expect(dones[0]).toMatchObject({
      type: 'node_done',
      nodeKey: 'root-node',
      response: 'Hi!',
      usage: { input: 2, output: 3, total: 5 },
    });
    expect(dones[1]).toMatchObject({
      type: 'node_done',
      nodeKey: 'leaf-node',
      response: 'Hi!',
      usage: { input: 2, output: 3, total: 5 },
    });
  });

  it('emits handoff from root to leaf between node_done and next node_start', async () => {
    setupTwoNodeGraph();
    const handler = makeStreamingHandler(['ok']);
    const events = await collectStream(graph('graph-flag', { handlers: [handler] }).stream('hi', mockContext));
    const types = events.map((e) => e.type);
    const handoffIndex = types.indexOf('handoff');
    expect(handoffIndex).toBeGreaterThan(-1);
    expect(events[handoffIndex]).toEqual({
      type: 'handoff',
      sourceKey: 'root-node',
      targetKey: 'leaf-node',
    });
    expect(types[handoffIndex - 1]).toBe('node_done');
    expect(types[handoffIndex + 1]).toBe('node_start');
  });

  it('yields a final done event with leaf response and aggregate usage', async () => {
    setupTwoNodeGraph();
    const handler = makeStreamingHandler(['final'], { input_tokens: 2, output_tokens: 3 });
    const events = await collectStream(graph('graph-flag', { handlers: [handler] }).stream('hi', mockContext));
    const done = events.at(-1);
    expect(done).toMatchObject({
      type: 'done',
      response: 'final',
      usage: { input: 4, output: 6, total: 10 },
    });
    expect((done as { path?: unknown }).path).toBeUndefined();
    expect((done as { nodes?: unknown }).nodes).toBeUndefined();
  });

  it('places all lifecycle events before the final done', async () => {
    setupTwoNodeGraph();
    const handler = makeStreamingHandler(['a']);
    const events = await collectStream(graph('graph-flag', { handlers: [handler] }).stream('hi', mockContext));
    const doneIndex = events.findIndex((e) => e.type === 'done');
    expect(doneIndex).toBe(events.length - 1);
    const after = events.slice(doneIndex + 1);
    expect(after).toHaveLength(0);
  });

  it('tracks $ld:ai:graph:invocation_success on success', async () => {
    setupTwoNodeGraph();
    const handler = makeStreamingHandler(['ok']);
    await collectStream(graph('graph-flag', { handlers: [handler] }).stream('hi', mockContext));
    const eventNames = mockTrack.mock.calls.map((c: unknown[]) => c[0]);
    expect(eventNames).toContain('$ld:ai:graph:invocation_success');
  });

  it('tracks $ld:ai:graph:duration:total on success', async () => {
    setupTwoNodeGraph();
    const handler = makeStreamingHandler(['ok']);
    await collectStream(graph('graph-flag', { handlers: [handler] }).stream('hi', mockContext));
    const eventNames = mockTrack.mock.calls.map((c: unknown[]) => c[0]);
    expect(eventNames).toContain('$ld:ai:graph:duration:total');
  });

  it('tracks $ld:ai:graph:path on success', async () => {
    setupTwoNodeGraph();
    const handler = makeStreamingHandler(['ok']);
    await collectStream(graph('graph-flag', { handlers: [handler] }).stream('hi', mockContext));
    const pathCall = mockTrack.mock.calls.find((c: unknown[]) => c[0] === '$ld:ai:graph:path');
    expect(pathCall).toBeDefined();
  });

  it('tracks $ld:ai:graph:handoff_success when routing from root to leaf', async () => {
    setupTwoNodeGraph();
    const handler = makeStreamingHandler(['ok']);
    await collectStream(graph('graph-flag', { handlers: [handler] }).stream('hi', mockContext));
    const handoffCall = mockTrack.mock.calls.find((c: unknown[]) => c[0] === '$ld:ai:graph:handoff_success');
    expect(handoffCall).toBeDefined();
    expect(handoffCall?.[2]).toMatchObject({ sourceKey: 'root-node', targetKey: 'leaf-node' });
  });

  it('tracks $ld:ai:graph:invocation_failure and re-throws when a node stream throws', async () => {
    setupTwoNodeGraph();
    const err = new Error('stream boom');
    const handler = makeStreamingHandler();
    handler.stream = async function* () {
      throw err;
    };
    await expect(collectStream(graph('graph-flag', { handlers: [handler] }).stream('hi', mockContext))).rejects.toThrow(
      'stream boom',
    );
    const eventNames = mockTrack.mock.calls.map((c: unknown[]) => c[0]);
    expect(eventNames).toContain('$ld:ai:graph:invocation_failure');
  });

  it('emits per-node generation:success with graphKey on track data', async () => {
    setupTwoNodeGraph();
    const handler = makeStreamingHandler(['ok']);
    await collectStream(graph('graph-flag', { handlers: [handler] }).stream('hi', mockContext));
    const successCalls = mockTrack.mock.calls.filter((c: unknown[]) => c[0] === '$ld:ai:generation:success');
    expect(successCalls.length).toBeGreaterThanOrEqual(2);
    for (const call of successCalls) {
      expect(call[2]).toMatchObject({ graphKey: 'graph-flag' });
    }
  });

  it('falls back to the blocking handler when stream is not defined', async () => {
    setupTwoNodeGraph();
    const handler = makeHandler('blocked');
    const events = await collectStream(graph('graph-flag', { handlers: [handler] }).stream('hi', mockContext));
    const chunks = events.filter((e) => e.type === 'chunk');
    expect(chunks).toEqual([
      { type: 'chunk', text: 'blocked', nodeKey: 'root-node' },
      { type: 'chunk', text: 'blocked', nodeKey: 'leaf-node' },
    ]);
    expect(events.at(-1)).toMatchObject({ type: 'done', response: 'blocked' });
  });

  it('includes graphJudge results on the final done event', async () => {
    const judgeData = { 'graph-judge': { usage: { input: 1, output: 1, total: 2 }, response: 'ok', score: 0.8 } };
    const { runJudges } = await import('../judges.js');
    (runJudges as ReturnType<typeof vi.fn>).mockResolvedValue(judgeData);
    setupTwoNodeGraph();
    const handler = makeStreamingHandler(['final']);
    const events = await collectStream(
      graph('graph-flag', { handlers: [handler], graphJudge: 'graph-judge' }).stream('hi', mockContext),
    );
    expect(runJudges).toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({ type: 'done', judgeResults: judgeData });
  });

  it('omits judgeResults on done when judges return empty', async () => {
    const { runJudges } = await import('../judges.js');
    (runJudges as ReturnType<typeof vi.fn>).mockResolvedValue({});
    setupTwoNodeGraph();
    const handler = makeStreamingHandler(['final']);
    const events = await collectStream(
      graph('graph-flag', { handlers: [handler], graphJudge: 'graph-judge' }).stream('hi', mockContext),
    );
    const done = events.at(-1) as { judgeResults?: unknown };
    expect(done.judgeResults).toBeUndefined();
  });

  it('multi-edge route: model pick emits handoff_success from the route branch', async () => {
    setupBranchingGraph();
    const handler = makeBranchPickingStreamHandler('agent-b');
    await collectStream(graph('graph-flag', { handlers: [handler] }).stream('hi', mockContext));

    // Multi-edge fires once in streamRoute and again in streamNode(opts.from) on the leaf —
    // two events with the same source/target. Linear graphs only fire once from streamNode.
    const handoffCalls = mockTrack.mock.calls.filter((c: unknown[]) => c[0] === '$ld:ai:graph:handoff_success');
    expect(handoffCalls.length).toBe(2);
    expect(handoffCalls[0]?.[2]).toMatchObject({ sourceKey: 'root-node', targetKey: 'agent-b' });
  });

  it('multi-edge route: tracks handoff_failure when the node throws after choosing', async () => {
    setupBranchingGraph();
    const handler = makeBranchPickingThenThrowStreamHandler('agent-a', 'boom after choice');
    await expect(collectStream(graph('graph-flag', { handlers: [handler] }).stream('hi', mockContext))).rejects.toThrow(
      'boom after choice',
    );

    const failureCall = mockTrack.mock.calls.find((c: unknown[]) => c[0] === '$ld:ai:graph:handoff_failure');
    expect(failureCall).toBeDefined();
    expect(failureCall?.[2]).toMatchObject({ sourceKey: 'root-node', targetKey: 'agent-a' });
  });

  it('multi-edge route: judges receive the original node config, not handoff-augmented tools', async () => {
    const { runJudges } = await import('../judges.js');
    (runJudges as ReturnType<typeof vi.fn>).mockResolvedValue({});
    setupBranchingGraph();
    const handler = makeBranchPickingStreamHandler('agent-b');
    await collectStream(graph('graph-flag', { handlers: [handler] }).stream('hi', mockContext));

    const rootJudgeCall = (runJudges as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => (c[0] as { config?: { instructions?: string } })?.config?.instructions === 'I am root',
    );
    expect(rootJudgeCall).toBeDefined();
    const judgedConfig = (rootJudgeCall?.[0] as { config: { tools?: Record<string, unknown>; instructions: string } })
      .config;
    expect(judgedConfig.instructions).toBe('I am root');
    expect(Object.keys(judgedConfig.tools ?? {}).some((k) => k.startsWith('__handoff_'))).toBe(false);
  });

  it('multi-edge route: handoff tools and routing instructions match the blocking path', async () => {
    setupBranchingGraph();
    const handler = makeBranchPickingStreamHandler('agent-b');
    await collectStream(graph('graph-flag', { handlers: [handler] }).stream('hi', mockContext));

    const streamMock = handler.stream as ReturnType<typeof vi.fn>;
    const [rootConfig, , rootToolHandlers] = streamMock.mock.calls[0] as [
      { instructions: string; tools: Record<string, { description: string }> },
      unknown,
      Record<string, () => unknown>,
    ];

    // Tuned in #59: the prefix is unconditional, so a description sourced from the target's
    // own instructions cannot read as a tool that does the target's work.
    expect(rootConfig.tools.__handoff_agent_a.description).toBe('Transfer control to agent-a. I am A');
    expect(rootConfig.tools.__handoff_agent_b.description).toBe('Transfer control to agent-b. I am B');
    expect(rootConfig.instructions).toContain('Complete your task using your available tools first.');
    expect(rootToolHandlers.__handoff_agent_b()).toBe(
      'Handoff to agent-b recorded. Finish your own work and provide your final response.',
    );
  });
});
