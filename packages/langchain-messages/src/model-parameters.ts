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
 * Constructor fields every LangChain chat model takes from `BaseChatModelParams` that a config
 * can set as JSON. `callbacks`, `callbackManager`, `cache` and `maxConcurrency` are wiring, and
 * `maxRetries` is client retry policy, so none of them are forwarded.
 */
const BASE_CHAT_MODEL_KEYS = ['disableStreaming', 'metadata', 'outputVersion', 'tags', 'verbose'] as const;

/**
 * `ChatOpenAI` constructor fields this package takes from `config.model.parameters`, after
 * camelizing the bag. Mirrors the Python SDK's `ChatOpenAI` list.
 *
 * Never forwarded: `apiKey`, `openAIApiKey`, `configuration` (client options, including the base
 * URL, default headers, fetch and proxy settings), `timeout`, `maxRetries`, `modelKwargs` (merged
 * into the request body as written), `prefixMessages` (prompt content), `model` / `modelName`
 * (the handler sets the model), and the client internals `completions`, `responses`,
 * `__includeRawResponse` and `supportsStrictToolCalling`.
 */
export const CHAT_OPENAI_FORWARDED_KEYS = [
  ...BASE_CHAT_MODEL_KEYS,
  'audio',
  'frequencyPenalty',
  'logitBias',
  'logprobs',
  'maxCompletionTokens',
  'maxTokens',
  'modalities',
  'n',
  'presencePenalty',
  'promptCacheKey',
  'promptCacheRetention',
  'reasoning',
  'service_tier',
  'stop',
  'stopSequences',
  'streamUsage',
  'streaming',
  'temperature',
  'topLogprobs',
  'topP',
  'useResponsesApi',
  'user',
  'verbosity',
  'zdrEnabled',
] as const satisfies ReadonlyArray<keyof ChatOpenAIFields>;

/**
 * `ChatAnthropic` constructor fields this package takes from `config.model.parameters`, after
 * camelizing the bag. Mirrors the Python SDK's `ChatAnthropic` list, minus `mcp_servers` (remote
 * tools) and `model_kwargs` (request injection), neither of which a config may set.
 *
 * Never forwarded: `apiKey`, `anthropicApiKey`, `anthropicApiUrl`, `clientOptions` (including
 * default headers and fetch), `createClient`, `invocationKwargs` (merged into the request body as
 * written), and `model` / `modelName`.
 *
 * Nested values (`thinking`, `contextManagement`, `outputConfig`) are the Anthropic Messages API's
 * own snake_case shapes, which `ChatAnthropic` sends as written, so they are not converted. A
 * top-level `effort` (the name the UI writes) becomes `outputConfig.effort`; see
 * `modelConstructorParameters`.
 */
export const CHAT_ANTHROPIC_FORWARDED_KEYS = [
  ...BASE_CHAT_MODEL_KEYS,
  'betas',
  'contextManagement',
  'inferenceGeo',
  'maxTokens',
  'outputConfig',
  'stopSequences',
  'streamUsage',
  'streaming',
  'temperature',
  'thinking',
  'topK',
  'topP',
] as const satisfies ReadonlyArray<keyof ChatAnthropicInput>;

/**
 * `ChatBedrockConverse` constructor fields this package takes from `config.model.parameters`,
 * after camelizing the bag. Mirrors the Python SDK's `ChatBedrockConverse` list, minus
 * `region_name`, which is connection configuration.
 *
 * Never forwarded: `additionalModelRequestFields` (merged into the request body as written),
 * `region`, `credentials`, `bedrockApiKey`, `bedrockApiSecret`,
 * `bedrockApiSessionToken`, the AWS credential-provider settings (`profile`, `roleArn`, ...),
 * `endpointHost`, `client`, `clientOptions`, `defaultHeaders`, `model`, and
 * `applicationInferenceProfile` (which replaces the model the handler resolved).
 */
export const CHAT_BEDROCK_CONVERSE_FORWARDED_KEYS = [
  ...BASE_CHAT_MODEL_KEYS,
  'guardrailConfig',
  'maxTokens',
  'performanceConfig',
  'serviceTier',
  'streamUsage',
  'streaming',
  'supportsToolChoiceValues',
  'temperature',
  'topP',
] as const satisfies ReadonlyArray<keyof ChatBedrockConverseInput>;

export type LangChainModelClass = 'openai' | 'anthropic' | 'bedrock';

const FORWARDED_KEYS: Record<LangChainModelClass, ReadonlyArray<string>> = {
  openai: CHAT_OPENAI_FORWARDED_KEYS,
  anthropic: CHAT_ANTHROPIC_FORWARDED_KEYS,
  bedrock: CHAT_BEDROCK_CONVERSE_FORWARDED_KEYS,
};

/**
 * `config.model.parameters` as constructor fields for one LangChain chat model class: camelized
 * (`top_p` becomes `topP`; nested values are left alone, and snake_case wins when both spellings
 * are set), then narrowed to that class's allowlist. Unknown keys are dropped.
 *
 * Renames before the allowlist is applied:
 * - `ChatOpenAI` reads its service tier as `service_tier`, so a camelized `serviceTier` is
 *   renamed back.
 * - `ChatAnthropic` has no `effort` field; a top-level `effort` becomes `outputConfig.effort`.
 *   An explicit `output_config.effort` wins.
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
  if (modelClass === 'anthropic' && camelized.effort !== undefined) {
    const outputConfig =
      camelized.outputConfig && typeof camelized.outputConfig === 'object' && !Array.isArray(camelized.outputConfig)
        ? (camelized.outputConfig as Record<string, unknown>)
        : {};
    camelized.outputConfig = { effort: camelized.effort, ...outputConfig };
  }
  return pickForwardedModelParameters(camelized, FORWARDED_KEYS[modelClass]);
}
