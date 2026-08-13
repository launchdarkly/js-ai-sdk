import type { Span } from '@opentelemetry/api';

/**
 * Conversation content on spans, per LaunchDarkly's "Richer LLM spans" proposal.
 *
 * Two rules drive everything in this file.
 *
 * **Attributes, not events.** Canonical content lives on span attributes. OTEP 4430 deprecated the
 * span-event recording API, and LaunchDarkly's ingest does not normalize content events into the
 * canonical shape — a `gen_ai.content.prompt` event, which is what these handlers emitted before,
 * is read by nothing on the LaunchDarkly side.
 *
 * **Off by default.** Everything here is conversation content, which is PII. A handler opts in with
 * `captureContent: true`; every function below takes that decision as its `capture` argument and
 * returns without writing when it is false. Passing the flag rather than reading ambient state
 * keeps the gate visible at each call site.
 *
 * Handlers also test the same flag themselves before building the argument, so the check appears
 * twice on purpose: the guard here is the safety net that makes a forgotten call site harmless, and
 * the guard there avoids walking a conversation and serializing JSON that would then be discarded —
 * per model turn, in a loop.
 *
 * Two carriers are written for the same content, deliberately:
 *
 * - `gen_ai.input.messages` / `gen_ai.output.messages` / `gen_ai.system_instructions` /
 *   `gen_ai.tool.definitions` — the canonical JSON shape from the OTel GenAI semconv, and the shape
 *   the proposal makes normative.
 * - `gen_ai.prompt.{i}.role|content` / `gen_ai.completion.{i}.role|content` — the OpenLLMetry shape,
 *   one numbered attribute per field.
 *   LaunchDarkly's LLM trace view and conversation view read *only* this one today, so canonical
 *   attributes alone would render as an empty transcript.
 *
 * A third carrier is written alongside them: the `gen_ai.content.prompt` / `gen_ai.content.completion`
 * span events. OTEP 4430 deprecated the span-event recording API and LaunchDarkly's ingest reads
 * nothing from them, so they are redundant today — but they are what every published version of
 * these handlers has emitted, and removing them would silently break any consumer that learned to
 * read them. They are written from the same messages and behind the same gate as everything else
 * here, so the three carriers cannot disagree.
 *
 * Both are listed as supported in the proposal's attribute table; the OpenLLMetry pair is annotated there
 * as being kept "so today's LLM trace view still renders it". Drop the flat writes once the reader
 * parses the canonical attributes.
 */

/**
 * The one knob every handler factory accepts for content capture.
 *
 * Shared rather than redeclared per package so the name, the default and the docstring cannot drift
 * apart across the six handlers.
 */
export interface ContentCaptureOptions {
  /**
   * Put prompts, model output, tool arguments and tool results on the emitted spans.
   *
   * Defaults to `false`. Conversation content is PII, so a run emits only metadata — models, token
   * counts, timings, tool names — until a caller asks for more. Turning this on sends the text of
   * every request and response to whatever OTel endpoint the SDK is configured with.
   */
  captureContent?: boolean;
}

/** A typed piece of one message, mirroring the `parts` union in the GenAI JSON schemas. */
export type SpanMessagePart =
  | { type: 'text'; content: string }
  | { type: 'reasoning'; content: string }
  | { type: 'tool_call'; id?: string; name: string; arguments?: unknown }
  | { type: 'tool_call_response'; id?: string; result?: unknown };

/** One turn of the conversation, in the canonical `{ role, parts }` shape. */
export interface SpanMessage {
  role: 'system' | 'user' | 'assistant' | 'tool' | (string & {});
  parts: SpanMessagePart[];
  /** Output messages only. Why the model stopped producing this message. */
  finishReason?: string;
}

/** Convenience for the common case: a whole message that is one block of text. */
export const textMessage = (role: SpanMessage['role'], content: string): SpanMessage => ({
  role,
  parts: [{ type: 'text', content }],
});

/**
 * Flattens a message's parts to the single string the flat `gen_ai.prompt.{i}.content` carrier
 * holds. Text and reasoning contribute their text; tool traffic is JSON, because OpenLLMetry has
 * no place to put structure.
 */
function partToText(part: SpanMessagePart): string {
  switch (part.type) {
    case 'text':
    case 'reasoning':
      return part.content;
    case 'tool_call':
      return JSON.stringify({ name: part.name, arguments: part.arguments ?? null });
    default:
      // An absent result contributes nothing, so `partsToText` drops it and the flat carriers agree
      // with the canonical one, which omits the key. Coercing it to `null` first rendered it as the
      // literal text `null`, which reads in the trace view as a tool that returned a null value
      // rather than one that returned nothing.
      //
      // An explicit `null` result still renders as `null`, because that is what the canonical
      // carrier reports for it. The two cases differ, and only one of them is a claim about what
      // the tool returned.
      if (part.result === undefined) return '';
      return typeof part.result === 'string' ? part.result : JSON.stringify(part.result);
  }
}

/** One `role: content` line, the shape the legacy content events have always carried. */
function eventLine(message: SpanMessage): string {
  return `${message.role}: ${partsToText(message.parts)}`;
}

function partsToText(parts: SpanMessagePart[]): string {
  return parts
    .map(partToText)
    .filter((text) => text.length > 0)
    .join('\n');
}

/** The canonical JSON form: `snake_case` keys, and no `undefined` members. */
function toCanonicalMessage(message: SpanMessage): Record<string, unknown> {
  const canonical: Record<string, unknown> = { role: message.role, parts: message.parts };
  if (message.finishReason !== undefined) canonical.finish_reason = message.finishReason;
  return canonical;
}

/**
 * Writes the OpenLLMetry carrier: one numbered attribute per field, rather than one attribute holding
 * the whole structure. `prefix` is `gen_ai.prompt` or `gen_ai.completion` — the only difference
 * between the input and output halves, which is why this is one parameterised function.
 *
 * Named for the convention rather than the shape. OpenLLMetry predates the GenAI semantic
 * conventions and is what LaunchDarkly's LLM trace view parses today, so a reader who needs to know
 * why `gen_ai.prompt.0.role` looks the way it does has somewhere to go and look it up.
 *
 * An empty message list writes nothing rather than writing a zero-length marker: the reader treats
 * a missing key and an empty list identically, and a run with no content should leave no trace of
 * having tried.
 */
function setOpenLLMetryMessages(span: Span, prefix: string, messages: SpanMessage[]): void {
  messages.forEach((message, index) => {
    span.setAttribute(`${prefix}.${index}.role`, message.role);
    span.setAttribute(`${prefix}.${index}.content`, partsToText(message.parts));
  });
}

/**
 * Every provider spelling this SDK actually serves, mapped onto semconv's finish-reason vocabulary.
 *
 * The vocabulary is `stop`, `length`, `content_filter`, `tool_calls` and `error`. Anthropic and
 * OpenAI are the only two vendors behind these six handlers, so they are the only two rows here —
 * a spelling from a vendor nothing in this SDK talks to is a guess, and the passthrough below is
 * already the right answer for one.
 *
 * Keys are compared lower-cased. Not for any vendor's sake: it costs one `toLowerCase()` and means
 * a provider that shouts its enum is mapped rather than passed through as a stray value.
 *
 * `pause_turn` is deliberately absent. Anthropic returns it when a long-running server-side tool
 * suspends a turn that has not actually finished, and no semconv value means "did not finish" — so
 * it falls through to the passthrough rather than being flattened into `stop`.
 */
const SEMCONV_FINISH_REASONS: Record<string, string> = {
  // Anthropic `stop_reason`
  end_turn: 'stop',
  stop_sequence: 'stop',
  max_tokens: 'length',
  tool_use: 'tool_calls',
  refusal: 'content_filter',
  // OpenAI Chat Completions `finish_reason` — mostly already the vocabulary
  stop: 'stop',
  length: 'length',
  tool_calls: 'tool_calls',
  content_filter: 'content_filter',
  function_call: 'tool_calls',
};

/**
 * Maps one provider's own finish reason onto semconv's `gen_ai.response.finish_reasons` vocabulary.
 *
 * This SDK used to pass the provider's string through untranslated on four of six handlers, on the
 * argument that translating `end_turn` into `stop` loses information. Measuring it settled the
 * argument the other way: a single Actuator run emits `chat` spans from more than one handler, so a
 * consumer grouping by finish reason saw `stop` and `end_turn` as two different outcomes for the
 * same event. Cross-handler consistency is the whole point of the attribute, and it is what the
 * semantic conventions ask for — an enum, not whatever the vendor happened to name it.
 *
 * Nothing is lost. The provider's own wording is still on the span: the raw response is what
 * `gen_ai.output.messages` was built from, and an unrecognised reason is passed through verbatim
 * rather than dropped or coerced, so a new vendor spelling shows up as itself instead of silently
 * becoming `stop`. That passthrough is the signal to add a row to the table above.
 */
export function toSemconvFinishReason(raw: string | null | undefined): string | undefined {
  if (typeof raw !== 'string' || !raw) return undefined;
  return SEMCONV_FINISH_REASONS[raw.toLowerCase()] ?? raw;
}

/**
 * Reads the finish reasons out of a LangChain `LLMResult` or a single `AIMessage`.
 *
 * Both shapes are accepted because both are what the handlers hold: `langchain-agents` finishes a
 * turn from an `LLMResult` in `handleLLMEnd`, while `langchain-messages` finishes one from the
 * `AIMessage` that `invoke()` returned.
 *
 * LangChain does not normalise the field, so it is read from every place providers put it:
 * `generationInfo.finish_reason` (OpenAI) and `response_metadata.finish_reason` or
 * `.stop_reason` (Anthropic), then mapped onto the semconv vocabulary by
 * `toSemconvFinishReason` — LangChain is the one place where the same handler can serve either
 * vendor, so it is where an untranslated passthrough is least defensible.
 *
 * Returns undefined rather than an empty array when nothing is present, so a caller leaves the
 * attribute off instead of asserting that the turn finished for no reason.
 *
 * Shared here for the same reason as `langChainSpanMessages`: both LangChain handlers need exactly
 * this, and a copy in each package is how the span code in this SDK drifted apart the last time.
 */
export function langChainFinishReasons(source: unknown): string[] | undefined {
  const generations = (source as { generations?: unknown[] })?.generations;
  const candidates = Array.isArray(generations) ? (generations.flat() as unknown[]) : [source];

  const reasons: string[] = [];
  for (const candidate of candidates) {
    const reason = toSemconvFinishReason(finishReasonOf(candidate));
    if (reason) reasons.push(reason);
  }
  return reasons.length > 0 ? reasons : undefined;
}

/** A `ChatGeneration` holds the message under `message`; an `AIMessage` is itself the message. */
function finishReasonOf(candidate: unknown): string | undefined {
  const record = (candidate ?? {}) as Record<string, unknown>;
  const info = (record.generationInfo ?? {}) as Record<string, unknown>;
  const message = (record.message ?? record) as Record<string, unknown>;
  const metadata = (message.response_metadata ?? {}) as Record<string, unknown>;
  const reason = info.finish_reason ?? metadata.finish_reason ?? metadata.stop_reason;
  return typeof reason === 'string' && reason ? reason : undefined;
}

/**
 * Converts LangChain `BaseMessage`s into canonical span messages, lifting the system prompt out.
 *
 * Shared here rather than copied into `langchain-messages` and `langchain-agents`: both need the
 * exact same conversion, and a copy in each package is how the span code in this SDK drifted apart
 * the last time. The narrowing is structural — `_getType()`, `content`, `tool_calls` — so the client
 * takes no dependency on `@langchain/core`.
 *
 * LangChain names its roles `human` / `ai`; the semconv vocabulary is `user` / `assistant`.
 */
export function langChainSpanMessages(messages: ReadonlyArray<unknown>): {
  systemInstructions?: string;
  messages: SpanMessage[];
} {
  const system: string[] = [];
  const converted: SpanMessage[] = [];

  for (const raw of messages as Array<Record<string, unknown>>) {
    const type = typeof raw._getType === 'function' ? String((raw._getType as () => string)()) : '';
    const text = langChainContentText(raw.content);

    if (type === 'system' || type === 'developer') {
      if (text) system.push(text);
      continue;
    }

    const parts: SpanMessagePart[] = [];
    if (text) parts.push({ type: 'text', content: text });

    if (type === 'tool') {
      converted.push({
        role: 'tool',
        parts: [
          {
            type: 'tool_call_response',
            id: typeof raw.tool_call_id === 'string' ? raw.tool_call_id : undefined,
            result: text,
          },
        ],
      });
      continue;
    }

    if (Array.isArray(raw.tool_calls)) {
      for (const call of raw.tool_calls as Array<Record<string, unknown>>) {
        parts.push({
          type: 'tool_call',
          id: typeof call.id === 'string' ? call.id : undefined,
          name: String(call.name ?? ''),
          arguments: call.args,
        });
      }
    }

    converted.push({ role: type === 'human' ? 'user' : type === 'ai' ? 'assistant' : type || 'user', parts });
  }

  return { systemInstructions: system.length > 0 ? system.join('\n') : undefined, messages: converted };
}

/**
 * LangChain message content is a string, or a list holding typed blocks and bare strings.
 *
 * `MessageContent` is `string | Array<string | MessageContentComplex>`, so a bare string in the list
 * is what the library documents, not a malformed input. Keeping only the blocks whose `type` is
 * `text` dropped those strings, and the span then showed less of the conversation than the model was
 * given.
 */
function langChainContentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return (content as unknown[])
    .map((block) => {
      if (typeof block === 'string') return block;
      const typed = block as Record<string, unknown> | null;
      return typed?.type === 'text' ? String(typed.text ?? '') : '';
    })
    .filter((text) => text.length > 0)
    .join('');
}

/**
 * One entry of the tool catalog, as it was actually offered to the model.
 *
 * Deliberately not `Tool` from the AI Config: a handler filters the configured tools down to the
 * ones it has a registered implementation for, and it is that filtered set the model saw. Recording
 * the unfiltered config would misreport what the model could have called.
 */
export interface ToolDefinitionInput {
  name: string;
  description?: string;
  parameters?: unknown;
}

/**
 * Records what the model was given: system instructions, the messages, and the tool catalog.
 *
 * `systemInstructions` is written both to its own attribute and, when present, as message 0 of the
 * OpenLLMetry carrier — that shape has no separate slot for it, and dropping it there would hide the
 * system prompt from the only view that renders today.
 */
export function setInputContentAttributes(
  span: Span,
  capture: boolean,
  input: {
    systemInstructions?: string;
    messages?: SpanMessage[];
    toolDefinitions?: ReadonlyArray<ToolDefinitionInput>;
  },
): void {
  if (!capture) return;

  const { systemInstructions, messages = [], toolDefinitions } = input;

  if (systemInstructions) {
    span.setAttribute('gen_ai.system_instructions', JSON.stringify([{ type: 'text', content: systemInstructions }]));
  }

  if (messages.length > 0) {
    span.setAttribute('gen_ai.input.messages', JSON.stringify(messages.map(toCanonicalMessage)));
  }

  // The system prompt is a message here, unlike in the canonical carrier where it has its own
  // attribute. OpenLLMetry has no separate slot for it, so it goes in at index 0.
  const openLLMetryMessages = systemInstructions ? [textMessage('system', systemInstructions), ...messages] : messages;
  setOpenLLMetryMessages(span, 'gen_ai.prompt', openLLMetryMessages);
  span.addEvent('gen_ai.content.prompt', {
    'gen_ai.prompt': openLLMetryMessages.map(eventLine).join('\n'),
  });

  if (toolDefinitions) setToolDefinitionAttributes(span, capture, toolDefinitions);
}

/** Records what the model produced. */
export function setOutputContentAttributes(span: Span, capture: boolean, messages: SpanMessage[]): void {
  if (!capture || messages.length === 0) return;
  span.setAttribute('gen_ai.output.messages', JSON.stringify(messages.map(toCanonicalMessage)));
  setOpenLLMetryMessages(span, 'gen_ai.completion', messages);
  span.addEvent('gen_ai.content.completion', {
    'gen_ai.completion': messages.map((message) => partsToText(message.parts)).join('\n'),
  });
}

/**
 * Records the tools the model was allowed to call.
 *
 * The catalog is content because tool descriptions and parameter schemas routinely embed
 * customer-specific detail, so it sits behind the same gate as the messages.
 */
export function setToolDefinitionAttributes(
  span: Span,
  capture: boolean,
  tools: ReadonlyArray<ToolDefinitionInput>,
): void {
  if (!capture || tools.length === 0) return;
  const definitions = tools.map((tool) => ({
    type: 'function',
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    ...(tool.parameters ? { parameters: tool.parameters } : {}),
  }));
  span.setAttribute('gen_ai.tool.definitions', JSON.stringify(definitions));
}

/**
 * Records one tool call's arguments and result on its `execute_tool` span.
 *
 * Both are stringified rather than written as native attribute values: an argument bag is an object,
 * and OTel attributes hold only primitives and arrays of primitives.
 */
export function setToolCallContentAttributes(
  span: Span,
  capture: boolean,
  io: { arguments?: unknown; result?: unknown },
): void {
  if (!capture) return;
  if (io.arguments !== undefined) {
    span.setAttribute('gen_ai.tool.call.arguments', stringifyToolValue(io.arguments));
  }
  if (io.result !== undefined) {
    span.setAttribute('gen_ai.tool.call.result', stringifyToolValue(io.result));
  }
}

/** A string passes through unchanged; anything else becomes JSON. */
function stringifyToolValue(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value ?? null);
}
