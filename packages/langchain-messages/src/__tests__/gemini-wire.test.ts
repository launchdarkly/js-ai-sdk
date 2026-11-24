import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLangChainMessagesHandler } from '../handler.js';

// Like wire.test.ts for ChatOpenAI, this file does NOT mock @langchain/google-genai. Every other
// Gemini test mocks the class or stubs `invoke` / `stream`, so the thought-signature key shape, the
// ToolMessage pairing, `thinkingConfig` on the wire and streamed usage summing are only checked
// against the real client here, with its outgoing fetch intercepted.

type Captured = { url: string; body: Record<string, any> };

const captured: Captured[] = [];

const SIGNATURE = 'SIG-FROM-GEMINI';

const toolCallReply = {
  candidates: [
    {
      content: {
        role: 'model',
        parts: [{ functionCall: { name: 'get_weather', args: { city: 'Paris' } }, thoughtSignature: SIGNATURE }],
      },
      finishReason: 'STOP',
    },
  ],
  usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4, totalTokenCount: 14 },
};

const textReply = (text: string) => ({
  candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }],
  usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 3, totalTokenCount: 23 },
});

const sse = (chunks: unknown[]) =>
  new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

const stubFetch = (replies: Array<(url: string) => Response>) => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown, init?: RequestInit) => {
      const href = String(url instanceof Request ? url.url : url);
      captured.push({ url: href, body: JSON.parse(String(init?.body)) });
      const reply = replies[captured.length - 1];
      if (!reply) throw new Error(`unexpected request ${captured.length}`);
      return reply(href);
    }),
  );
};

beforeEach(() => {
  captured.length = 0;
  vi.stubEnv('GOOGLE_API_KEY', 'CUSTOMER');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const config = {
  model: {
    name: 'gemini-3-pro-preview',
    parameters: { thinking_config: { thinking_budget: 64 }, max_tokens: 256 },
  },
  provider: { name: 'gemini' },
  instructions: 'You are helpful.',
  tools: {
    get_weather: {
      name: 'get_weather',
      type: 'function' as const,
      description: 'Weather for a city',
      parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
    },
  },
};

const modelTurns = () => captured.map((request) => request.body.contents as Array<{ role: string; parts: any[] }>);

const expectSecondTurnCarriesSignature = () => {
  expect(captured).toHaveLength(2);
  const history = modelTurns()[1];
  const callIndex = history.findIndex((turn) => turn.role === 'model' && turn.parts.some((part) => part.functionCall));
  expect(callIndex).toBeGreaterThanOrEqual(0);
  // The real signature, not the placeholder the client substitutes for gemini-3 when it is lost.
  expect(history[callIndex].parts.find((part) => part.functionCall)).toMatchObject({
    functionCall: { name: 'get_weather', args: { city: 'Paris' } },
    thoughtSignature: SIGNATURE,
  });
  // The ToolMessage is sent straight after the call it answers, as a functionResponse for it.
  expect(history[callIndex + 1].parts).toEqual([
    expect.objectContaining({ functionResponse: expect.objectContaining({ name: 'get_weather' }) }),
  ]);
  expect(JSON.stringify(history[callIndex + 1].parts[0].functionResponse.response)).toContain('22C');
};

describe('createLangChainMessagesHandler wire request (real ChatGoogleGenerativeAI, unmocked)', () => {
  it('sends thinkingConfig, then returns the thought signature with the paired tool result', async () => {
    stubFetch([() => json(toolCallReply), () => json(textReply('Sunny, 22C'))]);
    const getWeather = vi.fn(async () => '22C');

    const result = await createLangChainMessagesHandler()(config as never, 'Weather in Paris?', {
      get_weather: getWeather,
    });

    expect(captured[0].url).toContain('gemini-3-pro-preview:generateContent');
    expect(captured[0].body.generationConfig).toMatchObject({
      thinkingConfig: { thinkingBudget: 64 },
      maxOutputTokens: 256,
    });
    expect(getWeather).toHaveBeenCalledWith({ city: 'Paris' });
    expectSecondTurnCarriesSignature();
    expect(result.output).toBe('Sunny, 22C');
    expect(result.usage).toEqual({ input_tokens: 30, output_tokens: 7 });
  }, 10000);

  it('streams the same two turns and sums usage from cumulative chunk counts', async () => {
    stubFetch([
      () => sse([toolCallReply]),
      () =>
        sse([
          {
            candidates: [{ content: { role: 'model', parts: [{ text: 'Sunny, ' }] } }],
            usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 1, totalTokenCount: 21 },
          },
          {
            candidates: [{ content: { role: 'model', parts: [{ text: '22C' }] }, finishReason: 'STOP' }],
            usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 3, totalTokenCount: 23 },
          },
        ]),
    ]);
    const handler = createLangChainMessagesHandler();

    let done: { output: string; usage: { input_tokens: number; output_tokens: number } } | undefined;
    for await (const event of handler.stream?.(config as never, 'Weather in Paris?', {
      get_weather: vi.fn(async () => '22C'),
    }) ?? []) {
      if (event.type === 'done') done = event as typeof done;
    }

    expect(captured[0].url).toContain('gemini-3-pro-preview:streamGenerateContent');
    expect(captured[0].body.generationConfig).toMatchObject({ thinkingConfig: { thinkingBudget: 64 } });
    expectSecondTurnCarriesSignature();
    expect(done?.output).toBe('Sunny, 22C');
    // The client turns Gemini's cumulative counts into per-chunk deltas; summed, they must equal
    // the final counts of each turn (10 + 20 in, 4 + 3 out), not the sum of every chunk's total.
    expect(done?.usage).toEqual({ input_tokens: 30, output_tokens: 7 });
  }, 10000);
});
