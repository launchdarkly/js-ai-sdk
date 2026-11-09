import type { AiConfigRep } from '@launchdarkly/ai-server';
import type { JSONValue } from 'ai';
import { providerKey } from './model-id.js';

type JSONObject = { [key: string]: JSONValue | undefined };
type ProviderOptions = Record<string, JSONObject>;
type GatewayInferenceRegion = { scope: 'zone'; geoRegion: string };

/**
 * The `geoRegion` values the Gateway accepts for `inferenceRegion: { scope: 'zone' }`
 * (https://vercel.com/docs/ai-gateway/security-and-compliance/regional-inference).
 */
const GATEWAY_GEO_REGIONS = new Set(['us', 'eu', 'au', 'jp']);

const BEDROCK_PROVIDERS = new Set(['bedrock', 'amazonbedrock']);

/**
 * The Gateway zone for a Bedrock `model.region`, which holds a cross-region inference-profile
 * prefix such as `us` or `eu`, not an AWS region code. `global`, or no region, is the Gateway
 * default and sends nothing: an explicit `global` fails under a team-wide region pin. A prefix the
 * Gateway has no zone for throws rather than run the request somewhere the config did not ask for.
 */
function bedrockInferenceRegion(configured: string): GatewayInferenceRegion | undefined {
  const region = configured.trim().toLowerCase();
  if (!region || region === 'global') return undefined;
  if (!GATEWAY_GEO_REGIONS.has(region)) {
    throw new Error(
      `Bedrock model.region "${configured}" has no Vercel AI Gateway inference region. ` +
        'The Gateway can pin Bedrock to us, eu, au or jp, or leave it global. ' +
        'Set model.region to one of those, or pass the handler a model that calls Bedrock directly.',
    );
  }
  return { scope: 'zone', geoRegion: region };
}

function routesThroughGateway(model: unknown): boolean {
  if (typeof model === 'string') return true;
  return typeof model === 'object' && model !== null && (model as { provider?: unknown }).provider === 'gateway';
}

function isObject(value: unknown): value is JSONObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The call's `providerOptions`: the caller's, plus a Bedrock-scoped `gateway.inferenceRegion` when a
 * Bedrock config with a `model.region` runs through the AI Gateway. The region goes under
 * `inferenceRegion.providers.bedrock`, so Anthropic or Vertex serving the same model stay
 * unconstrained. A region the caller already set for Bedrock, directly or through a top-level
 * `scope`, wins.
 */
export function gatewayProviderOptions(
  config: AiConfigRep,
  model: unknown,
  callerOptions?: ProviderOptions,
): ProviderOptions | undefined {
  const region = config.model.region;
  if (
    typeof region !== 'string' ||
    !BEDROCK_PROVIDERS.has(providerKey(config.provider?.name ?? '')) ||
    !routesThroughGateway(model)
  ) {
    return callerOptions;
  }
  const bedrock = bedrockInferenceRegion(region);
  if (!bedrock) return callerOptions;
  const gateway = callerOptions?.gateway ?? {};
  const callerRegion = gateway.inferenceRegion;
  if (callerRegion !== undefined && !isObject(callerRegion)) return callerOptions;
  const callerProviders = isObject(callerRegion?.providers) ? callerRegion.providers : {};
  if (callerRegion?.scope !== undefined || Object.hasOwn(callerProviders, 'bedrock')) return callerOptions;
  return {
    ...callerOptions,
    gateway: {
      ...gateway,
      inferenceRegion: { ...callerRegion, providers: { ...callerProviders, bedrock } },
    },
  };
}
