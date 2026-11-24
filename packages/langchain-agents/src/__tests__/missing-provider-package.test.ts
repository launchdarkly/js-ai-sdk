import { SpanStatusCode, trace } from '@opentelemetry/api';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The provider packages are optional peers, so a config for a provider whose package is not
// installed must fail with an error that names the package to install.

vi.mock('@langchain/google-genai', () => {
  throw new Error("Cannot find package '@langchain/google-genai'");
});

vi.mock('@langchain/aws', () => {
  throw new Error("Cannot find package '@langchain/aws'");
});

import { createLangChainAgentsHandler } from '../handler.js';

const configFor = (provider: string, name: string) => ({
  model: { name },
  provider: { name: provider },
  instructions: 'You are helpful.',
});

const exporter = new InMemorySpanExporter();
const tracerProvider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });

const expectFailedRootSpan = (install: string) => {
  const roots = exporter.getFinishedSpans().filter((span) => span.name === 'invoke_agent');
  expect(roots).toHaveLength(1);
  expect(roots[0].status.code).toBe(SpanStatusCode.ERROR);
  expect(roots[0].status.message).toContain(install);
  exporter.reset();
};

describe('createLangChainAgentsHandler: missing provider package', () => {
  beforeAll(() => {
    trace.setGlobalTracerProvider(tracerProvider);
  });

  afterAll(async () => {
    await tracerProvider.shutdown();
  });

  beforeEach(() => {
    exporter.reset();
  });

  it.each([
    ['Gemini', 'gemini-3.1-pro-preview', 'npm install @langchain/google-genai'],
    ['Bedrock', 'anthropic.claude-sonnet-4-5', 'npm install @langchain/aws'],
  ])('names the package to install for a %s config and fails the root span, on invoke and stream', async (provider, name, install) => {
    const handler = createLangChainAgentsHandler();
    await expect(handler(configFor(provider, name) as never, 'q', {}, {})).rejects.toThrow(install);
    expectFailedRootSpan(install);
    await expect(async () => {
      for await (const _event of handler.stream?.(configFor(provider, name) as never, 'q', {}, {}) ?? []) {
        // drain
      }
    }).rejects.toThrow(install);
    expectFailedRootSpan(install);
  });
});
