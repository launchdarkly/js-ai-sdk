/**
 * Process-wide `configure` defaults (TESTING.md §3.9a, §3.14).
 *
 * `SDKOptions.captureContent` is a default, not a ceiling: an explicit handler override wins,
 * including an explicit `false` over a configured `true`. Handlers read it when they run.
 */

import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const lifecycle = vi.hoisted(() => ({
  track: vi.fn(),
  resolve: vi.fn(),
}));

vi.mock('../lifecycle.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lifecycle.js')>()),
  getClient: () => ({ track: lifecycle.track }),
  extractVariation: (...args: unknown[]) => lifecycle.resolve(...args),
}));

import { ConversationIdSpanProcessor } from '../conversation.js';
import { configure, createHandler, type SDKOptions, shutdown } from '../index.js';
import { runJudge, runJudges } from '../judges.js';
import { effectiveCaptureContent } from '../sdk-options.js';
import { executeAndStream, executeAndTrack } from '../tracking.js';
import type { AiConfigRep, HandlerStreamEvent, JudgeTask, ProviderHandler } from '../types.js';

const fn = async () => ({ output: 'ok', usage: {} });
const handler = (captureContent?: boolean): ProviderHandler =>
  createHandler(['TestProvider', 'messages'], fn, { captureContent });

const CONFIG: AiConfigRep = {
  model: { name: 'gpt-4' },
  provider: { name: 'TestProvider' },
  instructions: 'hi',
} as AiConfigRep;
const META = { enabled: true, variationKey: 'v1', version: 1, mode: 'messages' as const };
const USER = { kind: 'user' as const, key: 'u1' };

const invoke = (h: ProviderHandler) =>
  executeAndTrack({ configKey: 'k', config: CONFIG, meta: META, userContext: USER, handler: h });

beforeEach(async () => {
  vi.clearAllMocks();
  await shutdown();
});

afterEach(async () => {
  await shutdown();
});

describe('configure', () => {
  it('defaults to capturing content when never called', () => {
    expect(effectiveCaptureContent(undefined)).toBe(true);
    expect(handler().captureContent).toBe(true);
  });

  it('is read when the handler is used, not when it is built', () => {
    const h = handler();
    configure({ options: { captureContent: false } });
    expect(h.captureContent).toBe(false);
  });

  it('can be replaced before the first invocation', () => {
    configure({ options: { captureContent: true } });
    configure({ options: { captureContent: false } });
    expect(handler().captureContent).toBe(false);
  });

  it('treats an omitted captureContent as the built-in true', () => {
    configure({ options: { captureContent: false } });
    configure({ options: {} });
    expect(handler().captureContent).toBe(true);
  });

  it('lets an explicit factory value override the configured default either way', () => {
    configure({ options: { captureContent: true } });
    expect(handler(false).captureContent).toBe(false);
    expect(handler(true).captureContent).toBe(true);
    expect(handler(undefined).captureContent).toBe(true);

    configure({ options: { captureContent: false } });
    expect(handler(true).captureContent).toBe(true);
    expect(handler(false).captureContent).toBe(false);
    expect(handler(undefined).captureContent).toBe(false);
  });

  it('treats assigning captureContent as the handler override, leaving the process default alone', () => {
    configure({ options: { captureContent: true } });
    const h = handler();
    h.captureContent = false;
    expect(h.captureContent).toBe(false);
    expect(handler().captureContent).toBe(true);
    h.captureContent = true;
    configure({ options: { captureContent: false } });
    expect(h.captureContent).toBe(true);
  });

  it('keeps an explicit override when a handler is wrapped again without one', () => {
    configure({ options: { captureContent: true } });
    const rewrapped = createHandler(['Other', 'messages'], handler(false));
    expect(rewrapped.captureContent).toBe(false);
    expect(createHandler(['Other', 'messages'], handler(true)).captureContent).toBe(true);
    expect(createHandler(['Other', 'messages'], handler(false), { captureContent: true }).captureContent).toBe(true);
  });

  it('leaves a re-wrapped unset handler unset, so a later configure still applies', () => {
    const rewrapped = createHandler(['Other', 'messages'], handler());
    expect(rewrapped.captureContent).toBe(true);
    configure({ options: { captureContent: false } });
    expect(rewrapped.captureContent).toBe(false);
  });

  it('rejects a value that is not an SDKOptions object', () => {
    expect(() => configure({ options: null as unknown as SDKOptions })).toThrow(TypeError);
    expect(() => configure({ options: { captureContent: 1 } as unknown as SDKOptions })).toThrow(/boolean/);
  });

  it('rejects different options after an invocation and accepts identical ones', async () => {
    configure({ options: { captureContent: true } });
    await invoke(handler());
    expect(() => configure({ options: { captureContent: false } })).toThrow(/cannot change/);
    configure({ options: { captureContent: true } });
    configure({ options: {} });
    expect(handler().captureContent).toBe(true);
  });

  it('latches on a plain function the SDK invokes, not only on createHandler output', async () => {
    const plain = vi.fn(fn) as unknown as ProviderHandler;
    await invoke(plain);
    expect(() => configure({ options: { captureContent: false } })).toThrow(/cannot change/);
  });

  it('latches on a direct handler call, outside the SDK, and still accepts identical options', async () => {
    configure({ options: { captureContent: true } });
    await handler()(CONFIG, 'hi');
    expect(() => configure({ options: { captureContent: false } })).toThrow(/cannot change/);
    configure({ options: { captureContent: true } });
  });

  it('latches when a direct call starts, before its promise settles', () => {
    let finish: (value: { output: string; usage: Record<string, unknown> }) => void = () => {};
    const h = createHandler(
      ['TestProvider', 'messages'],
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = h(CONFIG);
    expect(() => configure({ options: { captureContent: false } })).toThrow(/cannot change/);
    finish({ output: 'ok', usage: {} });
    return pending;
  });

  it('latches on a direct call to a handler wrapped twice', async () => {
    const twice = createHandler(['TestProvider', 'messages'], handler());
    await twice(CONFIG);
    expect(() => configure({ options: { captureContent: false } })).toThrow(/cannot change/);
  });

  it('latches when a handler stream starts, even if it is never iterated', () => {
    const body = vi.fn();
    const h = createHandler(['TestProvider', 'messages'], fn, {
      stream: async function* () {
        body();
        yield { type: 'done', output: '', usage: {} } as HandlerStreamEvent;
      },
    });
    const gen = h.stream?.(CONFIG);
    expect(gen).toBeDefined();
    expect(body).not.toHaveBeenCalled();
    expect(() => configure({ options: { captureContent: false } })).toThrow(/cannot change/);
  });

  it('latches on a streamed invocation through the SDK', async () => {
    for await (const _ of executeAndStream({
      configKey: 'k',
      config: CONFIG,
      meta: META,
      userContext: USER,
      handler: handler(),
    })) {
      // drain
    }
    expect(() => configure({ options: { captureContent: false } })).toThrow(/cannot change/);
  });

  it('does not latch on reading the property', () => {
    expect(handler().captureContent).toBe(true);
    configure({ options: { captureContent: false } });
    expect(handler().captureContent).toBe(false);
  });

  it('is restored to the built-in default by shutdown, which also allows configure again', async () => {
    configure({ options: { captureContent: false } });
    await invoke(handler());
    await shutdown();
    expect(handler().captureContent).toBe(true);
    configure({ options: { captureContent: false } });
    expect(handler().captureContent).toBe(false);
  });
});

describe('runJudges explanation follows the judge handler’s effective capture flag', () => {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new ConversationIdSpanProcessor(), new SimpleSpanProcessor(exporter)],
  });
  const tracer = provider.getTracer('@launchdarkly/ai-server');
  const contextManager = new AsyncLocalStorageContextManager();

  beforeAll(() => {
    contextManager.enable();
    context.setGlobalContextManager(contextManager);
    trace.setGlobalTracerProvider(provider);
  });

  afterAll(async () => {
    context.disable();
    trace.disable();
    await provider.shutdown();
  });

  beforeEach(() => {
    exporter.reset();
    lifecycle.resolve.mockResolvedValue({
      config: { model: { name: 'gpt-4' }, provider: { name: 'TestProvider' }, instructions: 'judge' },
      meta: { enabled: true, variationKey: 'j1', version: 1, mode: 'messages' },
    });
    vi.spyOn(Math, 'random').mockReturnValue(0);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const judgeFn = async () => {
    tracer.startActiveSpan('invoke_agent', (span) => span.end());
    return { output: '{"score": 0.9, "reasoning": "good"}', usage: { input_tokens: 1, output_tokens: 1 } };
  };

  const explanation = async (judge: ProviderHandler): Promise<unknown> => {
    exporter.reset();
    await runJudges({
      config: {
        ...CONFIG,
        judgeConfiguration: { judges: [{ key: 'judge-1', samplingRate: 1 }] },
      } as AiConfigRep,
      userContext: USER,
      handler: judge,
      userInput: 'q',
      llmResponse: 'r',
      baseTrackData: { runId: 'x' } as never,
    });
    const spans = exporter.getFinishedSpans().filter((s) => s.name === 'invoke_agent');
    expect(spans.length).toBeGreaterThan(0);
    return spans[spans.length - 1].attributes['gen_ai.evaluation.explanation'];
  };

  it('writes it under the built-in default', async () => {
    expect(await explanation(createHandler(['TestProvider', 'messages'], judgeFn))).toBe('good');
  });

  it('writes it for a plain function judge under the built-in default', async () => {
    const plain = judgeFn as unknown as ProviderHandler;
    plain.providesFor = ['TestProvider', 'messages'];
    expect(await explanation(plain)).toBe('good');
  });

  it('omits it for an explicit false', async () => {
    expect(
      await explanation(createHandler(['TestProvider', 'messages'], judgeFn, { captureContent: false })),
    ).toBeUndefined();
  });

  it('omits it when configure turns the default off', async () => {
    const judge = createHandler(['TestProvider', 'messages'], judgeFn);
    configure({ options: { captureContent: false } });
    expect(await explanation(judge)).toBeUndefined();
  });

  it('writes it for an explicit true when the configured default is false', async () => {
    configure({ options: { captureContent: false } });
    expect(await explanation(createHandler(['TestProvider', 'messages'], judgeFn, { captureContent: true }))).toBe(
      'good',
    );
  });

  it('omits it for a re-wrapped judge that kept an explicit false', async () => {
    const inner = createHandler(['TestProvider', 'messages'], judgeFn, { captureContent: false });
    expect(await explanation(createHandler(['TestProvider', 'messages'], inner))).toBeUndefined();
  });
});

describe('deferred runJudge explanation follows the judge handler’s effective capture flag', () => {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new ConversationIdSpanProcessor(), new SimpleSpanProcessor(exporter)],
  });
  const tracer = provider.getTracer('@launchdarkly/ai-server');
  const contextManager = new AsyncLocalStorageContextManager();

  beforeAll(() => {
    contextManager.enable();
    context.setGlobalContextManager(contextManager);
    trace.setGlobalTracerProvider(provider);
  });

  afterAll(async () => {
    context.disable();
    trace.disable();
    await provider.shutdown();
  });

  const judgeFn = async () => {
    tracer.startActiveSpan('invoke_agent', (span) => span.end());
    return { output: '{"score": 0.9, "reasoning": "good"}', usage: { input_tokens: 1, output_tokens: 1 } };
  };

  const task: JudgeTask = {
    configKey: 'judge-1',
    judgeConfig: { model: { name: 'gpt-4' }, provider: { name: 'TestProvider' }, instructions: 'judge' } as AiConfigRep,
    judgeMeta: { enabled: true, variationKey: 'j1', version: 1, mode: 'messages' },
    actualOutput: 'r',
    userInput: 'q',
    userContext: USER,
    judgeProvider: 'TestProvider',
    judgeMode: 'messages',
    collapseMessages: false,
    parentTrackData: { runId: 'x' } as never,
  };

  const explanation = async (judge: ProviderHandler): Promise<unknown> => {
    exporter.reset();
    const result = await runJudge(task, [judge]);
    expect(result?.score).toBe(0.9);
    const spans = exporter.getFinishedSpans().filter((s) => s.name === 'invoke_agent');
    expect(spans.length).toBeGreaterThan(0);
    return spans[spans.length - 1].attributes['gen_ai.evaluation.explanation'];
  };

  it('writes it under the built-in default', async () => {
    expect(await explanation(createHandler(['TestProvider', 'messages'], judgeFn))).toBe('good');
  });

  it('omits it for an explicit false', async () => {
    expect(
      await explanation(createHandler(['TestProvider', 'messages'], judgeFn, { captureContent: false })),
    ).toBeUndefined();
  });

  it('omits it when configure turns the default off', async () => {
    const judge = createHandler(['TestProvider', 'messages'], judgeFn);
    configure({ options: { captureContent: false } });
    expect(await explanation(judge)).toBeUndefined();
  });

  it('writes it for an explicit true when the configured default is false', async () => {
    configure({ options: { captureContent: false } });
    expect(await explanation(createHandler(['TestProvider', 'messages'], judgeFn, { captureContent: true }))).toBe(
      'good',
    );
  });
});
