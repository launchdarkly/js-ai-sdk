import { describe, expect, it } from 'vitest';
import { createLangChainHandler } from '../handler.js';

// This file deliberately does NOT mock @langchain/openai. Every other test in this package mocks
// it out, so a handler-internal bug that maps a config key to the wrong ChatOpenAI constructor
// field would never reach a real request body — which is exactly how the snake_case bug this
// package's casing fix addresses went unnoticed. Constructing a real ChatOpenAI and intercepting
// its outgoing fetch call is the only check that would have caught it.

const baseConfig = {
  model: {
    name: 'gpt-4o',
    parameters: {
      top_p: 0.42,
      max_tokens: 321,
    },
  },
  provider: { name: 'LangChain' },
  instructions: 'You are helpful.',
};

describe('createLangChainHandler — wire request (real ChatOpenAI, unmocked)', () => {
  it('sends snake_case model.parameters onto the wire as top_p / max_tokens', async () => {
    let capturedBody: Record<string, unknown> | undefined;

    const fetchFn = async (_url: unknown, init?: { body?: unknown }) => {
      capturedBody = JSON.parse(String(init?.body));
      // Abort before any real network call is attempted.
      throw new Error('aborted: request captured');
    };

    const config = {
      ...baseConfig,
      model: {
        ...baseConfig.model,
        parameters: {
          ...baseConfig.model.parameters,
          // `maxRetries: 0` is LangChain's own AsyncCaller retry count (defaults to 6, with
          // backoff), separate from the openai client's own maxRetries inside `configuration`.
          // Without it a thrown fetch is retried repeatedly and the test times out.
          maxRetries: 0,
          configuration: { apiKey: 'test-key', fetch: fetchFn },
        },
      },
    };

    await expect(createLangChainHandler()(config as any, 'hi')).rejects.toThrow();

    expect(capturedBody).toBeDefined();
    expect(capturedBody!.top_p).toBe(0.42);
    expect(capturedBody!.max_tokens).toBe(321);
  });
});
