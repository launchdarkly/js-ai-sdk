import { SpanStatusCode } from '@opentelemetry/api';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockRun = vi.fn();
const mockAgentConstructor = vi.fn();
const mockTool = vi.fn().mockImplementation(({ execute, ...rest }) => ({ ...rest, execute }));
// getResponse / getStreamedResponse of the inner model that SpanningModelProvider wraps.
const mockInnerGetResponse = vi.fn();
const mockInnerGetStreamed = vi.fn();
// Captures the modelProvider passed to `new Runner(...)` so tests can drive the wrapped model.
const mockProviderRef: { current: any } = { current: undefined };

const { makeMockSpan, mockChildSpans, mockSpan } = vi.hoisted(() => {
  const makeSpan = () => ({
    setAttribute: vi.fn(),
    addEvent: vi.fn(),
    setStatus: vi.fn(),
    end: vi.fn(),
    recordException: vi.fn(),
  });
  return {
    makeMockSpan: makeSpan,
    mockChildSpans: [] as Array<{ name: string; span: ReturnType<typeof makeSpan> }>,
    mockSpan: makeSpan(),
  };
});

const mockGraph = vi.hoisted(() => vi.fn().mockReturnValue({ call: vi.fn() }));

vi.mock('@openai/agents', () => ({
  // EventEmitter-lite so the handler's agent.on('agent_tool_start'/'agent_tool_end', …) works and
  // tests can drive tool lifecycle via agent.emit(...).
  Agent: class {
    private _listeners: Record<string, Function[]> = {};
    constructor(...args: any[]) {
      mockAgentConstructor(...args);
    }
    on(event: string, fn: Function) {
      this._listeners[event] = this._listeners[event] ?? [];
      this._listeners[event].push(fn);
      return this;
    }
    emit(event: string, ...a: any[]) {
      for (const fn of this._listeners[event] ?? []) fn(...a);
    }
  },
  Runner: class {
    // The handler reads `new Runner().config.modelProvider` to discover the provider the SDK
    // would use on its own, so the stub has to expose `config` the way the real class does.
    config: any;
    constructor(config?: any) {
      if (config?.modelProvider) mockProviderRef.current = config.modelProvider;
      this.config = {
        modelProvider: config?.modelProvider ?? {
          getModel: () => ({ getResponse: mockInnerGetResponse, getStreamedResponse: mockInnerGetStreamed }),
        },
      };
    }
    run(...args: any[]) {
      return mockRun(...args);
    }
  },
  OpenAIProvider: class {
    getModel() {
      return { getResponse: mockInnerGetResponse, getStreamedResponse: mockInnerGetStreamed };
    }
  },
  tool: (...args: any[]) => mockTool(...args),
}));

vi.mock('@opentelemetry/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@opentelemetry/api')>();
  return {
    ...actual,
    trace: {
      ...actual.trace,
      getTracer: vi.fn().mockReturnValue({
        startActiveSpan: vi.fn().mockImplementation((_name: string, fn: Function) => fn(mockSpan)),
        // The root `invoke_agent` span reuses mockSpan; every `chat`/`execute_tool` child gets its own span.
        startSpan: vi.fn().mockImplementation((name: string) => {
          if (name === 'invoke_agent') return mockSpan;
          const span = makeMockSpan();
          mockChildSpans.push({ name, span });
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
    config: vi.fn().mockReturnValue({ invoke: vi.fn().mockResolvedValue({ response: 'ok', usage: {} }) }),
    graph: mockGraph,
  };
});

import { openaiGraph } from '../graph.js';
import { createOpenAIAgentHandler } from '../handler.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const baseConfig = {
  model: { name: 'gpt-4o' },
  provider: { name: 'OpenAI' },
  instructions: 'You are helpful.',
};

function mockRunResult(finalOutput = 'agent response', inputTokens = 10, outputTokens = 5) {
  return {
    finalOutput,
    state: { usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens } },
  };
}

function modelSpans() {
  return mockChildSpans.filter(({ name }) => name.startsWith('chat'));
}

function latestModelSpan() {
  return mockChildSpans.findLast(({ name }) => name.startsWith('chat'))?.span;
}

/**
 * Drives the wrapped model + tool lifecycle the way the real Runner would: one model turn, an
 * optional tool call, then a second model turn — so we can assert the emitted span tree.
 */
function driveAgentRun({ tool }: { tool?: string } = {}) {
  return async (agent: any) => {
    const model = await mockProviderRef.current.getModel('gpt-4o');
    await model.getResponse({});
    if (tool) {
      agent.emit('agent_tool_start', {}, { name: tool }, { toolCall: { callId: 'call_1', name: tool } });
      agent.emit('agent_tool_end', {}, { name: tool }, 'tool result', { toolCall: { callId: 'call_1', name: tool } });
      await model.getResponse({});
    }
    return mockRunResult();
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('createOpenAIAgentHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockChildSpans.length = 0;
    for (const key of Object.keys(mockSpan)) {
      (mockSpan as any)[key].mockReset?.();
    }
  });

  // ── 1.1 Factory and metadata ────────────────────────────────────────────────

  it('returns a callable function', () => {
    expect(typeof createOpenAIAgentHandler()).toBe('function');
  });

  it('attaches providesFor = ["OpenAI", "agent"]', () => {
    expect(createOpenAIAgentHandler().providesFor).toEqual(['OpenAI', 'agent']);
  });

  it('returns independent instances on multiple calls', () => {
    expect(createOpenAIAgentHandler()).not.toBe(createOpenAIAgentHandler());
  });

  // ── 1.2 Prompt construction ─────────────────────────────────────────────────

  it('passes instructions and model to Agent', async () => {
    mockRun.mockResolvedValue(mockRunResult());
    await createOpenAIAgentHandler()(baseConfig as any, 'hi');
    const agentArgs = mockAgentConstructor.mock.calls[0][0];
    expect(agentArgs.instructions).toBe('You are helpful.');
    expect(agentArgs.model).toBe('gpt-4o');
  });

  it('substitutes variables in instructions', async () => {
    mockRun.mockResolvedValue(mockRunResult());
    const config = { ...baseConfig, instructions: 'Hello {{name}}.' };
    await createOpenAIAgentHandler()(config as any, 'q', {}, { name: 'Dave' });
    expect(mockAgentConstructor.mock.calls[0][0].instructions).toBe('Hello Dave.');
  });

  it('builds prompt from messages when instructions absent', async () => {
    mockRun.mockResolvedValue(mockRunResult());
    const config = {
      model: { name: 'gpt-4o' },
      provider: { name: 'OpenAI' },
      messages: [
        { role: 'system', content: 'Be helpful.' },
        { role: 'user', content: 'Old message' },
      ],
    };
    await createOpenAIAgentHandler()(config as any, 'new input');
    // instructions should come from system messages
    expect(mockAgentConstructor.mock.calls[0][0].instructions).toBe('Be helpful.');
    // prompt passed to run should include history + new input
    const runPrompt = mockRun.mock.calls[0][1];
    expect(runPrompt).toContain('Old message');
    expect(runPrompt).toContain('new input');
  });

  // ── 1.2 Path C — edge cases ─────────────────────────────────────────────────

  it('does not throw when userInput is undefined', async () => {
    mockRun.mockResolvedValue(mockRunResult());
    await expect(createOpenAIAgentHandler()(baseConfig as any, undefined)).resolves.toBeDefined();
  });

  it('does not throw when userInput is an empty string', async () => {
    mockRun.mockResolvedValue(mockRunResult());
    await expect(createOpenAIAgentHandler()(baseConfig as any, '')).resolves.toBeDefined();
  });

  it('prefers instructions over messages when both are present', async () => {
    mockRun.mockResolvedValue(mockRunResult());
    const config = {
      model: { name: 'gpt-4o' },
      provider: { name: 'OpenAI' },
      instructions: 'From instructions.',
      messages: [{ role: 'system', content: 'From messages.' }],
    };
    await createOpenAIAgentHandler()(config as any, 'q');
    expect(mockAgentConstructor.mock.calls[0][0].instructions).toBe('From instructions.');
  });

  // ── 1.3 Tool conversion ─────────────────────────────────────────────────────

  it('creates agent tools when config.tools is present', async () => {
    mockRun.mockResolvedValue(mockRunResult());
    const config = {
      ...baseConfig,
      tools: {
        search: { name: 'search', type: 'function' as const, parameters: { type: 'object' }, description: 'Search' },
      },
    };
    await createOpenAIAgentHandler()(config as any, 'q', { search: vi.fn() });
    expect(mockTool).toHaveBeenCalledWith(expect.objectContaining({ name: 'search' }));
    const agentArgs = mockAgentConstructor.mock.calls[0][0];
    expect(agentArgs.tools).toHaveLength(1);
  });

  it('creates agent with no tools when config.tools is absent', async () => {
    mockRun.mockResolvedValue(mockRunResult());
    await createOpenAIAgentHandler()(baseConfig as any, 'q');
    const agentArgs = mockAgentConstructor.mock.calls[0][0];
    expect(agentArgs.tools ?? []).toHaveLength(0);
  });

  // ── 1.4 Tool execution edge cases ───────────────────────────────────────────

  it('does not expose tools to the agent when toolHandlers is empty', async () => {
    mockRun.mockResolvedValue(mockRunResult());
    const config = {
      ...baseConfig,
      tools: { search: { name: 'search', type: 'function' as const, parameters: { type: 'object' } } },
    };
    await createOpenAIAgentHandler()(config as any, 'q', {});
    // Tool is filtered out — agent receives no tools and tool() is never called
    expect(mockTool).not.toHaveBeenCalled();
    const agentArgs = mockAgentConstructor.mock.calls[0][0];
    expect(agentArgs.tools ?? []).toHaveLength(0);
  });

  it('execute callback propagates error when tool handler throws', async () => {
    mockRun.mockResolvedValue(mockRunResult());
    const err = new Error('tool exploded');
    const config = {
      ...baseConfig,
      tools: { search: { name: 'search', type: 'function' as const, parameters: { type: 'object' } } },
    };
    await createOpenAIAgentHandler()(config as any, 'q', { search: vi.fn().mockRejectedValue(err) });
    const toolObj = mockTool.mock.results[0].value;
    await expect(toolObj.execute({})).rejects.toThrow('tool exploded');
  });

  it('does not call tool() when config.tools is absent, even if toolHandlers is non-empty', async () => {
    mockRun.mockResolvedValue(mockRunResult());
    await createOpenAIAgentHandler()(baseConfig as any, 'q', { search: vi.fn() });
    expect(mockTool).not.toHaveBeenCalled();
  });

  it('excludes tools from the agent when the handler is a non-function (e.g. unwrapped NativeTool)', async () => {
    mockRun.mockResolvedValue(mockRunResult());
    // Simulate an unwrapped NativeTool sentinel: truthy but not callable.
    // In normal usage wrapToolHandlers converts NativeTool to a function stub before the
    // provider handler is called, but callers that bypass wrapToolHandlers should not crash.
    const nativeToolLike = { id: Symbol('native'), toolName: 'WebSearch' };
    const config = {
      ...baseConfig,
      tools: { search: { name: 'search', type: 'function' as const, parameters: { type: 'object' } } },
    };
    await createOpenAIAgentHandler()(config as any, 'q', { search: nativeToolLike as any });
    // Non-function handler is filtered out — the agent receives no tools
    expect(mockTool).not.toHaveBeenCalled();
    const agentArgs = mockAgentConstructor.mock.calls[0][0];
    expect(agentArgs.tools ?? []).toHaveLength(0);
  });

  // ── 1.5 Telemetry ───────────────────────────────────────────────────────────

  it('sets invoke_agent on the root and gen_ai usage on the chat model span', async () => {
    mockInnerGetResponse.mockResolvedValue({ output: [], usage: { inputTokens: 8, outputTokens: 4, totalTokens: 12 } });
    mockRun.mockImplementation(driveAgentRun());
    await createOpenAIAgentHandler()(baseConfig as any, 'q');
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('gen_ai.operation.name', 'invoke_agent');
    const modelSpan = latestModelSpan();
    expect(modelSpan?.setAttribute).toHaveBeenCalledWith('gen_ai.system', 'openai');
    expect(modelSpan?.setAttribute).toHaveBeenCalledWith('gen_ai.operation.name', 'chat');
    expect(modelSpan?.setAttribute).toHaveBeenCalledWith('gen_ai.request.model', 'gpt-4o');
    expect(modelSpan?.setAttribute).toHaveBeenCalledWith('gen_ai.usage.input_tokens', 8);
    expect(modelSpan?.setAttribute).toHaveBeenCalledWith('gen_ai.usage.output_tokens', 4);
    expect(modelSpan?.setAttribute).toHaveBeenCalledWith('gen_ai.usage.total_tokens', 12);
    // All five attributes, always: an absent one drops the span from any query grouping on the
    // complete set, which reads as "no cached tokens" rather than "this handler didn't say".
    expect(modelSpan?.setAttribute).toHaveBeenCalledWith('gen_ai.usage.cache_read.input_tokens', 0);
    expect(modelSpan?.setAttribute).toHaveBeenCalledWith('gen_ai.usage.cache_creation.input_tokens', 0);
  });

  it('derives total_tokens from input + output, ignoring the SDK-reported total', async () => {
    // The Agents SDK accumulates its own totalTokens, which can include tokens counted in
    // neither input nor output. Trusting it would leave total derivable on five handlers
    // and not on this one.
    mockInnerGetResponse.mockResolvedValue({
      output: [],
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 999 },
    });
    mockRun.mockImplementation(driveAgentRun());
    await createOpenAIAgentHandler()(baseConfig as any, 'q');
    const modelSpan = latestModelSpan();
    expect(modelSpan?.setAttribute).toHaveBeenCalledWith('gen_ai.usage.total_tokens', 15);
    expect(modelSpan?.setAttribute).not.toHaveBeenCalledWith('gen_ai.usage.total_tokens', 999);
  });

  it('emits no content at all by default', async () => {
    mockRun.mockResolvedValue(mockRunResult('answer'));
    await createOpenAIAgentHandler()(baseConfig as any, 'question');

    // Conversation content is PII, so a caller has to ask for it. Asserting on the recorded
    // arguments rather than on specific keys catches a new content attribute added without a gate.
    const written = JSON.stringify(mockSpan.setAttribute.mock.calls);
    expect(written).not.toContain('question');
    expect(mockSpan.addEvent).not.toHaveBeenCalledWith('gen_ai.content.prompt', expect.anything());
  });

  it('puts prompt and completion on span attributes when capture is enabled', async () => {
    mockRun.mockResolvedValue(mockRunResult('answer'));
    await createOpenAIAgentHandler({ captureContent: true })(baseConfig as any, 'question');

    // Attributes, not events: OTEP 4430 deprecated event-recorded content and LaunchDarkly's
    // readers parse only attributes.
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('gen_ai.prompt.1.content', 'question');
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('gen_ai.completion.0.content', 'answer');
    expect(mockSpan.addEvent).toHaveBeenCalledWith('gen_ai.content.prompt', expect.anything());
  });

  it('sets OK status and ends span on success', async () => {
    mockRun.mockResolvedValue(mockRunResult());
    await createOpenAIAgentHandler()(baseConfig as any, 'q');
    expect(mockSpan.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.OK });
    expect(mockSpan.end).toHaveBeenCalled();
  });

  // ── 1.5b Span hierarchy (invoke_agent → chat → execute_tool) ─────────────────

  it('emits one chat child span per model turn under the invoke_agent root', async () => {
    mockInnerGetResponse.mockResolvedValue({ output: [], usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } });
    mockRun.mockImplementation(driveAgentRun({ tool: 'search' }));
    await createOpenAIAgentHandler()(baseConfig as any, 'q', { search: vi.fn() });

    const chats = modelSpans();
    expect(chats).toHaveLength(2);
    expect(chats.every(({ span }) => span.end.mock.calls.length === 1)).toBe(true);
    // `{operation} {request.model}`, per the semantic conventions for an inference span.
    expect(chats.every(({ name }) => name === `chat ${baseConfig.model.name}`)).toBe(true);
  });

  it('emits an execute_tool child span per tool call, keyed by call id', async () => {
    mockInnerGetResponse.mockResolvedValue({ output: [], usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } });
    mockRun.mockImplementation(driveAgentRun({ tool: 'search' }));
    await createOpenAIAgentHandler()(baseConfig as any, 'q', { search: vi.fn() });

    const toolSpan = mockChildSpans.find(({ name }) => name === 'execute_tool search')?.span;
    expect(toolSpan?.setAttribute).toHaveBeenCalledWith('gen_ai.operation.name', 'execute_tool');
    expect(toolSpan?.setAttribute).toHaveBeenCalledWith('gen_ai.tool.name', 'search');
    expect(toolSpan?.setAttribute).toHaveBeenCalledWith('gen_ai.tool.call.id', 'call_1');
    expect(toolSpan?.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.OK });
    expect(toolSpan?.end).toHaveBeenCalledOnce();
  });

  it('reports OpenAI cached tokens as cache_read without adding them to the input total', async () => {
    mockInnerGetResponse.mockResolvedValue({
      output: [],
      // OpenAI already includes cached tokens inside inputTokens; cached is a subset, not additive.
      usage: { inputTokens: 50, outputTokens: 5, totalTokens: 55, inputTokensDetails: [{ cached_tokens: 30 }] },
    });
    mockRun.mockImplementation(driveAgentRun());
    await createOpenAIAgentHandler()(baseConfig as any, 'q');

    const modelSpan = latestModelSpan();
    expect(modelSpan?.setAttribute).toHaveBeenCalledWith('gen_ai.usage.input_tokens', 50);
    expect(modelSpan?.setAttribute).toHaveBeenCalledWith('gen_ai.usage.output_tokens', 5);
    expect(modelSpan?.setAttribute).toHaveBeenCalledWith('gen_ai.usage.total_tokens', 55);
    expect(modelSpan?.setAttribute).toHaveBeenCalledWith('gen_ai.usage.cache_read.input_tokens', 30);
    // OpenAI has no cache-creation concept; still emitted, as 0, so the set is always complete.
    expect(modelSpan?.setAttribute).toHaveBeenCalledWith('gen_ai.usage.cache_creation.input_tokens', 0);
  });

  // ── LaunchDarkly correlation ────────────────────────────────────────────────
  //
  // The `feature_flag` span event is how the AI Config Monitoring tab locates a trace
  // (events.name = feature_flag AND events.attributes.feature_flag.key = <configKey>). It has to
  // be on the root, because the root is what that query finds. Dropping it, or emitting it on a
  // child instead, silently detaches every trace from its AI Config with nothing else failing.

  const ldFixture = {
    __ld: {
      configKey: 'test-config',
      variationKey: 'variation-a',
      runId: 'run-123',
      environmentId: 'env-abc',
      version: 1,
      modelName: 'test-model',
      providerName: 'TestProvider',
    },
  };

  it('emits the feature_flag correlation event on the invoke_agent root', async () => {
    mockInnerGetResponse.mockResolvedValue({ output: [], usage: { inputTokens: 1, outputTokens: 1 } });
    mockRun.mockImplementation(driveAgentRun());
    await createOpenAIAgentHandler()(baseConfig as any, 'q', {}, ldFixture);

    expect(mockSpan.addEvent).toHaveBeenCalledWith('feature_flag', {
      'feature_flag.key': 'test-config',
      'feature_flag.provider.name': 'LaunchDarkly',
      'feature_flag.set.id': 'env-abc',
    });
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('launchdarkly.operation.type', 'gen_ai');
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('launchdarkly.config.key', 'test-config');
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('launchdarkly.variation.key', 'variation-a');
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('launchdarkly.run.id', 'run-123');
  });

  it('does not emit the feature_flag event on child spans', async () => {
    mockInnerGetResponse.mockResolvedValue({ output: [], usage: { inputTokens: 1, outputTokens: 1 } });
    mockRun.mockImplementation(driveAgentRun());
    await createOpenAIAgentHandler()(baseConfig as any, 'q', {}, ldFixture);

    const childEvents = mockChildSpans.flatMap(({ span }) => span.addEvent.mock.calls.map((c: unknown[]) => c[0]));
    expect(childEvents).not.toContain('feature_flag');
  });

  it('fails the chat span when the model turn throws', async () => {
    const err = new Error('model down');
    mockInnerGetResponse.mockRejectedValue(err);
    mockRun.mockImplementation(async () => {
      const model = await mockProviderRef.current.getModel('gpt-4o');
      await model.getResponse({});
      return mockRunResult();
    });
    await expect(createOpenAIAgentHandler()(baseConfig as any, 'q')).rejects.toThrow('model down');

    const modelSpan = latestModelSpan();
    expect(modelSpan?.recordException).toHaveBeenCalledWith(err);
    expect(modelSpan?.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.ERROR, message: 'model down' });
    expect(modelSpan?.end).toHaveBeenCalledOnce();
  });

  it('fails an open tool span when the agent run crashes mid-flight', async () => {
    const err = new Error('run boom');
    mockInnerGetResponse.mockResolvedValue({ output: [], usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } });
    mockRun.mockImplementation(async (agent: any) => {
      const model = await mockProviderRef.current.getModel('gpt-4o');
      await model.getResponse({});
      agent.emit('agent_tool_start', {}, { name: 'search' }, { toolCall: { callId: 'call_1', name: 'search' } });
      throw err; // crash before agent_tool_end — tool span left open
    });
    await expect(createOpenAIAgentHandler()(baseConfig as any, 'q', { search: vi.fn() })).rejects.toThrow('run boom');

    const toolSpan = mockChildSpans.find(({ name }) => name === 'execute_tool search')?.span;
    expect(toolSpan?.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.ERROR, message: 'run boom' });
    expect(toolSpan?.end).toHaveBeenCalledOnce();
  });

  // ── 1.6 Error handling ──────────────────────────────────────────────────────

  it('records exception, sets ERROR status, ends span, and re-throws', async () => {
    const err = new Error('OpenAI agent failed');
    mockRun.mockRejectedValue(err);
    await expect(createOpenAIAgentHandler()(baseConfig as any, 'q')).rejects.toThrow('OpenAI agent failed');
    expect(mockSpan.recordException).toHaveBeenCalledWith(err);
    expect(mockSpan.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.ERROR, message: 'OpenAI agent failed' });
    expect(mockSpan.end).toHaveBeenCalled();
  });

  // ── 1.7 Convenience export ──────────────────────────────────────────────────

  it('openaiAgents calls config() with the correct handler and passes userInput + context', async () => {
    const { openaiAgents } = await import('../handler.js');
    const { config } = await import('@launchdarkly/ai-server');
    const mockInvoke = vi.fn().mockResolvedValue({ response: 'ok', usage: {} });
    (config as any).mockReturnValue({ invoke: mockInvoke });
    const ctx = { kind: 'user' as const, key: 'u' };
    await openaiAgents('flag', 'hello', ctx, {} as any);
    expect(config).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'flag',
        handler: expect.objectContaining({ providesFor: ['OpenAI', 'agent'] }),
      }),
    );
    expect(mockInvoke).toHaveBeenCalledWith('hello', ctx, undefined);
  });

  // ── 1.8 Streaming ────────────────────────────────────────────────────────────

  async function collectStream<T>(gen: AsyncGenerator<T>): Promise<T[]> {
    const out: T[] = [];
    for await (const e of gen) out.push(e);
    return out;
  }

  it('handler.stream is defined', () => {
    const handler = createOpenAIAgentHandler();
    expect(typeof handler.stream).toBe('function');
  });

  it('yields chunk events from raw model text delta events', async () => {
    const streamedResult = {
      [Symbol.asyncIterator]: async function* () {
        yield { type: 'raw_model_stream_event', data: { type: 'response.output_text.delta', delta: 'Hello' } };
        yield { type: 'raw_model_stream_event', data: { type: 'response.output_text.delta', delta: ' world' } };
        yield { type: 'run_item_stream_event', item: {} };
      },
      state: { usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 } },
      finalOutput: 'Hello world',
    };
    mockRun.mockResolvedValue(streamedResult);
    const handler = createOpenAIAgentHandler();
    const events = await collectStream(handler.stream?.(baseConfig as any, 'q', {}, {}));
    const chunks = events.filter((e: any) => e.type === 'chunk').map((e: any) => e.text);
    expect(chunks).toEqual(['Hello', ' world']);
  });

  it('yields a done event with correct usage', async () => {
    const streamedResult = {
      [Symbol.asyncIterator]: async function* () {
        yield { type: 'raw_model_stream_event', data: { type: 'response.output_text.delta', delta: 'hi' } };
      },
      state: { usage: { inputTokens: 4, outputTokens: 6, totalTokens: 10 } },
      finalOutput: 'hi',
    };
    mockRun.mockResolvedValue(streamedResult);
    const handler = createOpenAIAgentHandler();
    const events = await collectStream(handler.stream?.(baseConfig as any, 'q', {}, {}));
    const done = events.at(-1) as any;
    expect(done.type).toBe('done');
    expect(done.usage).toMatchObject({ input_tokens: 4, output_tokens: 6 });
  });

  it('sets invoke_agent on the root and emits a chat span on streaming', async () => {
    mockInnerGetStreamed.mockImplementation(async function* () {
      yield { type: 'response_done', response: { usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } } };
    });
    mockRun.mockImplementation(async () => {
      const model = await mockProviderRef.current.getModel('gpt-4o');
      // Drain the wrapped stream so SpanningModel opens+closes the chat span, as the real Runner would.
      for await (const _event of model.getStreamedResponse({})) {
        /* drain */
      }
      return {
        [Symbol.asyncIterator]: async function* () {},
        state: { usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
        finalOutput: '',
      };
    });
    await collectStream(createOpenAIAgentHandler({ captureContent: true }).stream?.(baseConfig as any, 'q', {}, {}));
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('gen_ai.operation.name', 'invoke_agent');
    expect(latestModelSpan()?.setAttribute).toHaveBeenCalledWith('gen_ai.system', 'openai');
    expect(latestModelSpan()?.setAttribute).toHaveBeenCalledWith('gen_ai.usage.input_tokens', 1);
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('gen_ai.prompt.1.content', 'q');
    expect(mockSpan.addEvent).toHaveBeenCalledWith('gen_ai.content.prompt', expect.anything());
    expect(mockSpan.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.OK });
  });

  it('records exception on stream error', async () => {
    const err = new Error('agent stream fail');
    mockRun.mockRejectedValue(err);
    await expect(collectStream(createOpenAIAgentHandler().stream?.(baseConfig as any, 'q', {}, {}))).rejects.toThrow(
      'agent stream fail',
    );
    expect(mockSpan.recordException).toHaveBeenCalledWith(err);
    expect(mockSpan.setStatus).toHaveBeenCalledWith(expect.objectContaining({ code: SpanStatusCode.ERROR }));
  });

  // ── History ──────────────────────────────────────────────────────────────────

  const sampleHistory = [
    { role: 'user' as const, content: 'What is feature flagging?' },
    { role: 'assistant' as const, content: 'Feature flagging is a technique...' },
  ];

  it('history is appended to system prompt / instructions', async () => {
    mockRun.mockResolvedValue(mockRunResult());
    await createOpenAIAgentHandler()(baseConfig as any, 'q', {}, {}, sampleHistory);
    const instructions = mockAgentConstructor.mock.calls[0][0].instructions;
    expect(instructions).toContain('You are helpful.');
    expect(instructions).toContain('Conversation History:');
  });

  it('history format is correct', async () => {
    mockRun.mockResolvedValue(mockRunResult());
    await createOpenAIAgentHandler()(baseConfig as any, 'q', {}, {}, sampleHistory);
    const instructions = mockAgentConstructor.mock.calls[0][0].instructions;
    expect(instructions).toContain('user: What is feature flagging?');
    expect(instructions).toContain('assistant: Feature flagging is a technique...');
  });

  it('empty history is treated like no history', async () => {
    mockRun.mockResolvedValue(mockRunResult());
    await createOpenAIAgentHandler()(baseConfig as any, 'q', {}, {}, []);
    const instructions = mockAgentConstructor.mock.calls[0][0].instructions;
    expect(instructions).not.toContain('Conversation History:');
    expect(instructions).toBe('You are helpful.');
  });

  it('history without prior system prompt', async () => {
    mockRun.mockResolvedValue(mockRunResult());
    const config = { model: { name: 'gpt-4o' }, provider: { name: 'OpenAI' } };
    await createOpenAIAgentHandler()(config as any, 'q', {}, {}, sampleHistory);
    const instructions = mockAgentConstructor.mock.calls[0][0].instructions;
    expect(instructions).toContain('Conversation History:');
    expect(instructions).toContain('user: What is feature flagging?');
    expect(instructions).toContain('assistant: Feature flagging is a technique...');
  });
});

// ── §1.9 outputFormat — first-class (Agent outputType) ───────────────────────

describe('createOpenAIAgentHandler — outputFormat (§1.9)', () => {
  const outputFormat = { type: 'object', properties: { score: { type: 'number' } } };

  beforeEach(() => {
    vi.clearAllMocks();
    mockChildSpans.length = 0;
    for (const key of Object.keys(mockSpan)) {
      (mockSpan as any)[key].mockReset?.();
    }
  });

  it('wraps outputFormat in a JsonSchemaDefinition envelope for Agent outputType', async () => {
    mockRun.mockResolvedValue({
      finalOutput: { score: 9 },
      state: { usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 } },
    });
    const config = { ...baseConfig, outputFormat };
    await createOpenAIAgentHandler()(config as any, 'hello');
    const agentArgs = mockAgentConstructor.mock.calls[0][0];
    // outputFormat (the raw schema content) must be nested under `schema` inside
    // the JsonSchemaDefinition wrapper — not spread at the top level.
    expect(agentArgs.outputType).toMatchObject({
      type: 'json_schema',
      name: 'output',
      strict: false,
      schema: expect.objectContaining(outputFormat),
    });
  });

  it('returns finalOutput object directly when outputFormat is set', async () => {
    const parsedOutput = { score: 9 };
    mockRun.mockResolvedValue({
      finalOutput: parsedOutput,
      state: { usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 } },
    });
    const config = { ...baseConfig, outputFormat };
    const result = await createOpenAIAgentHandler()(config as any, 'hello');
    expect(result.output).toEqual(parsedOutput);
  });

  it('does not pass outputType when outputFormat is absent', async () => {
    mockRun.mockResolvedValue(mockRunResult());
    await createOpenAIAgentHandler()(baseConfig as any, 'hello');
    const agentArgs = mockAgentConstructor.mock.calls[0][0];
    expect(agentArgs.outputType).toBeUndefined();
  });
});

// ─── openaiGraph ─────────────────────────────────────────────────────────────

describe('openaiGraph', () => {
  beforeEach(() => {
    mockGraph.mockClear();
  });

  it('calls graph() with the correct flag key', () => {
    openaiGraph('graph-flag', {});
    expect(mockGraph).toHaveBeenCalledWith('graph-flag', expect.any(Object));
  });

  it('pre-binds the OpenAI agent handler into graph()', () => {
    openaiGraph('graph-flag', {});
    const [[, opts]] = mockGraph.mock.calls;
    expect(opts.handlers).toHaveLength(1);
    expect(opts.handlers[0].providesFor).toEqual(['OpenAI', 'agent']);
  });

  it('forwards user-supplied options to graph()', () => {
    const myTool = vi.fn();
    openaiGraph('graph-flag', { toolHandlers: { myTool } });
    const [[, opts]] = mockGraph.mock.calls;
    expect(opts.toolHandlers).toEqual({ myTool });
  });
});
