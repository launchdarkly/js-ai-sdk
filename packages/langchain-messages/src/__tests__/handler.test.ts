import { AIMessage } from '@langchain/core/messages';
import { SpanStatusCode } from '@opentelemetry/api';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockStartActiveSpan = vi.hoisted(() => vi.fn());

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

vi.mock('@opentelemetry/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@opentelemetry/api')>();
  return {
    ...actual,
    trace: {
      ...actual.trace,
      getTracer: vi.fn().mockReturnValue({
        startActiveSpan: mockStartActiveSpan.mockImplementation((_name: string, fn: Function) => fn(mockSpan)),
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

function modelSpans() {
  return mockChildSpans.filter(({ name }) => name.startsWith('chat'));
}

function latestModelSpan() {
  return mockChildSpans.findLast(({ name }) => name.startsWith('chat'))?.span;
}

vi.mock('@launchdarkly/ai-server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@launchdarkly/ai-server')>();
  return {
    ...actual,
    config: vi.fn().mockReturnValue({ invoke: vi.fn().mockResolvedValue({ response: 'ok', usage: {} }) }),
  };
});

// LangChain's ChatOpenAI is only used as the default — we inject our own llm in tests
vi.mock('@langchain/openai', () => ({
  ChatOpenAI: vi.fn().mockImplementation(() => ({})),
}));

import { createLangChainHandler } from '../handler.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Creates a minimal mock LLM that returns a plain text AIMessage. */
function makeMockLLM(content = 'response text', inputTokens = 10, outputTokens = 5) {
  const invoke = vi.fn().mockResolvedValue(
    new AIMessage({
      content,
      usage_metadata: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens,
      },
    }),
  );
  return {
    invoke,
    bindTools: vi.fn().mockReturnThis(),
  };
}

const baseConfig = {
  model: { name: 'gpt-4o' },
  provider: { name: 'LangChain' },
  instructions: 'You are helpful.',
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('createLangChainHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStartActiveSpan.mockImplementation((_name: string, fn: Function) => fn(mockSpan));
    mockChildSpans.length = 0;
    for (const key of Object.keys(mockSpan)) {
      (mockSpan as any)[key].mockReset?.();
    }
  });

  // ── 1.1 Factory and metadata ────────────────────────────────────────────────

  it('returns a callable function', () => {
    expect(typeof createLangChainHandler(makeMockLLM() as any)).toBe('function');
  });

  it('attaches providesFor = ["*", "messages"]', () => {
    expect(createLangChainHandler(makeMockLLM() as any).providesFor).toEqual(['*', 'messages']);
  });

  it('returns independent instances on multiple calls', () => {
    const llm = makeMockLLM() as any;
    expect(createLangChainHandler(llm)).not.toBe(createLangChainHandler(llm));
  });

  // ── 1.2 Prompt construction ─────────────────────────────────────────────────

  it('uses instructions as SystemMessage', async () => {
    const llm = makeMockLLM();
    const handler = createLangChainHandler(llm as any);
    await handler(baseConfig as any, 'hello');
    const messages = llm.invoke.mock.calls[0][0];
    expect(messages[0]._getType()).toBe('system');
    expect(messages[0].content).toBe('You are helpful.');
    expect(messages[1]._getType()).toBe('human');
    expect(messages[1].content).toBe('hello');
  });

  it('substitutes variables in instructions', async () => {
    const llm = makeMockLLM();
    await createLangChainHandler(llm as any)(
      { ...baseConfig, instructions: 'Hello {{name}}.' } as any,
      'q',
      {},
      { name: 'Carol' },
    );
    const messages = llm.invoke.mock.calls[0][0];
    expect(messages[0].content).toBe('Hello Carol.');
  });

  it('uses messages array when instructions absent — skips appending when last is user', async () => {
    const llm = makeMockLLM();
    const config = {
      model: { name: 'gpt-4o' },
      provider: { name: 'LangChain' },
      messages: [
        { role: 'system', content: 'Be concise.' },
        { role: 'user', content: 'Old question' },
      ],
    };
    await createLangChainHandler(llm as any)(config as any, 'new question');
    const messages = llm.invoke.mock.calls[0][0];
    expect(messages[0]._getType()).toBe('system');
    expect(messages[0].content).toBe('Be concise.');
    expect(messages).toHaveLength(2);
    expect(messages[1].content).toBe('Old question');
  });

  it('appends userInput when last message is assistant', async () => {
    const llm = makeMockLLM();
    const config = {
      model: { name: 'gpt-4o' },
      provider: { name: 'LangChain' },
      messages: [
        { role: 'system', content: 'Be concise.' },
        { role: 'user', content: 'Old question' },
        { role: 'assistant', content: 'Old answer' },
      ],
    };
    await createLangChainHandler(llm as any)(config as any, 'new question');
    const messages = llm.invoke.mock.calls[0][0];
    expect(messages.at(-1).content).toBe('new question');
  });

  it('prefers messages over instructions when both are present', async () => {
    const llm = makeMockLLM();
    const config = {
      ...baseConfig,
      messages: [{ role: 'system', content: 'Messages system — takes priority' }],
    };
    await createLangChainHandler(llm as any)(config as any, 'q');
    const messages = llm.invoke.mock.calls[0][0];
    expect(messages[0].content).toBe('Messages system — takes priority');
  });

  // ── 1.x.2 Path C edge cases ─────────────────────────────────────────────────

  it('does not throw when userInput is an empty string', async () => {
    const llm = makeMockLLM();
    // Capture the messages snapshot at call time before the array is mutated by later pushes
    let capturedMessages: any[] | undefined;
    llm.invoke.mockImplementation((msgs: any[]) => {
      capturedMessages = [...msgs];
      return Promise.resolve(
        new AIMessage({ content: 'ok', usage_metadata: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }),
      );
    });
    await expect(createLangChainHandler(llm as any)(baseConfig as any, '')).resolves.toBeDefined();
    // With instructions present: [SystemMessage, HumanMessage(userInput)]
    const humanMsg = capturedMessages?.[1];
    expect(humanMsg._getType()).toBe('human');
    expect(humanMsg.content).toBe('');
  });

  it('does not throw when userInput is undefined', async () => {
    const llm = makeMockLLM();
    await expect(createLangChainHandler(llm as any)(baseConfig as any, undefined)).resolves.toBeDefined();
  });

  it('leaves unresolved placeholder unchanged in instructions', async () => {
    const llm = makeMockLLM();
    await createLangChainHandler(llm as any)({ ...baseConfig, instructions: 'Hello {{missing}}.' } as any, 'q', {}, {});
    const messages = llm.invoke.mock.calls[0][0];
    expect(messages[0].content).toBe('Hello {{missing}}.');
  });

  // ── 1.x.3 Path B variable substitution in messages array ────────────────────

  it('substitutes variables in system-role messages', async () => {
    const llm = makeMockLLM();
    const config = {
      model: { name: 'gpt-4o' },
      provider: { name: 'LangChain' },
      messages: [{ role: 'system', content: 'Be a {{role}}.' }],
    };
    await createLangChainHandler(llm as any)(config as any, 'q', {}, { role: 'poet' });
    const messages = llm.invoke.mock.calls[0][0];
    expect(messages[0]._getType()).toBe('system');
    expect(messages[0].content).toBe('Be a poet.');
  });

  it('substitutes variables in user-role messages', async () => {
    const llm = makeMockLLM();
    const config = {
      model: { name: 'gpt-4o' },
      provider: { name: 'LangChain' },
      messages: [{ role: 'user', content: 'Tell me about {{topic}}.' }],
    };
    await createLangChainHandler(llm as any)(config as any, 'follow-up', {}, { topic: 'oceans' });
    const messages = llm.invoke.mock.calls[0][0];
    expect(messages[0]._getType()).toBe('human');
    expect(messages[0].content).toBe('Tell me about oceans.');
  });

  // ── 1.3 Tool conversion ─────────────────────────────────────────────────────

  it('calls bindTools when config.tools is present', async () => {
    const llm = makeMockLLM();
    const config = {
      ...baseConfig,
      tools: {
        search: { name: 'search', type: 'function' as const, parameters: { type: 'object' }, description: 'Search' },
      },
    };
    await createLangChainHandler(llm as any)(config as any, 'q', { search: vi.fn() });
    expect(llm.bindTools).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ function: expect.objectContaining({ name: 'search' }) })]),
    );
  });

  it('does not call bindTools when config.tools is absent', async () => {
    const llm = makeMockLLM();
    await createLangChainHandler(llm as any)(baseConfig as any, 'q');
    expect(llm.bindTools).not.toHaveBeenCalled();
  });

  // ── 1.x.4 Multiple tools forwarded ──────────────────────────────────────────

  it('forwards all three tools to bindTools', async () => {
    const llm = makeMockLLM();
    const config = {
      ...baseConfig,
      tools: {
        search: {
          name: 'search',
          type: 'function' as const,
          parameters: { type: 'object' },
          description: 'Search the web',
        },
        calc: { name: 'calc', type: 'function' as const, parameters: { type: 'object' }, description: 'Calculate' },
        weather: {
          name: 'weather',
          type: 'function' as const,
          parameters: { type: 'object' },
          description: 'Get weather',
        },
      },
    };
    await createLangChainHandler(llm as any)(config as any, 'q', { search: vi.fn(), calc: vi.fn(), weather: vi.fn() });
    const toolDefs = llm.bindTools.mock.calls[0][0];
    expect(toolDefs).toHaveLength(3);
    const names = toolDefs.map((t: any) => t.function.name);
    expect(names).toContain('search');
    expect(names).toContain('calc');
    expect(names).toContain('weather');
  });

  // ── 1.4 Tool execution loop ─────────────────────────────────────────────────

  it('invokes the tool handler when model returns tool_calls', async () => {
    const myTool = vi.fn().mockReturnValue('tool-result');
    const llm = {
      bindTools: vi.fn().mockReturnThis(),
      invoke: vi
        .fn()
        .mockResolvedValueOnce(
          new AIMessage({
            content: '',
            tool_calls: [{ name: 'myTool', args: { q: 'test' }, id: 'tc1' }],
            usage_metadata: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
          }),
        )
        .mockResolvedValueOnce(
          new AIMessage({
            content: 'Final answer',
            usage_metadata: { input_tokens: 2, output_tokens: 2, total_tokens: 4 },
          }),
        ),
    };
    const config = {
      ...baseConfig,
      tools: { myTool: { name: 'myTool', type: 'function' as const, parameters: {} } },
    };
    const result = await createLangChainHandler(llm as any)(config as any, 'q', { myTool });
    expect(myTool).toHaveBeenCalledWith({ q: 'test' });
    expect(result.output).toBe('Final answer');
  });

  // ── 1.x.5 Multiple consecutive tool calls ───────────────────────────────────

  it('handles multiple consecutive tool calls across turns', async () => {
    const toolA = vi.fn().mockReturnValue('result-a');
    const toolB = vi.fn().mockReturnValue('result-b');
    const llm = {
      bindTools: vi.fn().mockReturnThis(),
      invoke: vi
        .fn()
        .mockResolvedValueOnce(
          new AIMessage({
            content: '',
            tool_calls: [{ name: 'toolA', args: { x: 1 }, id: 'tc1' }],
            usage_metadata: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
          }),
        )
        .mockResolvedValueOnce(
          new AIMessage({
            content: '',
            tool_calls: [{ name: 'toolB', args: { y: 2 }, id: 'tc2' }],
            usage_metadata: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
          }),
        )
        .mockResolvedValueOnce(
          new AIMessage({
            content: 'Done',
            usage_metadata: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
          }),
        ),
    };
    const config = {
      ...baseConfig,
      tools: {
        toolA: { name: 'toolA', type: 'function' as const, parameters: {} },
        toolB: { name: 'toolB', type: 'function' as const, parameters: {} },
      },
    };
    const result = await createLangChainHandler(llm as any)(config as any, 'q', { toolA, toolB });
    expect(toolA).toHaveBeenCalledOnce();
    expect(toolA).toHaveBeenCalledWith({ x: 1 });
    expect(toolB).toHaveBeenCalledOnce();
    expect(toolB).toHaveBeenCalledWith({ y: 2 });
    expect(result.output).toBe('Done');
  });

  it('throws when model requests an unregistered tool', async () => {
    const llm = {
      bindTools: vi.fn().mockReturnThis(),
      invoke: vi.fn().mockResolvedValue(
        new AIMessage({
          content: '',
          tool_calls: [{ name: 'unknownTool', args: {}, id: 'tc1' }],
          usage_metadata: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        }),
      ),
    };
    const config = {
      ...baseConfig,
      tools: { unknownTool: { name: 'unknownTool', type: 'function' as const, parameters: {} } },
    };
    await expect(createLangChainHandler(llm as any)(config as any, 'q', {})).rejects.toThrow(/unknownTool/);
  });

  it('propagates errors thrown by tool handlers', async () => {
    const brokenTool = vi.fn().mockRejectedValue(new Error('tool explosion'));
    const llm = {
      bindTools: vi.fn().mockReturnThis(),
      invoke: vi.fn().mockResolvedValue(
        new AIMessage({
          content: '',
          tool_calls: [{ name: 'brokenTool', args: {}, id: 'tc1' }],
          usage_metadata: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        }),
      ),
    };
    const config = {
      ...baseConfig,
      tools: { brokenTool: { name: 'brokenTool', type: 'function' as const, parameters: {} } },
    };
    await expect(createLangChainHandler(llm as any)(config as any, 'q', { brokenTool })).rejects.toThrow(
      'tool explosion',
    );
  });

  it('does not invoke toolHandlers when config.tools is absent', async () => {
    const orphanTool = vi.fn();
    const llm = makeMockLLM();
    await createLangChainHandler(llm as any)(baseConfig as any, 'q', { orphanTool });
    expect(orphanTool).not.toHaveBeenCalled();
    expect(llm.invoke).toHaveBeenCalledOnce();
  });

  // ── 1.5 Telemetry ───────────────────────────────────────────────────────────

  it('uses invoke_agent as the root span name', async () => {
    await createLangChainHandler(makeMockLLM() as any)(baseConfig as any, 'q');
    expect(mockStartActiveSpan).toHaveBeenCalledWith('invoke_agent', expect.any(Function));
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('gen_ai.operation.name', 'invoke_agent');
  });

  it('sets gen_ai usage attributes on the chat model span', async () => {
    const llm = makeMockLLM('hi', 8, 4);
    await createLangChainHandler(llm as any)(baseConfig as any, 'q');
    const modelSpan = latestModelSpan();
    expect(modelSpan?.setAttribute).toHaveBeenCalledWith('gen_ai.system', 'langchain');
    expect(modelSpan?.setAttribute).toHaveBeenCalledWith('gen_ai.operation.name', 'chat');
    expect(modelSpan?.setAttribute).toHaveBeenCalledWith('gen_ai.request.model', 'gpt-4o');
    expect(modelSpan?.setAttribute).toHaveBeenCalledWith('gen_ai.usage.input_tokens', 8);
    expect(modelSpan?.setAttribute).toHaveBeenCalledWith('gen_ai.usage.output_tokens', 4);
    expect(modelSpan?.setAttribute).toHaveBeenCalledWith('gen_ai.usage.total_tokens', 12);
  });

  it('emits no content at all by default', async () => {
    const llm = makeMockLLM('answer');
    await createLangChainHandler(llm as any)(baseConfig as any, 'question');

    // Conversation content is PII, so a caller has to ask for it. Asserting on the recorded
    // arguments rather than on specific keys catches a new content attribute added without a gate.
    const written = JSON.stringify(mockSpan.setAttribute.mock.calls);
    expect(written).not.toContain('question');
    expect(mockSpan.addEvent).not.toHaveBeenCalledWith('gen_ai.content.prompt', expect.anything());
  });

  it('puts prompt and completion on span attributes when capture is enabled', async () => {
    const llm = makeMockLLM('answer');
    await createLangChainHandler(llm as any, { captureContent: true })(baseConfig as any, 'question');

    // Attributes, not events: OTEP 4430 deprecated event-recorded content and LaunchDarkly's
    // readers parse only attributes.
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('gen_ai.prompt.1.content', 'question');
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('gen_ai.completion.0.content', 'answer');
    expect(mockSpan.addEvent).toHaveBeenCalledWith('gen_ai.content.prompt', expect.anything());
  });

  // ── LaunchDarkly correlation ────────────────────────────────────────────────
  //
  // The `feature_flag` span event is how the AI Config Monitoring tab locates a trace
  // (events.name = feature_flag AND events.attributes.feature_flag.key = <configKey>). It has to be
  // on the root, because the root is what that query finds. Dropping it, or emitting it on a child
  // instead, silently detaches every trace from its AI Config with nothing else failing.

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

  it('emits the feature_flag correlation event and launchdarkly attributes on the root span', async () => {
    await createLangChainHandler(makeMockLLM() as any)(baseConfig as any, 'q', {}, ldFixture);

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
    await createLangChainHandler(makeMockLLM() as any)(baseConfig as any, 'q', {}, ldFixture);
    const childEvents = mockChildSpans.flatMap(({ span }) => span.addEvent.mock.calls.map((c: unknown[]) => c[0]));
    expect(childEvents).not.toContain('feature_flag');
  });

  it('sets OK status and ends span on success', async () => {
    await createLangChainHandler(makeMockLLM() as any)(baseConfig as any, 'q');
    expect(mockSpan.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.OK });
    expect(mockSpan.end).toHaveBeenCalled();
  });

  // ── 1.5b Span hierarchy (invoke_agent → chat → execute_tool) ─────────────────

  function toolThenAnswerLLM(myTool: ReturnType<typeof vi.fn>) {
    return {
      bindTools: vi.fn().mockReturnThis(),
      invoke: vi
        .fn()
        .mockResolvedValueOnce(
          new AIMessage({
            content: '',
            tool_calls: [{ name: 'myTool', args: { q: 'test' }, id: 'tc1' }],
            usage_metadata: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
          }),
        )
        .mockResolvedValueOnce(
          new AIMessage({
            content: 'Final answer',
            usage_metadata: { input_tokens: 2, output_tokens: 2, total_tokens: 4 },
          }),
        ),
      _tool: myTool,
    };
  }

  const toolConfig = {
    ...baseConfig,
    tools: { myTool: { name: 'myTool', type: 'function' as const, parameters: {} } },
  };

  it('emits one chat child span per model turn under the invoke_agent root', async () => {
    const myTool = vi.fn().mockReturnValue('r');
    await createLangChainHandler(toolThenAnswerLLM(myTool) as any)(toolConfig as any, 'q', { myTool });

    const chats = modelSpans();
    expect(chats).toHaveLength(2);
    expect(chats.every(({ span }) => span.end.mock.calls.length === 1)).toBe(true);
    // `{operation} {request.model}`, per the semantic conventions for an inference span.
    expect(chats.every(({ name }) => name === `chat ${baseConfig.model.name}`)).toBe(true);
  });

  it('emits an execute_tool child span per tool call, keyed by tool_call id', async () => {
    const myTool = vi.fn().mockReturnValue('r');
    await createLangChainHandler(toolThenAnswerLLM(myTool) as any)(toolConfig as any, 'q', { myTool });

    const toolSpan = mockChildSpans.find(({ name }) => name === 'execute_tool myTool')?.span;
    expect(toolSpan?.setAttribute).toHaveBeenCalledWith('gen_ai.operation.name', 'execute_tool');
    expect(toolSpan?.setAttribute).toHaveBeenCalledWith('gen_ai.tool.name', 'myTool');
    expect(toolSpan?.setAttribute).toHaveBeenCalledWith('gen_ai.tool.call.id', 'tc1');
    expect(toolSpan?.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.OK });
    expect(toolSpan?.end).toHaveBeenCalledOnce();
  });

  it('surfaces LangChain cached tokens as cache_read without adding them to the input total', async () => {
    const llm = {
      bindTools: vi.fn().mockReturnThis(),
      invoke: vi.fn().mockResolvedValue(
        new AIMessage({
          content: 'hi',
          // LangChain already includes cached tokens inside input_tokens; the breakdown lives in details.
          usage_metadata: {
            input_tokens: 50,
            output_tokens: 5,
            total_tokens: 55,
            input_token_details: { cache_read: 30, cache_creation: 10 },
          },
        }),
      ),
    };
    await createLangChainHandler(llm as any)(baseConfig as any, 'q');

    const modelSpan = latestModelSpan();
    expect(modelSpan?.setAttribute).toHaveBeenCalledWith('gen_ai.usage.input_tokens', 50);
    expect(modelSpan?.setAttribute).toHaveBeenCalledWith('gen_ai.usage.cache_read.input_tokens', 30);
    expect(modelSpan?.setAttribute).toHaveBeenCalledWith('gen_ai.usage.cache_creation.input_tokens', 10);
  });

  it('fails the chat span when the model invoke throws', async () => {
    const err = new Error('LLM down');
    const llm = { invoke: vi.fn().mockRejectedValue(err), bindTools: vi.fn().mockReturnThis() };
    await expect(createLangChainHandler(llm as any)(baseConfig as any, 'q')).rejects.toThrow('LLM down');

    const modelSpan = latestModelSpan();
    expect(modelSpan?.recordException).toHaveBeenCalledWith(err);
    expect(modelSpan?.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.ERROR, message: 'LLM down' });
    expect(modelSpan?.end).toHaveBeenCalledOnce();
  });

  it('fails the execute_tool span when a tool handler throws', async () => {
    const err = new Error('tool boom');
    const llm = {
      bindTools: vi.fn().mockReturnThis(),
      invoke: vi.fn().mockResolvedValue(
        new AIMessage({
          content: '',
          tool_calls: [{ name: 'myTool', args: {}, id: 'tc1' }],
          usage_metadata: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
        }),
      ),
    };
    await expect(
      createLangChainHandler(llm as any)(toolConfig as any, 'q', { myTool: vi.fn().mockRejectedValue(err) }),
    ).rejects.toThrow('tool boom');

    const toolSpan = mockChildSpans.find(({ name }) => name === 'execute_tool myTool')?.span;
    expect(toolSpan?.recordException).toHaveBeenCalledWith(err);
    expect(toolSpan?.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.ERROR, message: 'tool boom' });
    expect(toolSpan?.end).toHaveBeenCalledOnce();
  });

  // ── 1.6 Error handling ──────────────────────────────────────────────────────

  it('records exception, sets ERROR status, ends span, and re-throws', async () => {
    const err = new Error('LLM error');
    const llm = { invoke: vi.fn().mockRejectedValue(err), bindTools: vi.fn().mockReturnThis() };
    await expect(createLangChainHandler(llm as any)(baseConfig as any, 'q')).rejects.toThrow('LLM error');
    expect(mockSpan.recordException).toHaveBeenCalledWith(err);
    expect(mockSpan.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.ERROR, message: 'LLM error' });
    expect(mockSpan.end).toHaveBeenCalled();
  });

  // ── 1.7 Convenience export ──────────────────────────────────────────────────

  it('langchainMessages calls config() with the correct handler, userInput, and context', async () => {
    const { langchainMessages } = await import('../handler.js');
    const { config } = await import('@launchdarkly/ai-server');
    const ctx = { kind: 'user' as const, key: 'u' };
    const mockInvoke = vi.fn().mockResolvedValue({ response: 'ok', usage: {} });
    (config as any).mockReturnValue({ invoke: mockInvoke });
    await langchainMessages('flag', 'hello', ctx, {} as any);
    expect(config).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'flag',
        handler: expect.objectContaining({ providesFor: ['*', 'messages'] }),
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

  function makeStreamingLLM(chunks: string[], inputTokens = 5, outputTokens = 3) {
    const streamFn = vi.fn().mockReturnValue(
      (async function* () {
        for (const text of chunks) {
          yield new AIMessage({
            content: text,
            usage_metadata: {
              input_tokens: inputTokens / chunks.length,
              output_tokens: outputTokens / chunks.length,
              total_tokens: (inputTokens + outputTokens) / chunks.length,
            },
          });
        }
      })(),
    );
    return { invoke: vi.fn(), stream: streamFn, bindTools: vi.fn().mockReturnThis() };
  }

  it('handler.stream is defined', () => {
    const handler = createLangChainHandler(makeMockLLM() as any);
    expect(typeof handler.stream).toBe('function');
  });

  it('handler.stream returns an async iterable', () => {
    const llm = makeStreamingLLM(['hi']);
    const handler = createLangChainHandler(llm as any);
    const gen = handler.stream?.(baseConfig as any, 'q', {}, {});
    expect(typeof gen[Symbol.asyncIterator]).toBe('function');
  });

  it('yields chunk events for each AIMessageChunk', async () => {
    const llm = makeStreamingLLM(['Hello', ' world']);
    const handler = createLangChainHandler(llm as any);
    const events = await collectStream(handler.stream?.(baseConfig as any, 'q', {}, {}));
    const chunks = events.filter((e: any) => e.type === 'chunk').map((e: any) => e.text);
    expect(chunks).toEqual(['Hello', ' world']);
  });

  it('yields a done event as the last event', async () => {
    const llm = makeStreamingLLM(['hi']);
    const handler = createLangChainHandler(llm as any);
    const events = await collectStream(handler.stream?.(baseConfig as any, 'q', {}, {}));
    expect(events.at(-1) as any).toMatchObject({ type: 'done' });
  });

  it('no chunk event appears after the done event', async () => {
    const llm = makeStreamingLLM(['a', 'b', 'c']);
    const handler = createLangChainHandler(llm as any);
    const events = await collectStream(handler.stream?.(baseConfig as any, 'q', {}, {}));
    const doneIdx = events.findIndex((e: any) => e.type === 'done');
    const chunksAfterDone = events.slice(doneIdx + 1).filter((e: any) => e.type === 'chunk');
    expect(chunksAfterDone).toHaveLength(0);
  });

  it('done event carries correct usage', async () => {
    const llm = makeStreamingLLM(['result'], 10, 6);
    const handler = createLangChainHandler(llm as any);
    const events = await collectStream(handler.stream?.(baseConfig as any, 'q', {}, {}));
    const done = events.find((e: any) => e.type === 'done') as any;
    expect(done.usage.input_tokens).toBe(10);
    expect(done.usage.output_tokens).toBe(6);
  });

  it('done event carries the accumulated output text', async () => {
    const llm = makeStreamingLLM(['Hello', ' world']);
    const handler = createLangChainHandler(llm as any);
    const events = await collectStream(handler.stream?.(baseConfig as any, 'q', {}, {}));
    const done = events.find((e: any) => e.type === 'done') as any;
    expect(done.output).toBe('Hello world');
  });

  it('sets span attributes and puts content on attributes when enabled, streaming', async () => {
    const llm = makeStreamingLLM(['result']);
    await collectStream(
      createLangChainHandler(llm as any, { captureContent: true }).stream?.(baseConfig as any, 'q', {}, {}),
    );
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('gen_ai.operation.name', 'invoke_agent');
    const modelSpan = latestModelSpan();
    expect(modelSpan?.setAttribute).toHaveBeenCalledWith('gen_ai.system', 'langchain');
    expect(modelSpan?.setAttribute).toHaveBeenCalledWith('gen_ai.operation.name', 'chat');
    expect(modelSpan?.setAttribute).toHaveBeenCalledWith('gen_ai.request.model', 'gpt-4o');
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('gen_ai.prompt.1.content', 'q');
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('gen_ai.completion.0.content', 'result');
    expect(mockSpan.addEvent).toHaveBeenCalledWith('gen_ai.content.completion', expect.anything());
    expect(mockSpan.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.OK });
    expect(mockSpan.end).toHaveBeenCalled();
  });

  it('uses invoke_agent as the streaming root span name', async () => {
    const { trace } = await import('@opentelemetry/api');
    const startSpanSpy = (trace.getTracer as any)().startSpan;
    const llm = makeStreamingLLM(['hi']);
    await collectStream(createLangChainHandler(llm as any).stream?.(baseConfig as any, 'q', {}, {}));
    expect(startSpanSpy).toHaveBeenCalledWith('invoke_agent');
  });

  it('records exception on stream error', async () => {
    const err = new Error('stream fail');
    const llm = {
      invoke: vi.fn(),
      bindTools: vi.fn().mockReturnThis(),
      stream: vi.fn().mockRejectedValue(err),
    };
    await expect(
      collectStream(createLangChainHandler(llm as any).stream?.(baseConfig as any, 'q', {}, {})),
    ).rejects.toThrow('stream fail');
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
    const llm = makeMockLLM();
    const handler = createLangChainHandler(llm as any);
    const config = {
      model: { name: 'gpt-4o' },
      provider: { name: 'LangChain' },
      messages: [
        { role: 'system', content: 'Be concise.' },
        { role: 'user', content: 'Previous question' },
        { role: 'assistant', content: 'Previous answer' },
      ],
    };
    await handler(config as any, 'new question', {}, {}, sampleHistory);
    const messages = llm.invoke.mock.calls[0][0];
    expect(messages[0]._getType()).toBe('system');
    expect(messages[0].content).toBe('Be concise.');
    expect(messages[1]._getType()).toBe('human');
    expect(messages[1].content).toBe('Previous question');
    expect(messages[2]._getType()).toBe('ai');
    expect(messages[2].content).toBe('Previous answer');
    expect(messages[3]._getType()).toBe('human');
    expect(messages[3].content).toBe('What is feature flagging?');
    expect(messages[4]._getType()).toBe('ai');
    expect(messages[4].content).toBe('Feature flagging is a technique...');
    expect(messages.at(-1)._getType()).toBe('human');
    expect(messages.at(-1).content).toBe('new question');
  });

  it('history with instructions path — history messages appear before userInput', async () => {
    const llm = makeMockLLM();
    const handler = createLangChainHandler(llm as any);
    await handler(baseConfig as any, 'follow up', {}, {}, sampleHistory);
    const messages = llm.invoke.mock.calls[0][0];
    expect(messages[0]._getType()).toBe('system');
    expect(messages[0].content).toBe('You are helpful.');
    expect(messages[1]._getType()).toBe('human');
    expect(messages[1].content).toBe('What is feature flagging?');
    expect(messages[2]._getType()).toBe('ai');
    expect(messages[2].content).toBe('Feature flagging is a technique...');
    expect(messages.at(-1)._getType()).toBe('human');
    expect(messages.at(-1).content).toBe('follow up');
  });

  it('empty history is treated like no history', async () => {
    const llm1 = makeMockLLM();
    await createLangChainHandler(llm1 as any)(baseConfig as any, 'hi', {}, {}, []);
    const withEmpty = llm1.invoke.mock.calls[0][0];

    const llm2 = makeMockLLM();
    await createLangChainHandler(llm2 as any)(baseConfig as any, 'hi');
    const without = llm2.invoke.mock.calls[0][0];

    expect(withEmpty.length).toEqual(without.length);
    for (let i = 0; i < withEmpty.length; i++) {
      expect(withEmpty[i]._getType()).toBe(without[i]._getType());
      expect(withEmpty[i].content).toBe(without[i].content);
    }
  });

  it('system role messages in history are filtered out', async () => {
    const llm = makeMockLLM();
    const handler = createLangChainHandler(llm as any);
    const historyWithSystem = [
      { role: 'user' as const, content: 'Hello' },
      { role: 'system' as const, content: 'Should be filtered' },
      { role: 'assistant' as const, content: 'Hi there' },
    ];
    await handler(baseConfig as any, 'follow up', {}, {}, historyWithSystem);
    const messages = llm.invoke.mock.calls[0][0];
    const allContent = messages.map((m: any) => m.content);
    expect(allContent).not.toContain('Should be filtered');
    expect(allContent).toContain('Hello');
    expect(allContent).toContain('Hi there');
  });

  // ── 1.x.7 Streaming — tool loop ─────────────────────────────────────────────

  it('streams chunks from both turns around a tool call', async () => {
    const myTool = vi.fn().mockReturnValue('tool-output');

    // First stream turn: text then tool call
    const firstTurnChunks = [
      new AIMessage({
        content: 'Pre-tool text',
        usage_metadata: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
      }),
      new AIMessage({
        content: '',
        tool_calls: [{ name: 'myTool', args: { q: 'ask' }, id: 'tc1' }],
        usage_metadata: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      }),
    ];

    // Second stream turn: text after tool result
    const secondTurnChunks = [
      new AIMessage({
        content: 'Post-tool text',
        usage_metadata: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
      }),
    ];

    let callCount = 0;
    const streamFn = vi.fn().mockImplementation(() => {
      const chunks = callCount === 0 ? firstTurnChunks : secondTurnChunks;
      callCount++;
      return (async function* () {
        for (const c of chunks) yield c;
      })();
    });

    const llm = { invoke: vi.fn(), stream: streamFn, bindTools: vi.fn().mockReturnThis() };
    const config = {
      ...baseConfig,
      tools: { myTool: { name: 'myTool', type: 'function' as const, parameters: {} } },
    };

    const events = await collectStream(createLangChainHandler(llm as any).stream?.(config as any, 'q', { myTool }, {}));

    const chunkTexts = events.filter((e: any) => e.type === 'chunk').map((e: any) => e.text);
    expect(chunkTexts).toContain('Pre-tool text');
    expect(chunkTexts).toContain('Post-tool text');
  });

  it('streaming tool handler invoked with correct args', async () => {
    const myTool = vi.fn().mockReturnValue('result');

    const firstTurnChunks = [
      new AIMessage({
        content: '',
        tool_calls: [{ name: 'myTool', args: { key: 'val' }, id: 'tc1' }],
        usage_metadata: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      }),
    ];
    const secondTurnChunks = [
      new AIMessage({ content: 'done', usage_metadata: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }),
    ];

    let callCount = 0;
    const streamFn = vi.fn().mockImplementation(() => {
      const chunks = callCount === 0 ? firstTurnChunks : secondTurnChunks;
      callCount++;
      return (async function* () {
        for (const c of chunks) yield c;
      })();
    });

    const llm = { invoke: vi.fn(), stream: streamFn, bindTools: vi.fn().mockReturnThis() };
    const config = {
      ...baseConfig,
      tools: { myTool: { name: 'myTool', type: 'function' as const, parameters: {} } },
    };

    await collectStream(createLangChainHandler(llm as any).stream?.(config as any, 'q', { myTool }, {}));

    expect(myTool).toHaveBeenCalledWith({ key: 'val' });
  });

  it('done.output spans all streaming turns (pre-tool + post-tool)', async () => {
    const myTool = vi.fn().mockReturnValue('result');

    const firstTurnChunks = [
      new AIMessage({ content: 'Hello ', usage_metadata: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } }),
      new AIMessage({
        content: '',
        tool_calls: [{ name: 'myTool', args: {}, id: 'tc1' }],
        usage_metadata: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      }),
    ];
    const secondTurnChunks = [
      new AIMessage({ content: 'world', usage_metadata: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } }),
    ];

    let callCount = 0;
    const streamFn = vi.fn().mockImplementation(() => {
      const chunks = callCount === 0 ? firstTurnChunks : secondTurnChunks;
      callCount++;
      return (async function* () {
        for (const c of chunks) yield c;
      })();
    });

    const llm = { invoke: vi.fn(), stream: streamFn, bindTools: vi.fn().mockReturnThis() };
    const config = {
      ...baseConfig,
      tools: { myTool: { name: 'myTool', type: 'function' as const, parameters: {} } },
    };

    const events = await collectStream(createLangChainHandler(llm as any).stream?.(config as any, 'q', { myTool }, {}));

    const done = events.find((e: any) => e.type === 'done') as any;
    expect(done.output).toBe('Hello world');
  });
});

// ── §1.9 outputFormat — first-class (withStructuredOutput) ───────────────────

describe('createLangChainHandler — outputFormat (§1.9)', () => {
  const outputFormat = { type: 'object', properties: { answer: { type: 'string' } } };

  beforeEach(() => {
    vi.clearAllMocks();
    mockStartActiveSpan.mockImplementation((_name: string, fn: Function) => fn(mockSpan));
    mockChildSpans.length = 0;
    for (const key of Object.keys(mockSpan)) {
      (mockSpan as any)[key].mockReset?.();
    }
  });

  it('calls withStructuredOutput with the schema and { includeRaw: true } when outputFormat is set', async () => {
    const parsedOutput = { answer: 'forty-two' };
    const structuredInvoke = vi.fn().mockResolvedValue({
      parsed: parsedOutput,
      raw: new AIMessage({
        content: JSON.stringify(parsedOutput),
        usage_metadata: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      }),
    });
    const withStructuredOutput = vi.fn().mockReturnValue({ invoke: structuredInvoke });
    const llm = { invoke: vi.fn(), bindTools: vi.fn().mockReturnThis(), withStructuredOutput };
    const config = { ...baseConfig, outputFormat };
    await createLangChainHandler(llm as any)(config as any, 'hello');
    expect(withStructuredOutput).toHaveBeenCalledWith(outputFormat, expect.objectContaining({ includeRaw: true }));
  });

  it('returns the parsed field from withStructuredOutput invoke as output', async () => {
    const structuredOutput = { answer: 'forty-two' };
    const structuredInvoke = vi.fn().mockResolvedValue({
      parsed: structuredOutput,
      raw: new AIMessage({
        content: JSON.stringify(structuredOutput),
        usage_metadata: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      }),
    });
    const withStructuredOutput = vi.fn().mockReturnValue({ invoke: structuredInvoke });
    const llm = { invoke: vi.fn(), bindTools: vi.fn().mockReturnThis(), withStructuredOutput };
    const config = { ...baseConfig, outputFormat };
    const result = await createLangChainHandler(llm as any)(config as any, 'hello');
    expect(result.output).toEqual(structuredOutput);
  });

  it('does not call withStructuredOutput when outputFormat is absent', async () => {
    const withStructuredOutput = vi.fn();
    const llm = { ...makeMockLLM(), withStructuredOutput };
    const handler = createLangChainHandler(llm as any);
    await handler(baseConfig as any, 'hello');
    expect(withStructuredOutput).not.toHaveBeenCalled();
  });

  it('returns non-zero token usage from underlying model when outputFormat is set', async () => {
    // withStructuredOutput must be called with { includeRaw: true } so that the handler
    // can extract usage_metadata from the raw AIMessage alongside the parsed output.
    const parsedOutput = { answer: 'forty-two' };
    const rawMessage = new AIMessage({
      content: JSON.stringify(parsedOutput),
      usage_metadata: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
    });
    const structuredInvoke = vi.fn().mockResolvedValue({ parsed: parsedOutput, raw: rawMessage });
    const withStructuredOutput = vi.fn().mockReturnValue({ invoke: structuredInvoke });
    const llm = { invoke: vi.fn(), bindTools: vi.fn().mockReturnThis(), withStructuredOutput };
    const config = { ...baseConfig, outputFormat };
    const result = await createLangChainHandler(llm as any)(config as any, 'hello');
    expect(result.usage).toMatchObject({ input_tokens: 5, output_tokens: 3 });
  });

  it('returns the parsed field from the includeRaw response as output', async () => {
    const parsedOutput = { answer: 'forty-two' };
    const structuredInvoke = vi.fn().mockResolvedValue({
      parsed: parsedOutput,
      raw: new AIMessage({
        content: JSON.stringify(parsedOutput),
        usage_metadata: { input_tokens: 2, output_tokens: 2, total_tokens: 4 },
      }),
    });
    const withStructuredOutput = vi.fn().mockReturnValue({ invoke: structuredInvoke });
    const llm = { invoke: vi.fn(), bindTools: vi.fn().mockReturnThis(), withStructuredOutput };
    const config = { ...baseConfig, outputFormat };
    const result = await createLangChainHandler(llm as any)(config as any, 'hello');
    expect(result.output).toEqual(parsedOutput);
  });
});

// ── §1.9 outputFormat + tools conflict ───────────────────────────────────────

describe('createLangChainHandler — outputFormat + tools conflict (§1.9)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStartActiveSpan.mockImplementation((_name: string, fn: Function) => fn(mockSpan));
    mockChildSpans.length = 0;
    for (const key of Object.keys(mockSpan)) {
      (mockSpan as any)[key].mockReset?.();
    }
  });

  it('does not throw when outputFormat and config.tools are both present', async () => {
    const withStructuredOutput = vi.fn().mockReturnValue({
      invoke: vi.fn().mockResolvedValue({
        parsed: { answer: 'ok' },
        raw: new AIMessage({ content: '{}', usage_metadata: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }),
      }),
    });
    const llm = {
      invoke: vi.fn().mockResolvedValue(
        new AIMessage({
          content: 'response',
          usage_metadata: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        }),
      ),
      bindTools: vi.fn().mockReturnThis(),
      withStructuredOutput,
    };
    const config = {
      ...baseConfig,
      outputFormat: { type: 'object', properties: { answer: { type: 'string' } } },
      tools: { myTool: { name: 'myTool', type: 'function' as const, parameters: {} } },
    };
    await expect(createLangChainHandler(llm as any)(config as any, 'hello')).resolves.toBeDefined();
  });

  it('does not throw when outputFormat is set and config.tools is absent', async () => {
    const structuredInvoke = vi.fn().mockResolvedValue({
      parsed: { answer: 'ok' },
      raw: new AIMessage({
        content: '{"answer":"ok"}',
        usage_metadata: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      }),
    });
    const withStructuredOutput = vi.fn().mockReturnValue({ invoke: structuredInvoke });
    const llm = { invoke: vi.fn(), bindTools: vi.fn().mockReturnThis(), withStructuredOutput };
    const config = { ...baseConfig, outputFormat: { type: 'object', properties: { answer: { type: 'string' } } } };
    await expect(createLangChainHandler(llm as any)(config as any, 'hello')).resolves.not.toThrow();
  });
});

// ── §1.10 MAX_STEPS cap ───────────────────────────────────────────────────────

describe('createLangChainHandler — MAX_STEPS cap (§1.10)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStartActiveSpan.mockImplementation((_name: string, fn: Function) => fn(mockSpan));
    mockChildSpans.length = 0;
    for (const key of Object.keys(mockSpan)) {
      (mockSpan as any)[key].mockReset?.();
    }
  });

  function makeToolCallMessage() {
    return new AIMessage({
      content: '',
      tool_calls: [{ id: 'tc_1', name: 'myTool', args: {} }],
      usage_metadata: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    });
  }

  it('throws after MAX_STEPS (10) consecutive tool-call responses in invoke', async () => {
    const toolFn = vi.fn().mockReturnValue('result');
    const toolMsg = makeToolCallMessage();
    const invoke = vi.fn().mockResolvedValue(toolMsg);
    const llm = { invoke, bindTools: vi.fn().mockReturnThis() };

    const cfg = { ...baseConfig, tools: { myTool: { name: 'myTool', type: 'function' as const, parameters: {} } } };
    await expect(createLangChainHandler(llm as any)(cfg as any, 'q', { myTool: toolFn })).rejects.toThrow(
      /maximum number of steps/,
    );
    // 11 calls: 10 tool loops + 1 that hits the cap check
    expect(invoke).toHaveBeenCalledTimes(11);
  });

  it('does not throw when exactly MAX_STEPS tool calls are followed by a final response in invoke', async () => {
    const toolFn = vi.fn().mockReturnValue('result');
    const toolMsg = makeToolCallMessage();
    const finalMsg = new AIMessage({
      content: 'Done',
      usage_metadata: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    });
    const invoke = vi.fn();
    for (let i = 0; i < 10; i++) invoke.mockResolvedValueOnce(toolMsg);
    invoke.mockResolvedValueOnce(finalMsg);
    const llm = { invoke, bindTools: vi.fn().mockReturnThis() };

    const cfg = { ...baseConfig, tools: { myTool: { name: 'myTool', type: 'function' as const, parameters: {} } } };
    const result = await createLangChainHandler(llm as any)(cfg as any, 'q', { myTool: toolFn });
    expect(result.output).toBe('Done');
  });

  it('throws after MAX_STEPS (10) consecutive tool-call chunks in stream', async () => {
    const toolFn = vi.fn().mockReturnValue('result');
    const toolChunk = new AIMessage({
      content: '',
      tool_calls: [{ id: 'tc_1', name: 'myTool', args: {} }],
      usage_metadata: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    });

    const streamFn = vi.fn().mockImplementation(() =>
      (async function* () {
        yield toolChunk;
      })(),
    );
    const llm = { invoke: vi.fn(), stream: streamFn, bindTools: vi.fn().mockReturnThis() };

    const cfg = { ...baseConfig, tools: { myTool: { name: 'myTool', type: 'function' as const, parameters: {} } } };
    const collectStream = async (gen: AsyncGenerator<any>) => {
      const out: any[] = [];
      for await (const e of gen) out.push(e);
      return out;
    };
    await expect(
      collectStream(createLangChainHandler(llm as any).stream?.(cfg as any, 'q', { myTool: toolFn }, {})),
    ).rejects.toThrow(/maximum number of steps/);
  });
});
