import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConversationIdSpanProcessor } from '../conversation.js';
import { runJudges } from '../judges.js';
import { configure, resetSdkOptions, resolveCaptureContent } from '../sdk-options.js';
import type { ProviderHandler } from '../types.js';
import { createHandler } from '../utils.js';

const SINGLETON_KEY = Symbol.for('@launchdarkly/ai-server:singleton');
const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({
  spanProcessors: [new ConversationIdSpanProcessor(), new SimpleSpanProcessor(exporter)],
});
const contextManager = new AsyncLocalStorageContextManager();

const judgeVariation = {
  _ldMeta: { enabled: true, variationKey: 'v1', version: 1, mode: 'messages' },
  model: { name: 'gpt-4o' },
  provider: { name: 'OpenAI' },
  instructions: 'You are a judge.',
};

function clearSingleton() {
  delete (globalThis as any)[SINGLETON_KEY];
}

function plantClient() {
  const client = {
    variation: vi.fn().mockResolvedValue(judgeVariation),
    track: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
  (globalThis as any)[SINGLETON_KEY] = { client, initPromise: Promise.resolve(client) };
  return client;
}

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
  clearSingleton();
  exporter.reset();
});

afterEach(() => {
  resetSdkOptions();
  clearSingleton();
  vi.restoreAllMocks();
});

describe('configure', () => {
  it('defaults capture to false until startup configures it', () => {
    expect(resolveCaptureContent(undefined)).toBe(false);
    clearSingleton();
    configure({ captureContent: true });
    expect(resolveCaptureContent(undefined)).toBe(true);
  });

  it('lets an explicit false override a configured true', () => {
    configure({ captureContent: true });
    expect(resolveCaptureContent(false)).toBe(false);
    expect(resolveCaptureContent(true)).toBe(true);
    expect(resolveCaptureContent(undefined)).toBe(true);
  });

  it('reads the default at invocation, including after the handler was built', () => {
    const handler = createHandler(['OpenAI', 'messages'], async () => ({ output: 'ok' }));
    expect(handler.captureContent).toBeUndefined();
    configure({ captureContent: true });
    expect(resolveCaptureContent(handler.captureContent)).toBe(true);
  });

  it('replaces the default before the first AI invocation and accepts an identical repeat after', () => {
    configure({ captureContent: false });
    configure({ captureContent: true });
    expect(resolveCaptureContent(undefined)).toBe(true);
    expect(() => configure({ captureContent: true })).not.toThrow();
    expect(() => configure({})).toThrow(/first AI invocation/);
    expect(() => configure({ captureContent: false })).toThrow(/request data/);
  });

  it('shutdown restores the built-in default so a later invocation does not keep the old one', async () => {
    configure({ captureContent: true });
    resolveCaptureContent(undefined);
    const { shutdown } = await import('../lifecycle.js');
    await shutdown();
    configure({ captureContent: true });
    expect(resolveCaptureContent(undefined)).toBe(true);
    await shutdown();
    expect(resolveCaptureContent(undefined)).toBe(false);
  });

  it('rejects a non-boolean and warns on an unknown field without storing it', () => {
    expect(() => configure({ captureContent: 'yes' as unknown as boolean })).toThrow(/boolean/);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    configure({ captureContent: true, streamProtocol: 'ag-ui' } as never);
    expect(warn.mock.calls).toEqual([['[LaunchDarkly] Ignoring unrecognized configure option(s): streamProtocol']]);
    expect(resolveCaptureContent(undefined)).toBe(true);
  });

  it('passes the configured default through the judge explanation gate', async () => {
    plantClient();
    configure({ captureContent: true });
    const handler: ProviderHandler = async () => {
      const span = trace.getTracer('@launchdarkly/ai-server').startSpan('invoke_agent');
      span.end();
      return { output: '{"score":0.9,"reasoning":"on topic"}', usage: { input_tokens: 1, output_tokens: 1 } };
    };
    handler.providesFor = ['OpenAI', 'messages'];

    await runJudges({
      config: {
        model: { name: 'gpt-4o' },
        provider: { name: 'OpenAI' },
        instructions: 'Be helpful.',
        judgeConfiguration: { judges: [{ key: 'relevance', samplingRate: 1 }] },
      },
      userContext: { kind: 'user', key: 'user-1' },
      handler,
      userInput: 'hello',
      llmResponse: 'world',
      baseTrackData: {
        variationKey: 'v1',
        configKey: 'main',
        version: 1,
        runId: 'run-1',
        modelName: 'gpt-4o',
        providerName: 'OpenAI',
      },
    });

    const span = exporter.getFinishedSpans().find((item) => item.name === 'invoke_agent');
    expect(span?.attributes['gen_ai.evaluation.explanation']).toBe('on topic');
  });

  it('omits judge reasoning when the handler explicitly disables capture', async () => {
    plantClient();
    configure({ captureContent: true });
    const handler: ProviderHandler = async () => {
      const span = trace.getTracer('@launchdarkly/ai-server').startSpan('invoke_agent');
      span.end();
      return { output: '{"score":0.9,"reasoning":"on topic"}', usage: { input_tokens: 1, output_tokens: 1 } };
    };
    handler.providesFor = ['OpenAI', 'messages'];
    handler.captureContent = false;

    await runJudges({
      config: {
        model: { name: 'gpt-4o' },
        provider: { name: 'OpenAI' },
        instructions: 'Be helpful.',
        judgeConfiguration: { judges: [{ key: 'relevance', samplingRate: 1 }] },
      },
      userContext: { kind: 'user', key: 'user-1' },
      handler,
      userInput: 'hello',
      llmResponse: 'world',
      baseTrackData: {
        variationKey: 'v1',
        configKey: 'main',
        version: 1,
        runId: 'run-1',
        modelName: 'gpt-4o',
        providerName: 'OpenAI',
      },
    });

    const span = exporter.getFinishedSpans().find((item) => item.name === 'invoke_agent');
    expect(span?.attributes['gen_ai.evaluation.explanation']).toBeUndefined();
  });
});
