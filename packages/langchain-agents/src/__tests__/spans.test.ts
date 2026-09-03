import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { FakeChatModel } from '@langchain/core/utils/testing';
import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLangChainAgentsHandler } from '../handler.js';

/**
 * The companion `callbacks.test.ts` drives `buildSpanCallbacks` directly, against a root span the
 * test creates itself. That proves the callbacks nest under whatever context they are handed, but
 * not that the *handler* hands them the right one — so the handler's own root-to-child wiring was
 * asserted only in `handler.test.ts`, where `startSpan` discards its `parentContext` argument and
 * parentage is unobservable.
 *
 * This file closes that gap: a real `BasicTracerProvider`, a real `createAgent` graph, and a fake
 * chat model injected through the handler's own `llm` parameter. No module is mocked.
 *
 * The `AsyncLocalStorageContextManager` is not incidental. The non-streaming path derives its parent
 * from `context.active()` inside `startActiveSpan`, which only carries the root span while a context
 * manager is registered — `client/src/lifecycle.ts` registers exactly this one, so this setup
 * mirrors production. Without it the tree silently flattens into unrelated root spans.
 */

const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
const contextManager = new AsyncLocalStorageContextManager();

const baseConfig = {
  model: { name: 'gpt-4o' },
  provider: { name: 'OpenAI' },
  instructions: 'You are helpful.',
};

const usage = { input_tokens: 10, output_tokens: 5, total_tokens: 15 };

/**
 * A real `BaseChatModel` (so `createAgent` accepts it) that returns a canned reply and never
 * touches the network. `bindTools` is required by the agent graph and `FakeChatModel` does not
 * provide it.
 */
class FakeToolModel extends FakeChatModel {
  constructor(
    private readonly reply: AIMessage,
    private readonly failWith?: Error,
  ) {
    super({});
  }

  bindTools() {
    return this;
  }

  async _generate(): Promise<{ generations: Array<{ text: string; message: AIMessage }> }> {
    if (this.failWith) throw this.failWith;
    return { generations: [{ text: String(this.reply.content), message: this.reply }] };
  }
}

const makeLLM = (content = 'Hello!') => new FakeToolModel(new AIMessage({ content, usage_metadata: usage })) as never;

class TwoTurnToolModel extends FakeChatModel {
  private calls = 0;

  constructor() {
    super({});
  }

  bindTools() {
    return this;
  }

  async _generate(): Promise<{ generations: Array<{ text: string; message: AIMessage }> }> {
    this.calls++;
    if (this.calls === 1) {
      const message = new AIMessage({
        content: '',
        usage_metadata: usage,
        tool_calls: [{ name: 'search', args: { q: 'x' }, id: 'call_1' }],
      });
      return { generations: [{ text: '', message }] };
    }
    const message = new AIMessage({ content: 'done', usage_metadata: usage });
    return { generations: [{ text: 'done', message }] };
  }
}

/**
 * Answers the first call and throws on every one after it, so a run fails with exactly one turn's
 * usage already reported through the callbacks. The first reply carries tool calls, which is what
 * makes the agent graph come back for the second call.
 */
class FailOnSecondCallModel extends FakeChatModel {
  private calls = 0;

  constructor(private readonly first: AIMessage) {
    super({});
  }

  bindTools() {
    return this;
  }

  async _generate(): Promise<{ generations: Array<{ text: string; message: AIMessage }> }> {
    this.calls++;
    if (this.calls > 1) throw new Error('model down mid-loop');
    return { generations: [{ text: String(this.first.content), message: this.first }] };
  }
}

const toolConfig = {
  ...baseConfig,
  tools: { search: { name: 'search', type: 'function' as const, parameters: { type: 'object', properties: {} } } },
};

const spans = () => exporter.getFinishedSpans();
const named = (prefix: string) => spans().filter((s) => s.name.startsWith(prefix));
const root = () => spans().find((s) => s.name === 'invoke_agent');

describe('langchain-agents span tree against a real tracer', () => {
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

  it('nests the chat span under the invoke_agent root the handler created', async () => {
    const llm = makeLLM();

    await createLangChainAgentsHandler(llm)(baseConfig as never, 'q');

    const [chat] = named('chat');
    expect(chat).toBeDefined();
    expect(chat.parentSpanContext?.spanId).toBe(root()?.spanContext().spanId);
    expect(chat.spanContext().traceId).toBe(root()?.spanContext().traceId);
  });

  it('carries the run-level token totals and the serving provider on the root', async () => {
    const llm = makeLLM();

    await createLangChainAgentsHandler(llm)(baseConfig as never, 'q');

    const attrs = root()?.attributes ?? {};
    expect(attrs['gen_ai.usage.input_tokens']).toBe(10);
    expect(attrs['gen_ai.usage.output_tokens']).toBe(5);
    expect(attrs['gen_ai.usage.total_tokens']).toBe(15);
    // `gen_ai.provider.name` names who served the model; `langchain` is the framework and is not a
    // member of the semconv enum. The legacy `gen_ai.system` keeps the value the handler shipped.
    expect(attrs['gen_ai.provider.name']).toBe('openai');
    expect(attrs['gen_ai.system']).toBe('langchain');
  });

  it('reports anthropic as the serving provider when the config names it', async () => {
    const llm = makeLLM('Hi');
    const config = { ...baseConfig, provider: { name: 'Anthropic' }, model: { name: 'claude-sonnet-4-5' } };

    await createLangChainAgentsHandler(llm)(config as never, 'q');

    expect(root()?.attributes['gen_ai.provider.name']).toBe('anthropic');
  });

  it('keeps one trace id across the whole tree', async () => {
    const llm = makeLLM();

    await createLangChainAgentsHandler(llm)(baseConfig as never, 'q');

    expect(new Set(spans().map((s) => s.spanContext().traceId)).size).toBe(1);
  });

  it('ends and fails both spans when the model throws', async () => {
    const llm = new FakeToolModel(new AIMessage({ content: '' }), new Error('model down')) as never;

    await expect(createLangChainAgentsHandler(llm)(baseConfig as never, 'q')).rejects.toThrow(/model down/);

    // The exporter only receives ended spans, so seeing the root proves it was not orphaned.
    expect(root()).toBeDefined();
    expect(root()?.status.code).toBe(2); // ERROR
  });

  /**
   * The success path sums `usage_metadata` over `result.messages`, and on a throw there is no
   * `result` to sum. The run total therefore comes from the callbacks, which saw every turn that
   * did complete — those tokens were billed, and the root is the only span carrying
   * `launchdarkly.config.key`, so a config-scoped cost query finds nothing without it.
   */
  it('reports the completed turns token spend on the root when a later turn throws', async () => {
    const llm = new FailOnSecondCallModel(
      new AIMessage({
        content: '',
        usage_metadata: usage,
        tool_calls: [{ name: 'search', args: { q: 'x' }, id: 'call_1' }],
      }),
    ) as never;

    await expect(
      createLangChainAgentsHandler(llm)(toolConfig as never, 'q', { search: vi.fn().mockReturnValue('r') }),
    ).rejects.toThrow(/model down mid-loop/);

    // Exactly the one turn that completed: 10 in, 5 out.
    const attrs = root()?.attributes ?? {};
    expect(attrs['gen_ai.usage.input_tokens']).toBe(10);
    expect(attrs['gen_ai.usage.output_tokens']).toBe(5);
    expect(root()?.status.code).toBe(2); // still ERROR
  });

  // Zeros would assert the run cost nothing; an absent attribute says "unknown".
  it('writes no token attributes on the root when no turn ever completed', async () => {
    const llm = new FakeToolModel(new AIMessage({ content: '' }), new Error('model down')) as never;

    await expect(createLangChainAgentsHandler(llm)(baseConfig as never, 'q')).rejects.toThrow(/model down/);

    expect(root()?.attributes['gen_ai.usage.input_tokens']).toBeUndefined();
  });

  it('nests the chat span under the root in the streaming path', async () => {
    const llm = makeLLM();

    const gen = createLangChainAgentsHandler(llm).stream?.(baseConfig as never, 'q', {}, {}) as AsyncGenerator<unknown>;
    for await (const _event of gen) {
      // drain
    }

    const [chat] = named('chat');
    expect(chat).toBeDefined();
    expect(chat.parentSpanContext?.spanId).toBe(root()?.spanContext().spanId);
  });

  it('ends every span when the consumer abandons the stream mid-flight', async () => {
    const llm = makeLLM();

    const gen = createLangChainAgentsHandler(llm).stream?.(baseConfig as never, 'q', {}, {}) as AsyncGenerator<unknown>;
    for await (const _event of gen) break;

    const rootSpan = root();
    expect(rootSpan).toBeDefined();
    // Marked, not failed: stopping early is a normal consumer action and LaunchDarkly's own metrics
    // record neither a success nor an error for it.
    expect(rootSpan?.attributes['launchdarkly.stream.abandoned']).toBe(true);
    expect(rootSpan?.status.code).toBe(0); // UNSET
  });

  // LangChain does not normalise the finish reason, so the handler reads the provider's own string
  // off the LLMResult and maps it. Anthropic is the input here precisely because this handler also
  // serves OpenAI: the same `chat` span shape has to report the same value for the same outcome no
  // matter which vendor is behind it, which an untranslated `end_turn` would not.
  it('maps the provider finish reason onto the semconv vocabulary on the chat span', async () => {
    const llm = new FakeToolModel(
      new AIMessage({ content: 'Hello!', usage_metadata: usage, response_metadata: { stop_reason: 'end_turn' } }),
    ) as never;

    await createLangChainAgentsHandler(llm)(baseConfig as never, 'q');

    const [chat] = named('chat');
    expect(chat.attributes['gen_ai.response.finish_reasons']).toEqual(['stop']);
  });

  it('omits the finish reason when the provider reports none', async () => {
    await createLangChainAgentsHandler(makeLLM())(baseConfig as never, 'q');

    const [chat] = named('chat');
    expect(chat.attributes['gen_ai.response.finish_reasons']).toBeUndefined();
  });

  it('leaves HumanMessage and ToolMessage out of the token totals', async () => {
    // The handler sums `usage_metadata` over `result.messages`, which is the whole conversation.
    // Only AI messages carry usage, so the sum must equal one turn rather than counting the input.
    const llm = makeLLM();

    const result = await createLangChainAgentsHandler(llm)(baseConfig as never, 'q');

    expect(result.usage).toMatchObject({ input_tokens: 10, output_tokens: 5 });
    expect(new HumanMessage('q').usage_metadata).toBeUndefined();
  });

  it('puts context identity on the invoke_agent root and on no child span', async () => {
    const llm = new TwoTurnToolModel() as never;

    await createLangChainAgentsHandler(llm)(
      toolConfig as never,
      'q',
      { search: vi.fn().mockReturnValue('r') },
      {
        __ld: { configKey: 'cfg', variationKey: 'var', runId: 'run-1' },
        ldContext: { kind: 'user', key: 'user-123' },
      },
    );

    const featureFlag = root()?.events.find((event) => event.name === 'feature_flag');
    expect(root()?.attributes['context.contextKeys.user']).toBe('user-123');
    expect(featureFlag?.attributes?.['feature_flag.context.id']).toBe('user-123');
    expect(featureFlag?.attributes?.['feature_flag.contextKeys']).toBe('{"user":"user-123"}');

    expect(named('chat').length).toBeGreaterThan(0);
    expect(named('execute_tool ').length).toBeGreaterThan(0);
    for (const child of spans().filter((span) => span.name !== 'invoke_agent')) {
      expect(child.attributes['context.contextKeys.user']).toBeUndefined();
      expect(child.events.find((event) => event.name === 'feature_flag')).toBeUndefined();
    }
  });
});
