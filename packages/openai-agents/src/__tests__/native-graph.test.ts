import { SpanStatusCode } from '@opentelemetry/api';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockAgentConstructor = vi.hoisted(() => vi.fn());
const mockHandoff = vi.hoisted(() => vi.fn().mockImplementation((agent: any) => ({ __handoff: true, agent })));
const mockTool = vi.hoisted(() => vi.fn().mockImplementation(({ execute, ...rest }: any) => ({ ...rest, execute })));
const mockRunnerRun = vi.hoisted(() => vi.fn());

// Track all Agent instances in construction order
const createdAgents: any[] = [];
// Capture event handlers registered via runner.on()
const capturedEventHandlers: Record<string, Function> = {};

vi.mock('@openai/agents', () => ({
  Agent: class {
    name: string;
    _config: any;
    constructor(args: any) {
      mockAgentConstructor(args);
      this.name = args.name;
      this._config = args;
      createdAgents.push(this);
    }
  },
  Runner: class {
    on(event: string, handler: Function) {
      capturedEventHandlers[event] = handler;
    }
    run = mockRunnerRun;
  },
  handoff: mockHandoff,
  tool: mockTool,
}));

const mockSpan = vi.hoisted(() => ({
  setAttribute: vi.fn(),
  setStatus: vi.fn(),
  end: vi.fn(),
  recordException: vi.fn(),
}));

vi.mock('@opentelemetry/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@opentelemetry/api')>();
  return {
    ...actual,
    trace: {
      ...actual.trace,
      getTracer: vi.fn().mockReturnValue({
        startActiveSpan: vi.fn().mockImplementation((_name: string, fn: Function) => fn(mockSpan)),
      }),
    },
  };
});

const mockTrack = vi.hoisted(() => vi.fn());
vi.mock('@launchdarkly/ai-server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@launchdarkly/ai-server')>();
  return {
    ...actual,
    getClient: vi.fn().mockReturnValue({ track: mockTrack }),
    parseTemplate: (template: string) => template,
  };
});

import { toOpenAIAgents } from '../native-graph.js';

// ─── Fixture helpers ──────────────────────────────────────────────────────────

function makeNode(key: string, instructions?: string, edgeTargetKeys: string[] = []) {
  return {
    key,
    config: {
      model: { name: 'gpt-4o' },
      provider: { name: 'OpenAI' },
      ...(instructions !== undefined ? { instructions } : {}),
    },
    meta: { variationKey: `${key}-var`, version: 1 },
    edges: edgeTargetKeys.map((targetKey) => ({ targetKey, key: `${key}-${targetKey}` })),
    isTerminal: () => edgeTargetKeys.length === 0,
  };
}

/** Creates a simple two-node graph: root → leaf */
function makeTwoNodeGraph() {
  const leafNode = makeNode('leaf-agent', 'I am the leaf.');
  const rootNode = makeNode('root-agent', 'I am the root.', ['leaf-agent']);

  return {
    enabled: true,
    key: 'test-graph',
    root: rootNode,
    getNode: (key: string) => (key === 'root-agent' ? rootNode : key === 'leaf-agent' ? leafNode : null),
    reverseTraverse: async <T>(fn: (node: any, ctx: Record<string, T>) => Promise<void>) => {
      const ctx: Record<string, T> = {};
      await fn(leafNode, ctx); // leaf-first (reverse BFS)
      await fn(rootNode, ctx);
    },
  };
}

function makeRunResult(finalOutput = 'final response', inputTokens = 5, outputTokens = 3) {
  return {
    finalOutput,
    state: { usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens } },
  };
}

const ldContext = { kind: 'user' as const, key: 'u1' };

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('toOpenAIAgents', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createdAgents.length = 0;
    for (const key of Object.keys(capturedEventHandlers)) {
      delete capturedEventHandlers[key];
    }
    Object.values(mockSpan).forEach((fn) => (fn as any).mockReset?.());
    mockRunnerRun.mockResolvedValue(makeRunResult());
  });

  // ── Disabled / null-root guards ───────────────────────────────────────────

  it('throws when graph is disabled', async () => {
    const def = { ...makeTwoNodeGraph(), enabled: false };
    await expect(toOpenAIAgents(Promise.resolve(def as any)).invoke('hi')).rejects.toThrow(/disabled/i);
  });

  it('throws when root is null', async () => {
    const def = { ...makeTwoNodeGraph(), root: null };
    await expect(toOpenAIAgents(Promise.resolve(def as any)).invoke('hi')).rejects.toThrow(/root/i);
  });

  // ── Topology translation ──────────────────────────────────────────────────

  it('creates one Agent per node in a two-node graph', async () => {
    await toOpenAIAgents(Promise.resolve(makeTwoNodeGraph())).invoke('hi');
    expect(mockAgentConstructor).toHaveBeenCalledTimes(2);
  });

  it('terminal node is constructed without handoffs', async () => {
    await toOpenAIAgents(Promise.resolve(makeTwoNodeGraph())).invoke('hi');
    // Leaf is constructed first (reverseTraverse = leaf-first)
    const leafArgs = mockAgentConstructor.mock.calls[0][0];
    expect(leafArgs.handoffs ?? []).toHaveLength(0);
  });

  it('non-terminal root node is constructed with handoff to child', async () => {
    await toOpenAIAgents(Promise.resolve(makeTwoNodeGraph())).invoke('hi');
    const rootArgs = mockAgentConstructor.mock.calls[1][0];
    expect(rootArgs.handoffs).toHaveLength(1);
    // handoff() was called with the leaf agent (first created)
    expect(mockHandoff).toHaveBeenCalledWith(createdAgents[0]);
  });

  it('calls Runner.run with the root agent and the input string', async () => {
    await toOpenAIAgents(Promise.resolve(makeTwoNodeGraph())).invoke('test input');
    // Root is the second agent created (leaf was first)
    expect(mockRunnerRun).toHaveBeenCalledWith(createdAgents[1], 'test input');
  });

  it('forwards history to root Runner.run as structured input', async () => {
    const history = [
      {
        role: 'user' as const,
        content: [
          { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png', data: 'abc123' } },
        ],
      },
    ];
    await toOpenAIAgents(Promise.resolve(makeTwoNodeGraph())).invoke('describe', {}, history);
    const input = mockRunnerRun.mock.calls[0][1];
    expect(Array.isArray(input)).toBe(true);
    expect(JSON.stringify(input)).toContain('input_image');
    expect(JSON.stringify(input)).toContain('abc123');
  });

  // ── Instructions forwarding ───────────────────────────────────────────────

  it('forwards node instructions to each Agent constructor', async () => {
    await toOpenAIAgents(Promise.resolve(makeTwoNodeGraph())).invoke('hi');
    expect(mockAgentConstructor.mock.calls[0][0].instructions).toBe('I am the leaf.');
    expect(mockAgentConstructor.mock.calls[1][0].instructions).toBe('I am the root.');
  });

  it('omits instructions property when node has none', async () => {
    const leafNode = makeNode('leaf-agent'); // no instructions
    const rootNode = makeNode('root-agent', 'Root prompt.', ['leaf-agent']);
    const def = {
      ...makeTwoNodeGraph(),
      root: rootNode,
      getNode: (key: string) => (key === 'root-agent' ? rootNode : leafNode),
      reverseTraverse: async <T>(fn: any) => {
        const ctx: Record<string, T> = {};
        await fn(leafNode, ctx);
        await fn(rootNode, ctx);
      },
    };
    await toOpenAIAgents(Promise.resolve(def as any)).invoke('hi');
    expect(mockAgentConstructor.mock.calls[0][0].instructions).toBeUndefined();
  });

  // ── Return value ──────────────────────────────────────────────────────────

  it('returns { response, usage } from the runner result', async () => {
    mockRunnerRun.mockResolvedValue(makeRunResult('hello world', 10, 6));
    const result = await toOpenAIAgents(Promise.resolve(makeTwoNodeGraph())).invoke('q');
    expect(result.response).toBe('hello world');
    expect(result.usage).toEqual({ input: 10, output: 6, total: 16 });
  });

  // ── LD Telemetry ──────────────────────────────────────────────────────────

  it('agent_end callback emits $ld:ai:generation:success', async () => {
    mockRunnerRun.mockImplementation(async () => {
      capturedEventHandlers.agent_end?.({}, { name: 'root-agent' }, 'output');
      return makeRunResult();
    });
    await toOpenAIAgents(Promise.resolve(makeTwoNodeGraph()), { context: ldContext }).invoke('hi');
    expect(mockTrack).toHaveBeenCalledWith('$ld:ai:generation:success', ldContext, expect.any(Object), 1);
  });

  it('agent_handoff callback emits $ld:ai:graph:handoff_success', async () => {
    mockRunnerRun.mockImplementation(async () => {
      capturedEventHandlers.agent_handoff?.({}, { name: 'root-agent' }, { name: 'leaf-agent' });
      return makeRunResult();
    });
    await toOpenAIAgents(Promise.resolve(makeTwoNodeGraph()), { context: ldContext }).invoke('hi');
    expect(mockTrack).toHaveBeenCalledWith('$ld:ai:graph:handoff_success', ldContext, expect.any(Object), 1);
  });

  it('emits invocation_success, duration, total_tokens, and path on success', async () => {
    await toOpenAIAgents(Promise.resolve(makeTwoNodeGraph()), { context: ldContext }).invoke('hi');
    expect(mockTrack).toHaveBeenCalledWith('$ld:ai:graph:invocation_success', ldContext, expect.any(Object), 1);
    expect(mockTrack).toHaveBeenCalledWith(
      '$ld:ai:graph:duration:total',
      ldContext,
      expect.any(Object),
      expect.any(Number),
    );
    expect(mockTrack).toHaveBeenCalledWith(
      '$ld:ai:graph:total_tokens',
      ldContext,
      expect.any(Object),
      expect.any(Number),
    );
    expect(mockTrack).toHaveBeenCalledWith('$ld:ai:graph:path', ldContext, expect.any(Object), expect.any(Number));
  });

  it('emits invocation_failure and re-throws when runner.run rejects', async () => {
    const err = new Error('runner crashed');
    mockRunnerRun.mockRejectedValue(err);
    await expect(
      toOpenAIAgents(Promise.resolve(makeTwoNodeGraph()), { context: ldContext }).invoke('hi'),
    ).rejects.toThrow('runner crashed');
    expect(mockTrack).toHaveBeenCalledWith('$ld:ai:graph:invocation_failure', ldContext, expect.any(Object), 1);
  });

  it('does not call track when no context is provided', async () => {
    await toOpenAIAgents(Promise.resolve(makeTwoNodeGraph())).invoke('hi');
    expect(mockTrack).not.toHaveBeenCalled();
  });

  // ── OTel span lifecycle ───────────────────────────────────────────────────

  it('sets ld.ai.graph.key span attribute on success', async () => {
    await toOpenAIAgents(Promise.resolve(makeTwoNodeGraph())).invoke('hi');
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('ld.ai.graph.key', 'test-graph');
    expect(mockSpan.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.OK });
    expect(mockSpan.end).toHaveBeenCalled();
  });

  it('records exception and ends span on runner error', async () => {
    const err = new Error('span test error');
    mockRunnerRun.mockRejectedValue(err);
    await expect(toOpenAIAgents(Promise.resolve(makeTwoNodeGraph())).invoke('hi')).rejects.toThrow();
    expect(mockSpan.recordException).toHaveBeenCalledWith(err);
    expect(mockSpan.setStatus).toHaveBeenCalledWith(expect.objectContaining({ code: SpanStatusCode.ERROR }));
    expect(mockSpan.end).toHaveBeenCalled();
  });

  // ── sanitizeName truncation ───────────────────────────────────────────────

  it('truncates agent names to 64 characters', async () => {
    const longKey = 'a'.repeat(80);
    const leafNode = makeNode(longKey, 'Leaf.') as any;
    const rootNode = makeNode('root', 'Root.', [longKey]);
    const def = {
      enabled: true,
      key: 'test-graph',
      root: rootNode,
      getNode: (key: string) => (key === 'root' ? rootNode : key === longKey ? leafNode : null),
      reverseTraverse: async <T>(fn: (node: any, ctx: Record<string, T>) => Promise<void>) => {
        const ctx: Record<string, T> = {};
        await fn(leafNode, ctx);
        await fn(rootNode, ctx);
      },
    };
    await toOpenAIAgents(Promise.resolve(def as any)).invoke('hi');
    const agentNames = mockAgentConstructor.mock.calls.map((c: any[]) => c[0].name);
    // The long-key agent's name must be at most 64 characters
    expect(agentNames[0].length).toBeLessThanOrEqual(64);
  });

  // ── agent_start hook ─────────────────────────────────────────────────────

  it('agent_start hook pushes node to path', async () => {
    mockRunnerRun.mockImplementation(async () => {
      // Simulate agent_start firing for the root agent
      capturedEventHandlers.agent_start?.({}, { name: 'root-agent' });
      return makeRunResult();
    });
    await toOpenAIAgents(Promise.resolve(makeTwoNodeGraph()), { context: ldContext }).invoke('hi');
    // Verify $ld:ai:graph:path was tracked with a value >= 1 (path includes root)
    expect(mockTrack).toHaveBeenCalledWith('$ld:ai:graph:path', ldContext, expect.anything(), expect.any(Number));
  });

  it('agent_start does not add a duplicate key when on_handoff already added it', async () => {
    let capturedPath: string[] | undefined;
    mockRunnerRun.mockImplementation(async () => {
      // Simulate on_handoff adding the leaf node key first (as the real handoff hook does)
      capturedEventHandlers.agent_handoff?.({}, { name: 'root-agent' }, { name: 'leaf-agent' });
      // Then simulate agent_start firing for the same leaf node
      capturedEventHandlers.agent_start?.({}, { name: 'leaf-agent' });
      // Capture path length via the track call
      return makeRunResult();
    });
    await toOpenAIAgents(Promise.resolve(makeTwoNodeGraph()), { context: ldContext }).invoke('hi');
    // $ld:ai:graph:path is tracked with path.length — leaf-agent should appear exactly once
    const pathCall = mockTrack.mock.calls.find((c: any[]) => c[0] === '$ld:ai:graph:path');
    // leaf-agent was added once by handoff, agent_start should NOT add it again
    // path.length should be 1 (only leaf-agent, since root agent_start never fired)
    expect(pathCall).toBeDefined();
    expect(pathCall[3]).toBe(1);
  });

  // ── config.messages system prompt ────────────────────────────────────────

  it('builds instructions from config.messages when instructions absent', async () => {
    const leafNode = {
      key: 'leaf-agent',
      config: {
        model: { name: 'gpt-4o' },
        provider: { name: 'OpenAI' },
        messages: [{ role: 'system', content: 'From messages.' }],
      },
      meta: { variationKey: 'leaf-var', version: 1 },
      edges: [],
      isTerminal: () => true,
    };
    const rootNode = makeNode('root-agent', 'Root.', ['leaf-agent']);
    const def = {
      enabled: true,
      key: 'test-graph',
      root: rootNode,
      getNode: (key: string) => (key === 'root-agent' ? rootNode : leafNode),
      reverseTraverse: async <T>(fn: any) => {
        const ctx: Record<string, T> = {};
        await fn(leafNode, ctx);
        await fn(rootNode, ctx);
      },
    };
    await toOpenAIAgents(Promise.resolve(def as any)).invoke('hi');
    // Leaf agent (first constructed) should have instructions from messages
    expect(mockAgentConstructor.mock.calls[0][0].instructions).toBe('From messages.');
  });

  // ── OTel span usage attributes ────────────────────────────────────────────

  it('sets gen_ai.usage.* and ld.ai.graph.path span attributes on success', async () => {
    mockRunnerRun.mockResolvedValue(makeRunResult('output', 7, 3));
    await toOpenAIAgents(Promise.resolve(makeTwoNodeGraph())).invoke('hi');
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('gen_ai.usage.input_tokens', 7);
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('gen_ai.usage.output_tokens', 3);
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('gen_ai.usage.total_tokens', 10);
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('ld.ai.graph.path', expect.any(String));
  });
});
