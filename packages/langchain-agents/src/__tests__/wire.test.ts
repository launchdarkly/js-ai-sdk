import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLangChainAgentsHandler } from '../handler.js';
import { NEVER_FORWARDED_PARAMETERS } from './never-forwarded.js';

// This file deliberately does NOT mock @langchain/openai. Every other test in this package mocks
// it out, so a handler-internal bug that maps a config key to the wrong ChatOpenAI constructor
// field would never reach a real request body. Constructing a real ChatOpenAI and intercepting
// its outgoing fetch call checks what actually goes on the wire.

type Captured = { url: string; headers: Record<string, string>; body: Record<string, unknown> };

const captured: Captured[] = [];

beforeEach(() => {
  captured.length = 0;
  // The customer's own credentials, from the environment, as an application would set them.
  vi.stubEnv('OPENAI_API_KEY', 'CUSTOMER');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown, init?: RequestInit) => {
      captured.push({
        url: String(url instanceof Request ? url.url : url),
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        body: JSON.parse(String(init?.body)),
      });
      // A 401 is not retried by either the openai client or LangChain's AsyncCaller.
      return new Response(JSON.stringify({ error: { message: 'captured' } }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const baseConfig = {
  model: { name: 'gpt-4o', parameters: { top_p: 0.42, max_tokens: 321 } },
  provider: { name: 'LangChain' },
  instructions: 'You are helpful.',
};

describe('createLangChainAgentsHandler wire request (real ChatOpenAI, unmocked)', () => {
  it('sends snake_case model.parameters onto the wire as top_p / max_tokens', async () => {
    await expect(createLangChainAgentsHandler()(baseConfig as any, 'hi')).rejects.toThrow();
    expect(captured.length).toBeGreaterThan(0);
    expect(captured[0].body.top_p).toBe(0.42);
    expect(captured[0].body.max_tokens).toBe(321);
  }, 10000);

  it('keeps the customer key, base URL and headers when a config sets credentials, endpoints and headers', async () => {
    const config = {
      ...baseConfig,
      model: {
        ...baseConfig.model,
        parameters: {
          ...baseConfig.model.parameters,
          ...NEVER_FORWARDED_PARAMETERS,
          api_key: 'ATTACKER',
          base_url: 'https://attacker.example/v1',
          configuration: {
            apiKey: 'ATTACKER',
            baseURL: 'https://attacker.example/v1',
            defaultHeaders: { Authorization: 'Bearer ATTACKER' },
          },
          model_kwargs: { injected: 'NEVER_FORWARDED' },
        },
      },
    };
    await expect(createLangChainAgentsHandler()(config as any, 'hi')).rejects.toThrow();
    expect(captured.length).toBeGreaterThan(0);
    for (const request of captured) {
      expect(request.url.startsWith('https://api.openai.com/')).toBe(true);
      expect(request.headers.authorization).toBe('Bearer CUSTOMER');
      expect(JSON.stringify(request)).not.toContain('NEVER_FORWARDED');
      expect(JSON.stringify(request)).not.toContain('ATTACKER');
    }
    expect(captured[0].body.top_p).toBe(0.42);
  }, 10000);
});
