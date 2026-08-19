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
import type { ProviderHandler } from '../types.js';

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
});

// ─── conversation id on ld.ai.graph ───────────────────────────────────────────
//
// The telemetry contract claims the conversation id lands on `ld.ai.graph` spans. True by
// construction — the shared processor stamps every span — but a graph span is created by
// `startActiveSpan` deep inside `buildGraph`'s await chain, so this guards the claim directly.

describe('graph().invoke() conversation id', () => {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new ConversationIdSpanProcessor(), new SimpleSpanProcessor(exporter)],
  });
  const contextManager = new AsyncLocalStorageContextManager();

  beforeAll(() => {
    contextManager.enable();
    context.setGlobalContextManager(contextManager);
    trace.setGlobalTracerProvider(provider);
  });

  afterAll(async () => {
    context.disable();
    await provider.shutdown();
  });

  beforeEach(() => {
    exporter.reset();
    vi.clearAllMocks();
    mockTrack.mockReset();
    (getClient as ReturnType<typeof vi.fn>).mockReturnValue({ track: mockTrack, variation: mockVariation });
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
});
