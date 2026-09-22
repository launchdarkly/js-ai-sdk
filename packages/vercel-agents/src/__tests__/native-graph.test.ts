import { SpanStatusCode } from '@opentelemetry/api';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const aiMocks = vi.hoisted(() => ({
  agentArguments: [] as any[],
  agents: [] as any[],
  generateImplementation: undefined as undefined | ((options: any, request: any) => Promise<any>),
  jsonSchema: vi.fn((schema: unknown) => ({ schema })),
  stepCountIs: vi.fn((steps: number) => ({ type: 'step-count', steps })),
  tool: vi.fn(({ execute, ...definition }: any) => ({ ...definition, execute })),
}));

vi.mock('ai', () => ({
  ToolLoopAgent: class {
    options: any;
    generate: ReturnType<typeof vi.fn>;
    constructor(options: any) {
      this.options = options;
      this.generate = vi.fn((request: any) =>
        aiMocks.generateImplementation
          ? aiMocks.generateImplementation(options, request)
          : Promise.resolve({
              text: `${options.instructions ?? options.model} response`,
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            }),
      );
      aiMocks.agentArguments.push(options);
      aiMocks.agents.push(this);
    }
  },
  tool: aiMocks.tool,
  jsonSchema: aiMocks.jsonSchema,
  stepCountIs: aiMocks.stepCountIs,
}));

const telemetryMocks = vi.hoisted(() => ({
  track: vi.fn(),
  span: {
    end: vi.fn(),
    recordException: vi.fn(),
    setAttribute: vi.fn(),
    setStatus: vi.fn(),
  },
  startActiveSpan: vi.fn(),
}));

vi.mock('@launchdarkly/ai-server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@launchdarkly/ai-server')>();
  return {
    ...actual,
    getClient: vi.fn(() => ({ track: telemetryMocks.track })),
    parseTemplate: (value: string) => value,
  };
});

vi.mock('@opentelemetry/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@opentelemetry/api')>();
  return {
    ...actual,
    trace: {
      ...actual.trace,
      getTracer: vi.fn(() => ({
        startActiveSpan: telemetryMocks.startActiveSpan.mockImplementation((_name: string, fn: Function) =>
          fn(telemetryMocks.span),
        ),
      })),
    },
  };
});

import { toVercelAgents } from '../native-graph.js';

function makeNode(
  key: string,
  instructions: string,
  targets: string[] = [],
  tools?: Record<string, any>,
  model = `${key}/model`,
) {
  return {
    key,
    config: {
      model: { name: model },
      provider: { name: 'GatewayProvider' },
      instructions,
      tools,
    },
    meta: { variationKey: `${key}-variation`, version: 1 },
    edges: targets.map((targetKey) => ({
      key: `${key}-${targetKey}`,
      sourceKey: key,
      targetKey,
      handoff: { description: `Transfer to ${targetKey}` },
    })),
    isTerminal: () => targets.length === 0,
  };
}

function makeGraph() {
  const leaf = makeNode(
    'leaf',
    'Leaf instructions',
    [],
    {
      lookup: {
        name: 'lookup',
        type: 'function',
        description: 'Look something up',
        parameters: { type: 'object', properties: { query: { type: 'string' } } },
      },
    },
    'anthropic/leaf-model',
  );
  const root = makeNode('root', 'Root instructions', ['leaf'], undefined, 'openai/root-model');
  const nodes = { root, leaf };
  return {
    enabled: true,
    key: 'vercel-native-graph',
    root,
    getNode: (key: string) => nodes[key as keyof typeof nodes] ?? null,
    edgesFrom: (key: string) => nodes[key as keyof typeof nodes]?.edges ?? [],
    traverse: async (visitor: (node: any) => Promise<void>) => {
      await visitor(root);
      await visitor(leaf);
    },
    reverseTraverse: async <T>(visitor: (node: any, state: Record<string, T>) => Promise<void>) => {
      const state: Record<string, T> = {};
      await visitor(leaf, state);
      await visitor(root, state);
    },
  };
}

const context = { kind: 'user' as const, key: 'user-1' };

describe('toVercelAgents', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    aiMocks.agentArguments.length = 0;
    aiMocks.agents.length = 0;
    aiMocks.generateImplementation = undefined;
  });

  it('rejects disabled graphs and graphs without a root', async () => {
    await expect(
      toVercelAgents(Promise.resolve({ ...makeGraph(), enabled: false } as any)).invoke('hi'),
    ).rejects.toThrow(/disabled/i);
    await expect(toVercelAgents(Promise.resolve({ ...makeGraph(), root: null } as any)).invoke('hi')).rejects.toThrow(
      /root/i,
    );
  });

  it('constructs one native ToolLoopAgent per node with node model and instructions', async () => {
    await toVercelAgents(Promise.resolve(makeGraph() as any)).invoke('hi');
    expect(aiMocks.agentArguments).toHaveLength(2);
    expect(aiMocks.agentArguments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ model: 'openai/root-model', instructions: 'Root instructions' }),
        expect.objectContaining({ model: 'anthropic/leaf-model', instructions: 'Leaf instructions' }),
      ]),
    );
  });

  it('resolves the injected model factory independently for every evaluated node', async () => {
    const modelFactory = vi.fn((config: any) => ({ modelId: `resolved:${config.model.name}` }));
    await toVercelAgents(Promise.resolve(makeGraph() as any), { modelFactory } as any).invoke('hi');
    expect(modelFactory).toHaveBeenCalledTimes(2);
    expect(aiMocks.agentArguments.map((args) => args.model.modelId).sort()).toEqual([
      'resolved:anthropic/leaf-model',
      'resolved:openai/root-model',
    ]);
  });

  it('adds one callable transfer_to_<target> tool per outgoing root edge', async () => {
    await toVercelAgents(Promise.resolve(makeGraph() as any)).invoke('hi');
    const rootOptions = aiMocks.agentArguments.find((args) => args.model === 'openai/root-model');
    expect(Object.keys(rootOptions.tools)).toContain('transfer_to_leaf');
    expect(typeof rootOptions.tools.transfer_to_leaf.execute).toBe('function');
    expect(rootOptions.tools.transfer_to_leaf.description).toMatch(/leaf/i);
  });

  it('adds no handoff tools to terminal nodes', async () => {
    await toVercelAgents(Promise.resolve(makeGraph() as any)).invoke('hi');
    const leafOptions = aiMocks.agentArguments.find((args) => args.model === 'anthropic/leaf-model');
    expect(Object.keys(leafOptions.tools ?? {}).filter((name) => name.startsWith('transfer_to_'))).toHaveLength(0);
  });

  it('includes callable node-local tools alongside handoffs and executes global handlers', async () => {
    const lookup = vi.fn().mockResolvedValue('lookup result');
    await toVercelAgents(Promise.resolve(makeGraph() as any), {
      toolHandlers: { lookup },
    } as any).invoke('hi');
    const leafOptions = aiMocks.agentArguments.find((args) => args.model === 'anthropic/leaf-model');
    expect(Object.keys(leafOptions.tools)).toContain('lookup');
    await leafOptions.tools.lookup.execute({ query: 'flags' }, { toolCallId: 'lookup-1' });
    expect(lookup).toHaveBeenCalledWith({ query: 'flags' });
  });

  it('filters node-local tools without callable handlers', async () => {
    await toVercelAgents(Promise.resolve(makeGraph() as any), { toolHandlers: {} } as any).invoke('hi');
    const leafOptions = aiMocks.agentArguments.find((args) => args.model === 'anthropic/leaf-model');
    expect(Object.keys(leafOptions.tools ?? {})).not.toContain('lookup');
  });

  it('starts at the graph root and applies caller history only to its first invocation', async () => {
    const history = [
      { role: 'user' as const, content: 'Earlier question' },
      { role: 'assistant' as const, content: 'Earlier answer' },
    ];
    await toVercelAgents(Promise.resolve(makeGraph() as any)).invoke('New question', {}, history);
    const rootAgent = aiMocks.agents.find((agent) => agent.options.model === 'openai/root-model');
    const leafAgent = aiMocks.agents.find((agent) => agent.options.model === 'anthropic/leaf-model');
    expect(rootAgent.generate).toHaveBeenCalledWith({
      messages: [
        { role: 'user', content: 'Earlier question' },
        { role: 'assistant', content: 'Earlier answer' },
        { role: 'user', content: 'New question' },
      ],
    });
    expect(leafAgent.generate).not.toHaveBeenCalled();
  });

  it('follows selected handoffs once, returns leaf text, and accumulates visited-node usage', async () => {
    aiMocks.generateImplementation = async (options, request) => {
      if (options.model === 'openai/root-model') {
        await options.tools.transfer_to_leaf.execute({}, { toolCallId: 'handoff-1' });
        return {
          text: 'routing',
          usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
        };
      }
      expect(request.messages).toEqual([{ role: 'user', content: 'routing' }]);
      return {
        text: 'leaf answer',
        usage: { inputTokens: 4, outputTokens: 3, totalTokens: 7 },
      };
    };
    const result = await toVercelAgents(Promise.resolve(makeGraph() as any)).invoke('start');
    const rootAgent = aiMocks.agents.find((agent) => agent.options.model === 'openai/root-model');
    const leafAgent = aiMocks.agents.find((agent) => agent.options.model === 'anthropic/leaf-model');
    expect(rootAgent.generate).toHaveBeenCalledOnce();
    expect(leafAgent.generate).toHaveBeenCalledOnce();
    expect(result).toEqual({
      response: 'leaf answer',
      usage: { input: 6, output: 4, total: 10 },
    });
    expect(telemetryMocks.span.setAttribute).toHaveBeenCalledWith('ld.ai.graph.path', 'root,leaf');
  });

  it('emits graph success, handoff, duration, and token telemetry when context is supplied', async () => {
    aiMocks.generateImplementation = async (options) => {
      if (options.model === 'openai/root-model') {
        await options.tools.transfer_to_leaf.execute({}, { toolCallId: 'handoff-1' });
        return { text: 'route', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
      }
      return { text: 'done', usage: { inputTokens: 2, outputTokens: 2, totalTokens: 4 } };
    };
    await toVercelAgents(Promise.resolve(makeGraph() as any), { context } as any).invoke('start');
    const names = telemetryMocks.track.mock.calls.map((call) => call[0]);
    expect(names).toEqual(
      expect.arrayContaining([
        '$ld:ai:graph:handoff_success',
        '$ld:ai:graph:invocation_success',
        '$ld:ai:graph:duration:total',
        '$ld:ai:tokens:input',
        '$ld:ai:tokens:output',
        '$ld:ai:tokens:total',
      ]),
    );
    expect(telemetryMocks.track.mock.calls.every((call) => call[1] === context)).toBe(true);
  });

  it('emits no LaunchDarkly tracking without context', async () => {
    await toVercelAgents(Promise.resolve(makeGraph() as any)).invoke('hi');
    expect(telemetryMocks.track).not.toHaveBeenCalled();
  });

  it('records graph failure and always ends the graph span', async () => {
    const error = new Error('agent failed');
    aiMocks.generateImplementation = async () => {
      throw error;
    };
    await expect(toVercelAgents(Promise.resolve(makeGraph() as any), { context } as any).invoke('hi')).rejects.toThrow(
      'agent failed',
    );
    expect(telemetryMocks.track).toHaveBeenCalledWith('$ld:ai:graph:invocation_failure', context, expect.anything(), 1);
    expect(telemetryMocks.span.recordException).toHaveBeenCalledWith(error);
    expect(telemetryMocks.span.setStatus).toHaveBeenCalledWith(expect.objectContaining({ code: SpanStatusCode.ERROR }));
    expect(telemetryMocks.span.end).toHaveBeenCalledOnce();
  });

  it('ends the graph span when native generation is cancelled', async () => {
    const cancellation = new DOMException('cancelled', 'AbortError');
    aiMocks.generateImplementation = async () => {
      throw cancellation;
    };
    await expect(toVercelAgents(Promise.resolve(makeGraph() as any)).invoke('hi')).rejects.toThrow('cancelled');
    expect(telemetryMocks.span.end).toHaveBeenCalledOnce();
  });
});
