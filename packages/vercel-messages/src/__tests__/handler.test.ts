import { beforeEach, describe, expect, it, vi } from 'vitest';

const aiMocks = vi.hoisted(() => ({
  generateText: vi.fn(),
  streamText: vi.fn(),
  tool: vi.fn(({ execute, ...definition }: any) => ({ ...definition, execute })),
  jsonSchema: vi.fn((schema: unknown) => ({ schema })),
  outputObject: vi.fn((options: unknown) => ({ kind: 'object', ...((options as object) ?? {}) })),
  stepCountIs: vi.fn((steps: number) => ({ type: 'step-count', steps })),
}));

vi.mock('ai', () => ({
  generateText: aiMocks.generateText,
  streamText: aiMocks.streamText,
  tool: aiMocks.tool,
  jsonSchema: aiMocks.jsonSchema,
  Output: { object: aiMocks.outputObject },
  stepCountIs: aiMocks.stepCountIs,
}));

const serverMocks = vi.hoisted(() => ({
  config: vi.fn(),
}));

vi.mock('@launchdarkly/ai-server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@launchdarkly/ai-server')>();
  return { ...actual, config: serverMocks.config };
});

const spanMocks = vi.hoisted(() => {
  const makeSpan = () => ({
    addEvent: vi.fn(),
    end: vi.fn(),
    recordException: vi.fn(),
    setAttribute: vi.fn(),
    setStatus: vi.fn(),
  });
  return {
    children: [] as Array<{ name: string; span: ReturnType<typeof makeSpan> }>,
    makeSpan,
    root: makeSpan(),
    startActiveSpan: vi.fn(),
    startSpan: vi.fn(),
  };
});

vi.mock('@opentelemetry/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@opentelemetry/api')>();
  return {
    ...actual,
    trace: {
      ...actual.trace,
      getTracer: vi.fn(() => ({
        startActiveSpan: spanMocks.startActiveSpan.mockImplementation((_name: string, fn: Function) =>
          fn(spanMocks.root),
        ),
        startSpan: spanMocks.startSpan.mockImplementation((name: string) => {
          if (name === 'invoke_agent') return spanMocks.root;
          const span = spanMocks.makeSpan();
          spanMocks.children.push({ name, span });
          return span;
        }),
      })),
    },
  };
});

import { createVercelMessagesHandler, vercelMessages } from '../handler.js';

const baseConfig = {
  model: {
    name: 'anthropic/claude-sonnet-4',
    parameters: { temperature: 0.2 },
  },
  provider: { name: 'Anthropic' },
  instructions: 'Be helpful.',
};

function generation(text = 'answer', inputTokens = 4, outputTokens = 2) {
  return {
    text,
    usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
    steps: [{ usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens } }],
  };
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const events: T[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

describe('createVercelMessagesHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    spanMocks.children.length = 0;
    aiMocks.generateText.mockResolvedValue(generation());
    serverMocks.config.mockReturnValue({ invoke: vi.fn().mockResolvedValue({ response: 'ok', usage: {} }) });
  });

  it('advertises wildcard messages metadata', () => {
    expect(createVercelMessagesHandler().providesFor).toEqual(['*', 'messages']);
  });

  it('passes a provider-qualified model id unchanged to generateText', async () => {
    await createVercelMessagesHandler()(baseConfig as any, 'hello');
    expect(aiMocks.generateText).toHaveBeenCalledWith(expect.objectContaining({ model: 'anthropic/claude-sonnet-4' }));
  });

  it('builds a Gateway creator/model id from the evaluated provider', async () => {
    await createVercelMessagesHandler()(
      { ...baseConfig, model: { name: 'grok-4.5' }, provider: { name: 'xAI' } } as any,
      'hello',
    );
    expect(aiMocks.generateText).toHaveBeenCalledWith(expect.objectContaining({ model: 'spacexai/grok-4.5' }));
  });

  it('converts an LD dotted creator prefix without rewriting model version dots', async () => {
    await createVercelMessagesHandler()(
      { ...baseConfig, model: { name: 'openai.gpt-5.6-sol' }, provider: { name: 'OpenAI' } } as any,
      'hello',
    );
    expect(aiMocks.generateText).toHaveBeenCalledWith(expect.objectContaining({ model: 'openai/gpt-5.6-sol' }));
  });

  it('uses a supplied model instance instead of resolving a gateway model', async () => {
    const model = { specificationVersion: 'v3', provider: 'test', modelId: 'injected' };
    await createVercelMessagesHandler({ model } as any)(baseConfig as any, 'hello');
    expect(aiMocks.generateText).toHaveBeenCalledWith(expect.objectContaining({ model }));
  });

  it('calls an async model factory once per invocation with evaluated config', async () => {
    const model = { modelId: 'factory-model' };
    const modelFactory = vi.fn().mockResolvedValue(model);
    const handler = createVercelMessagesHandler({ modelFactory } as any);
    await handler(baseConfig as any, 'one');
    await handler({ ...baseConfig, model: { name: 'gateway/alias' } } as any, 'two');
    expect(modelFactory).toHaveBeenCalledTimes(2);
    expect(modelFactory).toHaveBeenNthCalledWith(1, baseConfig);
    expect(aiMocks.generateText).toHaveBeenLastCalledWith(expect.objectContaining({ model }));
  });

  it('keeps injected model sources scoped to each handler instance', async () => {
    const first = { modelId: 'first' };
    const second = { modelId: 'second' };
    await createVercelMessagesHandler({ model: first } as any)(baseConfig as any, 'one');
    await createVercelMessagesHandler({ model: second } as any)(baseConfig as any, 'two');
    expect(aiMocks.generateText).toHaveBeenNthCalledWith(1, expect.objectContaining({ model: first }));
    expect(aiMocks.generateText).toHaveBeenNthCalledWith(2, expect.objectContaining({ model: second }));
  });

  it('forwards generation parameters while stripping handler-owned fields and casing variants', async () => {
    const owned = {
      model: 'override',
      messages: ['override'],
      prompt: 'override',
      system: 'override',
      tools: { override: true },
      stream: true,
      output: 'override',
      outputFormat: {},
      output_format: {},
      stopWhen: 'override',
      stop_when: 'override',
      maxSteps: 999,
      max_steps: 999,
      apiKey: 'secret',
      api_key: 'secret',
      baseURL: 'https://wrong.invalid',
      base_url: 'https://wrong.invalid',
    };
    await createVercelMessagesHandler()(
      { ...baseConfig, model: { ...baseConfig.model, parameters: { temperature: 0.7, topP: 0.9, ...owned } } } as any,
      'hello',
    );
    const request = aiMocks.generateText.mock.calls[0][0];
    expect(request).toMatchObject({ temperature: 0.7, topP: 0.9, model: baseConfig.model.name });
    // Stable generateText transport fields must still exist, but flag parameters cannot replace
    // the handler-owned values.
    expect(request.messages).toEqual([{ role: 'user', content: 'hello' }]);
    expect(request.system).toBe('Be helpful.');
    expect(request).not.toHaveProperty('apiKey');
    expect(request).not.toHaveProperty('api_key');
    expect(request).not.toHaveProperty('baseURL');
    expect(request).not.toHaveProperty('base_url');
    expect(request).not.toHaveProperty('maxSteps');
    expect(request).not.toHaveProperty('max_steps');
    expect(request).not.toHaveProperty('outputFormat');
    expect(request).not.toHaveProperty('output_format');
  });

  it('uses generateText messages rather than a prompt string', async () => {
    await createVercelMessagesHandler()(baseConfig as any, 'hello');
    const request = aiMocks.generateText.mock.calls[0][0];
    expect(request.prompt).toBeUndefined();
    expect(request.messages).toEqual([{ role: 'user', content: 'hello' }]);
    expect(request.system).toBe('Be helpful.');
  });

  it('composes config messages, history, then user input with system history filtered', async () => {
    const config = {
      model: baseConfig.model,
      provider: baseConfig.provider,
      messages: [
        { role: 'system', content: 'System from config' },
        { role: 'user', content: 'Configured question' },
        { role: 'assistant', content: 'Configured answer' },
      ],
    };
    const history = [
      { role: 'system' as const, content: 'Do not forward me' },
      { role: 'user' as const, content: 'Previous question' },
      { role: 'assistant' as const, content: 'Previous answer' },
    ];
    await createVercelMessagesHandler()(config as any, 'Current question', {}, {}, history);
    const request = aiMocks.generateText.mock.calls[0][0];
    expect(request.system).toBe('System from config');
    expect(request.messages).toEqual([
      { role: 'user', content: 'Configured question' },
      { role: 'assistant', content: 'Configured answer' },
      { role: 'user', content: 'Previous question' },
      { role: 'assistant', content: 'Previous answer' },
      { role: 'user', content: 'Current question' },
    ]);
  });

  it('maps base64 and URL image history to native AI SDK image parts', async () => {
    const history = [
      {
        role: 'user' as const,
        content: [
          { type: 'text' as const, text: 'Compare these.' },
          { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png', data: 'YWJj' } },
          { type: 'image' as const, source: { type: 'url' as const, url: 'https://example.com/image.png' } },
        ],
      },
    ];
    await createVercelMessagesHandler()(baseConfig as any, '', {}, {}, history);
    const content = aiMocks.generateText.mock.calls[0][0].messages[0].content;
    expect(content[0]).toEqual({ type: 'text', text: 'Compare these.' });
    expect(content[1]).toMatchObject({ type: 'image', mediaType: 'image/png' });
    expect(content[1].image).toBeInstanceOf(Uint8Array);
    expect(content[2]).toEqual({ type: 'image', image: new URL('https://example.com/image.png') });
  });

  it('offers only tools with callable handlers and preserves JSON Schema', async () => {
    const execute = vi.fn().mockResolvedValue('sunny');
    const config = {
      ...baseConfig,
      tools: {
        weather: {
          name: 'weather',
          type: 'function',
          description: 'Get weather',
          parameters: { type: 'object', properties: { city: { type: 'string' } } },
        },
        missing: { name: 'missing', type: 'function', parameters: { type: 'object' } },
      },
    };
    aiMocks.generateText.mockImplementation(async (request: any) => {
      await request.tools.weather.execute({ city: 'Oakland' }, { toolCallId: 'call-1' });
      return generation('sunny');
    });
    await createVercelMessagesHandler()(config as any, 'weather?', { weather: execute });
    const request = aiMocks.generateText.mock.calls[0][0];
    expect(Object.keys(request.tools)).toEqual(['weather']);
    expect(aiMocks.tool).toHaveBeenCalledWith(
      expect.objectContaining({
        description: 'Get weather',
        inputSchema: expect.anything(),
        execute: expect.any(Function),
      }),
    );
    expect(aiMocks.jsonSchema).toHaveBeenCalledWith(config.tools.weather.parameters);
    expect(execute).toHaveBeenCalledWith({ city: 'Oakland' });
    expect(request.stopWhen).toEqual({ type: 'step-count', steps: 10 });
  });

  it('uses Output.object for blocking structured output and serializes the result', async () => {
    aiMocks.generateText.mockResolvedValue({
      ...generation('', 3, 2),
      output: { answer: 'forty-two' },
    });
    const schema = {
      type: 'object',
      properties: { answer: { type: 'string' } },
      required: ['answer'],
      additionalProperties: false,
    };
    const result = await createVercelMessagesHandler()({ ...baseConfig, outputFormat: schema } as any, 'q');
    expect(aiMocks.outputObject).toHaveBeenCalledWith({ schema: { schema } });
    expect(aiMocks.generateText).toHaveBeenCalledWith(expect.objectContaining({ output: expect.anything() }));
    expect(result.output).toBe('{"answer":"forty-two"}');
  });

  it('normalizes the AI Config json_schema descriptor into JSON Schema', async () => {
    const schema = { type: 'json_schema', properties: { answer: { type: 'string' } } };
    await createVercelMessagesHandler()({ ...baseConfig, outputFormat: schema } as any, 'q');
    expect(aiMocks.jsonSchema).toHaveBeenCalledWith({
      ...schema,
      type: 'object',
      required: ['answer'],
      additionalProperties: false,
    });
  });

  it('supplies the required and additionalProperties that strict providers demand', async () => {
    const schema = { type: 'object', properties: { answer: { type: 'string' }, source: { type: 'string' } } };
    await createVercelMessagesHandler()({ ...baseConfig, outputFormat: schema } as any, 'q');
    expect(aiMocks.jsonSchema).toHaveBeenCalledWith({
      ...schema,
      required: ['answer', 'source'],
      additionalProperties: false,
    });
  });

  it('widens a partial required list, which strict providers also reject', async () => {
    const schema = {
      type: 'object',
      properties: { answer: { type: 'string' }, source: { type: 'string' } },
      required: ['answer'],
      additionalProperties: true,
    };
    await createVercelMessagesHandler()({ ...baseConfig, outputFormat: schema } as any, 'q');
    expect(aiMocks.jsonSchema).toHaveBeenCalledWith({
      ...schema,
      required: ['answer', 'source'],
      additionalProperties: false,
    });
  });

  it('normalizes and accumulates usage across model steps', async () => {
    aiMocks.generateText.mockResolvedValue({
      text: 'done',
      usage: { inputTokens: 7, outputTokens: 4, totalTokens: 11 },
      steps: [
        { usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 } },
        { usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 } },
      ],
    });
    const result = await createVercelMessagesHandler()(baseConfig as any, 'q');
    expect(result.usage).toEqual({ input_tokens: 7, output_tokens: 4, total_tokens: 11 });
  });

  it('uses streamText, forwards deltas, ignores outputFormat, and emits one final done', async () => {
    aiMocks.streamText.mockReturnValue({
      textStream: (async function* () {
        yield 'Hello';
        yield ' world';
      })(),
      usage: Promise.resolve({ inputTokens: 5, outputTokens: 2, totalTokens: 7 }),
    });
    const handler = createVercelMessagesHandler();
    const events = await collect(
      handler.stream?.({ ...baseConfig, outputFormat: { type: 'object' } } as any, 'q', {}, {}) as AsyncIterable<any>,
    );
    expect(aiMocks.streamText).toHaveBeenCalledWith(expect.not.objectContaining({ output: expect.anything() }));
    expect(events).toEqual([
      { type: 'chunk', text: 'Hello' },
      { type: 'chunk', text: ' world' },
      {
        type: 'done',
        output: 'Hello world',
        usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
      },
    ]);
  });

  it('cancels the provider iterator and ends the root span when the consumer exits early', async () => {
    const providerReturn = vi.fn().mockResolvedValue({ done: true });
    const iterator = {
      next: vi
        .fn()
        .mockResolvedValueOnce({ done: false, value: 'first' })
        .mockResolvedValueOnce({ done: false, value: 'must-not-be-consumed' }),
      return: providerReturn,
    };
    aiMocks.streamText.mockReturnValue({
      textStream: { [Symbol.asyncIterator]: () => iterator },
      usage: Promise.resolve({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
    });
    const stream = createVercelMessagesHandler().stream?.(baseConfig as any, 'q', {}, {});
    for await (const event of stream as AsyncIterable<any>) {
      expect(event).toEqual({ type: 'chunk', text: 'first' });
      break;
    }
    expect(providerReturn).toHaveBeenCalledOnce();
    expect(iterator.next).toHaveBeenCalledOnce();
    expect(spanMocks.root.end).toHaveBeenCalledOnce();
  });

  it('uses evaluated provider telemetry while preserving the gateway model id', async () => {
    await createVercelMessagesHandler()(baseConfig as any, 'q');
    const chat = spanMocks.children.find(({ name }) => name === `chat ${baseConfig.model.name}`)?.span;
    expect(chat?.setAttribute).toHaveBeenCalledWith('gen_ai.system', 'anthropic');
    expect(chat?.setAttribute).toHaveBeenCalledWith('gen_ai.provider.name', 'anthropic');
    expect(chat?.setAttribute).toHaveBeenCalledWith('gen_ai.request.model', 'anthropic/claude-sonnet-4');
    expect(aiMocks.generateText.mock.calls[0][0]).not.toHaveProperty('experimental_telemetry');
  });

  it('pre-wires the convenience function through config()', async () => {
    const invoke = vi.fn().mockResolvedValue({ response: 'ok', usage: {} });
    serverMocks.config.mockReturnValue({ invoke });
    const context = { kind: 'user', key: 'u1' };
    await vercelMessages('flag-key', 'hello', context as any, {});
    expect(serverMocks.config).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'flag-key',
        handler: expect.objectContaining({ providesFor: ['*', 'messages'] }),
      }),
    );
    expect(invoke).toHaveBeenCalledWith('hello', context, undefined);
  });
});
