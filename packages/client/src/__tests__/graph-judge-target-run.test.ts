/**
 * In a graph, a judge's target is the run its metric event names: a per-node judge points at that
 * node's run, and the graph-level judge points at the graph run. Graph judge spans already nest
 * under `launchdarkly.graph`, but a shared trace does not say which run inside it a judge graded.
 *
 * Runs the real graph, judges and tracking code. Only the LaunchDarkly client is stubbed.
 */

import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockTrack, mockVariation, mockExtractVariation } = vi.hoisted(() => ({
  mockTrack: vi.fn(),
  mockVariation: vi.fn(),
  mockExtractVariation: vi.fn(),
}));

vi.mock('../lifecycle.js', () => ({
  getClient: () => ({ track: mockTrack, variation: mockVariation }),
  initClient: vi.fn().mockResolvedValue(undefined),
  extractVariation: mockExtractVariation,
  shutdown: vi.fn(),
  waitForTelemetry: vi.fn(),
  shutdownTelemetry: vi.fn(),
}));

import { ConversationIdSpanProcessor } from '../conversation.js';
import { graph } from '../graph.js';
import { LD_JUDGE_TARGET_CONFIG_KEY, LD_JUDGE_TARGET_RUN_ID, LD_JUDGE_TARGET_VARIATION_KEY } from '../judges.js';
import { resetSdkOptions } from '../sdk-options.js';
import type { ProviderHandler, TrackData } from '../types.js';
import { setLdSpanAttributes } from '../utils.js';

const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({
  spanProcessors: [new ConversationIdSpanProcessor(), new SimpleSpanProcessor(exporter)],
});
const contextManager = new AsyncLocalStorageContextManager();

beforeAll(() => {
  context.setGlobalContextManager(contextManager.enable());
  trace.setGlobalTracerProvider(provider);
});

afterAll(() => {
  trace.disable();
  context.disable();
});

const userContext = { kind: 'user' as const, key: 'alexis' };
const judgeKeys = new Set(['node-judge', 'graph-judge']);

const nodeConfig = (judge?: string) => ({
  model: { name: 'gpt-4o' },
  provider: { name: 'OpenAI' },
  instructions: 'You are an agent.',
  ...(judge ? { judgeConfiguration: { judges: [{ key: judge, samplingRate: 1 }] } } : {}),
});

const judgeConfig = (key: string) => ({
  model: { name: 'gpt-4o' },
  provider: { name: 'OpenAI' },
  instructions: 'You are a judge.',
  evaluationMetricKey: `$ld:ai:judge:${key}`,
});

/**
 * Opens an `invoke_agent` span the way a real handler does, with the LaunchDarkly attributes for
 * whichever run it is serving, so node runs and judge runs can be told apart by `launchdarkly.config.key`.
 */
const handler: ProviderHandler = vi.fn(async (_config, _input, _tools, variables) => {
  const span = trace.getTracer('@launchdarkly/ai-openai-messages').startSpan('invoke_agent');
  setLdSpanAttributes(span, variables);
  const configKey = (variables?.__ld as TrackData | undefined)?.configKey ?? '';
  span.end();
  return judgeKeys.has(configKey)
    ? { output: '{"score":0.9,"reasoning":"fine"}', usage: { input_tokens: 1, output_tokens: 1 } }
    : { output: 'answer', usage: { input_tokens: 2, output_tokens: 3 } };
}) as unknown as ProviderHandler;
handler.providesFor = ['OpenAI', 'messages'];

beforeEach(() => {
  resetSdkOptions();
  exporter.reset();
  mockTrack.mockReset();
  mockVariation.mockResolvedValue({
    root: 'root-node',
    edges: { 'root-node': [{ key: 'leaf-node' }] },
    _ldMeta: { variationKey: 'graph-v2', version: 2 },
  });
  mockExtractVariation.mockImplementation(async (key: string) => {
    const meta = (variationKey: string) => ({ enabled: true, variationKey, version: 1, mode: 'messages' });
    if (key === 'root-node') return { config: nodeConfig(), meta: meta('root-v1') };
    if (key === 'leaf-node') return { config: nodeConfig('node-judge'), meta: meta('leaf-v1') };
    if (judgeKeys.has(key)) return { config: judgeConfig(key), meta: meta('judge-v1') };
    throw new Error(`Unknown key: ${key}`);
  });
});

afterEach(() => resetSdkOptions());

const spansOf = (configKey: string) =>
  exporter.getFinishedSpans().filter((s) => s.attributes['launchdarkly.config.key'] === configKey);

const judgeEvent = (judgeKey: string) => {
  const call = mockTrack.mock.calls.find(([name]) => name === `$ld:ai:judge:${judgeKey}`);
  expect(call).toBeDefined();
  return call?.[2] as TrackData;
};

describe.each(['invoke', 'stream'] as const)('graph().%s() judge targets', (method) => {
  const run = async () => {
    const g = graph('graph-flag', { handlers: [handler], graphJudge: 'graph-judge' });
    if (method === 'invoke') {
      await g.invoke('hi', userContext);
    } else {
      for await (const _ of g.stream('hi', userContext)) {
        // drain
      }
    }
  };

  it("points a per-node judge at that node's run", async () => {
    await run();
    const [leafSpan] = spansOf('leaf-node');
    const judgeSpans = spansOf('node-judge');
    const event = judgeEvent('node-judge');

    expect(judgeSpans).toHaveLength(1);
    expect(event.runId).toBe(leafSpan.attributes['launchdarkly.run.id']);
    for (const span of judgeSpans) {
      expect(span.attributes[LD_JUDGE_TARGET_RUN_ID]).toBe(event.runId);
      expect(span.attributes[LD_JUDGE_TARGET_CONFIG_KEY]).toBe('leaf-node');
      expect(span.attributes[LD_JUDGE_TARGET_VARIATION_KEY]).toBe('leaf-v1');
    }
  });

  it('points the graph-level judge at the graph run', async () => {
    await run();
    const [graphSpan] = exporter.getFinishedSpans().filter((s) => s.name === 'launchdarkly.graph');
    const judgeSpans = spansOf('graph-judge');
    const event = judgeEvent('graph-judge');

    expect(judgeSpans).toHaveLength(1);
    expect(event.runId).toBe(graphSpan.attributes['launchdarkly.run.id']);
    for (const span of judgeSpans) {
      expect(span.attributes[LD_JUDGE_TARGET_RUN_ID]).toBe(graphSpan.attributes['launchdarkly.run.id']);
      expect(span.attributes[LD_JUDGE_TARGET_CONFIG_KEY]).toBe('graph-flag');
      expect(span.attributes[LD_JUDGE_TARGET_VARIATION_KEY]).toBe('graph-v2');
    }
  });

  it("leaves the nodes' own spans and the graph span without judge targets", async () => {
    await run();
    const notJudges = exporter
      .getFinishedSpans()
      .filter((s) => !judgeKeys.has(String(s.attributes['launchdarkly.config.key'])));
    expect(notJudges.length).toBeGreaterThanOrEqual(3);
    for (const span of notJudges) expect(span.attributes).not.toHaveProperty(LD_JUDGE_TARGET_RUN_ID);
  });
});
