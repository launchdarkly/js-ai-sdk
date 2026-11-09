import { describe, expect, it } from 'vitest';
import { gatewayModelId } from '../model-id.js';

const config = (provider: string, model = 'model') => ({ provider: { name: provider }, model: { name: model } }) as any;

describe('gatewayModelId', () => {
  it.each([
    ['Anthropic', 'model', 'anthropic/model'],
    ['OpenAI', 'model', 'openai/model'],
    ['Bedrock', 'anthropic.claude-sonnet-4', 'anthropic/claude-sonnet-4'],
    ['Azure', 'model', 'openai/model'],
    ['Gemini', 'model', 'google/model'],
    ['Cohere', 'model', 'cohere/model'],
    ['Cortex', 'llama-4-scout', 'meta/llama-4-scout'],
    ['Cursor', 'claude-sonnet-4', 'anthropic/claude-sonnet-4'],
    ['Databricks', 'llama-4-maverick', 'meta/llama-4-maverick'],
    ['DeepSeek', 'model', 'deepseek/model'],
    ['Fireworks AI', 'qwen-3-235b', 'alibaba/qwen-3-235b'],
    ['Meta', 'model', 'meta/model'],
    ['Mistral', 'model', 'mistral/model'],
    ['Perplexity', 'model', 'perplexity/model'],
    ['Vertex', 'model', 'google/model'],
  ])('maps LaunchDarkly provider %s', (provider, model, expected) => {
    expect(gatewayModelId(config(provider, model))).toBe(expected);
  });

  it.each(['AI21 Labs', 'IBM Watson'])('fails locally for unsupported creator %s', (provider) => {
    expect(() => gatewayModelId(config(provider))).toThrow('currently exposes no models created by');
  });

  it('preserves an explicit Gateway id', () => {
    expect(gatewayModelId(config('Bedrock', 'amazon/nova-pro'))).toBe('amazon/nova-pro');
  });

  it('removes a Bedrock region and dotted creator prefix', () => {
    expect(gatewayModelId(config('Bedrock', 'us.anthropic.claude-sonnet-4'))).toBe('anthropic/claude-sonnet-4');
  });

  it.each([
    ['anthropic.claude-sonnet-4-5-20250929-v1:0', 'anthropic/claude-sonnet-4-5-20250929'],
    ['us.anthropic.claude-sonnet-4-5-20250929-v1:0', 'anthropic/claude-sonnet-4-5-20250929'],
    ['eu.anthropic.claude-sonnet-4-5-20250929-v1:0', 'anthropic/claude-sonnet-4-5-20250929'],
    ['global.anthropic.claude-sonnet-4-5-20250929-v1:0', 'anthropic/claude-sonnet-4-5-20250929'],
    ['anthropic.claude-haiku-4-5-20251001-v1:0', 'anthropic/claude-haiku-4-5-20251001'],
    ['amazon.nova-pro-v1:0', 'amazon/nova-pro'],
    ['anthropic.claude-sonnet-4-5-20250929-v1:0:200k', 'anthropic/claude-sonnet-4-5-20250929'],
  ])('maps the full Bedrock id %s to %s', (model, expected) => {
    expect(gatewayModelId(config('Bedrock', model))).toBe(expected);
  });

  it('keeps a version that is part of the model name', () => {
    expect(gatewayModelId(config('Bedrock', 'amazon.titan-embed-text-v2'))).toBe('amazon/titan-embed-text-v2');
  });

  it('leaves an explicit Gateway id alone even when it ends like a Bedrock version', () => {
    expect(gatewayModelId(config('Bedrock', 'anthropic/claude-sonnet-4.5'))).toBe('anthropic/claude-sonnet-4.5');
  });

  it('fails locally when a multi-model host has no identifiable creator', () => {
    expect(() => gatewayModelId(config('Databricks', 'custom-deployment'))).toThrow(
      'hosts models from multiple creators',
    );
  });
});
