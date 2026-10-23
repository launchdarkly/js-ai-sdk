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

  it('drops store (data retention) and background (would break the handler) from the request body', async () => {
    const { createOpenAIHandler } = await import('../handler.js');
    const config = {
      model: { name: 'gpt-4o', parameters: { store: true, background: true } },
      provider: { name: 'OpenAI' },
      instructions: 'You are helpful.',
    };

    const handler = createOpenAIHandler();
    await handler(config as any, 'hi');

    expect(capturedBody).not.toHaveProperty('store');
    expect(capturedBody).not.toHaveProperty('background');
  });

  it('sends an object tool result to the model as JSON, not "[object Object]"', async () => {
    const toolCallBody = {
      ...finalResponseBody(),
      output: [{ type: 'function_call', name: 'weather', call_id: 'call_1', arguments: '{}' }],
      output_text: '',
    };
    const bodies: Array<Record<string, any>> = [];
    fetchMock.mockImplementation(async (_url: unknown, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string));
      return mockFetchResponse(bodies.length === 1 ? toolCallBody : finalResponseBody());
    });
    const { createOpenAIHandler } = await import('../handler.js');
    const config = {
      model: { name: 'gpt-4o' },
      provider: { name: 'OpenAI' },
      instructions: 'You are helpful.',
      tools: { weather: { name: 'weather', type: 'function' as const, parameters: {} } },
    };

    await createOpenAIHandler()(config as any, 'hi', { weather: () => ({ temp: 72, city: 'Zürich' }) });

    const output = bodies[1].input.find((item: any) => item.type === 'function_call_output');
    expect(output.output).toBe('{"temp":72,"city":"Zürich"}');
  });
});
