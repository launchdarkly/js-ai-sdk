import { type Agent, Runner } from '@openai/agents';
import { context, SpanStatusCode, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLiteLLMAgentsHandler } from '../handler.js';

/**
 * Unlike `handler.test.ts`, this file mocks neither `@opentelemetry/api` nor the Agents SDK.
 *
 * The real `Agent`, `Runner` and `OpenAIChatCompletionsModel` run against a real tracer; only the
 * network seam is faked, through the handler's own `client` option. The tool lifecycle is
 * therefore the SDK's own `agent_tool_start`/`agent_tool_end` emissions, not a hand-driven stub.
 */

const completionQueue: unknown[] = [];
const fakeClient = {
  baseURL: 'http://litellm.test/v1',
  chat: {
    completions: {
      create: async () => {
        const next = completionQueue.shift();
        if (next === undefined) throw new Error('fake client: completion queue is empty');
        return next;
      },
    },
  },
};

const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
const contextManager = new AsyncLocalStorageContextManager();

const toolDefinition = (name: string) => ({
  name,
  type: 'function' as const,
  description: name,
  parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
});

const twoToolConfig = {
  model: { name: 'gpt-4o' },
  provider: { name: 'openai' },
  instructions: 'You are helpful.',
  tools: { okTool: toolDefinition('okTool'), badTool: toolDefinition('badTool') },
};

const toolTurn = (callId: string, name: string) => ({
  id: `cc_${callId}`,
  object: 'chat.completion',
  created: 0,
  model: 'gpt-4o',
  choices: [
    {
      index: 0,
      finish_reason: 'tool_calls',
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: callId, type: 'function', function: { name, arguments: '{"q":"test"}' } }],
      },
    },
  ],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
});

const spans = () => exporter.getFinishedSpans();
const named = (prefix: string) => spans().filter((s) => s.name.startsWith(prefix));

describe('litellm-agents span tree against the real Runner', () => {
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
    vi.restoreAllMocks();
    exporter.reset();
    completionQueue.length = 0;
  });

  describe('a failed tool call', () => {
    // A tool failure aborts the run here (`errorFunction: null`), so the succeeding call is in the
    // turn before it.
    it('marks the failing execute_tool span tool_error and leaves the succeeding one clean', async () => {
      completionQueue.push(toolTurn('call_ok', 'okTool'), toolTurn('call_bad', 'badTool'));

      await expect(
        createLiteLLMAgentsHandler({ captureContent: true, client: fakeClient as never })(twoToolConfig as never, 'q', {
          okTool: vi.fn().mockReturnValue('fine'),
          badTool: vi.fn().mockRejectedValue(new Error('tool broke')),
        }),
      ).rejects.toThrow('tool broke');

      const ok = named('execute_tool okTool')[0];
      const bad = named('execute_tool badTool')[0];
      expect(ok.status.code).toBe(SpanStatusCode.OK);
      expect(ok.attributes['error.type']).toBeUndefined();
      expect(ok.attributes['gen_ai.tool.call.result']).toBe('fine');
      expect(bad.status.code).toBe(SpanStatusCode.ERROR);
      expect(bad.attributes['error.type']).toBe('tool_error');
      expect(bad.attributes['gen_ai.tool.call.result']).toBeUndefined();
      expect(bad.events.map((e) => e.name)).toContain('exception');
    });

    it('ends an aborted tool call ERROR without tool_error', async () => {
      completionQueue.push(toolTurn('call_ok', 'okTool'), toolTurn('call_bad', 'badTool'));

      await expect(
        createLiteLLMAgentsHandler({ captureContent: true, client: fakeClient as never })(twoToolConfig as never, 'q', {
          okTool: vi.fn().mockReturnValue('fine'),
          badTool: vi.fn().mockRejectedValue(new DOMException('aborted', 'AbortError')),
        }),
      ).rejects.toThrow('aborted');

      const ok = named('execute_tool okTool')[0];
      const bad = named('execute_tool badTool')[0];
      expect(ok.status.code).toBe(SpanStatusCode.OK);
      expect(ok.attributes['error.type']).toBeUndefined();
      expect(ok.attributes['gen_ai.tool.call.result']).toBe('fine');
      expect(bad.status.code).toBe(SpanStatusCode.ERROR);
      expect(bad.attributes['error.type']).toBeUndefined();
      expect(bad.attributes['gen_ai.tool.call.result']).toBeUndefined();
      expect(bad.events.map((e) => e.name)).toContain('exception');
    });

    // Abandonment is the consumer's choice, not a tool failure. The streamed run is faked, as in
    // `handler.test.ts`, because the stream handler only forwards `response.output_text.delta`
    // events, which the real chat-completions model never emits; the tool span still comes from
    // the real Agent's `agent_tool_start` emission.
    it('ends a tool span open at abandonment UNSET and marked abandoned', async () => {
      vi.spyOn(Runner.prototype, 'run').mockImplementation((async (agent: Agent) => ({
        state: { usage: {} },
        async *[Symbol.asyncIterator]() {
          agent.emit(
            'agent_tool_start',
            {} as never,
            { name: 'okTool' } as never,
            {
              toolCall: { callId: 'call_slow', name: 'okTool', arguments: '{"q":"test"}' },
            } as never,
          );
          yield { type: 'raw_model_stream_event', data: { type: 'response.output_text.delta', delta: 'Hi' } };
          yield { type: 'raw_model_stream_event', data: { type: 'response.output_text.delta', delta: 'never read' } };
        },
      })) as never);

      const gen = createLiteLLMAgentsHandler({ captureContent: true, client: fakeClient as never }).stream?.(
        twoToolConfig as never,
        'q',
        { okTool: vi.fn() },
        {},
      ) as AsyncGenerator<unknown>;
      for await (const _event of gen) break;

      const [tool] = named('execute_tool okTool');
      expect(tool.status.code).toBe(SpanStatusCode.UNSET);
      expect(tool.attributes['launchdarkly.stream.abandoned']).toBe(true);
      expect(tool.attributes['error.type']).toBeUndefined();
    });
  });
});
