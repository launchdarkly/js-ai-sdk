import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ConversationIdSpanProcessor,
  GEN_AI_CONVERSATION_ID,
  setConversationIdIfAbsent,
  withConversationId,
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
