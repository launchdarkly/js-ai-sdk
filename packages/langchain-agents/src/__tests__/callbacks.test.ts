import { HumanMessage } from '@langchain/core/messages';
import { FakeChatModel } from '@langchain/core/utils/testing';
import { context, trace } from '@opentelemetry/api';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildSpanCallbacks } from '../handler.js';

/**
 * Unlike `handler.test.ts`, this file mocks nothing.
 *
 * It drives LangChain's real callback machinery and a real OpenTelemetry tracer, using a
 * `FakeChatModel` so no network or API key is involved. Two things can only be checked this way:
 *
 *  - **Parentage.** `handler.test.ts` stubs `startActiveSpan` as `(_name, fn) => fn(mockSpan)`,
 *    which never installs a span into the active context — so every parent it observes is empty,
 *    and a broken parent/child link would not fail a single assertion there.
 *  - **Callback delivery.** LangChain, not our code, decides when callbacks run. The module mock
 *    in `handler.test.ts` replaces exactly that decision.
 */

const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
trace.setGlobalTracerProvider(provider);

const aiConfig = { model: { name: 'fake-model' }, provider: { name: 'OpenAI' } } as never;

const chatSpans = () => exporter.getFinishedSpans().filter((s) => s.name.startsWith('chat'));

/** A model that consumes real wall-clock time, so span duration is meaningful. */
class SlowFakeChatModel extends FakeChatModel {
  async _generate(...args: Parameters<FakeChatModel['_generate']>): Promise<ReturnType<FakeChatModel['_generate']>> {
    await new Promise((resolve) => setTimeout(resolve, 60));
    return super._generate(...args);
  }
}

describe('buildSpanCallbacks against real LangChain', () => {
  beforeEach(() => {
    exporter.reset();
  });

  afterAll(async () => {
    await provider.shutdown();
  });

  it('nests the chat span under the caller-supplied parent context', async () => {
    const root = trace.getTracer('test').startSpan('invoke_agent test');
    const parentContext = trace.setSpan(context.active(), root);

    const { callbacks } = buildSpanCallbacks(aiConfig, parentContext);
    await new FakeChatModel({}).invoke([new HumanMessage('hi')], { callbacks });
    root.end();

    const [chat] = chatSpans();
    expect(chat).toBeDefined();
    expect(chat.parentSpanContext?.spanId).toBe(root.spanContext().spanId);
    expect(chat.spanContext().traceId).toBe(root.spanContext().traceId);
  });

  it('makes the chat span a root when no parent is in context', async () => {
    const { callbacks } = buildSpanCallbacks(aiConfig, context.active());
    await new FakeChatModel({}).invoke([new HumanMessage('hi')], { callbacks });

    const [chat] = chatSpans();
    expect(chat?.parentSpanContext).toBeUndefined();
  });

  it('ends the chat span before invoke() resolves, with no flush', async () => {
    // LangChain queues these callbacks rather than awaiting them (`awaitHandlers` defaults to
    // false). The queue is `autoStart: true`, so a *synchronous* callback still completes in time.
    // This does not test the flag — it holds either way. It pins the property the flag's default
    // leaves us relying on: making any callback in buildSpanCallbacks async would break it.
    const { callbacks } = buildSpanCallbacks(aiConfig, context.active());

    await new SlowFakeChatModel({}).invoke([new HumanMessage('hi')], { callbacks });

    // No awaitAllCallbacks(), no timer, no forceFlush.
    expect(chatSpans()).toHaveLength(1);
  });

  it('times the chat span around the model call', async () => {
    const { callbacks } = buildSpanCallbacks(aiConfig, context.active());

    await new SlowFakeChatModel({}).invoke([new HumanMessage('hi')], { callbacks });

    const [span] = chatSpans();
    const durationMs = span.duration[0] * 1000 + span.duration[1] / 1e6;
    // The fake model sleeps 60ms; a span that measured callback dispatch instead would be ~0ms.
    expect(durationMs).toBeGreaterThan(50);
  });

  it('records the exception and ERROR status on the chat span when the model throws', async () => {
    const model = new FakeChatModel({});
    model._generate = async () => {
      throw new Error('model down');
    };

    const { callbacks } = buildSpanCallbacks(aiConfig, context.active());
    await expect(model.invoke([new HumanMessage('hi')], { callbacks })).rejects.toThrow('model down');

    const [span] = chatSpans();
    expect(span).toBeDefined();
    expect(span.events.map((e) => e.name)).toContain('exception');
    expect(span.status.code).toBe(2); // SpanStatusCode.ERROR
  });
});
