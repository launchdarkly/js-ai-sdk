import type { Span } from '@opentelemetry/api';
import { contextIdentity } from './context.js';
import type { AiConfigRep, HandlerStreamEvent, Message, ProviderHandler, TokenUsage, TrackData } from './types.js';

/**
 * The callable shape of a provider handler before `providesFor` is attached.
 * Uses `Record<string, any>` for `toolHandlers` so that handler
 * implementations typed as `Record<string, Function>` are accepted without a
 * contravariant mismatch at the call site.
 */
type HandlerInput = (
  config: AiConfigRep,
  userInput?: string,
  // biome-ignore lint/suspicious/noExplicitAny: avoids contravariant mismatch with narrowed handler implementations
  toolHandlers?: Record<string, any>,
  variables?: Record<string, unknown>,
  history?: Message[],
) => Promise<{ output?: unknown; usage?: Record<string, unknown> }>;

type StreamHandlerInput = (
  config: AiConfigRep,
  userInput?: string,
  // biome-ignore lint/suspicious/noExplicitAny: avoids contravariant mismatch with narrowed handler implementations
  toolHandlers?: Record<string, any>,
  variables?: Record<string, unknown>,
  history?: Message[],
) => AsyncGenerator<HandlerStreamEvent>;

/**
 * Attaches `providesFor` metadata to a handler function and returns it as a
 * typed `ProviderHandler`. This is the canonical way to build a handler —
 * both package-internal factories and user-supplied custom handlers should use
 * this helper instead of manually assigning `handler.providesFor`.
 *
 * The returned value is the same function reference; `createHandler` mutates
 * in place rather than wrapping.
 *
 * Pass an optional `streamHandler` as the third argument to attach a streaming
 * implementation. When present, `model().stream()` will call it instead of
 * the blocking handler, yielding text chunks in real time. When absent,
 * `model().stream()` falls back to the blocking handler.
 */
export function createHandler(
  providesFor: [string, 'agent' | 'messages'],
  handler: HandlerInput,
  streamHandler?: StreamHandlerInput,
  captureContent?: boolean,
): ProviderHandler {
  const ph = handler as ProviderHandler;
  ph.providesFor = providesFor;
  if (streamHandler) ph.stream = streamHandler;
  if (captureContent !== undefined) ph.captureContent = captureContent;
  return ph;
}

/**
 * Normalizes a variation mode to the handler type used in `providesFor`.
 * Both `'completion'` and `'judge'` configs are served by the `'messages'`
 * handler — they share the same stateless request/response pattern.
 */
export const normalizeMode = (mode: string | undefined): 'agent' | 'messages' =>
  mode === 'agent' ? 'agent' : 'messages';

/**
 * Coerces a provider-reported token count to a finite number, defaulting to 0.
 *
 * Provider SDKs report usage as loosely-typed bags where a field may be absent,
 * null, or (in streaming paths) a partially-populated value. Every count that
 * reaches a span or a `TokenUsage` should pass through here — an emitted `NaN`
 * is worse than an emitted 0, because `trackTokens` guards on `total > 0` and
 * `NaN > 0` is false, so the metric is dropped silently rather than reported low.
 *
 * Exported for this package's own modules and tests, and deliberately absent from
 * `index.ts`: it carries no LaunchDarkly or AI meaning, so publishing it would bind a
 * generic numeric coercion to this package's semver contract. Handler packages keep
 * their own copy of these four lines instead.
 */
export function numberOrZero(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * The provider-neutral token counts a span reports, after the caller has applied
 * its own provider's cache accounting.
 *
 * `input` is the *inclusive* total: whether cache tokens were already counted
 * inside the provider's input figure (OpenAI, LangChain) or reported alongside it
 * and folded in by the caller (Anthropic), by the time a value reaches this type
 * the folding is done. See `setUsageSpanAttributes`.
 */
export type SpanUsage = {
  /** Total input tokens, inclusive of cache-read and cache-creation input. */
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
};

/**
 * Provider usage field names, tried in order; the first row whose input *and* output
 * keys are both present wins. Cache fields list every spelling we accept, because
 * providers disagree (Anthropic `cache_creation_input_tokens`, Bedrock Converse
 * `cacheWriteInputTokens`) and an unlisted spelling is silently dropped from the total.
 *
 * **Contract for handlers:** this fold is provider-blind — it always adds the cache
 * fields on top of the input field. A handler must therefore return *either* raw usage
 * with the cache fields intact (Anthropic-style reporting, where cache is genuinely
 * additional), *or* an input figure that already includes cache with the cache fields
 * omitted (OpenAI- and LangChain-style reporting). Returning a pre-folded input
 * *alongside* the cache fields double-counts the cached portion of every call.
 */
const usageKeyPairs: ReadonlyArray<
  readonly [string, string, ReadonlyArray<string> | undefined, ReadonlyArray<string> | undefined]
> = [
  ['input_tokens', 'output_tokens', ['cache_read_input_tokens'], ['cache_creation_input_tokens']],
  ['inputTokens', 'outputTokens', ['cacheReadInputTokens'], ['cacheCreationInputTokens', 'cacheWriteInputTokens']],
  ['input', 'output', undefined, undefined],
];

/** Sums every accepted spelling of a cache field, so an alias never silently reads as 0. */
const readCacheField = (usage: Record<string, unknown>, keys: ReadonlyArray<string> | undefined): number =>
  keys ? keys.reduce((sum, key) => sum + numberOrZero(usage[key]), 0) : 0;

export const parseUsage = (usage: Record<string, unknown>): TokenUsage => {
  let tokens: TokenUsage = { total: 0, input: 0, output: 0 };

  for (const [inputKey, outputKey, cacheReadKeys, cacheCreationKeys] of usageKeyPairs) {
    if (inputKey in usage && outputKey in usage) {
      const cacheReadInput = readCacheField(usage, cacheReadKeys);
      const cacheCreationInput = readCacheField(usage, cacheCreationKeys);
      const uncachedInput = numberOrZero(usage[inputKey]);
      const input = uncachedInput + cacheReadInput + cacheCreationInput;
      const output = numberOrZero(usage[outputKey]);
      const hasInputDetails =
        cacheReadKeys !== undefined &&
        cacheCreationKeys !== undefined &&
        [...cacheReadKeys, ...cacheCreationKeys].some((key) => key in usage);
      tokens = {
        input,
        output,
        total: input + output,
        ...(hasInputDetails
          ? {
              inputDetails: {
                uncached: uncachedInput,
                cacheRead: cacheReadInput,
                cacheCreation: cacheCreationInput,
              },
            }
          : {}),
      };
      break;
    }
  }

  return tokens;
};

/**
 * Replaces {{variable}} placeholders in a template string with values from a
 * variables object. Supports dot-notation for nested values (e.g. {{user.name}}).
 * Unrecognised placeholders are left as-is.
 */
export function parseTemplate(template: string, variables: Record<string, unknown>): string {
  return template.replace(/\{\{([\w.]+)\}\}/g, (match, path: string) => {
    const value = path.split('.').reduce<unknown>((obj, key) => {
      if (obj !== null && typeof obj === 'object' && key in (obj as object)) {
        return (obj as Record<string, unknown>)[key];
      }
      return undefined;
    }, variables);

    return value !== undefined && value !== null ? String(value) : match;
  });
}

/**
 * Adds a provider's cached-token counts into its input total.
 *
 * Providers describe the same call two different ways. Anthropic reports cache reads and cache
 * writes as buckets *beside* `input_tokens`, so `input_tokens` counts only the new tokens: a turn
 * that read 19,971 tokens from cache and wrote 3,580 more reports `input_tokens: 3`, when the model
 * actually processed 23,554. OpenAI and LangChain report one input figure that already contains the
 * cached tokens, with `cached_tokens` as a subset breakdown.
 *
 * This is for the first kind. Applying it to the second would count the cached tokens twice, which
 * is why the rule lives at the call site and not inside `setUsageSpanAttributes`.
 *
 * Not named for Anthropic: Bedrock Converse reports the same way, and the shape is the reason it
 * applies, not the vendor.
 */
export function addCachedTokensToInput(rawUsage: Record<string, unknown>): SpanUsage {
  const cacheRead = numberOrZero(rawUsage.cache_read_input_tokens);
  const cacheCreation = numberOrZero(rawUsage.cache_creation_input_tokens);
  return {
    input: numberOrZero(rawUsage.input_tokens) + cacheRead + cacheCreation,
    output: numberOrZero(rawUsage.output_tokens),
    cacheRead,
    cacheCreation,
  };
}

/**
 * A run's accumulated token spend, for the `invoke_agent` root.
 *
 * The root is the only span carrying `launchdarkly.*` and the `feature_flag` event, so it is the
 * span a config-scoped query finds. Without a run total on it, that query returns nothing: summing
 * the children requires having already found them.
 */
export interface RunUsage {
  readonly total: SpanUsage;
  /**
   * Whether any turn reported usage at all.
   *
   * The failure path needs this to tell "no call completed" from "a call completed and reported
   * zero". Only the second may be written to a span: all-zero attributes assert the run cost
   * nothing, which a run whose first call died mid-flight cannot claim, whereas an absent attribute
   * correctly says "unknown". Counted rather than derived by testing the total for zero, so a
   * provider reporting a genuinely empty bag stays distinguishable.
   */
  readonly reported: boolean;
  /** Adds one turn. `undefined` is a no-op and does not count as reported. */
  add(turn: SpanUsage | undefined): void;
}

/**
 * Accumulates per-turn `SpanUsage` into a run total.
 *
 * Provider-blind on purpose: it sums four numbers and remembers whether anything was added. The
 * cache-folding rule that differs per provider has already been applied by the time a `SpanUsage`
 * exists — see that type — so each handler maps its own bag first and this stays shared.
 *
 * The two Anthropic handlers deliberately do not use it. Their run total has to stay in Anthropic's
 * own field names with the cache buckets *unfolded*, because it is also the handler's return value
 * and `parseUsage` folds it exactly once; handing back a `SpanUsage` there would count the cache
 * twice. Their accumulators are local for that reason and say so.
 */
export function createRunUsage(): RunUsage {
  const total: SpanUsage = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
  let turns = 0;
  return {
    total,
    get reported() {
      return turns > 0;
    },
    add(turn: SpanUsage | undefined) {
      if (!turn) return;
      turns++;
      total.input += turn.input;
      total.output += turn.output;
      total.cacheRead += turn.cacheRead;
      total.cacheCreation += turn.cacheCreation;
    },
  };
}

/**
 * One LangChain `usage_metadata` bag as `SpanUsage`, or `undefined` when it reports no counts.
 *
 * LangChain already includes cached tokens in `input_tokens`, so nothing is folded here. Shared
 * because both LangChain handlers read the identical shape, and because `undefined` for an empty bag
 * is what keeps a turn the provider said nothing about from registering as reported — the callback
 * path hands over `{}` rather than nothing when a provider omits usage entirely.
 */
export function langChainSpanUsage(usage: Record<string, unknown> | undefined): SpanUsage | undefined {
  if (!usage) return undefined;
  if (usage.input_tokens === undefined && usage.output_tokens === undefined) return undefined;
  const details = (usage.input_token_details ?? {}) as Record<string, unknown>;
  return {
    input: numberOrZero(usage.input_tokens),
    output: numberOrZero(usage.output_tokens),
    cacheRead: numberOrZero(details.cache_read),
    cacheCreation: numberOrZero(details.cache_creation),
  };
}

/**
 * Writes the OpenTelemetry `gen_ai.usage.*` token attributes onto a span.
 *
 * Always writes all five attributes, every time, including zeros. Consumers group
 * and aggregate on the complete set, and an *absent* attribute drops a span from
 * those queries entirely — which reads as "this call had no cached tokens" when it
 * actually means "this handler forgot to say." A provider with no cache-creation
 * concept still reports 0.
 *
 * `total` is always `input + output`. Providers that report their own total are
 * deliberately not trusted here: a provider-supplied figure can include tokens that
 * appear in neither input nor output, which makes `total` non-derivable on one
 * handler and derivable on the rest.
 *
 * This helper does **not** know each provider's cache accounting, and must not learn
 * it. Anthropic reports cache tokens alongside input, so its callers fold them in;
 * OpenAI and LangChain already count cache tokens inside input, so their callers pass
 * the reported figure through untouched. Both arrive here as an inclusive `input`.
 * Centralising that rule would silently double-count for two providers out of three.
 *
 * Attribute names follow the OTel gen_ai semantic conventions, where both cache
 * attributes are documented as values that SHOULD already be included in
 * `gen_ai.usage.input_tokens`.
 */
export function setUsageSpanAttributes(span: Span, usage: SpanUsage): void {
  const input = numberOrZero(usage.input);
  const output = numberOrZero(usage.output);
  span.setAttribute('gen_ai.usage.input_tokens', input);
  span.setAttribute('gen_ai.usage.output_tokens', output);
  span.setAttribute('gen_ai.usage.total_tokens', input + output);
  span.setAttribute('gen_ai.usage.cache_read.input_tokens', numberOrZero(usage.cacheRead));
  span.setAttribute('gen_ai.usage.cache_creation.input_tokens', numberOrZero(usage.cacheCreation));
  // OpenLLMetry aliases for the same two numbers. Gonfalon prefers these names, and they belong here
  // rather than beside the completion text so they cannot disagree with the canonical attributes
  // above: computed at a call site off `rawUsage.input_tokens`, the alias undercounted Anthropic by
  // every cached token, because on Anthropic `input_tokens` excludes the cache.
  span.setAttribute('gen_ai.usage.prompt_tokens', input);
  span.setAttribute('gen_ai.usage.completion_tokens', output);
}

/**
 * Writes the model identity attributes that every LLM span carries.
 *
 * Both spellings of the provider key are emitted on purpose. `gen_ai.system` is the
 * pre-1.37 semconv name and is what handlers shipped before the span hierarchy landed;
 * `gen_ai.provider.name` is the current name and the one the Richer LLM Spans proposal
 * lists. Emitting only the new key would silently break dashboards written against the
 * old one, and emitting only the old one leaves us off-spec — so both go out until the
 * next major.
 *
 * `legacySystem` exists because the two keys do not always want the same value. The LangChain
 * handlers shipped `gen_ai.system = 'langchain'`, but `gen_ai.provider.name` means *who served the
 * model* and its semconv enum has no `langchain` member — so those handlers pass the real provider
 * for the new key and keep the framework name on the old one.
 */
export function setModelIdentityAttributes(
  span: Span,
  providerName: string,
  requestModel: string,
  legacySystem: string = providerName,
): void {
  span.setAttribute('gen_ai.system', legacySystem);
  span.setAttribute('gen_ai.provider.name', providerName);
  span.setAttribute('gen_ai.request.model', requestModel);
}

/**
 * Ends a span exactly once, even when the caller cannot know whether an earlier path
 * already ended it.
 *
 * The streaming handlers need this: a consumer that `break`s out of `for await`, or
 * throws inside the loop body, makes the generator run its `finally` without ever
 * entering `catch` — so the cleanup path and the success path can both reach the same
 * span. An `end()` after `end()` is silently ignored by the OTel SDK but is recorded as
 * a diagnostic error, and double-ending would also hide a genuine leak, so the guard is
 * explicit.
 *
 * An abandoned span is marked with `launchdarkly.stream.abandoned` and deliberately left
 * at `UNSET` rather than `ERROR`. Stopping early is a normal thing for a consumer to do —
 * rendering enough of a response and moving on — and nothing failed. Marking it ERROR
 * would also put the trace at odds with LaunchDarkly's own metrics, which record neither
 * a success nor an error for an abandoned stream: two dashboards would disagree about the
 * same run. The attribute keeps abandonment findable without asserting a failure.
 */
export function endSpanOnce(span: Span, tracker: Set<Span>, abandoned = false): void {
  if (tracker.has(span)) return;
  tracker.add(span);
  if (abandoned) span.setAttribute('launchdarkly.stream.abandoned', true);
  span.end();
}

/**
 * Sets LaunchDarkly config-identifying attributes on an OTel span and emits
 * the `feature_flag` span event required by the AI Config Monitoring Traces tab.
 *
 * Reads the `__ld` entry injected into `variables` by `executeAndTrack` /
 * `executeAndStream`, so handlers never need to receive `TrackData` directly.
 *
 * Span attributes (for LLM dashboard discovery and custom queries):
 *   launchdarkly.operation.type  = 'gen_ai'
 *   launchdarkly.config.key      = configKey
 *   launchdarkly.variation.key   = variationKey
 *   launchdarkly.run.id          = runId
 *   launchdarkly.graph.key       = graphKey    (only when present)
 *
 * Span event (required for AI Config Monitoring tab trace correlation):
 *   name: 'feature_flag'
 *   attributes: feature_flag.key, feature_flag.provider.name, feature_flag.set.id
 *   The observability backend projects these event attrs to span-level attrs,
 *   satisfying the query: events.name=feature_flag AND
 *   events.attributes.feature_flag.key=<configKey> AND
 *   feature_flag.set.id=<environmentId>
 *
 *   Per-kind span attributes `context.contextKeys.<kind>` are what make a
 *   single kind filterable; `feature_flag.context.id` is a composite for a
 *   multi-kind context. See AIC-3230.
 */
export function setLdSpanAttributes(span: Span, variables: Record<string, unknown> | undefined): void {
  span.setAttribute('launchdarkly.operation.type', 'gen_ai');
  const ld = variables?.__ld as TrackData | undefined;
  if (!ld) return;
  span.setAttribute('launchdarkly.config.key', ld.configKey);
  span.setAttribute('launchdarkly.variation.key', ld.variationKey);
  span.setAttribute('launchdarkly.run.id', ld.runId);
  if (ld.graphKey) span.setAttribute('launchdarkly.graph.key', ld.graphKey);

  const featureFlagAttrs: Record<string, string> = {
    'feature_flag.key': ld.configKey,
    'feature_flag.provider.name': 'LaunchDarkly',
  };
  if (ld.environmentId) {
    featureFlagAttrs['feature_flag.set.id'] = ld.environmentId;
  }

  // `executeAndTrack` / `executeAndStream` merge `ldContext` into variables
  // after the caller's own variables, so it is always the evaluation context
  // and cannot be clobbered by a user-supplied variable of the same name.
  const identity = contextIdentity(variables?.ldContext);
  if (identity) {
    // Matches the Go SDK's ldotel hook (`feature_flag.context.id`) and the
    // observability browser SDK (both, plus the per-kind span attributes).
    featureFlagAttrs['feature_flag.context.id'] = identity.canonicalKey;
    featureFlagAttrs['feature_flag.contextKeys'] = JSON.stringify(identity.contextKeys);
    // The canonical key is a composite for a multi-kind context, so it cannot
    // answer "filter to this one user". These per-kind attributes can, and they
    // use the spelling AI Config Monitoring's group-by already speaks.
    for (const [kind, key] of Object.entries(identity.contextKeys)) {
      span.setAttribute(`context.contextKeys.${kind}`, key);
    }
  }

  span.addEvent('feature_flag', featureFlagAttrs);
}

/**
 * Sets OpenLLMetry-style indexed prompt attributes on a span.
 * Gonfalon's LLM Summary tab reads `gen_ai.prompt.N.role` / `.content`
 * (attribute-based, takes precedence over span events).
 */
export function setOpenLLMetryPrompt(span: Span, messages: Array<{ role: string; content: string }>): void {
  for (let i = 0; i < messages.length; i++) {
    span.setAttribute(`gen_ai.prompt.${i}.role`, messages[i].role);
    span.setAttribute(`gen_ai.prompt.${i}.content`, messages[i].content);
  }
}

/**
 * Sets OpenLLMetry-style indexed completion attributes. Gonfalon reads
 * `gen_ai.completion.0.role` / `.content`.
 *
 * The token aliases this used to write moved to `setUsageSpanAttributes`, the one place usage is
 * written. They were computed at each call site straight off the provider's `input_tokens`, which on
 * Anthropic excludes cached tokens — so the alias disagreed with `gen_ai.usage.input_tokens` on the
 * same span, and Gonfalon prefers the alias. One writer, one number.
 */
export function setOpenLLMetryCompletion(span: Span, completion: string): void {
  span.setAttribute('gen_ai.completion.0.role', 'assistant');
  span.setAttribute('gen_ai.completion.0.content', completion);
}

/**
 * When only an agent handler is available for a messages-mode config, collapse
 * all messages into a single `instructions` string so the agent handler receives
 * a well-formed prompt without requiring a separate messages client to be
 * registered. The original config is returned unchanged when `instructions` is
 * already present or there are no messages.
 */
export function collapseMessagesToInstructions(config: AiConfigRep): AiConfigRep {
  const messages: Array<{ role: string; content: string }> = config.messages ?? [];
  if (!messages.length || config.instructions) return config;
  const instructions = messages.map((m) => m.content).join('\n\n');
  return { ...config, instructions, messages: [] };
}

/**
 * Parses a JSON string that may be wrapped in markdown code fences (```json or ```).
 * Also handles text with preamble before the fence block.
 * Returns null if the text cannot be parsed as valid JSON.
 */
export function parseJSONWithPossibleFences<T>(rawText: string): T | null {
  const trimmed = rawText.trim();

  try {
    return JSON.parse(trimmed);
  } catch {
    // not bare JSON — fall through
  }

  // Strip leading/trailing fences (text starts with the fence)
  const strippedLeading = trimmed
    .replace(/^```json\r?\n/, '')
    .replace(/^```\r?\n/, '')
    .replace(/\r?\n```$/, '')
    .trim();

  try {
    return JSON.parse(strippedLeading);
  } catch {
    // not a fence-wrapped block — fall through
  }

  // Find a code fence block anywhere in the text (preamble before the fence)
  const fenceMatch = trimmed.match(/```(?:json)?\r?\n([\s\S]*?)\r?\n```/);
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1].trim());
    } catch {
      // fence block content is not valid JSON — fall through
    }
  }

  return null;
}
