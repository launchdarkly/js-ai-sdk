import { ConversationIdSpanProcessor, NATIVE_TOOL_KEY, NativeTool, withConversationId } from '@launchdarkly/ai-server';
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
 * Parentage matters more in this handler than in the messages handlers. The agent SDK owns the
 * loop, so `chat` spans are opened and closed from message-stream branches and `execute_tool` spans
 * from `PreToolUse`/`PostToolUse` hooks the SDK invokes — not from a lexical block we control. The
 * fake `query` below reproduces the SDK's message and hook sequence; that ordering is the same
 * assumption `handler.test.ts` already makes.
 *
 * The `AsyncLocalStorageContextManager` is not incidental. The non-streaming path derives its parent
 * from `context.active()` inside `startActiveSpan`, which only carries the root span while a context
 * manager is registered — `client/src/lifecycle.ts` registers exactly this one, so this setup
 * mirrors production. Without it the tree silently flattens into unrelated root spans. The streaming
 * path builds its parent with an explicit `trace.setSpan` and is unaffected either way.
 */

const mockQuery = vi.fn();

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (...args: any[]) => mockQuery(...args),
  tool: vi.fn().mockReturnValue({}),
  createSdkMcpServer: vi.fn().mockReturnValue({}),
}));

import { createClaudeAgentsHandler } from '../handler.js';

const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({
  spanProcessors: [new ConversationIdSpanProcessor(), new SimpleSpanProcessor(exporter)],
});
const contextManager = new AsyncLocalStorageContextManager();

const baseConfig = {
  model: { name: 'claude-opus-4-5' },
  provider: { name: 'Anthropic' },
  instructions: 'You are helpful.',
};

const toolConfig = {
  ...baseConfig,
  tools: { search: { name: 'search', type: 'function' as const, parameters: { type: 'object', properties: {} } } },
};

// `request_id` and `session_id` on the wrapper and `usage`/`stop_reason`/`model` inside are real
// fields of SDKAssistantMessage. `request_id` identifies the API call — several messages can share
// one, because the CLI emits one message per content block of a single response.
const assistantMessage = (inputTokens = 10, outputTokens = 2, requestId = 'req_1', content: unknown[] = []) => ({
  type: 'assistant',
  session_id: 'sess-1',
  request_id: requestId,
  message: {
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    content,
    model: 'claude-opus-4-5',
    stop_reason: 'end_turn',
  },
});

/** A response delivered as N content blocks: same `request_id`, same usage bag, repeated. */
const responseBlocks = (requestId: string, blocks: unknown[][], inputTokens = 10, outputTokens = 2) =>
  blocks.map((content) => assistantMessage(inputTokens, outputTokens, requestId, content));

// `type` and `subtype` are the real discriminants: SDKResultError shares `type: 'result'` and has
// no `result` field at all, which is why the handler branches on them rather than on key presence.
const resultMessage = (result = 'agent output') => ({
  type: 'result' as const,
  subtype: 'success' as const,
  result,
  usage: { input_tokens: 22, output_tokens: 5 },
});

const errorResultMessage = () => ({
  type: 'result' as const,
  subtype: 'error_max_turns' as const,
  is_error: true,
  errors: ['turn limit reached'],
  usage: { input_tokens: 40000, output_tokens: 500 },
});

/**
 * Replays the SDK's PreToolUse → PostToolUse sequence for one tool call.
 *
 * `PostToolBatch` is deliberately not replayed: this handler does not register it. Turn boundaries
 * come from the message stream, so a hook is not needed to find them.
 */
async function fireToolHooks(hooks: any, toolUseId = 'tool-1', toolName = 'mcp__tool-mcp__search') {
  const input = { tool_name: toolName, tool_use_id: toolUseId, tool_input: { query: 'x' }, session_id: 'sess-1' };
  await hooks.PreToolUse[0].hooks[0]({ hook_event_name: 'PreToolUse', ...input });
  await hooks.PostToolUse[0].hooks[0]({ hook_event_name: 'PostToolUse', ...input, tool_response: { ok: true } });
}

const initMessage = (sessionId = 'sess-1', tools?: string[]) => ({
  type: 'system' as const,
  subtype: 'init' as const,
  session_id: sessionId,
  ...(tools ? { tools } : {}),
});

/**
 * The turn the CLI sends the model next: tool results, and any context it injected itself.
 *
 * A real `SDKUserMessage` carries Anthropic's own `MessageParam` in `message`, which is why the
 * handler reads `message.message.content` rather than a field of its own.
 */
const toolResultMessage = (toolUseId = 'tu-1', content = 'found it') => ({
  type: 'user' as const,
  session_id: 'sess-1',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content }] },
});

// What the CLI emits while a call is in flight. Measured against Agent SDK 0.3.220: a burst of
// these arrives during every call, the last in the same millisecond as the response.
const thinkingTokens = () => ({ type: 'system' as const, subtype: 'thinking_tokens' as const });

const collectStream = async (gen: AsyncGenerator<unknown>) => {
  const out: unknown[] = [];
  for await (const e of gen) out.push(e);
  return out;
};

const spans = () => exporter.getFinishedSpans();
const named = (prefix: string) => spans().filter((s) => s.name.startsWith(prefix));
const root = () => spans().find((s) => s.name === 'invoke_agent');

/** An OTel `HrTime` pair as milliseconds. */
const ms = (hrtime: readonly [number, number]) => hrtime[0] * 1e3 + hrtime[1] / 1e6;

/**
 * The tolerance every timing assertion below is written against.
 *
 * A span's timestamps come from `Date.now()` anchored to `performance.now()`, and drift between
 * those two clocks makes a `setTimeout(n)` legitimately measure a little under `n` — CI failed on
 * `>= 40` for a 40ms delay. Asserting the exact delay therefore tests the runtime's clocks, not the
 * handler. Half is the margin used instead: the bugs these tests pin collapse a window to near zero
 * or stretch it across an entire extra call, so half a delay still separates pass from fail by tens
 * of milliseconds in both directions.
 */
const atLeastHalf = (delayMs: number) => delayMs / 2;

describe('claude-agents span tree against a real tracer', () => {
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

  // One `chat` span per assistant message, because one assistant message is one model response —
  // the SDK gives each its own `request_id`. The span vocabulary has to be the same three names
  // the other five handlers emit. A regression that reintroduces the CLI's own `claude_code.*`
  // spans, which sit outside the semantic conventions, shows up here as extra names.
  it('emits one chat span per model response', async () => {
    mockQuery.mockImplementation(async function* () {
      yield assistantMessage();
      yield resultMessage();
    });

    await createClaudeAgentsHandler()(baseConfig as never, 'q');

    expect(spans().map((s) => s.name)).toEqual(['chat claude-opus-4-5', 'invoke_agent']);
    const [chat] = named('chat');
    expect(chat.attributes['gen_ai.operation.name']).toBe('chat');
    expect(chat.attributes['gen_ai.response.id']).toBe('req_1');
    expect(chat.attributes['gen_ai.conversation.id']).toBe('sess-1');
  });

  it('emits only invoke_agent, chat and execute_tool across a multi-turn agent loop', async () => {
    mockQuery.mockImplementation(async function* ({ options }: any) {
      yield assistantMessage(10, 2, 'req_1');
      await fireToolHooks(options.hooks, 'tool-1');
      yield assistantMessage(12, 3, 'req_2');
      await fireToolHooks(options.hooks, 'tool-2');
      yield assistantMessage(14, 4, 'req_3');
      yield resultMessage('done');
    });

    await createClaudeAgentsHandler()(toolConfig as never, 'q', { search: vi.fn().mockReturnValue('r') });

    // Three model responses and two tool calls, so three `chat` spans and two `execute_tool`
    // spans: each count tracks what actually happened rather than a fixed shape.
    expect(
      spans()
        .map((s) => s.name)
        .sort(),
    ).toEqual([
      'chat claude-opus-4-5',
      'chat claude-opus-4-5',
      'chat claude-opus-4-5',
      'execute_tool search',
      'execute_tool search',
      'invoke_agent',
    ]);
  });

  // The bug this pins: the CLI splits one API response across several assistant messages, one per
  // content block. Emitting a span per message produced 55 spans for 22 real calls on a live 8-turn
  // run, and reported each call's tokens two to four times over. `request_id` is the unit.
  it('emits one chat span per API call, not per assistant message', async () => {
    mockQuery.mockImplementation(async function* () {
      for (const m of responseBlocks(
        'req_shared',
        [
          [{ type: 'thinking', thinking: 'let me look' }],
          [{ type: 'tool_use', id: 'tu-1', name: 'search', input: { q: 'x' } }],
        ],
        23669,
        8,
      )) {
        yield m;
      }
      yield resultMessage('done');
    });

    await createClaudeAgentsHandler({ captureContent: true })(baseConfig as never, 'q');

    const chats = named('chat');
    expect(chats).toHaveLength(1);
    // Written once, from the first block. Both messages carry the same bag, so adding it per
    // message would report 47,338 input tokens for a 23,669-token call.
    expect(chats[0].attributes['gen_ai.usage.input_tokens']).toBe(23669);
    expect(chats[0].attributes['gen_ai.response.id']).toBe('req_shared');

    // Both blocks survive on the one span; folding them must not drop the reasoning.
    const [output] = JSON.parse(String(chats[0].attributes['gen_ai.output.messages']));
    expect(output.parts.map((part: { type: string }) => part.type)).toEqual(['reasoning', 'tool_call']);
  });

  // The second live timing failure. Progress messages arrive *during* a call, so treating them as
  // boundaries collapsed the window to the gap between the last one and the response — a live
  // 4-call run reported 34ms, 2ms, 6ms and 3ms for calls that really took seconds.
  it('measures a call from the last local work, not from the progress messages during it', async () => {
    mockQuery.mockImplementation(async function* () {
      yield initMessage('sess-1');
      // 60ms of real call time, reported on only by progress messages.
      for (let i = 0; i < 3; i++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        yield thinkingTokens();
      }
      yield assistantMessage(10, 2, 'req_1');
      yield resultMessage('done');
    });

    await createClaudeAgentsHandler()(baseConfig as never, 'q');

    const [chat] = named('chat');
    // Collapsing to the last progress message would report the gap after it — single-digit ms.
    expect(ms(chat.duration)).toBeGreaterThanOrEqual(atLeastHalf(60));
  });

  // A `user` message carries the tool results the next call is sent, so it *is* a boundary — the
  // window for the following call must start there and not before.
  it('starts a call at the user message carrying the previous tool results', async () => {
    mockQuery.mockImplementation(async function* ({ options }: any) {
      yield initMessage('sess-1');
      yield assistantMessage(10, 2, 'req_1', [{ type: 'tool_use', id: 'tu-1', name: 'search', input: {} }]);
      await fireToolHooks(options.hooks, 'tool-1');
      await new Promise((resolve) => setTimeout(resolve, 50));
      yield { type: 'user', message: { content: [] } };
      yield thinkingTokens();
      yield assistantMessage(12, 3, 'req_2');
      yield resultMessage('done');
    });

    await createClaudeAgentsHandler()(toolConfig as never, 'q', { search: vi.fn().mockReturnValue('r') });

    const second = named('chat')[1];
    // The 50ms of tool time preceded the `user` message, so it is outside this call.
    expect(ms(second.duration)).toBeLessThan(50);
  });

  // The live failure this pins. One API response holds several tool_use blocks; the CLI dispatches
  // them one at a time, so its messages are separated in the stream by the tool executions they
  // triggered. Grouping only while messages are adjacent still produced 38 spans for 30 real calls.
  it('folds one response messages together even when tool calls separate them', async () => {
    mockQuery.mockImplementation(async function* ({ options }: any) {
      yield assistantMessage(23669, 8, 'req_shared', [{ type: 'thinking', thinking: 'plan' }]);
      yield assistantMessage(23669, 8, 'req_shared', [{ type: 'tool_use', id: 'tu-1', name: 'search', input: {} }]);
      await fireToolHooks(options.hooks, 'tool-1');
      yield { type: 'user', message: { content: [] } };
      // Same API call, third block, arriving after a tool ran.
      yield assistantMessage(23669, 8, 'req_shared', [{ type: 'tool_use', id: 'tu-2', name: 'search', input: {} }]);
      await fireToolHooks(options.hooks, 'tool-2');
      yield resultMessage('done');
    });

    await createClaudeAgentsHandler({ captureContent: true })(toolConfig as never, 'q', {
      search: vi.fn().mockReturnValue('r'),
    });

    const chats = named('chat');
    expect(chats).toHaveLength(1);
    expect(chats[0].attributes['gen_ai.usage.input_tokens']).toBe(23669);
    // All three blocks on the one span, in arrival order.
    const [output] = JSON.parse(String(chats[0].attributes['gen_ai.output.messages']));
    expect(output.parts.map((part: { type: string }) => part.type)).toEqual(['reasoning', 'tool_call', 'tool_call']);
  });

  // The response arrived complete at the first message; the CLI was already holding every block.
  // Ending the span at the LAST message would put the tool executions between them inside the call.
  it('ends a response at its first message, excluding the tool time that follows', async () => {
    mockQuery.mockImplementation(async function* ({ options }: any) {
      yield assistantMessage(10, 2, 'req_shared', [{ type: 'tool_use', id: 'tu-1', name: 'search', input: {} }]);
      await fireToolHooks(options.hooks, 'tool-1');
      await new Promise((resolve) => setTimeout(resolve, 50));
      yield assistantMessage(10, 2, 'req_shared', [{ type: 'tool_use', id: 'tu-2', name: 'search', input: {} }]);
      yield resultMessage('done');
    });

    await createClaudeAgentsHandler()(toolConfig as never, 'q', { search: vi.fn().mockReturnValue('r') });

    const [chat] = named('chat');
    expect(ms(chat.duration)).toBeLessThan(50);
  });

  // Two calls in a row with nothing between them: the second's window opens where the first closed,
  // so the two neither overlap nor double-count the first call's time. The 60ms before the first
  // response is what makes this observable — reusing the run's original boundary for the second
  // span would stretch it across both calls.
  it('starts a back-to-back response where the previous one ended', async () => {
    mockQuery.mockImplementation(async function* () {
      await new Promise((resolve) => setTimeout(resolve, 60));
      yield assistantMessage(10, 2, 'req_1');
      await new Promise((resolve) => setTimeout(resolve, 40));
      yield assistantMessage(12, 3, 'req_2');
      yield resultMessage('done');
    });

    await createClaudeAgentsHandler()(baseConfig as never, 'q');

    const [first, second] = named('chat');

    // The first call owns its 60ms; the second owns the 40ms that followed, and not the 60.
    expect(ms(first.duration)).toBeGreaterThanOrEqual(atLeastHalf(60));
    expect(ms(second.duration)).toBeGreaterThanOrEqual(atLeastHalf(40));
    // Reusing the run's original boundary would stretch the second span across both calls — 100ms.
    // The bound sits between the two so neither a slow runner nor the bug lands on the wrong side.
    expect(ms(second.duration)).toBeLessThan(70);

    // And they abut rather than overlap.
    const endOfFirst = ms(first.startTime) + ms(first.duration);
    expect(ms(second.startTime)).toBeGreaterThanOrEqual(endOfFirst - 1);
  });

  // A run that throws mid-response leaves a span open. The exporter only receives ended spans, so
  // without the cleanup the call would be missing from the trace entirely.
  it('ends a chat span left open when the run throws', async () => {
    mockQuery.mockImplementation(async function* () {
      yield assistantMessage(10, 2, 'req_1');
      throw new Error('transport died');
    });

    await expect(createClaudeAgentsHandler()(baseConfig as never, 'q')).rejects.toThrow('transport died');

    expect(named('chat')).toHaveLength(1);
  });

  // Without a request_id there is nothing to group on, so each message stands alone rather than
  // being silently merged into an unrelated call.
  it('falls back to one span per message when the SDK reports no request id', async () => {
    mockQuery.mockImplementation(async function* () {
      yield { type: 'assistant', session_id: 'sess-1', message: { usage: {}, content: [], model: 'claude-opus-4-5' } };
      yield { type: 'assistant', session_id: 'sess-1', message: { usage: {}, content: [], model: 'claude-opus-4-5' } };
      yield resultMessage('done');
    });

    await createClaudeAgentsHandler()(baseConfig as never, 'q');

    expect(named('chat')).toHaveLength(2);
  });

  // Per response, not per run. Copying the run total onto every child would be worse than
  // emitting nothing: it would multiply the run's reported cost by the number of turns.
  it('carries each response own usage and finish reason on its own chat span', async () => {
    mockQuery.mockImplementation(async function* () {
      yield assistantMessage(10, 2, 'req_1');
      yield assistantMessage(12, 3, 'req_2');
      yield resultMessage('done');
    });

    await createClaudeAgentsHandler()(baseConfig as never, 'q');

    const chats = named('chat');
    expect(chats.map((s) => s.attributes['gen_ai.usage.input_tokens'])).toEqual([10, 12]);
    expect(chats.map((s) => s.attributes['gen_ai.usage.output_tokens'])).toEqual([2, 3]);
    // Anthropic's `end_turn`, mapped onto the semconv vocabulary so this span groups with the
    // openai and langchain handlers' spans rather than beside them.
    expect(chats[0].attributes['gen_ai.response.finish_reasons']).toEqual(['stop']);
    // The root still reports the run's cumulative usage from the result message.
    expect(root()?.attributes['gen_ai.usage.input_tokens']).toBe(22);
  });

  // A `chat` span must not bill tool time as model time. The window starts at the message that
  // preceded the response, so anything between the previous response and the tool result falls
  // outside it.
  it('excludes tool execution time from the chat span window', async () => {
    mockQuery.mockImplementation(async function* ({ options }: any) {
      yield assistantMessage(10, 2, 'req_1');
      await fireToolHooks(options.hooks, 'tool-1');
      await new Promise((resolve) => setTimeout(resolve, 40));
      yield { type: 'user', message: { content: [] } };
      yield assistantMessage(12, 3, 'req_2');
      yield resultMessage('done');
    });

    await createClaudeAgentsHandler()(toolConfig as never, 'q', { search: vi.fn().mockReturnValue('r') });

    const second = named('chat')[1];
    const durationMs = second.duration[0] * 1e3 + second.duration[1] / 1e6;
    expect(durationMs).toBeLessThan(40);
  });

  it('nests every hook-driven execute_tool span directly under the root', async () => {
    mockQuery.mockImplementation(async function* ({ options }: any) {
      yield assistantMessage();
      await fireToolHooks(options.hooks);
      yield resultMessage('done');
    });

    await createClaudeAgentsHandler()(toolConfig as never, 'q', { search: vi.fn().mockReturnValue('r') });

    const [tool] = named('execute_tool ');
    expect(tool).toBeDefined();
    expect(tool.parentSpanContext?.spanId).toBe(root()?.spanContext().spanId);

    const traceIds = new Set(spans().map((s) => s.spanContext().traceId));
    expect(traceIds.size).toBe(1);
  });

  // The streaming path shares the emitter, so a response delivered as an assistant message gets
  // its span there too. Partial `stream_event` deltas are not responses and must not open one.
  it('emits chat spans from the streaming path on assistant messages only', async () => {
    mockQuery.mockImplementation(async function* () {
      yield { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi' } } };
      yield assistantMessage();
      yield resultMessage('Hi');
    });

    await collectStream(createClaudeAgentsHandler().stream?.(baseConfig as never, 'q', {}, {}) as never);

    expect(spans().map((s) => s.name)).toEqual(['chat claude-opus-4-5', 'invoke_agent']);
  });

  // A streamed response arrives as many `stream_event` deltas followed by one assistant message.
  // Treating a delta as a boundary would restart the window on every chunk and report a span a few
  // milliseconds long for a call that took seconds.
  it('measures a streamed response from before its first delta, not its last', async () => {
    mockQuery.mockImplementation(async function* () {
      await new Promise((resolve) => setTimeout(resolve, 40));
      yield { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'H' } } };
      yield { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'i' } } };
      yield assistantMessage();
      yield resultMessage('Hi');
    });

    await collectStream(createClaudeAgentsHandler().stream?.(baseConfig as never, 'q', {}, {}) as never);

    const [chat] = named('chat');
    // Restarting on the last delta would report the sub-millisecond gap between the two deltas.
    expect(ms(chat.duration)).toBeGreaterThanOrEqual(atLeastHalf(40));
  });

  // `gen_ai.conversation.id` is the only key LaunchDarkly's trace view groups a multi-turn
  // conversation on, and it deliberately accepts no aliases. The CLI stamps its `session.id` on
  // every span it emits and ingest maps that to this key, so reading the same id off the `init`
  // message is what keeps one run from splitting into two conversations.
  it('stamps the CLI session id as gen_ai.conversation.id on the root and on tool spans', async () => {
    mockQuery.mockImplementation(async function* ({ options }: any) {
      yield initMessage('sess-abc');
      yield assistantMessage();
      await fireToolHooks(options.hooks, 'tool-1', 'mcp__tool-mcp__search');
      yield resultMessage('done');
    });

    await createClaudeAgentsHandler()(toolConfig as never, 'q', { search: vi.fn().mockReturnValue('r') });

    expect(root()?.attributes['gen_ai.conversation.id']).toBe('sess-abc');
    const [tool] = named('execute_tool ');
    expect(tool.attributes['gen_ai.conversation.id']).toBe('sess-1');
  });

  it('omits gen_ai.conversation.id when the SDK yields no init message', async () => {
    mockQuery.mockImplementation(async function* () {
      yield resultMessage();
    });

    await createClaudeAgentsHandler()(baseConfig as never, 'q');

    expect(root()?.attributes['gen_ai.conversation.id']).toBeUndefined();
  });

  it('keeps a caller-supplied conversation id instead of the CLI session id', async () => {
    mockQuery.mockImplementation(async function* ({ options }: any) {
      yield initMessage('sess-abc');
      yield assistantMessage();
      await fireToolHooks(options.hooks, 'tool-1', 'mcp__tool-mcp__search');
      yield resultMessage('done');
    });

    await withConversationId('thread-stable', () =>
      createClaudeAgentsHandler()(toolConfig as never, 'q', { search: vi.fn().mockReturnValue('r') }),
    );

    expect(root()?.attributes['gen_ai.conversation.id']).toBe('thread-stable');
    expect(named('chat')[0]?.attributes['gen_ai.conversation.id']).toBe('thread-stable');
    expect(named('execute_tool ')[0]?.attributes['gen_ai.conversation.id']).toBe('thread-stable');
  });

  // Each turn's content belongs to that turn's own `chat` span, and the root carries the final
  // answer — the same division the other five handlers use. The intermediate turn's tool calls
  // and reasoning blocks land on a span of their own rather than being folded into the root.
  it('puts each turn content on its own chat span and the final answer on the root', async () => {
    mockQuery.mockImplementation(async function* () {
      yield {
        type: 'assistant',
        message: {
          usage: { input_tokens: 10, output_tokens: 2 },
          content: [{ type: 'tool_use', id: 'tu-1', name: 'search', input: { query: 'x' } }],
          stop_reason: 'tool_use',
        },
      };
      yield {
        type: 'assistant',
        message: {
          usage: { input_tokens: 12, output_tokens: 3 },
          content: [{ type: 'text', text: 'final' }],
          stop_reason: 'end_turn',
        },
      };
      yield resultMessage('final');
    });

    await createClaudeAgentsHandler({ captureContent: true })(baseConfig as never, 'q');

    const [first, second] = named('chat').map((s) => JSON.parse(String(s.attributes['gen_ai.output.messages'])));
    expect(first[0].parts[0]).toMatchObject({ type: 'tool_call', name: 'search' });
    // snake_case in the canonical carrier, per the semantic conventions.
    expect(first[0].finish_reason).toBe('tool_calls');
    expect(second[0].parts[0]).toMatchObject({ type: 'text', content: 'final' });

    const output = JSON.parse(String(root()?.attributes['gen_ai.output.messages']));
    expect(output).toEqual([{ role: 'assistant', parts: [{ type: 'text', content: 'final' }] }]);
  });

  // A span that reports only the answer cannot be read on its own. The request the CLI assembled is
  // out of reach, but the conversation is not: every turn arrives on the message stream, so each
  // span can say which turns its own call was sent.
  it('gives each chat span the conversation as it stood when its response began', async () => {
    mockQuery.mockImplementation(async function* () {
      yield initMessage();
      yield assistantMessage(10, 2, 'req_1', [{ type: 'tool_use', id: 'tu-1', name: 'search', input: { q: 'x' } }]);
      yield toolResultMessage('tu-1', 'found it');
      yield assistantMessage(12, 3, 'req_2', [{ type: 'text', text: 'done' }]);
      yield resultMessage('done');
    });

    await createClaudeAgentsHandler({ captureContent: true })(baseConfig as never, 'q');

    const inputs = named('chat').map((s) => JSON.parse(String(s.attributes['gen_ai.input.messages'])));
    expect(inputs).toHaveLength(2);

    // The first call saw only the user's prompt.
    expect(inputs[0]).toEqual([{ role: 'user', parts: [{ type: 'text', content: 'q' }] }]);

    // The second saw the prompt, the first reply, and the tool result that came back. The growth is
    // the point: a bug that reuses one list for every span shows up as the first input holding all
    // three too.
    expect(inputs[1].map((message: any) => message.role)).toEqual(['user', 'assistant', 'user']);
    expect(inputs[1][1].parts[0]).toMatchObject({ type: 'tool_call', name: 'search' });
    expect(inputs[1][2].parts[0]).toMatchObject({ type: 'tool_call_response', id: 'tu-1' });
  });

  // Tool results used to be read only as a clock tick, so the model's own answer arrived on a span
  // while the question that produced it was discarded.
  it('carries the tool result into the next call input with its role intact', async () => {
    mockQuery.mockImplementation(async function* () {
      yield assistantMessage(10, 2, 'req_1', [{ type: 'tool_use', id: 'tu-9', name: 'search', input: {} }]);
      yield toolResultMessage('tu-9', 'the answer is 42');
      yield assistantMessage(12, 3, 'req_2', [{ type: 'text', text: 'ok' }]);
      yield resultMessage('ok');
    });

    await createClaudeAgentsHandler({ captureContent: true })(baseConfig as never, 'q');

    const second = JSON.parse(String(named('chat')[1].attributes['gen_ai.input.messages']));
    const toolTurn = second.find((message: any) => message.parts[0]?.type === 'tool_call_response');
    expect(toolTurn.role).toBe('user');
    // The block's payload, not the block: a reader wants the tool's answer, not its envelope.
    expect(toolTurn.parts[0]).toEqual({ type: 'tool_call_response', id: 'tu-9', result: 'the answer is 42' });
  });

  // The CLI holds a whole response before dispatching any of its blocks, so the call that followed
  // carried the complete assistant turn. A block still arriving on this side belonged to it all
  // along — freezing each turn at snapshot time would drop content the model demonstrably saw.
  it('reports a whole assistant turn in a later input even when its blocks arrive out of order', async () => {
    mockQuery.mockImplementation(async function* () {
      yield assistantMessage(10, 2, 'req_1', [{ type: 'text', text: 'first' }]);
      yield assistantMessage(12, 3, 'req_2', [{ type: 'text', text: 'second' }]);
      // A trailing block of the FIRST response, arriving after the second response began.
      yield assistantMessage(10, 2, 'req_1', [{ type: 'text', text: 'and also' }]);
      yield resultMessage('done');
    });

    await createClaudeAgentsHandler({ captureContent: true })(baseConfig as never, 'q');

    const second = JSON.parse(String(named('chat')[1].attributes['gen_ai.input.messages']));
    const assistantTurn = second.find((message: any) => message.role === 'assistant');
    expect(assistantTurn.parts.map((part: any) => part.content)).toEqual(['first', 'and also']);
  });

  // The CLI announces its own tools only at `init`, and only by name. Listing a name with no schema
  // says "this was offered, its schema is not ours to state"; omitting it hides a tool the model
  // could call. The root is rewritten so it cannot disagree with its own children.
  it('widens the tool catalog with the CLI native tools on both the root and the chat spans', async () => {
    mockQuery.mockImplementation(async function* () {
      yield initMessage('sess-1', ['Read', 'Bash', 'mcp__tool-mcp__search']);
      yield assistantMessage(10, 2, 'req_1', [{ type: 'text', text: 'hi' }]);
      yield resultMessage('hi');
    });

    await createClaudeAgentsHandler({ captureContent: true })(toolConfig as never, 'q');

    const onRoot = JSON.parse(String(root()?.attributes['gen_ai.tool.definitions']));
    const onChat = JSON.parse(String(named('chat')[0].attributes['gen_ai.tool.definitions']));
    expect(onChat).toEqual(onRoot);

    // `search` keeps the schema the AI Config gave it, and is not listed a second time under the
    // MCP name the CLI reports it by.
    expect(onRoot.map((tool: any) => tool.name)).toEqual(['search', 'Read', 'Bash']);
    expect(onRoot[0].parameters).toEqual({ type: 'object', properties: {} });
    expect(onRoot[1].parameters).toBeUndefined();
  });

  // A subagent's own model calls arrive on the parent's stream, interleaved with the main thread's.
  // Measured against Agent SDK 0.3.220: a `general-purpose` response landed between two main-thread
  // responses. One flat conversation would hand the main thread's later calls an input containing
  // turns from a conversation they were never part of.
  it('keeps a subagent conversation out of the main thread input', async () => {
    const task = 'toolu_task_1';
    mockQuery.mockImplementation(async function* () {
      yield initMessage();
      // Main thread asks for a subagent.
      yield {
        ...assistantMessage(10, 2, 'req_main1', [{ type: 'tool_use', id: task, name: 'Task', input: { q: 'go' } }]),
        parent_tool_use_id: null,
      };
      // The subagent's own turns, tagged with the Task call that spawned it.
      yield { ...toolResultMessage('sub-tool', 'subagent read a file'), parent_tool_use_id: task };
      yield {
        ...assistantMessage(30, 4, 'req_sub1', [{ type: 'text', text: 'subagent says alpha' }]),
        parent_tool_use_id: task,
        subagent_type: 'general-purpose',
      };
      // Back on the main thread: the Task tool's result.
      yield { ...toolResultMessage(task, 'alpha'), parent_tool_use_id: null };
      yield { ...assistantMessage(12, 3, 'req_main2', [{ type: 'text', text: 'done' }]), parent_tool_use_id: null };
      yield resultMessage('done');
    });

    await createClaudeAgentsHandler({ captureContent: true })(baseConfig as never, 'q');

    const byModel = new Map(named('chat').map((s) => [String(s.attributes['gen_ai.response.id']), s] as const));
    const inputOf = (requestId: string) =>
      JSON.parse(String(byModel.get(requestId)?.attributes['gen_ai.input.messages']));

    // The main thread's second call saw its own prompt, its own first reply, and the Task result —
    // and none of the subagent's turns.
    const main2 = inputOf('req_main2');
    expect(main2.map((message: any) => message.role)).toEqual(['user', 'assistant', 'user']);
    expect(JSON.stringify(main2)).not.toContain('subagent read a file');

    // The subagent's own call saw only its own conversation, not the run's opening prompt.
    const sub1 = inputOf('req_sub1');
    expect(sub1).toHaveLength(1);
    expect(sub1[0].parts[0]).toMatchObject({ type: 'tool_call_response', result: 'subagent read a file' });

    // Named, so a reader knows why that span's input does not chain onto the main thread's.
    expect(byModel.get('req_sub1')?.attributes['gen_ai.agent.name']).toBe('general-purpose');
    expect(byModel.get('req_main2')?.attributes['gen_ai.agent.name']).toBeUndefined();
  });

  // The run's system prompt and tool catalog belong to the run, not to an agent the CLI spawned
  // under its own definition and its own tool subset — neither of which this side is told.
  it('does not put the run system prompt or tool catalog on a subagent chat span', async () => {
    const task = 'toolu_task_2';
    mockQuery.mockImplementation(async function* () {
      yield initMessage('sess-1', ['Task', 'Read']);
      yield { ...assistantMessage(10, 2, 'req_m', [{ type: 'text', text: 'spawning' }]), parent_tool_use_id: null };
      yield {
        ...assistantMessage(30, 4, 'req_s', [{ type: 'text', text: 'sub' }]),
        parent_tool_use_id: task,
        subagent_type: 'general-purpose',
      };
      yield resultMessage('done');
    });

    await createClaudeAgentsHandler({ captureContent: true })(toolConfig as never, 'q');

    const span = (requestId: string) => named('chat').find((s) => s.attributes['gen_ai.response.id'] === requestId);
    expect(span('req_m')?.attributes['gen_ai.system_instructions']).toBeDefined();
    expect(span('req_m')?.attributes['gen_ai.tool.definitions']).toBeDefined();
    expect(span('req_s')?.attributes['gen_ai.system_instructions']).toBeUndefined();
    expect(span('req_s')?.attributes['gen_ai.tool.definitions']).toBeUndefined();
  });

  // A `NativeTool` binds an AI Config key to a provider tool with a name of its own. Catalogued
  // under the AI Config key it appeared twice: once with the config's schema, and once from `init`
  // without one — two entries describing one tool the model saw under a third name.
  it('catalogs a native AI Config tool once, under the name the model saw', async () => {
    const nativeStub = () => {};
    (nativeStub as any)[NATIVE_TOOL_KEY] = new NativeTool(Symbol('ws'), 'WebSearch');

    mockQuery.mockImplementation(async function* () {
      yield initMessage('sess-1', ['WebSearch', 'Read']);
      yield assistantMessage(10, 2, 'req_1', [{ type: 'text', text: 'hi' }]);
      yield resultMessage('hi');
    });

    const configWithNative = {
      ...baseConfig,
      tools: { webSearch: { name: 'webSearch', type: 'function' as const, description: 'search the web' } },
    };
    await createClaudeAgentsHandler({ captureContent: true })(configWithNative as never, 'q', {
      webSearch: nativeStub,
    });

    const catalog = JSON.parse(String(root()?.attributes['gen_ai.tool.definitions']));
    // `WebSearch` — the provider name, which is also what its `execute_tool` span carries — once.
    expect(catalog.map((tool: any) => tool.name)).toEqual(['WebSearch', 'Read']);
    // Under that name, still carrying what the AI Config declared about it.
    expect(catalog[0].description).toBe('search the web');
  });

  it('emits no input messages or tool definitions when content capture is off', async () => {
    mockQuery.mockImplementation(async function* () {
      yield initMessage('sess-1', ['Read']);
      yield assistantMessage(10, 2, 'req_1', [{ type: 'text', text: 'hi' }]);
      yield toolResultMessage();
      yield assistantMessage(12, 3, 'req_2', [{ type: 'text', text: 'bye' }]);
      yield resultMessage('bye');
    });

    await createClaudeAgentsHandler()(toolConfig as never, 'q');

    for (const span of [root(), ...named('chat')]) {
      expect(span?.attributes['gen_ai.input.messages']).toBeUndefined();
      expect(span?.attributes['gen_ai.tool.definitions']).toBeUndefined();
      expect(span?.attributes['gen_ai.system_instructions']).toBeUndefined();
    }
  });

  it('falls back to the result text when the run produced no assistant message', async () => {
    mockQuery.mockImplementation(async function* () {
      yield resultMessage('only-the-result');
    });

    await createClaudeAgentsHandler({ captureContent: true })(baseConfig as never, 'q');

    const output = JSON.parse(String(root()?.attributes['gen_ai.output.messages']));
    expect(output).toEqual([{ role: 'assistant', parts: [{ type: 'text', content: 'only-the-result' }] }]);
  });

  it('fails the run when the agent SDK reports an error result, keeping the real token spend', async () => {
    // `SDKResultError` carries no `result` field, so a key-presence gate never matched it: the loop
    // just ended and the run was reported OK with zeroed usage, discarding both the token spend and
    // the SDK's own error list.
    mockQuery.mockImplementation(async function* () {
      yield assistantMessage();
      yield errorResultMessage();
    });

    await expect(createClaudeAgentsHandler()(baseConfig as never, 'q')).rejects.toThrow(/error_max_turns/);

    const attrs = root()?.attributes ?? {};
    expect(root()?.status.code).toBe(2); // ERROR, not OK
    expect(attrs['gen_ai.usage.input_tokens']).toBe(40000); // the spend is still reported
    expect(attrs['gen_ai.usage.output_tokens']).toBe(500);
  });

  it('carries the run-level token totals on the invoke_agent root, not only on the children', async () => {
    mockQuery.mockImplementation(async function* () {
      yield assistantMessage();
      yield resultMessage('done');
    });

    await createClaudeAgentsHandler()(baseConfig as never, 'q');

    // The agent SDK reports usage cumulatively on the result message, which is what the root wants.
    // Writing that figure onto a per-turn chat span instead made the children sum above the run.
    const attrs = root()?.attributes ?? {};
    expect(attrs['gen_ai.usage.input_tokens']).toBe(22);
    expect(attrs['gen_ai.usage.output_tokens']).toBe(5);
    expect(attrs['gen_ai.provider.name']).toBe('anthropic');
  });

  it('ends and parents the open spans when the agent SDK throws mid-loop', async () => {
    mockQuery.mockImplementation(async function* ({ options }: any) {
      yield assistantMessage();
      await options.hooks.PreToolUse[0].hooks[0]({
        hook_event_name: 'PreToolUse',
        tool_name: 'mcp__tool-mcp__search',
        tool_use_id: 'tool-1',
        tool_input: {},
      });
      throw new Error('agent crashed');
    });

    await expect(
      createClaudeAgentsHandler()(toolConfig as never, 'q', { search: vi.fn().mockReturnValue('r') }),
    ).rejects.toThrow('agent crashed');

    // The exporter only receives ended spans, so the tool span appearing here is `closeOpenSpans`
    // doing its job — and it still has to be attached to the root to be findable.
    const rootId = root()?.spanContext().spanId;
    const [tool] = named('execute_tool ');
    expect(rootId).toBeDefined();
    expect(tool?.parentSpanContext?.spanId).toBe(rootId);
  });

  /**
   * The `result` message is the only place the CLI reports a run-level total, and it never arrives
   * when `query()` throws. The per-response sum is then the sole record of what the run spent, and
   * the root — the only span carrying `launchdarkly.config.key` — has to report it.
   *
   * Two responses with distinct `request_id`s, so this also pins that the sum is per *response*: the
   * usage bag a multi-block response repeats on every message must not be counted more than once.
   */
  it('reports the responses that did arrive on the root when the agent SDK throws', async () => {
    mockQuery.mockImplementation(async function* () {
      yield assistantMessage(100, 20, 'req_1');
      yield assistantMessage(100, 20, 'req_1', [{ type: 'thinking', thinking: 'same call, second block' }]);
      yield assistantMessage(200, 30, 'req_2');
      throw new Error('transport died');
    });

    await expect(createClaudeAgentsHandler()(baseConfig as never, 'q')).rejects.toThrow('transport died');

    const attrs = root()?.attributes ?? {};
    expect(attrs['gen_ai.usage.input_tokens']).toBe(300); // 100 + 200, not 100 + 100 + 200
    expect(attrs['gen_ai.usage.output_tokens']).toBe(50);
    expect(root()?.status.code).toBe(2); // still ERROR
  });

  // Zeros would assert the run cost nothing, which a run that died before its first response cannot
  // claim. An absent attribute says "unknown" instead.
  it('writes no token attributes on the root when no response ever arrived', async () => {
    mockQuery.mockImplementation(async function* () {
      throw new Error('spawn failed');
      // biome-ignore lint/correctness/noUnreachable: the generator must still be an async generator
      yield assistantMessage();
    });

    await expect(createClaudeAgentsHandler()(baseConfig as never, 'q')).rejects.toThrow('spawn failed');

    expect(root()?.attributes['gen_ai.usage.input_tokens']).toBeUndefined();
  });

  // The run ended without a `result` message, so nothing carried a run-level total. This path used
  // to write a local that was never incremented, so it always claimed zero tokens for calls that
  // really happened.
  it('reports the per-response sum when the stream ends with no result message', async () => {
    mockQuery.mockImplementation(async function* () {
      yield assistantMessage(100, 20, 'req_1');
      yield assistantMessage(200, 30, 'req_2');
    });

    const result = await createClaudeAgentsHandler()(baseConfig as never, 'q');

    const attrs = root()?.attributes ?? {};
    expect(attrs['gen_ai.usage.input_tokens']).toBe(300);
    expect(attrs['gen_ai.usage.output_tokens']).toBe(50);
    // And the same figure is what the caller is told it spent.
    expect(result.usage).toMatchObject({ input_tokens: 300, output_tokens: 50 });
  });

  it('puts context identity on the invoke_agent root and on no child span', async () => {
    mockQuery.mockImplementation(async function* ({ options }: any) {
      yield assistantMessage(10, 2, 'req_1');
      await fireToolHooks(options.hooks, 'tool-1');
      yield assistantMessage(12, 3, 'req_2');
      yield resultMessage('done');
    });

    await createClaudeAgentsHandler()(
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
