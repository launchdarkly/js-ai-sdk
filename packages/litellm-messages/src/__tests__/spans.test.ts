import { context, SpanStatusCode, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLiteLLMMessagesHandler } from '../handler.js';

/**
 * Unlike `handler.test.ts`, this file does not mock `@opentelemetry/api`: a real
 * `BasicTracerProvider` exports real spans, so the assertions are about the emitted spans
 * themselves. The proxy client is injected through the handler's own `client` option.
 *
 * The `AsyncLocalStorageContextManager` mirrors the one `client/src/lifecycle.ts` registers in
 * production; without it the non-streaming tree flattens into unrelated root spans.
 */

const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
const contextManager = new AsyncLocalStorageContextManager();

const baseConfig = {
  instructions: 'You are helpful.',
  model: { name: 'anthropic/claude-sonnet-4' },
  provider: { name: 'Anthropic' },
};

const tool = (name: string) => ({ name, parameters: {}, type: 'function' as const });

const toolCompletion = (id: string, name: string) => ({
  choices: [
    {
      finish_reason: 'tool_calls',
      message: {
        content: null,
        role: 'assistant',
        tool_calls: [{ function: { arguments: `{"q":"${name}"}`, name }, id, index: 0, type: 'function' }],
      },
    },
  ],
  usage: { completion_tokens: 1, prompt_tokens: 3, total_tokens: 4 },
});

const toolStream = (id: string, name: string) => ({
  controller: { abort: vi.fn() },
  async *[Symbol.asyncIterator]() {
    yield {
      choices: [{ delta: { tool_calls: [{ function: { arguments: `{"q":"${name}"}`, name }, id, index: 0 }] } }],
    };
  },
});

const clientWith = (create: ReturnType<typeof vi.fn>) => ({ chat: { completions: { create } } }) as never;

const collectStream = async (gen: AsyncGenerator<unknown>) => {
  const out: unknown[] = [];
  for await (const e of gen) out.push(e);
  return out;
};

const named = (prefix: string) => exporter.getFinishedSpans().filter((s) => s.name.startsWith(prefix));

describe('litellm-messages spans against a real tracer', () => {
  beforeAll(() => {
    contextManager.enable();
    context.setGlobalContextManager(contextManager);
    trace.setGlobalTracerProvider(provider);
  });

  afterAll(async () => {
    context.disable();
    await provider.shutdown();
  });

  beforeEach(() => {
    exporter.reset();
  });

  describe('a failed tool call', () => {
    const twoToolConfig = { ...baseConfig, tools: { okTool: tool('okTool'), badTool: tool('badTool') } };
    const handlers = () => ({
      okTool: vi.fn().mockReturnValue('fine'),
      badTool: vi.fn().mockRejectedValue(new Error('tool broke')),
    });

    // A tool failure aborts the run here, so the succeeding call is in the turn before it.
    const assertToolSpans = () => {
      const ok = named('execute_tool okTool')[0];
      const bad = named('execute_tool badTool')[0];
      expect(ok.status.code).toBe(SpanStatusCode.OK);
      expect(ok.attributes['error.type']).toBeUndefined();
      expect(ok.attributes['gen_ai.tool.call.result']).toBe('fine');
      expect(bad.status.code).toBe(SpanStatusCode.ERROR);
      expect(bad.attributes['error.type']).toBe('tool_error');
      expect(bad.attributes['gen_ai.tool.call.result']).toBeUndefined();
      expect(bad.events.map((e) => e.name)).toContain('exception');
    };

    it('marks the failing execute_tool span tool_error and leaves the succeeding one clean', async () => {
      const create = vi
        .fn()
        .mockResolvedValueOnce(toolCompletion('call_ok', 'okTool'))
        .mockResolvedValueOnce(toolCompletion('call_bad', 'badTool'));

      await expect(
        createLiteLLMMessagesHandler({ client: clientWith(create), captureContent: true })(
          twoToolConfig as never,
          'q',
          handlers(),
        ),
      ).rejects.toThrow('tool broke');

      assertToolSpans();
    });

    it('does the same on the streaming path', async () => {
      const create = vi
        .fn()
        .mockResolvedValueOnce(toolStream('call_ok', 'okTool'))
        .mockResolvedValueOnce(toolStream('call_bad', 'badTool'));

      const gen = createLiteLLMMessagesHandler({ client: clientWith(create), captureContent: true }).stream?.(
        twoToolConfig as never,
        'q',
        handlers(),
        {},
      ) as AsyncGenerator<unknown>;
      await expect(collectStream(gen)).rejects.toThrow('tool broke');

      assertToolSpans();
    });
  });
});
