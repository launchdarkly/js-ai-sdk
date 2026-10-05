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

  it('forwards ChatOpenAI fields under their constructor names', () => {
    expect(
      modelConstructorParameters(
        {
          temperature: 0.2,
          max_tokens: 100,
          max_completion_tokens: 200,
          top_p: 0.9,
          frequency_penalty: 0.1,
          presence_penalty: 0.2,
          n: 2,
          logit_bias: { '50256': -100 },
          logprobs: true,
          top_logprobs: 3,
          stop: ['END'],
          stream_usage: true,
          reasoning: { effort: 'low' },
          verbosity: 'low',
          service_tier: 'flex',
          prompt_cache_key: 'k',
          use_responses_api: true,
          user: 'u-1',
          tags: ['t'],
          metadata: { a: 1 },
        },
        'openai',
      ),
    ).toEqual({
      temperature: 0.2,
      maxTokens: 100,
      maxCompletionTokens: 200,
      topP: 0.9,
      frequencyPenalty: 0.1,
      presencePenalty: 0.2,
      n: 2,
      logitBias: { '50256': -100 },
      logprobs: true,
      topLogprobs: 3,
      stop: ['END'],
      streamUsage: true,
      reasoning: { effort: 'low' },
      verbosity: 'low',
      // ChatOpenAI reads this one field in snake_case.
      service_tier: 'flex',
      promptCacheKey: 'k',
      useResponsesApi: true,
      user: 'u-1',
      tags: ['t'],
      metadata: { a: 1 },
    });
  });

  it('forwards ChatAnthropic fields, keeps nested Messages API shapes, and folds effort into outputConfig', () => {
    expect(
      modelConstructorParameters(
        {
          temperature: 0.2,
          max_tokens: 100,
          top_k: 40,
          top_p: 0.9,
          stop_sequences: ['END'],
          thinking: { type: 'enabled', budget_tokens: 1024 },
          context_management: { edits: [{ type: 'clear_tool_uses_20250919' }] },
          inference_geo: 'us',
          betas: ['context-1m-2025-08-07'],
          effort: 'low',
        },
        'anthropic',
      ),
    ).toEqual({
      temperature: 0.2,
      maxTokens: 100,
      topK: 40,
      topP: 0.9,
      stopSequences: ['END'],
      // ChatAnthropic sends these to the Messages API as written, so they stay snake_case.
      thinking: { type: 'enabled', budget_tokens: 1024 },
      contextManagement: { edits: [{ type: 'clear_tool_uses_20250919' }] },
      inferenceGeo: 'us',
      betas: ['context-1m-2025-08-07'],
      outputConfig: { effort: 'low' },
    });
    expect(modelConstructorParameters({ effort: 'low', output_config: { effort: 'high' } }, 'anthropic')).toEqual({
      outputConfig: { effort: 'high' },
    });
  });

  it('forwards ChatBedrockConverse fields under their constructor names', () => {
    expect(
      modelConstructorParameters(
        {
          temperature: 0.2,
          max_tokens: 100,
          top_p: 0.9,
          guardrail_config: { guardrailIdentifier: 'g', guardrailVersion: '1' },
          performance_config: { latency: 'optimized' },
          service_tier: 'priority',
          supports_tool_choice_values: ['auto'],
          application_inference_profile: 'arn:smuggled',
        },
        'bedrock',
      ),
    ).toEqual({
      temperature: 0.2,
      maxTokens: 100,
      topP: 0.9,
      guardrailConfig: { guardrailIdentifier: 'g', guardrailVersion: '1' },
      performanceConfig: { latency: 'optimized' },
      serviceTier: 'priority',
      supportsToolChoiceValues: ['auto'],
    });
  });
});
