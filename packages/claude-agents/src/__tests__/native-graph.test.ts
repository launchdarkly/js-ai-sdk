import type { GraphDefinition, GraphEdge, GraphNode } from '@launchdarkly/ai-server';
import { SpanStatusCode } from '@opentelemetry/api';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockQuery = vi.fn();
// Return an object with a `name` property so SUBAGENT_TOOL_PREFIX + tool.name works correctly
const mockTool = vi.fn().mockImplementation((...args: unknown[]) => ({ name: args[0] as string }));
const mockCreateSdkMcpServer = vi.fn().mockReturnValue({});
const mockTrack = vi.fn();

const mockGraphSpan = vi.hoisted(() => ({
  setAttribute: vi.fn(),
  addEvent: vi.fn(),
  setStatus: vi.fn(),
  recordException: vi.fn(),
  end: vi.fn(),
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  tool: (...args: unknown[]) => mockTool(...args),
  createSdkMcpServer: (...args: unknown[]) => mockCreateSdkMcpServer(...args),
}));

vi.mock('@opentelemetry/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@opentelemetry/api')>();
  return {
    ...actual,
    trace: {
      ...actual.trace,
      getTracer: vi.fn().mockReturnValue({
        startActiveSpan: vi
          .fn()
          .mockImplementation((_name: string, fn: (span: unknown) => unknown) => fn(mockGraphSpan)),
      }),
    },
  };
});

vi.mock('@launchdarkly/ai-server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@launchdarkly/ai-server')>();
  return {
    ...actual,
    getClient: () => ({ track: mockTrack }),
    // The real `tryGetEnvironmentId` reads the LD client's feature store, which no unit test has.
    // Stub the environment id onto the two track-data builders so the adapter's wiring can be
    // asserted here; the lookup itself is covered in the client package's own tests.
    makeGraphTrackData: (graphKey: string, runId: string) => ({
      ...actual.makeGraphTrackData(graphKey, runId),
      environmentId: 'env-123',
    }),
    makeNodeTrackData: (node: any, graphKey: string, runId: string) => ({
      ...actual.makeNodeTrackData(node, graphKey, runId),
      environmentId: 'env-123',
    }),
  };
});

import { NativeTool } from '@launchdarkly/ai-server';
import { toClaudeAgents } from '../native-graph.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeEdge(sourceKey: string, targetKey: string): GraphEdge {
  return { key: `${sourceKey}-${targetKey}`, sourceKey, targetKey };
}

function makeNode(key: string, edges: GraphEdge[] = []): GraphNode {
  return {
    key,
    config: {
      model: { name: 'claude-opus-4-5' },
      provider: { name: 'Anthropic' },
      instructions: `Instructions for ${key}`,
    },
    meta: { enabled: true, variationKey: 'v1', version: 1, mode: 'agent' },
    edges,
    isTerminal: () => edges.length === 0,
  };
}

function makeGraphDef(overrides: Partial<GraphDefinition> = {}): GraphDefinition {
  const leaf = makeNode('leaf');
  const root = makeNode('root', [makeEdge('root', 'leaf')]);

  return {
    key: 'test-graph',
    enabled: true,
    root,
    getNode: (key: string) => (key === 'root' ? root : key === 'leaf' ? leaf : undefined),
    getChildNodes: vi.fn().mockReturnValue([]),
    getParentNodes: vi.fn().mockReturnValue([]),
    terminalNodes: () => [leaf],
    edgesFrom: vi.fn().mockReturnValue([]),
    runNode: vi.fn(),
    route: vi.fn(),
    traverse: vi.fn(),
    reverseTraverse: async (fn, ctx = {}) => {
      await fn(leaf, ctx);
      await fn(root, ctx);
      return undefined;
    },
    ...overrides,
  };
}

function makeResultMessage(result = 'done', usage = { input_tokens: 1, output_tokens: 2 }) {
  return async function* () {
    yield { result, usage };
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('toClaudeAgents', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQuery.mockImplementation(makeResultMessage());
    for (const key of Object.keys(mockGraphSpan)) {
      (mockGraphSpan as any)[key].mockReset?.();
    }
  });

  it('throws when the graph is disabled', async () => {
    const def = makeGraphDef({ enabled: false });
    await expect(
      toClaudeAgents(Promise.resolve(def), { context: { kind: 'user', key: 'u' } }).invoke('hi'),
    ).rejects.toThrow(/disabled/i);
  });

  // B1: span.end() must be called on success
  it('ends the graph span on successful completion', async () => {
    const def = makeGraphDef();
    await toClaudeAgents(Promise.resolve(def)).invoke('hello');
    expect(mockGraphSpan.end).toHaveBeenCalled();
  });

  // B1: span.end() must be called on error
  it('ends the graph span when the root query throws', async () => {
    const def = makeGraphDef();
    mockQuery.mockImplementation(async function* () {
      throw new Error('boom');
    });
    await expect(toClaudeAgents(Promise.resolve(def)).invoke('hello')).rejects.toThrow('boom');
    expect(mockGraphSpan.end).toHaveBeenCalled();
  });

  // T5: one sub-agent tool per non-root node
  it('creates exactly one sub-agent tool for each non-root node', async () => {
    const def = makeGraphDef(); // root → leaf (1 non-root node)
    await toClaudeAgents(Promise.resolve(def)).invoke('hello');
    expect(mockTool).toHaveBeenCalledTimes(1);
    expect(mockTool.mock.calls[0][0]).toBe('leaf');
  });

  // T6: root query allowedTools contains mcp__subagents__ prefix
  it('passes child sub-agent tool names to root query allowedTools with mcp__subagents__ prefix', async () => {
    const def = makeGraphDef();
    await toClaudeAgents(Promise.resolve(def)).invoke('hello');
    const rootQueryOpts = mockQuery.mock.calls[0][0].options;
    expect(rootQueryOpts.allowedTools).toContain('mcp__subagents__leaf');
  });

  // T7: handoff_success tracking when sub-agent tool executor is invoked
  it('emits $ld:ai:graph:handoff_success when a sub-agent tool executor is invoked', async () => {
    const def = makeGraphDef();
    await toClaudeAgents(Promise.resolve(def), {
      context: { kind: 'user', key: 'user-1' },
    }).invoke('hello');

    // The 4th argument to tool() is the executor callback
    const toolExecutor = mockTool.mock.calls[0][3] as (args: { input: string }) => Promise<unknown>;
    await toolExecutor({ input: 'subtask' });

    expect(mockTrack).toHaveBeenCalledWith(
      '$ld:ai:graph:handoff_success',
      { kind: 'user', key: 'user-1' },
      expect.objectContaining({ configKey: 'leaf' }),
      1,
    );
    const leafNodes = mockTrack.mock.calls.filter(
      (c: unknown[]) => c[0] === '$ld:ai:graph:node' && (c[2] as { nodeKey?: string }).nodeKey === 'leaf',
    );
    expect(leafNodes).toHaveLength(1);
    expect(leafNodes[0][3]).toBe(1);
  });

  // T8: invocation_success tracking
  it('emits $ld:ai:graph:invocation_success on successful completion', async () => {
    const def = makeGraphDef();
    await toClaudeAgents(Promise.resolve(def), {
      context: { kind: 'user', key: 'user-1' },
    }).invoke('hello');

    expect(mockTrack).toHaveBeenCalledWith(
      '$ld:ai:graph:invocation_success',
      { kind: 'user', key: 'user-1' },
      expect.any(Object),
      1,
    );
    expect(mockTrack).toHaveBeenCalledWith(
      '$ld:ai:graph:node',
      { kind: 'user', key: 'user-1' },
      expect.objectContaining({ nodeKey: 'root', index: 0 }),
      1,
    );
    expect(mockTrack).not.toHaveBeenCalledWith(
      '$ld:ai:graph:path',
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it('tags the graph span with the run identity so LaunchDarkly can link the trace to the config', async () => {
    const def = makeGraphDef();
    await toClaudeAgents(Promise.resolve(def), { context: { kind: 'user', key: 'user-1' } }).invoke('hello');
    expect(mockGraphSpan.setAttribute).toHaveBeenCalledWith('launchdarkly.operation.type', 'gen_ai');
    expect(mockGraphSpan.setAttribute).toHaveBeenCalledWith('launchdarkly.config.key', 'test-graph');
    expect(mockGraphSpan.setAttribute).toHaveBeenCalledWith('launchdarkly.graph.key', 'test-graph');
    expect(mockGraphSpan.setAttribute).toHaveBeenCalledWith('launchdarkly.run.id', expect.any(String));
    expect(mockGraphSpan.setAttribute).toHaveBeenCalledWith('launchdarkly.variation.key', expect.any(String));
    expect(mockGraphSpan.setAttribute).toHaveBeenCalledWith('context.contextKeys.user', 'user-1');
    expect(mockGraphSpan.addEvent).toHaveBeenCalledWith('feature_flag', {
      'feature_flag.key': 'test-graph',
      'feature_flag.provider.name': 'LaunchDarkly',
      'feature_flag.set.id': 'env-123',
      'feature_flag.context.id': 'user-1',
      'feature_flag.contextKeys': '{"user":"user-1"}',
    });
  });

  it('keys the graph-level events to the graph, not the root node', async () => {
    await toClaudeAgents(Promise.resolve(makeGraphDef()), { context: { kind: 'user', key: 'user-1' } }).invoke('hello');
    const graphEvents = mockTrack.mock.calls.filter((c: unknown[]) =>
      ['$ld:ai:graph:invocation_success', '$ld:ai:graph:duration:total', '$ld:ai:graph:total_tokens'].includes(
        c[0] as string,
      ),
    );
    expect(graphEvents).toHaveLength(3);
    for (const call of graphEvents) {
      expect(call[2]).toEqual(expect.objectContaining({ configKey: 'test-graph', graphKey: 'test-graph' }));
    }
  });

  it('keys invocation_failure to the graph, not the root node', async () => {
    mockQuery.mockImplementation(async function* () {
      throw new Error('boom');
    });
    await expect(
      toClaudeAgents(Promise.resolve(makeGraphDef()), { context: { kind: 'user', key: 'user-1' } }).invoke('hello'),
    ).rejects.toThrow('boom');
    const failures = mockTrack.mock.calls.filter((c: unknown[]) => c[0] === '$ld:ai:graph:invocation_failure');
    expect(failures).toHaveLength(1);
    expect(failures[0][2]).toEqual(expect.objectContaining({ configKey: 'test-graph', graphKey: 'test-graph' }));
  });

  it('records a sub-agent build error on the graph span, tracks it as a failure, and ends the span once', async () => {
    const def = makeGraphDef({
      reverseTraverse: async () => {
        throw new Error('setup boom');
      },
    });
    await expect(
      toClaudeAgents(Promise.resolve(def), { context: { kind: 'user', key: 'user-1' } }).invoke('hello'),
    ).rejects.toThrow('setup boom');
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockGraphSpan.end).toHaveBeenCalledTimes(1);
    expect(mockGraphSpan.recordException).toHaveBeenCalledTimes(1);
    expect(mockGraphSpan.recordException).toHaveBeenCalledWith(expect.any(Error));
    expect(mockGraphSpan.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.ERROR, message: 'setup boom' });
    expect(mockGraphSpan.setStatus).not.toHaveBeenCalledWith({ code: SpanStatusCode.OK });
    const failures = mockTrack.mock.calls.filter((c: unknown[]) => c[0] === '$ld:ai:graph:invocation_failure');
    expect(failures).toHaveLength(1);
    expect(failures[0][2]).toEqual(expect.objectContaining({ configKey: 'test-graph', graphKey: 'test-graph' }));
  });

  it('puts the environment id on every node and graph tracking event', async () => {
    const def = makeGraphDef();
    await toClaudeAgents(Promise.resolve(def), { context: { kind: 'user', key: 'user-1' } }).invoke('hello');
    expect(mockTrack).toHaveBeenCalled();
    for (const call of mockTrack.mock.calls) {
      expect(call[2]).toEqual(expect.objectContaining({ environmentId: 'env-123' }));
    }
  });

  // T9: invocation_failure tracking
  it('emits $ld:ai:graph:invocation_failure when the root query throws', async () => {
    const def = makeGraphDef();
    mockQuery.mockImplementation(async function* () {
      throw new Error('root failed');
    });

    await expect(
      toClaudeAgents(Promise.resolve(def), {
        context: { kind: 'user', key: 'user-1' },
      }).invoke('hello'),
    ).rejects.toThrow('root failed');

    expect(mockTrack).toHaveBeenCalledWith(
      '$ld:ai:graph:invocation_failure',
      { kind: 'user', key: 'user-1' },
      expect.any(Object),
      1,
    );
  });

  // T10: system prompt forwarding from node instructions
  it('forwards config.instructions as systemPrompt to root query', async () => {
    const def = makeGraphDef();
    await toClaudeAgents(Promise.resolve(def)).invoke('hello');
    const rootQueryOpts = mockQuery.mock.calls[0][0].options;
    expect(rootQueryOpts.systemPrompt).toBe('Instructions for root');
  });

  // T11: final response comes from root query result
  it('returns the root query result as the final response', async () => {
    const def = makeGraphDef();
    mockQuery.mockImplementation(makeResultMessage('root answer'));
    const result = await toClaudeAgents(Promise.resolve(def)).invoke('hello');
    expect(result.response).toBe('root answer');
  });

  it('forwards history to the root query prompt as native Anthropic image blocks', async () => {
    const def = makeGraphDef();
    const history = [
      {
        role: 'user' as const,
        content: [
          { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png', data: 'abc123' } },
        ],
      },
    ];
    await toClaudeAgents(Promise.resolve(def)).invoke('describe', {}, history);
    const { prompt } = mockQuery.mock.calls[0][0];
    expect(typeof prompt === 'string').toBe(false);
    const chunks: unknown[] = [];
    for await (const chunk of prompt as AsyncIterable<unknown>) {
      chunks.push(chunk);
    }
    const serialized = JSON.stringify(chunks);
    expect(serialized).toContain('"type":"image"');
    expect(serialized).toContain('abc123');
  });

  it('runs the root with a plain string prompt when history is omitted', async () => {
    const def = makeGraphDef();
    await toClaudeAgents(Promise.resolve(def)).invoke('hello');
    expect(mockQuery.mock.calls[0][0].prompt).toBe('hello');
  });

  it('emits tool-call tracking when PreToolUse invokes a NativeTool stub', async () => {
    const def = makeGraphDef();
    const webSearch = new NativeTool(Symbol('ws'), 'WebSearch');

    let capturedHooks: { PreToolUse?: Array<{ hooks: Array<(input: unknown) => Promise<unknown>> }> } | undefined;
    mockQuery.mockImplementation(async function* (queryArgs: { options?: { hooks?: typeof capturedHooks } }) {
      capturedHooks = queryArgs.options?.hooks;
      yield { result: 'ok', usage: { input_tokens: 1, output_tokens: 1 } };
    });

    await toClaudeAgents(Promise.resolve(def), {
      context: { kind: 'user', key: 'user-1' },
      toolHandlers: { 'web-search': webSearch },
    }).invoke('hello');

    expect(capturedHooks?.PreToolUse).toBeDefined();
    const hook = capturedHooks?.PreToolUse?.[0].hooks[0];
    await hook({ hook_event_name: 'PreToolUse', tool_name: 'WebSearch' });

    expect(mockTrack).toHaveBeenCalledWith(
      '$ld:ai:tool_call',
      { kind: 'user', key: 'user-1' },
      expect.objectContaining({ toolKey: 'web-search' }),
      1,
    );
  });

  // ── root === null guard ──────────────────────────────────────────────────────

  it('throws when def.root is null even when graph is enabled', async () => {
    const def = makeGraphDef({ root: null as any });
    await expect(toClaudeAgents(Promise.resolve(def)).invoke('hi')).rejects.toThrow(/root/i);
  });

  // ── config.tools forwarded to node ──────────────────────────────────────────

  it('calls buildToolMCP with node config.tools when present', async () => {
    const nodeWithTools = makeNode('leaf', []);
    (nodeWithTools as any).config.tools = {
      search: { name: 'search', type: 'function', parameters: {}, description: 'Search' },
    };
    const root = makeNode('root', [makeEdge('root', 'leaf')]);

    const def = makeGraphDef({
      root,
      getNode: (key: string) => (key === 'root' ? root : key === 'leaf' ? nodeWithTools : undefined),
      reverseTraverse: async (fn: any, ctx: any = {}) => {
        await fn(nodeWithTools, ctx);
        await fn(root, ctx);
        return undefined;
      },
    });

    const myToolFn = vi.fn().mockResolvedValue('result');
    await toClaudeAgents(Promise.resolve(def), {
      toolHandlers: { search: myToolFn },
    }).invoke('hello');

    // The tool executor for the 'leaf' sub-agent tool invokes query() with mcpServers
    // We verify via the tool executor that it calls query with mcpServers set
    const leafToolExecutor = mockTool.mock.calls[0][3] as (args: { input: string }) => Promise<unknown>;
    mockQuery.mockClear();
    // Re-invoke the executor so the query mock records new calls
    await leafToolExecutor({ input: 'sub task' });
    const queryCall = mockQuery.mock.calls[0];
    expect(queryCall[0].options.mcpServers).toBeDefined();
  });

  // ── config.messages system prompt ────────────────────────────────────────────

  it('uses config.messages system entries as systemPrompt when instructions absent', async () => {
    const nodeWithMessages = {
      key: 'leaf',
      config: {
        model: { name: 'claude-opus-4-5' },
        provider: { name: 'Anthropic' },
        messages: [{ role: 'system', content: 'From messages system.' }],
      },
      meta: { enabled: true, variationKey: 'v1', version: 1, mode: 'agent' },
      edges: [],
      isTerminal: () => true,
    } as any;
    const rootWithMessages = {
      key: 'root',
      config: {
        model: { name: 'claude-opus-4-5' },
        provider: { name: 'Anthropic' },
        messages: [{ role: 'system', content: 'Root system from messages.' }],
      },
      meta: { enabled: true, variationKey: 'v1', version: 1, mode: 'agent' },
      edges: [makeEdge('root', 'leaf')],
      isTerminal: () => false,
    } as any;

    const def = makeGraphDef({
      root: rootWithMessages,
      getNode: (key: string) => (key === 'root' ? rootWithMessages : nodeWithMessages),
      reverseTraverse: async (fn: any, ctx: any = {}) => {
        await fn(nodeWithMessages, ctx);
        await fn(rootWithMessages, ctx);
        return undefined;
      },
    });

    await toClaudeAgents(Promise.resolve(def)).invoke('hello');

    // Root query receives systemPrompt from messages
    const rootQueryOpts = mockQuery.mock.calls[0][0].options;
    expect(rootQueryOpts.systemPrompt).toBe('Root system from messages.');
  });

  // ── Per-node token/duration tracking ─────────────────────────────────────────

  it('emits per-node $ld:ai:generation:success and $ld:ai:duration:total after root runs', async () => {
    const ctx = { kind: 'user' as const, key: 'u2' };
    mockQuery.mockImplementation(makeResultMessage('ok', { input_tokens: 3, output_tokens: 4 }));
    const def = makeGraphDef();
    await toClaudeAgents(Promise.resolve(def), { context: ctx }).invoke('hello');

    const eventNames = mockTrack.mock.calls.map((c: any[]) => c[0]);
    expect(eventNames).toContain('$ld:ai:generation:success');
    expect(eventNames).toContain('$ld:ai:duration:total');
    expect(eventNames).toContain('$ld:ai:tokens:total');
    expect(eventNames).toContain('$ld:ai:tokens:input');
    expect(eventNames).toContain('$ld:ai:tokens:output');
  });
});
