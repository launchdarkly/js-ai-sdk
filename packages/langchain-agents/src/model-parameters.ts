import type { ChatAnthropicInput } from '@langchain/anthropic';
import type { ChatBedrockConverseInput } from '@langchain/aws';
import type { ChatOpenAIFields } from '@langchain/openai';
import {
  type AiConfigRep,
  camelizeModelParameters,
  normalizeModelParameters,
  pickForwardedModelParameters,
} from '@launchdarkly/ai-server';

/**
 * The allowlists below are the LangChain lists in the cross-SDK spec (ai-sdks-monorepo TESTING.md
 * §1.12), the same lists the Python SDK forwards, in the camelCase the LangChain constructors
 * read. Only settings that shape what the model generates are on them. Adding a key after 1.0
 * breaks nobody, and removing one does, so a key that does not clearly shape generation stays off.
 *
 * Never forwarded to any model class: the `BaseChatModelParams` fields (`callbacks`, `cache`,
 * `maxConcurrency`, `metadata`, `tags`, `verbose`, `disableStreaming`, `outputVersion`), which are
 * wiring, tracing, logging and response shape rather than generation settings; `maxRetries`
 * (client retry policy); and `streaming` / `streamUsage`, which the handler's call shape decides.
 */

/**
 * `ChatOpenAI` constructor fields this package takes from `config.model.parameters`, after
 * camelizing the bag.
 *
 * Never forwarded: `apiKey`, `openAIApiKey`, `configuration` (client options, including the base
 * URL, default headers, fetch and proxy settings), `timeout`, `maxRetries`, `modelKwargs` (merged
 * into the request body as written), `prefixMessages` (prompt content), `model` / `modelName`
 * (the handler sets the model), the client internals `completions`, `responses`,
 * `__includeRawResponse` and `supportsStrictToolCalling`, and:
 * - `reasoning`, `useResponsesApi`: switch `ChatOpenAI` to the Responses API, which changes the
 *   response shape the handler reads. Reasoning control is not forwarded until both SDKs can set it
 *   without switching APIs.
 * - `audio`, `modalities`: change the output type, not how text is generated.
 * - `promptCacheRetention`, `zdrEnabled`: data retention.
 * - `user`: identity and attribution.
 * - `promptCacheKey`: the Python `ChatOpenAI` has no such field, so the cross-SDK list cuts it for
 *   both SDKs.
 */
export const CHAT_OPENAI_FORWARDED_KEYS = [
  'frequencyPenalty',
  'logitBias',
  'logprobs',
  'maxCompletionTokens',
  'maxTokens',
  'n',
  'presencePenalty',
  'service_tier',
  'stop',
  'stopSequences',
  'temperature',
  'topLogprobs',
  'topP',
  'verbosity',
] as const satisfies ReadonlyArray<keyof ChatOpenAIFields>;

/**
 * `ChatAnthropic` constructor fields this package takes from `config.model.parameters`, after
 * camelizing the bag and applying the renames in `modelConstructorParameters`.
 *
 * Never forwarded: `apiKey`, `anthropicApiKey`, `anthropicApiUrl`, `clientOptions` (including
 * default headers and fetch), `createClient`, `invocationKwargs` (merged into the request body as
 * written), `mcpServers` (remote tools), `model` / `modelName`, and:
 * - `inferenceGeo`: decides where data is processed.
 * - `contextManagement`: server-side state.
 *
 * Nested values (`thinking`, `outputConfig`) are the Anthropic Messages API's own snake_case
 * shapes, which `ChatAnthropic` sends as written, so they are not converted.
 */
export const CHAT_ANTHROPIC_FORWARDED_KEYS = [
  'betas',
  'maxTokens',
  'outputConfig',
  'stopSequences',
  'temperature',
  'thinking',
  'topK',
  'topP',
] as const satisfies ReadonlyArray<keyof ChatAnthropicInput>;

/**
 * `ChatBedrockConverse` constructor fields this package takes from `config.model.parameters`,
 * after camelizing the bag.
 *
 * Never forwarded: `additionalModelRequestFields` (merged into the request body as written),
 * `region`, `credentials`, `bedrockApiKey`, `bedrockApiSecret`,
 * `bedrockApiSessionToken`, the AWS credential-provider settings (`profile`, `roleArn`, ...),
 * `endpointHost`, `client`, `clientOptions`, `defaultHeaders`, `model`,
 * `applicationInferenceProfile` (which replaces the model the handler resolved), and:
 * - `guardrailConfig`: applies a guardrail rather than shaping generation.
 * - `supportsToolChoiceValues`: tool behaviour the handler depends on.
 */
export const CHAT_BEDROCK_CONVERSE_FORWARDED_KEYS = [
  'maxTokens',
  'performanceConfig',
  'serviceTier',
  'temperature',
  'topP',
] as const satisfies ReadonlyArray<keyof ChatBedrockConverseInput>;

export type LangChainModelClass = 'openai' | 'anthropic' | 'bedrock';

const FORWARDED_KEYS: Record<LangChainModelClass, ReadonlyArray<string>> = {
  openai: CHAT_OPENAI_FORWARDED_KEYS,
  anthropic: CHAT_ANTHROPIC_FORWARDED_KEYS,
  bedrock: CHAT_BEDROCK_CONVERSE_FORWARDED_KEYS,
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Nested values each model class reads as objects. A value of the wrong shape (not an object, or
 * a `thinking` without the `type` the Anthropic API requires) is dropped rather than passed on.
 */
const NESTED_SHAPE_CHECKS: Record<LangChainModelClass, Record<string, (value: unknown) => boolean>> = {
  openai: { logitBias: isPlainObject },
  anthropic: {
    outputConfig: isPlainObject,
    thinking: (value) => isPlainObject(value) && typeof value.type === 'string',
  },
  bedrock: { performanceConfig: isPlainObject },
};

/**
 * `config.model.parameters` as constructor fields for one LangChain chat model class: camelized
 * (`top_p` becomes `topP`; nested values are left alone, and snake_case wins when both spellings
 * are set), then narrowed to that class's allowlist. Unknown keys and malformed nested values are
 * dropped.
 *
 * Renames before the allowlist is applied:
 * - `ChatOpenAI` reads its service tier as `service_tier`, so a camelized `serviceTier` is
 *   renamed back.
 * - `ChatAnthropic` has no `effort` field; a top-level `effort` becomes `outputConfig.effort`.
 *   An explicit `output_config.effort` wins.
 * - `ChatAnthropic` has no `maxTokensToSample` or `stop` field. `max_tokens_to_sample` is another
 *   name for `max_tokens` and becomes `maxTokens`, and `stop` is another name for `stop_sequences`
 *   and becomes `stopSequences`. When both names are set, `max_tokens` and `stop_sequences` win.
 */
export function modelConstructorParameters(
  parameters: AiConfigRep['model']['parameters'] | unknown,
  modelClass: LangChainModelClass,
): Record<string, unknown> {
  const camelized = camelizeModelParameters(normalizeModelParameters(parameters));
  if (modelClass === 'openai' && camelized.serviceTier !== undefined) {
    camelized.service_tier = camelized.serviceTier;
    delete camelized.serviceTier;
  }
  if (modelClass === 'anthropic') {
    if (camelized.effort !== undefined) {
      const outputConfig = isPlainObject(camelized.outputConfig) ? camelized.outputConfig : {};
      camelized.outputConfig = { effort: camelized.effort, ...outputConfig };
    }
    camelized.maxTokens ??= camelized.maxTokensToSample;
    camelized.stopSequences ??= camelized.stop;
  }
  const picked = pickForwardedModelParameters(camelized, FORWARDED_KEYS[modelClass]);
  for (const [key, isWellFormed] of Object.entries(NESTED_SHAPE_CHECKS[modelClass])) {
    if (picked[key] !== undefined && !isWellFormed(picked[key])) delete picked[key];
  }
  return picked;
}
