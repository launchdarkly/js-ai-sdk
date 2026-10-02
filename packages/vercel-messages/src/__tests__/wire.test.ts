import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { createVercelMessagesHandler } from '../handler.js';

// This file deliberately does NOT mock `ai`. The handler tests mock generateText/streamText, so
// they only prove what the handler hands to the AI SDK, not that the AI SDK reads it: it silently
// drops any call setting it does not recognize, which is how snake_case `max_tokens` / `top_p`
// went nowhere before. Running the real generateText/streamText against a mock language model
// checks the settings that actually reach the model call.

const parameters = {
  max_tokens: 321,
  top_p: 0.42,
  stop_sequences: ['END'],
  max_retries: 0,
};

const baseConfig = {
  model: { name: 'openai/gpt-5', parameters },
  provider: { name: 'OpenAI' },
  instructions: 'You are helpful.',
};

function capturingModel() {
  return new MockLanguageModelV4({
    doGenerate: async () => {
      throw new Error('aborted: request captured');
    },
    doStream: async () => {
      throw new Error('aborted: request captured');
    },
  });
}

describe('createVercelMessagesHandler, model call (real AI SDK, mock model)', () => {
  it('generateText sends model.parameters to the model as maxOutputTokens / topP / stopSequences', async () => {
    const model = capturingModel();
    await expect(createVercelMessagesHandler({ model })(baseConfig as any, 'hi')).rejects.toThrow();
    expect(model.doGenerateCalls).toHaveLength(1);
    expect(model.doGenerateCalls[0]).toMatchObject({ maxOutputTokens: 321, topP: 0.42, stopSequences: ['END'] });
  });

  it('streamText sends the same settings', async () => {
    const model = capturingModel();
    const stream = createVercelMessagesHandler({ model }).stream?.(baseConfig as any, 'hi', {}, {});
    await expect(
      (async () => {
        for await (const _event of stream as AsyncIterable<unknown>) {
          // drain
        }
      })(),
    ).rejects.toThrow();
    expect(model.doStreamCalls).toHaveLength(1);
    expect(model.doStreamCalls[0]).toMatchObject({ maxOutputTokens: 321, topP: 0.42, stopSequences: ['END'] });
  });
});
