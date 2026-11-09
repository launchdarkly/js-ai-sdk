import type { AiConfigRep } from '@launchdarkly/ai-server';
import type { LanguageModel } from 'ai';

/** The `geoRegion` values AI Gateway accepts for `inferenceRegion: { scope: 'zone' }`. */
const GATEWAY_GEO_REGIONS = new Set(['us', 'eu', 'au', 'jp']);

type GatewayInferenceRegion = { scope: 'zone'; geoRegion: string };

function isBedrock(config: AiConfigRep): boolean {
  const provider = (config.provider?.name ?? '').toLowerCase().replaceAll(/[^a-z0-9]/g, '');
  return provider === 'bedrock' || provider === 'amazonbedrock';
}

function usesGateway(model: LanguageModel | string): boolean {
  return typeof model === 'string' || (typeof model === 'object' && model.provider === 'gateway');
}

/**
 * The Gateway `inferenceRegion` for a Bedrock config's `model.region`, a Bedrock cross-region
 * inference profile prefix such as `us` or `eu`. `global` (or no region) is the Gateway default,
 * so nothing is pinned. A prefix the Gateway has no zone for (`apac`, `ca`, ...) throws rather than
 * silently running the request in another region.
 */
export function bedrockInferenceRegion(config: AiConfigRep): GatewayInferenceRegion | undefined {
  if (!isBedrock(config)) return undefined;
  const region = config.model.region?.trim().toLowerCase();
  if (!region || region === 'global') return undefined;
  if (GATEWAY_GEO_REGIONS.has(region)) return { scope: 'zone', geoRegion: region };
  throw new Error(
    `Bedrock model.region "${config.model.region}" has no Vercel AI Gateway inference region. ` +
      'The Gateway can pin Bedrock to us, eu, au or jp, or leave it global. ' +
      'Set model.region to one of those, or inject a model/modelFactory that calls Bedrock directly.',
  );
}

/**
 * Call-level `providerOptions` pinning the Bedrock region on a Gateway model. Only the
 * `inferenceRegion.providers.bedrock` entry is set: the AI SDK deep-merges call options over a
 * caller's model defaults (`wrapLanguageModel` + `defaultSettingsMiddleware`), so the caller's other
 * `gateway` options (`byok`, `order`, `only`, a top-level `inferenceRegion`, ...) are kept.
 */
export function gatewayRegionProviderOptions(
  config: AiConfigRep,
  model: LanguageModel | string,
): { gateway: { inferenceRegion: { providers: { bedrock: GatewayInferenceRegion } } } } | undefined {
  if (!usesGateway(model)) return undefined;
  const bedrock = bedrockInferenceRegion(config);
  return bedrock ? { gateway: { inferenceRegion: { providers: { bedrock } } } } : undefined;
}
