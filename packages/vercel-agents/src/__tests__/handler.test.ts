import { beforeEach, describe, expect, it, vi } from 'vitest';

const aiMocks = vi.hoisted(() => ({
  agentArguments: [] as any[],
  generate: vi.fn(),
  stream: vi.fn(),
  tool: vi.fn(({ execute, ...definition }: any) => ({ ...definition, execute })),
  jsonSchema: vi.fn((schema: unknown) => ({ schema })),
  outputObject: vi.fn((options: unknown) => ({ kind: 'object', ...((options as object) ?? {}) })),
  stepCountIs: vi.fn((steps: number) => ({ type: 'step-count', steps })),
}));

vi.mock('ai', () => ({
  ToolLoopAgent: class {
    constructor(options: any) {
      aiMocks.agentArguments.push(options);
    }
    generate = aiMocks.generate;
    stream = aiMocks.stream;
  },
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
  };
});

vi.mock('@opentelemetry/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@opentelemetry/api')>();
  return {
    ...actual,
    trace: {
      ...actual.trace,
      getTracer: vi.fn(() => ({
        startActiveSpan: vi.fn((_name: string, fn: Function) => fn(spanMocks.root)),
        startSpan: vi.fn((name: string) => {
          if (name === 'invoke_agent') return spanMocks.root;
          const span = spanMocks.makeSpan();
          spanMocks.children.push({ name, span });
          return span;
        }),
      })),
    },
  };
});

import { createVercelAgentsHandler, vercelAgents } from '../handler.js';

const baseConfig = {
  model: { name: 'openai/gpt-5', parameters: { temperature: 0.1 } },
  provider: { name: 'OpenAI' },
  instructions: 'You are an agent.',
};

function agentResult(text = 'agent answer', inputTokens = 6, outputTokens = 3) {
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

describe('createVercelAgentsHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    aiMocks.agentArguments.length = 0;
    spanMocks.children.length = 0;
    aiMocks.generate.mockResolvedValue(agentResult());
    serverMocks.config.mockReturnValue({ invoke: vi.fn().mockResolvedValue({ response: 'ok', usage: {} }) });
  });

  it('advertises wildcard agent metadata', () => {
    expect(createVercelAgentsHandler().providesFor).toEqual(['*', 'agent']);
  });

  it('constructs the stable ToolLoopAgent and calls generate()', async () => {
    await createVercelAgentsHandler()(baseConfig as any, 'hello');
    expect(aiMocks.agentArguments).toHaveLength(1);
    expect(aiMocks.agentArguments[0]).toMatchObject({
      model: 'openai/gpt-5',
      instructions: 'You are an agent.',
    });
    expect(aiMocks.generate).toHaveBeenCalledOnce();
  });

  it('builds a Gateway creator/model id from the evaluated provider', async () => {
    await createVercelAgentsHandler()(
      { ...baseConfig, model: { name: 'grok-4.5' }, provider: { name: 'xAI' } } as any,
      'hello',
    );
    expect(aiMocks.agentArguments[0].model).toBe('spacexai/grok-4.5');
  });

  it('converts an LD dotted creator prefix', async () => {
    await createVercelAgentsHandler()(
      { ...baseConfig, model: { name: 'openai.gpt-5.6-sol' }, provider: { name: 'OpenAI' } } as any,
      'hello',
    );
    expect(aiMocks.agentArguments[0].model).toBe('openai/gpt-5.6-sol');
  });

  it('passes the gateway model name unchanged and supports model instances', async () => {
    const model = { modelId: 'injected' };
    await createVercelAgentsHandler({ model } as any)(baseConfig as any, 'hello');
    expect(aiMocks.agentArguments[0].model).toBe(model);
  });

  it('resolves an async model factory once per invocation', async () => {
    const model = { modelId: 'factory-model' };
    const modelFactory = vi.fn().mockResolvedValue(model);
    await createVercelAgentsHandler({ modelFactory } as any)(baseConfig as any, 'hello');
    expect(modelFactory).toHaveBeenCalledOnce();
    expect(modelFactory).toHaveBeenCalledWith(baseConfig);
    expect(aiMocks.agentArguments[0].model).toBe(model);
  });

  it('forwards model settings but strips fields owned by the handler and agent loop', async () => {
    const parameters = {
      temperature: 0.4,
      topP: 0.8,
      model: 'bad',
      messages: [],
      prompt: 'bad',
      system: 'bad',
      tools: {},
      stream: true,
      output: {},
      outputFormat: {},
      output_format: {},
      stopWhen: 'bad',
      stop_when: 'bad',
      maxSteps: 100,
      max_steps: 100,
      apiKey: 'secret',
      api_key: 'secret',
      baseURL: 'https://wrong.invalid',
      base_url: 'https://wrong.invalid',
    };
    await createVercelAgentsHandler()({ ...baseConfig, model: { ...baseConfig.model, parameters } } as any, 'hello');
    expect(aiMocks.agentArguments[0]).toMatchObject({
      model: baseConfig.model.name,
      temperature: 0.4,
      topP: 0.8,
      stopWhen: { type: 'step-count', steps: 10 },
    });
    expect(aiMocks.agentArguments[0]).not.toMatchObject({
      messages: [],
      apiKey: 'secret',
      baseURL: 'https://wrong.invalid',
    });
  });

  it('passes structured history and user input to agent.generate messages', async () => {
    const history = [
      { role: 'system' as const, content: 'filtered system' },
      { role: 'user' as const, content: 'earlier question' },
      { role: 'assistant' as const, content: 'earlier answer' },
    ];
    await createVercelAgentsHandler()(baseConfig as any, 'follow up', {}, {}, history);
    expect(aiMocks.generate).toHaveBeenCalledWith({
      messages: [
        { role: 'user', content: 'earlier question' },
        { role: 'assistant', content: 'earlier answer' },
        { role: 'user', content: 'follow up' },
      ],
    });
    expect(JSON.stringify(aiMocks.agentArguments[0].instructions)).not.toContain('Conversation History');
  });

  it('maps multimodal root history to native AI SDK image parts', async () => {
    const history = [
      {
        role: 'user' as const,
        content: [
          { type: 'text' as const, text: 'Describe this.' },
          { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/jpeg', data: 'YWJj' } },
        ],
      },
    ];
    await createVercelAgentsHandler()(baseConfig as any, '', {}, {}, history);
    const content = aiMocks.generate.mock.calls[0][0].messages[0].content;
    expect(content[0]).toEqual({ type: 'text', text: 'Describe this.' });
    expect(content[1]).toMatchObject({ type: 'image', mediaType: 'image/jpeg' });
    expect(content[1].image).toBeInstanceOf(Uint8Array);
    expect(aiMocks.generate.mock.calls[0][0].messages).toHaveLength(1);
  });

  it('includes only callable tools and delegates execution to supplied handlers', async () => {
    const weather = vi.fn().mockResolvedValue({ temperature: 72 });
    const config = {
      ...baseConfig,
      tools: {
        weather: {
          name: 'weather',
          type: 'function',
          description: 'Weather lookup',
          parameters: { type: 'object', properties: { city: { type: 'string' } } },
        },
        missing: { name: 'missing', type: 'function', parameters: { type: 'object' } },
      },
    };
    aiMocks.generate.mockImplementation(async () => {
      await aiMocks.agentArguments[0].tools.weather.execute({ city: 'Austin' }, { toolCallId: 'call-1' });
      return agentResult('72');
    });
    await createVercelAgentsHandler()(config as any, 'weather?', { weather });
    expect(Object.keys(aiMocks.agentArguments[0].tools)).toEqual(['weather']);
    expect(aiMocks.jsonSchema).toHaveBeenCalledWith(config.tools.weather.parameters);
    expect(weather).toHaveBeenCalledWith({ city: 'Austin' });
  });

  it('uses native structured output for blocking agent generation', async () => {
    aiMocks.generate.mockResolvedValue({
      ...agentResult('', 4, 2),
      output: { result: 'structured' },
    });
    const schema = {
      type: 'object',
      properties: { result: { type: 'string' } },
      required: ['result'],
      additionalProperties: false,
    };
    const result = await createVercelAgentsHandler()({ ...baseConfig, outputFormat: schema } as any, 'q');
    expect(aiMocks.agentArguments[0].output).toEqual({ kind: 'object', schema: { schema } });
    expect(result.output).toBe('{"result":"structured"}');
  });

  it('normalizes the AI Config json_schema descriptor into JSON Schema', async () => {
    const schema = { type: 'json_schema', properties: { result: { type: 'string' } } };
    await createVercelAgentsHandler()({ ...baseConfig, outputFormat: schema } as any, 'q');
    expect(aiMocks.jsonSchema).toHaveBeenCalledWith({
      ...schema,
      type: 'object',
      required: ['result'],
      additionalProperties: false,
    });
  });

  it('supplies the required and additionalProperties that strict providers demand', async () => {
    const schema = { type: 'object', properties: { result: { type: 'string' }, source: { type: 'string' } } };
    await createVercelAgentsHandler()({ ...baseConfig, outputFormat: schema } as any, 'q');
    expect(aiMocks.jsonSchema).toHaveBeenCalledWith({
      ...schema,
      required: ['result', 'source'],
      additionalProperties: false,
    });
  });

  it('widens a partial required list, which strict providers also reject', async () => {
    const schema = {
      type: 'object',
      properties: { result: { type: 'string' }, source: { type: 'string' } },
      required: ['result'],
    };
    await createVercelAgentsHandler()({ ...baseConfig, outputFormat: schema } as any, 'q');
    expect(aiMocks.jsonSchema).toHaveBeenCalledWith({
      ...schema,
      required: ['result', 'source'],
      additionalProperties: false,
    });
  });

  it('normalizes aggregate agent usage', async () => {
    aiMocks.generate.mockResolvedValue({
      text: 'done',
      usage: { inputTokens: 9, outputTokens: 5, totalTokens: 14 },
      steps: [{ usage: { inputTokens: 4, outputTokens: 2 } }, { usage: { inputTokens: 5, outputTokens: 3 } }],
    });
    const result = await createVercelAgentsHandler()(baseConfig as any, 'q');
    expect(result.usage).toEqual({ input_tokens: 9, output_tokens: 5, total_tokens: 14 });
  });

  it('uses evaluated provider telemetry, preserves the gateway model id, and disables runtime telemetry', async () => {
    await createVercelAgentsHandler()(baseConfig as any, 'q');
    const chat = spanMocks.children.find(({ name }) => name === `chat ${baseConfig.model.name}`)?.span;
    expect(chat?.setAttribute).toHaveBeenCalledWith('gen_ai.system', 'openai');
    expect(chat?.setAttribute).toHaveBeenCalledWith('gen_ai.provider.name', 'openai');
    expect(chat?.setAttribute).toHaveBeenCalledWith('gen_ai.request.model', 'openai/gpt-5');
    expect(aiMocks.agentArguments[0]).not.toHaveProperty('experimental_telemetry');
  });

  it('uses ToolLoopAgent.stream and emits ordered chunks plus one done event', async () => {
    aiMocks.stream.mockReturnValue({
      textStream: (async function* () {
        yield 'agent ';
        yield 'answer';
      })(),
      usage: Promise.resolve({ inputTokens: 3, outputTokens: 2, totalTokens: 5 }),
    });
    const events = await collect(
      createVercelAgentsHandler().stream?.(baseConfig as any, 'q', {}, {}) as AsyncIterable<any>,
    );
    expect(aiMocks.stream).toHaveBeenCalledWith({ messages: [{ role: 'user', content: 'q' }] });
    expect(events).toEqual([
      { type: 'chunk', text: 'agent ' },
      { type: 'chunk', text: 'answer' },
      {
        type: 'done',
        output: 'agent answer',
        usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
      },
    ]);
  });

  it('cancels an early-exited agent stream and closes the root span', async () => {
    const returnSpy = vi.fn().mockResolvedValue({ done: true });
    const iterator = {
      next: vi.fn().mockResolvedValueOnce({ done: false, value: 'first' }),
      return: returnSpy,
    };
    aiMocks.stream.mockReturnValue({
      textStream: { [Symbol.asyncIterator]: () => iterator },
      usage: Promise.resolve({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
    });
    const stream = createVercelAgentsHandler().stream?.(baseConfig as any, 'q', {}, {});
    for await (const event of stream as AsyncIterable<any>) {
      expect(event).toEqual({ type: 'chunk', text: 'first' });
      break;
    }
    expect(returnSpy).toHaveBeenCalledOnce();
    expect(spanMocks.root.end).toHaveBeenCalledOnce();
  });

  it('pre-wires vercelAgents through config()', async () => {
    const invoke = vi.fn().mockResolvedValue({ response: 'ok', usage: {} });
    serverMocks.config.mockReturnValue({ invoke });
    const context = { kind: 'user', key: 'u1' };
    await vercelAgents('flag-key', 'hello', context as any, {});
    expect(serverMocks.config).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'flag-key',
        handler: expect.objectContaining({ providesFor: ['*', 'agent'] }),
      }),
    );
    expect(invoke).toHaveBeenCalledWith('hello', context, undefined);
  });
});
