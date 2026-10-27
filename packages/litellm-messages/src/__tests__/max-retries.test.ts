import { beforeEach, describe, expect, it, vi } from 'vitest';

// `maxRetries` reaches the OpenAI-compatible client the handler builds, and only when set
// (TESTING.md §1.1a). The real client is constructed, so the assertions read its own retry count.
// Only `chat.completions.create` is replaced, so no test reaches a proxy.

type Built = { options: Record<string, unknown>; client: { maxRetries: number } };

const { built, mockCreate } = vi.hoisted(() => ({ built: [] as Built[], mockCreate: vi.fn() }));

vi.mock('openai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('openai')>();
  const Real = actual.default;
  class Recording extends Real {
    constructor(options: ConstructorParameters<typeof Real>[0]) {
      super(options);
      built.push({ options: options as Record<string, unknown>, client: this });
      (this.chat.completions as unknown as { create: unknown }).create = mockCreate;
    }
  }
  return { ...actual, default: Recording };
});

vi.mock('@launchdarkly/ai-server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@launchdarkly/ai-server')>();
  return {
    ...actual,
    configInternal: vi.fn().mockReturnValue({ invoke: vi.fn().mockResolvedValue({ response: 'ok', usage: {} }) }),
  };
});

import { configInternal } from '@launchdarkly/ai-server';
import OpenAI from 'openai';
import { createLiteLLMMessagesHandler, litellmMessages } from '../handler.js';

const baseURL = 'https://litellm.example.test/v1';
const config = {
  model: { name: 'anthropic/claude-sonnet-4' },
  provider: { name: 'Anthropic' },
  instructions: 'You are helpful.',
};
const completion = {
  model: 'anthropic/claude-sonnet-4',
  choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 1 },
};
const stubClient = { chat: { completions: { create: vi.fn() } } };

describe('createLiteLLMMessagesHandler — maxRetries (§1.1a)', () => {
  beforeEach(() => {
    built.length = 0;
    mockCreate.mockReset().mockResolvedValue(completion);
    vi.mocked(configInternal).mockClear();
  });

  it('passes the value to the client the handler builds', async () => {
    await createLiteLLMMessagesHandler({ baseURL, maxRetries: 7 })(config as never, 'q', {}, {});
    expect(built).toHaveLength(1);
    expect(built[0].client.maxRetries).toBe(7);
  });

  it('keeps the vendor default when omitted', async () => {
    await createLiteLLMMessagesHandler({ baseURL })(config as never, 'q', {}, {});
    expect(built[0].options).not.toHaveProperty('maxRetries');
    // Compared with a client built without the option, so the test does not hard-code the default.
    const vendorDefault = new OpenAI({ apiKey: 'test-key' }).maxRetries;
    expect(built[0].client.maxRetries).toBe(vendorDefault);
  });

  it('honours an explicit 0 from the caller', async () => {
    await createLiteLLMMessagesHandler({ baseURL, maxRetries: 0 })(config as never, 'q', {}, {});
    expect(built[0].client.maxRetries).toBe(0);
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
    expect(() => createLiteLLMMessagesHandler({ baseURL, maxRetries: value as never })).toThrow(/maxRetries/);
  });

  it('cannot be set by model.parameters', async () => {
    const withParameters = {
      ...config,
      model: { ...config.model, parameters: { max_retries: 50, maxRetries: 50, num_retries: 50 } },
    };
    await createLiteLLMMessagesHandler({ baseURL, maxRetries: 3 })(withParameters as never, 'q', {}, {});
    expect(built[0].client.maxRetries).toBe(3);
    // Neither the request body nor a per-request option carries the config's value.
    expect(JSON.stringify(mockCreate.mock.calls)).not.toMatch(/(max|num)_?retries/i);
  });

  it('reaches the client on both invoke and stream', async () => {
    const handler = createLiteLLMMessagesHandler({ baseURL, maxRetries: 7 });
    await handler(config as never, 'q', {}, {});
    mockCreate.mockResolvedValueOnce(
      (async function* () {
        yield { choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }] };
        yield { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } };
      })(),
    );
    for await (const _event of handler.stream?.(config as never, 'q', {}, {}) ?? []) {
      // drain
    }
    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(built.map(({ client }) => client.maxRetries)).toEqual([7, 7]);
  });

  it.each([
    ['client', { client: stubClient }],
    ['clientFactory', { clientFactory: () => stubClient }],
  ])('is refused alongside a caller-supplied %s', (_label, supplied) => {
    expect(() => createLiteLLMMessagesHandler({ ...supplied, maxRetries: 7 } as never)).toThrow(/maxRetries/);
  });

  it('is forwarded by the convenience export and not passed to config()', async () => {
    await litellmMessages('my-flag', 'hello', { kind: 'user', key: 'u' }, { baseURL, maxRetries: 6 });
    const args = vi.mocked(configInternal).mock.calls[0][0] as {
      handler: ReturnType<typeof createLiteLLMMessagesHandler>;
    };
    expect(args).not.toHaveProperty('maxRetries');
    await args.handler(config as never, 'q', {}, {});
    expect(built[0].client.maxRetries).toBe(6);
  });
});
