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
  explanation?: string;
};

type JudgeEvalCapture = {
  name: string;
  evaluation?: JudgeEvaluation;
  span?: Span;
  pendingEnd?: () => void;
  released: boolean;
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
  if (evaluation.explanation) {
    attrs['gen_ai.evaluation.explanation'] = evaluation.explanation;
  }
  span.addEvent('gen_ai.evaluation.result', attrs);
  span.setAttribute('gen_ai.evaluation.name', evaluation.name);
  span.setAttribute('gen_ai.evaluation.score.value', evaluation.score);
  if (evaluation.explanation) {
    span.setAttribute('gen_ai.evaluation.explanation', evaluation.explanation);
  }
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
    capture.pendingEnd = () => {
      if (ended) return;
      ended = true;
      originalEnd(endTime);
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
  const trimmed = id.trim();
  if (!trimmed) return fn();
  return context.with(context.active().setValue(CONVERSATION_ID_KEY, trimmed), fn);
}

/**
 * Holds the judge `invoke_agent` span open until `record` runs, then writes
 * `gen_ai.evaluation.result` on that span. `executeAndTrack` returns after the handler has already
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
    const ctx = parentContext ?? context.active();
    const id = conversationIdFrom(ctx) ?? conversationIdFrom(context.active());
    if (id) setConversationIdIfAbsent(span, id);

    const capture = (parentContext ?? context.active()).getValue(JUDGE_EVAL_KEY) as JudgeEvalCapture | undefined;
    const activeCapture = (context.active().getValue(JUDGE_EVAL_KEY) as JudgeEvalCapture | undefined) ?? capture;
    if (activeCapture && spanName(span) === 'invoke_agent') {
      delayInvokeAgentEnd(span, activeCapture);
    }
  }

  onEnd(_span: unknown): void {}

  shutdown(): Promise<void> {
    return Promise.resolve();
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }
}
