import { SpanStatusCode } from '@opentelemetry/api';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const { mockResponsesCreate, mockResponsesStream } = vi.hoisted(() => ({
  mockResponsesCreate: vi.fn(),
  mockResponsesStream: vi.fn(),
}));
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

vi.mock('openai', () => ({
  default: class {
    responses = { create: mockResponsesCreate, stream: mockResponsesStream };
  },
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
  };
});

import { createOpenAIHandler } from '../handler.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const baseConfig = {
  model: { name: 'gpt-4o' },
  provider: { name: 'OpenAI' },
  instructions: 'You are helpful.',
};

function mockFinalResponse(outputText = 'Hello!', inputTokens = 10, outputTokens = 5) {
  return {
    id: 'resp_1',
    model: 'gpt-4o',
    output: [{ type: 'message', content: [{ type: 'output_text', text: outputText }] }],
    output_text: outputText,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  };
}

function mockToolCallResponse(toolName: string, args: Record<string, unknown> = {}) {
  return {
    id: 'resp_tool',
    model: 'gpt-4o',
    output: [{ type: 'function_call', name: toolName, call_id: 'call_1', arguments: JSON.stringify(args) }],
    output_text: '',
    usage: { input_tokens: 5, output_tokens: 2 },
  };
}

function modelSpans() {
  return mockChildSpans.filter(({ name }) => name.startsWith('chat'));
}

function latestModelSpan() {
  return mockChildSpans.findLast(({ name }) => name.startsWith('chat'))?.span;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('createOpenAIHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockChildSpans.length = 0;
    for (const key of Object.keys(mockSpan)) {
      (mockSpan as any)[key].mockReset?.();
    }
  });

  // ── 1.1 Factory and metadata ────────────────────────────────────────────────

  it('returns a callable function', () => {
    expect(typeof createOpenAIHandler()).toBe('function');
  });

  it('attaches providesFor = ["OpenAI", "messages"]', () => {
    expect(createOpenAIHandler().providesFor).toEqual(['OpenAI', 'messages']);
  });

  it('returns independent instances on multiple calls', () => {
    expect(createOpenAIHandler()).not.toBe(createOpenAIHandler());
  });

  // ── 1.2 Prompt construction ─────────────────────────────────────────────────

  it('uses instructions as system message', async () => {
    mockResponsesCreate.mockResolvedValue(mockFinalResponse());
    await createOpenAIHandler()(baseConfig as any, 'hello');
    const { input } = mockResponsesCreate.mock.calls[0][0];
    const systemMsg = input.find((m: any) => m.role === 'system');
    expect(systemMsg?.content).toBe('You are helpful.');
    expect(input.at(-1).content).toBe('hello');
  });

  it('substitutes variables in instructions', async () => {
    mockResponsesCreate.mockResolvedValue(mockFinalResponse());
    const config = { ...baseConfig, instructions: 'Hello {{name}}.' };
    await createOpenAIHandler()(config as any, 'q', {}, { name: 'Bob' });
    const { input } = mockResponsesCreate.mock.calls[0][0];
    const systemMsg = input.find((m: any) => m.role === 'system');
    expect(systemMsg?.content).toBe('Hello Bob.');
  });

  it('leaves unresolved placeholders in instructions unchanged', async () => {
    mockResponsesCreate.mockResolvedValue(mockFinalResponse());
    const config = { ...baseConfig, instructions: 'Hello {{missing}}.' };
    await createOpenAIHandler()(config as any, 'q', {}, {});
    const { input } = mockResponsesCreate.mock.calls[0][0];
    const systemMsg = input.find((m: any) => m.role === 'system');
    expect(systemMsg?.content).toBe('Hello {{missing}}.');
  });

  it('uses messages array when instructions absent — skips appending when last is user', async () => {
    mockResponsesCreate.mockResolvedValue(mockFinalResponse());
    const config = {
      model: { name: 'gpt-4o' },
      provider: { name: 'OpenAI' },
      messages: [
        { role: 'system', content: 'Be concise.' },
        { role: 'user', content: 'Earlier question' },
      ],
    };
    await createOpenAIHandler()(config as any, 'new question');
    const { input } = mockResponsesCreate.mock.calls[0][0];
    expect(input[0].content).toBe('Be concise.');
    expect(input).toHaveLength(2);
    expect(input[1].content).toBe('Earlier question');
  });

  it('appends userInput when last message is assistant', async () => {
    mockResponsesCreate.mockResolvedValue(mockFinalResponse());
    const config = {
      model: { name: 'gpt-4o' },
      provider: { name: 'OpenAI' },
      messages: [
        { role: 'system', content: 'Be concise.' },
        { role: 'user', content: 'Earlier question' },
        { role: 'assistant', content: 'Earlier answer' },
      ],
    };
    await createOpenAIHandler()(config as any, 'new question');
    const { input } = mockResponsesCreate.mock.calls[0][0];
    expect(input.at(-1).content).toBe('new question');
  });

  it('substitutes variables in messages array content', async () => {
    mockResponsesCreate.mockResolvedValue(mockFinalResponse());
    const config = {
      model: { name: 'gpt-4o' },
      provider: { name: 'OpenAI' },
      messages: [
        { role: 'system', content: 'You help {{team}}.' },
        { role: 'user', content: 'Question from {{user}}' },
      ],
    };
    await createOpenAIHandler()(config as any, 'new q', {}, { team: 'eng', user: 'Alice' });
    const { input } = mockResponsesCreate.mock.calls[0][0];
    expect(input[0].content).toBe('You help eng.');
    expect(input[1].content).toBe('Question from Alice');
  });

  it('messages array wins over instructions when both are present', async () => {
    mockResponsesCreate.mockResolvedValue(mockFinalResponse());
    const config = {
      model: { name: 'gpt-4o' },
      provider: { name: 'OpenAI' },
      instructions: 'Instructions system prompt',
      messages: [
        { role: 'system', content: 'Messages system prompt' },
        { role: 'user', content: 'Earlier turn' },
      ],
    };
    await createOpenAIHandler()(config as any, 'new q');
    const { input } = mockResponsesCreate.mock.calls[0][0];
    const contents = input.map((m: any) => m.content);
    expect(contents).toContain('Messages system prompt');
    expect(contents).not.toContain('Instructions system prompt');
  });

  it('does not throw when userInput is empty string', async () => {
    mockResponsesCreate.mockResolvedValue(mockFinalResponse());
    await expect(createOpenAIHandler()(baseConfig as any, '')).resolves.not.toThrow();
  });

  it('does not throw when userInput is undefined', async () => {
    mockResponsesCreate.mockResolvedValue(mockFinalResponse());
    await expect(createOpenAIHandler()(baseConfig as any, undefined)).resolves.not.toThrow();
  });

  it('appends an empty user message in the messages path when userInput is empty string', async () => {
    mockResponsesCreate.mockResolvedValue(mockFinalResponse());
    const config = {
      model: { name: 'gpt-4o' },
      provider: { name: 'OpenAI' },
      messages: [{ role: 'system', content: 'Be helpful.' }],
    };
    await createOpenAIHandler()(config as any, '');
    const { input } = mockResponsesCreate.mock.calls[0][0];
    expect(input.at(-1)).toMatchObject({ role: 'user', content: '' });
  });

  // ── 1.3 Tool conversion ─────────────────────────────────────────────────────

  it('includes tools in provider call when config.tools is present', async () => {
    mockResponsesCreate.mockResolvedValue(mockFinalResponse());
    const config = {
      ...baseConfig,
      tools: {
        search: {
          name: 'search',
          type: 'function' as const,
          parameters: { type: 'object', properties: {} },
          description: 'Search',
        },
      },
    };
    await createOpenAIHandler()(config as any, 'q', { search: vi.fn() });
    const call = mockResponsesCreate.mock.calls[0][0];
    expect(call.tools).toHaveLength(1);
    expect(call.tools[0].name).toBe('search');
  });

  it('forwards all fields (name, description, parameters) for each tool', async () => {
    mockResponsesCreate.mockResolvedValue(mockFinalResponse());
    const config = {
      ...baseConfig,
      tools: {
        search: {
          name: 'search',
          type: 'function' as const,
          parameters: { type: 'object', properties: { q: { type: 'string' } } },
          description: 'Web search',
        },
      },
    };
    await createOpenAIHandler()(config as any, 'q', { search: vi.fn() });
    const tool = mockResponsesCreate.mock.calls[0][0].tools[0];
    expect(tool.name).toBe('search');
    expect(tool.description).toBe('Web search');
    expect(tool.parameters).toEqual({ type: 'object', properties: { q: { type: 'string' } } });
  });

  it('includes all tools when config.tools has multiple entries', async () => {
    mockResponsesCreate.mockResolvedValue(mockFinalResponse());
    const config = {
      ...baseConfig,
      tools: {
        toolA: { name: 'toolA', type: 'function' as const, parameters: {} },
        toolB: { name: 'toolB', type: 'function' as const, parameters: {} },
        toolC: { name: 'toolC', type: 'function' as const, parameters: {} },
      },
    };
    await createOpenAIHandler()(config as any, 'q', { toolA: vi.fn(), toolB: vi.fn(), toolC: vi.fn() });
    const { tools } = mockResponsesCreate.mock.calls[0][0];
    expect(tools).toHaveLength(3);
    expect(tools.map((t: any) => t.name)).toEqual(expect.arrayContaining(['toolA', 'toolB', 'toolC']));
  });

  it('sends no tools when config.tools is absent', async () => {
    mockResponsesCreate.mockResolvedValue(mockFinalResponse());
    await createOpenAIHandler()(baseConfig as any, 'q');
    const call = mockResponsesCreate.mock.calls[0][0];
    expect(call.tools ?? []).toHaveLength(0);
  });

  // ── 1.4 Tool execution loop ─────────────────────────────────────────────────

  it('invokes the tool handler and loops until end', async () => {
    const myTool = vi.fn().mockReturnValue('result');
    mockResponsesCreate
      .mockResolvedValueOnce(mockToolCallResponse('myTool', { x: 1 }))
      .mockResolvedValueOnce(mockFinalResponse('Done'));

    const config = {
      ...baseConfig,
      tools: { myTool: { name: 'myTool', type: 'function' as const, parameters: {} } },
    };
    const result = await createOpenAIHandler()(config as any, 'q', { myTool });
    expect(myTool).toHaveBeenCalledWith({ x: 1 });
    expect(result.output).toBe('Done');
  });

  it('handles multiple consecutive tool calls across turns', async () => {
    const toolA = vi.fn().mockReturnValue('resultA');
    const toolB = vi.fn().mockReturnValue('resultB');
    mockResponsesCreate
      .mockResolvedValueOnce(mockToolCallResponse('toolA', { a: 1 }))
      .mockResolvedValueOnce(mockToolCallResponse('toolB', { b: 2 }))
      .mockResolvedValueOnce(mockFinalResponse('All done'));

    const config = {
      ...baseConfig,
      tools: {
        toolA: { name: 'toolA', type: 'function' as const, parameters: {} },
        toolB: { name: 'toolB', type: 'function' as const, parameters: {} },
      },
    };
    const result = await createOpenAIHandler()(config as any, 'q', { toolA, toolB });
    expect(toolA).toHaveBeenCalledOnce();
    expect(toolB).toHaveBeenCalledOnce();
    expect(result.output).toBe('All done');
  });

  it('throws when provider requests an unregistered tool', async () => {
    mockResponsesCreate.mockResolvedValueOnce(mockToolCallResponse('unknownTool'));
    const config = {
      ...baseConfig,
      tools: { unknownTool: { name: 'unknownTool', type: 'function' as const, parameters: {} } },
    };
    await expect(createOpenAIHandler()(config as any, 'q', {})).rejects.toThrow(/unknownTool/);
  });

  it('propagates errors thrown by a tool handler', async () => {
    const boom = vi.fn().mockRejectedValue(new Error('tool exploded'));
    mockResponsesCreate.mockResolvedValueOnce(mockToolCallResponse('boom'));
    const config = {
      ...baseConfig,
      tools: { boom: { name: 'boom', type: 'function' as const, parameters: {} } },
    };
    await expect(createOpenAIHandler()(config as any, 'q', { boom })).rejects.toThrow('tool exploded');
  });

  it('does not invoke toolHandlers when config.tools is absent', async () => {
    const shouldNotBeCalled = vi.fn();
    mockResponsesCreate.mockResolvedValue(mockFinalResponse());
    await createOpenAIHandler()(baseConfig as any, 'q', { shouldNotBeCalled });
    expect(shouldNotBeCalled).not.toHaveBeenCalled();
    expect(mockResponsesCreate).toHaveBeenCalledOnce();
  });

  // ── 1.5 Telemetry ───────────────────────────────────────────────────────────

  it('opens a root span named "invoke_agent"', async () => {
    mockResponsesCreate.mockResolvedValue(mockFinalResponse());
    const { trace } = await import('@opentelemetry/api');
    const tracer = trace.getTracer('');
    await createOpenAIHandler()(baseConfig as any, 'q');
    expect(tracer.startActiveSpan).toHaveBeenCalledWith('invoke_agent', expect.any(Function));
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('gen_ai.operation.name', 'invoke_agent');
  });

  it('sets gen_ai usage attributes on the chat model span', async () => {
    mockResponsesCreate.mockResolvedValue(mockFinalResponse('hi', 8, 4));
    await createOpenAIHandler()(baseConfig as any, 'q');
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

  it('emits no content at all by default', async () => {
    mockResponsesCreate.mockResolvedValue(mockFinalResponse('answer'));
    await createOpenAIHandler()(baseConfig as any, 'question');

    // Conversation content is PII, so a caller has to ask for it. Asserting on the recorded
    // arguments rather than on specific keys catches a new content attribute added without a gate.
    const written = JSON.stringify(mockSpan.setAttribute.mock.calls);
    expect(written).not.toContain('question');
    expect(mockSpan.addEvent).not.toHaveBeenCalledWith('gen_ai.content.prompt', expect.anything());
  });

  it('puts prompt and completion on span attributes when capture is enabled', async () => {
    mockResponsesCreate.mockResolvedValue(mockFinalResponse('answer'));
    await createOpenAIHandler({ captureContent: true })(baseConfig as any, 'question');

    // Attributes, not events: OTEP 4430 deprecated event-recorded content and LaunchDarkly's
    // readers parse only attributes.
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('gen_ai.prompt.1.content', 'question');
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('gen_ai.completion.0.content', 'answer');
    expect(mockSpan.addEvent).toHaveBeenCalledWith('gen_ai.content.prompt', expect.anything());
  });

  it('sets OK status and ends span on success', async () => {
    mockResponsesCreate.mockResolvedValue(mockFinalResponse());
    await createOpenAIHandler()(baseConfig as any, 'q');
    expect(mockSpan.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.OK });
    expect(mockSpan.end).toHaveBeenCalled();
  });

  // ── 1.6 Span hierarchy (invoke_agent → chat → execute_tool) ──────────────────

  it('emits one chat child span per model turn under the invoke_agent root', async () => {
    mockResponsesCreate
      .mockResolvedValueOnce(mockToolCallResponse('myTool', { x: 1 }))
      .mockResolvedValueOnce(mockFinalResponse('done', 3, 4));

    const config = {
      ...baseConfig,
      tools: { myTool: { name: 'myTool', type: 'function' as const, parameters: {} } },
    };
    await createOpenAIHandler()(config as any, 'q', { myTool: vi.fn().mockReturnValue('r') });

    const chats = modelSpans();
    expect(chats).toHaveLength(2);
    expect(chats.every(({ span }) => span.end.mock.calls.length === 1)).toBe(true);
    // `{operation} {request.model}`, per the semantic conventions for an inference span.
    expect(chats.every(({ name }) => name === `chat ${baseConfig.model.name}`)).toBe(true);
  });

  it('emits an execute_tool child span per tool call, keyed by call id', async () => {
    mockResponsesCreate
      .mockResolvedValueOnce(mockToolCallResponse('myTool', { x: 1 }))
      .mockResolvedValueOnce(mockFinalResponse('done', 3, 4));

    const config = {
      ...baseConfig,
      tools: { myTool: { name: 'myTool', type: 'function' as const, parameters: {} } },
    };
    await createOpenAIHandler()(config as any, 'q', { myTool: vi.fn().mockReturnValue('r') });

    const toolSpan = mockChildSpans.find(({ name }) => name === 'execute_tool myTool')?.span;
    expect(toolSpan?.setAttribute).toHaveBeenCalledWith('gen_ai.operation.name', 'execute_tool');
    expect(toolSpan?.setAttribute).toHaveBeenCalledWith('gen_ai.tool.name', 'myTool');
    expect(toolSpan?.setAttribute).toHaveBeenCalledWith('gen_ai.tool.call.id', 'call_1');
    expect(toolSpan?.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.OK });
    expect(toolSpan?.end).toHaveBeenCalledOnce();
  });

  it('reports OpenAI cached tokens as cache_read without adding them to the input total', async () => {
    mockResponsesCreate.mockResolvedValue({
      ...mockFinalResponse('hi', 50, 5),
      // OpenAI already includes cached tokens inside input_tokens; cached is a subset, not additive.
      usage: { input_tokens: 50, output_tokens: 5, input_tokens_details: { cached_tokens: 30 } },
    });

    await createOpenAIHandler()(baseConfig as any, 'q');

    const modelSpan = latestModelSpan();
    expect(modelSpan?.setAttribute).toHaveBeenCalledWith('gen_ai.usage.input_tokens', 50);
    expect(modelSpan?.setAttribute).toHaveBeenCalledWith('gen_ai.usage.output_tokens', 5);
    expect(modelSpan?.setAttribute).toHaveBeenCalledWith('gen_ai.usage.total_tokens', 55);
    expect(modelSpan?.setAttribute).toHaveBeenCalledWith('gen_ai.usage.cache_read.input_tokens', 30);
    // OpenAI has no cache-creation concept; still emitted, as 0, so the set is always complete.
    expect(modelSpan?.setAttribute).toHaveBeenCalledWith('gen_ai.usage.cache_creation.input_tokens', 0);
  });

  it('fails the chat span when the provider call throws', async () => {
    const err = new Error('provider down');
    mockResponsesCreate.mockRejectedValueOnce(err);

    await expect(createOpenAIHandler()(baseConfig as any, 'q')).rejects.toThrow('provider down');

    const modelSpan = latestModelSpan();
    expect(modelSpan?.recordException).toHaveBeenCalledWith(err);
    expect(modelSpan?.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.ERROR, message: 'provider down' });
    expect(modelSpan?.end).toHaveBeenCalledOnce();
  });

  it('fails the execute_tool span when a tool handler throws', async () => {
    const err = new Error('tool boom');
    mockResponsesCreate.mockResolvedValueOnce(mockToolCallResponse('myTool', {}));

    const config = {
      ...baseConfig,
      tools: { myTool: { name: 'myTool', type: 'function' as const, parameters: {} } },
    };
    await expect(createOpenAIHandler()(config as any, 'q', { myTool: vi.fn().mockRejectedValue(err) })).rejects.toThrow(
      'tool boom',
    );

    const toolSpan = mockChildSpans.find(({ name }) => name === 'execute_tool myTool')?.span;
    expect(toolSpan?.recordException).toHaveBeenCalledWith(err);
    expect(toolSpan?.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.ERROR, message: 'tool boom' });
    expect(toolSpan?.end).toHaveBeenCalledOnce();
  });

  // ── 1.5 LaunchDarkly config-association span attributes ──────────────────────

  const ldFixture = {
    __ld: {
      configKey: 'test-config',
      variationKey: 'variation-a',
      runId: 'run-123',
      version: 1,
      modelName: 'test-model',
      providerName: 'TestProvider',
    },
  };

  it('sets launchdarkly.operation.type, config.key, variation.key, and run.id when __ld is in variables', async () => {
    mockResponsesCreate.mockResolvedValue(mockFinalResponse());
    await createOpenAIHandler()(baseConfig as any, 'q', {}, ldFixture);
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('launchdarkly.operation.type', 'gen_ai');
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('launchdarkly.config.key', 'test-config');
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('launchdarkly.variation.key', 'variation-a');
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('launchdarkly.run.id', 'run-123');
  });

  it('does not set launchdarkly.graph.key when graphKey is absent in __ld', async () => {
    mockResponsesCreate.mockResolvedValue(mockFinalResponse());
    await createOpenAIHandler()(baseConfig as any, 'q', {}, ldFixture);
    const graphKeyCalls = mockSpan.setAttribute.mock.calls.filter((c: any[]) => c[0] === 'launchdarkly.graph.key');
    expect(graphKeyCalls).toHaveLength(0);
  });

  it('sets launchdarkly.graph.key when graphKey is present in __ld', async () => {
    mockResponsesCreate.mockResolvedValue(mockFinalResponse());
    const vars = { __ld: { ...ldFixture.__ld, graphKey: 'my-graph' } };
    await createOpenAIHandler()(baseConfig as any, 'q', {}, vars);
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('launchdarkly.graph.key', 'my-graph');
  });

  it('sets launchdarkly.operation.type in the streaming path when __ld is in variables', async () => {
    const streamFinalResp = {
      id: 'resp-ld',
      model: 'gpt-4o',
      usage: { input_tokens: 1, output_tokens: 1 },
      output: [],
      output_text: 'hi',
    };
    async function* deltaGen() {
      yield { type: 'response.output_text.delta', delta: 'hi' };
    }
    const streamMock = {
      [Symbol.asyncIterator]: () => deltaGen()[Symbol.asyncIterator](),
      finalResponse: vi.fn().mockResolvedValue(streamFinalResp),
    };
    mockResponsesStream.mockReturnValue(streamMock);
    const handler = createOpenAIHandler();
    const streamFn = handler.stream as NonNullable<typeof handler.stream>;
    const events: any[] = [];
    for await (const e of streamFn(baseConfig as any, 'q', {}, ldFixture)) {
      events.push(e);
    }
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('launchdarkly.operation.type', 'gen_ai');
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('launchdarkly.config.key', 'test-config');
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('launchdarkly.variation.key', 'variation-a');
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('launchdarkly.run.id', 'run-123');
    expect(mockSpan.addEvent).toHaveBeenCalledWith(
      'feature_flag',
      expect.objectContaining({ 'feature_flag.key': 'test-config' }),
    );
  });

  // The `feature_flag` span event is how the AI Config Monitoring tab locates a trace
  // (events.name = feature_flag AND events.attributes.feature_flag.key = <configKey>). It has to be
  // on the root, because the root is what that query finds. Dropping it, or emitting it on a child
  // instead, silently detaches every trace from its AI Config with nothing else failing.

  it('emits the feature_flag correlation event on the root span', async () => {
    mockResponsesCreate.mockResolvedValue(mockFinalResponse());
    await createOpenAIHandler()(baseConfig as any, 'q', {}, ldFixture);
    expect(mockSpan.addEvent).toHaveBeenCalledWith(
      'feature_flag',
      expect.objectContaining({ 'feature_flag.key': 'test-config', 'feature_flag.provider.name': 'LaunchDarkly' }),
    );
  });

  it('does not emit the feature_flag event on child spans', async () => {
    mockResponsesCreate.mockResolvedValue(mockFinalResponse());
    await createOpenAIHandler()(baseConfig as any, 'q', {}, ldFixture);
    const childEvents = mockChildSpans.flatMap(({ span }) => span.addEvent.mock.calls.map((c: unknown[]) => c[0]));
    expect(childEvents).not.toContain('feature_flag');
  });

  // ── 1.6 Error handling ──────────────────────────────────────────────────────

  it('records exception, sets ERROR status, ends span, and re-throws', async () => {
    const err = new Error('OpenAI down');
    mockResponsesCreate.mockRejectedValue(err);
    await expect(createOpenAIHandler()(baseConfig as any, 'q')).rejects.toThrow('OpenAI down');
    expect(mockSpan.recordException).toHaveBeenCalledWith(err);
    expect(mockSpan.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.ERROR, message: 'OpenAI down' });
    expect(mockSpan.end).toHaveBeenCalled();
  });

  // ── 1.7 Convenience export ──────────────────────────────────────────────────

  it('openaiMessages calls config() with the correct handler', async () => {
    const { openaiMessages } = await import('../handler.js');
    const { config } = await import('@launchdarkly/ai-server');

    const ctx = { kind: 'user' as const, key: 'u' };
    await openaiMessages('flag', 'hello', ctx, {} as any);
    expect(config).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'flag',
        handler: expect.objectContaining({ providesFor: ['OpenAI', 'messages'] }),
      }),
    );
  });

  it('openaiMessages passes userInput and context to .invoke()', async () => {
    const { openaiMessages } = await import('../handler.js');
    const { config } = await import('@launchdarkly/ai-server');
    const mockInvoke = vi.fn().mockResolvedValue({ response: 'ok', usage: {} });
    (config as any).mockReturnValue({ invoke: mockInvoke });

    const ctx = { kind: 'user' as const, key: 'u2' };
    await openaiMessages('flag2', 'my input', ctx, {} as any);
    expect(mockInvoke).toHaveBeenCalledWith('my input', ctx, undefined);
  });

  // ── 1.8 Streaming ────────────────────────────────────────────────────────────

  function makeResponseStreamMock(events: any[], finalResponse: any) {
    const asyncIterable = (async function* () {
      for (const e of events) yield e;
    })();
    return {
      [Symbol.asyncIterator]: () => asyncIterable[Symbol.asyncIterator](),
      finalResponse: vi.fn().mockResolvedValue(finalResponse),
    };
  }

  async function collectStream<T>(gen: AsyncGenerator<T>): Promise<T[]> {
    const out: T[] = [];
    for await (const e of gen) out.push(e);
    return out;
  }

  const baseFinalResponse = {
    id: 'resp-1',
    model: 'gpt-4o',
    usage: { input_tokens: 10, output_tokens: 5 },
    output: [],
    output_text: 'Hello world',
  };

  it('handler.stream is defined', () => {
    const handler = createOpenAIHandler();
    expect(typeof handler.stream).toBe('function');
  });

  it('handler.stream returns an async iterable', () => {
    mockResponsesStream.mockReturnValue(
      makeResponseStreamMock([{ type: 'response.output_text.delta', delta: 'hi' }], baseFinalResponse),
    );
    const result = createOpenAIHandler().stream?.(baseConfig as any, 'q', {}, {});
    expect(result[Symbol.asyncIterator]).toBeDefined();
  });

  it('yields chunk events for each text delta', async () => {
    const streamEvents = [
      { type: 'response.output_text.delta', delta: 'Hello' },
      { type: 'response.output_text.delta', delta: ' world' },
    ];
    mockResponsesStream.mockReturnValue(makeResponseStreamMock(streamEvents, baseFinalResponse));
    const handler = createOpenAIHandler();
    const events = await collectStream(handler.stream?.(baseConfig as any, 'q', {}, {}));
    const chunks = events.filter((e: any) => e.type === 'chunk');
    expect(chunks).toEqual([
      { type: 'chunk', text: 'Hello' },
      { type: 'chunk', text: ' world' },
    ]);
  });

  it('yields a done event as the last event with correct usage', async () => {
    const streamEvents = [{ type: 'response.output_text.delta', delta: 'Hi' }];
    const finalResp = { ...baseFinalResponse, usage: { input_tokens: 3, output_tokens: 7 } };
    mockResponsesStream.mockReturnValue(makeResponseStreamMock(streamEvents, finalResp));
    const handler = createOpenAIHandler();
    const events = await collectStream(handler.stream?.(baseConfig as any, 'q', {}, {}));
    const done = events.at(-1) as any;
    expect(done.type).toBe('done');
    expect(done.usage).toMatchObject({ input_tokens: 3, output_tokens: 7 });
  });

  it('yields exactly one done event', async () => {
    mockResponsesStream.mockReturnValue(
      makeResponseStreamMock([{ type: 'response.output_text.delta', delta: 'hi' }], baseFinalResponse),
    );
    const events = await collectStream(createOpenAIHandler().stream?.(baseConfig as any, 'q', {}, {}));
    expect(events.filter((e: any) => e.type === 'done')).toHaveLength(1);
  });

  it('all chunks appear before the done event', async () => {
    mockResponsesStream.mockReturnValue(
      makeResponseStreamMock(
        [
          { type: 'response.output_text.delta', delta: 'A' },
          { type: 'response.output_text.delta', delta: 'B' },
        ],
        baseFinalResponse,
      ),
    );
    const events = await collectStream(createOpenAIHandler().stream?.(baseConfig as any, 'q', {}, {}));
    const doneIdx = events.findIndex((e: any) => e.type === 'done');
    const chunkAfterDone = events.slice(doneIdx + 1).some((e: any) => e.type === 'chunk');
    expect(chunkAfterDone).toBe(false);
  });

  it('done event output equals concatenated chunk text', async () => {
    mockResponsesStream.mockReturnValue(
      makeResponseStreamMock(
        [
          { type: 'response.output_text.delta', delta: 'Hello' },
          { type: 'response.output_text.delta', delta: ' world' },
        ],
        baseFinalResponse,
      ),
    );
    const events = await collectStream(createOpenAIHandler().stream?.(baseConfig as any, 'q', {}, {}));
    const done = events.find((e: any) => e.type === 'done') as any;
    expect(done.output).toBe('Hello world');
  });

  it('opens a streaming root span named "invoke_agent"', async () => {
    mockResponsesStream.mockReturnValue(
      makeResponseStreamMock([{ type: 'response.output_text.delta', delta: 'hi' }], baseFinalResponse),
    );
    const { trace } = await import('@opentelemetry/api');
    const tracer = trace.getTracer('');
    await collectStream(createOpenAIHandler().stream?.(baseConfig as any, 'q', {}, {}));
    expect(tracer.startSpan).toHaveBeenCalledWith('invoke_agent');
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('gen_ai.operation.name', 'invoke_agent');
  });

  it('yields chunks from all turns and done.output spans pre- and post-tool text', async () => {
    const myTool = vi.fn().mockReturnValue('tool result');

    const toolFinalResponse = {
      id: 'resp-tool',
      model: 'gpt-4o',
      usage: { input_tokens: 5, output_tokens: 2 },
      output: [{ type: 'function_call', name: 'myTool', call_id: 'call_1', arguments: JSON.stringify({ x: 99 }) }],
      output_text: '',
    };
    const postToolFinalResponse = {
      id: 'resp-2',
      model: 'gpt-4o',
      usage: { input_tokens: 3, output_tokens: 4 },
      output: [],
      output_text: ' after',
    };

    mockResponsesStream
      .mockReturnValueOnce(
        makeResponseStreamMock([{ type: 'response.output_text.delta', delta: 'before' }], toolFinalResponse),
      )
      .mockReturnValueOnce(
        makeResponseStreamMock([{ type: 'response.output_text.delta', delta: ' after' }], postToolFinalResponse),
      );

    const config = {
      ...baseConfig,
      tools: { myTool: { name: 'myTool', type: 'function' as const, parameters: {} } },
    };
    const events = await collectStream(createOpenAIHandler().stream?.(config as any, 'q', { myTool }, {}));
    const chunks = events.filter((e: any) => e.type === 'chunk').map((e: any) => e.text);
    expect(chunks).toEqual(['before', ' after']);
    expect(myTool).toHaveBeenCalledWith({ x: 99 });
    const done = events.find((e: any) => e.type === 'done') as any;
    expect(done.output).toBe('before after');
  });

  it('sets span attributes and puts content on attributes when enabled', async () => {
    mockResponsesStream.mockReturnValue(
      makeResponseStreamMock([{ type: 'response.output_text.delta', delta: 'hi' }], baseFinalResponse),
    );
    await collectStream(createOpenAIHandler({ captureContent: true }).stream?.(baseConfig as any, 'q', {}, {}));
    const modelSpan = latestModelSpan();
    expect(modelSpan?.setAttribute).toHaveBeenCalledWith('gen_ai.system', 'openai');
    expect(modelSpan?.setAttribute).toHaveBeenCalledWith('gen_ai.request.model', 'gpt-4o');
    expect(modelSpan?.setAttribute).toHaveBeenCalledWith('gen_ai.response.model', baseFinalResponse.model);
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('gen_ai.prompt.1.content', 'q');
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('gen_ai.completion.0.content', 'hi');
    expect(mockSpan.addEvent).toHaveBeenCalledWith('gen_ai.content.completion', expect.anything());
    expect(mockSpan.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.OK });
    expect(mockSpan.end).toHaveBeenCalled();
  });

  it('records exception on provider stream error', async () => {
    const err = new Error('stream error');
    mockResponsesStream.mockImplementation(() => {
      throw err;
    });
    await expect(collectStream(createOpenAIHandler().stream?.(baseConfig as any, 'q', {}, {}))).rejects.toThrow(
      'stream error',
    );
    expect(mockSpan.recordException).toHaveBeenCalledWith(err);
    expect(mockSpan.setStatus).toHaveBeenCalledWith(expect.objectContaining({ code: SpanStatusCode.ERROR }));
    expect(mockSpan.end).toHaveBeenCalled();
  });

  it('throws and records error when streaming encounters an unregistered tool', async () => {
    const toolFinalResponse = {
      id: 'resp-tool',
      model: 'gpt-4o',
      usage: { input_tokens: 2, output_tokens: 1 },
      output: [{ type: 'function_call', name: 'unknownTool', call_id: 'c1', arguments: '{}' }],
      output_text: '',
    };
    mockResponsesStream.mockReturnValue(makeResponseStreamMock([], toolFinalResponse));
    const config = {
      ...baseConfig,
      tools: { unknownTool: { name: 'unknownTool', type: 'function' as const, parameters: {} } },
    };
    await expect(collectStream(createOpenAIHandler().stream?.(config as any, 'q', {}, {}))).rejects.toThrow(
      /unknownTool/,
    );
    expect(mockSpan.recordException).toHaveBeenCalled();
    expect(mockSpan.setStatus).toHaveBeenCalledWith(expect.objectContaining({ code: SpanStatusCode.ERROR }));
    expect(mockSpan.end).toHaveBeenCalled();
  });

  it('throws and records error when tool handler rejects during streaming', async () => {
    const err = new Error('tool boom');
    const toolFinalResponse = {
      id: 'resp-tool',
      model: 'gpt-4o',
      usage: { input_tokens: 2, output_tokens: 1 },
      output: [{ type: 'function_call', name: 'myTool', call_id: 'c1', arguments: '{}' }],
      output_text: '',
    };
    mockResponsesStream.mockReturnValue(makeResponseStreamMock([], toolFinalResponse));
    const config = { ...baseConfig, tools: { myTool: { name: 'myTool', type: 'function' as const, parameters: {} } } };
    const brokenTool = vi.fn().mockRejectedValue(err);
    await expect(
      collectStream(createOpenAIHandler().stream?.(config as any, 'q', { myTool: brokenTool }, {})),
    ).rejects.toThrow('tool boom');
    expect(mockSpan.recordException).toHaveBeenCalledWith(err);
    expect(mockSpan.setStatus).toHaveBeenCalledWith(expect.objectContaining({ code: SpanStatusCode.ERROR }));
    expect(mockSpan.end).toHaveBeenCalled();
  });

  // ── History ──────────────────────────────────────────────────────────────────

  const sampleHistory = [
    { role: 'user' as const, content: 'What is feature flagging?' },
    { role: 'assistant' as const, content: 'Feature flagging is a technique...' },
  ];

  it('history messages are inserted between config messages and userInput', async () => {
    mockResponsesCreate.mockResolvedValue(mockFinalResponse());
    const config = {
      model: { name: 'gpt-4o' },
      provider: { name: 'OpenAI' },
      messages: [
        { role: 'system', content: 'Be concise.' },
        { role: 'user', content: 'Previous question' },
        { role: 'assistant', content: 'Previous answer' },
      ],
    };
    await createOpenAIHandler()(config as any, 'new question', {}, {}, sampleHistory);
    const { input } = mockResponsesCreate.mock.calls[0][0];
    expect(input[0]).toMatchObject({ role: 'system', content: 'Be concise.' });
    expect(input[1]).toMatchObject({ role: 'user', content: 'Previous question' });
    expect(input[2]).toMatchObject({ role: 'assistant', content: 'Previous answer' });
    expect(input[3]).toMatchObject({ role: 'user', content: 'What is feature flagging?' });
    expect(input[4]).toMatchObject({ role: 'assistant', content: 'Feature flagging is a technique...' });
    expect(input.at(-1)).toMatchObject({ role: 'user', content: 'new question' });
  });

  it('history with instructions path — history messages appear before userInput', async () => {
    mockResponsesCreate.mockResolvedValue(mockFinalResponse());
    await createOpenAIHandler()(baseConfig as any, 'follow up', {}, {}, sampleHistory);
    const { input } = mockResponsesCreate.mock.calls[0][0];
    expect(input[0]).toMatchObject({ role: 'system', content: 'You are helpful.' });
    expect(input[1]).toMatchObject({ role: 'user', content: 'What is feature flagging?' });
    expect(input[2]).toMatchObject({ role: 'assistant', content: 'Feature flagging is a technique...' });
    expect(input.at(-1)).toMatchObject({ role: 'user', content: 'follow up' });
  });

  it('empty history is treated like no history', async () => {
    mockResponsesCreate.mockResolvedValue(mockFinalResponse());
    await createOpenAIHandler()(baseConfig as any, 'hi', {}, {}, []);
    const withEmpty = mockResponsesCreate.mock.calls[0][0].input;

    mockResponsesCreate.mockClear();
    mockResponsesCreate.mockResolvedValue(mockFinalResponse());
    await createOpenAIHandler()(baseConfig as any, 'hi');
    const without = mockResponsesCreate.mock.calls[0][0].input;

    expect(withEmpty).toEqual(without);
  });

  it('system role messages in history are included as-is by OpenAI handler', async () => {
    mockResponsesCreate.mockResolvedValue(mockFinalResponse());
    const historyWithSystem = [
      { role: 'user' as const, content: 'Hello' },
      { role: 'system' as const, content: 'System in history' },
      { role: 'assistant' as const, content: 'Hi there' },
    ];
    await createOpenAIHandler()(baseConfig as any, 'follow up', {}, {}, historyWithSystem);
    const { input } = mockResponsesCreate.mock.calls[0][0];
    const contents = input.map((m: any) => m.content);
    expect(contents).toContain('Hello');
    expect(contents).toContain('Hi there');
  });
});

// ── §1.4 Token accumulation across multiple tool turns (blocking) ────────────

describe('createOpenAIHandler — token accumulation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of Object.keys(mockSpan)) {
      (mockSpan as any)[key].mockReset?.();
    }
  });

  it('sums usage tokens across all tool turns in the blocking handler', async () => {
    const toolFn = vi.fn().mockReturnValue('res');
    // Turn 1: tool call (5 input, 2 output)
    mockResponsesCreate
      .mockResolvedValueOnce(mockToolCallResponse('myTool', {})) // 5 + 2
      .mockResolvedValueOnce(mockFinalResponse('done', 3, 4)); // 3 + 4

    const config = {
      ...baseConfig,
      tools: { myTool: { name: 'myTool', type: 'function' as const, parameters: {} } },
    };
    const result = await createOpenAIHandler()(config as any, 'q', { myTool: toolFn });
    expect(result.usage).toMatchObject({ input_tokens: 8, output_tokens: 6 });
  });
});

// ── §1.9 outputFormat — first-class (Responses API text.format) ───────────────

describe('createOpenAIHandler — outputFormat (§1.9)', () => {
  const outputFormat = { type: 'object', properties: { answer: { type: 'string' } } };

  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of Object.keys(mockSpan)) {
      (mockSpan as any)[key].mockReset?.();
    }
  });

  it('passes text.format with json_schema when outputFormat is set', async () => {
    mockResponsesCreate.mockResolvedValue(mockFinalResponse());
    const config = { ...baseConfig, outputFormat };
    await createOpenAIHandler()(config as any, 'hello');
    const call = mockResponsesCreate.mock.calls[0][0];
    expect(call.text).toEqual({
      format: { type: 'json_schema', name: 'output', schema: outputFormat, strict: false },
    });
  });

  it('does not pass a text argument when outputFormat is absent', async () => {
    mockResponsesCreate.mockResolvedValue(mockFinalResponse());
    await createOpenAIHandler()(baseConfig as any, 'hello');
    const call = mockResponsesCreate.mock.calls[0][0];
    expect(call.text).toBeUndefined();
  });
});

// ── §1.10 MAX_STEPS cap ───────────────────────────────────────────────────────

describe('createOpenAIHandler — MAX_STEPS cap (§1.10)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of Object.keys(mockSpan)) {
      (mockSpan as any)[key].mockReset?.();
    }
  });

  it('throws after MAX_STEPS (10) consecutive tool-call responses in invoke', async () => {
    const toolFn = vi.fn().mockReturnValue('result');
    mockResponsesCreate
      .mockResolvedValueOnce(mockToolCallResponse('myTool'))
      .mockResolvedValueOnce(mockToolCallResponse('myTool'))
      .mockResolvedValueOnce(mockToolCallResponse('myTool'))
      .mockResolvedValueOnce(mockToolCallResponse('myTool'))
      .mockResolvedValueOnce(mockToolCallResponse('myTool'))
      .mockResolvedValueOnce(mockToolCallResponse('myTool'))
      .mockResolvedValueOnce(mockToolCallResponse('myTool'))
      .mockResolvedValueOnce(mockToolCallResponse('myTool'))
      .mockResolvedValueOnce(mockToolCallResponse('myTool'))
      .mockResolvedValueOnce(mockToolCallResponse('myTool'))
      .mockResolvedValueOnce(mockToolCallResponse('myTool'));

    const cfg = { ...baseConfig, tools: { myTool: { name: 'myTool', type: 'function' as const, parameters: {} } } };
    await expect(createOpenAIHandler()(cfg as any, 'q', { myTool: toolFn })).rejects.toThrow(/maximum number of steps/);
  });

  it('does not throw when exactly MAX_STEPS tool calls are followed by a final response in invoke', async () => {
    const toolFn = vi.fn().mockReturnValue('result');
    mockResponsesCreate
      .mockResolvedValueOnce(mockToolCallResponse('myTool'))
      .mockResolvedValueOnce(mockToolCallResponse('myTool'))
      .mockResolvedValueOnce(mockToolCallResponse('myTool'))
      .mockResolvedValueOnce(mockToolCallResponse('myTool'))
      .mockResolvedValueOnce(mockToolCallResponse('myTool'))
      .mockResolvedValueOnce(mockToolCallResponse('myTool'))
      .mockResolvedValueOnce(mockToolCallResponse('myTool'))
      .mockResolvedValueOnce(mockToolCallResponse('myTool'))
      .mockResolvedValueOnce(mockToolCallResponse('myTool'))
      .mockResolvedValueOnce(mockToolCallResponse('myTool'))
      .mockResolvedValueOnce(mockFinalResponse('Done'));

    const cfg = { ...baseConfig, tools: { myTool: { name: 'myTool', type: 'function' as const, parameters: {} } } };
    const result = await createOpenAIHandler()(cfg as any, 'q', { myTool: toolFn });
    expect(result.output).toBe('Done');
  });

  it('throws after MAX_STEPS (10) consecutive tool-call responses in stream', async () => {
    const toolFn = vi.fn().mockReturnValue('result');
    function makeToolStream() {
      return {
        [Symbol.asyncIterator]: () => (async function* () {})()[Symbol.asyncIterator](),
        finalResponse: vi.fn().mockResolvedValue({
          id: 'resp_tool',
          usage: { input_tokens: 1, output_tokens: 1 },
          output: [{ type: 'function_call', name: 'myTool', call_id: 'c1', arguments: '{}' }],
          output_text: '',
        }),
      };
    }
    mockResponsesStream
      .mockReturnValueOnce(makeToolStream())
      .mockReturnValueOnce(makeToolStream())
      .mockReturnValueOnce(makeToolStream())
      .mockReturnValueOnce(makeToolStream())
      .mockReturnValueOnce(makeToolStream())
      .mockReturnValueOnce(makeToolStream())
      .mockReturnValueOnce(makeToolStream())
      .mockReturnValueOnce(makeToolStream())
      .mockReturnValueOnce(makeToolStream())
      .mockReturnValueOnce(makeToolStream())
      .mockReturnValueOnce(makeToolStream());

    const cfg = { ...baseConfig, tools: { myTool: { name: 'myTool', type: 'function' as const, parameters: {} } } };
    const collectStream = async (gen: AsyncGenerator<any>) => {
      const out: any[] = [];
      for await (const e of gen) out.push(e);
      return out;
    };
    await expect(
      collectStream(createOpenAIHandler().stream?.(cfg as any, 'q', { myTool: toolFn }, {})),
    ).rejects.toThrow(/maximum number of steps/);
  });
});
