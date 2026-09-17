import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ConversationIdSpanProcessor,
  GEN_AI_CONVERSATION_ID,
  setConversationIdIfAbsent,
  withConversationId,
  withJudgeEvaluation,
} from '../conversation.js';

const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({
  spanProcessors: [new ConversationIdSpanProcessor(), new SimpleSpanProcessor(exporter)],
});
const tracer = provider.getTracer('@launchdarkly/ai-server');
const contextManager = new AsyncLocalStorageContextManager();

afterAll(async () => {
  context.disable();
  await provider.shutdown();
});

beforeAll(() => {
  contextManager.enable();
  context.setGlobalContextManager(contextManager);
  trace.setGlobalTracerProvider(provider);
});

beforeEach(() => {
  exporter.reset();
});

const finished = () => exporter.getFinishedSpans();

describe('withConversationId', () => {
  it('stamps gen_ai.conversation.id on every span started in the scope', () => {
    withConversationId('thread-123', () => {
      const root = tracer.startSpan('invoke_agent');
      const child = tracer.startSpan('chat gpt-4o', undefined, trace.setSpan(context.active(), root));
      child.end();
      root.end();
    });

    const spans = finished();
    expect(spans).toHaveLength(2);
    for (const span of spans) {
      expect(span.attributes[GEN_AI_CONVERSATION_ID]).toBe('thread-123');
    }
  });

  it('writes nothing when the caller supplies no id', () => {
    const span = tracer.startSpan('invoke_agent');
    span.end();
    expect(finished()[0]?.attributes[GEN_AI_CONVERSATION_ID]).toBeUndefined();
  });

  it('treats a whitespace id as unbound', () => {
    withConversationId('   ', () => {
      const span = tracer.startSpan('invoke_agent');
      span.end();
    });
    expect(finished()[0]?.attributes[GEN_AI_CONVERSATION_ID]).toBeUndefined();
  });

  it('does not invent an id from the trace id', () => {
    const span = tracer.startSpan('invoke_agent');
    span.end();
    const recorded = finished()[0];
    expect(recorded?.attributes[GEN_AI_CONVERSATION_ID]).toBeUndefined();
    expect(recorded?.spanContext().traceId).toBeTruthy();
  });
});

describe('setConversationIdIfAbsent', () => {
  it('leaves a caller-supplied id in place', () => {
    withConversationId('caller-id', () => {
      const span = tracer.startSpan('invoke_agent');
      setConversationIdIfAbsent(span, 'sess-abc');
      span.end();
    });
    expect(finished()[0]?.attributes[GEN_AI_CONVERSATION_ID]).toBe('caller-id');
  });

  it('writes the session id when the caller supplied none', () => {
    const span = tracer.startSpan('invoke_agent');
    setConversationIdIfAbsent(span, 'sess-abc');
    span.end();
    expect(finished()[0]?.attributes[GEN_AI_CONVERSATION_ID]).toBe('sess-abc');
  });
});

describe('withJudgeEvaluation', () => {
  it('puts gen_ai.evaluation.result on the invoke_agent span after the handler has ended it', async () => {
    await withJudgeEvaluation('relevance-judge', async (record) => {
      await tracer.startActiveSpan('invoke_agent', async (span) => {
        span.setAttribute('gen_ai.operation.name', 'invoke_agent');
        span.end();
      });
      record(0.91);
    });

    const [span] = finished().filter((s) => s.name === 'invoke_agent');
    expect(span).toBeDefined();
    expect(span.attributes['gen_ai.evaluation.name']).toBe('relevance-judge');
    expect(span.attributes['gen_ai.evaluation.score.value']).toBe(0.91);
    const event = span.events.find((e) => e.name === 'gen_ai.evaluation.result');
    expect(event).toBeDefined();
    expect(event?.attributes?.['gen_ai.evaluation.name']).toBe('relevance-judge');
    expect(event?.attributes?.['gen_ai.evaluation.score.value']).toBe(0.91);
    expect(event?.attributes?.['gen_ai.evaluation.score.label']).toBeUndefined();
  });

  it('does not invent a score.label', async () => {
    await withJudgeEvaluation('judge-key', async (record) => {
      await tracer.startActiveSpan('invoke_agent', async (span) => {
        span.end();
      });
      record(0.5);
    });
    const [span] = finished();
    expect(span.attributes['gen_ai.evaluation.score.label']).toBeUndefined();
    const event = span.events.find((e) => e.name === 'gen_ai.evaluation.result');
    expect(event?.attributes?.['gen_ai.evaluation.score.label']).toBeUndefined();
  });
});

describe('withJudgeEvaluation content and timing', () => {
  it('does not export the judge explanation', async () => {
    // Judge reasoning is model prose about the user's conversation, i.e. content. AGENTS.md gates
    // content attributes behind `captureContent`, which this layer never receives.
    await withJudgeEvaluation('relevance-judge', async (record) => {
      await tracer.startActiveSpan('invoke_agent', async (span) => span.end());
      record(0.2);
    });

    const [span] = finished().filter((s) => s.name === 'invoke_agent');
    expect(Object.keys(span.attributes).some((k) => k.includes('explanation'))).toBe(false);
    const event = span.events.find((e) => e.name === 'gen_ai.evaluation.result');
    expect(Object.keys(event?.attributes ?? {}).some((k) => k.includes('explanation'))).toBe(false);
  });

  it('ends the span at the handler call, not at release', async () => {
    let endedAt = 0;
    await withJudgeEvaluation('slow-judge', async (record) => {
      await tracer.startActiveSpan('invoke_agent', async (span) => span.end());
      endedAt = Date.now();
      await new Promise((r) => setTimeout(r, 50)); // stands in for tracking + parsing
      record(0.5);
    });

    const [span] = finished().filter((s) => s.name === 'invoke_agent');
    const endMs = span.endTime[0] * 1000 + span.endTime[1] / 1e6;
    expect(endMs - endedAt).toBeLessThan(20);
  });
});

describe('ConversationIdSpanProcessor scope', () => {
  // The processor is registered on the *global* provider, so it sees every span in the process.
  // Stamping a caller-supplied id onto unrelated telemetry — Postgres queries, inbound HTTP server
  // spans, and the outbound provider call itself — is both wrong and the leak this design avoids.
  it('stamps spans from LaunchDarkly tracers', () => {
    const ld = provider.getTracer('@launchdarkly/ai-claude-messages');
    withConversationId('thread-123', () => {
      ld.startSpan('invoke_agent').end();
    });
    expect(finished()[0]?.attributes[GEN_AI_CONVERSATION_ID]).toBe('thread-123');
  });

  it('does not stamp third-party instrumentation spans', () => {
    const http = provider.getTracer('@opentelemetry/instrumentation-http');
    const pg = provider.getTracer('@opentelemetry/instrumentation-pg');
    withConversationId('thread-123', () => {
      http.startSpan('HTTP POST api.openai.com').end();
      pg.startSpan('pg.query').end();
    });
    for (const span of finished()) {
      expect(span.attributes[GEN_AI_CONVERSATION_ID], span.name).toBeUndefined();
    }
  });
});

describe('withConversationId with a nullish id', () => {
  it('treats a nullish id as unbound rather than throwing', () => {
    // The natural call site is an optional header: withConversationId(req.headers['x-conv-id'], …)
    const run = () =>
      withConversationId(undefined as unknown as string, () => {
        tracer.startSpan('invoke_agent').end();
        return 'ok';
      });
    expect(run()).toBe('ok');
    expect(finished()[0]?.attributes[GEN_AI_CONVERSATION_ID]).toBeUndefined();
  });
});

describe('judge explanation is gated on captureContent', () => {
  // The judge's reasoning is model prose about the user's conversation, so it follows the same
  // gate as every other content attribute rather than being emitted unconditionally.
  it('writes the explanation when the judge handler captures content', async () => {
    await withJudgeEvaluation('relevance-judge', async (record) => {
      await tracer.startActiveSpan('invoke_agent', async (span) => span.end());
      record(0.8, 'on topic and complete');
    });

    const [span] = finished().filter((s) => s.name === 'invoke_agent');
    expect(span.attributes['gen_ai.evaluation.explanation']).toBe('on topic and complete');
    const event = span.events.find((e) => e.name === 'gen_ai.evaluation.result');
    expect(event?.attributes?.['gen_ai.evaluation.explanation']).toBe('on topic and complete');
  });

  it('omits the explanation when none is supplied', async () => {
    await withJudgeEvaluation('relevance-judge', async (record) => {
      await tracer.startActiveSpan('invoke_agent', async (span) => span.end());
      record(0.8);
    });

    const [span] = finished().filter((s) => s.name === 'invoke_agent');
    expect(Object.keys(span.attributes).some((k) => k.includes('explanation'))).toBe(false);
    const event = span.events.find((e) => e.name === 'gen_ai.evaluation.result');
    expect(Object.keys(event?.attributes ?? {}).some((k) => k.includes('explanation'))).toBe(false);
  });
});
