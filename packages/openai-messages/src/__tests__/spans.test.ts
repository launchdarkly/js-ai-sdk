import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unlike `handler.test.ts`, this file does not mock `@opentelemetry/api`.
 *
 * `handler.test.ts` stubs `startActiveSpan` as `(_name, fn) => fn(mockSpan)` and stubs `startSpan`
 * so that it ignores its `parentContext` argument entirely. Parentage is therefore unobservable
 * there: deleting every `parentContext` argument from the handler would not fail one assertion.
 *
 * Here a real `BasicTracerProvider` exports real spans, so the assertions are about the shape of
 * the emitted tree — which is what LaunchDarkly's AI Config Monitoring reads.
 *
 * The `AsyncLocalStorageContextManager` below is not incidental. The non-streaming path derives its
 * parent from `context.active()` inside `startActiveSpan`, which only carries the root span while a
 * context manager is registered — `client/src/lifecycle.ts` registers exactly this one, so this
 * setup mirrors production. Without it the tree silently flattens into unrelated root spans. The
 * streaming path builds its parent with an explicit `trace.setSpan` and is unaffected either way.
 */

const { mockResponsesCreate, mockResponsesStream } = vi.hoisted(() => ({
  mockResponsesCreate: vi.fn(),
  mockResponsesStream: vi.fn(),
}));

vi.mock('openai', () => ({
  default: class {
    responses = { create: mockResponsesCreate, stream: mockResponsesStream };
  },
}));

import { createOpenAIHandler } from '../handler.js';

const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
const contextManager = new AsyncLocalStorageContextManager();

const baseConfig = {
  model: { name: 'gpt-4o' },
  provider: { name: 'OpenAI' },
  instructions: 'You are helpful.',
};

const toolConfig = {
  ...baseConfig,
  tools: { myTool: { name: 'myTool', type: 'function' as const, parameters: {} } },
};

const finalResponse = (text = 'Hello!') => ({
  id: 'resp_final',
  model: 'gpt-4o',
  output: [],
  output_text: text,
  usage: { input_tokens: 10, output_tokens: 5 },
});

const toolCallResponse = () => ({
  id: 'resp_tool',
  model: 'gpt-4o',
  output: [{ type: 'function_call', name: 'myTool', call_id: 'call_1', arguments: '{"q":"test"}' }],
  output_text: '',
  usage: { input_tokens: 5, output_tokens: 2 },
});

const makeStreamMock = (events: unknown[], finalResp: unknown) => ({
  [Symbol.asyncIterator]: async function* () {
    for (const e of events) yield e;
  },
  finalResponse: vi.fn().mockResolvedValue(finalResp),
});

const collectStream = async (gen: AsyncGenerator<unknown>) => {
  const out: unknown[] = [];
  for await (const e of gen) out.push(e);
  return out;
};

const spans = () => exporter.getFinishedSpans();
const named = (prefix: string) => spans().filter((s) => s.name.startsWith(prefix));
const root = () => spans().find((s) => s.name === 'invoke_agent');

describe('openai-messages span tree against a real tracer', () => {
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

  it('nests the chat span under the invoke_agent root', async () => {
    mockResponsesCreate.mockResolvedValue(finalResponse());

    await createOpenAIHandler()(baseConfig as never, 'q');

    const [chat] = named('chat');
    expect(chat).toBeDefined();
    expect(chat.parentSpanContext?.spanId).toBe(root()?.spanContext().spanId);
  });

  it('keeps every chat span of a multi-turn tool loop a direct child of the root', async () => {
    mockResponsesCreate.mockResolvedValueOnce(toolCallResponse()).mockResolvedValueOnce(finalResponse('Final'));

    await createOpenAIHandler()(toolConfig as never, 'q', { myTool: vi.fn().mockReturnValue('r') });

    const chats = named('chat');
    const rootId = root()?.spanContext().spanId;
    expect(chats).toHaveLength(2);
    // Siblings, not a chain: a chat span nested under the previous chat span would misreport
    // per-turn latency as cumulative.
    expect(chats.map((s) => s.parentSpanContext?.spanId)).toEqual([rootId, rootId]);
  });

  it('nests the execute_tool span under the root and keeps one trace id across the tree', async () => {
    mockResponsesCreate.mockResolvedValueOnce(toolCallResponse()).mockResolvedValueOnce(finalResponse('Final'));

    await createOpenAIHandler()(toolConfig as never, 'q', { myTool: vi.fn().mockReturnValue('r') });

    const [tool] = named('execute_tool ');
    expect(tool).toBeDefined();
    expect(tool.parentSpanContext?.spanId).toBe(root()?.spanContext().spanId);

    const traceIds = new Set(spans().map((s) => s.spanContext().traceId));
    expect(traceIds.size).toBe(1);
  });

  it('nests the chat span under the root in the streaming path', async () => {
    mockResponsesStream.mockReturnValue(
      makeStreamMock([{ type: 'response.output_text.delta', delta: 'Hi' }], finalResponse('Hi')),
    );

    await collectStream(createOpenAIHandler().stream?.(baseConfig as never, 'q', {}, {}) as never);

    const [chat] = named('chat');
    expect(chat).toBeDefined();
    expect(chat.parentSpanContext?.spanId).toBe(root()?.spanContext().spanId);
  });

  it('carries the run-level token totals on the invoke_agent root, not only on the children', async () => {
    mockResponsesCreate.mockResolvedValueOnce(toolCallResponse()).mockResolvedValueOnce(finalResponse('Final'));

    await createOpenAIHandler()(toolConfig as never, 'q', { myTool: vi.fn().mockReturnValue('r') });

    // The root is the only span carrying `launchdarkly.*` and the `feature_flag` event, so a
    // config-scoped query finds it and nothing else. Totals must be readable there.
    const attrs = root()?.attributes ?? {};
    expect(attrs['gen_ai.usage.input_tokens']).toBe(15); // 5 + 10
    expect(attrs['gen_ai.usage.output_tokens']).toBe(7); // 2 + 5
    expect(attrs['gen_ai.usage.total_tokens']).toBe(22);
    expect(attrs['gen_ai.provider.name']).toBe('openai');
  });

  it('ends every span when the consumer abandons the stream mid-flight', async () => {
    mockResponsesStream.mockReturnValue(
      makeStreamMock(
        [
          { type: 'response.output_text.delta', delta: 'one' },
          { type: 'response.output_text.delta', delta: 'two' },
        ],
        finalResponse('one two'),
      ),
    );

    // `break` makes the generator run `finally` without ever entering `catch`. Without cleanup
    // there the root span is never ended, so it is never exported, and the run vanishes from AI
    // Config Monitoring along with its `feature_flag` event.
    const gen = createOpenAIHandler().stream?.(baseConfig as never, 'q', {}, {}) as AsyncGenerator<unknown>;
    for await (const _chunk of gen) break;

    const rootSpan = root();
    expect(rootSpan).toBeDefined();
    // Marked, not failed. Stopping early is a normal consumer action, and LaunchDarkly's own
    // metrics record neither a success nor an error for it — an ERROR status here would leave the
    // trace and the AI Config dashboard disagreeing about the same run.
    expect(rootSpan?.attributes['launchdarkly.stream.abandoned']).toBe(true);
    expect(rootSpan?.status.code).toBe(0); // UNSET
    expect(named('chat')).toHaveLength(1); // the in-flight chat span is closed too
  });

  it('ends and parents both spans when the provider call throws', async () => {
    mockResponsesCreate.mockRejectedValue(new Error('provider down'));

    await expect(createOpenAIHandler()(baseConfig as never, 'q')).rejects.toThrow('provider down');

    // The exporter only receives ended spans, so seeing both proves neither was orphaned.
    const [chat] = named('chat');
    expect(root()).toBeDefined();
    expect(chat?.parentSpanContext?.spanId).toBe(root()?.spanContext().spanId);
  });

  // A run that dies partway through has still been billed for the turns that finished, and the root
  // is the only span carrying `launchdarkly.config.key` — so without this a config-scoped cost query
  // reports nothing at all for the run rather than reporting it short.
  it('reports the completed turns token spend on the root when a later turn throws', async () => {
    mockResponsesCreate
      .mockResolvedValueOnce(toolCallResponse())
      .mockRejectedValueOnce(new Error('provider down mid-loop'));

    await expect(
      createOpenAIHandler()(toolConfig as never, 'q', { myTool: vi.fn().mockReturnValue('r') }),
    ).rejects.toThrow('provider down mid-loop');

    // Exactly the one completed turn's usage — `toolCallResponse` reports 5 in, 2 out.
    const attrs = root()?.attributes ?? {};
    expect(attrs['gen_ai.usage.input_tokens']).toBe(5);
    expect(attrs['gen_ai.usage.output_tokens']).toBe(2);
    expect(attrs['gen_ai.usage.total_tokens']).toBe(7);
    expect(root()?.status.code).toBe(2); // still ERROR
  });

  // The other side of the same rule: zeros are a claim that the run cost nothing, which a run whose
  // very first call failed cannot make. An absent attribute says "unknown"; `0` says "free".
  it('writes no token attributes on the root when no turn ever completed', async () => {
    mockResponsesCreate.mockRejectedValue(new Error('provider down'));

    await expect(createOpenAIHandler()(baseConfig as never, 'q')).rejects.toThrow('provider down');

    expect(root()?.attributes['gen_ai.usage.input_tokens']).toBeUndefined();
    expect(root()?.attributes['gen_ai.usage.output_tokens']).toBeUndefined();
  });
});
