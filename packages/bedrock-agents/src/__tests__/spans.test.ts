import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unlike `handler.test.ts`, this file does not mock `@opentelemetry/api`.
 *
 * A real tracer is required to observe whether in-flight chat/tool spans stay open after a
 * consumer `break`s the stream, and whether they are marked ERROR. The Strands SDK is still
 * mocked: `addHook` + `stream` fire Before* events without the matching After* so the handler
 * holds open child spans when the consumer stops.
 */

const { Agent, BeforeModelCallEvent, AfterModelCallEvent, BeforeToolCallEvent, AfterToolCallEvent, agentInstances } =
  vi.hoisted(() => {
    class BeforeModelCallEvent {}
    class AfterModelCallEvent {}
    class BeforeToolCallEvent {}
    class AfterToolCallEvent {}

    const agentInstances: Array<{ cancel: ReturnType<typeof vi.fn> }> = [];

    class Agent {
      messages: unknown[] = [];
      cancel = vi.fn();
      private hooks = new Map<unknown, Array<(event: unknown) => void>>();

      constructor() {
        agentInstances.push(this);
      }

      addHook(eventType: unknown, cb: (event: unknown) => void) {
        const list = this.hooks.get(eventType) ?? [];
        list.push(cb);
        this.hooks.set(eventType, list);
      }

      fire(eventType: unknown, event: unknown) {
        for (const cb of this.hooks.get(eventType) ?? []) cb(event);
      }

      invoke = vi.fn(async () => {
        this.fire(BeforeModelCallEvent, { agent: this });
        throw new Error('provider down');
      });

      async *stream() {
        this.fire(BeforeModelCallEvent, { agent: this });
        this.fire(BeforeToolCallEvent, {
          toolUse: { name: 'lookup', toolUseId: 'tool-1', input: { q: 1 } },
        });
        yield {
          type: 'modelStreamUpdateEvent',
          event: { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'one' } },
        };
        yield {
          type: 'modelStreamUpdateEvent',
          event: { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'two' } },
        };
        this.fire(AfterModelCallEvent, {
          agent: this,
          stopData: { message: { content: [{ text: 'one two' }] }, stopReason: 'endTurn' },
        });
        this.fire(AfterToolCallEvent, {
          toolUse: { name: 'lookup', toolUseId: 'tool-1' },
          result: 'ok',
        });
        yield {
          type: 'agentResultEvent',
          result: {
            lastMessage: { content: [{ text: 'one two' }] },
            metrics: { accumulatedUsage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } },
          },
        };
      }
    }

    return {
      Agent,
      BeforeModelCallEvent,
      AfterModelCallEvent,
      BeforeToolCallEvent,
      AfterToolCallEvent,
      agentInstances,
    };
  });

vi.mock('@strands-agents/sdk', () => ({
  Agent,
  BedrockModel: vi.fn(class {}),
  tool: vi.fn((definition) => definition),
  BeforeModelCallEvent,
  AfterModelCallEvent,
  BeforeToolCallEvent,
  AfterToolCallEvent,
}));

import { createBedrockAgentsHandler } from '../handler.js';

const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
const contextManager = new AsyncLocalStorageContextManager();

const baseConfig = {
  model: { name: 'anthropic.claude-sonnet-4-5', region: 'us' },
  provider: { name: 'Bedrock' },
  instructions: 'You are helpful.',
};

const spans = () => exporter.getFinishedSpans();
const named = (prefix: string) => spans().filter((s) => s.name.startsWith(prefix));
const root = () => spans().find((s) => s.name === 'invoke_agent');

describe('bedrock-agents span tree against a real tracer', () => {
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
    agentInstances.length = 0;
    exporter.reset();
  });

  it('ends every span when the consumer abandons the stream mid-flight', async () => {
    const gen = createBedrockAgentsHandler().stream?.(baseConfig as never, 'q', {}, {}) as AsyncGenerator<unknown>;
    for await (const _chunk of gen) break;

    const rootSpan = root();
    expect(rootSpan).toBeDefined();
    expect(rootSpan?.attributes['launchdarkly.stream.abandoned']).toBe(true);
    expect(rootSpan?.status.code).toBe(0); // UNSET

    const [chat] = named('chat');
    const [tool] = named('execute_tool');
    expect(chat).toBeDefined();
    expect(tool).toBeDefined();
    expect(chat.attributes['launchdarkly.stream.abandoned']).toBe(true);
    expect(tool.attributes['launchdarkly.stream.abandoned']).toBe(true);
    expect(chat.status.code).toBe(0);
    expect(tool.status.code).toBe(0);
    expect(agentInstances[0].cancel).toHaveBeenCalled();
  });

  it('marks open child spans ERROR when invoke throws', async () => {
    await expect(createBedrockAgentsHandler()(baseConfig as never, 'q')).rejects.toThrow('provider down');

    const [chat] = named('chat');
    expect(root()?.status.code).toBe(2); // ERROR
    expect(chat).toBeDefined();
    expect(chat.status.code).toBe(2);
    expect(chat.attributes['launchdarkly.stream.abandoned']).toBeUndefined();
  });
});
