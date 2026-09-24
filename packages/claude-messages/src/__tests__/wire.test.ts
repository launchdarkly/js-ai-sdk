// ─── Wire-level tests ───────────────────────────────────────────────────────
//
// Unlike handler.test.ts, this file does NOT mock `@anthropic-ai/sdk`. It lets the real
// Anthropic SDK build a request and intercepts the outgoing HTTP call via a stubbed global
// `fetch`, so these tests prove the JSON body actually sent to the Messages API — not just
// what reaches a mocked `messages.create`.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function mockFetchResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function finalMessageBody() {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-3-5-sonnet-20241022',
    content: [{ type: 'text', text: 'hi' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

describe('createClaudeMessagesHandler — wire-level request body', () => {
  let capturedBody: Record<string, unknown> | undefined;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    process.env.ANTHROPIC_API_KEY = 'test-key';
    capturedBody = undefined;
    fetchMock = vi.fn(async (_url: unknown, init: RequestInit) => {
      capturedBody = JSON.parse(init.body as string);
      return mockFetchResponse(finalMessageBody());
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('moves a UI-offered top-level effort into output_config.effort and drops a key the Messages API top level does not accept', async () => {
    const { createClaudeMessagesHandler } = await import('../handler.js');
    const config = {
      model: { name: 'claude-3-5-sonnet-20241022', parameters: { effort: 'high' } },
      provider: { name: 'Anthropic' },
      instructions: 'You are helpful.',
    };

    const handler = createClaudeMessagesHandler();
    await handler(config as any, 'hi');

    expect(fetchMock).toHaveBeenCalled();
    expect(capturedBody).not.toHaveProperty('effort');
    expect(capturedBody?.output_config).toEqual({ effort: 'high' });
  });

  it('forwards an accepted key (temperature) and drops an unrecognized one at the wire', async () => {
    const { createClaudeMessagesHandler } = await import('../handler.js');
    const config = {
      model: { name: 'claude-3-5-sonnet-20241022', parameters: { temperature: 0.3, made_up_key: 'nope' } },
      provider: { name: 'Anthropic' },
      instructions: 'You are helpful.',
    };

    const handler = createClaudeMessagesHandler();
    await handler(config as any, 'hi');

    expect(capturedBody?.temperature).toBe(0.3);
    expect(capturedBody).not.toHaveProperty('made_up_key');
  });
});
