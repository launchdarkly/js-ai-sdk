// ─── Wire-level tests ───────────────────────────────────────────────────────
//
// Unlike handler.test.ts, this file does NOT mock the `openai` package. It lets the real
// OpenAI SDK build a request and intercepts the outgoing HTTP call via a stubbed global
// `fetch`, so these tests prove the JSON body actually sent to the Responses API — not just
// what reaches a mocked `responses.create`.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function mockFetchResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function finalResponseBody() {
  return {
    id: 'resp_1',
    object: 'response',
    status: 'completed',
    model: 'gpt-4o',
    output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi' }] }],
    output_text: 'hi',
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

describe('createOpenAIHandler — wire-level request body', () => {
  let capturedBody: Record<string, unknown> | undefined;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    process.env.OPENAI_API_KEY = 'test-key';
    capturedBody = undefined;
    fetchMock = vi.fn(async (_url: unknown, init: RequestInit) => {
      capturedBody = JSON.parse(init.body as string);
      return mockFetchResponse(finalResponseBody());
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends max_output_tokens and drops frequency_penalty for a config that sets both Chat Completions keys', async () => {
    const { createOpenAIHandler } = await import('../handler.js');
    const config = {
      model: {
        name: 'gpt-4o',
        parameters: {
          max_tokens: 256,
          // Not a Responses API key; the LaunchDarkly UI offers it because it lists the Chat
          // Completions parameter set. Must be dropped, not sent — the real API 400s on it.
          frequency_penalty: 0.5,
        },
      },
      provider: { name: 'OpenAI' },
      instructions: 'You are helpful.',
    };

    const handler = createOpenAIHandler();
    await handler(config as any, 'hi');

    expect(fetchMock).toHaveBeenCalled();
    expect(capturedBody?.max_output_tokens).toBe(256);
    expect(capturedBody).not.toHaveProperty('max_tokens');
    expect(capturedBody).not.toHaveProperty('frequency_penalty');
  });

  it('forwards an accepted key (temperature) to the wire request', async () => {
    const { createOpenAIHandler } = await import('../handler.js');
    const config = {
      model: { name: 'gpt-4o', parameters: { temperature: 0.25 } },
      provider: { name: 'OpenAI' },
      instructions: 'You are helpful.',
    };

    const handler = createOpenAIHandler();
    await handler(config as any, 'hi');

    expect(capturedBody?.temperature).toBe(0.25);
  });

  it('forwards store (no generation effect, but does not break the handler) and drops background (would break it)', async () => {
    const { createOpenAIHandler } = await import('../handler.js');
    const config = {
      model: { name: 'gpt-4o', parameters: { store: true, background: true } },
      provider: { name: 'OpenAI' },
      instructions: 'You are helpful.',
    };

    const handler = createOpenAIHandler();
    await handler(config as any, 'hi');

    expect(capturedBody?.store).toBe(true);
    expect(capturedBody).not.toHaveProperty('background');
  });
});
