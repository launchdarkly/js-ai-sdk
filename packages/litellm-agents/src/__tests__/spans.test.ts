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

/** One assistant turn that calls every listed tool at once. */
const parallelTurn = (...calls: Array<[callId: string, name: string]>) => {
  const turn = toolTurn(calls[0][0], calls[0][1]);
  turn.choices[0].message.tool_calls = calls.map(([id, name]) => ({
    id,
    type: 'function',
    function: { name, arguments: '{"q":"test"}' },
  }));
  return turn;
};

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

    // Parallel calls: the SDK runs them with Promise.all, so one rejection fails the run while the
    // other is still running, and only the handler's failure-path closer ends the open span. The
    // run rejects with the SDK's ToolCallError, which wraps the tool's own error.
    const parallelFailure = async (failure: unknown, run: (handlers: Record<string, unknown>) => Promise<unknown>) => {
      let slowStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        slowStarted = resolve;
      });
      let releaseSlow!: (value: string) => void;
      const outcome = run({
        okTool: vi.fn(() => {
          slowStarted();
          return new Promise<string>((resolve) => {
            releaseSlow = resolve;
          });
        }),
        badTool: vi.fn(async () => {
          await started;
          throw failure;
        }),
      }).then(
        () => undefined,
        (error: unknown) => error,
      );
      const error = await outcome;
      releaseSlow('late');
      const [slow] = named('execute_tool okTool');
      const [bad] = named('execute_tool badTool');
      return { error, slow, bad };
    };

    it('marks a sibling tool span still open when a parallel call fails tool_error', async () => {
      completionQueue.push(parallelTurn(['call_slow', 'okTool'], ['call_bad', 'badTool']));

      const { error, slow, bad } = await parallelFailure(new Error('tool broke'), (handlers) =>
        createLiteLLMAgentsHandler({ captureContent: true, client: fakeClient as never })(
          twoToolConfig as never,
          'q',
          handlers as never,
        ),
      );

      expect(String(error)).toContain('tool broke');
      expect(bad.attributes['error.type']).toBe('tool_error');
      expect(slow.status.code).toBe(SpanStatusCode.ERROR);
      expect(slow.attributes['error.type']).toBe('tool_error');
      expect(slow.attributes['gen_ai.tool.call.result']).toBeUndefined();
      expect(slow.events.map((e) => e.name)).toContain('exception');
    });

    it('leaves tool_error off a sibling span when a parallel call aborts', async () => {
      completionQueue.push(parallelTurn(['call_slow', 'okTool'], ['call_bad', 'badTool']));

      const { error, slow, bad } = await parallelFailure(new DOMException('aborted', 'AbortError'), (handlers) =>
        createLiteLLMAgentsHandler({ captureContent: true, client: fakeClient as never })(
          twoToolConfig as never,
          'q',
          handlers as never,
        ),
      );

      expect((error as { name?: string }).name).toBe('ToolCallError');
      expect(bad.status.code).toBe(SpanStatusCode.ERROR);
      expect(bad.attributes['error.type']).toBeUndefined();
      expect(slow.status.code).toBe(SpanStatusCode.ERROR);
      expect(slow.attributes['error.type']).toBeUndefined();
      expect(slow.attributes['gen_ai.tool.call.result']).toBeUndefined();
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
    // The handler awaits `run.cancel()` on abandonment. A tool that rejects while the run winds
    // down reports its end then, exactly as the SDK does (end event with the error text, then
    // rethrow); it is still part of the abandonment, not a tool failure.
    it('keeps a tool that rejects during the cancel UNSET and marked abandoned', async () => {
      const toolCall = { callId: 'call_slow', name: 'okTool', arguments: '{"q":"test"}' };
      vi.spyOn(Runner.prototype, 'run').mockImplementation((async (agent: Agent) => ({
        state: { usage: {} },
        async cancel() {
          const sdkTool = agent.tools.find((t) => t.name === 'okTool') as unknown as {
            invoke: (ctx: unknown, input: string, details: unknown) => Promise<unknown>;
          };
          try {
            await sdkTool.invoke({}, toolCall.arguments, { toolCall });
          } catch (error) {
            agent.emit('agent_tool_end', {} as never, sdkTool as never, String(error), { toolCall } as never);
          }
        },
        async *[Symbol.asyncIterator]() {
          agent.emit('agent_tool_start', {} as never, { name: 'okTool' } as never, { toolCall } as never);
          yield { type: 'raw_model_stream_event', data: { type: 'response.output_text.delta', delta: 'Hi' } };
          yield { type: 'raw_model_stream_event', data: { type: 'response.output_text.delta', delta: 'never read' } };
        },
      })) as never);
      const okTool = vi.fn().mockRejectedValue(new Error('tool broke during cancel'));

      const gen = createLiteLLMAgentsHandler({ captureContent: true, client: fakeClient as never }).stream?.(
        twoToolConfig as never,
        'q',
        { okTool },
        {},
      ) as AsyncGenerator<unknown>;
      for await (const _event of gen) break;

      expect(okTool).toHaveBeenCalled();
      const [tool] = named('execute_tool okTool');
      expect(tool.status.code).toBe(SpanStatusCode.UNSET);
      expect(tool.attributes['launchdarkly.stream.abandoned']).toBe(true);
      expect(tool.attributes['error.type']).toBeUndefined();
      expect(tool.events.map((e) => e.name)).not.toContain('exception');
      const root = spans().find((s) => s.name === 'invoke_agent');
      expect(root?.status.code).toBe(SpanStatusCode.UNSET);
      expect(root?.attributes['launchdarkly.stream.abandoned']).toBe(true);
    });
  });
});
