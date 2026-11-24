import { trace } from '@opentelemetry/api';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLangChainMessagesHandler } from '../handler.js';

// Like wire.test.ts for ChatOpenAI, this file does NOT mock @langchain/google-genai. Every other
// Gemini test mocks the class or stubs `invoke` / `stream`, so the thought-signature key shape, the
// ToolMessage pairing, `thinkingConfig` on the wire and streamed usage, thinking tokens included, are only checked
// against the real client here, with its outgoing fetch intercepted.

type Captured = { url: string; body: Record<string, any> };

const exporter = new InMemorySpanExporter();
const tracerProvider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });

beforeAll(() => {
  trace.setGlobalTracerProvider(tracerProvider);
});

afterAll(async () => {
  await tracerProvider.shutdown();
});

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
  usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4, thoughtsTokenCount: 5, totalTokenCount: 19 },
};

const textReply = (text: string) => ({
  candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }],
  usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 3, thoughtsTokenCount: 2, totalTokenCount: 25 },
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
  exporter.reset();
  vi.stubEnv('GOOGLE_API_KEY', 'CUSTOMER');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const config = {
  model: {
    name: 'gemini-3-pro-preview',
    parameters: { thinking_level: 'low', thinking_budget: 64, max_tokens: 256 },
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
  it('sends the thinking level, then returns the thought signature with the paired tool result', async () => {
    stubFetch([() => json(toolCallReply), () => json(textReply('Sunny, 22C'))]);
    const getWeather = vi.fn(async () => '22C');

    const result = await createLangChainMessagesHandler()(config as never, 'Weather in Paris?', {
      get_weather: getWeather,
    });

    expect(captured[0].url).toContain('gemini-3-pro-preview:generateContent');
    // thinking_level wins over thinking_budget, in the API's upper-case spelling, with no includeThoughts.
    expect(captured[0].body.generationConfig).toMatchObject({
      thinkingConfig: { thinkingLevel: 'LOW' },
      maxOutputTokens: 256,
    });
    expect(captured[0].body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'LOW' });
    expect(getWeather).toHaveBeenCalledWith({ city: 'Paris' });
    expectSecondTurnCarriesSignature();
    expect(result.output).toBe('Sunny, 22C');
    // Output counts the reply and its thinking: (4 + 5) + (3 + 2).
    expect(result.usage).toEqual({ input_tokens: 30, output_tokens: 14 });
  }, 10000);

  it('streams the same two turns and reports the same usage as invoke, thinking tokens included', async () => {
    stubFetch([
      () => sse([toolCallReply]),
      () =>
        sse([
          {
            candidates: [{ content: { role: 'model', parts: [{ text: 'Sunny, ' }] } }],
            usageMetadata: {
              promptTokenCount: 20,
              candidatesTokenCount: 1,
              thoughtsTokenCount: 2,
              totalTokenCount: 23,
            },
          },
          {
            candidates: [{ content: { role: 'model', parts: [{ text: '22C' }] }, finishReason: 'STOP' }],
            usageMetadata: {
              promptTokenCount: 20,
              candidatesTokenCount: 3,
              thoughtsTokenCount: 2,
              totalTokenCount: 25,
            },
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
    expect(captured[0].body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'LOW' });
    expectSecondTurnCarriesSignature();
    expect(done?.output).toBe('Sunny, 22C');
    // The client turns Gemini's cumulative counts into per-chunk deltas; summed, they must equal
    // the final counts of each turn, the same as invoke: 10 + 20 in, (4 + 5) + (3 + 2) out.
    expect(done?.usage).toEqual({ input_tokens: 30, output_tokens: 14 });
  }, 10000);

  it.each([
    ['invoke', false],
    ['stream', true],
  ])(
    'ends a blocked reply with no parts as content_filter with empty output, on %s',
    async (_path, streamed) => {
      // How Gemini returns a reply its safety filters block: a finish reason and no content.
      const blocked = {
        candidates: [{ finishReason: 'SAFETY' }],
        usageMetadata: { promptTokenCount: 5, totalTokenCount: 5 },
      };
      stubFetch([() => (streamed ? sse([blocked]) : json(blocked))]);
      const handler = createLangChainMessagesHandler();
      const plain = { ...config, tools: undefined };

      let output: string | undefined;
      if (streamed) {
        for await (const event of handler.stream?.(plain as never, 'Something unsafe', {}) ?? []) {
          if (event.type === 'done') output = (event as { output: string }).output;
        }
      } else {
        output = (await handler(plain as never, 'Something unsafe', {})).output;
      }

      expect(output).toBe('');
      const chat = exporter.getFinishedSpans().filter((span) => span.attributes['gen_ai.operation.name'] === 'chat');
      expect(chat).toHaveLength(1);
      expect(chat[0].attributes['gen_ai.response.finish_reasons']).toEqual(['content_filter']);
    },
    10000,
  );

  it.each([
    [2, 3],
    [0, 1],
  ])(
    'makes maxRetries + 1 requests in all, through the real client: maxRetries %i',
    async (maxRetries, requests) => {
      const failing = () => new Response(JSON.stringify({ error: { code: 500, message: 'boom' } }), { status: 500 });
      stubFetch(Array.from({ length: requests + 1 }, () => failing));
      const handler = createLangChainMessagesHandler(undefined, { maxRetries });

      await expect(handler({ ...config, tools: undefined } as never, 'Hi', {})).rejects.toThrow();
      expect(captured).toHaveLength(requests);
    },
    20000,
  );
});
