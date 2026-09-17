import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unlike `handler.test.ts`, this file mocks neither `@opentelemetry/api` nor the Agents SDK's loop.
 *
 * `handler.test.ts` replaces `Agent` with an EventEmitter-lite and `Runner` with a stub whose `run`
 * returns a canned result, so the tool lifecycle has to be driven by hand and parentage is
 * unobservable (its stubbed `startSpan` discards the `parentContext` argument entirely).
 *
 * Here the real `Agent`, the real `Runner` and the real tool-invocation path run against a real
 * tracer. Only the network seam is faked, and it is installed through the SDK's own
 * `setDefaultModelProvider()` rather than a module mock — no module is mocked in this file at all.
 * The agent loop, the `agent_tool_start`/`agent_tool_end` emissions and the `SpanningModel`
 * interception are therefore all exercised as shipped, which is the point: in this handler the SDK
 * owns the loop and our spans hang off interception seams rather than off blocks we control.
 *
 * The `AsyncLocalStorageContextManager` is not incidental. The non-streaming path derives its parent
 * from `context.active()` inside `startActiveSpan`, which only carries the root span while a context
 * manager is registered — `client/src/lifecycle.ts` registers exactly this one, so this setup
 * mirrors production. Without it the tree silently flattens into unrelated root spans. The streaming
 * path builds its parent with an explicit `trace.setSpan` and is unaffected either way.
 */

process.env.OPENAI_API_KEY ??= 'test-key-not-used';

const responseQueue: unknown[] = [];
const streamQueue: unknown[][] = [];

/**
 * Stands in for the only part of the SDK that would touch the network, and is installed through
 * the SDK's own public `setDefaultModelProvider()` rather than a module mock. That is deliberate:
 * the handler resolves its provider from the SDK default precisely so a user's custom provider is
 * honoured, and installing the fake the same way a user would is what pins that behaviour.
 */
const fakeModelProvider = {
  async getModel() {
    return {
      getResponse: async () => {
        const next = responseQueue.shift();
        if (next === undefined) throw new Error('fake model: response queue is empty');
        if (next instanceof Error) throw next;
        return next;
      },
      getStreamedResponse: async function* () {
        const events = streamQueue.shift();
        if (events === undefined) throw new Error('fake model: stream queue is empty');
        for (const event of events) yield event;
      },
    };
  },
} as never;

import { setDefaultModelProvider, setTracingDisabled, Usage } from '@openai/agents';
import { createOpenAIAgentHandler } from '../handler.js';

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
  tools: {
    search: {
      name: 'search',
      type: 'function' as const,
      description: 'Search',
      parameters: {
        type: 'object',
        properties: { q: { type: 'string' } },
        required: ['q'],
        additionalProperties: false,
      },
    },
  },
};

const usage = () => new Usage({ requests: 1, inputTokens: 10, outputTokens: 5, totalTokens: 15 });

const messageItem = (text: string) => ({
  id: 'msg_1',
  type: 'message' as const,
  role: 'assistant' as const,
  status: 'completed' as const,
  content: [{ type: 'output_text' as const, text }],
});

const textResponse = (text = 'Hello!') => ({ usage: usage(), output: [messageItem(text)], responseId: 'resp_text' });

const toolCallResponse = () => ({
  usage: usage(),
  output: [
    {
      id: 'fc_1',
      type: 'function_call' as const,
      callId: 'call_1',
      name: 'search',
      arguments: '{"q":"test"}',
      status: 'completed' as const,
    },
  ],
  responseId: 'resp_tool',
});

const collectStream = async (gen: AsyncGenerator<unknown>) => {
  const out: unknown[] = [];
  for await (const e of gen) out.push(e);
  return out;
};

const spans = () => exporter.getFinishedSpans();
const named = (prefix: string) => spans().filter((s) => s.name.startsWith(prefix));
const root = () => spans().find((s) => s.name === 'invoke_agent');

describe('openai-agents span tree against the real Runner', () => {
  beforeAll(() => {
    // The SDK otherwise ships its own traces to OpenAI's backend over the network.
    setTracingDisabled(true);
    setDefaultModelProvider(fakeModelProvider);
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
    responseQueue.length = 0;
    streamQueue.length = 0;
  });

  it('nests the chat span under the invoke_agent root', async () => {
    responseQueue.push(textResponse());

    await createOpenAIAgentHandler()(baseConfig as never, 'q');

    const [chat] = named('chat');
    expect(chat).toBeDefined();
    expect(chat.parentSpanContext?.spanId).toBe(root()?.spanContext().spanId);
  });

  it('keeps every chat span of a real multi-turn tool loop a direct child of the root', async () => {
    responseQueue.push(toolCallResponse(), textResponse('Final'));

    const result = await createOpenAIAgentHandler()(toolConfig as never, 'q', {
      search: vi.fn().mockReturnValue('r'),
    });

    // Proves the Runner really took a second turn rather than stopping at the tool call.
    expect(result.output).toBe('Final');

    const chats = named('chat');
    const rootId = root()?.spanContext().spanId;
    expect(chats).toHaveLength(2);
    // Siblings, not a chain: a chat span nested under the previous chat span would misreport
    // per-turn latency as cumulative.
    expect(chats.map((s) => s.parentSpanContext?.spanId)).toEqual([rootId, rootId]);
  });

  // Neither the Agents SDK's ModelResponse nor the Responses API under it has a per-message finish
  // reason, so the semconv value is derived from the run `status`. `completed` is a run status and
  // not a member of the finish-reason vocabulary; emitting it verbatim is what this used to do.
  it('maps a completed run onto stop', async () => {
    responseQueue.push({ ...textResponse(), providerData: { status: 'completed' } });

    await createOpenAIAgentHandler()(baseConfig as never, 'q');

    expect(named('chat')[0].attributes['gen_ai.response.finish_reasons']).toEqual(['stop']);
  });

  // The regression this pins: a turn that stopped to call a tool reports `status: 'completed'` too,
  // so passing the status through labelled every span in a tool loop identically. The output items
  // are the only thing that tells the two apart.
  it('reports tool_calls for a turn that stopped to call a tool, not the completed status', async () => {
    responseQueue.push(
      { ...toolCallResponse(), providerData: { status: 'completed' } },
      { ...textResponse('Final'), providerData: { status: 'completed' } },
    );

    await createOpenAIAgentHandler()(toolConfig as never, 'q', { search: vi.fn().mockReturnValue('r') });

    expect(named('chat').map((s) => s.attributes['gen_ai.response.finish_reasons'])).toEqual([
      ['tool_calls'],
      ['stop'],
    ]);
  });

  it('maps a truncated run onto length and a filtered one onto content_filter', async () => {
    responseQueue.push(
      {
        ...textResponse(),
        providerData: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } },
      },
      { ...textResponse(), providerData: { status: 'incomplete', incomplete_details: { reason: 'content_filter' } } },
    );

    await createOpenAIAgentHandler()(baseConfig as never, 'q');
    await createOpenAIAgentHandler()(baseConfig as never, 'q');

    expect(named('chat').map((s) => s.attributes['gen_ai.response.finish_reasons'])).toEqual([
      ['length'],
      ['content_filter'],
    ]);
  });

  // A turn reporting neither a function call nor a recognised status leaves the attribute off,
  // rather than asserting `stop` for a run whose outcome nothing reported.
  it('omits the finish reason when the response carries no providerData', async () => {
    responseQueue.push(textResponse());

    await createOpenAIAgentHandler()(baseConfig as never, 'q');

    expect(named('chat')[0].attributes['gen_ai.response.finish_reasons']).toBeUndefined();
  });

  it('nests the SDK-emitted execute_tool span under the root, not under the chat span', async () => {
    const search = vi.fn().mockReturnValue('r');
    responseQueue.push(toolCallResponse(), textResponse('Final'));

    await createOpenAIAgentHandler()(toolConfig as never, 'q', { search });

    // The span exists because the real Runner invoked the tool and emitted agent_tool_start/end.
    expect(search).toHaveBeenCalledTimes(1);

    const [tool] = named('execute_tool ');
    const chatIds = new Set(named('chat').map((s) => s.spanContext().spanId));
    expect(tool).toBeDefined();
    expect(tool.parentSpanContext?.spanId).toBe(root()?.spanContext().spanId);
    expect(chatIds.has(tool.parentSpanContext?.spanId ?? '')).toBe(false);

    const traceIds = new Set(spans().map((s) => s.spanContext().traceId));
    expect(traceIds.size).toBe(1);
  });

  it('nests the chat span under the root in the streaming path', async () => {
    streamQueue.push([
      {
        type: 'response_done',
        response: {
          id: 'resp_stream',
          usage: { requests: 1, inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          output: [messageItem('Hi')],
        },
      },
    ]);

    await collectStream(createOpenAIAgentHandler().stream?.(baseConfig as never, 'q', {}, {}) as never);

    const [chat] = named('chat');
    expect(chat).toBeDefined();
    expect(chat.parentSpanContext?.spanId).toBe(root()?.spanContext().spanId);
  });

  it('routes through the provider installed with setDefaultModelProvider', async () => {
    // Regression guard: the handler used to hard-code `new OpenAIProvider()`, which silently sent
    // Azure / LiteLLM / Ollama users to api.openai.com. Every other test in this file also depends
    // on the fake provider being reached, so this asserts the mechanism directly.
    const getModel = vi.fn(fakeModelProvider.getModel);
    setDefaultModelProvider({ getModel } as never);
    responseQueue.push(textResponse());

    await createOpenAIAgentHandler()(baseConfig as never, 'q');

    expect(getModel).toHaveBeenCalled();
    setDefaultModelProvider(fakeModelProvider);
  });

  it('carries the run-level token totals on the invoke_agent root, not only on the children', async () => {
    responseQueue.push(toolCallResponse(), textResponse('Final'));

    await createOpenAIAgentHandler()(toolConfig as never, 'q', { search: vi.fn().mockReturnValue('r') });

    // The root is the only span carrying `launchdarkly.*` and the `feature_flag` event, so a
    // config-scoped query finds it and nothing else. Totals must be readable there.
    const attrs = root()?.attributes ?? {};
    expect(attrs['gen_ai.usage.input_tokens']).toBe(20); // two turns of 10
    expect(attrs['gen_ai.usage.output_tokens']).toBe(10);
    expect(attrs['gen_ai.usage.total_tokens']).toBe(30);
    expect(attrs['gen_ai.provider.name']).toBe('openai');
  });

  it('ends and parents both spans when the model call throws', async () => {
    responseQueue.push(new Error('provider down'));

    await expect(createOpenAIAgentHandler()(baseConfig as never, 'q')).rejects.toThrow('provider down');

    // The exporter only receives ended spans, so seeing both proves neither was orphaned.
    const [chat] = named('chat');
    expect(root()).toBeDefined();
    expect(chat?.parentSpanContext?.spanId).toBe(root()?.spanContext().spanId);
  });

  /**
   * The Agents SDK attaches the `RunState` it failed in to its own errors, and that state carries
   * the same `usage` aggregate the success path reads. So a failed run has already told us what it
   * spent, and the root — the only span carrying `launchdarkly.config.key` — must report it.
   *
   * This is not hypothetical: a live run hit `MaxTurnsExceededError` after ten calls and ~155k input
   * tokens, and reported none of them, because the root's usage was written only on success.
   */
  it('reports the run spend the Agents SDK attached to its error on the root', async () => {
    const failure = Object.assign(new Error('Max turns (10) exceeded'), {
      state: { usage: { inputTokens: 155_000, outputTokens: 320 } },
    });
    responseQueue.push(failure);

    await expect(createOpenAIAgentHandler()(baseConfig as never, 'q')).rejects.toThrow('Max turns (10) exceeded');

    const attrs = root()?.attributes ?? {};
    expect(attrs['gen_ai.usage.input_tokens']).toBe(155_000);
    expect(attrs['gen_ai.usage.output_tokens']).toBe(320);
    expect(attrs['gen_ai.usage.total_tokens']).toBe(155_320);
    expect(root()?.status.code).toBe(2); // still ERROR
  });

  // A tool handler's own error propagates unwrapped and carries no `state`. Zeros would assert the
  // run cost nothing; an absent attribute correctly says "unknown".
  it('writes no token attributes on the root when the error carries no run state', async () => {
    responseQueue.push(new Error('provider down'));

    await expect(createOpenAIAgentHandler()(baseConfig as never, 'q')).rejects.toThrow('provider down');

    expect(root()?.attributes['gen_ai.usage.input_tokens']).toBeUndefined();
    expect(root()?.attributes['gen_ai.usage.output_tokens']).toBeUndefined();
  });

  it('puts context identity on the invoke_agent root and on no child span', async () => {
    responseQueue.push(toolCallResponse(), textResponse('Final'));

    await createOpenAIAgentHandler()(
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
