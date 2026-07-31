import { AIMessage, AIMessageChunk } from '@langchain/core/messages';
import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLangChainHandler } from '../handler.js';

/**
 * Unlike `handler.test.ts`, this file mocks no modules at all — the chat model is injected through
 * the handler's own `llm` parameter, and the tracer is real.
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

const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
const contextManager = new AsyncLocalStorageContextManager();

const baseConfig = {
  model: { name: 'gpt-4o' },
  provider: { name: 'LangChain' },
  instructions: 'You are helpful.',
};

const toolConfig = {
  ...baseConfig,
  tools: { myTool: { name: 'myTool', type: 'function' as const, parameters: {} } },
};

const usage = { input_tokens: 10, output_tokens: 5, total_tokens: 15 };

/** The handler only ever calls `bindTools`, `invoke` and `stream` on the injected model. */
function makeLLM(responses: AIMessage[]) {
  const invoke = vi.fn();
  for (const r of responses) invoke.mockResolvedValueOnce(r);
  const llm = {
    invoke,
    bindTools: () => llm,
    stream: async () =>
      (async function* () {
        yield new AIMessageChunk({ content: 'Hi', usage_metadata: usage });
      })(),
  };
  return llm as never;
}

const textResponse = (content = 'Hello!') => new AIMessage({ content, usage_metadata: usage });

const toolCallResponse = () =>
  new AIMessage({
    content: '',
    tool_calls: [{ name: 'myTool', id: 'tc_1', args: { q: 'test' } }],
    usage_metadata: usage,
  });

const collectStream = async (gen: AsyncGenerator<unknown>) => {
  const out: unknown[] = [];
  for await (const e of gen) out.push(e);
  return out;
};

const spans = () => exporter.getFinishedSpans();
const named = (prefix: string) => spans().filter((s) => s.name.startsWith(prefix));
const root = () => spans().find((s) => s.name === 'invoke_agent');

describe('langchain-messages span tree against a real tracer', () => {
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
    exporter.reset();
  });

  it('nests the chat span under the invoke_agent root', async () => {
    await createLangChainHandler(makeLLM([textResponse()]))(baseConfig as never, 'q');

    const [chat] = named('chat');
    expect(chat).toBeDefined();
    expect(chat.parentSpanContext?.spanId).toBe(root()?.spanContext().spanId);
  });

  it('keeps every chat span of a multi-turn tool loop a direct child of the root', async () => {
    const llm = makeLLM([toolCallResponse(), textResponse('Final')]);

    await createLangChainHandler(llm)(toolConfig as never, 'q', { myTool: vi.fn().mockReturnValue('r') });

    const chats = named('chat');
    const rootId = root()?.spanContext().spanId;
    expect(chats).toHaveLength(2);
    // Siblings, not a chain: a chat span nested under the previous chat span would misreport
    // per-turn latency as cumulative.
    expect(chats.map((s) => s.parentSpanContext?.spanId)).toEqual([rootId, rootId]);
  });

  it('nests the execute_tool span under the root and keeps one trace id across the tree', async () => {
    const llm = makeLLM([toolCallResponse(), textResponse('Final')]);

    await createLangChainHandler(llm)(toolConfig as never, 'q', { myTool: vi.fn().mockReturnValue('r') });

    const [tool] = named('execute_tool ');
    expect(tool).toBeDefined();
    expect(tool.parentSpanContext?.spanId).toBe(root()?.spanContext().spanId);

    const traceIds = new Set(spans().map((s) => s.spanContext().traceId));
    expect(traceIds.size).toBe(1);
  });

  it('nests the chat span under the root in the streaming path', async () => {
    const handler = createLangChainHandler(makeLLM([]));

    await collectStream(handler.stream?.(baseConfig as never, 'q', {}, {}) as never);

    const [chat] = named('chat');
    expect(chat).toBeDefined();
    expect(chat.parentSpanContext?.spanId).toBe(root()?.spanContext().spanId);
  });

  it('carries the run-level token totals on the invoke_agent root, not only on the children', async () => {
    const llm = makeLLM([toolCallResponse(), textResponse('Final')]);

    await createLangChainHandler(llm)(toolConfig as never, 'q', { myTool: vi.fn().mockReturnValue('r') });

    // The root is the only span carrying `launchdarkly.*` and the `feature_flag` event, so a
    // config-scoped query finds it and nothing else. Totals must be readable there.
    const attrs = root()?.attributes ?? {};
    expect(attrs['gen_ai.usage.input_tokens']).toBe(20); // two turns of 10
    expect(attrs['gen_ai.usage.output_tokens']).toBe(10);
    expect(attrs['gen_ai.usage.total_tokens']).toBe(30);
    // `gen_ai.provider.name` names who served the model, and its semconv enum has no `langchain`
    // member — LangChain is the framework. The legacy `gen_ai.system` keeps the shipped value.
    expect(attrs['gen_ai.provider.name']).toBe('openai');
    expect(attrs['gen_ai.system']).toBe('langchain');
  });

  it('preserves the cache breakdown on the streaming chat span', async () => {
    // LangChain reports the split per chunk in `usage_metadata.input_token_details`. Synthesizing
    // a usage bag from the two scalars alone made this span emit `cache_read = 0` while the
    // blocking path emitted the real figure — a zero that reads as "no cached tokens".
    const llm = {
      bindTools: () => llm,
      invoke: vi.fn(),
      stream: async () =>
        (async function* () {
          yield new AIMessageChunk({
            content: 'Hi',
            usage_metadata: {
              input_tokens: 10005,
              output_tokens: 1,
              total_tokens: 10006,
              input_token_details: { cache_read: 10000, cache_creation: 0 },
            },
          });
        })(),
    } as never;

    await collectStream(createLangChainHandler(llm).stream?.(baseConfig as never, 'q', {}, {}) as never);

    const [chat] = named('chat');
    expect(chat.attributes['gen_ai.usage.cache_read.input_tokens']).toBe(10000);
    expect(chat.attributes['gen_ai.usage.input_tokens']).toBe(10005);
    // Surfaced, never re-added: LangChain already counts the cached portion inside input.
    expect(chat.attributes['gen_ai.usage.total_tokens']).toBe(10006);
  });

  it('ends every span when the consumer abandons the stream mid-flight', async () => {
    const llm = {
      bindTools: () => llm,
      invoke: vi.fn(),
      stream: async () =>
        (async function* () {
          yield new AIMessageChunk({ content: 'one', usage_metadata: usage });
          yield new AIMessageChunk({ content: 'two', usage_metadata: usage });
        })(),
    } as never;

    // `break` makes the generator run `finally` without ever entering `catch`. Without cleanup
    // there the root span is never ended, so it is never exported, and the run vanishes from AI
    // Config Monitoring along with its `feature_flag` event.
    const gen = createLangChainHandler(llm).stream?.(baseConfig as never, 'q', {}, {}) as AsyncGenerator<unknown>;
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

  // The handler reads the provider's own string off the AIMessage that invoke() returned, so a
  // `chat` span here reports the same attribute as the claude and openai handlers do.
  it('records the provider finish reason on each chat span', async () => {
    const llm = makeLLM([
      new AIMessage({ content: 'Hello!', usage_metadata: usage, response_metadata: { finish_reason: 'stop' } }),
    ]);

    await createLangChainHandler(llm)(baseConfig as never, 'q');

    expect(named('chat')[0].attributes['gen_ai.response.finish_reasons']).toEqual(['stop']);
  });

  it('omits the finish reason when the provider reports none', async () => {
    await createLangChainHandler(makeLLM([textResponse()]))(baseConfig as never, 'q');

    expect(named('chat')[0].attributes['gen_ai.response.finish_reasons']).toBeUndefined();
  });

  it('ends and parents both spans when the model call throws', async () => {
    const llm = { invoke: vi.fn().mockRejectedValue(new Error('model down')), bindTools: () => llm } as never;

    await expect(createLangChainHandler(llm)(baseConfig as never, 'q')).rejects.toThrow('model down');

    // The exporter only receives ended spans, so seeing both proves neither was orphaned.
    const [chat] = named('chat');
    expect(root()).toBeDefined();
    expect(chat?.parentSpanContext?.spanId).toBe(root()?.spanContext().spanId);
  });

  // The turns that completed were billed, and the root is the only span a config-scoped cost query
  // can read them from — so a run that dies mid-loop must report short rather than report nothing.
  it('reports the completed turns token spend on the root when a later turn throws', async () => {
    const invoke = vi
      .fn()
      .mockResolvedValueOnce(toolCallResponse())
      .mockRejectedValueOnce(new Error('model down mid-loop'));
    const llm = { invoke, bindTools: () => llm } as never;

    await expect(
      createLangChainHandler(llm)(toolConfig as never, 'q', { myTool: vi.fn().mockReturnValue('r') }),
    ).rejects.toThrow('model down mid-loop');

    const attrs = root()?.attributes ?? {};
    expect(attrs['gen_ai.usage.input_tokens']).toBe(10);
    expect(attrs['gen_ai.usage.output_tokens']).toBe(5);
    expect(root()?.status.code).toBe(2); // still ERROR
  });

  // Zeros would assert the run cost nothing; an absent attribute says "unknown".
  it('writes no token attributes on the root when no turn ever completed', async () => {
    const llm = { invoke: vi.fn().mockRejectedValue(new Error('model down')), bindTools: () => llm } as never;

    await expect(createLangChainHandler(llm)(baseConfig as never, 'q')).rejects.toThrow('model down');

    expect(root()?.attributes['gen_ai.usage.input_tokens']).toBeUndefined();
  });
});
