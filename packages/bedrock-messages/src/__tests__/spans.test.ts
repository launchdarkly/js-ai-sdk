import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unlike `handler.test.ts`, this file does not mock `@opentelemetry/api`.
 *
 * Streaming already ends `openModelSpan` as abandoned in `finally`. This asserts that early
 * return from the consumer closes the in-flight chat span without marking it ERROR.
 */

const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));

vi.mock('@aws-sdk/client-bedrock-runtime', () => {
  class BedrockRuntimeClient {
    send = mockSend;
  }
  class ConverseCommand {
    constructor(readonly input: unknown) {}
  }
  class ConverseStreamCommand {
    constructor(readonly input: unknown) {}
  }
  return { BedrockRuntimeClient, ConverseCommand, ConverseStreamCommand };
});

import { createBedrockMessagesHandler } from '../handler.js';

const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
const contextManager = new AsyncLocalStorageContextManager();

const baseConfig = {
  model: { name: 'anthropic.claude-sonnet-4-5', region: 'us' },
  provider: { name: 'Bedrock' },
  instructions: 'Be concise.',
};

const spans = () => exporter.getFinishedSpans();
const named = (prefix: string) => spans().filter((s) => s.name.startsWith(prefix));
const root = () => spans().find((s) => s.name === 'invoke_agent');

describe('bedrock-messages span tree against a real tracer', () => {
  beforeAll(() => {
    contextManager.enable();
    context.setGlobalContextManager(contextManager);
    trace.setGlobalTracerProvider(provider);
  });

  afterAll(async () => {
    context.disable();
    await provider.shutdown();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    exporter.reset();
  });

  it('ends every span when the consumer abandons the stream mid-flight', async () => {
    mockSend.mockResolvedValue({
      stream: (async function* () {
        yield { contentBlockDelta: { delta: { text: 'one' } } };
        yield { contentBlockDelta: { delta: { text: 'two' } } };
      })(),
    });

    const gen = createBedrockMessagesHandler().stream?.(baseConfig as never, 'q', {}, {}) as AsyncGenerator<unknown>;
    for await (const _chunk of gen) break;

    const rootSpan = root();
    expect(rootSpan).toBeDefined();
    expect(rootSpan?.attributes['launchdarkly.stream.abandoned']).toBe(true);
    expect(rootSpan?.status.code).toBe(0); // UNSET

    const [chat] = named('chat');
    expect(chat).toBeDefined();
    expect(chat.attributes['launchdarkly.stream.abandoned']).toBe(true);
    expect(chat.status.code).toBe(0);
  });
});
