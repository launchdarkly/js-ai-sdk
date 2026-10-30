/**
 * A judge runs after the graded handler has ended its span, so its spans start a trace of their
 * own. Every span of a judge's run carries the run id, config key and variation key of the run it
 * graded, so the two traces can be joined exactly instead of by timestamp.
 */

import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockExecuteAndTrack, mockExtractVariation } = vi.hoisted(() => ({
  mockExecuteAndTrack: vi.fn(),
  mockExtractVariation: vi.fn(),
}));

vi.mock('../tracking.js', () => ({ executeAndTrack: mockExecuteAndTrack }));

vi.mock('../lifecycle.js', () => ({
  extractVariation: mockExtractVariation,
  getClient: () => ({ track: vi.fn() }),
}));

import { ConversationIdSpanProcessor } from '../conversation.js';
import {
  LD_JUDGE_TARGET_CONFIG_KEY,
  LD_JUDGE_TARGET_RUN_ID,
  LD_JUDGE_TARGET_VARIATION_KEY,
  runJudge,
  runJudges,
} from '../judges.js';
import type { JudgeTask, ProviderHandler, TrackData } from '../types.js';

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

const gradedRun: TrackData = {
  runId: 'graded-run-id',
  configKey: 'pr-reviewer',
  variationKey: 'opus',
  version: 3,
  modelName: 'claude-opus-5-5',
  providerName: 'Anthropic',
};

const judgeConfig = {
  model: { name: 'claude-sonnet-5' },
  provider: { name: 'Anthropic' },
  instructions: 'You are a judge.',
  evaluationMetricKey: '$ld:ai:judge:no-nitpicks',
};
const judgeMeta = { enabled: true, variationKey: 'default', version: 1, mode: 'messages' as const };

const handler: ProviderHandler = vi.fn() as unknown as ProviderHandler;
handler.providesFor = ['Anthropic', 'messages'];

beforeEach(() => {
  exporter.reset();
  mockExtractVariation.mockResolvedValue({ config: judgeConfig, meta: judgeMeta });
  // Stands in for a judge handler: it opens the judge's invoke_agent and a chat span under it,
  // on an SDK tracer, after the graded run is over.
  mockExecuteAndTrack.mockImplementation(async () => {
    const tracer = trace.getTracer('@launchdarkly/ai-claude-messages');
    await tracer.startActiveSpan('invoke_agent', async (root) => {
      tracer.startSpan('chat').end();
      root.end();
    });
    return { usage: { input: 1, output: 1, total: 2 }, response: '{"score":1,"reasoning":"ok"}' };
  });
});

const expectEverySpanPointsAtTheGradedRun = () => {
  const spans = exporter.getFinishedSpans();
  expect(spans.map((s) => s.name).sort()).toEqual(['chat', 'invoke_agent']);
  for (const span of spans) {
    expect(span.attributes[LD_JUDGE_TARGET_RUN_ID]).toBe('graded-run-id');
    expect(span.attributes[LD_JUDGE_TARGET_CONFIG_KEY]).toBe('pr-reviewer');
    expect(span.attributes[LD_JUDGE_TARGET_VARIATION_KEY]).toBe('opus');
  }
};

describe('judge spans point at the run they graded', () => {
  it('stamps every span of an inline judge with the graded run', async () => {
    await runJudges({
      config: {
        ...judgeConfig,
        judgeConfiguration: { judges: [{ judgeConfigKey: 'no-nitpicks', samplingRate: 1 }] },
      },
      userContext: { kind: 'user', key: 'alexis' },
      handler,
      llmResponse: 'Verdict: approve',
      baseTrackData: gradedRun,
    });
    expectEverySpanPointsAtTheGradedRun();
  });

  it('stamps every span of a deferred judge with the graded run from the task', async () => {
    const task = {
      configKey: 'no-nitpicks',
      judgeConfig,
      judgeMeta,
      actualOutput: 'Verdict: approve',
      userContext: { kind: 'user', key: 'alexis' },
      judgeProvider: 'Anthropic',
      judgeMode: 'messages',
      collapseMessages: false,
      parentTrackData: gradedRun,
    } as unknown as JudgeTask;
    await runJudge(task, [handler]);
    expectEverySpanPointsAtTheGradedRun();
  });

  it('leaves spans outside a judge run alone', async () => {
    trace.getTracer('@launchdarkly/ai-claude-messages').startSpan('invoke_agent').end();
    const [span] = exporter.getFinishedSpans();
    expect(span.attributes[LD_JUDGE_TARGET_RUN_ID]).toBeUndefined();
  });
});

const runInline = (target: TrackData, judgeHandler: ProviderHandler = handler) =>
  runJudges({
    config: {
      ...judgeConfig,
      judgeConfiguration: { judges: [{ judgeConfigKey: 'no-nitpicks', samplingRate: 1 }] },
    },
    userContext: { kind: 'user', key: 'alexis' },
    handler: judgeHandler,
    llmResponse: 'Verdict: approve',
    baseTrackData: target,
  });

const runDeferred = (target: TrackData, judgeHandler: ProviderHandler = handler) =>
  runJudge(
    {
      configKey: 'no-nitpicks',
      judgeConfig,
      judgeMeta,
      actualOutput: 'Verdict: approve',
      userContext: { kind: 'user', key: 'alexis' },
      judgeProvider: 'Anthropic',
      judgeMode: 'messages',
      collapseMessages: false,
      parentTrackData: target,
    } as unknown as JudgeTask,
    [judgeHandler],
  );

const targetAttributes = (span: { attributes: Record<string, unknown> }) => ({
  runId: span.attributes[LD_JUDGE_TARGET_RUN_ID],
  configKey: span.attributes[LD_JUDGE_TARGET_CONFIG_KEY],
  variationKey: span.attributes[LD_JUDGE_TARGET_VARIATION_KEY],
});

describe.each([
  ['inline', runInline],
  ['deferred', runDeferred],
])('judge target attributes on the %s path', (_path, run) => {
  it('are written with content capture off, since they are identifiers', async () => {
    const captureOff: ProviderHandler = vi.fn() as unknown as ProviderHandler;
    captureOff.providesFor = ['Anthropic', 'messages'];
    captureOff.captureContent = false;
    await run(gradedRun, captureOff);
    expectEverySpanPointsAtTheGradedRun();
  });

  it('leave off an empty variation key and keep the other two', async () => {
    await run({ ...gradedRun, variationKey: '' });
    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(2);
    for (const span of spans) {
      expect(span.attributes).not.toHaveProperty(LD_JUDGE_TARGET_VARIATION_KEY);
      expect(span.attributes[LD_JUDGE_TARGET_RUN_ID]).toBe('graded-run-id');
      expect(span.attributes[LD_JUDGE_TARGET_CONFIG_KEY]).toBe('pr-reviewer');
    }
  });

  it('do not overwrite a value the span set for itself', async () => {
    mockExecuteAndTrack.mockImplementation(async () => {
      const tracer = trace.getTracer('@launchdarkly/ai-claude-messages');
      tracer.startSpan('invoke_agent', { attributes: { [LD_JUDGE_TARGET_RUN_ID]: 'own' } }).end();
      return { usage: { input: 1, output: 1, total: 2 }, response: '{"score":1,"reasoning":"ok"}' };
    });
    await run(gradedRun);
    const [span] = exporter.getFinishedSpans();
    expect(targetAttributes(span)).toEqual({ runId: 'own', configKey: 'pr-reviewer', variationKey: 'opus' });
  });

  it('stay off spans from tracers that are not the SDK', async () => {
    mockExecuteAndTrack.mockImplementation(async () => {
      trace.getTracer('@launchdarkly/ai-claude-messages').startSpan('invoke_agent').end();
      trace.getTracer('some-http-library').startSpan('POST /v1/messages').end();
      return { usage: { input: 1, output: 1, total: 2 }, response: '{"score":1,"reasoning":"ok"}' };
    });
    await run(gradedRun);
    const spans = exporter.getFinishedSpans();
    const ours = spans.find((s) => s.name === 'invoke_agent');
    const theirs = spans.find((s) => s.name === 'POST /v1/messages');
    expect(ours && targetAttributes(ours)).toEqual({
      runId: 'graded-run-id',
      configKey: 'pr-reviewer',
      variationKey: 'opus',
    });
    expect(theirs && targetAttributes(theirs)).toEqual({
      runId: undefined,
      configKey: undefined,
      variationKey: undefined,
    });
  });
});
