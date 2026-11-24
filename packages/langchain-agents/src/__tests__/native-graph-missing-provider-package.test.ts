import { SpanStatusCode, trace } from '@opentelemetry/api';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The provider packages are optional peers, so a graph node whose provider package is not
// installed must fail the run with the same error, naming the package to install, that a
// single-agent call on that config gives.

const mockTrack = vi.hoisted(() => vi.fn());

vi.mock('@langchain/aws', () => {
  throw new Error("Cannot find package '@langchain/aws'");
});

vi.mock('@langchain/anthropic', () => {
  throw new Error("Cannot find package '@langchain/anthropic'");
});

vi.mock('@launchdarkly/ai-server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@launchdarkly/ai-server')>();
  return { ...actual, getClient: vi.fn().mockReturnValue({ track: mockTrack }) };
});

import { toLangGraph } from '../native-graph.js';

const singleNodeGraph = (model: string, provider: string) =>
  ({
    key: 'test-graph',
    enabled: true,
    root: { key: 'root' },
    edgesFrom: () => [],
    traverse: async (fn: (node: unknown) => Promise<void>) => {
      await fn({
        key: 'root',
        config: { model: { name: model }, provider: { name: provider } },
        meta: { variationKey: 'v1', version: 1 },
        isTerminal: () => true,
        edges: [],
      });
    },
  }) as never;

const exporter = new InMemorySpanExporter();
const tracerProvider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });

const expectFailedGraphSpan = (install: string) => {
  const spans = exporter.getFinishedSpans().filter((span) => span.name === 'launchdarkly.graph');
  expect(spans).toHaveLength(1);
  expect(spans[0].status.code).toBe(SpanStatusCode.ERROR);
  expect(spans[0].status.message).toContain(install);
};

describe('toLangGraph: missing provider package', () => {
  beforeAll(() => {
    trace.setGlobalTracerProvider(tracerProvider);
  });

  afterAll(async () => {
    await tracerProvider.shutdown();
  });

  beforeEach(() => {
    mockTrack.mockClear();
    exporter.reset();
  });

  it('names the package to install for a Bedrock node, tracks the run as failed, and fails the graph span', async () => {
    const context = { kind: 'user' as const, key: 'user-1' };
    await expect(
      toLangGraph(Promise.resolve(singleNodeGraph('anthropic.claude-sonnet-4-5', 'Bedrock')), { context }).invoke('hi'),
    ).rejects.toThrow('npm install @langchain/aws');
    expect(mockTrack).toHaveBeenCalledWith(
      '$ld:ai:graph:invocation_failure',
      context,
      expect.objectContaining({ graphKey: 'test-graph' }),
      1,
    );
    expectFailedGraphSpan('npm install @langchain/aws');
  });

  it('names the package to install for an Anthropic node, keeps the import error as the cause, and fails the graph span', async () => {
    const context = { kind: 'user' as const, key: 'user-1' };
    const run = toLangGraph(Promise.resolve(singleNodeGraph('claude-sonnet-4-5', 'Anthropic')), { context }).invoke(
      'hi',
    );
    await expect(run).rejects.toThrow('npm install @langchain/anthropic');
    await expect(run).rejects.toHaveProperty('cause', expect.any(Error));
    expect(mockTrack).toHaveBeenCalledWith(
      '$ld:ai:graph:invocation_failure',
      context,
      expect.objectContaining({ graphKey: 'test-graph' }),
      1,
    );
    expectFailedGraphSpan('npm install @langchain/anthropic');
  });
});
