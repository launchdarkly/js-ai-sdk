import type { ChatAnthropicInput } from '@langchain/anthropic';
import type { ChatBedrockConverseInput } from '@langchain/aws';
import type { GoogleGenerativeAIChatInput } from '@langchain/google-genai';
import type { ChatOpenAIFields } from '@langchain/openai';
import {
  type AiConfigRep,
  camelizeModelParameters,
  normalizeModelParameters,
  pickForwardedModelParameters,
} from '@launchdarkly/ai-server';

/**
 * The allowlists below are the cross-SDK LangChain lists, the same lists the Python SDK
 * forwards, in the camelCase the LangChain constructors
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
 * - `useResponsesApi`, `reasoning`: API-shape switches. `useResponsesApi` moves `ChatOpenAI` to
 *   the Responses API, and so does a `reasoning` with a `summary`, which changes the response
 *   shape the handler reads. The Python SDK forwards the Chat Completions `reasoning_effort`
 *   instead; the TypeScript `ChatOpenAI` takes that only per call, so it is not
 *   supported in TypeScript.
 * - `audio`, `modalities`: change the output type, not how text is generated.
 * - `promptCacheRetention`, `zdrEnabled`: data retention.
 * - `user`: identity and attribution.
 *
 * `promptCacheKey` is forwarded here but not supported in Python, because the
 * Python `ChatOpenAI` has no such constructor field.
 */
export const CHAT_OPENAI_FORWARDED_KEYS = [
  'frequencyPenalty',
  'logitBias',
  'logprobs',
  'maxCompletionTokens',
  'maxTokens',
  'n',
  'presencePenalty',
  'promptCacheKey',
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
 * shapes, which `ChatAnthropic` sends as written, so they are not converted. `outputConfig` keeps
 * only `effort` (see `toAnthropicOutputConfig`).
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

/**
 * `ChatGoogleGenerativeAI` constructor fields this package takes from `config.model.parameters`,
 * after camelizing the bag and applying the renames in `modelConstructorParameters`.
 *
 * Never forwarded: `apiKey`, `apiVersion`, `baseUrl`, `customHeaders`, `model`, and:
 * - `safetySettings`: safety configuration rather than a generation setting.
 * - `json`: switches the response to JSON, which the handler owns through `outputFormat`.
 * - `convertSystemMessageToHumanContent`: changes how the handler's system prompt is sent.
 *
 * `seed`, `frequency_penalty`, `presence_penalty` and `media_resolution` are on the cross-SDK
 * Gemini list but not supported in TypeScript: the TypeScript `ChatGoogleGenerativeAI` has no such
 * fields.
 *
 * `thinkingConfig` is built from the flat `thinking_budget` and `thinking_level` keys (see
 * `toGeminiThinkingConfig`). A nested `thinking_config` in `model.parameters` is never read, and
 * `include_thoughts` is never forwarded, because it puts the model's thought summaries in the reply
 * content the handler returns.
 */
export const CHAT_GOOGLE_GENERATIVE_AI_FORWARDED_KEYS = [
  'maxOutputTokens',
  'stopSequences',
  'temperature',
  'thinkingConfig',
  'topK',
  'topP',
] as const satisfies ReadonlyArray<keyof GoogleGenerativeAIChatInput>;

export type LangChainModelClass = 'openai' | 'anthropic' | 'bedrock' | 'gemini';

const FORWARDED_KEYS: Record<LangChainModelClass, ReadonlyArray<string>> = {
  openai: CHAT_OPENAI_FORWARDED_KEYS,
  anthropic: CHAT_ANTHROPIC_FORWARDED_KEYS,
  bedrock: CHAT_BEDROCK_CONVERSE_FORWARDED_KEYS,
  gemini: CHAT_GOOGLE_GENERATIVE_AI_FORWARDED_KEYS,
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The `thinking` variants the Anthropic Messages API takes (`ThinkingConfigParam`), each with its
 * required and optional sub-keys besides `type`. `ChatAnthropic` sends `thinking` as written, so
 * the same shapes as the Claude Messages handler apply.
 */
const ANTHROPIC_THINKING_SHAPES: Record<string, { required: ReadonlyArray<string>; optional: ReadonlyArray<string> }> =
  {
    enabled: { required: ['budget_tokens'], optional: ['display'] },
    adaptive: { required: [], optional: ['display'] },
    disabled: { required: [], optional: [] },
  };

/**
 * `thinking` with only the sub-keys its `type` takes, or `undefined` when it is not an object,
 * its `type` is missing or unknown, or a required sub-key is missing. The API rejects all of those.
 */
function toAnthropicThinking(value: unknown): Record<string, unknown> | undefined {
  if (
    !isPlainObject(value) ||
    typeof value.type !== 'string' ||
    !Object.hasOwn(ANTHROPIC_THINKING_SHAPES, value.type)
  ) {
    return undefined;
  }
  const { required, optional } = ANTHROPIC_THINKING_SHAPES[value.type];
  if (required.some((key) => value[key] === undefined || value[key] === null)) return undefined;
  const thinking: Record<string, unknown> = { type: value.type };
  for (const key of [...required, ...optional]) {
    if (value[key] !== undefined && value[key] !== null) thinking[key] = value[key];
  }
  return thinking;
}

/**
 * `outputConfig` rebuilt as `{ effort }`, or `undefined` when there is no string effort. An
 * explicit `output_config.effort` wins over a top-level `effort`. Every other sub-key is dropped:
 * `format` is structured output, which the handler owns through `outputFormat`, and forwarding it
 * would make the API enforce a schema the handler did not ask for.
 */
function toAnthropicOutputConfig(effort: unknown, outputConfig: unknown): { effort: string } | undefined {
  const explicit = isPlainObject(outputConfig) ? outputConfig.effort : undefined;
  const chosen = typeof explicit === 'string' ? explicit : effort;
  return typeof chosen === 'string' ? { effort: chosen } : undefined;
}

/** The `thinking_level` values the Gemini API takes, compared ignoring case. */
const GEMINI_THINKING_LEVELS: ReadonlyArray<string> = ['minimal', 'low', 'medium', 'high', 'xhigh'];

/**
 * The Gemini `thinkingConfig` built from the flat `thinking_budget` and `thinking_level` keys, or
 * `undefined` when neither is usable. A `thinking_level` outside `GEMINI_THINKING_LEVELS` is
 * dropped, and a `thinking_budget` that is not a whole number is dropped (`-1` is dynamic thinking
 * and `0` turns it off). When both are kept, the level wins and the budget is dropped, because the
 * Gemini API rejects a request that sets both. The level is sent in upper case, the API's spelling.
 */
function toGeminiThinkingConfig(budget: unknown, level: unknown): Record<string, unknown> | undefined {
  if (typeof level === 'string' && GEMINI_THINKING_LEVELS.includes(level.toLowerCase())) {
    return { thinkingLevel: level.toUpperCase() };
  }
  return Number.isInteger(budget) ? { thinkingBudget: budget } : undefined;
}

/**
 * Nested values each model class reads as objects. A value of the wrong shape is dropped rather
 * than passed on.
 */
const NESTED_SHAPE_CHECKS: Record<LangChainModelClass, Record<string, (value: unknown) => boolean>> = {
  openai: { logitBias: isPlainObject },
  anthropic: {},
  bedrock: { performanceConfig: isPlainObject },
  gemini: {},
};

/**
 * `config.model.parameters` as constructor fields for one LangChain chat model class: camelized
 * (`top_p` becomes `topP`; nested values are left alone), then narrowed to that class's allowlist.
 * The input keys are the snake_case ones: a key with an uppercase letter, such as a camelCase
 * `maxTokens`, is dropped before camelizing, like any other key not in the table. Unknown keys and
 * malformed nested values are dropped.
 *
 * Renames before the allowlist is applied:
 * - `ChatOpenAI` reads its service tier as `service_tier`, so a camelized `serviceTier` is
 *   renamed back.
 * - `ChatAnthropic` has no `effort` field; a top-level `effort` becomes `outputConfig.effort`.
 *   An explicit `output_config.effort` wins, and `outputConfig` keeps nothing else.
 * - `ChatAnthropic` has no `maxTokensToSample` or `stop` field. `max_tokens_to_sample` is another
 *   name for `max_tokens` and becomes `maxTokens`, and `stop` is another name for `stop_sequences`
 *   and becomes `stopSequences`. When both names are set, `max_tokens` and `stop_sequences` win.
 * - `ChatGoogleGenerativeAI` names its output limit `maxOutputTokens` and has no `stop` field.
 *   `max_tokens` becomes `maxOutputTokens` and `stop` becomes `stopSequences`. When both names are
 *   set, `max_output_tokens` and `stop_sequences` win. Its `thinkingConfig` is built from the flat
 *   `thinking_budget` and `thinking_level` keys, and a nested `thinking_config` is dropped.
 */
export function modelConstructorParameters(
  parameters: AiConfigRep['model']['parameters'] | unknown,
  modelClass: LangChainModelClass,
): Record<string, unknown> {
  const snakeCase = Object.fromEntries(
    Object.entries(normalizeModelParameters(parameters)).filter(([key]) => key === key.toLowerCase()),
  );
  const camelized = camelizeModelParameters(snakeCase);
  if (modelClass === 'openai' && camelized.serviceTier !== undefined) {
    camelized.service_tier = camelized.serviceTier;
    delete camelized.serviceTier;
  }
  if (modelClass === 'anthropic') {
    const outputConfig = toAnthropicOutputConfig(camelized.effort, camelized.outputConfig);
    if (outputConfig) camelized.outputConfig = outputConfig;
    else delete camelized.outputConfig;
    camelized.maxTokens ??= camelized.maxTokensToSample;
    camelized.stopSequences ??= camelized.stop;
  }
  if (modelClass === 'gemini') {
    camelized.maxOutputTokens ??= camelized.maxTokens;
    camelized.stopSequences ??= camelized.stop;
    const thinkingConfig = toGeminiThinkingConfig(camelized.thinkingBudget, camelized.thinkingLevel);
    if (thinkingConfig) camelized.thinkingConfig = thinkingConfig;
    else delete camelized.thinkingConfig;
  }
  const picked = pickForwardedModelParameters(camelized, FORWARDED_KEYS[modelClass]);
  for (const [key, isWellFormed] of Object.entries(NESTED_SHAPE_CHECKS[modelClass])) {
    if (picked[key] !== undefined && !isWellFormed(picked[key])) delete picked[key];
  }
  if (modelClass === 'anthropic' && picked.thinking !== undefined) {
    const thinking = toAnthropicThinking(picked.thinking);
    if (thinking) picked.thinking = thinking;
    else delete picked.thinking;
  }
  return picked;
}
