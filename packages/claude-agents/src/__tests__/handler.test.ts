import { SpanStatusCode } from '@opentelemetry/api';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockQuery = vi.fn();
const mockTool = vi.fn().mockReturnValue({});
const mockCreateSdkMcpServer = vi.fn().mockReturnValue({});
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

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (...args: any[]) => mockQuery(...args),
  tool: (...args: any[]) => mockTool(...args),
  createSdkMcpServer: (...args: any[]) => mockCreateSdkMcpServer(...args),
}));

vi.mock('@opentelemetry/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@opentelemetry/api')>();
  return {
    ...actual,
    trace: {
      ...actual.trace,
      getTracer: vi.fn().mockReturnValue({
        startActiveSpan: vi.fn().mockImplementation((_name: string, fn: Function) => fn(mockSpan)),
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

import { NATIVE_TOOL_KEY, NativeTool } from '@launchdarkly/ai-server';
import { buildPrompt, buildToolMCP, createClaudeAgentsHandler, partitionTools } from '../handler.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeResultMessage(result = 'agent output', usage = { input_tokens: 10, output_tokens: 5 }) {
  return async function* () {
    yield { type: 'result', subtype: 'success', result, usage };
  };
}

const baseConfig = {
  model: { name: 'claude-opus-4-5' },
  provider: { name: 'Anthropic' },
  instructions: 'You are helpful.',
};

// ─── buildPrompt ──────────────────────────────────────────────────────────────

describe('buildPrompt', () => {
  it('uses instructions as systemPrompt and userInput as prompt', () => {
    const { prompt, systemPrompt } = buildPrompt({ ...baseConfig, instructions: 'Be helpful.' } as any, 'hi', {});
    expect(systemPrompt).toBe('Be helpful.');
    expect(prompt).toBe('hi');
  });

  it('substitutes variables in instructions', () => {
    const { systemPrompt } = buildPrompt({ ...baseConfig, instructions: 'Hello {{name}}.' } as any, 'q', {
      name: 'Eve',
    });
    expect(systemPrompt).toBe('Hello Eve.');
  });

  it('leaves unresolved placeholders as-is', () => {
    const { systemPrompt } = buildPrompt({ ...baseConfig, instructions: 'Hello {{missing}}.' } as any, 'q', {});
    expect(systemPrompt).toBe('Hello {{missing}}.');
  });

  it('prefers instructions over messages for the system prompt', () => {
    const config = {
      model: { name: 'claude-opus-4-5' },
      provider: { name: 'Anthropic' },
      instructions: 'From instructions.',
      messages: [{ role: 'system', content: 'From messages.' }],
    };
    const { systemPrompt } = buildPrompt(config as any, 'q', {});
    expect(systemPrompt).toBe('From instructions.');
  });

  it('builds prompt from messages when instructions absent', () => {
    const config = {
      model: { name: 'claude-opus-4-5' },
      provider: { name: 'Anthropic' },
      messages: [
        { role: 'system', content: 'Be concise.' },
        { role: 'user', content: 'Old message' },
      ],
    };
    const { prompt, systemPrompt } = buildPrompt(config as any, 'new input', {});
    expect(systemPrompt).toBe('Be concise.');
    expect(prompt).toContain('Old message');
    expect(prompt).toContain('new input');
  });

  it('returns only prompt when neither instructions nor messages present', () => {
    const config = { model: { name: 'claude-opus-4-5' }, provider: { name: 'Anthropic' } };
    const { prompt, systemPrompt } = buildPrompt(config as any, 'just input', {});
    expect(prompt).toBe('just input');
    expect(systemPrompt).toBeUndefined();
  });
});

// ─── partitionTools ───────────────────────────────────────────────────────────

describe('partitionTools', () => {
  it('routes NativeTool stubs to nativeToolMap', () => {
    const native = new NativeTool(Symbol('n'), 'WebSearch');
    const stub = () => {};
    (stub as any)[NATIVE_TOOL_KEY] = native;
    const { nativeToolMap, nativeToolNames } = partitionTools({}, { webSearch: stub });
    expect(nativeToolMap.has('WebSearch')).toBe(true);
    expect(nativeToolNames).toContain('WebSearch');
  });

  it('routes user-defined tool handlers to userConfigTools', () => {
    const configTools = {
      search: { name: 'search', type: 'function' as const, parameters: {} },
    };
    const fn = vi.fn();
    const { userConfigTools } = partitionTools(configTools, { search: fn });
    expect(userConfigTools).toHaveProperty('search');
  });
});

// ─── createClaudeAgentsHandler ────────────────────────────────────────────────

describe('createClaudeAgentsHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockChildSpans.length = 0;
    for (const key of Object.keys(mockSpan)) {
      (mockSpan as any)[key].mockReset?.();
    }
  });

  // ── 1.1 Factory and metadata ────────────────────────────────────────────────

  it('returns a callable function', () => {
    expect(typeof createClaudeAgentsHandler()).toBe('function');
  });

  it('attaches providesFor = ["Anthropic", "agent"]', () => {
    expect(createClaudeAgentsHandler().providesFor).toEqual(['Anthropic', 'agent']);
  });

  it('returns independent instances on multiple calls', () => {
    expect(createClaudeAgentsHandler()).not.toBe(createClaudeAgentsHandler());
  });

  // ── 1.2 & 1.4 Prompt construction and agentic loop ─────────────────────────

  it('passes systemPrompt and model name to query', async () => {
    mockQuery.mockImplementation(makeResultMessage());
    await createClaudeAgentsHandler()(baseConfig as any, 'hello');
    const { options } = mockQuery.mock.calls[0][0];
    expect(options.systemPrompt).toBe('You are helpful.');
    expect(options.model).toBe('claude-opus-4-5');
  });

  it('returns the result from the query generator', async () => {
    mockQuery.mockImplementation(makeResultMessage('final answer'));
    const result = await createClaudeAgentsHandler()(baseConfig as any, 'q');
    expect(result.output).toBe('final answer');
  });

  // ── 1.3 Tool wiring ─────────────────────────────────────────────────────────

  it('builds MCP server when config.tools has user-defined tools', async () => {
    mockQuery.mockImplementation(makeResultMessage());
    const config = {
      ...baseConfig,
      tools: { search: { name: 'search', type: 'function' as const, parameters: { type: 'object', properties: {} } } },
    };
    await createClaudeAgentsHandler()(config as any, 'q', { search: vi.fn() });
    expect(mockCreateSdkMcpServer).toHaveBeenCalled();
  });

  it('does not build MCP server when config.tools is absent', async () => {
    mockQuery.mockImplementation(makeResultMessage());
    await createClaudeAgentsHandler()(baseConfig as any, 'q');
    expect(mockCreateSdkMcpServer).not.toHaveBeenCalled();
  });

  // ── 1.5 Telemetry ───────────────────────────────────────────────────────────

  it('sets gen_ai span attributes on the invoke_agent root', async () => {
    mockQuery.mockImplementation(makeResultMessage('ok', { input_tokens: 8, output_tokens: 4 }));
    await createClaudeAgentsHandler()(baseConfig as any, 'q');
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('gen_ai.operation.name', 'invoke_agent');
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('gen_ai.system', 'anthropic');
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('gen_ai.provider.name', 'anthropic');
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('gen_ai.request.model', 'claude-opus-4-5');
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('gen_ai.response.model', 'claude-opus-4-5');
    // The agent SDK reports usage cumulatively on the result message, which is what the root wants.
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('gen_ai.usage.input_tokens', 8);
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('gen_ai.usage.output_tokens', 4);
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('gen_ai.usage.total_tokens', 12);
    // `chat` belongs to the per-response children, never to the root.
    expect(mockSpan.setAttribute).not.toHaveBeenCalledWith('gen_ai.operation.name', 'chat');
  });

  // The CLI's own instrumentation emits span names outside the semantic conventions
  // (`claude_code.llm_request`, `claude_code.tool`, `claude_code.tool.blocked_on_user`), so
  // enabling it would make this handler's traces read differently from the other five and from
  // any non-LaunchDarkly OTel backend. `env` must also stay absent entirely, so the child keeps
  // the SDK's own inheritance instead of a bag assembled here.
  it('never enables the CLI own telemetry exporter', async () => {
    mockQuery.mockImplementation(makeResultMessage('ok', { input_tokens: 1, output_tokens: 1 }));
    await createClaudeAgentsHandler()(baseConfig as any, 'q');

    const { options } = mockQuery.mock.calls[0][0];
    expect('env' in options).toBe(false);
    expect(JSON.stringify(options)).not.toContain('CLAUDE_CODE');
  });

  it('includes cache tokens in input usage and preserves the provider breakdown', async () => {
    const rawUsage = {
      input_tokens: 4,
      output_tokens: 5,
      cache_read_input_tokens: 100,
      cache_creation_input_tokens: 20,
    };
    mockQuery.mockImplementation(makeResultMessage('ok', rawUsage));

    const result = await createClaudeAgentsHandler()(baseConfig as any, 'q');

    // Cumulative run usage, so asserted on the root.
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('gen_ai.usage.input_tokens', 124);
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('gen_ai.usage.output_tokens', 5);
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('gen_ai.usage.total_tokens', 129);
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('gen_ai.usage.cache_read.input_tokens', 100);
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('gen_ai.usage.cache_creation.input_tokens', 20);
    expect(result.usage).toEqual(rawUsage);
  });

  // ── LaunchDarkly correlation ────────────────────────────────────────────────
  //
  // The `feature_flag` span event is how the AI Config Monitoring tab locates a trace:
  //   events.name = feature_flag
  //   AND events.attributes.feature_flag.key = <configKey>
  // It must be on the root, because the root is the span that query finds. Losing it, or
  // emitting it on a child instead, silently detaches every trace from its AI Config —
  // with no error and no failing assertion anywhere else in this suite.

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
    mockQuery.mockImplementation(makeResultMessage('ok', { input_tokens: 1, output_tokens: 1 }));
    await createClaudeAgentsHandler()(baseConfig as any, 'q', {}, ldFixture);

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
    mockQuery.mockImplementation(makeResultMessage('ok', { input_tokens: 1, output_tokens: 1 }));
    await createClaudeAgentsHandler()(baseConfig as any, 'q', {}, ldFixture);

    const childEvents = mockChildSpans.flatMap(({ span }) => span.addEvent.mock.calls.map((c: unknown[]) => c[0]));
    expect(childEvents).not.toContain('feature_flag');
  });

  it('emits the feature_flag event on the root of the streaming path too', async () => {
    mockQuery.mockImplementation(makeResultMessage('ok', { input_tokens: 1, output_tokens: 1 }));
    await collectStream(createClaudeAgentsHandler().stream?.(baseConfig as any, 'q', {}, ldFixture));

    expect(mockSpan.addEvent).toHaveBeenCalledWith(
      'feature_flag',
      expect.objectContaining({ 'feature_flag.key': 'test-config' }),
    );
  });

  it('uses an agent root and starts no per-call span of its own', async () => {
    const { trace } = await import('@opentelemetry/api');
    mockQuery.mockImplementation(makeResultMessage());
    await createClaudeAgentsHandler()(baseConfig as any, 'q');
    expect((trace.getTracer as any)().startActiveSpan).toHaveBeenCalledWith('invoke_agent', expect.any(Function));
    // No `startSpan` at all on a tool-less run: the only spans this handler starts directly are
    // `execute_tool` ones from hooks.
    expect((trace.getTracer as any)().startSpan).not.toHaveBeenCalled();
  });

  it('creates tool-execution child spans for an agent loop, and nothing else', async () => {
    mockQuery.mockImplementation(async function* ({ options }: any) {
      yield {
        type: 'assistant',
        message: { usage: { input_tokens: 10, output_tokens: 2 }, content: [] },
      };
      await options.hooks.PreToolUse[0].hooks[0]({
        hook_event_name: 'PreToolUse',
        tool_name: 'mcp__tool-mcp__search',
        tool_use_id: 'tool-1',
        tool_input: { query: 'x' },
      });
      await options.hooks.PostToolUse[0].hooks[0]({
        hook_event_name: 'PostToolUse',
        tool_name: 'mcp__tool-mcp__search',
        tool_use_id: 'tool-1',
        tool_input: { query: 'x' },
        tool_response: { ok: true },
      });
      yield {
        type: 'assistant',
        message: { usage: { input_tokens: 12, output_tokens: 3 }, content: [] },
      };
      yield { type: 'result', subtype: 'success', result: 'done', usage: { input_tokens: 22, output_tokens: 5 } };
    });
    const config = {
      ...baseConfig,
      tools: { search: { name: 'search', type: 'function' as const, parameters: { type: 'object', properties: {} } } },
    };

    await createClaudeAgentsHandler()(config as any, 'q', { search: vi.fn() });

    const toolSpan = mockChildSpans.find(({ name }) => name === 'execute_tool search')?.span;
    // Two model responses and one tool call, so two `chat` spans and one `execute_tool`. Sorted
    // because `chat` spans are created when the run flushes rather than as each message arrives —
    // their start and end timestamps are explicit, so creation order is not chronological order.
    expect(mockChildSpans.map(({ name }) => name).sort()).toEqual([
      'chat claude-opus-4-5',
      'chat claude-opus-4-5',
      'execute_tool search',
    ]);
    expect(toolSpan?.setAttribute).toHaveBeenCalledWith('gen_ai.operation.name', 'execute_tool');
    expect(toolSpan?.setAttribute).toHaveBeenCalledWith('gen_ai.tool.name', 'search');
    expect(toolSpan?.setAttribute).toHaveBeenCalledWith('gen_ai.tool.call.id', 'tool-1');
    expect(toolSpan?.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.OK });
    expect(toolSpan?.end).toHaveBeenCalledOnce();
  });

  it('emits no content at all by default', async () => {
    mockQuery.mockImplementation(makeResultMessage('done'));
    await createClaudeAgentsHandler()(baseConfig as any, 'question');

    // Conversation content is PII, so a caller has to ask for it. Asserting on the recorded
    // arguments rather than on specific keys catches a new content attribute added without a gate.
    const written = JSON.stringify(mockSpan.setAttribute.mock.calls);
    expect(written).not.toContain('question');
    expect(mockSpan.addEvent).not.toHaveBeenCalledWith('gen_ai.content.prompt', expect.anything());
  });

  it('puts prompt and completion on span attributes when capture is enabled', async () => {
    mockQuery.mockImplementation(makeResultMessage('done'));
    await createClaudeAgentsHandler({ captureContent: true })(baseConfig as any, 'question');

    // Attributes are what LaunchDarkly's readers parse, and OTEP 4430 deprecated event-recorded
    // content — but the events are still emitted alongside them, because every published version of
    // this handler has emitted them and dropping them would break a consumer silently.
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('gen_ai.prompt.1.content', 'question');
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('gen_ai.completion.0.content', 'done');
    expect(mockSpan.addEvent).toHaveBeenCalledWith('gen_ai.content.prompt', expect.anything());
    expect(mockSpan.addEvent).toHaveBeenCalledWith('gen_ai.content.completion', expect.anything());
  });

  it('sets OK status and ends span on success', async () => {
    mockQuery.mockImplementation(makeResultMessage());
    await createClaudeAgentsHandler()(baseConfig as any, 'q');
    expect(mockSpan.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.OK });
    expect(mockSpan.end).toHaveBeenCalled();
  });

  // ── 1.6 Error handling ──────────────────────────────────────────────────────

  it('records exception, sets ERROR status, ends span, and re-throws', async () => {
    const err = new Error('agent SDK failure');
    mockQuery.mockImplementation(async function* () {
      throw err;
    });
    await expect(createClaudeAgentsHandler()(baseConfig as any, 'q')).rejects.toThrow('agent SDK failure');
    expect(mockSpan.recordException).toHaveBeenCalledWith(err);
    expect(mockSpan.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.ERROR, message: 'agent SDK failure' });
    expect(mockSpan.end).toHaveBeenCalled();
  });

  // ── 1.7 Convenience export ──────────────────────────────────────────────────

  it('claudeAgents calls config() with the correct handler', async () => {
    const { claudeAgents } = await import('../handler.js');
    const { config } = await import('@launchdarkly/ai-server');
    const ctx = { kind: 'user' as const, key: 'u' };
    await claudeAgents('flag', 'hello', ctx, {} as any);
    expect(config).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'flag',
        handler: expect.objectContaining({ providesFor: ['Anthropic', 'agent'] }),
      }),
    );
  });

  it('claudeAgents passes userInput and context to config().invoke()', async () => {
    const { claudeAgents } = await import('../handler.js');
    const { config } = await import('@launchdarkly/ai-server');
    const invokeMock = vi.fn().mockResolvedValue({ response: 'ok', usage: {} });
    vi.mocked(config).mockReturnValue({ invoke: invokeMock } as any);
    const ctx = { kind: 'user' as const, key: 'u' };
    await claudeAgents('flag', 'hello', ctx, {} as any);
    expect(invokeMock).toHaveBeenCalledWith('hello', ctx, undefined);
  });

  // ── 1.8 Streaming ────────────────────────────────────────────────────────────

  async function collectStream<T>(gen: AsyncGenerator<T>): Promise<T[]> {
    const out: T[] = [];
    for await (const e of gen) out.push(e);
    return out;
  }

  it('handler.stream is defined', () => {
    const handler = createClaudeAgentsHandler();
    expect(typeof handler.stream).toBe('function');
  });

  it('yields chunk events from stream_event text_delta messages', async () => {
    mockQuery.mockImplementation(async function* () {
      yield {
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } },
      };
      yield {
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: ' world' } },
      };
      yield {
        type: 'result',
        subtype: 'success',
        result: 'Hello world',
        usage: { input_tokens: 10, output_tokens: 5 },
      };
    });
    const handler = createClaudeAgentsHandler();
    const events = await collectStream(handler.stream?.(baseConfig as any, 'q', {}, {}));
    const chunks = events.filter((e: any) => e.type === 'chunk').map((e: any) => e.text);
    expect(chunks).toEqual(['Hello', ' world']);
  });

  it('yields a done event when result message arrives', async () => {
    mockQuery.mockImplementation(async function* () {
      yield {
        type: 'result',
        subtype: 'success',
        result: 'Final answer',
        usage: { input_tokens: 5, output_tokens: 3 },
      };
    });
    const handler = createClaudeAgentsHandler();
    const events = await collectStream(handler.stream?.(baseConfig as any, 'q', {}, {}));
    const done = events.at(-1) as any;
    expect(done.type).toBe('done');
    expect(done.output).toBe('Final answer');
  });

  it('sets span attributes and puts content on attributes when enabled', async () => {
    mockQuery.mockImplementation(async function* () {
      yield { type: 'result', subtype: 'success', result: 'ok', usage: { input_tokens: 2, output_tokens: 1 } };
    });
    await collectStream(createClaudeAgentsHandler({ captureContent: true }).stream?.(baseConfig as any, 'q', {}, {}));
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('gen_ai.system', 'anthropic');
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('gen_ai.prompt.1.content', 'q');
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('gen_ai.completion.0.content', 'ok');
    expect(mockSpan.addEvent).toHaveBeenCalledWith('gen_ai.content.completion', expect.anything());
    expect(mockSpan.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.OK });
    expect(mockSpan.end).toHaveBeenCalled();
  });

  it('includes cache tokens in streaming input usage', async () => {
    mockQuery.mockImplementation(async function* () {
      yield {
        type: 'result',
        subtype: 'success',
        result: 'ok',
        usage: {
          input_tokens: 3,
          output_tokens: 2,
          cache_read_input_tokens: 40,
          cache_creation_input_tokens: 7,
        },
      };
    });

    const events = await collectStream(createClaudeAgentsHandler().stream?.(baseConfig as any, 'q', {}, {}));

    // Cumulative run usage, so asserted on the root.
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('gen_ai.usage.input_tokens', 50);
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('gen_ai.usage.total_tokens', 52);
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('gen_ai.usage.cache_read.input_tokens', 40);
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('gen_ai.usage.cache_creation.input_tokens', 7);
    expect((events.at(-1) as any).usage).toMatchObject({
      input_tokens: 3,
      cache_read_input_tokens: 40,
      cache_creation_input_tokens: 7,
    });
  });

  it('records exception on error', async () => {
    const err = new Error('query stream error');
    mockQuery.mockImplementation(async function* () {
      throw err;
    });
    await expect(collectStream(createClaudeAgentsHandler().stream?.(baseConfig as any, 'q', {}, {}))).rejects.toThrow(
      'query stream error',
    );
    expect(mockSpan.recordException).toHaveBeenCalledWith(err);
    expect(mockSpan.setStatus).toHaveBeenCalledWith(expect.objectContaining({ code: SpanStatusCode.ERROR }));
  });

  // ── History ──────────────────────────────────────────────────────────────────

  const sampleHistory = [
    { role: 'user' as const, content: 'What is feature flagging?' },
    { role: 'assistant' as const, content: 'Feature flagging is a technique...' },
  ];

  it('history is appended to system prompt (via buildPrompt)', () => {
    const { systemPrompt } = buildPrompt(baseConfig as any, 'q', {}, sampleHistory);
    expect(systemPrompt).toContain('You are helpful.');
    expect(systemPrompt).toContain('Conversation History:');
  });

  it('history format is correct', () => {
    const { systemPrompt } = buildPrompt(baseConfig as any, 'q', {}, sampleHistory);
    expect(systemPrompt).toContain('user: What is feature flagging?');
    expect(systemPrompt).toContain('assistant: Feature flagging is a technique...');
  });

  it('empty history is treated like no history', () => {
    const { systemPrompt } = buildPrompt(baseConfig as any, 'q', {}, []);
    expect(systemPrompt).not.toContain('Conversation History:');
    expect(systemPrompt).toBe('You are helpful.');
  });

  it('history without prior system prompt', () => {
    const config = { model: { name: 'claude-opus-4-5' }, provider: { name: 'Anthropic' } };
    const { systemPrompt } = buildPrompt(config as any, 'q', {}, sampleHistory);
    expect(systemPrompt).toContain('Conversation History:');
    expect(systemPrompt).toContain('user: What is feature flagging?');
    expect(systemPrompt).toContain('assistant: Feature flagging is a technique...');
  });

  it('history is passed through to query when calling the handler', async () => {
    mockQuery.mockImplementation(makeResultMessage());
    await createClaudeAgentsHandler()(baseConfig as any, 'q', {}, {}, sampleHistory);
    const { options } = mockQuery.mock.calls[0][0];
    expect(options.systemPrompt).toContain('Conversation History:');
    expect(options.systemPrompt).toContain('user: What is feature flagging?');
  });
});

// ─── buildToolMCP ─────────────────────────────────────────────────────────────

describe('buildToolMCP', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('throws a descriptive error when no handler is registered for a tool', async () => {
    const configTools = {
      search: { name: 'search', type: 'function' as const, parameters: { type: 'object', properties: {} } },
    };
    await buildToolMCP(configTools, {});
    const toolCall = mockTool.mock.calls[0];
    const execute = toolCall[3] as (...args: unknown[]) => Promise<unknown>;
    await expect(execute({ query: 'x' })).rejects.toThrow(/search/i);
  });

  // T1: multiple tools
  it('registers all tools when config.tools has multiple entries', async () => {
    const configTools = {
      search: { name: 'search', type: 'function' as const, parameters: { type: 'object', properties: {} } },
      summarize: { name: 'summarize', type: 'function' as const, parameters: { type: 'object', properties: {} } },
      translate: { name: 'translate', type: 'function' as const, parameters: { type: 'object', properties: {} } },
    };
    await buildToolMCP(configTools, { search: vi.fn(), summarize: vi.fn(), translate: vi.fn() });
    expect(mockTool).toHaveBeenCalledTimes(3);
    const registeredNames = mockTool.mock.calls.map((c: any[]) => c[0]);
    expect(registeredNames).toContain('search');
    expect(registeredNames).toContain('summarize');
    expect(registeredNames).toContain('translate');
  });

  // T2: tool handler throws
  it('propagates errors thrown by a tool handler', async () => {
    const configTools = {
      search: { name: 'search', type: 'function' as const, parameters: { type: 'object', properties: {} } },
    };
    const throwingHandler = vi.fn().mockRejectedValue(new Error('tool exploded'));
    await buildToolMCP(configTools, { search: throwingHandler });
    const execute = mockTool.mock.calls[0][3] as (...args: unknown[]) => Promise<unknown>;
    await expect(execute({ query: 'x' })).rejects.toThrow('tool exploded');
  });
});

// ─── streaming additional coverage ────────────────────────────────────────────

describe('streaming additional coverage', () => {
  async function collectStream<T>(gen: AsyncGenerator<T>): Promise<T[]> {
    const out: T[] = [];
    for await (const e of gen) out.push(e);
    return out;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockChildSpans.length = 0;
    for (const key of Object.keys(mockSpan)) {
      (mockSpan as any)[key].mockReset?.();
    }
  });

  // T3: done event carries usage from provider
  it('done event carries the provider usage tokens', async () => {
    mockQuery.mockImplementation(async function* () {
      yield { type: 'result', subtype: 'success', result: 'answer', usage: { input_tokens: 7, output_tokens: 3 } };
    });
    const events = await collectStream(createClaudeAgentsHandler().stream?.(baseConfig as any, 'q', {}, {}));
    const done = events.at(-1) as any;
    expect(done.type).toBe('done');
    expect(done.usage).toMatchObject({ input_tokens: 7, output_tokens: 3 });
  });

  // T4: no chunk events appear after the done event
  it('yields no chunk events after the done event', async () => {
    mockQuery.mockImplementation(async function* () {
      yield {
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } },
      };
      yield { type: 'result', subtype: 'success', result: 'Hello', usage: { input_tokens: 3, output_tokens: 2 } };
    });
    const events = await collectStream(createClaudeAgentsHandler().stream?.(baseConfig as any, 'q', {}, {}));
    const doneIdx = events.findIndex((e: any) => e.type === 'done');
    const chunksAfterDone = events.slice(doneIdx + 1).filter((e: any) => e.type === 'chunk');
    expect(chunksAfterDone).toHaveLength(0);
  });
});

// ── §1.9 outputFormat — best-effort (system prompt injection) ─────────────────

describe('createClaudeAgentsHandler — outputFormat (§1.9)', () => {
  const outputFormat = { type: 'object', properties: { result: { type: 'string' } } };

  beforeEach(() => {
    vi.clearAllMocks();
    mockChildSpans.length = 0;
    for (const key of Object.keys(mockSpan)) {
      (mockSpan as any)[key].mockReset?.();
    }
  });

  it('appends JSON schema instruction to systemPrompt when outputFormat is set', async () => {
    mockQuery.mockImplementation(async function* () {
      yield { type: 'result', subtype: 'success', result: 'ok', usage: { input_tokens: 1, output_tokens: 1 } };
    });
    const config = { ...baseConfig, outputFormat };
    await createClaudeAgentsHandler()(config as any, 'hello');
    const callArgs = mockQuery.mock.calls[0][0];
    expect(callArgs.options.systemPrompt).toContain('You are helpful.');
    expect(callArgs.options.systemPrompt).toContain(JSON.stringify(outputFormat));
  });

  it('does not inject schema instruction when outputFormat is absent', async () => {
    mockQuery.mockImplementation(async function* () {
      yield { type: 'result', subtype: 'success', result: 'ok', usage: { input_tokens: 1, output_tokens: 1 } };
    });
    await createClaudeAgentsHandler()(baseConfig as any, 'hello');
    const callArgs = mockQuery.mock.calls[0][0];
    expect(callArgs.options.systemPrompt).toBe('You are helpful.');
    expect(callArgs.options.systemPrompt).not.toContain('"type":"object"');
  });
});
