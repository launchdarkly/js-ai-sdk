import { context, DiagLogLevel, diag, trace } from '@opentelemetry/api';
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

const { mockMessagesCreate, mockMessagesStream } = vi.hoisted(() => ({
  mockMessagesCreate: vi.fn(),
  mockMessagesStream: vi.fn(),
}));

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: mockMessagesCreate, stream: mockMessagesStream };
  },
}));

import { createClaudeMessagesHandler } from '../handler.js';

const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
const contextManager = new AsyncLocalStorageContextManager();

const baseConfig = {
  model: { name: 'claude-3-5-sonnet-20241022' },
  provider: { name: 'Anthropic' },
  instructions: 'You are helpful.',
};

const toolConfig = {
  ...baseConfig,
  tools: { myTool: { name: 'myTool', type: 'function' as const, parameters: {} } },
};

const finalResponse = (text = 'Hello!') => ({
  stop_reason: 'end_turn',
  content: [{ type: 'text', text }],
  usage: { input_tokens: 10, output_tokens: 5 },
});

const toolUseResponse = () => ({
  stop_reason: 'tool_use',
  content: [{ type: 'tool_use', id: 'tu_1', name: 'myTool', input: { q: 'test' } }],
  usage: { input_tokens: 5, output_tokens: 2 },
});

const makeStreamMock = (events: unknown[], finalMsg: unknown) => ({
  [Symbol.asyncIterator]: async function* () {
    for (const e of events) yield e;
  },
  finalMessage: vi.fn().mockResolvedValue(finalMsg),
});

const collectStream = async (gen: AsyncGenerator<unknown>) => {
  const out: unknown[] = [];
  for await (const e of gen) out.push(e);
  return out;
};

const spans = () => exporter.getFinishedSpans();
const named = (prefix: string) => spans().filter((s) => s.name.startsWith(prefix));
const root = () => spans().find((s) => s.name === 'invoke_agent');

describe('claude-messages span tree against a real tracer', () => {
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
    mockMessagesCreate.mockResolvedValue(finalResponse());

    await createClaudeMessagesHandler()(baseConfig as never, 'q');

    const [chat] = named('chat');
    expect(chat).toBeDefined();
    expect(chat.parentSpanContext?.spanId).toBe(root()?.spanContext().spanId);
  });

  it('keeps every chat span of a multi-turn tool loop a direct child of the root', async () => {
    mockMessagesCreate.mockResolvedValueOnce(toolUseResponse()).mockResolvedValueOnce(finalResponse('Final'));

    await createClaudeMessagesHandler()(toolConfig as never, 'q', { myTool: vi.fn().mockReturnValue('r') });

    const chats = named('chat');
    const rootId = root()?.spanContext().spanId;
    expect(chats).toHaveLength(2);
    // Siblings, not a chain: a chat span nested under the previous chat span would misreport
    // per-turn latency as cumulative.
    expect(chats.map((s) => s.parentSpanContext?.spanId)).toEqual([rootId, rootId]);
  });

  it('nests the execute_tool span under the root and keeps one trace id across the tree', async () => {
    mockMessagesCreate.mockResolvedValueOnce(toolUseResponse()).mockResolvedValueOnce(finalResponse('Final'));

    await createClaudeMessagesHandler()(toolConfig as never, 'q', { myTool: vi.fn().mockReturnValue('r') });

    const [tool] = named('execute_tool ');
    expect(tool).toBeDefined();
    expect(tool.parentSpanContext?.spanId).toBe(root()?.spanContext().spanId);

    const traceIds = new Set(spans().map((s) => s.spanContext().traceId));
    expect(traceIds.size).toBe(1);
  });

  it('nests the chat span under the root in the streaming path', async () => {
    mockMessagesStream.mockReturnValue(
      makeStreamMock([{ type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi' } }], finalResponse('Hi')),
    );

    await collectStream(createClaudeMessagesHandler().stream?.(baseConfig as never, 'q', {}, {}) as never);

    const [chat] = named('chat');
    expect(chat).toBeDefined();
    expect(chat.parentSpanContext?.spanId).toBe(root()?.spanContext().spanId);
  });

  it('carries the run-level token totals on the invoke_agent root, not only on the children', async () => {
    mockMessagesCreate.mockResolvedValueOnce(toolUseResponse()).mockResolvedValueOnce(finalResponse('Final'));

    await createClaudeMessagesHandler()(toolConfig as never, 'q', { myTool: vi.fn().mockReturnValue('r') });

    // The root is the only span carrying `launchdarkly.*` and the `feature_flag` event, so a
    // config-scoped query finds it and nothing else. Totals must be readable there.
    const attrs = root()?.attributes ?? {};
    expect(attrs['gen_ai.usage.input_tokens']).toBe(15); // 5 + 10
    expect(attrs['gen_ai.usage.output_tokens']).toBe(7); // 2 + 5
    expect(attrs['gen_ai.usage.total_tokens']).toBe(22);
    expect(attrs['gen_ai.provider.name']).toBe('anthropic');
    expect(attrs['gen_ai.request.model']).toBe('claude-3-5-sonnet-20241022');
  });

  it('ends every span when the consumer abandons the stream mid-flight', async () => {
    mockMessagesStream.mockReturnValue(
      makeStreamMock(
        [
          { type: 'content_block_delta', delta: { type: 'text_delta', text: 'one' } },
          { type: 'content_block_delta', delta: { type: 'text_delta', text: 'two' } },
        ],
        finalResponse('one two'),
      ),
    );

    // `break` makes the generator run `finally` without ever entering `catch`. Without cleanup
    // there, the root span is never ended, so it is never exported — and the run vanishes from
    // AI Config Monitoring along with its `feature_flag` event.
    const gen = createClaudeMessagesHandler().stream?.(baseConfig as never, 'q', {}, {}) as AsyncGenerator<unknown>;
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

  it('ends each span once when the stream itself rejects', async () => {
    // The streaming error path runs two failure handlers over the same chat span: the inner catch,
    // and the outer one via `openModelSpan` (the line that clears it is unreachable here). A double
    // `end()` leaves the exported span data intact — the OTel SDK ignores the second call — so the
    // only observable signal is the diagnostic it logs. That is what this asserts, because it is the
    // one thing that actually differs when the guard is missing.
    const diagErrors: string[] = [];
    diag.setLogger(
      { error: (msg: string) => diagErrors.push(msg), warn() {}, info() {}, debug() {}, verbose() {} },
      DiagLogLevel.ERROR,
    );

    mockMessagesStream.mockImplementation(() => {
      throw new Error('stream exploded');
    });

    const gen = createClaudeMessagesHandler().stream?.(baseConfig as never, 'q', {}, {}) as AsyncGenerator<unknown>;
    await expect(collectStream(gen)).rejects.toThrow('stream exploded');
    diag.disable();

    expect(diagErrors.filter((m) => m.includes('You can only call end() on a span once'))).toEqual([]);

    const chats = named('chat');
    expect(chats).toHaveLength(1);
    expect(chats[0].status.code).toBe(2); // ERROR
    expect(chats[0].events.filter((e) => e.name === 'exception')).toHaveLength(1);
    expect(root()?.status.code).toBe(2);
  });

  it('carries both content carriers on the exported spans when capture is on', async () => {
    mockMessagesCreate.mockResolvedValueOnce(toolUseResponse()).mockResolvedValueOnce(finalResponse('Final'));

    await createClaudeMessagesHandler({ captureContent: true })(toolConfig as never, 'q', {
      myTool: vi.fn().mockReturnValue('r'),
    });

    // The canonical carrier the proposal makes normative.
    const [firstChat, secondChat] = named('chat');
    expect(JSON.parse(String(firstChat.attributes['gen_ai.input.messages']))).toEqual([
      { role: 'user', parts: [{ type: 'text', content: 'q' }] },
    ]);
    // A `chat` span is self-contained: turn two's input holds turn one's tool call and its result,
    // so a reader never has to walk to a sibling span to reconstruct the conversation.
    const secondTurnInput = JSON.parse(String(secondChat.attributes['gen_ai.input.messages']));
    expect(secondTurnInput).toHaveLength(3);
    expect(secondTurnInput[1].parts[0]).toEqual({
      type: 'tool_call',
      id: 'tu_1',
      name: 'myTool',
      arguments: { q: 'test' },
    });
    expect(secondTurnInput[2].parts[0]).toEqual({ type: 'tool_call_response', id: 'tu_1', result: 'r' });

    // The flat carrier, which is the only one LaunchDarkly's trace view parses today.
    expect(firstChat.attributes['gen_ai.prompt.0.role']).toBe('system');
    expect(firstChat.attributes['gen_ai.prompt.1.content']).toBe('q');
    expect(root()?.attributes['gen_ai.completion.0.content']).toBe('Final');

    const [tool] = named('execute_tool ');
    expect(tool.attributes['gen_ai.tool.call.arguments']).toBe('{"q":"test"}');
    expect(tool.attributes['gen_ai.tool.call.result']).toBe('r');
  });

  it('exports no content anywhere by default', async () => {
    mockMessagesCreate.mockResolvedValueOnce(toolUseResponse()).mockResolvedValueOnce(finalResponse('Final'));

    await createClaudeMessagesHandler()(toolConfig as never, 'secret question', {
      myTool: vi.fn().mockReturnValue('secret result'),
    });

    // Every span, every attribute, every event — nothing the user or the model said may appear.
    const everything = JSON.stringify(spans().map((s) => [s.attributes, s.events]));
    expect(everything).not.toContain('secret');
    expect(everything).not.toContain('gen_ai.input.messages');
    expect(everything).not.toContain('gen_ai.content.prompt');
  });

  it('ends and parents both spans when the provider call throws', async () => {
    mockMessagesCreate.mockRejectedValue(new Error('provider down'));

    await expect(createClaudeMessagesHandler()(baseConfig as never, 'q')).rejects.toThrow('provider down');

    // The exporter only receives ended spans, so seeing both proves neither was orphaned.
    const [chat] = named('chat');
    expect(root()).toBeDefined();
    expect(chat?.parentSpanContext?.spanId).toBe(root()?.spanContext().spanId);
  });

  // The turns that completed were billed. The accumulator is owned by the caller that holds the root
  // span rather than by the tool loop, precisely so a loop that throws does not take the spend with
  // it — the root is the only span a config-scoped cost query can read it from.
  it('reports the completed turns token spend on the root when a later turn throws', async () => {
    mockMessagesCreate
      .mockResolvedValueOnce(toolUseResponse())
      .mockRejectedValueOnce(new Error('provider down mid-loop'));

    await expect(
      createClaudeMessagesHandler()(toolConfig as never, 'q', { myTool: vi.fn().mockReturnValue('r') }),
    ).rejects.toThrow('provider down mid-loop');

    const attrs = root()?.attributes ?? {};
    expect(attrs['gen_ai.usage.input_tokens']).toBe(5);
    expect(attrs['gen_ai.usage.output_tokens']).toBe(2);
    expect(root()?.status.code).toBe(2); // still ERROR
  });

  // Zeros would assert the run cost nothing; an absent attribute says "unknown".
  it('writes no token attributes on the root when no turn ever completed', async () => {
    mockMessagesCreate.mockRejectedValue(new Error('provider down'));

    await expect(createClaudeMessagesHandler()(baseConfig as never, 'q')).rejects.toThrow('provider down');

    expect(root()?.attributes['gen_ai.usage.input_tokens']).toBeUndefined();
  });
});
