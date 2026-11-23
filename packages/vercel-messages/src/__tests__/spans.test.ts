import { context, SpanStatusCode, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unlike `handler.test.ts`, this file mocks neither `ai` nor `@opentelemetry/api`: the real AI SDK
 * runs the tool loop against a mock language model, and a real tracer exports the spans. That is
 * what shows how the AI SDK treats a tool whose `execute` throws, which the mocked tests cannot.
 */

import { shutdown } from '@launchdarkly/ai-server';
import { createVercelMessagesHandler } from '../handler.js';

const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
const contextManager = new AsyncLocalStorageContextManager();

const config = {
  model: { name: 'openai/gpt-5' },
  provider: { name: 'OpenAI' },
  instructions: 'You are helpful.',
  tools: {
    okTool: { name: 'okTool', type: 'function' as const, parameters: { type: 'object', properties: {} } },
    badTool: { name: 'badTool', type: 'function' as const, parameters: { type: 'object', properties: {} } },
  },
};

const usage = {
  inputTokens: { total: 5, noCache: 5, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 2, text: 2, reasoning: undefined },
};
const toolCalls = [
  { type: 'tool-call' as const, toolCallId: 'call_ok', toolName: 'okTool', input: '{}' },
  { type: 'tool-call' as const, toolCallId: 'call_bad', toolName: 'badTool', input: '{}' },
];

/** First turn calls both tools; the second answers with text. */
function twoTurnModel() {
  let turn = 0;
  return new MockLanguageModelV4({
    doGenerate: async () =>
      turn++ === 0
        ? { content: toolCalls, finishReason: { unified: 'tool-calls', raw: undefined }, usage, warnings: [] }
        : {
            content: [{ type: 'text', text: 'done' }],
            finishReason: { unified: 'stop', raw: undefined },
            usage,
            warnings: [],
          },
    doStream: async () => ({
      stream: convertArrayToReadableStream(
        turn++ === 0
          ? [...toolCalls, { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage }]
          : [
              { type: 'text-start', id: 't' },
              { type: 'text-delta', id: 't', delta: 'done' },
              { type: 'text-end', id: 't' },
              { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage },
            ],
      ),
    }),
  } as never);
}

const handlers = (failure: unknown = new Error('tool broke')) => ({
  okTool: vi.fn().mockResolvedValue('fine'),
  badTool: vi.fn().mockRejectedValue(failure),
});

const named = (name: string) => exporter.getFinishedSpans().filter((s) => s.name === name);

/** The AI SDK answers a thrown `execute` to the model as a tool error, so the run continues. */
function assertToolSpans(model: MockLanguageModelV4, calls: 'doGenerateCalls' | 'doStreamCalls') {
  const [ok] = named('execute_tool okTool');
  const [bad] = named('execute_tool badTool');
  expect(ok.status.code).toBe(SpanStatusCode.OK);
  expect(ok.attributes['error.type']).toBeUndefined();
  expect(ok.attributes['gen_ai.tool.call.result']).toBe('fine');
  expect(bad.status.code).toBe(SpanStatusCode.ERROR);
  expect(bad.attributes['error.type']).toBe('tool_error');
  expect(bad.attributes['gen_ai.tool.call.result']).toBeUndefined();
  expect(bad.events.map((e) => e.name)).toContain('exception');
  // The second model call received the failure as a tool error result.
  expect(model[calls]).toHaveLength(2);
  expect(JSON.stringify(model[calls][1].prompt)).toContain('tool broke');
  expect(named('invoke_agent')[0].status.code).toBe(SpanStatusCode.OK);
}

describe('vercel-messages tool spans against a real tracer and the real AI SDK', () => {
  beforeAll(() => {
    contextManager.enable();
    context.setGlobalContextManager(contextManager);
    trace.setGlobalTracerProvider(provider);
  });

  afterAll(async () => {
    context.disable();
    await provider.shutdown();
  });

  beforeEach(() => exporter.reset());

  afterEach(() => shutdown());

  describe('a failed tool call', () => {
    it('ends an aborted tool call ERROR without tool_error', async () => {
      const model = twoTurnModel();
      const result = await createVercelMessagesHandler({ model, captureContent: true })(
        config as never,
        'q',
        handlers(new DOMException('aborted', 'AbortError')),
      );

      // The AI SDK answers the abort to the model like any other tool error.
      expect(result.output).toBe('done');
      const [bad] = named('execute_tool badTool');
      expect(bad.status.code).toBe(SpanStatusCode.ERROR);
      expect(bad.attributes['error.type']).toBeUndefined();
      expect(bad.events.map((e) => e.name)).toContain('exception');
      expect(named('execute_tool okTool')[0].attributes['error.type']).toBeUndefined();
    });

    it('marks the failing execute_tool span tool_error, leaves the succeeding one clean, and keeps running', async () => {
      const model = twoTurnModel();
      const result = await createVercelMessagesHandler({ model, captureContent: true })(
        config as never,
        'q',
        handlers(),
      );

      expect(result.output).toBe('done');
      assertToolSpans(model, 'doGenerateCalls');
    });

    it('does the same on the streaming path', async () => {
      const model = twoTurnModel();
      const events: Array<{ type: string; output?: string }> = [];
      const gen = createVercelMessagesHandler({ model, captureContent: true }).stream?.(
        config as never,
        'q',
        handlers(),
        {},
      ) as AsyncGenerator<{ type: string; output?: string }>;
      for await (const event of gen) events.push(event);

      expect(events.at(-1)).toMatchObject({ type: 'done', output: 'done' });
      assertToolSpans(model, 'doStreamCalls');
    });
  });
});
