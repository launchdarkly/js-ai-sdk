import { AIMessage, SystemMessage } from '@langchain/core/messages';
import { SpanStatusCode } from '@opentelemetry/api';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Hoisted mocks ────────────────────────────────────────────────────────────

const mockSpan = vi.hoisted(() => ({
  setAttribute: vi.fn(),
  addEvent: vi.fn(),
  setStatus: vi.fn(),
  end: vi.fn(),
  recordException: vi.fn(),
}));

const mockTrack = vi.hoisted(() => vi.fn());

// StateGraph builder methods — shared across all tests, reset in beforeEach
const mockAddNode = vi.hoisted(() => vi.fn());
const mockAddEdge = vi.hoisted(() => vi.fn());
const mockAddConditionalEdges = vi.hoisted(() => vi.fn());
const mockCompile = vi.hoisted(() => vi.fn());
const mockCompiledInvoke = vi.hoisted(() => vi.fn());

// ─── Module mocks ─────────────────────────────────────────────────────────────

vi.mock('@langchain/langgraph', () => ({
  StateGraph: class {
    addNode = mockAddNode;
    addEdge = mockAddEdge;
    addConditionalEdges = mockAddConditionalEdges;
    compile = mockCompile;
  },
  Annotation: Object.assign(vi.fn().mockReturnValue({}), {
    Root: vi.fn().mockReturnValue({ State: {} }),
  }),
  addMessages: vi.fn(),
  Command: vi.fn(
    class {
      goto: string;
      constructor({ goto }: { goto: string }) {
        this.goto = goto;
      }
    },
  ),
  START: '__start__',
  END: '__end__',
}));

vi.mock('@langchain/langgraph/prebuilt', () => ({
  ToolNode: vi.fn(
    class {
      _tools: any[];
      constructor(tools: any[]) {
        this._tools = tools;
      }
    },
  ),
  toolsCondition: vi.fn(),
}));

vi.mock('@langchain/openai', () => ({
  ChatOpenAI: class {},
}));

vi.mock('@langchain/core/tools', () => ({
  tool: vi.fn().mockImplementation((fn, opts) => ({ _fn: fn, ...opts })),
}));

vi.mock('@opentelemetry/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@opentelemetry/api')>();
  return {
    ...actual,
    trace: {
      ...actual.trace,
      getTracer: vi.fn().mockReturnValue({
        startActiveSpan: vi.fn().mockImplementation((_name: string, fn: Function) => fn(mockSpan)),
        startSpan: vi.fn().mockReturnValue(mockSpan),
      }),
    },
  };
});

vi.mock('@launchdarkly/ai-server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@launchdarkly/ai-server')>();
  return {
    ...actual,
    getClient: vi.fn().mockReturnValue({ track: mockTrack }),
  };
});

import { toLangGraph } from '../native-graph.js';

// ─── Test helpers ─────────────────────────────────────────────────────────────

function makeNode(key: string, instructions = '', outgoingKeys: string[] = [], tools?: Record<string, any>) {
  return {
    key,
    config: {
      model: { name: 'gpt-4o' },
      provider: { name: 'LangChain' },
      instructions,
      tools,
    },
    meta: { variationKey: 'v1', version: 1 },
    isTerminal: () => outgoingKeys.length === 0,
    edges: [],
  } as any;
}

function makeEdge(sourceKey: string, targetKey: string) {
  return { key: `${sourceKey}-${targetKey}`, sourceKey, targetKey } as any;
}

function makeGraphDef(nodes: any[], edges: Record<string, any[]>, rootKey: string, enabled = true) {
  return {
    key: 'test-graph',
    enabled,
    root: enabled ? (nodes.find((n) => n.key === rootKey) ?? null) : null,
    edgesFrom: (key: string) => edges[key] ?? [],
    traverse: async (fn: (node: any) => Promise<void>) => {
      for (const node of nodes) {
        await fn(node);
      }
    },
  } as any;
}

function defaultMockResult() {
  return {
    messages: [
      new AIMessage({
        content: 'final answer',
        usage_metadata: { input_tokens: 5, output_tokens: 10, total_tokens: 15 },
      }),
    ],
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('toLangGraph', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCompile.mockReturnValue({ invoke: mockCompiledInvoke });
    mockCompiledInvoke.mockResolvedValue(defaultMockResult());
  });

  // ── Disabled graph / null root ─────────────────────────────────────────────

  it('throws when the graph is disabled', async () => {
    const def = makeGraphDef([], {}, 'root', false);
    await expect(toLangGraph(Promise.resolve(def)).invoke('hello')).rejects.toThrow(/disabled/);
  });

  it('throws when root is null (§2.x.3)', async () => {
    const def = { ...makeGraphDef([makeNode('root')], {}, 'root'), root: null };
    await expect(toLangGraph(Promise.resolve(def as any)).invoke('hello')).rejects.toThrow(/root/i);
  });

  // ── Two-node topology ───────────────────────────────────────────────────────

  it('registers a node for each graph node in the definition', async () => {
    const root = makeNode('root', 'Root instructions', ['leaf']);
    const leaf = makeNode('leaf', 'Leaf instructions', []);
    const def = makeGraphDef([root, leaf], { root: [makeEdge('root', 'leaf')] }, 'root');
    await toLangGraph(Promise.resolve(def)).invoke('hi');
    const registeredNames = mockAddNode.mock.calls.map((c: any[]) => c[0]);
    expect(registeredNames).toContain('root');
    expect(registeredNames).toContain('leaf');
  });

  it('wires the root node from START', async () => {
    const root = makeNode('root', '', ['leaf']);
    const leaf = makeNode('leaf', '', []);
    const def = makeGraphDef([root, leaf], { root: [makeEdge('root', 'leaf')] }, 'root');
    await toLangGraph(Promise.resolve(def)).invoke('hi');
    const edgeCalls: [string, string][] = mockAddEdge.mock.calls;
    expect(edgeCalls.some(([from]) => from === '__start__')).toBe(true);
    const startEdge = edgeCalls.find(([from]) => from === '__start__');
    expect(startEdge?.[1]).toBe('root');
  });

  it('wires a terminal leaf node to END', async () => {
    const root = makeNode('root', '', ['leaf']);
    const leaf = makeNode('leaf', '', []);
    const def = makeGraphDef([root, leaf], { root: [makeEdge('root', 'leaf')] }, 'root');
    await toLangGraph(Promise.resolve(def)).invoke('hi');
    const edgeCalls: [string, string][] = mockAddEdge.mock.calls;
    expect(edgeCalls.some(([from, to]) => from === 'leaf' && to === '__end__')).toBe(true);
  });

  // ── Handoff tools ───────────────────────────────────────────────────────────

  it('injects one transfer_to_ handoff tool per outgoing edge for a multi-child node', async () => {
    const { tool } = await import('@langchain/core/tools');
    const root = makeNode('root', '', ['child1', 'child2']);
    const child1 = makeNode('child1', '', []);
    const child2 = makeNode('child2', '', []);
    const def = makeGraphDef(
      [root, child1, child2],
      { root: [makeEdge('root', 'child1'), makeEdge('root', 'child2')] },
      'root',
    );
    await toLangGraph(Promise.resolve(def)).invoke('hi');
    // The root node call to tool() should include two handoff tools named transfer_to_child1 / transfer_to_child2
    const toolCalls = (tool as ReturnType<typeof vi.fn>).mock.calls;
    const handoffNames = toolCalls.map((c: any[]) => c[1]?.name).filter((n: string) => n?.startsWith('transfer_to_'));
    expect(handoffNames).toContain('transfer_to_child1');
    expect(handoffNames).toContain('transfer_to_child2');
  });

  it('injects no handoff tools for a terminal node', async () => {
    const { tool } = await import('@langchain/core/tools');
    const root = makeNode('root', '', []);
    const def = makeGraphDef([root], {}, 'root');
    await toLangGraph(Promise.resolve(def)).invoke('hi');
    const toolCalls = (tool as ReturnType<typeof vi.fn>).mock.calls;
    const handoffNames = toolCalls.map((c: any[]) => c[1]?.name).filter((n: string) => n?.startsWith('transfer_to_'));
    expect(handoffNames).toHaveLength(0);
  });

  // ── System prompt forwarding ────────────────────────────────────────────────

  it('passes config.instructions as a SystemMessage to the model', async () => {
    const mockModelInvoke = vi.fn().mockResolvedValue(
      new AIMessage({
        content: 'node result',
        usage_metadata: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
      }),
    );
    const mockModel = { invoke: mockModelInvoke, bindTools: vi.fn().mockReturnThis() };
    const modelFactory = vi.fn().mockReturnValue(mockModel);

    const root = makeNode('root', 'Be very helpful.', []);
    const def = makeGraphDef([root], {}, 'root');
    await toLangGraph(Promise.resolve(def), { modelFactory }).invoke('hi');

    // Extract the node function registered for 'root' and invoke it manually
    const rootNodeArgs = mockAddNode.mock.calls.find((c) => c[0] === 'root');
    expect(rootNodeArgs).toBeDefined();
    const rootNodeFn = rootNodeArgs?.[1];
    mockModelInvoke.mockClear();
    await rootNodeFn({ messages: [] });

    const messagesArg: any[] = mockModelInvoke.mock.calls[0][0];
    expect(messagesArg[0]).toBeInstanceOf(SystemMessage);
    expect(messagesArg[0].content).toBe('Be very helpful.');
  });

  // ── Output extraction ───────────────────────────────────────────────────────

  it('returns the content of the last AI message as response', async () => {
    const root = makeNode('root', '', []);
    const def = makeGraphDef([root], {}, 'root');
    const result = await toLangGraph(Promise.resolve(def)).invoke('hi');
    expect(result.response).toBe('final answer');
  });

  it('returns cumulative usage from the compiled graph result', async () => {
    const root = makeNode('root', '', []);
    const def = makeGraphDef([root], {}, 'root');
    const result = await toLangGraph(Promise.resolve(def)).invoke('hi');
    expect(result.usage.input).toBeGreaterThanOrEqual(0);
    expect(result.usage.output).toBeGreaterThanOrEqual(0);
  });

  // ── LD tracking ─────────────────────────────────────────────────────────────

  it('emits $ld:ai:graph:invocation_success on success', async () => {
    const ctx = { kind: 'user' as const, key: 'u1' };
    const root = makeNode('root', '', []);
    const def = makeGraphDef([root], {}, 'root');
    await toLangGraph(Promise.resolve(def), { context: ctx }).invoke('hi');
    expect(mockTrack).toHaveBeenCalledWith('$ld:ai:graph:invocation_success', ctx, expect.anything(), 1);
  });

  it('emits $ld:ai:graph:duration:total on success', async () => {
    const ctx = { kind: 'user' as const, key: 'u1' };
    const root = makeNode('root', '', []);
    const def = makeGraphDef([root], {}, 'root');
    await toLangGraph(Promise.resolve(def), { context: ctx }).invoke('hi');
    expect(mockTrack).toHaveBeenCalledWith('$ld:ai:graph:duration:total', ctx, expect.anything(), expect.any(Number));
  });

  it('emits $ld:ai:graph:invocation_failure when compiled.invoke throws', async () => {
    const ctx = { kind: 'user' as const, key: 'u1' };
    mockCompiledInvoke.mockRejectedValue(new Error('graph crash'));
    const root = makeNode('root', '', []);
    const def = makeGraphDef([root], {}, 'root');
    await expect(toLangGraph(Promise.resolve(def), { context: ctx }).invoke('hi')).rejects.toThrow('graph crash');
    expect(mockTrack).toHaveBeenCalledWith('$ld:ai:graph:invocation_failure', ctx, expect.anything(), 1);
  });

  // ── OTel span ────────────────────────────────────────────────────────────────

  it('sets launchdarkly.graph.key span attribute', async () => {
    const root = makeNode('root', '', []);
    const def = makeGraphDef([root], {}, 'root');
    await toLangGraph(Promise.resolve(def)).invoke('hi');
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('launchdarkly.graph.key', 'test-graph');
  });

  it('sets span status to OK on success', async () => {
    const root = makeNode('root', '', []);
    const def = makeGraphDef([root], {}, 'root');
    await toLangGraph(Promise.resolve(def)).invoke('hi');
    expect(mockSpan.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.OK });
  });

  it('sets span status to ERROR and records exception when compiled.invoke throws', async () => {
    const err = new Error('boom');
    mockCompiledInvoke.mockRejectedValue(err);
    const root = makeNode('root', '', []);
    const def = makeGraphDef([root], {}, 'root');
    await expect(toLangGraph(Promise.resolve(def)).invoke('hi')).rejects.toThrow('boom');
    expect(mockSpan.setStatus).toHaveBeenCalledWith(expect.objectContaining({ code: SpanStatusCode.ERROR }));
    expect(mockSpan.recordException).toHaveBeenCalledWith(expect.any(Error));
  });

  // ── Root null guard ──────────────────────────────────────────────────────────

  it('throws when def.root is null', async () => {
    const def = {
      key: 'test-graph',
      enabled: true,
      root: null,
      edgesFrom: () => [],
      traverse: async () => {},
    } as any;
    await expect(toLangGraph(Promise.resolve(def)).invoke('hi')).rejects.toThrow(/root/i);
  });

  // ── System prompt from config.messages ──────────────────────────────────────

  it('builds system prompt from config.messages when instructions absent', async () => {
    const mockModelInvoke = vi
      .fn()
      .mockResolvedValue(
        new AIMessage({ content: 'ok', usage_metadata: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }),
      );
    const mockModel = { invoke: mockModelInvoke, bindTools: vi.fn().mockReturnThis() };
    const modelFactory = vi.fn().mockReturnValue(mockModel);

    const nodeWithMessages = {
      key: 'root',
      config: {
        model: { name: 'gpt-4o' },
        provider: { name: 'LangChain' },
        messages: [{ role: 'system', content: 'Sys from messages.' }],
      },
      meta: { variationKey: 'v1', version: 1 },
      isTerminal: () => true,
      edges: [],
    } as any;

    const def = makeGraphDef([nodeWithMessages], {}, 'root');
    await toLangGraph(Promise.resolve(def), { modelFactory }).invoke('hi');

    const rootNodeArgs = mockAddNode.mock.calls.find((c: any[]) => c[0] === 'root');
    const rootNodeFn = rootNodeArgs?.[1];
    mockModelInvoke.mockClear();
    await rootNodeFn({ messages: [] });

    const messagesArg: any[] = mockModelInvoke.mock.calls[0][0];
    expect(messagesArg[0]).toBeInstanceOf(SystemMessage);
    expect(messagesArg[0].content).toBe('Sys from messages.');
  });

  // ── config.tools + ToolNode wiring ──────────────────────────────────────────

  it('creates a ToolNode when node has config.tools', async () => {
    const { ToolNode } = await import('@langchain/langgraph/prebuilt');
    const root = makeNode('root', 'instr', [], {
      myTool: { name: 'myTool', type: 'function' as const, parameters: { type: 'object' }, description: 'A tool' },
    });
    const def = makeGraphDef([root], {}, 'root');
    const myHandler = vi.fn().mockResolvedValue('result');
    await toLangGraph(Promise.resolve(def), { toolHandlers: { myTool: myHandler } }).invoke('hi');
    expect(ToolNode).toHaveBeenCalled();
  });

  // ── NativeTool returns empty string ─────────────────────────────────────────

  it('NativeTool in toolHandlers causes the tool to return an empty string', async () => {
    const { NativeTool } = await import('@launchdarkly/ai-server');
    const { tool } = await import('@langchain/core/tools');
    const nativeSentinel = new NativeTool(Symbol('test'), 'TestTool');
    const root = makeNode('root', 'instr', [], {
      myNativeTool: { name: 'myNativeTool', type: 'function' as const, parameters: { type: 'object' } },
    });
    const def = makeGraphDef([root], {}, 'root');
    await toLangGraph(Promise.resolve(def), { toolHandlers: { myNativeTool: nativeSentinel } }).invoke('hi');

    // Find the tool registered for myNativeTool and invoke it
    const toolCalls = (tool as ReturnType<typeof vi.fn>).mock.calls;
    const nativeToolCall = toolCalls.find((c: any[]) => c[1]?.name === 'myNativeTool');
    expect(nativeToolCall).toBeDefined();
    const toolFn = nativeToolCall?.[0];
    const result = await toolFn({});
    expect(result).toBe('');
  });

  // ── Per-node trackNode events ────────────────────────────────────────────────

  it('emits per-node $ld:ai:generation:success and $ld:ai:duration:total after each node', async () => {
    const ctx = { kind: 'user' as const, key: 'u1' };
    const mockModelInvoke = vi
      .fn()
      .mockResolvedValue(
        new AIMessage({ content: 'r', usage_metadata: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } }),
      );
    const mockModel = { invoke: mockModelInvoke, bindTools: vi.fn().mockReturnThis() };
    const modelFactory = vi.fn().mockReturnValue(mockModel);
    const root = makeNode('root', '', []);
    const def = makeGraphDef([root], {}, 'root');
    await toLangGraph(Promise.resolve(def), { context: ctx, modelFactory }).invoke('hi');

    // The node function is invoked via the compiled graph mock (defaultMockResult is used)
    // but we need the node function to actually run to emit trackNode events.
    // Extract the node function and invoke it directly.
    const rootNodeArgs = mockAddNode.mock.calls.find((c: any[]) => c[0] === 'root');
    const rootNodeFn = rootNodeArgs?.[1];
    mockTrack.mockClear();
    await rootNodeFn({ messages: [] });

    const eventNames = mockTrack.mock.calls.map((c: any[]) => c[0]);
    expect(eventNames).toContain('$ld:ai:generation:success');
    expect(eventNames).toContain('$ld:ai:duration:total');
    expect(eventNames).toContain('$ld:ai:tokens:total');
    expect(eventNames).toContain('$ld:ai:tokens:input');
    expect(eventNames).toContain('$ld:ai:tokens:output');
  });

  it('does not emit trackNode events when no context is provided', async () => {
    const mockModelInvoke = vi
      .fn()
      .mockResolvedValue(
        new AIMessage({ content: 'r', usage_metadata: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }),
      );
    const mockModel = { invoke: mockModelInvoke, bindTools: vi.fn().mockReturnThis() };
    const modelFactory = vi.fn().mockReturnValue(mockModel);
    const root = makeNode('root', '', []);
    const def = makeGraphDef([root], {}, 'root');
    mockTrack.mockClear();
    // No context passed
    await toLangGraph(Promise.resolve(def), { modelFactory }).invoke('hi');

    const rootNodeArgs = mockAddNode.mock.calls.find((c: any[]) => c[0] === 'root');
    const rootNodeFn = rootNodeArgs?.[1];
    mockTrack.mockClear();
    await rootNodeFn({ messages: [] });

    // No tracking at node level (ldContext is undefined)
    expect(mockTrack).not.toHaveBeenCalledWith(
      '$ld:ai:generation:success',
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  // ── transfer_to_* executor returns Command ───────────────────────────────────

  it('transfer_to_ handoff tool executor returns a Command with the target key', async () => {
    const { tool } = await import('@langchain/core/tools');
    const { Command } = await import('@langchain/langgraph');
    const root = makeNode('root', '', ['leaf']);
    const leaf = makeNode('leaf', '', []);
    const def = makeGraphDef([root, leaf], { root: [makeEdge('root', 'leaf')] }, 'root');
    await toLangGraph(Promise.resolve(def)).invoke('hi');

    const toolCalls = (tool as ReturnType<typeof vi.fn>).mock.calls;
    const handoffCall = toolCalls.find((c: any[]) => c[1]?.name === 'transfer_to_leaf');
    expect(handoffCall).toBeDefined();
    const handoffFn = handoffCall?.[0];
    const result = await handoffFn();
    expect(Command).toHaveBeenCalledWith(expect.objectContaining({ goto: 'leaf' }));
    expect((result as any).goto).toBe('leaf');
  });

  // ── extractUsage: missing usage_metadata ────────────────────────────────────

  it('handles AIMessage with no usage_metadata without throwing', async () => {
    const mockModelInvoke = vi.fn().mockResolvedValue(new AIMessage({ content: 'ok' }));
    const mockModel = { invoke: mockModelInvoke, bindTools: vi.fn().mockReturnThis() };
    const modelFactory = vi.fn().mockReturnValue(mockModel);
    const root = makeNode('root', '', []);
    const def = makeGraphDef([root], {}, 'root');
    await expect(toLangGraph(Promise.resolve(def), { modelFactory }).invoke('hi')).resolves.toBeDefined();
  });

  // ── AIMessage with array content ─────────────────────────────────────────────

  it('joins array text parts from the last AIMessage for the response', async () => {
    mockCompiledInvoke.mockResolvedValue({
      messages: [
        new AIMessage({
          content: [
            { type: 'text', text: 'Hello' },
            { type: 'text', text: ' world' },
          ] as any,
          usage_metadata: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
        }),
      ],
    });
    const root = makeNode('root', '', []);
    const def = makeGraphDef([root], {}, 'root');
    const result = await toLangGraph(Promise.resolve(def)).invoke('hi');
    expect(result.response).toBe('Hello world');
  });

  // ── OTel span attributes ─────────────────────────────────────────────────────

  it('sets launchdarkly.graph.path span attribute after traversal', async () => {
    const root = makeNode('root', '', []);
    const def = makeGraphDef([root], {}, 'root');
    await toLangGraph(Promise.resolve(def)).invoke('hi');
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('launchdarkly.graph.path', expect.any(String));
  });

  it('sets gen_ai.usage.* span attributes on success', async () => {
    const root = makeNode('root', '', []);
    const def = makeGraphDef([root], {}, 'root');
    await toLangGraph(Promise.resolve(def)).invoke('hi');
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('gen_ai.usage.input_tokens', expect.any(Number));
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('gen_ai.usage.output_tokens', expect.any(Number));
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('gen_ai.usage.total_tokens', expect.any(Number));
  });
});
