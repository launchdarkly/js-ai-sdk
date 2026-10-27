/**
 * Evaluations from Code — the spans the runner writes for one dataset row.
 *
 * Every row gets a `launchdarkly.dataset_row` root, so its generation, tool
 * calls and criteria share one trace. The root names no `gen_ai` operation
 * and no evaluation, so the conversation view treats it as an envelope and
 * keeps the generation in the transcript.
 *
 * A provider handler traces its own call. A plain function does not, so the
 * runner describes what it handed the function and what came back: one `chat`
 * span, an `execute_tool` span per recorded tool call, and, under each judge's
 * `evaluate` span, a `chat` span for the judge call. These are written only
 * when the call started no SDK span of its own, so a call is never traced
 * twice.
 *
 * These spans go to the tracer provider `initClient()` registered. They follow
 * the same content gate as every other span: the handler's explicit
 * `captureContent` when it has one, otherwise off. The
 * `$ld:ai:offline-evals:*` events never carry the transcript.
 *
 * Internal: nothing here is exported from an entry point.
 */

import { createHash } from 'node:crypto';
import { context, type Span, SpanStatusCode, trace } from '@opentelemetry/api';
import {
  type SpanMessage,
  type SpanMessagePart,
  setInputContentAttributes,
  setOutputContentAttributes,
  setToolCallContentAttributes,
  type ToolDefinitionInput,
  textMessage,
  toolResultString,
} from './content.js';
import {
  countSdkSpans,
  GEN_AI_CONVERSATION_ID,
  recordEvaluationOnSpan,
  withConversationId,
  withSpanAttributes,
} from './conversation.js';
import { errorMessage, isPlainObject } from './evaluations-api.js';
import { sdkSpanProcessorIsActive } from './lifecycle.js';
import { renderValue, type TrajectoryCall } from './trajectory.js';
import type { AiConfigRep, ProviderHandler } from './types.js';
import {
  parseTemplate,
  parseUsage,
  setModelIdentityAttributes,
  setUsageSpanAttributes,
  spanTimestamp,
} from './utils.js';

const TRACER_NAME = '@launchdarkly/ai-server';
export const ROW_SPAN_NAME = 'launchdarkly.dataset_row';

export const LD_EVALUATION_RUN_ID = 'launchdarkly.evaluation_run.id';
export const LD_EVALUATION_RUN_ROW_INDEX = 'launchdarkly.evaluation_run.row_index';

/**
 * The namespace LaunchDarkly derives an evaluation row's `conversationId`
 * under. Changing it re-keys every offline evaluation conversation.
 */
const EVALUATION_CONVERSATION_NAMESPACE = '6f0c2a4e-3b6d-4d0e-9c1a-2e6b7f8a9d01';

/** Content capture when a handler states no preference. Conversation content is PII, so it is off. */
const DEFAULT_CAPTURE_CONTENT = false;

/** RFC 9562 UUIDv5: SHA-1 of the namespace bytes and the name, with the version and variant bits set. */
function uuid5(namespace: string, name: string): string {
  const bytes = createHash('sha1')
    .update(Buffer.from(namespace.replace(/-/g, ''), 'hex'))
    .update(name, 'utf8')
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The UUIDv5 of `{runId}:{rowIndex}`. Row `0` is the suffix `:0`, not an omitted index. */
export const conversationIdForEvaluationRow = (runId: string, rowIndex: number): string =>
  uuid5(EVALUATION_CONVERSATION_NAMESPACE, `${runId}:${rowIndex}`);

const rowAttributes = (runId: string, rowIndex: number) => ({
  [GEN_AI_CONVERSATION_ID]: conversationIdForEvaluationRow(runId, rowIndex),
  [LD_EVALUATION_RUN_ID]: runId,
  [LD_EVALUATION_RUN_ROW_INDEX]: rowIndex,
});

/**
 * Binds one dataset row onto every SDK span started while `fn` runs:
 * `gen_ai.conversation.id` from {@link conversationIdForEvaluationRow}, and
 * `launchdarkly.evaluation_run.id` / `.row_index`. Never `launchdarkly.run.id`,
 * which is the AI Config tracking id.
 *
 * An outer conversation id is shadowed until `fn` returns: the row's id is the
 * join key for this row.
 */
export function withEvaluationRow<T>(runId: string, rowIndex: number, fn: () => T): T {
  return withConversationId(conversationIdForEvaluationRow(runId, rowIndex), () =>
    withSpanAttributes({ [LD_EVALUATION_RUN_ID]: runId, [LD_EVALUATION_RUN_ROW_INDEX]: rowIndex }, fn),
  );
}

/** Runs `fn` with `span` as the active span, so the spans it starts are children of it. */
export const withActiveSpan = <T>(span: Span, fn: () => T): T =>
  context.with(trace.setSpan(context.active(), span), fn);

const tracer = () => trace.getTracer(TRACER_NAME);

/**
 * Starts a span at an explicit time. Every span written here is timed from
 * {@link spanTimestamp} at both ends, so a child cannot land outside its
 * parent through two clocks disagreeing.
 */
const startSpan = (name: string, parent: Span | undefined, startTime = spanTimestamp()): Span =>
  parent
    ? tracer().startSpan(name, { startTime }, trace.setSpan(context.active(), parent))
    : tracer().startSpan(name, { root: true, startTime });

/** Ends a span started by this module. */
export const endSpan = (span: Span, endTime = spanTimestamp()): void => span.end(endTime);

/** Opens the row's root. The caller ends it with {@link endSpan} after the row's criteria. */
export function startRowSpan(runId: string, rowIndex: number): Span {
  const span = startSpan(ROW_SPAN_NAME, undefined);
  span.setAttributes(rowAttributes(runId, rowIndex));
  return span;
}

/** The thrown value's class name, for `error.type`. */
const errorType = (err: unknown): string => (err instanceof Error && err.constructor.name) || 'Error';

/** Marks the row's root OK, or ERROR when generation raised. */
export function finishRowSpan(span: Span, err?: unknown): void {
  if (err === undefined) {
    span.setStatus({ code: SpanStatusCode.OK });
    return;
  }
  span.setAttribute('error.type', errorType(err));
  span.setStatus({ code: SpanStatusCode.ERROR, message: errorMessage(err) });
}

/** Content capture for one call: the handler's own setting, otherwise off. */
export const captureFor = (handler: ProviderHandler | undefined): boolean =>
  typeof handler?.captureContent === 'boolean' ? handler.captureContent : DEFAULT_CAPTURE_CONTENT;

/** How a handler call ended, timed from just before it was entered to just after it settled. */
export type CallOutcome = { startedAt: number; endedAt: number; result?: unknown; error?: unknown };

/**
 * Runs one handler call, and when it started no SDK span, hands `describe`
 * what happened so the runner can write the span the handler did not. The
 * call's result or error passes through unchanged.
 *
 * A handler under a provider without the SDK's span processor always counts
 * 0, so nothing is described there: that would trace a handler that traced
 * itself twice.
 */
export async function traceHandlerCall<T>(
  call: () => Promise<T>,
  describe: (outcome: CallOutcome) => void,
): Promise<T> {
  return countSdkSpans(async (counter) => {
    const startedAt = spanTimestamp();
    let outcome: Omit<CallOutcome, 'startedAt' | 'endedAt'> = {};
    try {
      const result = await call();
      outcome = { result };
      return result;
    } catch (err) {
      outcome = { error: err };
      throw err;
    } finally {
      const endedAt = spanTimestamp();
      // The description is best effort: a span that cannot be written must not fail the call.
      if (counter.count === 0 && sdkSpanProcessorIsActive()) {
        try {
          describe({ startedAt, endedAt, ...outcome });
        } catch {
          // Nothing to recover: the call's own outcome is what the caller needs.
        }
      }
    }
  });
}

const providerName = (config: AiConfigRep): string => {
  const name = (config.provider as { name?: unknown } | undefined)?.name;
  return typeof name === 'string' ? name.toLowerCase() : '';
};

const modelName = (config: AiConfigRep): string => {
  const name = (config.model as { name?: unknown } | undefined)?.name;
  return typeof name === 'string' ? name : '';
};

/** Writes the provider and model a config names onto `span`. */
export const setConfigModelIdentity = (span: Span, config: AiConfigRep): void =>
  setModelIdentityAttributes(span, providerName(config), modelName(config));

/**
 * Row-local id joining a `tool_call` part to its `execute_tool` span. A plain
 * function reports no provider call id, so the runner numbers the calls it
 * recorded, in start order.
 */
const callId = (index: number): string => `call_${index + 1}`;

/**
 * The system instructions and messages the handler was given, rendered with
 * the call's variables in the single `parseTemplate` pass a provider handler
 * applies. `userInput` is the final user turn, as it is for every handler.
 */
function prompt(
  config: AiConfigRep,
  userInput: unknown,
  variables: Record<string, unknown>,
): { systemInstructions?: string; messages: SpanMessage[] } {
  const system: string[] = [];
  const messages: SpanMessage[] = [];
  if (typeof config.instructions === 'string' && config.instructions) {
    system.push(parseTemplate(config.instructions, variables));
  }
  for (const message of config.messages ?? []) {
    if (!isPlainObject(message) || typeof message.content !== 'string' || typeof message.role !== 'string') continue;
    const rendered = parseTemplate(message.content, variables);
    if (message.role === 'system') system.push(rendered);
    else messages.push(textMessage(message.role, rendered));
  }
  if (userInput !== undefined && userInput !== null) messages.push(textMessage('user', toolResultString(userInput)));
  return { systemInstructions: system.join('\n\n') || undefined, messages };
}

function toolDefinitions(config: AiConfigRep): ToolDefinitionInput[] {
  const definitions: ToolDefinitionInput[] = [];
  for (const [key, tool] of Object.entries(config.tools ?? {})) {
    if (!isPlainObject(tool)) continue;
    const name = typeof tool.name === 'string' && tool.name ? tool.name : key;
    definitions.push({
      name,
      description: typeof tool.description === 'string' && tool.description ? tool.description : undefined,
      parameters: tool.parameters,
    });
  }
  return definitions;
}

/**
 * Writes one `chat {model}` span for a call the handler did not trace, as a
 * child of `parent`. A call that raised is ERROR and has no output.
 * `toolCalls` become `tool_call` parts ahead of the answer, tied to their
 * `execute_tool` spans by call id, so the transcript keeps their order even
 * when every step lands in the same millisecond.
 */
export function recordChat(
  parent: Span,
  call: CallOutcome & {
    config: AiConfigRep;
    userInput: unknown;
    variables: Record<string, unknown>;
    toolCalls?: readonly TrajectoryCall[];
    capture: boolean;
  },
): void {
  const { config, capture } = call;
  const span = startSpan(`chat ${modelName(config)}`.trim(), parent, call.startedAt);
  try {
    span.setAttribute('gen_ai.operation.name', 'chat');
    setConfigModelIdentity(span, config);
    if (capture) {
      setInputContentAttributes(span, capture, {
        ...prompt(config, call.userInput, call.variables),
        toolDefinitions: toolDefinitions(config),
      });
    }
    if (call.error !== undefined) {
      span.setAttribute('error.type', errorType(call.error));
      span.setStatus({ code: SpanStatusCode.ERROR, message: errorMessage(call.error) });
      return;
    }
    const result = isPlainObject(call.result) ? call.result : {};
    if (isPlainObject(result.usage)) {
      const usage = parseUsage(result.usage);
      setUsageSpanAttributes(span, {
        input: usage.input,
        output: usage.output,
        cacheRead: usage.inputDetails?.cacheRead ?? 0,
        cacheCreation: usage.inputDetails?.cacheCreation ?? 0,
      });
    }
    if (capture) {
      const parts: SpanMessagePart[] = (call.toolCalls ?? []).map((toolCall, index) => ({
        type: 'tool_call',
        id: callId(index),
        name: toolCall.key,
        arguments: renderValue(toolCall.args),
      }));
      if (result.output !== undefined && result.output !== null) {
        parts.push({ type: 'text', content: toolResultString(result.output) });
      }
      if (parts.length) setOutputContentAttributes(span, capture, [{ role: 'assistant', parts }]);
    }
    span.setStatus({ code: SpanStatusCode.OK });
  } finally {
    endSpan(span, call.endedAt);
  }
}

/**
 * Writes an `execute_tool {name}` span under `parent` for each recorded call,
 * timed by the recorder. Arguments and results are the recorder's rendered
 * text, the same bounded values a judge reads. A call that never settled has
 * no end time, so it gets no span rather than an invented one.
 */
export function recordToolCalls(parent: Span, calls: readonly TrajectoryCall[], capture: boolean): void {
  calls.forEach((call, index) => {
    if (!call.done || call.startedAt === undefined || call.endedAt === undefined) return;
    const span = startSpan(`execute_tool ${call.key}`, parent, call.startedAt);
    try {
      span.setAttribute('gen_ai.operation.name', 'execute_tool');
      span.setAttribute('gen_ai.tool.name', call.key);
      span.setAttribute('gen_ai.tool.call.id', callId(index));
      span.setAttribute('gen_ai.tool.type', 'function');
      setToolCallContentAttributes(span, capture, {
        arguments: renderValue(call.args),
        result: call.error === undefined ? renderValue(call.result) : undefined,
      });
      if (call.error !== undefined) {
        span.setAttribute('error.type', 'tool_error');
        span.setStatus({ code: SpanStatusCode.ERROR, message: call.error });
      } else {
        span.setStatus({ code: SpanStatusCode.OK });
      }
    } finally {
      endSpan(span, call.endedAt);
    }
  });
}

/**
 * Opens `evaluate {criterionType}` under the row's root. The row attributes
 * are set here as well as by the span processor, so the span carries them
 * whichever processor is installed.
 */
export function startCriterionSpan(runId: string, rowIndex: number, criterionType: string, rowSpan: Span): Span {
  const span = startSpan(`evaluate ${criterionType}`, rowSpan);
  span.setAttribute('gen_ai.operation.name', 'evaluate');
  span.setAttributes(rowAttributes(runId, rowIndex));
  return span;
}

/** What {@link finishCriterionSpan} reads from a criterion result. */
export type CriterionOutcome = {
  status: 'COMPLETE' | 'ERROR';
  score?: number;
  reason?: string;
  error?: { cause: string; message: string };
};

/**
 * Records a criterion's outcome on its `evaluate` span. A `COMPLETE` result
 * adds `gen_ai.evaluation.result` with the name and score, mirrored onto the
 * span as the online judge path does, and the reason as the explanation only
 * when `capture` is on. There is no verdict, label or direction: LaunchDarkly
 * rules on the score. An `ERROR` result is an ERROR span with its cause as
 * `error.type`, and no result event.
 */
export function finishCriterionSpan(span: Span, name: string, outcome: CriterionOutcome, capture: boolean): void {
  if (outcome.status === 'COMPLETE' && typeof outcome.score === 'number') {
    const explanation = capture && outcome.reason ? outcome.reason : undefined;
    recordEvaluationOnSpan(span, { name, score: outcome.score, explanation }, true);
    span.setStatus({ code: SpanStatusCode.OK });
    return;
  }
  if (outcome.error?.cause) span.setAttribute('error.type', outcome.error.cause);
  span.setStatus({ code: SpanStatusCode.ERROR, message: outcome.error?.message });
}
