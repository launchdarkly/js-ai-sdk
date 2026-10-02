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
    parameters: { max_tokens: 321, top_p: 0.42, stop_sequences: ['END'], max_retries: 0 },
  },
  provider: { name: 'OpenAI' },
  instructions: 'You are an agent.',
};

describe('createVercelAgentsHandler, model call (real ToolLoopAgent, mock model)', () => {
  it('sends model.parameters to the model as maxOutputTokens / topP / stopSequences', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new Error('aborted: request captured');
      },
    });
    await expect(createVercelAgentsHandler({ model })(baseConfig as any, 'hi')).rejects.toThrow();
    expect(model.doGenerateCalls).toHaveLength(1);
    expect(model.doGenerateCalls[0]).toMatchObject({ maxOutputTokens: 321, topP: 0.42, stopSequences: ['END'] });
  });
});
