import {
  type Attributes,
  type Context,
  context,
  createContextKey,
  type Span,
  type TimeInput,
} from '@opentelemetry/api';

/** Canonical OTel GenAI conversation grouping key. LaunchDarkly's conversation view reads only this. */
export const GEN_AI_CONVERSATION_ID = 'gen_ai.conversation.id';

const CONVERSATION_ID_KEY = createContextKey('launchdarkly.gen_ai.conversation.id');
const JUDGE_EVAL_KEY = createContextKey('launchdarkly.judge.evaluation');

type JudgeEvaluation = {
  name: string;
  score: number;
  /** Only ever set when the judge's handler captures content. See `runJudges`. */
  explanation?: string;
};

type JudgeEvalCapture = {
  name: string;
  evaluation?: JudgeEvaluation;
  span?: Span;
  pendingEnd?: () => void;
  released: boolean;
};

/**
 * Every tracer this SDK creates is named `@launchdarkly/ai-<package>`. The processor is registered
 * on the *global* provider, so without this gate it stamps a caller-supplied id onto every span in
 * the process — Postgres queries, inbound HTTP server spans, and the outbound provider call itself.
 */
const LD_TRACER_PREFIX = '@launchdarkly/';

/**
 * True only when the span came from one of this SDK's own tracers.
 *
 * Deliberately conservative: an unrecognisable scope means "not ours", so an id is never sprayed
 * across unrelated telemetry. The companion test asserts LD spans *are* stamped, so a rename of
 * this field fails the suite loudly rather than silently disabling the feature.
 */
const isLaunchDarklySpan = (span: Span): boolean => {
  const scope = (span as unknown as { instrumentationScope?: { name?: string } }).instrumentationScope;
  return typeof scope?.name === 'string' && scope.name.startsWith(LD_TRACER_PREFIX);
};

const readAttribute = (span: Span, key: string): unknown => {
  const attrs = (span as unknown as { attributes?: Record<string, unknown> }).attributes;
  return attrs?.[key];
};

const spanName = (span: Span): string => {
  const name = (span as unknown as { name?: string }).name;
  return typeof name === 'string' ? name : '';
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

const CONTEXT_PROBE_KEY = createContextKey('launchdarkly.context.probe');
let warnedAboutContextManager = false;

/**
 * True when the global OTel context manager actually stores values.
 *
 * Until something registers one — `initClient()` does, via the tracer provider — the global
 * manager is OTel's `NoopContextManager`, whose `with()` discards the context entirely. A
 * conversation id bound before that point is silently lost, and every span goes out unstamped.
 * Probing a round-trip is cheaper and more honest than reaching into OTel internals.
 */
const contextManagerStoresValues = (): boolean =>
  context.with(context.active().setValue(CONTEXT_PROBE_KEY, true), () =>
    context.active().getValue(CONTEXT_PROBE_KEY),
  ) === true;

/** Warns once. A per-request binding would otherwise print this on every request. */
const warnContextManagerMissing = (): void => {
  if (warnedAboutContextManager) return;
  warnedAboutContextManager = true;
  // biome-ignore lint/suspicious/noConsole: the alternative is failing silently, which is the bug
  console.warn(
    '[LaunchDarkly] withConversationId was called before an OpenTelemetry context manager was ' +
      "registered, so gen_ai.conversation.id will not be set on this run's spans. Await " +
      'initClient() before binding a conversation id (or register a context manager yourself if ' +
      'you own the OTel setup). Later calls in this process will work once initialization completes.',
  );
};

const conversationIdFrom = (ctx: Context): string | undefined => {
  const value = ctx.getValue(CONVERSATION_ID_KEY);
  return typeof value === 'string' && value.length > 0 ? value : undefined;
};

const recordEvaluationOnSpan = (span: Span, evaluation: JudgeEvaluation): void => {
  if (!span.isRecording()) return;
  const attrs: Attributes = {
    'gen_ai.evaluation.name': evaluation.name,
    'gen_ai.evaluation.score.value': evaluation.score,
  };
  if (evaluation.explanation) attrs['gen_ai.evaluation.explanation'] = evaluation.explanation;
  span.addEvent('gen_ai.evaluation.result', attrs);
  for (const [key, value] of Object.entries(attrs)) span.setAttribute(key, value as never);
};

const delayInvokeAgentEnd = (span: Span, capture: JudgeEvalCapture): void => {
  const originalEnd = span.end.bind(span);
  let ended = false;
  const wrappedEnd = (endTime?: TimeInput) => {
    if (ended) return;
    if (capture.released) {
      ended = true;
      originalEnd(endTime);
      return;
    }
    capture.span = span;
    // Freeze the end time at the handler's call. Replaying an undefined endTime later would let
    // the SDK stamp "now" at release, inflating the judge span by the tracking and parsing work
    // that runs between the handler ending the span and the score being recorded.
    const frozen = endTime ?? Date.now();
    capture.pendingEnd = () => {
      if (ended) return;
      ended = true;
      originalEnd(frozen);
    };
  };
  (span as { end: Span['end'] }).end = wrappedEnd;
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
  // Nullish is treated as unbound, not as an error: the natural call site is an optional value
  // such as `withConversationId(req.headers['x-conversation-id'], …)`, and JS callers get no
  // compile-time protection on a published export.
  const trimmed = typeof id === 'string' ? id.trim() : '';
  if (!trimmed) return fn();
  if (!contextManagerStoresValues()) warnContextManagerMissing();
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
 * Holds the judge `invoke_agent` span open until `record` runs, then writes
 * `gen_ai.evaluation.result` on that span. The judge's reasoning is passed only when the judge's
 * own handler captures content — it is model prose about the user's conversation, so it follows
 * the same gate as every other content attribute. `executeAndTrack` returns after the handler has already
 * called `span.end()`, so without this delay the event would be dropped.
 *
 * Not part of the public API — used by `runJudges` / `runJudge`.
 */
export async function withJudgeEvaluation<T>(
  name: string,
  fn: (record: (score: number, explanation?: string) => void) => Promise<T>,
): Promise<T> {
  const capture: JudgeEvalCapture = { name, released: false };
  return context.with(context.active().setValue(JUDGE_EVAL_KEY, capture), async () => {
    try {
      return await fn((score, explanation) => {
        capture.evaluation = { name: capture.name, score, explanation };
        if (capture.span) recordEvaluationOnSpan(capture.span, capture.evaluation);
      });
    } finally {
      capture.released = true;
      capture.pendingEnd?.();
    }
  });
}

/**
 * Stamps `gen_ai.conversation.id` write-if-absent on every span, and delays ending a judge
 * `invoke_agent` span so evaluation events can land on it.
 *
 * Duck-typed to the OTel SDK `SpanProcessor` interface so this file depends only on
 * `@opentelemetry/api`. `initClient()` registers it ahead of `BatchSpanProcessor`.
 */
export class ConversationIdSpanProcessor {
  onStart(span: Span, parentContext?: Context): void {
    // One lookup, one precedence rule. The SDK always passes the real parent context, and falling
    // back to `context.active()` only mis-attributes: a span deliberately started from a captured
    // or detached context would inherit whatever conversation happens to be active on the stack.
    const ctx = parentContext ?? context.active();
    const id = conversationIdFrom(ctx);
    if (id && isLaunchDarklySpan(span)) setConversationIdIfAbsent(span, id);

    // Name check first — this runs for every span in the process and almost none are judge roots.
    if (spanName(span) !== 'invoke_agent') return;
    const capture = ctx.getValue(JUDGE_EVAL_KEY) as JudgeEvalCapture | undefined;
    if (capture) delayInvokeAgentEnd(span, capture);
  }

  onEnd(_span: unknown): void {}

  shutdown(): Promise<void> {
    return Promise.resolve();
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }
}
