import { context, type Span, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HandlerStreamEvent, ProviderHandler } from '../types.js';

const { mockTrack } = vi.hoisted(() => ({ mockTrack: vi.fn() }));

vi.mock('../lifecycle.js', () => ({
  extractVariation: vi.fn(),
  initClient: vi.fn().mockResolvedValue(undefined),
  getClient: vi.fn().mockReturnValue({ track: mockTrack }),
  shutdown: vi.fn(),
  waitForTelemetry: vi.fn(),
  shutdownTelemetry: vi.fn(),
}));

vi.mock('../judges.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../judges.js')>();
  return { ...actual, runJudges: vi.fn().mockResolvedValue({}) };
});

import { config } from '../client.js';
import { ConversationIdSpanProcessor, GEN_AI_CONVERSATION_ID, withConversationId } from '../conversation.js';
import { extractVariation, getClient } from '../lifecycle.js';

const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({
  spanProcessors: [new ConversationIdSpanProcessor(), new SimpleSpanProcessor(exporter)],
});
const tracer = provider.getTracer('@launchdarkly/ai-server');
const contextManager = new AsyncLocalStorageContextManager();

const mockContext = { kind: 'user' as const, key: 'user-1' };
const mockConfig = { model: { name: 'gpt-4o' }, provider: { name: 'OpenAI' }, instructions: 'You are helpful.' };
const mockMeta = { enabled: true, variationKey: 'v1', version: 1, mode: 'messages' as const };

/**
 * Mirrors what a real streaming handler does: opens `invoke_agent` when the generator body first
 * runs and a `chat` child as chunks arrive. Span creation therefore happens on `next()`, not at
 * `stream()` call time — which is exactly where a call-time-only binding is lost.
 */
function makeSpanCreatingStreamHandler(chunks: string[] = ['hello', ' world']): ProviderHandler {
  const usage = { input_tokens: 10, output_tokens: 5 };
  const h: ProviderHandler = vi.fn().mockResolvedValue({ output: chunks.join(''), usage });
  h.providesFor = ['OpenAI', 'messages'];
  h.stream = vi.fn().mockImplementation(async function* (): AsyncGenerator<HandlerStreamEvent> {
    const root = tracer.startSpan('invoke_agent');
    for (const text of chunks) {
      const chat = tracer.startSpan('chat gpt-4o', undefined, trace.setSpan(context.active(), root));
      chat.end();
      yield { type: 'chunk', text };
    }
    root.end();
    yield { type: 'done', usage };
  });
  return h;
}

async function drain<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const events: T[] = [];
  for await (const event of gen) events.push(event);
  return events;
}

const finished = () => exporter.getFinishedSpans();
const idsOn = (names: string[]) =>
  finished()
    .filter((s) => names.some((n) => s.name.startsWith(n)))
    .map((s) => s.attributes[GEN_AI_CONVERSATION_ID]);

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
  vi.clearAllMocks();
  mockTrack.mockReset();
  (extractVariation as ReturnType<typeof vi.fn>).mockResolvedValue({ config: mockConfig, meta: mockMeta });
  (getClient as ReturnType<typeof vi.fn>).mockReturnValue({ track: mockTrack });
});

describe('withConversationId + config().stream()', () => {
  it('stamps the id when the generator is built in the scope but iterated outside it', async () => {
    const handler = makeSpanCreatingStreamHandler();

    // The natural shape for a chat app: bind, hand the generator to the transport, iterate later.
    const gen = withConversationId('thread-123', () => config({ key: 'flag', handler }).stream('q', mockContext));
    await drain(gen);

    const ids = idsOn(['invoke_agent', 'chat']);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.every((id) => id === 'thread-123')).toBe(true);
  });

  it('stamps the id when the generator is iterated inside the scope', async () => {
    const handler = makeSpanCreatingStreamHandler();

    await withConversationId('thread-inside', async () => {
      await drain(config({ key: 'flag', handler }).stream('q', mockContext));
    });

    const ids = idsOn(['invoke_agent', 'chat']);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.every((id) => id === 'thread-inside')).toBe(true);
  });

  it('leaves span parenting unchanged when no id is bound', async () => {
    const handler = makeSpanCreatingStreamHandler(['only']);

    const caller = tracer.startSpan('caller');
    await context.with(trace.setSpan(context.active(), caller), async () => {
      await drain(config({ key: 'flag', handler }).stream('q', mockContext));
    });
    caller.end();

    const root = finished().find((s) => s.name === 'invoke_agent');
    const callerSpan = finished().find((s) => s.name === 'caller');
    expect(root?.parentSpanContext?.spanId).toBe(callerSpan?.spanContext().spanId);
    expect(root?.attributes[GEN_AI_CONVERSATION_ID]).toBeUndefined();
  });

  it('leaves span parenting unchanged when an id IS bound', async () => {
    // The unbound test above cannot catch a regression in the wrapper — `bindConversationId`
    // returns the generator untouched when nothing is bound, so it never builds one.
    const handler = makeSpanCreatingStreamHandler(['only']);

    const caller = tracer.startSpan('caller');
    await context.with(trace.setSpan(context.active(), caller), async () => {
      const gen = withConversationId('thread-123', () => config({ key: 'flag', handler }).stream('q', mockContext));
      await drain(gen);
    });
    caller.end();

    const root = finished().find((s) => s.name === 'invoke_agent');
    const callerSpan = finished().find((s) => s.name === 'caller');
    expect(root?.parentSpanContext?.spanId).toBe(callerSpan?.spanContext().spanId);
    expect(root?.attributes[GEN_AI_CONVERSATION_ID]).toBe('thread-123');
  });

  it('keeps overlapping streams isolated to their own conversation id', async () => {
    const runStream = async (id: string) => {
      const gen = withConversationId(id, () =>
        config({ key: 'flag', handler: makeSpanCreatingStreamHandler([id]) }).stream('q', mockContext),
      );
      await drain(gen);
    };

    await Promise.all([runStream('tenant-a'), runStream('tenant-b')]);

    const roots = finished().filter((s) => s.name === 'invoke_agent');
    expect(roots).toHaveLength(2);
    const seen = roots.map((s) => s.attributes[GEN_AI_CONVERSATION_ID]).sort();
    expect(seen).toEqual(['tenant-a', 'tenant-b']);

    // Every span in a trace carries that trace's id and no other.
    for (const root of roots) {
      const id = root.attributes[GEN_AI_CONVERSATION_ID];
      const sameTrace = finished().filter((s) => s.spanContext().traceId === root.spanContext().traceId);
      expect(sameTrace.every((s) => s.attributes[GEN_AI_CONVERSATION_ID] === id)).toBe(true);
    }
  });
});

describe('withConversationId + concurrent non-streaming work', () => {
  it('keeps two overlapping scopes isolated', async () => {
    const oneRun = async (id: string) => {
      await withConversationId(id, async () => {
        const span: Span = tracer.startSpan(`${id}:invoke_agent`);
        await new Promise((r) => setTimeout(r, 5));
        span.end();
      });
    };

    await Promise.all([oneRun('tenant-a'), oneRun('tenant-b')]);

    const byName = Object.fromEntries(finished().map((s) => [s.name, s.attributes[GEN_AI_CONVERSATION_ID]]));
    expect(byName['tenant-a:invoke_agent']).toBe('tenant-a');
    expect(byName['tenant-b:invoke_agent']).toBe('tenant-b');
  });
});
