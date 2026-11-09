import { describe, expect, it } from 'vitest';
import { gatewayProviderOptions } from '../inference-region.js';

const bedrock = (region?: string) =>
  ({
    provider: { name: 'Bedrock' },
    model: { name: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0', ...(region === undefined ? {} : { region }) },
  }) as any;

const US = { scope: 'zone', geoRegion: 'us' };
const EU = { scope: 'zone', geoRegion: 'eu' };

describe('gatewayProviderOptions', () => {
  it.each([
    ['us-east-1', US],
    ['us-west-2', US],
    ['US-EAST-2', US],
    ['us', US],
    ['eu-central-1', EU],
    ['eu-west-3', EU],
    ['eu-north-1', EU],
    ['eu-south-2', EU],
    [' eu ', EU],
    ['global', { scope: 'global' }],
  ])('scopes model.region %s to Bedrock', (region, expected) => {
    expect(gatewayProviderOptions(bedrock(region), 'anthropic/claude-sonnet-4-5-20250929')).toEqual({
      gateway: { inferenceRegion: { providers: { bedrock: expected } } },
    });
  });

  it.each([
    'apac',
    'ap-southeast-2',
    'ap-northeast-1',
    'ca-central-1',
    'sa-east-1',
    'us-gov-west-1',
    'me-central-1',
    'au',
    'jp',
  ])('throws for %s, which the Gateway cannot express here', (region) => {
    expect(() => gatewayProviderOptions(bedrock(region), 'anthropic/claude-sonnet-4-5-20250929')).toThrow(
      `Bedrock region "${region}" has no Vercel AI Gateway inference region`,
    );
  });

  it('adds nothing without a region', () => {
    expect(gatewayProviderOptions(bedrock(), 'anthropic/claude-sonnet-4-5-20250929')).toBeUndefined();
    expect(gatewayProviderOptions(bedrock(''), 'anthropic/claude-sonnet-4-5-20250929')).toBeUndefined();
  });

  it('adds nothing for a provider other than Bedrock', () => {
    const config = {
      provider: { name: 'Anthropic' },
      model: { name: 'claude-sonnet-4-5', region: 'eu-west-1' },
    } as any;
    expect(gatewayProviderOptions(config, 'anthropic/claude-sonnet-4-5')).toBeUndefined();
  });

  it('leaves an injected non-Gateway model alone, even for a region the Gateway cannot express', () => {
    const direct = { specificationVersion: 'v4', provider: 'amazon-bedrock', modelId: 'm' };
    expect(gatewayProviderOptions(bedrock('ca-central-1'), direct)).toBeUndefined();
  });

  it('applies to an injected Gateway model', () => {
    const gateway = { specificationVersion: 'v4', provider: 'gateway', modelId: 'm' };
    expect(gatewayProviderOptions(bedrock('eu-central-1'), gateway)).toEqual({
      gateway: { inferenceRegion: { providers: { bedrock: EU } } },
    });
  });

  it('merges into caller gateway options without dropping them', () => {
    const caller = {
      gateway: { order: ['bedrock'], byok: { bedrock: [{ accessKeyId: 'a' }] } },
      bedrock: { reasoningConfig: { type: 'enabled', budgetTokens: 2048 } },
    };
    const result = gatewayProviderOptions(bedrock('us-east-1'), 'model', caller);
    expect(result).toEqual({
      gateway: {
        order: ['bedrock'],
        byok: { bedrock: [{ accessKeyId: 'a' }] },
        inferenceRegion: { providers: { bedrock: US } },
      },
      bedrock: { reasoningConfig: { type: 'enabled', budgetTokens: 2048 } },
    });
    expect(caller.gateway).not.toHaveProperty('inferenceRegion');
  });

  it('adds Bedrock beside other per-provider regions the caller set', () => {
    const caller = { gateway: { inferenceRegion: { providers: { vertex: EU, anthropic: null } } } };
    expect(gatewayProviderOptions(bedrock('us-east-1'), 'model', caller)).toEqual({
      gateway: { inferenceRegion: { providers: { vertex: EU, anthropic: null, bedrock: US } } },
    });
  });

  it.each([
    ['a top-level region', { scope: 'zone', geoRegion: 'eu' }],
    ['a Bedrock region', { providers: { bedrock: EU } }],
    ['an explicitly unpinned Bedrock', { providers: { bedrock: null } }],
  ])('keeps %s the caller set', (_label, inferenceRegion) => {
    const caller = { gateway: { inferenceRegion } };
    expect(gatewayProviderOptions(bedrock('us-east-1'), 'model', caller as any)).toBe(caller);
  });

  it('still rejects an unsupported config region when the caller pins Bedrock', () => {
    const caller = { gateway: { inferenceRegion: { providers: { bedrock: EU } } } };
    expect(() => gatewayProviderOptions(bedrock('apac'), 'model', caller as any)).toThrow('has no Vercel AI Gateway');
  });
});
