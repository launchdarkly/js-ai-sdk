import { describe, expect, it } from 'vitest';
import { createLangChainAgentsHandler } from '../handler.js';

// This file deliberately does NOT mock @langchain/openai or the real `langchain` createAgent.
// Every other test in this package mocks both out, so a handler-internal bug that maps a config
// key to the wrong ChatOpenAI constructor field would never reach a real request body — which is
// exactly how the snake_case bug this package's casing fix addresses went unnoticed. Constructing
// a real ChatOpenAI (via the real agent executor) and intercepting its outgoing fetch call is the
// only check that would have caught it.

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

describe('createLangChainAgentsHandler — wire request (real ChatOpenAI + createAgent, unmocked)', () => {
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
          // LangChain's own AsyncCaller retries a thrown call up to 6 times by default; without
          // this the thrown fetch above is retried repeatedly and the test times out.
          maxRetries: 0,
          configuration: { apiKey: 'test-key', fetch: fetchFn },
        },
      },
    };

    await expect(createLangChainAgentsHandler()(config as any, 'hi')).rejects.toThrow();

    expect(capturedBody).toBeDefined();
    expect(capturedBody!.top_p).toBe(0.42);
    expect(capturedBody!.max_tokens).toBe(321);
  }, 10000);
});
