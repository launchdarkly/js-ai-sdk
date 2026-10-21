import { beforeEach, describe, expect, it, vi } from 'vitest';

const { agentArgs, clientArgs, handoffs, modelArgs, mockRun, mockTool, mockTrack, runnerArgs, runnerListeners } =
  vi.hoisted(() => ({
    agentArgs: [] as Array<Record<string, unknown>>,
    clientArgs: [] as Array<Record<string, unknown>>,
    handoffs: [] as unknown[],
    modelArgs: [] as Array<unknown[]>,
    mockRun: vi.fn(),
    mockTool: vi.fn(({ execute, ...definition }) => ({ ...definition, execute })),
    mockTrack: vi.fn(),
    runnerArgs: [] as Array<Record<string, unknown>>,
    runnerListeners: {} as Record<string, (...args: unknown[]) => void>,
  }));

vi.mock('openai', () => ({
  default: class {
    constructor(options: Record<string, unknown>) {
      clientArgs.push(options);
    }
  },
}));

vi.mock('@openai/agents', () => ({
  Agent: class {
    name: string;
    constructor(options: Record<string, unknown>) {
      this.name = String(options.name);
      agentArgs.push(options);
    }
  },
  OpenAIChatCompletionsModel: class {
    constructor(...args: unknown[]) {
      modelArgs.push(args);
    }
  },
  Runner: class {
    run = mockRun;
    on(name: string, listener: (...args: unknown[]) => void) {
      runnerListeners[name] = listener;
    }
    constructor(options: Record<string, unknown>) {
      runnerArgs.push(options);
    }
  },
  handoff: vi.fn((agent: unknown) => {
    handoffs.push(agent);
    return { agent };
  }),
  setTracingDisabled: vi.fn(),
  tool: mockTool,
}));

vi.mock('@launchdarkly/ai-server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@launchdarkly/ai-server')>()),
  getClient: () => ({ track: mockTrack }),
}));

import type { GraphDefinition, GraphNode } from '@launchdarkly/ai-server';
import { toLiteLLMAgents } from '../native-graph.js';

function node(key: string, model: string, children: string[] = [], withTool = false) {
  return {
    config: {
      instructions: `Instructions for ${key}`,
      model: { name: model },
      provider: { name: model.split('/')[0] },
      ...(withTool
        ? {
            tools: {
              search: {
                description: 'Search',
                name: 'search',
                parameters: { properties: {}, type: 'object' },
                type: 'function',
              },
            },
          }
        : {}),
    },
    edges: children.map((targetKey) => ({ key: `${key}-${targetKey}`, targetKey })),
    isTerminal: () => children.length === 0,
    key,
    meta: { variationKey: `${key}-variation`, version: 1 },
  };
}

function graphDefinition(): GraphDefinition {
  const leaf = node('leaf', 'gemini/leaf-alias');
  const root = node('root', 'anthropic/root-alias', ['leaf'], true);
  const definition = {
    enabled: true,
    getNode: (key: string) => (key === 'root' ? root : key === 'leaf' ? leaf : null),
    key: 'litellm-graph',
    reverseTraverse: async <T>(visit: (value: typeof root, context: Record<string, T>) => Promise<void>) => {
      const context: Record<string, T> = {};
      await visit(leaf, context);
      await visit(root, context);
    },
    root,
  };
  return definition as unknown as GraphDefinition;
}

describe('toLiteLLMAgents', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    agentArgs.length = 0;
    clientArgs.length = 0;
    handoffs.length = 0;
    modelArgs.length = 0;
    runnerArgs.length = 0;
    mockRun.mockResolvedValue({
      finalOutput: 'graph answer',
      state: { usage: { inputTokens: 9, outputTokens: 4, totalTokens: 13 } },
    });
  });

  it('rejects disabled and rootless definitions', async () => {
    const definition = graphDefinition();
    await expect(
      toLiteLLMAgents(Promise.resolve({ ...definition, enabled: false } as never), { client: {} as never }).invoke('q'),
    ).rejects.toThrow(/disabled|litellm-graph/i);
    await expect(
      toLiteLLMAgents(Promise.resolve({ ...definition, root: null } as never), { client: {} as never }).invoke('q'),
    ).rejects.toThrow(/root/i);
  });

  it('creates one Agent per node with node-authoritative LiteLLM models', async () => {
    const client = { marker: 'proxy' };
    await toLiteLLMAgents(Promise.resolve(graphDefinition()), { client: client as never }).invoke('q');
    expect(agentArgs).toHaveLength(2);
    expect(modelArgs).toContainEqual([client, 'gemini/leaf-alias']);
    expect(modelArgs).toContainEqual([client, 'anthropic/root-alias']);
    expect(JSON.stringify(modelArgs)).not.toContain('gpt-');
  });

  it('uses one proxy-configured client and never constructs a default OpenAI path', async () => {
    await toLiteLLMAgents(Promise.resolve(graphDefinition()), {
      apiKey: 'proxy-key',
      baseURL: 'https://litellm.example.test/v1',
    }).invoke('q');
    expect(clientArgs).toEqual([
      expect.objectContaining({
        apiKey: 'proxy-key',
        baseURL: 'https://litellm.example.test/v1',
      }),
    ]);
    expect(JSON.stringify(clientArgs)).not.toContain('api.openai.com');
    expect(runnerArgs[0]).toEqual(expect.objectContaining({ modelProvider: expect.anything() }));
  });

  it('resolves clientFactory independently for the adapter invocation', async () => {
    const client = { id: 'isolated-router' };
    const clientFactory = vi.fn().mockReturnValue(client);
    await toLiteLLMAgents(Promise.resolve(graphDefinition()), { clientFactory }).invoke('q');
    expect(clientFactory).toHaveBeenCalledOnce();
    expect(modelArgs.every(([boundClient]) => boundClient === client)).toBe(true);
  });

  it('wires terminal and non-terminal handoffs and runs the root agent', async () => {
    await toLiteLLMAgents(Promise.resolve(graphDefinition()), { client: {} as never }).invoke('hello');
    expect(agentArgs[0]).toMatchObject({ handoffs: [] });
    expect(agentArgs[1]).toMatchObject({ handoffs: [expect.anything()] });
    expect(handoffs).toHaveLength(1);
    expect(mockRun).toHaveBeenCalledWith(expect.objectContaining({ name: 'root' }), 'hello');
    await expect((runnerArgs[0].modelProvider as { getModel: () => Promise<unknown> }).getModel()).resolves.toBe(
      agentArgs[1].model,
    );
  });

  it('converts node tools with the supplied local handlers', async () => {
    const search = vi.fn().mockResolvedValue('found');
    await toLiteLLMAgents(Promise.resolve(graphDefinition()), {
      client: {} as never,
      toolHandlers: { search },
    }).invoke('q');
    expect(mockTool).toHaveBeenCalledWith(expect.objectContaining({ name: 'search' }));
    await expect(mockTool.mock.results[0].value.execute({ query: 'x' })).resolves.toBe('found');
  });

  it('forwards structured history to the root run', async () => {
    const history = [
      {
        content: [
          { source: { data: 'image-data', media_type: 'image/png', type: 'base64' as const }, type: 'image' as const },
        ],
        role: 'user' as const,
      },
    ];
    await toLiteLLMAgents(Promise.resolve(graphDefinition()), { client: {} as never }).invoke('describe', {}, history);
    const input = mockRun.mock.calls[0][1];
    expect(Array.isArray(input)).toBe(true);
    expect(JSON.stringify(input)).toContain('input_image');
    expect(JSON.stringify(input)).toContain('image-data');
  });

  it('filters system history and does not append an empty user turn', async () => {
    const history = [
      { content: 'ignore this', role: 'system' as const },
      { content: 'complete user turn', role: 'user' as const },
    ];
    await toLiteLLMAgents(Promise.resolve(graphDefinition()), { client: {} as never }).invoke('', {}, history);

    expect(mockRun.mock.calls[0][1]).toEqual([
      {
        role: 'user',
        content: [{ type: 'input_text', text: 'complete user turn' }],
      },
    ]);
  });

  it('composes root config messages before runtime history', async () => {
    const definition = graphDefinition();
    const root = definition.root as GraphNode;
    delete (root.config as { instructions?: string }).instructions;
    Object.assign(root.config, {
      messages: [
        { content: 'System {{name}}', role: 'system' },
        { content: 'Configured {{name}}', role: 'user' },
      ],
    });
    await toLiteLLMAgents(Promise.resolve(definition), { client: {} as never }).invoke('follow up', { name: 'Ada' }, [
      { content: 'earlier answer', role: 'assistant' },
    ]);

    expect(mockRun.mock.calls[0][1]).toEqual([
      { content: [{ text: 'Configured Ada', type: 'input_text' }], role: 'user' },
      { content: [{ text: 'earlier answer', type: 'output_text' }], role: 'assistant' },
      { content: [{ text: 'follow up', type: 'input_text' }], role: 'user' },
    ]);
  });

  it('returns normalized graph output and usage', async () => {
    const response = await toLiteLLMAgents(Promise.resolve(graphDefinition()), { client: {} as never }).invoke('q');
    expect(response).toEqual({
      response: 'graph answer',
      usage: { input: 9, output: 4, total: 13 },
    });
  });

  describe('LaunchDarkly telemetry', () => {
    const context = { key: 'user-1', kind: 'user' };
    const events = () =>
      mockTrack.mock.calls.map(([name, , data]) => [name, (data as { configKey: string }).configKey]);

    beforeEach(() => {
      mockRun.mockImplementation(async () => {
        runnerListeners.agent_start?.({}, { name: 'root' });
        runnerListeners.agent_handoff?.({}, { name: 'root' }, { name: 'leaf' });
        runnerListeners.agent_start?.({}, { name: 'leaf' });
        runnerListeners.agent_end?.({}, { name: 'leaf' }, 'graph answer');
        return { finalOutput: 'graph answer', state: { usage: { inputTokens: 9, outputTokens: 4, totalTokens: 13 } } };
      });
    });

    it('tracks nodes in path order, including the handoff target, and graph totals on the graph key', async () => {
      await toLiteLLMAgents(Promise.resolve(graphDefinition()), { client: {} as never, context }).invoke('q');
      expect(events()).toEqual([
        ['$ld:ai:graph:node', 'root'],
        ['$ld:ai:graph:node', 'leaf'],
        ['$ld:ai:graph:handoff_success', 'root'],
        ['$ld:ai:generation:success', 'leaf'],
        ['$ld:ai:graph:duration:total', 'litellm-graph'],
        ['$ld:ai:graph:total_tokens', 'litellm-graph'],
        ['$ld:ai:graph:invocation_success', 'litellm-graph'],
      ]);
      const nodes = mockTrack.mock.calls.filter(([name]) => name === '$ld:ai:graph:node');
      expect(nodes.map(([, , data]) => (data as { index: number }).index)).toEqual([0, 1]);
      const totalTokens = mockTrack.mock.calls.find(([name]) => name === '$ld:ai:graph:total_tokens');
      expect(totalTokens?.[3]).toBe(13);
    });

    it('tracks an invocation failure when setup fails before the run', async () => {
      const saved = process.env.LITELLM_BASE_URL;
      delete process.env.LITELLM_BASE_URL;
      try {
        await expect(toLiteLLMAgents(Promise.resolve(graphDefinition()), { context }).invoke('q')).rejects.toThrow(
          /baseURL/,
        );
      } finally {
        if (saved !== undefined) process.env.LITELLM_BASE_URL = saved;
      }
      expect(events()).toEqual([['$ld:ai:graph:invocation_failure', 'litellm-graph']]);
      expect(mockRun).not.toHaveBeenCalled();
    });

    it('tracks an invocation failure when the run throws', async () => {
      mockRun.mockRejectedValue(new Error('proxy down'));
      await expect(
        toLiteLLMAgents(Promise.resolve(graphDefinition()), { client: {} as never, context }).invoke('q'),
      ).rejects.toThrow('proxy down');
      expect(events()).toEqual([['$ld:ai:graph:invocation_failure', 'litellm-graph']]);
    });

    it('tracks nothing without a context', async () => {
      await toLiteLLMAgents(Promise.resolve(graphDefinition()), { client: {} as never }).invoke('q');
      expect(mockTrack).not.toHaveBeenCalled();
    });
  });
});
