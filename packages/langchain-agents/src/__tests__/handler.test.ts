import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { SpanStatusCode } from '@opentelemetry/api';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockCreateAgent = vi.fn();
// Captures (executorFn, opts) — executor is accessible via mock.calls[N][0]
const mockLangchainTool = vi.fn().mockImplementation((_fn, opts) => ({ ...opts }));

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

vi.mock('langchain', () => ({
  createAgent: (...args: any[]) => mockCreateAgent(...args),
}));

vi.mock('@langchain/core/tools', () => ({
  tool: (...args: any[]) => mockLangchainTool(...args),
}));

vi.mock('@langchain/openai', () => ({
  ChatOpenAI: class {},
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

import { createLangChainAgentsHandler } from '../handler.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeMockAgent(outputText = 'agent answer', inputTokens = 10, outputTokens = 5) {
  return {
    invoke: vi.fn().mockResolvedValue({
      messages: [
        new AIMessage({
          content: outputText,
          usage_metadata: {
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            total_tokens: inputTokens + outputTokens,
          },
        }),
      ],
    }),
  };
}

/**
 * A mock agent whose invoke() drives the LangChain callback lifecycle the way the real ReAct agent
 * would: model turn 1 → (optional) tool call → model turn 2. Lets us assert the emitted span tree.
 */
function makeCallbackAgent({
  output = 'agent answer',
  inputTokens = 8,
  outputTokens = 4,
  tool,
}: {
  output?: string;
  inputTokens?: number;
  outputTokens?: number;
  tool?: string;
} = {}) {
  const llmEnd = (input: number, out: number, details?: Record<string, unknown>) => ({
    generations: [[{ message: { usage_metadata: { input_tokens: input, output_tokens: out, ...(details ?? {}) } } }]],
  });
  return {
    invoke: vi.fn().mockImplementation(async (_input: unknown, cfg: any) => {
      const cb = cfg?.callbacks?.[0];
      cb?.handleChatModelStart?.({}, [], 'run-model-1');
      if (tool) {
        cb?.handleLLMEnd?.(llmEnd(inputTokens, outputTokens), 'run-model-1');
        cb?.handleToolStart?.({ name: tool }, '{}', 'run-tool-1', undefined, undefined, undefined, tool, 'call_1');
        cb?.handleToolEnd?.('tool result', 'run-tool-1');
        cb?.handleChatModelStart?.({}, [], 'run-model-2');
        cb?.handleLLMEnd?.(llmEnd(2, 2), 'run-model-2');
      } else {
        cb?.handleLLMEnd?.(llmEnd(inputTokens, outputTokens), 'run-model-1');
      }
      return {
        messages: [
          new AIMessage({
            content: output,
            usage_metadata: {
              input_tokens: inputTokens,
              output_tokens: outputTokens,
              total_tokens: inputTokens + outputTokens,
            },
          }),
        ],
      };
    }),
  };
}

const baseConfig = {
  model: { name: 'gpt-4o' },
  provider: { name: 'LangChain' },
  instructions: 'You are helpful.',
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('createLangChainAgentsHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockChildSpans.length = 0;
    for (const key of Object.keys(mockSpan)) {
      (mockSpan as any)[key].mockReset?.();
    }
  });

  // ── 1.1 Factory and metadata ────────────────────────────────────────────────

  it('returns a callable function', () => {
    const agent = makeMockAgent();
    mockCreateAgent.mockReturnValue(agent);
    expect(typeof createLangChainAgentsHandler({} as any)).toBe('function');
  });

  it('attaches providesFor = ["*", "agent"]', () => {
    expect(createLangChainAgentsHandler({} as any).providesFor).toEqual(['*', 'agent']);
  });

  it('returns independent instances on multiple calls', () => {
    const llm = {} as any;
    expect(createLangChainAgentsHandler(llm)).not.toBe(createLangChainAgentsHandler(llm));
  });

  // ── 1.2 Prompt construction ─────────────────────────────────────────────────

  it('passes instructions as systemPrompt to createAgent', async () => {
    const agent = makeMockAgent();
    mockCreateAgent.mockReturnValue(agent);
    await createLangChainAgentsHandler({} as any)(baseConfig as any, 'hi');
    expect(mockCreateAgent).toHaveBeenCalledWith(expect.objectContaining({ systemPrompt: 'You are helpful.' }));
  });

  it('substitutes variables in instructions', async () => {
    const agent = makeMockAgent();
    mockCreateAgent.mockReturnValue(agent);
    const config = { ...baseConfig, instructions: 'Hello {{name}}.' };
    await createLangChainAgentsHandler({} as any)(config as any, 'q', {}, { name: 'Frank' });
    expect(mockCreateAgent).toHaveBeenCalledWith(expect.objectContaining({ systemPrompt: 'Hello Frank.' }));
  });

  it('extracts system prompt from messages when instructions absent', async () => {
    const agent = makeMockAgent();
    mockCreateAgent.mockReturnValue(agent);
    const config = {
      model: { name: 'gpt-4o' },
      provider: { name: 'LangChain' },
      messages: [{ role: 'system', content: 'Be concise.' }],
    };
    await createLangChainAgentsHandler({} as any)(config as any, 'q');
    expect(mockCreateAgent).toHaveBeenCalledWith(expect.objectContaining({ systemPrompt: 'Be concise.' }));
  });

  it('includes user input as the final HumanMessage passed to agent.invoke', async () => {
    const agent = makeMockAgent();
    mockCreateAgent.mockReturnValue(agent);
    await createLangChainAgentsHandler({} as any)(baseConfig as any, 'my question');
    const { messages } = agent.invoke.mock.calls[0][0];
    const last = messages[messages.length - 1];
    expect(last instanceof HumanMessage).toBe(true);
    expect(last.content).toBe('my question');
  });

  // ── 1.3 Tool conversion ─────────────────────────────────────────────────────

  it('builds agent tools when config.tools is present', async () => {
    const agent = makeMockAgent();
    mockCreateAgent.mockReturnValue(agent);
    const config = {
      ...baseConfig,
      tools: {
        search: { name: 'search', type: 'function' as const, parameters: { type: 'object' }, description: 'Search' },
      },
    };
    await createLangChainAgentsHandler({} as any)(config as any, 'q', { search: vi.fn() });
    expect(mockLangchainTool).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({ name: 'search' }));
    const agentArgs = mockCreateAgent.mock.calls[0][0];
    expect(agentArgs.tools).toHaveLength(1);
  });

  it('passes empty tools array when config.tools is absent', async () => {
    const agent = makeMockAgent();
    mockCreateAgent.mockReturnValue(agent);
    await createLangChainAgentsHandler({} as any)(baseConfig as any, 'q');
    const agentArgs = mockCreateAgent.mock.calls[0][0];
    expect(agentArgs.tools).toHaveLength(0);
  });

  it('filters out config.tools entries that have no matching toolHandlers entry (§1.3)', async () => {
    const agent = makeMockAgent();
    mockCreateAgent.mockReturnValue(agent);
    const configWithTool = {
      ...baseConfig,
      tools: {
        'ghost-tool': {
          name: 'ghost-tool',
          type: 'function' as const,
          parameters: { type: 'object' },
          description: 'x',
        },
      },
    };
    // No handler provided for 'ghost-tool'
    await createLangChainAgentsHandler({} as any)(configWithTool as any, 'q', {});
    const toolCalls = (mockLangchainTool as ReturnType<typeof vi.fn>).mock.calls;
    const ghostCall = toolCalls.find((c: any[]) => c[1]?.name === 'ghost-tool');
    expect(ghostCall).toBeUndefined();
    const agentArgs = mockCreateAgent.mock.calls[0][0];
    expect(agentArgs.tools).toHaveLength(0);
  });

  it('only exposes tools that have a registered handler (§1.3)', async () => {
    const agent = makeMockAgent();
    mockCreateAgent.mockReturnValue(agent);
    const configWithTools = {
      ...baseConfig,
      tools: {
        registered: { name: 'registered', type: 'function' as const, parameters: { type: 'object' }, description: 'r' },
        missing: { name: 'missing', type: 'function' as const, parameters: { type: 'object' }, description: 'm' },
      },
    };
    const registeredFn = vi.fn().mockResolvedValue('result');
    await createLangChainAgentsHandler({} as any)(configWithTools as any, 'q', { registered: registeredFn });
    const toolCalls = (mockLangchainTool as ReturnType<typeof vi.fn>).mock.calls;
    const names = toolCalls.map((c: any[]) => c[1]?.name);
    expect(names).toContain('registered');
    expect(names).not.toContain('missing');
    const agentArgs = mockCreateAgent.mock.calls[0][0];
    expect(agentArgs.tools).toHaveLength(1);
  });

  // ── 1.5 Telemetry ───────────────────────────────────────────────────────────

  it('sets invoke_agent on the root and gen_ai usage on the chat model span', async () => {
    mockCreateAgent.mockReturnValue(makeCallbackAgent({ output: 'ok', inputTokens: 8, outputTokens: 4 }));
    await createLangChainAgentsHandler({} as any)(baseConfig as any, 'q');
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('gen_ai.operation.name', 'invoke_agent');
    const modelSpan = latestModelSpan();
    expect(modelSpan?.setAttribute).toHaveBeenCalledWith('gen_ai.system', 'langchain');
    expect(modelSpan?.setAttribute).toHaveBeenCalledWith('gen_ai.operation.name', 'chat');
    expect(modelSpan?.setAttribute).toHaveBeenCalledWith('gen_ai.request.model', 'gpt-4o');
    expect(modelSpan?.setAttribute).toHaveBeenCalledWith('gen_ai.usage.input_tokens', 8);
    expect(modelSpan?.setAttribute).toHaveBeenCalledWith('gen_ai.usage.output_tokens', 4);
    expect(modelSpan?.setAttribute).toHaveBeenCalledWith('gen_ai.usage.total_tokens', 12);
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
    mockCreateAgent.mockReturnValue(makeCallbackAgent({ output: 'ok', inputTokens: 1, outputTokens: 1 }));
    await createLangChainAgentsHandler({} as any)(baseConfig as any, 'q', {}, ldFixture);

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
    mockCreateAgent.mockReturnValue(makeCallbackAgent({ output: 'ok', inputTokens: 1, outputTokens: 1 }));
    await createLangChainAgentsHandler({} as any)(baseConfig as any, 'q', {}, ldFixture);

    const childEvents = mockChildSpans.flatMap(({ span }) => span.addEvent.mock.calls.map((c: unknown[]) => c[0]));
    expect(childEvents).not.toContain('feature_flag');
  });

  it('emits no content at all by default', async () => {
    mockCreateAgent.mockReturnValue(makeMockAgent('answer'));
    await createLangChainAgentsHandler({} as any)(baseConfig as any, 'question');

    // Conversation content is PII, so a caller has to ask for it. Asserting on the recorded
    // arguments rather than on specific keys catches a new content attribute added without a gate.
    const written = JSON.stringify(mockSpan.setAttribute.mock.calls);
    expect(written).not.toContain('question');
    expect(mockSpan.addEvent).not.toHaveBeenCalledWith('gen_ai.content.prompt', expect.anything());
  });

  it('puts prompt and completion on span attributes when capture is enabled', async () => {
    mockCreateAgent.mockReturnValue(makeMockAgent('answer'));
    await createLangChainAgentsHandler({} as any, { captureContent: true })(baseConfig as any, 'question');

    // Attributes, not events: OTEP 4430 deprecated event-recorded content and LaunchDarkly's
    // readers parse only attributes.
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('gen_ai.prompt.1.content', 'question');
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('gen_ai.completion.0.content', 'answer');
    expect(mockSpan.addEvent).toHaveBeenCalledWith('gen_ai.content.prompt', expect.anything());
  });

  it('sets OK status and ends span on success', async () => {
    mockCreateAgent.mockReturnValue(makeMockAgent());
    await createLangChainAgentsHandler({} as any)(baseConfig as any, 'q');
    expect(mockSpan.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.OK });
    expect(mockSpan.end).toHaveBeenCalled();
  });

  // ── 1.5b Span hierarchy (invoke_agent → chat → execute_tool) ─────────────────

  it('emits one chat child span per model turn under the invoke_agent root', async () => {
    mockCreateAgent.mockReturnValue(makeCallbackAgent({ tool: 'myTool' }));
    await createLangChainAgentsHandler({} as any)(baseConfig as any, 'q');

    const chats = modelSpans();
    expect(chats).toHaveLength(2);
    expect(chats.every(({ span }) => span.end.mock.calls.length === 1)).toBe(true);
    // `{operation} {request.model}`, per the semantic conventions for an inference span.
    expect(chats.every(({ name }) => name === `chat ${baseConfig.model.name}`)).toBe(true);
  });

  it('emits an execute_tool child span per tool call, keyed by tool_call id', async () => {
    mockCreateAgent.mockReturnValue(makeCallbackAgent({ tool: 'myTool' }));
    await createLangChainAgentsHandler({} as any)(baseConfig as any, 'q');

    const toolSpan = mockChildSpans.find(({ name }) => name === 'execute_tool myTool')?.span;
    expect(toolSpan?.setAttribute).toHaveBeenCalledWith('gen_ai.operation.name', 'execute_tool');
    expect(toolSpan?.setAttribute).toHaveBeenCalledWith('gen_ai.tool.name', 'myTool');
    expect(toolSpan?.setAttribute).toHaveBeenCalledWith('gen_ai.tool.call.id', 'call_1');
    expect(toolSpan?.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.OK });
    expect(toolSpan?.end).toHaveBeenCalledOnce();
  });

  it('surfaces LangChain cached tokens as cache_read without adding them to the input total', async () => {
    const agent = {
      invoke: vi.fn().mockImplementation(async (_input: unknown, cfg: any) => {
        const cb = cfg?.callbacks?.[0];
        cb?.handleChatModelStart?.({}, [], 'run-model-1');
        cb?.handleLLMEnd?.(
          {
            generations: [
              [
                {
                  message: {
                    usage_metadata: {
                      input_tokens: 50,
                      output_tokens: 5,
                      input_token_details: { cache_read: 30, cache_creation: 10 },
                    },
                  },
                },
              ],
            ],
          },
          'run-model-1',
        );
        return { messages: [new AIMessage({ content: 'hi' })] };
      }),
    };
    mockCreateAgent.mockReturnValue(agent);
    await createLangChainAgentsHandler({} as any)(baseConfig as any, 'q');

    const modelSpan = latestModelSpan();
    expect(modelSpan?.setAttribute).toHaveBeenCalledWith('gen_ai.usage.input_tokens', 50);
    expect(modelSpan?.setAttribute).toHaveBeenCalledWith('gen_ai.usage.cache_read.input_tokens', 30);
    expect(modelSpan?.setAttribute).toHaveBeenCalledWith('gen_ai.usage.cache_creation.input_tokens', 10);
  });

  it('fails open chat and tool spans when the agent run throws mid-flight', async () => {
    const err = new Error('agent boom');
    const agent = {
      invoke: vi.fn().mockImplementation(async (_input: unknown, cfg: any) => {
        const cb = cfg?.callbacks?.[0];
        cb?.handleChatModelStart?.({}, [], 'run-model-1');
        cb?.handleToolStart?.(
          { name: 'myTool' },
          '{}',
          'run-tool-1',
          undefined,
          undefined,
          undefined,
          'myTool',
          'call_1',
        );
        throw err; // crash before tool_end / llm_end — spans left open
      }),
    };
    mockCreateAgent.mockReturnValue(agent);
    await expect(createLangChainAgentsHandler({} as any)(baseConfig as any, 'q')).rejects.toThrow('agent boom');

    const chatSpan = latestModelSpan();
    const toolSpan = mockChildSpans.find(({ name }) => name === 'execute_tool myTool')?.span;
    expect(chatSpan?.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.ERROR, message: 'agent boom' });
    expect(chatSpan?.end).toHaveBeenCalledOnce();
    expect(toolSpan?.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.ERROR, message: 'agent boom' });
    expect(toolSpan?.end).toHaveBeenCalledOnce();
  });

  // ── 1.6 Error handling ──────────────────────────────────────────────────────

  it('records exception, sets ERROR status, ends span, and re-throws', async () => {
    const err = new Error('LangChain agent error');
    mockCreateAgent.mockReturnValue({ invoke: vi.fn().mockRejectedValue(err) });
    await expect(createLangChainAgentsHandler({} as any)(baseConfig as any, 'q')).rejects.toThrow(
      'LangChain agent error',
    );
    expect(mockSpan.recordException).toHaveBeenCalledWith(err);
    expect(mockSpan.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.ERROR, message: 'LangChain agent error' });
    expect(mockSpan.end).toHaveBeenCalled();
  });

  // ── 1.7 Convenience export ──────────────────────────────────────────────────

  it('langchainAgents calls config() with the correct handler', async () => {
    const { langchainAgents } = await import('../handler.js');
    const { config } = await import('@launchdarkly/ai-server');
    const ctx = { kind: 'user' as const, key: 'u' };
    await langchainAgents('flag', 'hello', ctx, {} as any);
    expect(config).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'flag',
        handler: expect.objectContaining({ providesFor: ['*', 'agent'] }),
      }),
    );
  });

  // ── 1.8 Streaming ────────────────────────────────────────────────────────────

  async function collectStream<T>(gen: AsyncGenerator<T>): Promise<T[]> {
    const out: T[] = [];
    for await (const e of gen) out.push(e);
    return out;
  }

  function makeAgentWithStream(aiMessages: AIMessage[]) {
    // Drives the callback lifecycle (one model turn) so streaming emits a `chat` child span,
    // then yields the graph step states the handler reads for text chunks.
    const streamFn = vi.fn().mockImplementation((_input: unknown, cfg: any) => {
      const cb = cfg?.callbacks?.[0];
      return (async function* () {
        cb?.handleChatModelStart?.({}, [], 'run-model-1');
        for (const msg of aiMessages) {
          yield { agent: { messages: [msg] } };
        }
        const last = aiMessages.at(-1) as any;
        cb?.handleLLMEnd?.(
          { generations: [[{ message: { usage_metadata: last?.usage_metadata ?? {} } }]] },
          'run-model-1',
        );
      })();
    });
    return { invoke: vi.fn(), stream: streamFn };
  }

  it('handler.stream is defined', () => {
    mockCreateAgent.mockReturnValue({ invoke: vi.fn(), stream: vi.fn().mockReturnValue((async function* () {})()) });
    const handler = createLangChainAgentsHandler({} as any);
    expect(typeof handler.stream).toBe('function');
  });

  it('yields chunk events from AI message steps', async () => {
    const aiMessages = [
      new AIMessage({
        content: 'Step 1 answer',
        usage_metadata: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
      }),
    ];
    mockCreateAgent.mockReturnValue(makeAgentWithStream(aiMessages));
    const handler = createLangChainAgentsHandler({} as any);
    const events = await collectStream(handler.stream?.(baseConfig as any, 'q', {}, {}));
    const chunks = events.filter((e: any) => e.type === 'chunk').map((e: any) => e.text);
    expect(chunks).toContain('Step 1 answer');
  });

  it('yields a done event as the last event', async () => {
    const aiMessages = [
      new AIMessage({ content: 'Answer', usage_metadata: { input_tokens: 2, output_tokens: 2, total_tokens: 4 } }),
    ];
    mockCreateAgent.mockReturnValue(makeAgentWithStream(aiMessages));
    const events = await collectStream(
      createLangChainAgentsHandler({} as any).stream?.(baseConfig as any, 'q', {}, {}),
    );
    expect(events.at(-1) as any).toMatchObject({ type: 'done' });
  });

  it('sets span attributes and puts content on attributes when enabled', async () => {
    const aiMessages = [
      new AIMessage({ content: 'hi', usage_metadata: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }),
    ];
    mockCreateAgent.mockReturnValue(makeAgentWithStream(aiMessages));
    await collectStream(
      createLangChainAgentsHandler({} as any, { captureContent: true }).stream?.(baseConfig as any, 'q', {}, {}),
    );
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('gen_ai.operation.name', 'invoke_agent');
    expect(latestModelSpan()?.setAttribute).toHaveBeenCalledWith('gen_ai.system', 'langchain');
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('gen_ai.prompt.1.content', 'q');
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('gen_ai.completion.0.content', 'hi');
    expect(mockSpan.addEvent).toHaveBeenCalledWith('gen_ai.content.prompt', expect.anything());
    expect(mockSpan.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.OK });
  });

  it('records exception on agent stream error', async () => {
    const err = new Error('agent stream error');
    mockCreateAgent.mockReturnValue({
      invoke: vi.fn(),
      stream: vi.fn().mockRejectedValue(err),
    });
    await expect(
      collectStream(createLangChainAgentsHandler({} as any).stream?.(baseConfig as any, 'q', {}, {})),
    ).rejects.toThrow('agent stream error');
    expect(mockSpan.recordException).toHaveBeenCalledWith(err);
  });

  it('streaming: span.end() is called on success', async () => {
    const aiMessages = [
      new AIMessage({ content: 'done', usage_metadata: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }),
    ];
    mockCreateAgent.mockReturnValue(makeAgentWithStream(aiMessages));
    await collectStream(createLangChainAgentsHandler({} as any).stream?.(baseConfig as any, 'q', {}, {}));
    expect(mockSpan.end).toHaveBeenCalled();
  });

  it('streaming: span.end() is called even when the agent stream throws', async () => {
    const err = new Error('stream crash');
    mockCreateAgent.mockReturnValue({
      invoke: vi.fn(),
      stream: vi.fn().mockRejectedValue(err),
    });
    await expect(
      collectStream(createLangChainAgentsHandler({} as any).stream?.(baseConfig as any, 'q', {}, {})),
    ).rejects.toThrow('stream crash');
    expect(mockSpan.end).toHaveBeenCalled();
  });

  it('stream returns an object with [Symbol.asyncIterator]', () => {
    mockCreateAgent.mockReturnValue({ invoke: vi.fn(), stream: vi.fn().mockReturnValue((async function* () {})()) });
    const gen = createLangChainAgentsHandler({} as any).stream?.(baseConfig as any, 'q', {}, {});
    expect(typeof gen[Symbol.asyncIterator]).toBe('function');
  });

  it('all chunk events appear before the done event', async () => {
    const aiMessages = [
      new AIMessage({ content: 'A', usage_metadata: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }),
      new AIMessage({ content: 'B', usage_metadata: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }),
    ];
    mockCreateAgent.mockReturnValue(makeAgentWithStream(aiMessages));
    const events = await collectStream(
      createLangChainAgentsHandler({} as any).stream?.(baseConfig as any, 'q', {}, {}),
    );
    const doneIdx = events.findIndex((e: any) => e.type === 'done');
    expect(doneIdx).toBe(events.length - 1);
  });

  it('done event usage reflects accumulated token counts', async () => {
    const aiMessages = [
      new AIMessage({ content: 'hi', usage_metadata: { input_tokens: 3, output_tokens: 7, total_tokens: 10 } }),
    ];
    mockCreateAgent.mockReturnValue(makeAgentWithStream(aiMessages));
    const events = await collectStream(
      createLangChainAgentsHandler({} as any).stream?.(baseConfig as any, 'q', {}, {}),
    );
    const done = events.find((e: any) => e.type === 'done') as any;
    expect(done.usage.input_tokens).toBe(3);
    expect(done.usage.output_tokens).toBe(7);
  });

  it('done event output equals the last accumulated chunk text', async () => {
    const aiMessages = [
      new AIMessage({
        content: 'final answer',
        usage_metadata: { input_tokens: 2, output_tokens: 4, total_tokens: 6 },
      }),
    ];
    mockCreateAgent.mockReturnValue(makeAgentWithStream(aiMessages));
    const events = await collectStream(
      createLangChainAgentsHandler({} as any).stream?.(baseConfig as any, 'q', {}, {}),
    );
    const done = events.find((e: any) => e.type === 'done') as any;
    expect(done.output).toBe('final answer');
  });

  // ── 1.2 Path C — edge cases ─────────────────────────────────────────────────

  it('does not throw when userInput is undefined', async () => {
    const agent = makeMockAgent();
    mockCreateAgent.mockReturnValue(agent);
    await expect(createLangChainAgentsHandler({} as any)(baseConfig as any, undefined)).resolves.toBeDefined();
  });

  it('prefers instructions over messages system entries for the system prompt', async () => {
    const agent = makeMockAgent();
    mockCreateAgent.mockReturnValue(agent);
    const config = {
      ...baseConfig,
      instructions: 'Use instructions.',
      messages: [{ role: 'system', content: 'Should be ignored.' }],
    };
    await createLangChainAgentsHandler({} as any)(config as any, 'q');
    expect(mockCreateAgent).toHaveBeenCalledWith(expect.objectContaining({ systemPrompt: 'Use instructions.' }));
  });

  it('leaves unresolved placeholders in instructions as-is', async () => {
    const agent = makeMockAgent();
    mockCreateAgent.mockReturnValue(agent);
    const config = { ...baseConfig, instructions: 'Hello {{unknown}}.' };
    await createLangChainAgentsHandler({} as any)(config as any, 'q', {}, {});
    expect(mockCreateAgent).toHaveBeenCalledWith(expect.objectContaining({ systemPrompt: 'Hello {{unknown}}.' }));
  });

  // ── 1.4 Tool execution ───────────────────────────────────────────────────────

  it('invokes toolHandler with the correct args when the executor is called', async () => {
    const myTool = vi.fn().mockResolvedValue('result');
    const agent = makeMockAgent();
    mockCreateAgent.mockReturnValue(agent);
    const config = {
      ...baseConfig,
      tools: {
        search: { name: 'search', type: 'function' as const, parameters: { type: 'object' }, description: 'Search' },
      },
    };
    await createLangChainAgentsHandler({} as any)(config as any, 'q', { search: myTool });
    const executor = mockLangchainTool.mock.calls[0][0];
    await executor({ query: 'hello' });
    expect(myTool).toHaveBeenCalledWith({ query: 'hello' });
  });

  it('does not expose tools that have no registered handler (filtered before agent creation)', async () => {
    const agent = makeMockAgent();
    mockCreateAgent.mockReturnValue(agent);
    const config = {
      ...baseConfig,
      tools: { search: { name: 'search', type: 'function' as const, parameters: {}, description: '' } },
    };
    // No handler for 'search' — tool must be filtered out, not forwarded to the agent
    await createLangChainAgentsHandler({} as any)(config as any, 'q', {});
    expect(mockLangchainTool).not.toHaveBeenCalled();
    const agentArgs = mockCreateAgent.mock.calls[0][0];
    expect(agentArgs.tools).toHaveLength(0);
  });

  it('propagates error when tool handler throws', async () => {
    const boom = new Error('tool exploded');
    const myTool = vi.fn().mockRejectedValue(boom);
    const agent = makeMockAgent();
    mockCreateAgent.mockReturnValue(agent);
    const config = {
      ...baseConfig,
      tools: { search: { name: 'search', type: 'function' as const, parameters: {}, description: '' } },
    };
    await createLangChainAgentsHandler({} as any)(config as any, 'q', { search: myTool });
    const executor = mockLangchainTool.mock.calls[0][0];
    await expect(executor({})).rejects.toThrow('tool exploded');
  });

  // ── History (§1.11 — structured messages, not system-prompt text) ────────────

  const sampleHistory = [
    { role: 'user' as const, content: 'What is feature flagging?' },
    { role: 'assistant' as const, content: 'Feature flagging is a technique...' },
  ];

  const imageHistory = [
    {
      role: 'user' as const,
      content: [
        { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png', data: 'abc123' } },
      ],
    },
  ];

  it('history is structured messages, not stuffed into systemPrompt', async () => {
    const agent = makeMockAgent();
    mockCreateAgent.mockReturnValue(agent);
    await createLangChainAgentsHandler({} as any)(baseConfig as any, 'q', {}, {}, sampleHistory);
    const systemPrompt = mockCreateAgent.mock.calls[0][0].systemPrompt;
    expect(systemPrompt).toContain('You are helpful.');
    expect(systemPrompt).not.toContain('Conversation History:');
    const messages = agent.invoke.mock.calls[0][0].messages;
    expect(messages.length).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(messages)).toContain('What is feature flagging?');
    expect(JSON.stringify(messages)).toContain('"q"');
  });

  it('history turns appear before userInput in initial messages', async () => {
    const agent = makeMockAgent();
    mockCreateAgent.mockReturnValue(agent);
    await createLangChainAgentsHandler({} as any)(baseConfig as any, 'follow up', {}, {}, sampleHistory);
    const messages = agent.invoke.mock.calls[0][0].messages;
    const serialized = JSON.stringify(messages);
    expect(serialized.indexOf('What is feature flagging?')).toBeLessThan(serialized.lastIndexOf('follow up'));
  });

  it('empty history is treated like no history', async () => {
    const agent = makeMockAgent();
    mockCreateAgent.mockReturnValue(agent);
    await createLangChainAgentsHandler({} as any)(baseConfig as any, 'q', {}, {}, []);
    const systemPrompt = mockCreateAgent.mock.calls[0][0].systemPrompt;
    expect(systemPrompt).not.toContain('Conversation History:');
    expect(systemPrompt).toBe('You are helpful.');
  });

  it('system-role history messages are filtered from initial messages', async () => {
    const agent = makeMockAgent();
    mockCreateAgent.mockReturnValue(agent);
    const withSystem = [{ role: 'system' as const, content: 'secret system' }, ...sampleHistory];
    await createLangChainAgentsHandler({} as any)(baseConfig as any, 'q', {}, {}, withSystem);
    expect(JSON.stringify(agent.invoke.mock.calls[0][0].messages)).not.toContain('secret system');
  });

  it('multimodal image history maps to LangChain image content parts', async () => {
    const agent = makeMockAgent();
    mockCreateAgent.mockReturnValue(agent);
    await createLangChainAgentsHandler({} as any)(baseConfig as any, 'describe', {}, {}, imageHistory);
    const serialized = JSON.stringify(agent.invoke.mock.calls[0][0].messages);
    expect(serialized).toMatch(/image_url|"type":"image"/);
    expect(serialized).toContain('abc123');
    expect(mockCreateAgent.mock.calls[0][0].systemPrompt).not.toContain('Conversation History:');
  });

  it('empty userInput with history ending in user does not append empty turn', async () => {
    const agent = makeMockAgent();
    mockCreateAgent.mockReturnValue(agent);
    const fullTurn = [
      {
        role: 'user' as const,
        content: [
          { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png', data: 'xyz' } },
          { type: 'text' as const, text: 'Analyze this diagram' },
        ],
      },
    ];
    await createLangChainAgentsHandler({} as any)(baseConfig as any, '', {}, {}, fullTurn);
    const messages = agent.invoke.mock.calls[0][0].messages;
    const serialized = JSON.stringify(messages);
    expect(serialized).toContain('Analyze this diagram');
    expect(serialized).toContain('xyz');
    const humanCount = messages.filter((m: { _getType?: () => string }) => m._getType?.() === 'human').length;
    expect(humanCount).toBe(1);
  });
});

// ── §1.9 outputFormat — withStructuredOutput after agent finishes ────────────

describe('createLangChainAgentsHandler — outputFormat (§1.9)', () => {
  const outputFormat = { type: 'object', properties: { result: { type: 'string' } } };
  const mockStructuredInvoke = vi.fn();
  const mockWithStructuredOutput = vi.fn();
  const mockLlm = { withStructuredOutput: mockWithStructuredOutput } as any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockChildSpans.length = 0;
    mockStructuredInvoke.mockResolvedValue({
      parsed: { result: 'structured answer' },
      raw: { usage_metadata: { input_tokens: 2, output_tokens: 3 } },
    });
    mockWithStructuredOutput.mockReturnValue({ invoke: mockStructuredInvoke });
    for (const key of Object.keys(mockSpan)) {
      (mockSpan as any)[key].mockReset?.();
    }
  });

  it('injects outputFormat schema into system prompt (best-effort)', async () => {
    const agent = makeMockAgent();
    mockCreateAgent.mockReturnValue(agent);
    const config = { ...baseConfig, outputFormat };
    await createLangChainAgentsHandler(mockLlm)(config as any, 'hello');
    const createAgentArgs = mockCreateAgent.mock.calls[0][0];
    expect(createAgentArgs.systemPrompt).toContain('You are helpful.');
    expect(createAgentArgs.systemPrompt).toContain(JSON.stringify(outputFormat));
  });

  it('does not call withStructuredOutput when outputFormat is absent', async () => {
    const agent = makeMockAgent();
    mockCreateAgent.mockReturnValue(agent);
    await createLangChainAgentsHandler(mockLlm)(baseConfig as any, 'hello');
    expect(mockWithStructuredOutput).not.toHaveBeenCalled();
  });

  it('does not call withStructuredOutput when outputFormat is set', async () => {
    const agent = makeMockAgent();
    mockCreateAgent.mockReturnValue(agent);
    const config = { ...baseConfig, outputFormat };
    await createLangChainAgentsHandler(mockLlm)(config as any, 'hello');
    expect(mockWithStructuredOutput).not.toHaveBeenCalled();
  });
});

// ─── langchainAgents — §1.7 invoke() argument passthrough ────────────────────

describe('langchainAgents — invoke() argument passthrough', () => {
  it('passes userInput and context to config().invoke()', async () => {
    vi.resetModules();
    const mockInvoke = vi.fn().mockResolvedValue({ response: 'ok', usage: {} });
    vi.doMock('@launchdarkly/ai-server', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@launchdarkly/ai-server')>();
      return {
        ...actual,
        config: vi.fn().mockReturnValue({ invoke: mockInvoke }),
      };
    });
    const { langchainAgents } = await import('../handler.js');
    const ctx = { kind: 'user' as const, key: 'test-user' };
    await langchainAgents('flag', 'tell me a joke', ctx, {} as any);
    expect(mockInvoke).toHaveBeenCalledWith('tell me a joke', ctx, undefined);
  });
});

// ─── langchainGraph ───────────────────────────────────────────────────────────

describe('langchainGraph', () => {
  it('pre-binds the LangChain agent handler into graph()', async () => {
    const graphMock = vi.fn().mockReturnValue({ call: vi.fn() });
    vi.doMock('@launchdarkly/ai-server', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@launchdarkly/ai-server')>();
      return { ...actual, graph: graphMock, config: vi.fn().mockReturnValue({ invoke: vi.fn() }) };
    });
    const { langchainGraph } = await import('../graph.js');
    langchainGraph('graph-flag', {});
    expect(graphMock).toHaveBeenCalledWith(
      'graph-flag',
      expect.objectContaining({
        handlers: expect.arrayContaining([expect.objectContaining({ providesFor: ['*', 'agent'] })]),
      }),
    );
  });

  it('forwards extra options (e.g. toolHandlers) to graph()', async () => {
    vi.resetModules();
    const graphMock = vi.fn().mockReturnValue({ call: vi.fn() });
    vi.doMock('@launchdarkly/ai-server', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@launchdarkly/ai-server')>();
      return { ...actual, graph: graphMock, config: vi.fn().mockReturnValue({ invoke: vi.fn() }) };
    });
    const { langchainGraph } = await import('../graph.js');
    const toolHandlers = { search: vi.fn() };
    langchainGraph('graph-flag', { toolHandlers });
    expect(graphMock).toHaveBeenCalledWith('graph-flag', expect.objectContaining({ toolHandlers }));
  });

  it('forwards the llm third argument to the handler constructor', async () => {
    vi.resetModules();
    const graphMock = vi.fn().mockReturnValue({ call: vi.fn() });
    const handlerFactorySpy = vi.fn().mockReturnValue({ providesFor: ['*', 'agent'] });
    vi.doMock('@launchdarkly/ai-server', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@launchdarkly/ai-server')>();
      return { ...actual, graph: graphMock, config: vi.fn().mockReturnValue({ invoke: vi.fn() }) };
    });
    vi.doMock('../handler.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../handler.js')>();
      return { ...actual, createLangChainAgentsHandler: handlerFactorySpy };
    });
    const { langchainGraph } = await import('../graph.js');
    const stubLlm = { invoke: vi.fn() } as any;
    langchainGraph('graph-flag', {}, stubLlm);
    expect(handlerFactorySpy).toHaveBeenCalledWith(stubLlm);
  });
});
