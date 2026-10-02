import {
  type AiConfigRep,
  camelizeModelParameters,
  normalizeModelParameters,
  pickForwardedModelParameters,
} from '@launchdarkly/ai-server';
import type { experimental_evaluate, generateText, LanguageModelCallOptions, RequestOptions } from 'ai';

/**
 * AI SDK call settings this package's `generateText` / `streamText` calls take from
 * `config.model.parameters`, after the renames in `buildModelParameterOptions`.
 *
 * The AI SDK drops any call setting it does not recognize without an error, so a key that is
 * not spelled exactly as below (snake_case `max_tokens`, `top_p`) reaches nothing. This list is
 * every `LanguageModelCallOptions` and `RequestOptions` field, minus the exclusions below, plus
 * the two `generateText` fields a config can meaningfully set as JSON: `toolChoice` and
 * `providerOptions`.
 *
 * Handler-owned (set by the handler from the config and the call shape, never from
 * `model.parameters`): `model`, `messages`, `prompt`, `system`, `instructions`, `tools`,
 * `stopWhen`, `output`.
 *
 * Excluded: `abortSignal`, which cannot be expressed in a JSON config and belongs to the caller.
 * Every other `generateText` field (callbacks, telemetry, tool repair, approval, `activeTools`,
 * `include`, ...) is either a function or wiring this handler does not expose, so it is not
 * forwarded.
 */
const FORWARDED_MODEL_PARAMETER_KEYS = [
  'frequencyPenalty',
  'headers',
  'maxOutputTokens',
  'maxRetries',
  'presencePenalty',
  'providerOptions',
  'reasoning',
  'seed',
  'stopSequences',
  'temperature',
  'timeout',
  'toolChoice',
  'topK',
  'topP',
] as const satisfies ReadonlyArray<keyof Parameters<typeof generateText>[0]>;

type VercelExcludedKeys = 'abortSignal';
// If the AI SDK adds a call setting and it is not classified above as forwarded or excluded,
// this type resolves to something other than `never` and the assignment below fails to compile,
// naming the unclassified key.
type VercelUndecidedModelParameterKeys = Exclude<
  keyof LanguageModelCallOptions | keyof RequestOptions,
  VercelExcludedKeys | (typeof FORWARDED_MODEL_PARAMETER_KEYS)[number]
>;
const _vercelModelParameterKeysExhaustive: Record<VercelUndecidedModelParameterKeys, never> = {} as Record<
  never,
  never
>;

/**
 * `config.model.parameters` as AI SDK call settings. The LaunchDarkly UI writes provider names
 * in snake_case, so the bag is camelized (`top_p` becomes `topP`; nested values are left alone,
 * and snake_case wins when both spellings are set), after two renames to the AI SDK's own names:
 *
 * - `max_tokens` / `max_completion_tokens` / `max_output_tokens` become `maxOutputTokens`. An
 *   explicit `max_output_tokens` wins, then `max_completion_tokens`, then `max_tokens`.
 * - `reasoning_effort` (OpenAI's name) becomes `reasoning`, whose values it shares. An explicit
 *   `reasoning` wins.
 *
 * Only `FORWARDED_MODEL_PARAMETER_KEYS` survive. A config that sets none of them produces `{}`,
 * so the call sees exactly what it always has.
 */
export function buildModelParameterOptions(parameters: AiConfigRep['model']['parameters']): Record<string, unknown> {
  const { max_tokens, max_completion_tokens, max_output_tokens, reasoning_effort, ...rest } =
    normalizeModelParameters(parameters);
  const renamed: Record<string, unknown> = { ...rest };
  const maxOutputTokens = max_output_tokens ?? max_completion_tokens ?? max_tokens;
  if (maxOutputTokens !== undefined) renamed.max_output_tokens = maxOutputTokens;
  if (reasoning_effort !== undefined && renamed.reasoning === undefined) renamed.reasoning = reasoning_effort;
  return pickForwardedModelParameters(camelizeModelParameters(renamed), FORWARDED_MODEL_PARAMETER_KEYS);
}

/**
 * `experimental_evaluate` request fields `vercelEvaluate` takes from `config.model.parameters`.
 * The evaluate call accepts no generation settings at all (no temperature, no token limit), so
 * those are not forwarded here.
 *
 * Handler-owned: `model`, `state`, `questions`. Excluded: `abortSignal`, as above.
 */
const FORWARDED_EVALUATE_PARAMETER_KEYS = ['headers', 'maxRetries', 'providerOptions'] as const;

type EvaluateHandlerOwnedKeys = 'model' | 'questions' | 'state';
type EvaluateExcludedKeys = 'abortSignal';
type EvaluateUndecidedModelParameterKeys = Exclude<
  keyof Parameters<typeof experimental_evaluate>[0],
  EvaluateHandlerOwnedKeys | EvaluateExcludedKeys | (typeof FORWARDED_EVALUATE_PARAMETER_KEYS)[number]
>;
const _evaluateModelParameterKeysExhaustive: Record<EvaluateUndecidedModelParameterKeys, never> = {} as Record<
  never,
  never
>;

/** `config.model.parameters`, camelized, narrowed to what `experimental_evaluate` accepts. */
export function buildEvaluateParameterOptions(parameters: AiConfigRep['model']['parameters']): Record<string, unknown> {
  return pickForwardedModelParameters(
    camelizeModelParameters(normalizeModelParameters(parameters)),
    FORWARDED_EVALUATE_PARAMETER_KEYS,
  );
}
