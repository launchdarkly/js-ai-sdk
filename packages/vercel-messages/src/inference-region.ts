import type { AiConfigRep } from '@launchdarkly/ai-server';
import type { JSONValue } from 'ai';
import { providerKey } from './model-id.js';

type JSONObject = { [key: string]: JSONValue | undefined };
type ProviderOptions = Record<string, JSONObject>;
type GatewayInferenceRegion = { scope: 'global' } | { scope: 'zone'; geoRegion: 'us' | 'eu' };

const US_REGION = /^us-(?:east|west)-\d+$/;
const EU_REGION = /^eu-(?:central|west|north|south)-\d+$/;

/**
 * The Gateway `inferenceRegion` for a Bedrock `model.region`. The Gateway pins a geography, not an
 * AWS region, so `eu-central-1` asks for any EU data center. Only the geographies that map
 * one-to-one onto Bedrock's own `us`, `eu` and `global` inference profiles are accepted; GovCloud,
 * Asia Pacific, Canada and the rest throw rather than run somewhere the config did not ask for.
 */
function bedrockInferenceRegion(region: string): GatewayInferenceRegion {
  const value = region.trim().toLowerCase();
  if (value === 'global') return { scope: 'global' };
  if (value === 'us' || US_REGION.test(value)) return { scope: 'zone', geoRegion: 'us' };
  if (value === 'eu' || EU_REGION.test(value)) return { scope: 'zone', geoRegion: 'eu' };
  throw new Error(
    `Bedrock region "${region}" has no Vercel AI Gateway inference region this handler supports ` +
      '("us", "eu", "global", or a us-/eu- AWS region). Inject a direct Bedrock model with ' +
      'model/modelFactory to call that region.',
  );
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
  if (!region || providerKey(config.provider?.name ?? '') !== 'bedrock' || !routesThroughGateway(model)) {
    return callerOptions;
  }
  const bedrock = bedrockInferenceRegion(region);
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
