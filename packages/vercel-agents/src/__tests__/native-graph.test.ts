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
    addEvent: vi.fn(),
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
import { expectNoNeverForwardedValue, NEVER_FORWARDED_PARAMETERS } from './never-forwarded.js';

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

  it("maps each node's snake_case model.parameters onto that node's ToolLoopAgent call settings", async () => {
    const graph = makeGraph();
    (graph.root.config.model as any).parameters = {
      max_tokens: 128,
      top_p: 0.7,
      provider_options: { openai: { reasoning_summary: 'auto' } },
      instructions: 'bad',
      tools: {},
      abort_signal: 'bad',
    };
    (graph.getNode('leaf')!.config.model as any).parameters = { temperature: 0.1, max_completion_tokens: 32 };
    await toVercelAgents(Promise.resolve(graph as any)).invoke('hi');
    const rootSettings = aiMocks.agentArguments.find((options) => options.model === 'openai/root-model');
    const leafSettings = aiMocks.agentArguments.find((options) => options.model === 'anthropic/leaf-model');
    expect(rootSettings).toMatchObject({
      maxOutputTokens: 128,
      topP: 0.7,
      instructions: 'Root instructions',
    });
    expect(Object.keys(rootSettings.tools)).toEqual(['transfer_to_leaf']);
    for (const key of ['max_tokens', 'top_p', 'provider_options', 'providerOptions', 'abort_signal', 'abortSignal']) {
      expect(rootSettings).not.toHaveProperty(key);
    }
    expect(leafSettings).toMatchObject({ temperature: 0.1, maxOutputTokens: 32 });
    expect(leafSettings).not.toHaveProperty('max_completion_tokens');
  });

  it('never forwards credentials, endpoints, headers or host settings from any node', async () => {
    const graph = makeGraph();
    (graph.root.config.model as any).parameters = { ...NEVER_FORWARDED_PARAMETERS, temperature: 0.3 };
    (graph.getNode('leaf')!.config.model as any).parameters = NEVER_FORWARDED_PARAMETERS;
    await toVercelAgents(Promise.resolve(graph as any)).invoke('hi');
    const rootSettings = aiMocks.agentArguments.find((options) => options.model === 'openai/root-model');
    expect(rootSettings.temperature).toBe(0.3);
    for (const settings of aiMocks.agentArguments) {
      expectNoNeverForwardedValue(settings);
    }
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
    expect(telemetryMocks.span.setAttribute).toHaveBeenCalledWith('launchdarkly.graph.path', 'root->leaf');
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

  it('tags the graph span with the run identity so LaunchDarkly can link the trace to the config', async () => {
    await toVercelAgents(Promise.resolve(makeGraph() as any), { context } as any).invoke('start');
    expect(telemetryMocks.span.setAttribute).toHaveBeenCalledWith('launchdarkly.operation.type', 'gen_ai');
    expect(telemetryMocks.span.setAttribute).toHaveBeenCalledWith('launchdarkly.config.key', 'vercel-native-graph');
    expect(telemetryMocks.span.setAttribute).toHaveBeenCalledWith('launchdarkly.graph.key', 'vercel-native-graph');
    expect(telemetryMocks.span.setAttribute).toHaveBeenCalledWith('launchdarkly.run.id', expect.any(String));
    expect(telemetryMocks.span.setAttribute).toHaveBeenCalledWith('launchdarkly.variation.key', expect.any(String));
    expect(telemetryMocks.span.setAttribute).toHaveBeenCalledWith('context.contextKeys.user', 'user-1');
    expect(telemetryMocks.span.addEvent).toHaveBeenCalledWith('feature_flag', {
      'feature_flag.key': 'vercel-native-graph',
      'feature_flag.provider.name': 'LaunchDarkly',
      'feature_flag.set.id': 'env-123',
      'feature_flag.context.id': 'user-1',
      'feature_flag.contextKeys': '{"user":"user-1"}',
    });
  });

  it('keys the graph-level events to the graph, not the root node', async () => {
    await toVercelAgents(Promise.resolve(makeGraph() as any), { context } as any).invoke('start');
    const graphEvents = telemetryMocks.track.mock.calls.filter((c: unknown[]) =>
      ['$ld:ai:graph:invocation_success', '$ld:ai:graph:duration:total', '$ld:ai:graph:total_tokens'].includes(
        c[0] as string,
      ),
    );
    expect(graphEvents).toHaveLength(3);
    for (const call of graphEvents) {
      expect(call[2]).toEqual(
        expect.objectContaining({ configKey: 'vercel-native-graph', graphKey: 'vercel-native-graph' }),
      );
    }
  });

  it('keys invocation_failure to the graph, not the root node', async () => {
    aiMocks.generateImplementation = async () => {
      throw new Error('boom');
    };
    await expect(toVercelAgents(Promise.resolve(makeGraph() as any), { context } as any).invoke('hi')).rejects.toThrow(
      'boom',
    );
    const failures = telemetryMocks.track.mock.calls.filter(
      (c: unknown[]) => c[0] === '$ld:ai:graph:invocation_failure',
    );
    expect(failures).toHaveLength(1);
    expect(failures[0][2]).toEqual(
      expect.objectContaining({ configKey: 'vercel-native-graph', graphKey: 'vercel-native-graph' }),
    );
  });

  it('puts the environment id on every node and graph tracking event', async () => {
    await toVercelAgents(Promise.resolve(makeGraph() as any), { context } as any).invoke('start');
    expect(telemetryMocks.track).toHaveBeenCalled();
    for (const call of telemetryMocks.track.mock.calls) {
      expect(call[2]).toEqual(expect.objectContaining({ environmentId: 'env-123' }));
    }
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

  it('records a setup error on the graph span, tracks it as a failure, and ends the span once', async () => {
    const modelFactory = () => {
      throw new Error('model boom');
    };
    await expect(
      toVercelAgents(Promise.resolve(makeGraph() as any), { context, modelFactory } as any).invoke('hi'),
    ).rejects.toThrow('model boom');
    expect(aiMocks.agents).toHaveLength(0);
    expect(telemetryMocks.span.end).toHaveBeenCalledOnce();
    expect(telemetryMocks.span.recordException).toHaveBeenCalledOnce();
    expect(telemetryMocks.span.recordException).toHaveBeenCalledWith(expect.any(Error));
    expect(telemetryMocks.span.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.ERROR, message: 'model boom' });
    expect(telemetryMocks.span.setStatus).not.toHaveBeenCalledWith({ code: SpanStatusCode.OK });
    const failures = telemetryMocks.track.mock.calls.filter(
      (c: unknown[]) => c[0] === '$ld:ai:graph:invocation_failure',
    );
    expect(failures).toHaveLength(1);
    expect(failures[0][2]).toEqual(
      expect.objectContaining({ configKey: 'vercel-native-graph', graphKey: 'vercel-native-graph' }),
    );
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
