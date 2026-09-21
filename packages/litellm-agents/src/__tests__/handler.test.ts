import { SpanStatusCode } from '@opentelemetry/api';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  agentArgs,
  agentListeners,
  clientArgs,
  modelArgs,
  mockConfig,
  mockGraph,
  mockInvoke,
  mockModelResponse,
  mockRootSpan,
  mockSpans,
  mockRun,
  mockTool,
  providerArgs,
  runnerArgs,
} = vi.hoisted(() => ({
  agentArgs: [] as Array<Record<string, unknown>>,
  agentListeners: {} as Record<string, Function[]>,
  clientArgs: [] as Array<Record<string, unknown>>,
  modelArgs: [] as Array<unknown[]>,
  mockConfig: vi.fn(),
  mockGraph: vi.fn(),
  mockInvoke: vi.fn(),
  mockModelResponse: vi.fn(),
  mockRootSpan: {
    addEvent: vi.fn(),
    end: vi.fn(),
    recordException: vi.fn(),
    setAttribute: vi.fn(),
    setStatus: vi.fn(),
  },
  mockSpans: [] as Array<{ name: string; span: Record<string, ReturnType<typeof vi.fn>> }>,
  mockRun: vi.fn(),
  mockTool: vi.fn(({ execute, ...definition }) => ({ ...definition, execute })),
  providerArgs: [] as Array<Record<string, unknown>>,
  runnerArgs: [] as Array<Record<string, unknown>>,
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
    on(name: string, listener: Function) {
      if (!agentListeners[name]) agentListeners[name] = [];
      agentListeners[name].push(listener);
    }
    constructor(options: Record<string, unknown>) {
      agentArgs.push(options);
    }
  },
  OpenAIChatCompletionsModel: class {
    getResponse = mockModelResponse;
    getStreamedResponse = vi.fn();
    constructor(...args: unknown[]) {
      modelArgs.push(args);
    }
  },
  OpenAIProvider: class {
    constructor(options: Record<string, unknown>) {
      providerArgs.push(options);
    }
  },
  Runner: class {
    run = mockRun;
    constructor(options: Record<string, unknown>) {
      runnerArgs.push(options);
    }
  },
  setTracingDisabled: vi.fn(),
  tool: mockTool,
}));

vi.mock('@opentelemetry/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@opentelemetry/api')>();
  return {
    ...actual,
    trace: {
      ...actual.trace,
      getTracer: vi.fn().mockReturnValue({
        startActiveSpan: vi.fn().mockImplementation((_name: string, fn: Function) => fn(mockRootSpan)),
        startSpan: vi.fn().mockImplementation((name: string) => {
          if (name === 'invoke_agent') return mockRootSpan;
          const span = {
            addEvent: vi.fn(),
            end: vi.fn(),
            recordException: vi.fn(),
            setAttribute: vi.fn(),
            setStatus: vi.fn(),
          };
          mockSpans.push({ name, span });
          return span;
        }),
      }),
    },
  };
});

vi.mock('@launchdarkly/ai-server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@launchdarkly/ai-server')>();
  return {
    ...actual,
    config: mockConfig.mockReturnValue({ invoke: mockInvoke }),
    graph: mockGraph,
  };
});

import { litellmGraph } from '../graph.js';
import { createLiteLLMAgentHandler, litellmAgents } from '../handler.js';

const baseConfig = {
  instructions: 'You are helpful.',
  model: { name: 'anthropic/claude-sonnet-4' },
  provider: { name: 'Anthropic' },
};

function result(output: unknown = 'answer', inputTokens = 5, outputTokens = 3) {
  return {
    finalOutput: output,
    state: { usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens } },
  };
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const events: T[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

describe('createLiteLLMAgentHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('LITELLM_BASE_URL', '');
    vi.stubEnv('LITELLM_API_KEY', '');
    agentArgs.length = 0;
    for (const key of Object.keys(agentListeners)) delete agentListeners[key];
    clientArgs.length = 0;
    modelArgs.length = 0;
    providerArgs.length = 0;
    runnerArgs.length = 0;
    mockSpans.length = 0;
    for (const fn of Object.values(mockRootSpan)) fn.mockReset();
    mockConfig.mockReturnValue({ invoke: mockInvoke });
    mockModelResponse.mockResolvedValue({ output: [], usage: { inputTokens: 2, outputTokens: 1 } });
  });

  it('advertises wildcard agent metadata and captureContent', () => {
    expect(createLiteLLMAgentHandler({ baseURL: 'https://proxy.test/v1' }).providesFor).toEqual(['*', 'agent']);
    expect(createLiteLLMAgentHandler({ baseURL: 'https://proxy.test/v1' }).captureContent).toBe(false);
    expect(createLiteLLMAgentHandler({ baseURL: 'https://proxy.test/v1', captureContent: true }).captureContent).toBe(
      true,
    );
  });

  it('binds the evaluated model to a chat-completions model backed by the injected proxy client', async () => {
    mockRun.mockResolvedValue(result());
    const client = { marker: 'litellm-client' };
    await createLiteLLMAgentHandler({ client: client as never })(baseConfig as never, 'hello');
    expect(modelArgs).toContainEqual([client, 'anthropic/claude-sonnet-4']);
    expect(modelArgs).toHaveLength(1);
    expect(agentArgs[0].model).toBeDefined();
    expect(runnerArgs[0]).toEqual(expect.objectContaining({ modelProvider: expect.anything() }));
    expect(clientArgs).toHaveLength(0);
  });

  it('constructs the compatible client with proxy credentials and never api.openai.com', async () => {
    mockRun.mockResolvedValue(result());
    await createLiteLLMAgentHandler({
      apiKey: 'proxy-key',
      baseURL: 'https://litellm.example.test/v1',
    })(baseConfig as never, 'hello');
    expect(clientArgs).toEqual([
      expect.objectContaining({ apiKey: 'proxy-key', baseURL: 'https://litellm.example.test/v1' }),
    ]);
    expect(JSON.stringify([...clientArgs, ...providerArgs])).not.toContain('api.openai.com');
  });

  it('infers proxy settings from the environment without forwarding provider credentials', async () => {
    vi.stubEnv('LITELLM_BASE_URL', 'https://env-litellm.example.test/v1');
    vi.stubEnv('LITELLM_API_KEY', '');
    vi.stubEnv('OPENAI_API_KEY', 'provider-secret');
    mockRun.mockResolvedValue(result());

    await createLiteLLMAgentHandler()(baseConfig as never, 'hello');

    expect(clientArgs).toEqual([
      expect.objectContaining({
        apiKey: 'not-needed',
        baseURL: 'https://env-litellm.example.test/v1',
      }),
    ]);
    expect(JSON.stringify(clientArgs)).not.toContain('provider-secret');
    vi.unstubAllEnvs();
  });

  it('rejects missing proxy ownership rather than falling back to the default provider', () => {
    expect(() => createLiteLLMAgentHandler({ apiKey: 'key' })).toThrow(/LITELLM_BASE_URL|baseURL/i);
    expect(providerArgs).toHaveLength(0);
  });

  it('resolves an isolated clientFactory after config evaluation and preserves aliases', async () => {
    mockRun.mockResolvedValue(result());
    const firstClient = { id: 'first' };
    const secondClient = { id: 'second' };
    const firstFactory = vi.fn().mockReturnValue(firstClient);
    const secondFactory = vi.fn().mockReturnValue(secondClient);
    const config = { ...baseConfig, model: { name: 'company-router-alias', parameters: { temperature: 0.2 } } };

    await createLiteLLMAgentHandler({ clientFactory: firstFactory })(config as never, 'one');
    await createLiteLLMAgentHandler({ clientFactory: secondFactory })(config as never, 'two');

    expect(firstFactory).toHaveBeenCalledWith(config);
    expect(secondFactory).toHaveBeenCalledWith(config);
    expect(modelArgs).toContainEqual([firstClient, 'company-router-alias']);
    expect(modelArgs).toContainEqual([secondClient, 'company-router-alias']);
  });

  it('keeps evaluated model and parameters authoritative over factory defaults', async () => {
    mockRun.mockResolvedValue(result());
    const client = { id: 'proxy' };
    const config = {
      ...baseConfig,
      model: {
        name: 'gemini/team-route',
        parameters: {
          api_key: 'provider-secret',
          base_url: 'https://wrong.example.test',
          max_tokens: 250,
          model: 'gpt-default',
          response_format: { type: 'text' },
          stream: true,
          temperature: 0.1,
          tools: ['override'],
        },
      },
    };
    await createLiteLLMAgentHandler({ client: client as never })(config as never, 'q');
    expect(modelArgs).toContainEqual([
      client,
      'gemini/team-route',
      expect.objectContaining({ max_tokens: 250, temperature: 0.1 }),
    ]);
    expect(JSON.stringify(modelArgs)).not.toContain('gpt-default');
    expect(JSON.stringify(modelArgs)).not.toContain('provider-secret');
    expect(agentArgs[0].modelSettings).toEqual({ max_tokens: 250, temperature: 0.1 });
  });

  it.each([
    ['max_turns', 7],
    ['maxTurns', 9],
  ])('forwards %s to Runner without leaking it into model settings', async (key, value) => {
    mockRun.mockResolvedValue(result());
    await createLiteLLMAgentHandler({ client: {} as never })(
      {
        ...baseConfig,
        model: { name: 'proxy-alias', parameters: { [key]: value, temperature: 0.2 } },
      } as never,
      'q',
    );
    expect(mockRun).toHaveBeenCalledWith(expect.anything(), 'q', { maxTurns: value });
    expect(agentArgs[0].modelSettings).toEqual({ temperature: 0.2 });
  });

  it('maps instructions, tools, structured history, and output format to the Agents SDK', async () => {
    mockRun.mockResolvedValue(result({ answer: 'yes' }));
    const search = vi.fn();
    const history = [
      { content: 'earlier', role: 'assistant' as const },
      {
        content: [
          { source: { data: 'abc123', media_type: 'image/png', type: 'base64' as const }, type: 'image' as const },
          { text: 'describe', type: 'text' as const },
        ],
        role: 'user' as const,
      },
    ];
    const schema = { properties: { answer: { type: 'string' } }, type: 'object' };
    const config = {
      ...baseConfig,
      instructions: 'Help {{name}}',
      outputFormat: schema,
      tools: {
        search: {
          description: 'Search',
          name: 'search',
          parameters: { properties: {}, type: 'object' },
          type: 'function',
        },
      },
    };
    await createLiteLLMAgentHandler({ client: {} as never })(
      config as never,
      'question',
      { search },
      { name: 'Ada' },
      history,
    );
    expect(agentArgs[0]).toMatchObject({
      instructions: 'Help Ada',
      outputType: { name: 'output', schema, strict: false, type: 'json_schema' },
      tools: [expect.objectContaining({ name: 'search' })],
    });
    const runnerInput = mockRun.mock.calls[0][1];
    expect(Array.isArray(runnerInput)).toBe(true);
    expect(JSON.stringify(runnerInput)).toContain('input_image');
    expect(JSON.stringify(runnerInput)).toContain('data:image/png;base64,abc123');
    expect(runnerInput.at(-1)).toMatchObject({ role: 'user' });
  });

  it('maps config messages without duplicating a final user turn', async () => {
    mockRun.mockResolvedValue(result());
    await createLiteLLMAgentHandler({ client: {} as never })(
      {
        model: baseConfig.model,
        provider: baseConfig.provider,
        messages: [
          { role: 'system', content: 'Help {{name}}' },
          { role: 'assistant', content: 'Earlier' },
          { role: 'user', content: 'Configured {{question}}' },
        ],
      } as never,
      'duplicate',
      {},
      { name: 'Ada', question: 'request' },
    );
    expect(agentArgs[0].instructions).toBe('Help Ada');
    expect(JSON.stringify(mockRun.mock.calls[0][1])).toContain('Configured request');
    expect(JSON.stringify(mockRun.mock.calls[0][1])).not.toContain('duplicate');
  });

  it('lets the Agents SDK execute converted tools and propagates tool errors', async () => {
    mockRun.mockResolvedValue(result());
    const error = new Error('tool failed');
    const config = {
      ...baseConfig,
      tools: {
        search: { name: 'search', parameters: { type: 'object' }, type: 'function' },
      },
    };
    await createLiteLLMAgentHandler({ client: {} as never })(config as never, 'q', {
      search: vi.fn().mockRejectedValue(error),
    });
    expect(mockTool).toHaveBeenCalledWith(expect.objectContaining({ name: 'search' }));
    await expect(mockTool.mock.results[0].value.execute({ q: 'x' })).rejects.toThrow('tool failed');
  });

  it('returns final output and aggregate Agents SDK usage', async () => {
    mockRun.mockResolvedValue(result('done', 12, 7));
    const response = await createLiteLLMAgentHandler({ client: {} as never })(baseConfig as never, 'q');
    expect(response).toMatchObject({ output: 'done', usage: { input_tokens: 12, output_tokens: 7 } });
  });

  it('disables duplicate Agents SDK tracing and emits LaunchDarkly telemetry with content gated', async () => {
    const { setTracingDisabled } = await import('@openai/agents');
    mockRun.mockResolvedValue(result('secret answer', 8, 4));
    await createLiteLLMAgentHandler({ client: {} as never })(
      baseConfig as never,
      'secret question',
      {},
      { __ld: { configKey: 'cfg', runId: 'run', variationKey: 'var' } },
    );
    expect(setTracingDisabled).toHaveBeenCalledWith(true);
    expect(mockRootSpan.addEvent).toHaveBeenCalledWith(
      'feature_flag',
      expect.objectContaining({ 'feature_flag.key': 'cfg' }),
    );
    expect(mockRootSpan.setAttribute).toHaveBeenCalledWith('gen_ai.system', 'litellm');
    expect(mockRootSpan.setAttribute).toHaveBeenCalledWith('gen_ai.provider.name', 'anthropic');
    expect(JSON.stringify(mockRootSpan.setAttribute.mock.calls)).not.toContain('secret question');
    expect(mockRootSpan.setAttribute).toHaveBeenCalledWith('gen_ai.usage.input_tokens', 8);
    expect(mockRootSpan.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.OK });
    expect(mockRootSpan.end).toHaveBeenCalledOnce();
  });

  it('emits execute_tool children from Agents SDK lifecycle hooks', async () => {
    mockRun.mockImplementation(async () => {
      const details = { toolCall: { arguments: '{"q":"x"}', callId: 'call-1', name: 'search' } };
      agentListeners.agent_tool_start?.[0]?.({}, { name: 'search' }, details);
      agentListeners.agent_tool_end?.[0]?.({}, { name: 'search' }, 'found', details);
      return result();
    });
    await createLiteLLMAgentHandler({ client: {} as never })(
      {
        ...baseConfig,
        tools: { search: { name: 'search', parameters: { type: 'object' }, type: 'function' } },
      } as never,
      'q',
      { search: vi.fn(() => undefined) },
    );
    const toolSpan = mockSpans.find(({ name }) => name === 'execute_tool search');
    expect(toolSpan?.span.setAttribute).toHaveBeenCalledWith('gen_ai.operation.name', 'execute_tool');
    expect(toolSpan?.span.end).toHaveBeenCalledOnce();
  });

  it('wraps each Agents SDK model turn in a provider-aware chat span', async () => {
    mockRun.mockResolvedValue(result());
    await createLiteLLMAgentHandler({ client: {} as never })(baseConfig as never, 'q');
    const provider = runnerArgs[0].modelProvider as { getModel: () => Promise<{ getResponse: Function }> };
    const model = await provider.getModel();
    await model.getResponse({ input: 'q', systemInstructions: 'help', tools: [] });
    const chat = mockSpans.find(({ name }) => name === 'chat anthropic/claude-sonnet-4');
    expect(chat?.span.setAttribute).toHaveBeenCalledWith('gen_ai.system', 'litellm');
    expect(chat?.span.setAttribute).toHaveBeenCalledWith('gen_ai.provider.name', 'anthropic');
    expect(chat?.span.setAttribute).toHaveBeenCalledWith('gen_ai.usage.input_tokens', 2);
    expect(chat?.span.end).toHaveBeenCalledOnce();
  });

  it('captures prompt and completion only when enabled', async () => {
    mockRun.mockResolvedValue(result('visible answer'));
    await createLiteLLMAgentHandler({ captureContent: true, client: {} as never })(
      baseConfig as never,
      'visible question',
    );
    expect(mockRootSpan.setAttribute).toHaveBeenCalledWith('gen_ai.prompt.1.content', 'visible question');
    expect(mockRootSpan.setAttribute).toHaveBeenCalledWith('gen_ai.completion.0.content', 'visible answer');
  });

  it('records, ends, and rethrows run errors', async () => {
    const error = new Error('agent failed');
    mockRun.mockRejectedValue(error);
    await expect(createLiteLLMAgentHandler({ client: {} as never })(baseConfig as never, 'q')).rejects.toThrow(
      'agent failed',
    );
    expect(mockRootSpan.recordException).toHaveBeenCalledWith(error);
    expect(mockRootSpan.setStatus).toHaveBeenCalledWith(expect.objectContaining({ code: SpanStatusCode.ERROR }));
    expect(mockRootSpan.end).toHaveBeenCalledOnce();
  });

  describe('streaming lifecycle', () => {
    it('requests streaming, forwards text deltas, and emits one done event with usage', async () => {
      const run = {
        finalOutput: 'Hello world',
        state: { usage: { inputTokens: 6, outputTokens: 3, totalTokens: 9 } },
        async *[Symbol.asyncIterator]() {
          yield { data: { delta: 'Hello', type: 'response.output_text.delta' }, type: 'raw_model_stream_event' };
          yield { data: { delta: ' world', type: 'response.output_text.delta' }, type: 'raw_model_stream_event' };
        },
      };
      mockRun.mockResolvedValue(run);
      const events = await collect(
        createLiteLLMAgentHandler({ client: {} as never }).stream?.(
          baseConfig as never,
          'q',
          {},
          {},
        ) as AsyncIterable<unknown>,
      );
      expect(mockRun).toHaveBeenCalledWith(expect.anything(), 'q', expect.objectContaining({ stream: true }));
      expect(events).toEqual([
        { text: 'Hello', type: 'chunk' },
        { text: ' world', type: 'chunk' },
        { output: 'Hello world', type: 'done', usage: expect.objectContaining({ input_tokens: 6, output_tokens: 3 }) },
      ]);
    });

    it('cancels the vendor run and closes telemetry on abandonment', async () => {
      const cancel = vi.fn();
      const run = {
        cancel,
        finalOutput: '',
        state: { usage: {} },
        async *[Symbol.asyncIterator]() {
          yield { data: { delta: 'first', type: 'response.output_text.delta' }, type: 'raw_model_stream_event' };
          yield { data: { delta: 'second', type: 'response.output_text.delta' }, type: 'raw_model_stream_event' };
        },
      };
      mockRun.mockResolvedValue(run);
      const iterable = createLiteLLMAgentHandler({ client: {} as never }).stream?.(
        baseConfig as never,
        'q',
        {},
        {},
      ) as AsyncIterable<unknown>;
      for await (const _event of iterable) break;
      expect(cancel).toHaveBeenCalledOnce();
      expect(mockRootSpan.setAttribute).toHaveBeenCalledWith('launchdarkly.stream.abandoned', true);
      expect(mockRootSpan.end).toHaveBeenCalledOnce();
    });

    it('records and rethrows streaming errors', async () => {
      const error = new Error('stream failed');
      mockRun.mockRejectedValue(error);
      await expect(
        collect(
          createLiteLLMAgentHandler({ client: {} as never }).stream?.(
            baseConfig as never,
            'q',
            {},
            {},
          ) as AsyncIterable<unknown>,
        ),
      ).rejects.toThrow('stream failed');
      expect(mockRootSpan.recordException).toHaveBeenCalledWith(error);
      expect(mockRootSpan.setStatus).toHaveBeenCalledWith(expect.objectContaining({ code: SpanStatusCode.ERROR }));
      expect(mockRootSpan.end).toHaveBeenCalledOnce();
    });
  });
});

describe('LiteLLM agent convenience wrappers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.mockReturnValue({ invoke: mockInvoke });
  });

  it('litellmAgents wires the wildcard handler and forwards variables', async () => {
    mockInvoke.mockResolvedValue({ response: 'ok', usage: {} });
    const context = { key: 'user', kind: 'user' as const };
    const variables = { topic: 'flags' };
    await litellmAgents('flag', 'hello', context, {
      baseURL: 'https://litellm.test/v1',
      variables,
    });
    expect(mockConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        handler: expect.objectContaining({ providesFor: ['*', 'agent'] }),
        key: 'flag',
      }),
    );
    expect(mockConfig.mock.calls[0][0]).not.toHaveProperty('variables');
    expect(mockInvoke).toHaveBeenCalledWith('hello', context, variables);
  });

  it('litellmGraph pre-binds a wildcard proxy handler and forwards graph options', () => {
    const toolHandlers = { search: vi.fn() };
    litellmGraph('graph-flag', {
      baseURL: 'https://litellm.test/v1',
      toolHandlers,
    });
    expect(mockGraph).toHaveBeenCalledWith(
      'graph-flag',
      expect.objectContaining({
        handlers: [expect.objectContaining({ providesFor: ['*', 'agent'] })],
        toolHandlers,
      }),
    );
  });
});
