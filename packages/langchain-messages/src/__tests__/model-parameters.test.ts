import { describe, expect, it } from 'vitest';
import { modelConstructorParameters } from '../model-parameters.js';
import { expectNoNeverForwardedValue, NEVER_FORWARDED_PARAMETERS } from './never-forwarded.js';

describe('modelConstructorParameters', () => {
  it.each(['openai', 'anthropic', 'bedrock'] as const)('drops every never-forwarded key for %s', (modelClass) => {
    const args = modelConstructorParameters({ ...NEVER_FORWARDED_PARAMETERS, temperature: 0.5 }, modelClass);
    expect(args).toEqual({ temperature: 0.5 });
    expectNoNeverForwardedValue(args);
  });

  it.each(['openai', 'anthropic', 'bedrock'] as const)('drops unknown keys and model for %s', (modelClass) => {
    expect(
      modelConstructorParameters(
        { model: 'smuggled', model_name: 'smuggled', tools: ['x'], unknown_key: 1, callbacks: [] },
        modelClass,
      ),
    ).toEqual({});
  });

  // The cross-SDK LangChain lists (TESTING.md §1.12), each key with a well-formed value. Every
  // removed key is in NEVER_FORWARDED_PARAMETERS, which is mixed in so the result proves it is gone.
  it('forwards exactly the canonical ChatOpenAI keys, under their constructor names', () => {
    expect(
      modelConstructorParameters(
        {
          ...NEVER_FORWARDED_PARAMETERS,
          frequency_penalty: 0.1,
          logit_bias: { '50256': -100 },
          logprobs: true,
          max_completion_tokens: 200,
          max_tokens: 100,
          n: 2,
          presence_penalty: 0.2,
          service_tier: 'flex',
          stop: ['END'],
          stop_sequences: ['STOP'],
          temperature: 0.2,
          top_logprobs: 3,
          top_p: 0.9,
          verbosity: 'low',
        },
        'openai',
      ),
    ).toEqual({
      frequencyPenalty: 0.1,
      logitBias: { '50256': -100 },
      logprobs: true,
      maxCompletionTokens: 200,
      maxTokens: 100,
      n: 2,
      presencePenalty: 0.2,
      // ChatOpenAI reads this one field in snake_case.
      service_tier: 'flex',
      stop: ['END'],
      stopSequences: ['STOP'],
      temperature: 0.2,
      topLogprobs: 3,
      topP: 0.9,
      verbosity: 'low',
    });
  });

  it('forwards exactly the canonical ChatAnthropic keys, keeps nested Messages API shapes, and folds effort into outputConfig', () => {
    expect(
      modelConstructorParameters(
        {
          ...NEVER_FORWARDED_PARAMETERS,
          betas: ['context-1m-2025-08-07'],
          effort: 'low',
          max_tokens: 100,
          output_config: { format: { type: 'json_schema', schema: {} } },
          stop_sequences: ['END'],
          temperature: 0.2,
          thinking: { type: 'enabled', budget_tokens: 1024 },
          top_k: 40,
          top_p: 0.9,
        },
        'anthropic',
      ),
    ).toEqual({
      betas: ['context-1m-2025-08-07'],
      maxTokens: 100,
      // ChatAnthropic sends these to the Messages API as written, so they stay snake_case.
      outputConfig: { effort: 'low', format: { type: 'json_schema', schema: {} } },
      stopSequences: ['END'],
      temperature: 0.2,
      thinking: { type: 'enabled', budget_tokens: 1024 },
      topK: 40,
      topP: 0.9,
    });
    expect(modelConstructorParameters({ effort: 'low', output_config: { effort: 'high' } }, 'anthropic')).toEqual({
      outputConfig: { effort: 'high' },
    });
  });

  it('maps ChatAnthropic max_tokens_to_sample to maxTokens and stop to stopSequences; the primary names win', () => {
    expect(modelConstructorParameters({ max_tokens_to_sample: 50, stop: ['A'] }, 'anthropic')).toEqual({
      maxTokens: 50,
      stopSequences: ['A'],
    });
    expect(
      modelConstructorParameters(
        { max_tokens_to_sample: 50, max_tokens: 60, stop: ['A'], stop_sequences: ['B'] },
        'anthropic',
      ),
    ).toEqual({ maxTokens: 60, stopSequences: ['B'] });
  });

  it('forwards exactly the canonical ChatBedrockConverse keys, under their constructor names', () => {
    expect(
      modelConstructorParameters(
        {
          ...NEVER_FORWARDED_PARAMETERS,
          max_tokens: 100,
          performance_config: { latency: 'optimized' },
          service_tier: 'priority',
          temperature: 0.2,
          top_p: 0.9,
          application_inference_profile: 'arn:smuggled',
        },
        'bedrock',
      ),
    ).toEqual({
      maxTokens: 100,
      performanceConfig: { latency: 'optimized' },
      serviceTier: 'priority',
      temperature: 0.2,
      topP: 0.9,
    });
  });

  it.each([
    ['anthropic', 'thinking', 'enabled'],
    ['anthropic', 'thinking', { budget_tokens: 1024 }],
    ['anthropic', 'output_config', 'high'],
    ['openai', 'logit_bias', [1, 2]],
    ['bedrock', 'performance_config', 'optimized'],
  ] as const)('drops a malformed nested value for %s: %s = %j', (modelClass, key, value) => {
    expect(modelConstructorParameters({ [key]: value, temperature: 0.1 }, modelClass)).toEqual({ temperature: 0.1 });
  });
});
