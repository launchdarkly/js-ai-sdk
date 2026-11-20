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
    ['us', US],
    ['eu', EU],
    ['au', { scope: 'zone', geoRegion: 'au' }],
    ['jp', { scope: 'zone', geoRegion: 'jp' }],
    ['US', US],
    [' eu ', EU],
  ])('scopes model.region %s to Bedrock', (region, expected) => {
    expect(gatewayProviderOptions(bedrock(region), 'anthropic/claude-sonnet-4-5-20250929')).toEqual({
      gateway: { inferenceRegion: { providers: { bedrock: expected } } },
    });
  });

  it('accepts the Amazon Bedrock provider spelling', () => {
    const config = { ...bedrock('jp'), provider: { name: 'Amazon Bedrock' } };
    expect(gatewayProviderOptions(config, 'model')).toEqual({
      gateway: { inferenceRegion: { providers: { bedrock: { scope: 'zone', geoRegion: 'jp' } } } },
    });
  });

  it.each([
    'apac',
    'ca',
    'in',
    'us-gov',
    'us-east-1',
    'eu-central-1',
    'ap-southeast-2',
  ])('throws for %s, which the Gateway has no zone for', (region) => {
    expect(() => gatewayProviderOptions(bedrock(region), 'anthropic/claude-sonnet-4-5-20250929')).toThrow(
      `Bedrock model.region "${region}" has no Vercel AI Gateway inference region. ` +
        'The Gateway can pin Bedrock to us, eu, au or jp, or leave it global. ' +
        'Set model.region to one of those, or pass the handler a model that calls Bedrock directly.',
    );
  });

  it.each([undefined, '', '  ', 'global', 'GLOBAL'])('sends nothing for region %j', (region) => {
    expect(gatewayProviderOptions(bedrock(region), 'anthropic/claude-sonnet-4-5-20250929')).toBeUndefined();
  });

  it('returns caller options unchanged for a global region', () => {
    const caller = { gateway: { order: ['bedrock'] } };
    expect(gatewayProviderOptions(bedrock('global'), 'model', caller)).toBe(caller);
  });

  it('adds nothing for a provider other than Bedrock', () => {
    const config = {
      provider: { name: 'Anthropic' },
      model: { name: 'claude-sonnet-4-5', region: 'eu' },
    } as any;
    expect(gatewayProviderOptions(config, 'anthropic/claude-sonnet-4-5')).toBeUndefined();
  });

  it('leaves an injected non-Gateway model alone, even for a region the Gateway cannot express', () => {
    const direct = { specificationVersion: 'v4', provider: 'amazon-bedrock', modelId: 'm' };
    expect(gatewayProviderOptions(bedrock('ca'), direct)).toBeUndefined();
  });

  it('applies to an injected Gateway model', () => {
    const gateway = { specificationVersion: 'v4', provider: 'gateway', modelId: 'm' };
    expect(gatewayProviderOptions(bedrock('eu'), gateway)).toEqual({
      gateway: { inferenceRegion: { providers: { bedrock: EU } } },
    });
  });

  it('merges into caller gateway options without dropping them', () => {
    const caller = {
      gateway: { order: ['bedrock'], byok: { bedrock: [{ accessKeyId: 'a' }] } },
      bedrock: { reasoningConfig: { type: 'enabled', budgetTokens: 2048 } },
    };
    const result = gatewayProviderOptions(bedrock('us'), 'model', caller);
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
    expect(gatewayProviderOptions(bedrock('us'), 'model', caller)).toEqual({
      gateway: { inferenceRegion: { providers: { vertex: EU, anthropic: null, bedrock: US } } },
    });
  });

  it.each([
    ['a top-level region', { scope: 'zone', geoRegion: 'eu' }],
    ['a Bedrock region', { providers: { bedrock: EU } }],
    ['an explicitly unpinned Bedrock', { providers: { bedrock: null } }],
  ])('keeps %s the caller set', (_label, inferenceRegion) => {
    const caller = { gateway: { inferenceRegion } };
    expect(gatewayProviderOptions(bedrock('us'), 'model', caller as any)).toBe(caller);
  });

  it('still rejects an unsupported config region when the caller pins Bedrock', () => {
    const caller = { gateway: { inferenceRegion: { providers: { bedrock: EU } } } };
    expect(() => gatewayProviderOptions(bedrock('apac'), 'model', caller as any)).toThrow('has no Vercel AI Gateway');
  });
});
