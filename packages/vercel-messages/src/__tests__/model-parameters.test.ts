import { createOpenAI } from '@ai-sdk/openai';
import { createGateway, generateText } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { createVercelMessagesHandler } from '../handler.js';
import { buildModelParameterOptions } from '../model-parameters.js';
import { expectNoNeverForwardedValue, NEVER_FORWARDED_PARAMETERS } from './never-forwarded.js';

// This file deliberately does NOT mock `ai`: it checks what reaches the provider's HTTP request.

type SeenHeaders = Record<string, string>[];

function capturingFetch(seen: SeenHeaders): typeof globalThis.fetch {
  return (async (_url: unknown, init?: RequestInit) => {
    seen.push(Object.fromEntries(new Headers(init?.headers).entries()));
    return new Response(JSON.stringify({ error: { message: 'captured' } }), { status: 401 });
  }) as typeof globalThis.fetch;
}

const attackerParameters = {
  headers: { Authorization: 'Bearer ATTACKER' },
  extra_headers: { Authorization: 'Bearer ATTACKER' },
  provider_options: { gateway: { byok: { openai: [{ apiKey: 'ATTACKER' }] }, order: ['attacker'] } },
};

function config(parameters: Record<string, unknown>) {
  return {
    model: { name: 'openai/gpt-4o', parameters },
    provider: { name: 'OpenAI' },
    instructions: 'You are helpful.',
  };
}

describe('model.parameters cannot change how the request authenticates', () => {
  it('keeps the customer API key on @ai-sdk/openai when a config sets an Authorization header', async () => {
    const seen: SeenHeaders = [];
    const provider = createOpenAI({ apiKey: 'CUSTOMER', fetch: capturingFetch(seen) });
    await expect(
      createVercelMessagesHandler({ model: provider('gpt-4o') })(config(attackerParameters) as any, 'hi'),
    ).rejects.toThrow();
    expect(seen.length).toBeGreaterThan(0);
    for (const headers of seen) {
      expect(headers.authorization).toBe('Bearer CUSTOMER');
    }
  });

  it('keeps the customer API key on the Vercel AI Gateway when a config sets an Authorization header', async () => {
    const seen: SeenHeaders = [];
    const gateway = createGateway({ apiKey: 'CUSTOMER', fetch: capturingFetch(seen) });
    await expect(
      createVercelMessagesHandler({ model: gateway('openai/gpt-4o') })(config(attackerParameters) as any, 'hi'),
    ).rejects.toThrow();
    expect(seen.length).toBeGreaterThan(0);
    for (const headers of seen) {
      expect(headers.authorization).toBe('Bearer CUSTOMER');
    }
  });

  // Jeff's repro from the review, inverted: the options built from a config that sets
  // `headers.Authorization` no longer replace the provider's own key.
  it('buildModelParameterOptions output spread into generateText does not override the provider key', async () => {
    const seen: SeenHeaders = [];
    const provider = createOpenAI({ apiKey: 'CUSTOMER', fetch: capturingFetch(seen) });
    const opts = buildModelParameterOptions({ headers: { Authorization: 'Bearer ATTACKER' } } as never);
    await generateText({ model: provider('gpt-4o'), prompt: 'hi', maxRetries: 0, ...opts }).catch(() => {});
    expect(seen[0]?.authorization).toBe('Bearer CUSTOMER');
  });
});

describe('buildModelParameterOptions allowlist', () => {
  it('drops every never-forwarded key', () => {
    const options = buildModelParameterOptions({ ...NEVER_FORWARDED_PARAMETERS, temperature: 0.5 } as never);
    expect(options).toEqual({ temperature: 0.5 });
    expectNoNeverForwardedValue(options);
  });

  it('never-forwarded keys do not reach the model call', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new Error('aborted: request captured');
      },
    });
    await expect(
      createVercelMessagesHandler({ model })(config(NEVER_FORWARDED_PARAMETERS) as any, 'hi'),
    ).rejects.toThrow();
    expect(model.doGenerateCalls).toHaveLength(1);
    // The AI SDK sets its own `headers` (user agent) on every call; the deep check still proves
    // none of the config's values reached it.
    expectNoNeverForwardedValue(model.doGenerateCalls[0], ['headers']);
  });

  it('forwards the allowed keys under the AI SDK names', () => {
    expect(
      buildModelParameterOptions({
        temperature: 0.2,
        top_p: 0.9,
        top_k: 40,
        presence_penalty: 0.1,
        frequency_penalty: 0.3,
        stop_sequences: ['END'],
        seed: 7,
        max_tokens: 100,
        reasoning_effort: 'low',
        tool_choice: 'auto',
      } as never),
    ).toEqual({
      temperature: 0.2,
      topP: 0.9,
      topK: 40,
      presencePenalty: 0.1,
      frequencyPenalty: 0.3,
      stopSequences: ['END'],
      seed: 7,
      maxOutputTokens: 100,
      reasoning: 'low',
      toolChoice: 'auto',
    });
  });
});
