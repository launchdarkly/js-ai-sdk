import { SpanStatusCode, trace } from '@opentelemetry/api';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLangChainMessagesHandler } from '../handler.js';

// The real ChatGoogleGenerativeAI with its outgoing fetch intercepted, so the key the request
// carries is the one the Gemini API would see. The TypeScript class reads only GOOGLE_API_KEY,
// so the handler passes GEMINI_API_KEY itself when GOOGLE_API_KEY is unset or empty.

const exporter = new InMemorySpanExporter();
const tracerProvider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });

const sentKeys: Array<string | null> = [];

const reply = {
  candidates: [{ content: { role: 'model', parts: [{ text: 'hello' }] }, finishReason: 'STOP' }],
  usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1, totalTokenCount: 4 },
};

const config = {
  model: { name: 'gemini-2.5-flash' },
  provider: { name: 'gemini' },
  instructions: 'You are helpful.',
};

const run = (handler: ReturnType<typeof createLangChainMessagesHandler>) => handler(config as never, 'Hi', {}, {});

const drain = async (handler: ReturnType<typeof createLangChainMessagesHandler>) => {
  for await (const _event of handler.stream?.(config as never, 'Hi', {}, {}) ?? []) {
    // drain
  }
};

describe('createLangChainMessagesHandler: Gemini API key', () => {
  beforeAll(() => {
    trace.setGlobalTracerProvider(tracerProvider);
  });

  afterAll(async () => {
    await tracerProvider.shutdown();
  });

  beforeEach(() => {
    exporter.reset();
    sentKeys.length = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown, init?: RequestInit) => {
        sentKeys.push(new Headers(init?.headers).get('x-goog-api-key'));
        if (String(url).includes('streamGenerateContent')) {
          return new Response(`data: ${JSON.stringify(reply)}\n\n`, {
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
          });
        }
        return new Response(JSON.stringify(reply), { status: 200, headers: { 'content-type': 'application/json' } });
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('uses GEMINI_API_KEY when GOOGLE_API_KEY is unset', async () => {
    vi.stubEnv('GOOGLE_API_KEY', '');
    vi.stubEnv('GEMINI_API_KEY', 'from-gemini');
    const handler = createLangChainMessagesHandler();

    await run(handler);
    await drain(handler);

    expect(sentKeys).toEqual(['from-gemini', 'from-gemini']);
  });

  it('uses GOOGLE_API_KEY when both are set', async () => {
    vi.stubEnv('GOOGLE_API_KEY', 'from-google');
    vi.stubEnv('GEMINI_API_KEY', 'from-gemini');
    const handler = createLangChainMessagesHandler();

    await run(handler);
    await drain(handler);

    expect(sentKeys).toEqual(['from-google', 'from-google']);
  });

  it('fails before any request, naming both variables, and fails the root span, when neither is set', async () => {
    vi.stubEnv('GOOGLE_API_KEY', '');
    vi.stubEnv('GEMINI_API_KEY', '');
    const handler = createLangChainMessagesHandler();

    await expect(run(handler)).rejects.toThrow(/GOOGLE_API_KEY or GEMINI_API_KEY/);
    await expect(drain(handler)).rejects.toThrow(/GOOGLE_API_KEY or GEMINI_API_KEY/);

    expect(sentKeys).toEqual([]);
    const roots = exporter.getFinishedSpans().filter((span) => span.name === 'invoke_agent');
    expect(roots).toHaveLength(2);
    for (const root of roots) expect(root.status.code).toBe(SpanStatusCode.ERROR);
  });
});
