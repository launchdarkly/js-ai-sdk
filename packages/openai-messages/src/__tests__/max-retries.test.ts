import { beforeEach, describe, expect, it, vi } from 'vitest';

// `maxRetries` reaches the `OpenAI` client the factory builds, and only when set (TESTING.md §1.1a).
// The real client is constructed, so the assertions read its own retry count rather than the
// arguments a stub happened to receive.

const { built } = vi.hoisted(() => ({
  built: [] as Array<{ options: Record<string, unknown> | undefined; client: { maxRetries: number } }>,
}));

vi.mock('openai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('openai')>();
  const Real = actual.default;
  class Recording extends Real {
    constructor(options?: ConstructorParameters<typeof Real>[0]) {
      super({ apiKey: 'test-key', ...options });
      built.push({ options: options as Record<string, unknown> | undefined, client: this });
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
import { createOpenAIMessagesHandler, openaiMessages } from '../handler.js';

describe('createOpenAIMessagesHandler — maxRetries (§1.1a)', () => {
  beforeEach(() => {
    built.length = 0;
    vi.mocked(configInternal).mockClear();
  });

  it('passes the value to the constructed client', () => {
    createOpenAIMessagesHandler({ maxRetries: 7 });
    expect(built).toHaveLength(1);
    expect(built[0].client.maxRetries).toBe(7);
  });

  it('keeps the vendor default when omitted', () => {
    createOpenAIMessagesHandler();
    expect(built[0].options).not.toHaveProperty('maxRetries');
    // Compared with a client built without the option, so the test does not hard-code the default.
    const vendorDefault = new OpenAI().maxRetries;
    expect(built[0].client.maxRetries).toBe(vendorDefault);
  });

  it('honours an explicit 0 from the caller', () => {
    createOpenAIMessagesHandler({ maxRetries: 0 });
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
    expect(() => createOpenAIMessagesHandler({ maxRetries: value as never })).toThrow(/maxRetries/);
    expect(built).toHaveLength(0);
  });

  it('cannot be set by model.parameters, and the same client serves invoke and stream', async () => {
    const handler = createOpenAIMessagesHandler({ maxRetries: 3 });
    const client = built[0].client as unknown as OpenAI;
    const finalResponse = {
      id: 'resp_1',
      model: 'gpt-4o',
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'Hello!' }] }],
      output_text: 'Hello!',
      usage: { input_tokens: 1, output_tokens: 1 },
    };
    const create = vi.spyOn(client.responses, 'create').mockResolvedValue(finalResponse as never);
    const stream = vi.spyOn(client.responses, 'stream').mockReturnValue({
      [Symbol.asyncIterator]: async function* () {},
      finalResponse: vi.fn().mockResolvedValue(finalResponse),
    } as never);
    const config = {
      model: { name: 'gpt-4o', parameters: { max_retries: 50, maxRetries: 50 } },
      provider: { name: 'OpenAI' },
      instructions: 'You are helpful.',
    };

    await handler(config as never, 'q', {}, {});
    for await (const _event of handler.stream?.(config as never, 'q', {}, {}) ?? []) {
      // drain
    }

    expect(create).toHaveBeenCalledOnce();
    expect(stream).toHaveBeenCalledOnce();
    expect(built).toHaveLength(1);
    expect(client.maxRetries).toBe(3);
    // Neither the request body nor a per-request option carries the config's value.
    expect(JSON.stringify([create.mock.calls, stream.mock.calls])).not.toMatch(/max_?retries/i);
  });

  it('is forwarded by the convenience export and not passed to config()', async () => {
    await openaiMessages('my-flag', 'hello', { kind: 'user', key: 'u' }, { maxRetries: 6 });
    expect(built[0].client.maxRetries).toBe(6);
    expect(vi.mocked(configInternal).mock.calls[0][0]).not.toHaveProperty('maxRetries');
  });
});
