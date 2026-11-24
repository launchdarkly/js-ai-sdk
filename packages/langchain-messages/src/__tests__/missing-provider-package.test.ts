import { describe, expect, it, vi } from 'vitest';

// The provider packages are optional peers, so a config for a provider whose package is not
// installed must fail with an error that names the package to install.

vi.mock('@langchain/google-genai', () => {
  throw new Error("Cannot find package '@langchain/google-genai'");
});

vi.mock('@langchain/aws', () => {
  throw new Error("Cannot find package '@langchain/aws'");
});

import { createLangChainMessagesHandler } from '../handler.js';

const configFor = (provider: string, name: string) => ({
  model: { name },
  provider: { name: provider },
  instructions: 'You are helpful.',
});

describe('createLangChainMessagesHandler: missing provider package', () => {
  it.each([
    ['Gemini', 'gemini-3.1-pro-preview', 'npm install @langchain/google-genai'],
    ['Bedrock', 'anthropic.claude-sonnet-4-5', 'npm install @langchain/aws'],
  ])('names the package to install for a %s config, on invoke and stream', async (provider, name, install) => {
    const handler = createLangChainMessagesHandler();
    await expect(handler(configFor(provider, name) as never, 'q', {}, {})).rejects.toThrow(install);
    await expect(async () => {
      for await (const _event of handler.stream?.(configFor(provider, name) as never, 'q', {}, {}) ?? []) {
        // drain
      }
    }).rejects.toThrow(install);
  });
});
