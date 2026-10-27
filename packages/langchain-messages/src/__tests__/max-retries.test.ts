import { beforeEach, describe, expect, it, vi } from 'vitest';

// `maxRetries` reaches the chat model the handler builds, and only when set (TESTING.md §1.1a).
// The real LangChain classes are constructed, so the assertions read each model's own retry count.
// Only `invoke` and `stream` are replaced, so no test reaches a provider.

type Built = { cls: string; args: Record<string, unknown>; model: { caller: { maxRetries: number } } };

const { built } = vi.hoisted(() => ({ built: [] as Built[] }));

async function recording<T extends new (...args: any[]) => object>(
  Real: T,
  cls: string,
  required: Record<string, unknown>,
): Promise<T> {
  const { AIMessage, AIMessageChunk } = await import('@langchain/core/messages');
  // A mixin over three unrelated LangChain classes, so the base is typed loosely.
  return class extends (Real as any) {
    constructor(args: Record<string, unknown>) {
      super({ ...required, ...args });
      built.push({ cls, args, model: this as unknown as Built['model'] });
    }
    async invoke() {
      return new AIMessage({ content: 'hi' });
    }
    async stream() {
      return (async function* () {
        yield new AIMessageChunk({ content: 'hi' });
      })();
    }
  } as unknown as T;
}

vi.mock('@langchain/openai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@langchain/openai')>();
  return { ...actual, ChatOpenAI: await recording(actual.ChatOpenAI, 'ChatOpenAI', { apiKey: 'test-key' }) };
});

vi.mock('@langchain/anthropic', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@langchain/anthropic')>();
  return {
    ...actual,
    ChatAnthropic: await recording(actual.ChatAnthropic, 'ChatAnthropic', { apiKey: 'test-key' }),
  };
});

vi.mock('@langchain/aws', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@langchain/aws')>();
  return {
    ...actual,
    ChatBedrockConverse: await recording(actual.ChatBedrockConverse, 'ChatBedrockConverse', {
      region: 'us-east-1',
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    }),
  };
});

vi.mock('@launchdarkly/ai-server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@launchdarkly/ai-server')>();
  return {
    ...actual,
    configInternal: vi.fn().mockReturnValue({ invoke: vi.fn().mockResolvedValue({ response: 'ok', usage: {} }) }),
  };
});

import { ChatAnthropic } from '@langchain/anthropic';
import { ChatBedrockConverse } from '@langchain/aws';
import { ChatOpenAI } from '@langchain/openai';
import { configInternal } from '@launchdarkly/ai-server';
import { createLangChainMessagesHandler, langchainMessages } from '../handler.js';

const configFor = (provider: string, name: string, parameters?: Record<string, unknown>) => ({
  model: { name, ...(parameters ? { parameters } : {}) },
  provider: { name: provider },
  instructions: 'You are helpful.',
});

describe('createLangChainMessagesHandler — maxRetries (§1.1a)', () => {
  beforeEach(() => {
    built.length = 0;
    vi.mocked(configInternal).mockClear();
  });

  it.each([
    ['OpenAI', 'gpt-4o', 'ChatOpenAI'],
    ['Anthropic', 'claude-sonnet-4-5', 'ChatAnthropic'],
    ['Bedrock', 'anthropic.claude-sonnet-4-5', 'ChatBedrockConverse'],
  ])('passes the value to the %s model the handler builds', async (provider, name, cls) => {
    await createLangChainMessagesHandler(undefined, { maxRetries: 7 })(configFor(provider, name) as never, 'q', {}, {});
    expect(built).toHaveLength(1);
    expect(built[0].cls).toBe(cls);
    expect(built[0].model.caller.maxRetries).toBe(7);
  });

  it.each([
    ['OpenAI', 'gpt-4o', ChatOpenAI],
    ['Anthropic', 'claude-sonnet-4-5', ChatAnthropic],
    ['Bedrock', 'anthropic.claude-sonnet-4-5', ChatBedrockConverse],
  ] as const)('keeps the vendor default for %s when omitted', async (provider, name, Cls) => {
    await createLangChainMessagesHandler()(configFor(provider, name) as never, 'q', {}, {});
    expect(built[0].args).not.toHaveProperty('maxRetries');
    // Compared with a model built without the option, so the test does not hard-code LangChain's
    // default. The recording subclass supplies credentials, so it builds the reference model too.
    const vendorDefault = (new (Cls as any)({ model: name }) as Built['model']).caller.maxRetries;
    built.length = 1;
    expect(built[0].model.caller.maxRetries).toBe(vendorDefault);
  });

  it('honours an explicit 0 from the caller', async () => {
    await createLangChainMessagesHandler(undefined, { maxRetries: 0 })(
      configFor('OpenAI', 'gpt-4o') as never,
      'q',
      {},
      {},
    );
    expect(built[0].model.caller.maxRetries).toBe(0);
  });

  it.each([
    null,
    true,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    '3',
    -1,
  ])('refuses %s at construction, naming the option', (value) => {
    expect(() => createLangChainMessagesHandler(undefined, { maxRetries: value as never })).toThrow(/maxRetries/);
  });

  it('cannot be set by model.parameters', async () => {
    const config = configFor('OpenAI', 'gpt-4o', { max_retries: 50, maxRetries: 50 });
    await createLangChainMessagesHandler(undefined, { maxRetries: 3 })(config as never, 'q', {}, {});
    expect(built[0].args.maxRetries).toBe(3);
    expect(built[0].model.caller.maxRetries).toBe(3);
  });

  it('reaches the model on both invoke and stream', async () => {
    const handler = createLangChainMessagesHandler(undefined, { maxRetries: 7 });
    const config = configFor('OpenAI', 'gpt-4o');
    await handler(config as never, 'q', {}, {});
    for await (const _event of handler.stream?.(config as never, 'q', {}, {}) ?? []) {
      // drain
    }
    expect(built).toHaveLength(2);
    expect(built.map(({ model }) => model.caller.maxRetries)).toEqual([7, 7]);
  });

  it.each([
    ['a model instance', {} as never],
    ['a model factory', (() => ({})) as never],
  ])('is refused alongside %s passed as llm', (_label, llm) => {
    expect(() => createLangChainMessagesHandler(llm, { maxRetries: 7 })).toThrow(/maxRetries/);
  });

  it('is forwarded by the convenience export and not passed to config()', async () => {
    await langchainMessages('my-flag', 'hello', { kind: 'user', key: 'u' }, { maxRetries: 6 });
    const { handler } = vi.mocked(configInternal).mock.calls[0][0] as {
      handler: ReturnType<typeof createLangChainMessagesHandler>;
    };
    expect(vi.mocked(configInternal).mock.calls[0][0]).not.toHaveProperty('maxRetries');
    await handler(configFor('OpenAI', 'gpt-4o') as never, 'q', {}, {});
    expect(built[0].model.caller.maxRetries).toBe(6);
  });
});
