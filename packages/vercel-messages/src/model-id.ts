import type { AiConfigRep } from '@launchdarkly/ai-server';

/** Creator prefixes returned by https://ai-gateway.vercel.sh/v1/models. */
const GATEWAY_CREATORS: Record<string, string> = {
  alibaba: 'alibaba',
  amazon: 'amazon',
  anthropic: 'anthropic',
  arceeai: 'arcee-ai',
  bfl: 'bfl',
  bytedance: 'bytedance',
  cohere: 'cohere',
  deepseek: 'deepseek',
  fishaudio: 'fish-audio',
  gemini: 'google',
  google: 'google',
  googleai: 'google',
  inception: 'inception',
  inclusionai: 'inclusionai',
  inferencenet: 'inference-net',
  interfaze: 'interfaze',
  klingai: 'klingai',
  meta: 'meta',
  minimax: 'minimax',
  mistral: 'mistral',
  mistralai: 'mistral',
  mixedbread: 'mixedbread',
  moonshotai: 'moonshotai',
  morph: 'morph',
  nvidia: 'nvidia',
  openai: 'openai',
  perplexity: 'perplexity',
  poolside: 'poolside',
  prodia: 'prodia',
  quiverai: 'quiverai',
  recraft: 'recraft',
  sakana: 'sakana',
  spacexai: 'spacexai',
  stepfun: 'stepfun',
  tencent: 'tencent',
  thinkingmachines: 'thinkingmachines',
  typesafe: 'typesafe-ai',
  typesafeai: 'typesafe-ai',
  voyage: 'voyage',
  xiaomi: 'xiaomi',
  xai: 'spacexai',
  zai: 'zai',
};

const providerKey = (value: string): string => value.toLowerCase().replaceAll(/[^a-z0-9]/g, '');

/**
 * Every provider offered by LaunchDarkly AI Configs. A null value means the
 * provider hosts models from multiple creators, or its own models are absent
 * from the current Gateway catalog, so the creator must come from the model.
 */
const PROVIDER_CREATORS: Record<string, string | null> = {
  anthropic: 'anthropic',
  openai: 'openai',
  bedrock: null,
  azure: 'openai',
  gemini: 'google',
  ai21labs: null,
  cohere: 'cohere',
  cortex: null,
  cursor: null,
  databricks: null,
  deepseek: 'deepseek',
  fireworksai: null,
  ibmwatson: null,
  meta: 'meta',
  mistral: 'mistral',
  perplexity: 'perplexity',
  vertex: 'google',
  // Compatibility aliases found in existing configs.
  google: 'google',
  googleai: 'google',
  mistralai: 'mistral',
  spacexai: 'spacexai',
  typesafe: 'typesafe-ai',
  typesafeai: 'typesafe-ai',
  xai: 'spacexai',
};

const MODEL_FAMILY_CREATORS: Array<[RegExp, string]> = [
  [/^(?:gpt|o[1-9])(?:[-.]|$)/i, 'openai'],
  [/^claude(?:[-.]|$)/i, 'anthropic'],
  [/^gemini(?:[-.]|$)/i, 'google'],
  [/^grok(?:[-.]|$)/i, 'spacexai'],
  [/^(?:command|aya)(?:[-.]|$)/i, 'cohere'],
  [/^deepseek(?:[-.]|$)/i, 'deepseek'],
  [/^llama(?:[-.]|$)/i, 'meta'],
  [/^(?:mistral|mixtral|codestral|pixtral)(?:[-.]|$)/i, 'mistral'],
  [/^sonar(?:[-.]|$)/i, 'perplexity'],
  [/^(?:nova|titan)(?:[-.]|$)/i, 'amazon'],
  [/^qwen(?:[-.]|$)/i, 'alibaba'],
];

function creatorFromModel(model: string): { creator: string; model: string } | undefined {
  const parts = model.split('.');
  for (let index = 0; index < parts.length - 1; index += 1) {
    const creator = GATEWAY_CREATORS[providerKey(parts[index])];
    if (creator) return { creator, model: parts.slice(index + 1).join('.') };
  }
  const family = MODEL_FAMILY_CREATORS.find(([pattern]) => pattern.test(model));
  return family ? { creator: family[1], model } : undefined;
}

/**
 * Builds the AI Gateway `creator/model` id from a LaunchDarkly AI Config.
 * Explicit Gateway ids remain authoritative. Dotted creator prefixes used by
 * some LD model configs are converted once; dots inside model versions remain.
 */
export function gatewayModelId(config: AiConfigRep): string {
  const model = config.model.name;
  if (model.includes('/')) return model;

  const provider = config.provider?.name ?? '';
  const providerName = providerKey(provider);
  const inferred = creatorFromModel(model);
  if (inferred) return `${inferred.creator}/${inferred.model}`;

  const creator = PROVIDER_CREATORS[providerName];
  if (creator) return `${creator}/${model}`;

  if (providerName === 'ai21labs' || providerName === 'ibmwatson') {
    throw new Error(
      `Vercel AI Gateway currently exposes no models created by "${provider}". ` +
        'Inject a direct provider model with model/modelFactory instead.',
    );
  }
  if (providerName in PROVIDER_CREATORS) {
    throw new Error(
      `LaunchDarkly provider "${provider}" hosts models from multiple creators, so "${model}" cannot be ` +
        'converted to a Vercel creator/model id. Store an explicit creator/model id or inject a model/modelFactory.',
    );
  }
  throw new Error(
    `Cannot map LaunchDarkly provider "${provider || 'unknown'}" to a Vercel AI Gateway creator. ` +
      'Pass a creator/model id in config.model.name or inject a model/modelFactory.',
  );
}
