import { describe, expect, it } from 'vitest';
import { bedrockInferenceRegion, gatewayRegionProviderOptions } from '../inference-region.js';

const config = (provider: string, region?: string) =>
  ({ provider: { name: provider }, model: { name: 'anthropic.claude-sonnet-4-5-20250929-v1:0', region } }) as any;

describe('bedrockInferenceRegion', () => {
  it.each(['us', 'eu', 'au', 'jp', 'EU', ' us '])('pins Bedrock model.region %j to a Gateway zone', (region) => {
    expect(bedrockInferenceRegion(config('Bedrock', region))).toEqual({
      scope: 'zone',
      geoRegion: region.trim().toLowerCase(),
    });
  });

  it.each([undefined, '', 'global'])('leaves Bedrock model.region %j on the Gateway default', (region) => {
    expect(bedrockInferenceRegion(config('Bedrock', region))).toBeUndefined();
  });

  it.each(['apac', 'ca', 'us-gov', 'us-east-1'])('throws for a region the Gateway cannot pin: %s', (region) => {
    expect(() => bedrockInferenceRegion(config('Bedrock', region))).toThrow(
      `Bedrock model.region "${region}" has no Vercel AI Gateway inference region`,
    );
  });

  it('ignores model.region for providers other than Bedrock', () => {
    expect(bedrockInferenceRegion(config('Anthropic', 'apac'))).toBeUndefined();
  });

  it('accepts the "Amazon Bedrock" provider spelling', () => {
    expect(bedrockInferenceRegion(config('Amazon Bedrock', 'eu'))).toEqual({ scope: 'zone', geoRegion: 'eu' });
  });
});

describe('gatewayRegionProviderOptions', () => {
  it('scopes the region to the bedrock provider for a Gateway model id', () => {
    expect(gatewayRegionProviderOptions(config('Bedrock', 'eu'), 'anthropic/claude-sonnet-4-5-20250929')).toEqual({
      gateway: { inferenceRegion: { providers: { bedrock: { scope: 'zone', geoRegion: 'eu' } } } },
    });
  });

  it('applies to an injected Gateway model', () => {
    const model = { provider: 'gateway', modelId: 'anthropic/claude-sonnet-4.5' } as any;
    expect(gatewayRegionProviderOptions(config('Bedrock', 'us'), model)).toEqual({
      gateway: { inferenceRegion: { providers: { bedrock: { scope: 'zone', geoRegion: 'us' } } } },
    });
  });

  it('neither applies nor throws for an injected non-Gateway model', () => {
    const model = { provider: 'amazon-bedrock', modelId: 'apac.anthropic.claude-sonnet-4-5-20250929-v1:0' } as any;
    expect(gatewayRegionProviderOptions(config('Bedrock', 'apac'), model)).toBeUndefined();
  });

  it('sends nothing when no region is pinned', () => {
    expect(gatewayRegionProviderOptions(config('Bedrock', 'global'), 'anthropic/x')).toBeUndefined();
    expect(gatewayRegionProviderOptions(config('OpenAI', 'eu'), 'openai/gpt-5')).toBeUndefined();
  });
});
