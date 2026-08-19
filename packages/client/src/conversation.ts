import { type Context, context, createContextKey, type Span } from '@opentelemetry/api';

/** Canonical OTel GenAI conversation grouping key. LaunchDarkly's conversation view reads only this. */
export const GEN_AI_CONVERSATION_ID = 'gen_ai.conversation.id';

const CONVERSATION_ID_KEY = createContextKey('launchdarkly.gen_ai.conversation.id');

const readAttribute = (span: Span, key: string): unknown => {
  const attrs = (span as unknown as { attributes?: Record<string, unknown> }).attributes;
  return attrs?.[key];
};

/**
 * Writes `gen_ai.conversation.id` only when the span does not already carry one.
 *
 * Used by `claude-agents` so a caller-supplied id stamped at span start is not overwritten by the
 * CLI session id. When the caller supplied none, this still writes the session id.
 */
export function setConversationIdIfAbsent(span: Span, id: string): void {
  if (!id) return;
  const existing = readAttribute(span, GEN_AI_CONVERSATION_ID);
  if (typeof existing === 'string' && existing.length > 0) return;
  span.setAttribute(GEN_AI_CONVERSATION_ID, id);
}

const conversationIdFrom = (ctx: Context): string | undefined => {
  const value = ctx.getValue(CONVERSATION_ID_KEY);
  return typeof value === 'string' && value.length > 0 ? value : undefined;
};

/**
 * Binds a caller-supplied conversation id for the duration of `fn`.
 *
 * Every span the SDK creates while this is bound (root, chat, execute_tool, graph) receives
 * `gen_ai.conversation.id`, provided {@link ConversationIdSpanProcessor} is registered — which
 * `initClient()` does when OTel is installed. An empty or whitespace id is treated as unbound:
 * semconv forbids inventing a UUID, a trace id, or a content hash as a fallback.
 *
 * This is a context value, not W3C baggage, so the id does not leak onto outbound HTTP calls.
 */
export function withConversationId<T>(id: string, fn: () => T): T {
  const trimmed = id.trim();
  if (!trimmed) return fn();
  return context.with(context.active().setValue(CONVERSATION_ID_KEY, trimmed), fn);
}

/**
 * Re-applies the conversation id bound at call time around every step of `generator`.
 *
 * An `async function*` body does not start until the first `next()`, which for a streaming caller
 * is normally after the {@link withConversationId} scope has already exited — so every span the
 * handler opens while streaming would otherwise silently miss the id.
 *
 * Only the id travels. The rest of the context is whatever is active at iteration time, so span
 * parenting for streaming callers is unchanged from an unbound stream.
 */
export function bindConversationId<T, TReturn, TNext>(
  generator: AsyncGenerator<T, TReturn, TNext>,
): AsyncGenerator<T, TReturn, TNext> {
  const id = conversationIdFrom(context.active());
  if (!id) return generator;

  const reenter = <R>(fn: () => R): R => context.with(context.active().setValue(CONVERSATION_ID_KEY, id), fn);

  return {
    next: (...args: [] | [TNext]) => reenter(() => generator.next(...args)),
    return: (value: TReturn | PromiseLike<TReturn>) => reenter(() => generator.return(value)),
    throw: (err: unknown) => reenter(() => generator.throw(err)),
    [Symbol.asyncIterator]() {
      return this;
    },
  } as AsyncGenerator<T, TReturn, TNext>;
}

/**
 * Stamps `gen_ai.conversation.id` write-if-absent on every span.
 *
 * Duck-typed to the OTel SDK `SpanProcessor` interface so this file depends only on
 * `@opentelemetry/api`. `initClient()` registers it ahead of `BatchSpanProcessor`.
 */
export class ConversationIdSpanProcessor {
  onStart(span: Span, parentContext?: Context): void {
    const ctx = parentContext ?? context.active();
    const id = conversationIdFrom(ctx) ?? conversationIdFrom(context.active());
    if (id) setConversationIdIfAbsent(span, id);
  }

  onEnd(_span: unknown): void {}

  shutdown(): Promise<void> {
    return Promise.resolve();
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }
}
