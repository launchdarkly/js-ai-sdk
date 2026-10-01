import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ConversationIdSpanProcessor, GEN_AI_CONVERSATION_ID, withConversationId } from '../conversation.js';

/**
 * Every other test file registers an `AsyncLocalStorageContextManager` up front, which is exactly
 * why this gap went unnoticed: real callers start with OTel's `NoopContextManager`, whose `with()`
 * discards the context. A `withConversationId` call made before `initClient()` therefore binds
 * nothing, and every span goes out unstamped.
 *
 * This file deliberately does NOT register a context manager until the second test, so the
 * un-registered state — the one real applications begin in — is covered.
 */

const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({
  spanProcessors: [new ConversationIdSpanProcessor(), new SimpleSpanProcessor(exporter)],
});
const tracer = provider.getTracer('@launchdarkly/ai-server');

beforeAll(() => {
  trace.setGlobalTracerProvider(provider);
});

afterAll(async () => {
  context.disable();
  await provider.shutdown();
});

describe('withConversationId before a context manager is registered', () => {
  it('warns instead of silently dropping the id', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    exporter.reset();

    withConversationId('thread-before-init', () => {
      tracer.startSpan('invoke_agent').end();
    });

    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]?.[0]);
    expect(message).toContain('initClient');
    expect(message).toContain('gen_ai.conversation.id');

    // The binding genuinely cannot work here — the point is that it is no longer silent.
    expect(exporter.getFinishedSpans()[0]?.attributes[GEN_AI_CONVERSATION_ID]).toBeUndefined();
    warn.mockRestore();
  });

  it('warns only once, however many times it is called', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    exporter.reset();

    withConversationId('thread-a', () => tracer.startSpan('invoke_agent').end());
    withConversationId('thread-b', () => tracer.startSpan('invoke_agent').end());

    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('withConversationId once a context manager is registered', () => {
  it('stamps the id and does not warn', () => {
    const contextManager = new AsyncLocalStorageContextManager();
    contextManager.enable();
    context.setGlobalContextManager(contextManager);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    exporter.reset();

    withConversationId('thread-after-init', () => {
      tracer.startSpan('invoke_agent').end();
    });

    expect(warn).not.toHaveBeenCalled();
    expect(exporter.getFinishedSpans()[0]?.attributes[GEN_AI_CONVERSATION_ID]).toBe('thread-after-init');
    warn.mockRestore();
  });
});
