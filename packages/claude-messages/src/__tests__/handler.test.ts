import { SpanStatusCode } from '@opentelemetry/api';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const { mockMessagesCreate, mockMessagesStream } = vi.hoisted(() => ({
  mockMessagesCreate: vi.fn(),
  mockMessagesStream: vi.fn(),
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

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: mockMessagesCreate, stream: mockMessagesStream };
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
        // The root `invoke_agent` span (non-streaming uses startActiveSpan; streaming uses startSpan)
        // reuses mockSpan; every `chat`/`execute_tool` child gets its own recorded span.
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

import { createClaudeMessagesHandler } from '../handler.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const baseConfig = {
  model: { name: 'claude-3-5-sonnet-20241022' },
  provider: { name: 'Anthropic' },
  instructions: 'You are helpful.',
};

function mockFinalResponse(text = 'Hello!', inputTokens = 10, outputTokens = 5) {
  return {
    stop_reason: 'end_turn',
    content: [{ type: 'text', text }],
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  };
}

function modelSpans() {
  return mockChildSpans.filter(({ name }) => name.startsWith('chat'));
}

function latestModelSpan() {
  return mockChildSpans.findLast(({ name }) => name.startsWith('chat'))?.span;
}

function latestToolSpan() {
  return mockChildSpans.findLast(({ name }) => name.startsWith('execute_tool '))?.span;
}

function mockToolUseResponse(name: string, input: unknown, id = 'tu_1') {
  return {
    stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id, name, input }],
    usage: { input_tokens: 5, output_tokens: 2 },
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('createClaudeMessagesHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockChildSpans.length = 0;
    mockSpan.setAttribute.mockReset();
    mockSpan.addEvent.mockReset();
    mockSpan.setStatus.mockReset();
    mockSpan.end.mockReset();
    mockSpan.recordException.mockReset();
  });

  // ── 1.1 Factory and metadata ────────────────────────────────────────────────

  it('returns a callable function', () => {
    const handler = createClaudeMessagesHandler();
    expect(typeof handler).toBe('function');
  });

  it('attaches providesFor = ["Anthropic", "messages"]', () => {
    const handler = createClaudeMessagesHandler();
    expect(handler.providesFor).toEqual(['Anthropic', 'messages']);
  });

  it('returns independent instances on multiple calls', () => {
    const h1 = createClaudeMessagesHandler();
    const h2 = createClaudeMessagesHandler();
    expect(h1).not.toBe(h2);
  });

  // ── 1.2 Prompt construction ─────────────────────────────────────────────────

  it('uses instructions as system prompt', async () => {
    mockMessagesCreate.mockResolvedValue(mockFinalResponse());
    const handler = createClaudeMessagesHandler();
    await handler(baseConfig as any, 'hi');
    const call = mockMessagesCreate.mock.calls[0][0];
    expect(call.system).toBe('You are helpful.');
    expect(call.messages.at(-1).content).toBe('hi');
  });

  it('substitutes variables in instructions', async () => {
    mockMessagesCreate.mockResolvedValue(mockFinalResponse());
    const handler = createClaudeMessagesHandler();
    const config = { ...baseConfig, instructions: 'Hello {{name}}.' };
    await handler(config as any, 'hi', {}, { name: 'Alice' });
    const call = mockMessagesCreate.mock.calls[0][0];
    expect(call.system).toBe('Hello Alice.');
  });

  it('leaves unknown placeholders intact', async () => {
    mockMessagesCreate.mockResolvedValue(mockFinalResponse());
    const handler = createClaudeMessagesHandler();
    const config = { ...baseConfig, instructions: 'Hi {{unknown}}.' };
    await handler(config as any, 'q');
    const call = mockMessagesCreate.mock.calls[0][0];
    expect(call.system).toBe('Hi {{unknown}}.');
  });

  it('uses messages array when instructions is absent', async () => {
    mockMessagesCreate.mockResolvedValue(mockFinalResponse());
    const handler = createClaudeMessagesHandler();
    const config = {
      model: { name: 'claude-3-5-sonnet-20241022' },
      provider: { name: 'Anthropic' },
      messages: [
        { role: 'system', content: 'Be concise.' },
        { role: 'user', content: 'Previous question' },
      ],
    };
    await handler(config as any, 'new question');
    const call = mockMessagesCreate.mock.calls[0][0];
    expect(call.system).toBe('Be concise.');
    expect(call.messages[0].content).toBe('Previous question');
    expect(call.messages).toHaveLength(1);
  });

  it('appends userInput when last message is not user role', async () => {
    mockMessagesCreate.mockResolvedValue(mockFinalResponse());
    const handler = createClaudeMessagesHandler();
    const config = {
      model: { name: 'claude-3-5-sonnet-20241022' },
      provider: { name: 'Anthropic' },
      messages: [
        { role: 'system', content: 'Be concise.' },
        { role: 'user', content: 'Previous question' },
        { role: 'assistant', content: 'Previous answer' },
      ],
    };
    await handler(config as any, 'new question');
    const call = mockMessagesCreate.mock.calls[0][0];
    expect(call.system).toBe('Be concise.');
    expect(call.messages.at(-1).content).toBe('new question');
  });

  it('prefers messages over instructions when both are present', async () => {
    mockMessagesCreate.mockResolvedValue(mockFinalResponse());
    const handler = createClaudeMessagesHandler();
    const config = {
      ...baseConfig,
      messages: [{ role: 'system', content: 'From messages — takes priority' }],
    };
    await handler(config as any, 'q');
    const call = mockMessagesCreate.mock.calls[0][0];
    expect(call.system).toBe('From messages — takes priority');
  });

  it('resolves {{variable}} placeholders in system-role messages', async () => {
    mockMessagesCreate.mockResolvedValue(mockFinalResponse());
    const handler = createClaudeMessagesHandler();
    const config = {
      model: { name: 'claude-3-5-sonnet-20241022' },
      provider: { name: 'Anthropic' },
      messages: [{ role: 'system', content: 'Hello {{name}}.' }],
    };
    await handler(config as any, 'q', {}, { name: 'Alice' });
    const call = mockMessagesCreate.mock.calls[0][0];
    expect(call.system).toBe('Hello Alice.');
  });

  it('resolves {{variable}} placeholders in user-role messages', async () => {
    mockMessagesCreate.mockResolvedValue(mockFinalResponse());
    const handler = createClaudeMessagesHandler();
    const config = {
      model: { name: 'claude-3-5-sonnet-20241022' },
      provider: { name: 'Anthropic' },
      messages: [{ role: 'user', content: 'My name is {{name}}.' }],
    };
    await handler(config as any, 'follow up', {}, { name: 'Bob' });
    const call = mockMessagesCreate.mock.calls[0][0];
    expect(call.messages[0].content).toBe('My name is Bob.');
  });

  it('includes assistant messages from config.messages in conversation history', async () => {
    mockMessagesCreate.mockResolvedValue(mockFinalResponse());
    const handler = createClaudeMessagesHandler();
    const config = {
      model: { name: 'claude-3-5-sonnet-20241022' },
      provider: { name: 'Anthropic' },
      messages: [
        { role: 'user', content: 'First question' },
        { role: 'assistant', content: 'First answer' },
      ],
    };
    await handler(config as any, 'Second question');
    const call = mockMessagesCreate.mock.calls[0][0];
    expect(call.messages[0]).toMatchObject({ role: 'user', content: 'First question' });
    expect(call.messages[1]).toMatchObject({ role: 'assistant', content: 'First answer' });
    expect(call.messages.at(-1)).toMatchObject({ role: 'user', content: 'Second question' });
  });

  it('does not throw when userInput is undefined', async () => {
    mockMessagesCreate.mockResolvedValue(mockFinalResponse());
    const handler = createClaudeMessagesHandler();
    await expect(handler(baseConfig as any, undefined)).resolves.toBeDefined();
  });

  it('does not throw when userInput is an empty string', async () => {
    mockMessagesCreate.mockResolvedValue(mockFinalResponse());
    const handler = createClaudeMessagesHandler();
    await expect(handler(baseConfig as any, '')).resolves.toBeDefined();
  });

  // ── 1.3 Tool conversion ─────────────────────────────────────────────────────

  it('passes tools to the provider when config.tools is present', async () => {
    mockMessagesCreate.mockResolvedValue(mockFinalResponse());
    const handler = createClaudeMessagesHandler();
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
    await handler(config as any, 'q', { search: vi.fn() });
    const call = mockMessagesCreate.mock.calls[0][0];
    expect(call.tools).toHaveLength(1);
    expect(call.tools[0].name).toBe('search');
    expect(call.tools[0].description).toBe('Search');
  });

  it('sends no tools when config.tools is absent', async () => {
    mockMessagesCreate.mockResolvedValue(mockFinalResponse());
    const handler = createClaudeMessagesHandler();
    await handler(baseConfig as any, 'q');
    const call = mockMessagesCreate.mock.calls[0][0];
    expect(call.tools ?? []).toHaveLength(0);
  });

  // ── 1.4 Tool execution loop ─────────────────────────────────────────────────

  it('invokes the tool handler on a tool_use response and continues', async () => {
    const toolUseFn = vi.fn().mockReturnValue('tool-result');
    mockMessagesCreate
      .mockResolvedValueOnce({
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'tu_1', name: 'myTool', input: { q: 'test' } }],
        usage: { input_tokens: 5, output_tokens: 2 },
      })
      .mockResolvedValueOnce(mockFinalResponse('Final answer', 3, 4));

    const config = {
      ...baseConfig,
      tools: { myTool: { name: 'myTool', type: 'function' as const, parameters: {} } },
    };
    const handler = createClaudeMessagesHandler();
    const result = await handler(config as any, 'q', { myTool: toolUseFn });

    expect(toolUseFn).toHaveBeenCalledWith({ q: 'test' });
    expect(result.output).toBe('Final answer');
  });

  it('handles multiple consecutive tool calls across two turns', async () => {
    const toolA = vi.fn().mockReturnValue('result-a');
    const toolB = vi.fn().mockReturnValue('result-b');
    mockMessagesCreate
      .mockResolvedValueOnce({
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'tu_1', name: 'toolA', input: { x: 1 } }],
        usage: { input_tokens: 4, output_tokens: 1 },
      })
      .mockResolvedValueOnce({
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'tu_2', name: 'toolB', input: { y: 2 } }],
        usage: { input_tokens: 3, output_tokens: 1 },
      })
      .mockResolvedValueOnce(mockFinalResponse('Done', 2, 2));

    const config = {
      ...baseConfig,
      tools: {
        toolA: { name: 'toolA', type: 'function' as const, parameters: {} },
        toolB: { name: 'toolB', type: 'function' as const, parameters: {} },
      },
    };
    const handler = createClaudeMessagesHandler();
    const result = await handler(config as any, 'q', { toolA, toolB });

    expect(toolA).toHaveBeenCalledWith({ x: 1 });
    expect(toolB).toHaveBeenCalledWith({ y: 2 });
    expect(result.output).toBe('Done');
  });

  it('propagates errors thrown by a tool handler function', async () => {
    const throwingTool = vi.fn().mockRejectedValue(new Error('tool failed'));
    mockMessagesCreate.mockResolvedValueOnce({
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'tu_1', name: 'myTool', input: {} }],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const config = {
      ...baseConfig,
      tools: { myTool: { name: 'myTool', type: 'function' as const, parameters: {} } },
    };
    const handler = createClaudeMessagesHandler();
    await expect(handler(config as any, 'q', { myTool: throwingTool })).rejects.toThrow('tool failed');
  });

  it('does not invoke toolHandlers when config.tools is absent', async () => {
    mockMessagesCreate.mockResolvedValue(mockFinalResponse());
    const spy = vi.fn();
    const handler = createClaudeMessagesHandler();
    await handler(baseConfig as any, 'q', { myTool: spy });
    expect(spy).not.toHaveBeenCalled();
    expect(mockMessagesCreate).toHaveBeenCalledTimes(1);
  });

  it('accumulates token counts correctly across multiple tool call iterations', async () => {
    const toolFn = vi.fn().mockReturnValue('ok');
    mockMessagesCreate
      .mockResolvedValueOnce({
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'tu_1', name: 'myTool', input: {} }],
        usage: { input_tokens: 5, output_tokens: 2 },
      })
      .mockResolvedValueOnce(mockFinalResponse('Final', 3, 4));

    const config = {
      ...baseConfig,
      tools: { myTool: { name: 'myTool', type: 'function' as const, parameters: {} } },
    };
    const handler = createClaudeMessagesHandler();
    const result = await handler(config as any, 'q', { myTool: toolFn });
    expect(result.usage).toMatchObject({ input_tokens: 8, output_tokens: 6 });
  });

  it('throws when the provider requests an unregistered tool', async () => {
    mockMessagesCreate.mockResolvedValueOnce({
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'tu_1', name: 'unknownTool', input: {} }],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const config = {
      ...baseConfig,
      tools: { unknownTool: { name: 'unknownTool', type: 'function' as const, parameters: {} } },
    };
    const handler = createClaudeMessagesHandler();
    await expect(handler(config as any, 'q', {})).rejects.toThrow(/unknownTool/);
  });

  // ── 1.5 Telemetry ───────────────────────────────────────────────────────────

  it('uses invoke_agent as the root span name', async () => {
    mockMessagesCreate.mockResolvedValue(mockFinalResponse());
    const { trace } = await import('@opentelemetry/api');
    await createClaudeMessagesHandler()(baseConfig as any, 'q');
    const tracer = (trace.getTracer as any).mock.results[0].value;
    expect(tracer.startActiveSpan).toHaveBeenCalledWith('invoke_agent', expect.any(Function));
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('gen_ai.operation.name', 'invoke_agent');
  });

  it('sets gen_ai usage attributes on the chat model span', async () => {
    mockMessagesCreate.mockResolvedValue(mockFinalResponse('hi', 10, 5));
    await createClaudeMessagesHandler()(baseConfig as any, 'q');
    const modelSpan = latestModelSpan();
    expect(modelSpan?.setAttribute).toHaveBeenCalledWith('gen_ai.system', 'anthropic');
    expect(modelSpan?.setAttribute).toHaveBeenCalledWith('gen_ai.operation.name', 'chat');
    expect(modelSpan?.setAttribute).toHaveBeenCalledWith('gen_ai.request.model', 'claude-3-5-sonnet-20241022');
    expect(modelSpan?.setAttribute).toHaveBeenCalledWith('gen_ai.usage.input_tokens', 10);
    expect(modelSpan?.setAttribute).toHaveBeenCalledWith('gen_ai.usage.output_tokens', 5);
    expect(modelSpan?.setAttribute).toHaveBeenCalledWith('gen_ai.usage.total_tokens', 15);
  });

  it('emits no content at all by default', async () => {
    mockMessagesCreate.mockResolvedValue(mockFinalResponse('answer'));
    await createClaudeMessagesHandler()(baseConfig as any, 'question');

    // Conversation content is PII, so a caller has to ask for it. Asserting on the recorded
    // arguments rather than on specific keys catches a new content attribute added without a gate.
    const written = JSON.stringify(mockSpan.setAttribute.mock.calls);
    expect(written).not.toContain('question');
    expect(written).not.toContain('answer');
    expect(mockSpan.addEvent).not.toHaveBeenCalledWith('gen_ai.content.prompt', expect.anything());
  });

  it('puts prompt and completion on span attributes when capture is enabled', async () => {
    mockMessagesCreate.mockResolvedValue(mockFinalResponse('answer'));
    await createClaudeMessagesHandler({ captureContent: true })(baseConfig as any, 'question');

    // Attributes, not events: OTEP 4430 deprecated event-recorded content and LaunchDarkly's
    // readers parse only attributes.
    const input = mockSpan.setAttribute.mock.calls.find((c: any[]) => c[0] === 'gen_ai.input.messages');
    expect(JSON.parse(input[1])).toEqual([{ role: 'user', parts: [{ type: 'text', content: 'question' }] }]);
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('gen_ai.prompt.1.content', 'question');
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('gen_ai.completion.0.content', 'answer');
    expect(mockSpan.addEvent).toHaveBeenCalledWith('gen_ai.content.prompt', expect.anything());
  });

  it('records the system prompt separately and as flat message zero', async () => {
    mockMessagesCreate.mockResolvedValue(mockFinalResponse('answer'));
    await createClaudeMessagesHandler({ captureContent: true })(baseConfig as any, 'question');

    const instructions = mockSpan.setAttribute.mock.calls.find((c: any[]) => c[0] === 'gen_ai.system_instructions');
    expect(JSON.parse(instructions[1])).toEqual([{ type: 'text', content: 'You are helpful.' }]);
    // The flat carrier has no separate slot for it, and it is the only carrier the trace view reads.
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('gen_ai.prompt.0.role', 'system');
  });

  it('records tool arguments, results and the catalog on the right spans', async () => {
    const config = {
      ...baseConfig,
      tools: { myTool: { name: 'myTool', type: 'function', description: 'A tool', parameters: { type: 'object' } } },
    };
    mockMessagesCreate
      .mockResolvedValueOnce(mockToolUseResponse('myTool', { q: 'hello' }))
      .mockResolvedValueOnce(mockFinalResponse('done'));

    await createClaudeMessagesHandler({ captureContent: true })(config as any, 'question', {
      myTool: vi.fn().mockReturnValue('tool output'),
    });

    const toolSpan = latestToolSpan();
    expect(toolSpan?.setAttribute).toHaveBeenCalledWith('gen_ai.tool.call.arguments', '{"q":"hello"}');
    expect(toolSpan?.setAttribute).toHaveBeenCalledWith('gen_ai.tool.call.result', 'tool output');

    // The catalog belongs on the model span, which is what saw it — not on the tool span.
    const catalog = latestModelSpan()?.setAttribute.mock.calls.find((c: any[]) => c[0] === 'gen_ai.tool.definitions');
    expect(JSON.parse(catalog[1])).toEqual([
      { type: 'function', name: 'myTool', description: 'A tool', parameters: { type: 'object' } },
    ]);
  });

  it('reports the finish reason on the chat span', async () => {
    mockMessagesCreate.mockResolvedValue(mockFinalResponse('answer'));
    await createClaudeMessagesHandler()(baseConfig as any, 'question');

    // Not content, so it is emitted regardless of the capture gate.
    expect(latestModelSpan()?.setAttribute).toHaveBeenCalledWith('gen_ai.response.finish_reasons', ['stop']);
  });

  it('sets span status OK on success and ends the span', async () => {
    mockMessagesCreate.mockResolvedValue(mockFinalResponse());
    await createClaudeMessagesHandler()(baseConfig as any, 'q');
    expect(mockSpan.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.OK });
    expect(mockSpan.end).toHaveBeenCalled();
  });

  // ── 1.6 Span hierarchy (invoke_agent → chat → execute_tool) ──────────────────

  it('emits one chat child span per model turn under the invoke_agent root', async () => {
    mockMessagesCreate
      .mockResolvedValueOnce({
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'tu_1', name: 'myTool', input: { q: 'test' } }],
        usage: { input_tokens: 5, output_tokens: 2 },
      })
      .mockResolvedValueOnce(mockFinalResponse('Final answer', 3, 4));

    const config = {
      ...baseConfig,
      tools: { myTool: { name: 'myTool', type: 'function' as const, parameters: {} } },
    };
    await createClaudeMessagesHandler()(config as any, 'q', { myTool: vi.fn().mockReturnValue('r') });

    // Two provider calls → two `chat` spans, each closed exactly once.
    const chats = modelSpans();
    expect(chats).toHaveLength(2);
    expect(chats.every(({ span }) => span.end.mock.calls.length === 1)).toBe(true);
    // `{operation} {request.model}`, per the semantic conventions for an inference span.
    expect(chats.every(({ name }) => name === `chat ${baseConfig.model.name}`)).toBe(true);
  });

  it('emits an execute_tool child span per tool call, keyed by tool_use id', async () => {
    mockMessagesCreate
      .mockResolvedValueOnce({
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'tu_1', name: 'myTool', input: { q: 'test' } }],
        usage: { input_tokens: 5, output_tokens: 2 },
      })
      .mockResolvedValueOnce(mockFinalResponse('Final answer', 3, 4));

    const config = {
      ...baseConfig,
      tools: { myTool: { name: 'myTool', type: 'function' as const, parameters: {} } },
    };
    await createClaudeMessagesHandler()(config as any, 'q', { myTool: vi.fn().mockReturnValue('r') });

    const toolSpan = mockChildSpans.find(({ name }) => name === 'execute_tool myTool')?.span;
    expect(toolSpan?.setAttribute).toHaveBeenCalledWith('gen_ai.operation.name', 'execute_tool');
    expect(toolSpan?.setAttribute).toHaveBeenCalledWith('gen_ai.tool.name', 'myTool');
    expect(toolSpan?.setAttribute).toHaveBeenCalledWith('gen_ai.tool.call.id', 'tu_1');
    expect(toolSpan?.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.OK });
    expect(toolSpan?.end).toHaveBeenCalledOnce();
  });

  it('folds cached input tokens into the chat span usage', async () => {
    mockMessagesCreate.mockResolvedValue({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'hi' }],
      usage: {
        input_tokens: 4,
        output_tokens: 5,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 20,
      },
    });

    const result = await createClaudeMessagesHandler()(baseConfig as any, 'q');

    const modelSpan = latestModelSpan();
    expect(modelSpan?.setAttribute).toHaveBeenCalledWith('gen_ai.usage.input_tokens', 124);
    expect(modelSpan?.setAttribute).toHaveBeenCalledWith('gen_ai.usage.output_tokens', 5);
    expect(modelSpan?.setAttribute).toHaveBeenCalledWith('gen_ai.usage.cache_read.input_tokens', 100);
    expect(modelSpan?.setAttribute).toHaveBeenCalledWith('gen_ai.usage.cache_creation.input_tokens', 20);
    expect(modelSpan?.setAttribute).toHaveBeenCalledWith('gen_ai.usage.total_tokens', 129);
    // The returned usage stays raw — cache fields intact, input NOT pre-folded — so that
    // `parseUsage` can fold it once and derive `inputDetails`. Pre-folding here would hide the
    // breakdown from callers; pre-folding *and* returning the cache fields would double-count.
    expect(result.usage).toEqual({
      input_tokens: 4,
      output_tokens: 5,
      cache_read_input_tokens: 100,
      cache_creation_input_tokens: 20,
    });
  });

  it('folds cache tokens onto the stream chat span but yields raw usage in the done event', async () => {
    const streamEvents = [{ type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi' } }];
    const finalMsg = {
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 7, cache_creation_input_tokens: 3 },
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'Hi' }],
    };
    mockMessagesStream.mockReturnValue(makeStreamMock(streamEvents, finalMsg));

    const handler = createClaudeMessagesHandler();
    const events = await collectStream(handler.stream?.(baseConfig as any, 'q', {}, {}));
    const done = events.at(-1) as any;

    const modelSpan = latestModelSpan();
    expect(modelSpan?.setAttribute).toHaveBeenCalledWith('gen_ai.usage.input_tokens', 20);
    expect(modelSpan?.setAttribute).toHaveBeenCalledWith('gen_ai.usage.cache_read.input_tokens', 7);
    expect(modelSpan?.setAttribute).toHaveBeenCalledWith('gen_ai.usage.cache_creation.input_tokens', 3);
    // Raw, for the same reason as the non-streaming path above.
    expect(done.usage).toEqual({
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 7,
      cache_creation_input_tokens: 3,
    });
  });

  it('fails the chat span when the provider call throws', async () => {
    const err = new Error('provider down');
    mockMessagesCreate.mockRejectedValueOnce(err);

    await expect(createClaudeMessagesHandler()(baseConfig as any, 'q')).rejects.toThrow('provider down');

    const modelSpan = latestModelSpan();
    expect(modelSpan?.recordException).toHaveBeenCalledWith(err);
    expect(modelSpan?.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.ERROR, message: 'provider down' });
    expect(modelSpan?.end).toHaveBeenCalledOnce();
  });

  it('fails the execute_tool span when a tool handler throws', async () => {
    const err = new Error('tool boom');
    mockMessagesCreate.mockResolvedValueOnce({
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'tu_1', name: 'myTool', input: {} }],
      usage: { input_tokens: 5, output_tokens: 2 },
    });

    const config = {
      ...baseConfig,
      tools: { myTool: { name: 'myTool', type: 'function' as const, parameters: {} } },
    };
    await expect(
      createClaudeMessagesHandler()(config as any, 'q', { myTool: vi.fn().mockRejectedValue(err) }),
    ).rejects.toThrow('tool boom');

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
    mockMessagesCreate.mockResolvedValue(mockFinalResponse());
    await createClaudeMessagesHandler()(baseConfig as any, 'q', {}, ldFixture);
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('launchdarkly.operation.type', 'gen_ai');
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('launchdarkly.config.key', 'test-config');
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('launchdarkly.variation.key', 'variation-a');
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('launchdarkly.run.id', 'run-123');
  });

  it('does not set launchdarkly.graph.key when graphKey is absent in __ld', async () => {
    mockMessagesCreate.mockResolvedValue(mockFinalResponse());
    await createClaudeMessagesHandler()(baseConfig as any, 'q', {}, ldFixture);
    const graphKeyCalls = mockSpan.setAttribute.mock.calls.filter((c: any[]) => c[0] === 'launchdarkly.graph.key');
    expect(graphKeyCalls).toHaveLength(0);
  });

  it('sets launchdarkly.graph.key when graphKey is present in __ld', async () => {
    mockMessagesCreate.mockResolvedValue(mockFinalResponse());
    const vars = { __ld: { ...ldFixture.__ld, graphKey: 'my-graph' } };
    await createClaudeMessagesHandler()(baseConfig as any, 'q', {}, vars);
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('launchdarkly.graph.key', 'my-graph');
  });

  it('sets launchdarkly.operation.type in the streaming path when __ld is in variables', async () => {
    const streamMock = makeStreamMock([{ type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } }], {
      usage: { input_tokens: 1, output_tokens: 1 },
      stop_reason: 'end_turn',
      content: [],
    });
    mockMessagesStream.mockReturnValue(streamMock);
    await collectStream(createClaudeMessagesHandler().stream?.(baseConfig as any, 'q', {}, ldFixture));
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('launchdarkly.operation.type', 'gen_ai');
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('launchdarkly.config.key', 'test-config');
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('launchdarkly.variation.key', 'variation-a');
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('launchdarkly.run.id', 'run-123');
  });

  // The `feature_flag` span event is how the AI Config Monitoring tab locates a trace
  // (events.name = feature_flag AND events.attributes.feature_flag.key = <configKey>). It has to be
  // on the root, because the root is what that query finds. Dropping it, or emitting it on a child
  // instead, silently detaches every trace from its AI Config with nothing else failing.

  it('emits the feature_flag correlation event on the root span', async () => {
    mockMessagesCreate.mockResolvedValue(mockFinalResponse());
    await createClaudeMessagesHandler()(baseConfig as any, 'q', {}, ldFixture);
    expect(mockSpan.addEvent).toHaveBeenCalledWith(
      'feature_flag',
      expect.objectContaining({ 'feature_flag.key': 'test-config', 'feature_flag.provider.name': 'LaunchDarkly' }),
    );
  });

  it('emits the feature_flag correlation event on the root of the streaming path', async () => {
    mockMessagesStream.mockReturnValue(makeStreamMock([], mockFinalResponse()));
    await collectStream(createClaudeMessagesHandler().stream?.(baseConfig as any, 'q', {}, ldFixture));
    expect(mockSpan.addEvent).toHaveBeenCalledWith(
      'feature_flag',
      expect.objectContaining({ 'feature_flag.key': 'test-config' }),
    );
  });

  it('does not emit the feature_flag event on child spans', async () => {
    mockMessagesCreate.mockResolvedValue(mockFinalResponse());
    await createClaudeMessagesHandler()(baseConfig as any, 'q', {}, ldFixture);
    const childEvents = mockChildSpans.flatMap(({ span }) => span.addEvent.mock.calls.map((c: unknown[]) => c[0]));
    expect(childEvents).not.toContain('feature_flag');
  });

  // ── 1.6 Error handling ──────────────────────────────────────────────────────

  it('records exception, sets ERROR status, ends span, and re-throws on provider error', async () => {
    const err = new Error('API failed');
    mockMessagesCreate.mockRejectedValue(err);
    await expect(createClaudeMessagesHandler()(baseConfig as any, 'q')).rejects.toThrow('API failed');
    expect(mockSpan.recordException).toHaveBeenCalledWith(err);
    expect(mockSpan.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.ERROR, message: 'API failed' });
    expect(mockSpan.end).toHaveBeenCalled();
  });

  // ── 1.7 Convenience export ──────────────────────────────────────────────────

  it('claudeMessages calls config() with the correct handler and forwards args', async () => {
    const { claudeMessages } = await import('../handler.js');
    const { config } = await import('@launchdarkly/ai-server');
    const ctx = { kind: 'user' as const, key: 'u' };
    await claudeMessages('my-flag', 'hello', ctx, {} as any);
    expect(config).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'my-flag',
        handler: expect.objectContaining({ providesFor: ['Anthropic', 'messages'] }),
      }),
    );
  });

  // ── 1.8 Streaming ────────────────────────────────────────────────────────────

  function makeStreamMock(events: any[], finalMsg: any) {
    const asyncIterable = (async function* () {
      for (const e of events) yield e;
    })();
    return {
      [Symbol.asyncIterator]: () => asyncIterable[Symbol.asyncIterator](),
      finalMessage: vi.fn().mockResolvedValue(finalMsg),
    };
  }

  async function collectStream<T>(gen: AsyncGenerator<T>): Promise<T[]> {
    const out: T[] = [];
    for await (const e of gen) out.push(e);
    return out;
  }

  it('handler.stream is defined', () => {
    const handler = createClaudeMessagesHandler();
    expect(typeof handler.stream).toBe('function');
  });

  it('handler.stream returns an async iterable', () => {
    const streamMock = makeStreamMock([], {
      usage: { input_tokens: 0, output_tokens: 0 },
      stop_reason: 'end_turn',
      content: [],
    });
    mockMessagesStream.mockReturnValue(streamMock);
    const handler = createClaudeMessagesHandler();
    const gen = handler.stream?.(baseConfig as any, 'q', {}, {});
    expect(typeof gen[Symbol.asyncIterator]).toBe('function');
  });

  it('yields chunk events for each text_delta', async () => {
    const streamEvents = [
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: ' world' } },
    ];
    const finalMsg = {
      usage: { input_tokens: 10, output_tokens: 5 },
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'Hello world' }],
    };
    mockMessagesStream.mockReturnValue(makeStreamMock(streamEvents, finalMsg));

    const handler = createClaudeMessagesHandler();
    const events = await collectStream(handler.stream?.(baseConfig as any, 'q', {}, {}));
    const chunks = events.filter((e: any) => e.type === 'chunk');
    expect(chunks).toEqual([
      { type: 'chunk', text: 'Hello' },
      { type: 'chunk', text: ' world' },
    ]);
  });

  it('yields a done event as the last event with correct usage', async () => {
    const streamEvents = [{ type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi' } }];
    const finalMsg = {
      usage: { input_tokens: 3, output_tokens: 7 },
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'Hi' }],
    };
    mockMessagesStream.mockReturnValue(makeStreamMock(streamEvents, finalMsg));

    const handler = createClaudeMessagesHandler();
    const events = await collectStream(handler.stream?.(baseConfig as any, 'q', {}, {}));
    const done = events.at(-1) as any;
    expect(done.type).toBe('done');
    expect(done.usage).toMatchObject({ input_tokens: 3, output_tokens: 7 });
  });

  it('all chunks appear before the done event', async () => {
    const streamEvents = [
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'a' } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'b' } },
    ];
    const finalMsg = { usage: { input_tokens: 1, output_tokens: 2 }, stop_reason: 'end_turn', content: [] };
    mockMessagesStream.mockReturnValue(makeStreamMock(streamEvents, finalMsg));

    const handler = createClaudeMessagesHandler();
    const events = await collectStream(handler.stream?.(baseConfig as any, 'q', {}, {}));
    const doneIndex = events.findIndex((e: any) => e.type === 'done');
    const chunksAfterDone = events.slice(doneIndex + 1).filter((e: any) => e.type === 'chunk');
    expect(chunksAfterDone).toHaveLength(0);
  });

  it('done event output is the full concatenation of all text chunks across all turns', async () => {
    const toolFn = vi.fn().mockReturnValue('tool-result');
    const firstStream = makeStreamMock(
      [{ type: 'content_block_delta', delta: { type: 'text_delta', text: 'pre-tool ' } }],
      {
        usage: { input_tokens: 5, output_tokens: 2 },
        stop_reason: 'tool_use',
        content: [
          { type: 'text', text: 'pre-tool ' },
          { type: 'tool_use', id: 'tu_1', name: 'myTool', input: {} },
        ],
      },
    );
    const secondStream = makeStreamMock(
      [{ type: 'content_block_delta', delta: { type: 'text_delta', text: 'post-tool' } }],
      { usage: { input_tokens: 3, output_tokens: 4 }, stop_reason: 'end_turn', content: [] },
    );
    mockMessagesStream.mockReturnValueOnce(firstStream).mockReturnValueOnce(secondStream);

    const config = { ...baseConfig, tools: { myTool: { name: 'myTool', type: 'function' as const, parameters: {} } } };
    const handler = createClaudeMessagesHandler();
    const events = await collectStream(handler.stream?.(config as any, 'q', { myTool: toolFn }, {}));
    const done = events.find((e: any) => e.type === 'done') as any;
    expect(done.output).toBe('pre-tool post-tool');
  });

  it('executes tool calls and continues streaming after', async () => {
    const toolFn = vi.fn().mockReturnValue('tool-result');
    // First stream: text delta then end (tool_use stop)
    const firstStream = makeStreamMock(
      [{ type: 'content_block_delta', delta: { type: 'text_delta', text: 'pre-tool ' } }],
      {
        usage: { input_tokens: 5, output_tokens: 2 },
        stop_reason: 'tool_use',
        content: [
          { type: 'text', text: 'pre-tool ' },
          { type: 'tool_use', id: 'tu_1', name: 'myTool', input: { q: 'hello' } },
        ],
      },
    );
    // Second stream: text delta (final answer)
    const secondStream = makeStreamMock(
      [{ type: 'content_block_delta', delta: { type: 'text_delta', text: 'post-tool' } }],
      {
        usage: { input_tokens: 3, output_tokens: 4 },
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'post-tool' }],
      },
    );
    mockMessagesStream.mockReturnValueOnce(firstStream).mockReturnValueOnce(secondStream);

    const config = { ...baseConfig, tools: { myTool: { name: 'myTool', type: 'function' as const, parameters: {} } } };
    const handler = createClaudeMessagesHandler();
    const events = await collectStream(handler.stream?.(config as any, 'q', { myTool: toolFn }, {}));
    const chunks = events.filter((e: any) => e.type === 'chunk').map((e: any) => e.text);
    expect(chunks).toContain('post-tool');
    expect(toolFn).toHaveBeenCalledWith({ q: 'hello' });
  });

  it('sets gen_ai span attributes and puts content on attributes when enabled', async () => {
    const streamMock = makeStreamMock([{ type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } }], {
      usage: { input_tokens: 2, output_tokens: 3 },
      stop_reason: 'end_turn',
      content: [],
    });
    mockMessagesStream.mockReturnValue(streamMock);

    await collectStream(createClaudeMessagesHandler({ captureContent: true }).stream?.(baseConfig as any, 'q', {}, {}));
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('gen_ai.operation.name', 'invoke_agent');
    const modelSpan = latestModelSpan();
    expect(modelSpan?.setAttribute).toHaveBeenCalledWith('gen_ai.system', 'anthropic');
    expect(modelSpan?.setAttribute).toHaveBeenCalledWith('gen_ai.request.model', 'claude-3-5-sonnet-20241022');
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('gen_ai.prompt.1.content', 'q');
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('gen_ai.completion.0.content', 'hi');
    expect(mockSpan.addEvent).toHaveBeenCalledWith('gen_ai.content.completion', expect.anything());
    expect(mockSpan.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.OK });
    expect(mockSpan.end).toHaveBeenCalled();
  });

  it('records exception and sets ERROR status on provider error', async () => {
    const err = new Error('stream error');
    mockMessagesStream.mockImplementation(() => {
      throw err;
    });
    const handler = createClaudeMessagesHandler();
    await expect(collectStream(handler.stream?.(baseConfig as any, 'q', {}, {}))).rejects.toThrow('stream error');
    expect(mockSpan.recordException).toHaveBeenCalledWith(err);
    expect(mockSpan.setStatus).toHaveBeenCalledWith(expect.objectContaining({ code: SpanStatusCode.ERROR }));
    expect(mockSpan.end).toHaveBeenCalled();
  });

  it('throws and records error in streaming path when tool is unregistered', async () => {
    const firstStream = makeStreamMock([], {
      usage: { input_tokens: 2, output_tokens: 1 },
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'tu_1', name: 'missingTool', input: {} }],
    });
    mockMessagesStream.mockReturnValue(firstStream);
    const config = {
      ...baseConfig,
      tools: { missingTool: { name: 'missingTool', type: 'function' as const, parameters: {} } },
    };
    const handler = createClaudeMessagesHandler();
    await expect(collectStream(handler.stream?.(config as any, 'q', {}, {}))).rejects.toThrow(/missingTool/);
    expect(mockSpan.recordException).toHaveBeenCalled();
    expect(mockSpan.setStatus).toHaveBeenCalledWith(expect.objectContaining({ code: SpanStatusCode.ERROR }));
    expect(mockSpan.end).toHaveBeenCalled();
  });

  it('throws and records error in streaming path when tool handler rejects', async () => {
    const err = new Error('tool blow up');
    const firstStream = makeStreamMock([], {
      usage: { input_tokens: 2, output_tokens: 1 },
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'tu_1', name: 'myTool', input: {} }],
    });
    mockMessagesStream.mockReturnValue(firstStream);
    const config = { ...baseConfig, tools: { myTool: { name: 'myTool', type: 'function' as const, parameters: {} } } };
    const brokenTool = vi.fn().mockRejectedValue(err);
    const handler = createClaudeMessagesHandler();
    await expect(collectStream(handler.stream?.(config as any, 'q', { myTool: brokenTool }, {}))).rejects.toThrow(
      'tool blow up',
    );
    expect(mockSpan.recordException).toHaveBeenCalledWith(err);
  });

  // ── §1.2 additional: multiple system messages joined ────────────────────────

  it('joins multiple system-role messages with newline when instructions absent', async () => {
    mockMessagesCreate.mockResolvedValue(mockFinalResponse());
    const config = {
      model: { name: 'claude-3-5-sonnet-20241022' },
      provider: { name: 'Anthropic' },
      messages: [
        { role: 'system', content: 'First.' },
        { role: 'system', content: 'Second.' },
      ],
    };
    await createClaudeMessagesHandler()(config as any, 'q');
    const call = mockMessagesCreate.mock.calls[0][0];
    expect(call.system).toBe('First.\nSecond.');
  });

  it('sends only user message when neither instructions nor messages present', async () => {
    mockMessagesCreate.mockResolvedValue(mockFinalResponse());
    const config = {
      model: { name: 'claude-3-5-sonnet-20241022' },
      provider: { name: 'Anthropic' },
    };
    await createClaudeMessagesHandler()(config as any, 'hello');
    const call = mockMessagesCreate.mock.calls[0][0];
    expect(call.system).toBeUndefined();
    expect(call.messages).toHaveLength(1);
    expect(call.messages[0].content).toBe('hello');
  });

  // ── History ──────────────────────────────────────────────────────────────────

  const sampleHistory = [
    { role: 'user' as const, content: 'What is feature flagging?' },
    { role: 'assistant' as const, content: 'Feature flagging is a technique...' },
  ];

  it('history messages are inserted between config messages and userInput', async () => {
    mockMessagesCreate.mockResolvedValue(mockFinalResponse());
    const handler = createClaudeMessagesHandler();
    const config = {
      model: { name: 'claude-3-5-sonnet-20241022' },
      provider: { name: 'Anthropic' },
      messages: [
        { role: 'system', content: 'Be concise.' },
        { role: 'user', content: 'Previous question' },
        { role: 'assistant', content: 'Previous answer' },
      ],
    };
    await handler(config as any, 'new question', {}, {}, sampleHistory);
    const call = mockMessagesCreate.mock.calls[0][0];
    expect(call.system).toBe('Be concise.');
    expect(call.messages[0]).toMatchObject({ role: 'user', content: 'Previous question' });
    expect(call.messages[1]).toMatchObject({ role: 'assistant', content: 'Previous answer' });
    expect(call.messages[2]).toMatchObject({ role: 'user', content: 'What is feature flagging?' });
    expect(call.messages[3]).toMatchObject({ role: 'assistant', content: 'Feature flagging is a technique...' });
    expect(call.messages.at(-1)).toMatchObject({ role: 'user', content: 'new question' });
  });

  it('history with instructions path — history messages appear before userInput', async () => {
    mockMessagesCreate.mockResolvedValue(mockFinalResponse());
    const handler = createClaudeMessagesHandler();
    await handler(baseConfig as any, 'follow up', {}, {}, sampleHistory);
    const call = mockMessagesCreate.mock.calls[0][0];
    expect(call.system).toBe('You are helpful.');
    expect(call.messages[0]).toMatchObject({ role: 'user', content: 'What is feature flagging?' });
    expect(call.messages[1]).toMatchObject({ role: 'assistant', content: 'Feature flagging is a technique...' });
    expect(call.messages.at(-1)).toMatchObject({ role: 'user', content: 'follow up' });
  });

  it('empty history is treated like no history', async () => {
    mockMessagesCreate.mockResolvedValue(mockFinalResponse());
    const handler = createClaudeMessagesHandler();
    await handler(baseConfig as any, 'hi', {}, {}, []);
    const callWithEmpty = mockMessagesCreate.mock.calls[0][0];

    mockMessagesCreate.mockClear();
    await handler(baseConfig as any, 'hi');
    const callWithout = mockMessagesCreate.mock.calls[0][0];

    expect(callWithEmpty.messages).toEqual(callWithout.messages);
    expect(callWithEmpty.system).toEqual(callWithout.system);
  });

  it('system role messages in history are filtered out', async () => {
    mockMessagesCreate.mockResolvedValue(mockFinalResponse());
    const handler = createClaudeMessagesHandler();
    const historyWithSystem = [
      { role: 'user' as const, content: 'Hello' },
      { role: 'system' as const, content: 'Should be filtered' },
      { role: 'assistant' as const, content: 'Hi there' },
    ];
    await handler(baseConfig as any, 'follow up', {}, {}, historyWithSystem);
    const call = mockMessagesCreate.mock.calls[0][0];
    const allContent = call.messages.map((m: any) => m.content);
    expect(allContent).not.toContain('Should be filtered');
    expect(allContent).toContain('Hello');
    expect(allContent).toContain('Hi there');
  });

  // ── §1.9 streaming ignores outputFormat ─────────────────────────────────────

  it('streaming handler does not inject outputFormat schema into system prompt', async () => {
    const outputFormat = { type: 'object', properties: { answer: { type: 'string' } } };
    const streamMock = makeStreamMock([{ type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } }], {
      usage: { input_tokens: 1, output_tokens: 1 },
      stop_reason: 'end_turn',
      content: [],
    });
    mockMessagesStream.mockReturnValue(streamMock);
    const config = { ...baseConfig, outputFormat };
    await collectStream(createClaudeMessagesHandler().stream?.(config as any, 'q', {}, {}));
    const call = mockMessagesStream.mock.calls[0][0];
    expect(call.system).toBe('You are helpful.');
    expect(call.system).not.toContain(JSON.stringify(outputFormat));
  });
});

// ── §1.9 outputFormat — best-effort (system prompt injection) ─────────────────

describe('createClaudeMessagesHandler — outputFormat (§1.9)', () => {
  const outputFormat = { type: 'object', properties: { answer: { type: 'string' } } };

  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of Object.keys(mockSpan)) {
      (mockSpan as any)[key].mockReset?.();
    }
  });

  it('appends JSON schema instruction to instructions-based system prompt when outputFormat is set', async () => {
    mockMessagesCreate.mockResolvedValue(mockFinalResponse());
    const config = { ...baseConfig, outputFormat };
    await createClaudeMessagesHandler()(config as any, 'hello');
    const call = mockMessagesCreate.mock.calls[0][0];
    expect(call.system).toContain('You are helpful.');
    expect(call.system).toContain(JSON.stringify(outputFormat));
  });

  it('appends JSON schema instruction when system prompt comes from messages array', async () => {
    mockMessagesCreate.mockResolvedValue(mockFinalResponse());
    const config = {
      model: { name: 'claude-3-5-sonnet-20241022' },
      provider: { name: 'Anthropic' },
      messages: [{ role: 'system', content: 'From messages.' }],
      outputFormat,
    };
    await createClaudeMessagesHandler()(config as any, 'hello');
    const call = mockMessagesCreate.mock.calls[0][0];
    expect(call.system).toContain('From messages.');
    expect(call.system).toContain(JSON.stringify(outputFormat));
  });

  it('does not inject schema instruction when outputFormat is absent', async () => {
    mockMessagesCreate.mockResolvedValue(mockFinalResponse());
    await createClaudeMessagesHandler()(baseConfig as any, 'hello');
    const call = mockMessagesCreate.mock.calls[0][0];
    expect(call.system).toBe('You are helpful.');
    expect(call.system).not.toContain('"type":"object"');
  });
});

// ── §1.10 MAX_STEPS cap ───────────────────────────────────────────────────────

describe('createClaudeMessagesHandler — MAX_STEPS cap (§1.10)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of Object.keys(mockSpan)) {
      (mockSpan as any)[key].mockReset?.();
    }
  });

  function toolUseResponse(id = 'tu_1') {
    return {
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id, name: 'myTool', input: {} }],
      usage: { input_tokens: 1, output_tokens: 1 },
    };
  }

  it('throws after MAX_STEPS (10) consecutive tool-use responses in invoke', async () => {
    const toolFn = vi.fn().mockReturnValue('result');
    mockMessagesCreate
      .mockResolvedValueOnce(toolUseResponse('tu_1'))
      .mockResolvedValueOnce(toolUseResponse('tu_2'))
      .mockResolvedValueOnce(toolUseResponse('tu_3'))
      .mockResolvedValueOnce(toolUseResponse('tu_4'))
      .mockResolvedValueOnce(toolUseResponse('tu_5'))
      .mockResolvedValueOnce(toolUseResponse('tu_6'))
      .mockResolvedValueOnce(toolUseResponse('tu_7'))
      .mockResolvedValueOnce(toolUseResponse('tu_8'))
      .mockResolvedValueOnce(toolUseResponse('tu_9'))
      .mockResolvedValueOnce(toolUseResponse('tu_10'))
      .mockResolvedValueOnce(toolUseResponse('tu_11'));

    const cfg = { ...baseConfig, tools: { myTool: { name: 'myTool', type: 'function' as const, parameters: {} } } };
    const handler = createClaudeMessagesHandler();
    await expect(handler(cfg as any, 'q', { myTool: toolFn })).rejects.toThrow(/maximum number of steps/);
    expect(mockMessagesCreate).toHaveBeenCalledTimes(11);
  });

  it('does not throw when exactly MAX_STEPS tool calls are followed by a final response in invoke', async () => {
    const toolFn = vi.fn().mockReturnValue('result');
    mockMessagesCreate
      .mockResolvedValueOnce(toolUseResponse('tu_1'))
      .mockResolvedValueOnce(toolUseResponse('tu_2'))
      .mockResolvedValueOnce(toolUseResponse('tu_3'))
      .mockResolvedValueOnce(toolUseResponse('tu_4'))
      .mockResolvedValueOnce(toolUseResponse('tu_5'))
      .mockResolvedValueOnce(toolUseResponse('tu_6'))
      .mockResolvedValueOnce(toolUseResponse('tu_7'))
      .mockResolvedValueOnce(toolUseResponse('tu_8'))
      .mockResolvedValueOnce(toolUseResponse('tu_9'))
      .mockResolvedValueOnce(toolUseResponse('tu_10'))
      .mockResolvedValueOnce(mockFinalResponse('Done'));

    const cfg = { ...baseConfig, tools: { myTool: { name: 'myTool', type: 'function' as const, parameters: {} } } };
    const handler = createClaudeMessagesHandler();
    const result = await handler(cfg as any, 'q', { myTool: toolFn });
    expect(result.output).toBe('Done');
  });

  it('throws after MAX_STEPS (10) consecutive tool-use responses in stream', async () => {
    const toolFn = vi.fn().mockReturnValue('result');
    function makeToolStream(id: string) {
      return {
        [Symbol.asyncIterator]: () => (async function* () {})()[Symbol.asyncIterator](),
        finalMessage: vi.fn().mockResolvedValue({
          usage: { input_tokens: 1, output_tokens: 1 },
          stop_reason: 'tool_use',
          content: [{ type: 'tool_use', id, name: 'myTool', input: {} }],
        }),
      };
    }
    mockMessagesStream
      .mockReturnValueOnce(makeToolStream('tu_1'))
      .mockReturnValueOnce(makeToolStream('tu_2'))
      .mockReturnValueOnce(makeToolStream('tu_3'))
      .mockReturnValueOnce(makeToolStream('tu_4'))
      .mockReturnValueOnce(makeToolStream('tu_5'))
      .mockReturnValueOnce(makeToolStream('tu_6'))
      .mockReturnValueOnce(makeToolStream('tu_7'))
      .mockReturnValueOnce(makeToolStream('tu_8'))
      .mockReturnValueOnce(makeToolStream('tu_9'))
      .mockReturnValueOnce(makeToolStream('tu_10'))
      .mockReturnValueOnce(makeToolStream('tu_11'));

    const cfg = { ...baseConfig, tools: { myTool: { name: 'myTool', type: 'function' as const, parameters: {} } } };
    const handler = createClaudeMessagesHandler();
    const collectStream = async (gen: AsyncGenerator<any>) => {
      const out: any[] = [];
      for await (const e of gen) out.push(e);
      return out;
    };
    await expect(collectStream(handler.stream?.(cfg as any, 'q', { myTool: toolFn }, {}))).rejects.toThrow(
      /maximum number of steps/,
    );
  });
});
