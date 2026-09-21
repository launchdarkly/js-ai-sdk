import { SpanStatusCode } from '@opentelemetry/api';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { constructedClients, mockChatCreate, mockConfig, mockInvoke, mockRootSpan, mockSpans } = vi.hoisted(() => {
  const span = () => ({
    addEvent: vi.fn(),
    end: vi.fn(),
    recordException: vi.fn(),
    setAttribute: vi.fn(),
    setStatus: vi.fn(),
  });
  return {
    constructedClients: [] as Array<Record<string, unknown>>,
    mockChatCreate: vi.fn(),
    mockConfig: vi.fn(),
    mockInvoke: vi.fn(),
    mockRootSpan: span(),
    mockSpans: [] as Array<{ name: string; span: ReturnType<typeof span> }>,
  };
});

vi.mock('openai', () => ({
  default: class {
    chat = { completions: { create: mockChatCreate } };
    constructor(options: Record<string, unknown>) {
      constructedClients.push(options);
    }
  },
}));

vi.mock('@opentelemetry/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@opentelemetry/api')>();
  const makeSpan = () => ({
    addEvent: vi.fn(),
    end: vi.fn(),
    recordException: vi.fn(),
    setAttribute: vi.fn(),
    setStatus: vi.fn(),
  });
  return {
    ...actual,
    trace: {
      ...actual.trace,
      getTracer: vi.fn().mockReturnValue({
        startActiveSpan: vi.fn().mockImplementation((_name: string, fn: Function) => fn(mockRootSpan)),
        startSpan: vi.fn().mockImplementation((name: string) => {
          if (name === 'invoke_agent') return mockRootSpan;
          const span = makeSpan();
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
  };
});

import { createLiteLLMMessagesHandler, litellmMessages } from '../handler.js';

const baseConfig = {
  instructions: 'You are helpful.',
  model: { name: 'anthropic/claude-sonnet-4' },
  provider: { name: 'Anthropic' },
};

const tool = (name: string) => ({
  description: `${name} description`,
  name,
  parameters: { properties: { value: { type: 'string' } }, type: 'object' },
  type: 'function' as const,
});

function completion(content = 'answer', promptTokens = 4, completionTokens = 2) {
  return {
    choices: [{ finish_reason: 'stop', message: { content, role: 'assistant' } }],
    model: 'proxy-model',
    usage: {
      completion_tokens: completionTokens,
      prompt_tokens: promptTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
}

function toolCompletion(calls: Array<{ id: string; name: string; arguments: string }>) {
  return {
    choices: [
      {
        finish_reason: 'tool_calls',
        message: {
          content: null,
          role: 'assistant',
          tool_calls: calls.map((call, index) => ({
            function: { arguments: call.arguments, name: call.name },
            id: call.id,
            index,
            type: 'function',
          })),
        },
      },
    ],
    usage: { completion_tokens: 1, prompt_tokens: 3, total_tokens: 4 },
  };
}

function stream(events: unknown[], onCancel = vi.fn()) {
  return {
    controller: { abort: onCancel },
    async *[Symbol.asyncIterator]() {
      for (const event of events) yield event;
    },
  };
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const events: T[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

describe('createLiteLLMMessagesHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('LITELLM_BASE_URL', '');
    vi.stubEnv('LITELLM_API_KEY', '');
    constructedClients.length = 0;
    mockSpans.length = 0;
    for (const fn of Object.values(mockRootSpan)) fn.mockReset();
    mockConfig.mockReturnValue({ invoke: mockInvoke });
  });

  describe('factory, proxy ownership, and evaluated config', () => {
    it('advertises wildcard messages metadata and captureContent', () => {
      expect(createLiteLLMMessagesHandler().providesFor).toEqual(['*', 'messages']);
      expect(createLiteLLMMessagesHandler().captureContent).toBe(false);
      expect(createLiteLLMMessagesHandler({ captureContent: true }).captureContent).toBe(true);
    });

    it('returns independent handlers', () => {
      expect(createLiteLLMMessagesHandler()).not.toBe(createLiteLLMMessagesHandler());
    });

    it('uses an injected OpenAI-compatible client without constructing another client', async () => {
      const create = vi.fn().mockResolvedValue(completion());
      const client = { chat: { completions: { create } } };
      await createLiteLLMMessagesHandler({ client: client as never })(baseConfig as never, 'hello');
      expect(create).toHaveBeenCalledOnce();
      expect(constructedClients).toHaveLength(0);
    });

    it('constructs the default compatible client against the LiteLLM proxy', async () => {
      mockChatCreate.mockResolvedValue(completion());
      await createLiteLLMMessagesHandler({
        apiKey: 'proxy-key',
        baseURL: 'https://litellm.example.test/v1',
      })(baseConfig as never, 'hello');
      expect(constructedClients).toEqual([
        expect.objectContaining({
          apiKey: 'proxy-key',
          baseURL: 'https://litellm.example.test/v1',
        }),
      ]);
    });

    it('infers proxy settings from the environment without forwarding provider credentials', async () => {
      vi.stubEnv('LITELLM_BASE_URL', 'https://env-litellm.example.test/v1');
      vi.stubEnv('LITELLM_API_KEY', '');
      vi.stubEnv('OPENAI_API_KEY', 'provider-secret');
      mockChatCreate.mockResolvedValue(completion());

      await createLiteLLMMessagesHandler()(baseConfig as never, 'hello');

      expect(constructedClients).toEqual([
        expect.objectContaining({
          apiKey: 'not-needed',
          baseURL: 'https://env-litellm.example.test/v1',
        }),
      ]);
      expect(JSON.stringify(constructedClients)).not.toContain('provider-secret');
      vi.unstubAllEnvs();
    });

    it('never targets api.openai.com when no base URL is configured', () => {
      expect(() => createLiteLLMMessagesHandler({ apiKey: 'proxy-key' })).toThrow(/LITELLM_BASE_URL|baseURL/i);
      expect(JSON.stringify(constructedClients)).not.toContain('api.openai.com');
    });

    it('keeps the no-arg factory metadata-safe but rejects before constructing a default client', async () => {
      const handler = createLiteLLMMessagesHandler();
      await expect(handler(baseConfig as never, 'hello')).rejects.toThrow(/LITELLM_BASE_URL|baseURL/i);
      expect(constructedClients).toHaveLength(0);
    });

    it('resolves clientFactory after evaluation and scopes it to the handler instance', async () => {
      const firstCreate = vi.fn().mockResolvedValue(completion('first'));
      const secondCreate = vi.fn().mockResolvedValue(completion('second'));
      const firstFactory = vi.fn().mockReturnValue({ chat: { completions: { create: firstCreate } } });
      const secondFactory = vi.fn().mockReturnValue({ chat: { completions: { create: secondCreate } } });
      const config = { ...baseConfig, model: { name: 'router-alias', parameters: { temperature: 0.3 } } };

      await createLiteLLMMessagesHandler({ clientFactory: firstFactory })(config as never, 'one');
      await createLiteLLMMessagesHandler({ clientFactory: secondFactory })(config as never, 'two');

      expect(firstFactory).toHaveBeenCalledWith(config);
      expect(secondFactory).toHaveBeenCalledWith(config);
      expect(firstCreate).toHaveBeenCalledOnce();
      expect(secondCreate).toHaveBeenCalledOnce();
    });

    it('forwards evaluated model and parameters while handler-owned fields win collisions', async () => {
      const create = vi.fn().mockResolvedValue(completion());
      const client = { chat: { completions: { create } } };
      const config = {
        ...baseConfig,
        model: {
          name: 'bedrock/company-alias',
          parameters: {
            max_tokens: 321,
            messages: ['malicious'],
            model: 'gpt-default',
            response_format: { type: 'text' },
            stream: true,
            temperature: 0.25,
            tools: ['malicious'],
          },
        },
      };
      await createLiteLLMMessagesHandler({ client: client as never })(config as never, 'hello');
      const request = create.mock.calls[0][0];
      expect(request).toMatchObject({
        max_tokens: 321,
        model: 'bedrock/company-alias',
        stream: false,
        temperature: 0.25,
      });
      expect(request.messages).not.toEqual(['malicious']);
      expect(request.tools).not.toEqual(['malicious']);
      expect(request.response_format).toBeUndefined();
    });
  });

  describe('prompt, history, and multimodal mapping', () => {
    it('uses instructions with templating and appends user input', async () => {
      const create = vi.fn().mockResolvedValue(completion());
      await createLiteLLMMessagesHandler({ client: { chat: { completions: { create } } } as never })(
        { ...baseConfig, instructions: 'Help {{name}}; keep {{missing}}.' } as never,
        'question',
        {},
        { name: 'Ada' },
      );
      expect(create.mock.calls[0][0].messages).toEqual([
        { content: 'Help Ada; keep {{missing}}.', role: 'system' },
        { content: 'question', role: 'user' },
      ]);
    });

    it('prefers config.messages and prevents duplicate final user input', async () => {
      const create = vi.fn().mockResolvedValue(completion());
      const config = {
        ...baseConfig,
        instructions: 'ignored',
        messages: [
          { content: 'System {{topic}}', role: 'system' },
          { content: 'Configured {{question}}', role: 'user' },
        ],
      };
      await createLiteLLMMessagesHandler({ client: { chat: { completions: { create } } } as never })(
        config as never,
        'duplicate',
        {},
        { question: 'question', topic: 'prompt' },
      );
      expect(create.mock.calls[0][0].messages).toEqual([
        { content: 'System prompt', role: 'system' },
        { content: 'Configured question', role: 'user' },
      ]);
    });

    it('inserts history before the final input and maps image blocks to image_url parts', async () => {
      const create = vi.fn().mockResolvedValue(completion());
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
      await createLiteLLMMessagesHandler({ client: { chat: { completions: { create } } } as never })(
        baseConfig as never,
        'follow up',
        {},
        {},
        history,
      );
      const messages = create.mock.calls[0][0].messages;
      expect(messages.at(-1)).toEqual({ content: 'follow up', role: 'user' });
      expect(messages[2].content).toEqual([
        { image_url: { url: 'data:image/png;base64,abc123' }, type: 'image_url' },
        { text: 'describe', type: 'text' },
      ]);
    });

    it('appends runtime input after config messages and history', async () => {
      const create = vi.fn().mockResolvedValue(completion());
      const config = {
        ...baseConfig,
        messages: [
          { content: 'System prompt', role: 'system' },
          { content: 'Configured question', role: 'user' },
        ],
      };
      await createLiteLLMMessagesHandler({ client: { chat: { completions: { create } } } as never })(
        config as never,
        'runtime follow up',
        {},
        {},
        [{ content: 'earlier answer', role: 'assistant' }],
      );

      expect(create.mock.calls[0][0].messages).toEqual([
        { content: 'System prompt', role: 'system' },
        { content: 'Configured question', role: 'user' },
        { content: 'earlier answer', role: 'assistant' },
        { content: 'runtime follow up', role: 'user' },
      ]);
    });
  });

  describe('tools, loops, usage, and structured output', () => {
    it('filters tools to callable handlers and forwards OpenAI-compatible schemas', async () => {
      const create = vi.fn().mockResolvedValue(completion());
      const config = {
        ...baseConfig,
        tools: { first: tool('first'), omitted: tool('omitted'), second: tool('second') },
      };
      await createLiteLLMMessagesHandler({ client: { chat: { completions: { create } } } as never })(
        config as never,
        'q',
        { first: vi.fn(), second: vi.fn() },
      );
      expect(create.mock.calls[0][0].tools).toEqual([
        {
          function: expect.objectContaining({
            description: 'first description',
            name: 'first',
            parameters: tool('first').parameters,
          }),
          type: 'function',
        },
        {
          function: expect.objectContaining({
            description: 'second description',
            name: 'second',
            parameters: tool('second').parameters,
          }),
          type: 'function',
        },
      ]);
    });

    it('executes a tool and sends assistant call plus tool result before continuing', async () => {
      const create = vi
        .fn()
        .mockResolvedValueOnce(toolCompletion([{ arguments: '{"value":"x"}', id: 'call-1', name: 'lookup' }]))
        .mockResolvedValueOnce(completion('done'));
      const lookup = vi.fn().mockResolvedValue({ found: true });
      const result = await createLiteLLMMessagesHandler({ client: { chat: { completions: { create } } } as never })(
        { ...baseConfig, tools: { lookup: tool('lookup') } } as never,
        'q',
        { lookup },
      );
      expect(lookup).toHaveBeenCalledWith({ value: 'x' });
      expect(create.mock.calls[1][0].messages.slice(-2)).toEqual([
        expect.objectContaining({ role: 'assistant', tool_calls: expect.any(Array) }),
        expect.objectContaining({ content: '{"found":true}', role: 'tool', tool_call_id: 'call-1' }),
      ]);
      expect(result.output).toBe('done');
    });

    it('executes parallel calls and consecutive tool turns while accumulating usage', async () => {
      const create = vi
        .fn()
        .mockResolvedValueOnce(
          toolCompletion([
            { arguments: '{"value":"a"}', id: 'a', name: 'first' },
            { arguments: '{"value":"b"}', id: 'b', name: 'second' },
          ]),
        )
        .mockResolvedValueOnce(toolCompletion([{ arguments: '{"value":"c"}', id: 'c', name: 'third' }]))
        .mockResolvedValueOnce(completion('done', 5, 2));
      const handlers = { first: vi.fn(), second: vi.fn(), third: vi.fn() };
      const result = await createLiteLLMMessagesHandler({ client: { chat: { completions: { create } } } as never })(
        { ...baseConfig, tools: { first: tool('first'), second: tool('second'), third: tool('third') } } as never,
        'q',
        handlers,
      );
      expect(handlers.first).toHaveBeenCalledWith({ value: 'a' });
      expect(handlers.second).toHaveBeenCalledWith({ value: 'b' });
      expect(handlers.third).toHaveBeenCalledWith({ value: 'c' });
      expect(result.usage).toMatchObject({ input_tokens: 11, output_tokens: 4 });
    });

    it('sends response_format on every blocking turn and lets the handler own it', async () => {
      const create = vi
        .fn()
        .mockResolvedValueOnce(toolCompletion([{ arguments: '{}', id: 'call-1', name: 'lookup' }]))
        .mockResolvedValueOnce(completion('{"answer":"yes"}'));
      const schema = { properties: { answer: { type: 'string' } }, type: 'object' };
      await createLiteLLMMessagesHandler({ client: { chat: { completions: { create } } } as never })(
        { ...baseConfig, outputFormat: schema, tools: { lookup: tool('lookup') } } as never,
        'q',
        { lookup: vi.fn() },
      );
      for (const [request] of create.mock.calls) {
        expect(request.response_format).toEqual({
          json_schema: { name: 'output', schema, strict: false },
          type: 'json_schema',
        });
      }
    });
  });

  describe('streaming', () => {
    it('yields text deltas, one done event, and terminal usage', async () => {
      const create = vi
        .fn()
        .mockResolvedValue(
          stream([
            { choices: [{ delta: { content: 'Hello' } }] },
            { choices: [{ delta: { content: ' world' } }] },
            { choices: [], usage: { completion_tokens: 3, prompt_tokens: 5, total_tokens: 8 } },
          ]),
        );
      const handler = createLiteLLMMessagesHandler({ client: { chat: { completions: { create } } } as never });
      const events = await collect(handler.stream?.(baseConfig as never, 'q', {}, {}) as AsyncIterable<unknown>);
      expect(create.mock.calls[0][0]).toMatchObject({ stream: true, stream_options: { include_usage: true } });
      expect(events).toEqual([
        { text: 'Hello', type: 'chunk' },
        { text: ' world', type: 'chunk' },
        { output: 'Hello world', type: 'done', usage: expect.objectContaining({ input_tokens: 5, output_tokens: 3 }) },
      ]);
    });

    it('assembles fragmented tool calls by index and continues streaming', async () => {
      const create = vi
        .fn()
        .mockResolvedValueOnce(
          stream([
            { choices: [{ delta: { content: 'before ' } }] },
            {
              choices: [
                {
                  delta: {
                    tool_calls: [{ function: { arguments: '{"value":', name: 'look' }, id: 'call-', index: 0 }],
                  },
                },
              ],
            },
            {
              choices: [
                {
                  delta: {
                    tool_calls: [{ function: { arguments: '"x"}', name: 'up' }, id: '1', index: 0 }],
                  },
                },
              ],
            },
          ]),
        )
        .mockResolvedValueOnce(
          stream([
            { choices: [{ delta: { content: 'after' } }] },
            { choices: [], usage: { completion_tokens: 2, prompt_tokens: 4, total_tokens: 6 } },
          ]),
        );
      const lookup = vi.fn().mockReturnValue('found');
      const events = await collect(
        createLiteLLMMessagesHandler({ client: { chat: { completions: { create } } } as never }).stream?.(
          { ...baseConfig, outputFormat: { type: 'object' }, tools: { lookup: tool('lookup') } } as never,
          'q',
          { lookup },
          {},
        ) as AsyncIterable<unknown>,
      );
      expect(lookup).toHaveBeenCalledWith({ value: 'x' });
      expect(events).toContainEqual({ text: 'before ', type: 'chunk' });
      expect(events).toContainEqual({ text: 'after', type: 'chunk' });
      expect(events.at(-1)).toMatchObject({ output: 'before after', type: 'done' });
      expect(create.mock.calls.every(([request]) => request.response_format === undefined)).toBe(true);
    });

    it('cancels the provider body and closes spans when the consumer abandons', async () => {
      const cancel = vi.fn();
      const create = vi
        .fn()
        .mockResolvedValue(
          stream([{ choices: [{ delta: { content: 'one' } }] }, { choices: [{ delta: { content: 'two' } }] }], cancel),
        );
      const iterable = createLiteLLMMessagesHandler({
        client: { chat: { completions: { create } } } as never,
      }).stream?.(baseConfig as never, 'q', {}, {}) as AsyncIterable<unknown>;
      for await (const _event of iterable) break;
      expect(cancel).toHaveBeenCalledOnce();
      expect(mockRootSpan.setAttribute).toHaveBeenCalledWith('launchdarkly.stream.abandoned', true);
      expect(mockRootSpan.setStatus).not.toHaveBeenCalledWith(expect.objectContaining({ code: SpanStatusCode.ERROR }));
      expect(mockRootSpan.end).toHaveBeenCalledOnce();
    });

    it('records and rethrows provider stream errors', async () => {
      const error = new Error('proxy stream failed');
      const create = vi.fn().mockRejectedValue(error);
      await expect(
        collect(
          createLiteLLMMessagesHandler({ client: { chat: { completions: { create } } } as never }).stream?.(
            baseConfig as never,
            'q',
            {},
            {},
          ) as AsyncIterable<unknown>,
        ),
      ).rejects.toThrow('proxy stream failed');
      expect(mockRootSpan.recordException).toHaveBeenCalledWith(error);
      expect(mockRootSpan.setStatus).toHaveBeenCalledWith(expect.objectContaining({ code: SpanStatusCode.ERROR }));
      expect(mockRootSpan.end).toHaveBeenCalledOnce();
    });
  });

  describe('telemetry and convenience wrapper', () => {
    it('emits provider-aware chat and tool child spans', async () => {
      const create = vi
        .fn()
        .mockResolvedValueOnce(toolCompletion([{ arguments: '{}', id: 'call-1', name: 'lookup' }]))
        .mockResolvedValueOnce(completion('done'));
      await createLiteLLMMessagesHandler({ client: { chat: { completions: { create } } } as never })(
        { ...baseConfig, tools: { lookup: tool('lookup') } } as never,
        'q',
        { lookup: vi.fn() },
      );
      const chats = mockSpans.filter(({ name }) => name === 'chat anthropic/claude-sonnet-4');
      expect(chats).toHaveLength(2);
      expect(chats[0].span.setAttribute).toHaveBeenCalledWith('gen_ai.system', 'litellm');
      expect(chats[0].span.setAttribute).toHaveBeenCalledWith('gen_ai.provider.name', 'anthropic');
      expect(mockSpans.map(({ name }) => name)).toContain('execute_tool lookup');
    });

    it('gates content while retaining model, usage, and LaunchDarkly correlation', async () => {
      const create = vi.fn().mockResolvedValue(completion('secret answer', 8, 4));
      const variables = {
        __ld: { configKey: 'cfg', runId: 'run', variationKey: 'variation' },
        ldContext: { key: 'user-1', kind: 'user' },
      };
      await createLiteLLMMessagesHandler({ client: { chat: { completions: { create } } } as never })(
        baseConfig as never,
        'secret question',
        {},
        variables,
      );
      expect(JSON.stringify(mockRootSpan.setAttribute.mock.calls)).not.toContain('secret question');
      expect(mockRootSpan.addEvent).toHaveBeenCalledWith(
        'feature_flag',
        expect.objectContaining({ 'feature_flag.key': 'cfg' }),
      );
      const chat = mockSpans.find(({ name }) => name.startsWith('chat '));
      expect(chat?.span.setAttribute).toHaveBeenCalledWith('gen_ai.request.model', 'anthropic/claude-sonnet-4');
      expect(chat?.span.setAttribute).toHaveBeenCalledWith('gen_ai.usage.input_tokens', 8);
    });

    it('captures prompt and completion only when captureContent is enabled', async () => {
      const create = vi.fn().mockResolvedValue(completion('visible answer'));
      await createLiteLLMMessagesHandler({
        captureContent: true,
        client: { chat: { completions: { create } } } as never,
      })(baseConfig as never, 'visible question');
      expect(mockRootSpan.setAttribute).toHaveBeenCalledWith('gen_ai.prompt.1.content', 'visible question');
      expect(mockRootSpan.setAttribute).toHaveBeenCalledWith('gen_ai.completion.0.content', 'visible answer');
    });

    it('litellmMessages wires the wildcard handler and forwards variables', async () => {
      mockInvoke.mockResolvedValue({ response: 'ok', usage: {} });
      const context = { key: 'user', kind: 'user' as const };
      const variables = { topic: 'flags' };
      await litellmMessages('flag', 'hello', context, {
        baseURL: 'https://litellm.test/v1',
        variables,
      });
      expect(mockConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          handler: expect.objectContaining({ providesFor: ['*', 'messages'] }),
          key: 'flag',
        }),
      );
      expect(mockConfig.mock.calls[0][0]).not.toHaveProperty('variables');
      expect(mockInvoke).toHaveBeenCalledWith('hello', context, variables);
    });
  });
});
