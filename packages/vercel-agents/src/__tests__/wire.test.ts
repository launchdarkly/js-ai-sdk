import { defaultSettingsMiddleware, wrapLanguageModel } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { createVercelAgentsHandler } from '../handler.js';

// This file deliberately does NOT mock `ai`. The handler tests mock ToolLoopAgent, so they only
// prove what the handler hands to the AI SDK, not that the AI SDK reads it: it silently drops any
// call setting it does not recognize, which is how snake_case `max_tokens` / `top_p` went nowhere
// before. Running a real ToolLoopAgent against a mock language model checks the settings that
// actually reach the model call.

const baseConfig = {
  model: {
    name: 'openai/gpt-5',
    parameters: { max_tokens: 321, top_p: 0.42, stop_sequences: ['END'] },
  },
  provider: { name: 'OpenAI' },
  instructions: 'You are an agent.',
};

const bedrockConfig = {
  model: { name: 'anthropic.claude-sonnet-4-5-20250929-v1:0', region: 'eu' },
  provider: { name: 'Bedrock' },
  instructions: 'You are an agent.',
};

function capturingModel(provider?: string) {
  return new MockLanguageModelV4({
    ...(provider ? { provider } : {}),
    doGenerate: async () => {
      throw new Error('aborted: request captured');
    },
  });
}

describe('createVercelAgentsHandler, model call (real ToolLoopAgent, mock model)', () => {
  it('sends model.parameters to the model as maxOutputTokens / topP / stopSequences', async () => {
    const model = capturingModel();
    await expect(createVercelAgentsHandler({ model })(baseConfig as any, 'hi')).rejects.toThrow();
    expect(model.doGenerateCalls).toHaveLength(1);
    expect(model.doGenerateCalls[0]).toMatchObject({ maxOutputTokens: 321, topP: 0.42, stopSequences: ['END'] });
  });

  it("merges the Bedrock region into the caller's Gateway options instead of replacing them", async () => {
    const inner = capturingModel('gateway');
    const model = wrapLanguageModel({
      model: inner,
      middleware: defaultSettingsMiddleware({
        settings: {
          providerOptions: {
            gateway: {
              order: ['bedrock', 'anthropic'],
              byok: { bedrock: [{ accessKeyId: 'id', secretAccessKey: 'secret' }] },
              inferenceRegion: { scope: 'zone', geoRegion: 'us', providers: { anthropic: null } },
            },
          },
        },
      }),
    });
    await expect(createVercelAgentsHandler({ model })(bedrockConfig as any, 'hi')).rejects.toThrow('request captured');
    expect(inner.doGenerateCalls[0].providerOptions).toEqual({
      gateway: {
        order: ['bedrock', 'anthropic'],
        byok: { bedrock: [{ accessKeyId: 'id', secretAccessKey: 'secret' }] },
        inferenceRegion: {
          scope: 'zone',
          geoRegion: 'us',
          providers: { anthropic: null, bedrock: { scope: 'zone', geoRegion: 'eu' } },
        },
      },
    });
  });

  it('sends no Gateway options to a model that is not the Gateway', async () => {
    const model = capturingModel('amazon-bedrock');
    await expect(
      createVercelAgentsHandler({ model })(
        { ...bedrockConfig, model: { ...bedrockConfig.model, region: 'apac' } } as any,
        'hi',
      ),
    ).rejects.toThrow('request captured');
    expect(model.doGenerateCalls[0].providerOptions).toBeUndefined();
  });

  it('fails before any model call when the Gateway cannot pin the Bedrock region', async () => {
    const model = capturingModel('gateway');
    await expect(
      createVercelAgentsHandler({ model })(
        { ...bedrockConfig, model: { ...bedrockConfig.model, region: 'apac' } } as any,
        'hi',
      ),
    ).rejects.toThrow('Bedrock model.region "apac" has no Vercel AI Gateway inference region');
    expect(model.doGenerateCalls).toHaveLength(0);
  });
});
