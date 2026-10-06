/**
 * TESTING.md §3.27 — `$ld:ai:sdk:usage`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../client.js';
import { graph, resolveGraph } from '../graph.js';
import { buildJudgeTasks, runJudge } from '../judges.js';
import { initClient, inspectConfig, shutdown } from '../lifecycle.js';
import { SDK_INFO_CONTEXT } from '../sdk-info.js';
import type { JudgeTask, LDClientInterface, LDContext, ProviderHandler, TrackData } from '../types.js';
import { createHandler } from '../utils.js';
import { LD_AI_PACKAGE_NAME, LD_AI_PACKAGE_VERSION } from '../version.js';

const ctx: LDContext = { kind: 'user', key: 'user-1' };

type FakeClient = LDClientInterface & { track: ReturnType<typeof vi.fn> };

function fakeClient(variation?: unknown): FakeClient {
  return {
    variation: vi.fn().mockResolvedValue(variation),
    track: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as FakeClient;
}

async function install(variation?: unknown): Promise<FakeClient> {
  await shutdown();
  const client = fakeClient(variation);
  await initClient(client);
  client.track.mockClear();
  return client;
}

function usageCalls(client: FakeClient, helper?: string): unknown[][] {
  return client.track.mock.calls.filter(
    (call) => call[0] === '$ld:ai:sdk:usage' && (helper === undefined || call[2]?.helper === helper),
  );
}

function expectUsage(client: FakeClient, helper: string): void {
  const calls = usageCalls(client, helper);
  expect(calls).toHaveLength(1);
  expect(calls[0]?.[1]).toEqual(SDK_INFO_CONTEXT);
  expect(calls[0]?.[2]).toEqual({
    aiSdkName: LD_AI_PACKAGE_NAME,
    aiSdkVersion: LD_AI_PACKAGE_VERSION,
    aiSdkLanguage: 'javascript',
    helper,
  });
  expect(calls[0]?.[3]).toBe(1);
}

async function settle(value: Promise<unknown>): Promise<void> {
  try {
    await value;
  } catch {
    // The report is the first statement. A later failure still leaves the event.
  }
}

function judgeArgs() {
  const handler = vi.fn() as unknown as ProviderHandler;
  handler.providesFor = ['OpenAI', 'messages'];
  return {
    config: { model: { name: 'm' }, provider: { name: 'OpenAI' }, instructions: 'i' },
    userContext: ctx,
    handler,
    llmResponse: '',
    baseTrackData: {
      runId: 'r',
      configKey: 'k',
      variationKey: 'v',
      version: 1,
      modelName: 'm',
      providerName: 'OpenAI',
    } as TrackData,
  };
}

const rows: Array<[string, () => Promise<void>]> = [
  ['client.config.invoke', () => settle(config({ key: 'k' }).invoke('q', ctx))],
  [
    'client.config.stream',
    () => {
      config({ key: 'k' }).stream('q', ctx);
      return Promise.resolve();
    },
  ],
  ['client.graph.invoke', () => settle(graph('k', {}).invoke('q', ctx))],
  [
    'client.graph.stream',
    () => {
      graph('k', {}).stream('q', ctx);
      return Promise.resolve();
    },
  ],
  ['client.resolveGraph', () => settle(resolveGraph('k', { context: ctx }))],
  ['client.inspectConfig', () => settle(inspectConfig('k', ctx))],
  ['client.runJudge', () => settle(runJudge({} as JudgeTask, []))],
  ['client.buildJudgeTasks', () => settle(buildJudgeTasks(judgeArgs()))],
  [
    'client.createHandler',
    () => {
      createHandler(['OpenAI', 'messages'], async () => ({ output: '' }));
      return Promise.resolve();
    },
  ],
];

describe('§3.27 helper usage', () => {
  let client: FakeClient;

  beforeEach(async () => {
    client = await install();
  });

  afterEach(async () => {
    await shutdown();
  });

  it.each(rows)('%s sends one $ld:ai:sdk:usage event', async (helper, call) => {
    await call();
    expectUsage(client, helper);
    if (helper === 'client.graph.invoke') {
      expect(usageCalls(client, 'client.graph.stream')).toHaveLength(0);
    }
    if (helper === 'client.graph.stream') {
      expect(usageCalls(client, 'client.graph.invoke')).toHaveLength(0);
    }
  });

  it('sends nothing on a repeat call, and again after shutdown', async () => {
    await buildJudgeTasks(judgeArgs());
    expectUsage(client, 'client.buildJudgeTasks');
    await buildJudgeTasks(judgeArgs());
    expect(usageCalls(client, 'client.buildJudgeTasks')).toHaveLength(1);

    await shutdown();
    client = await install();
    await buildJudgeTasks(judgeArgs());
    expectUsage(client, 'client.buildJudgeTasks');
  });

  it('sends a helper called before a client exists once the client exists', async () => {
    await shutdown();
    await buildJudgeTasks(judgeArgs());
    client = fakeClient();
    expect(usageCalls(client, 'client.buildJudgeTasks')).toHaveLength(0);
    await initClient(client);
    expectUsage(client, 'client.buildJudgeTasks');
  });

  it('does not fail the helper when track throws, and does not retry', async () => {
    client.track.mockImplementation(() => {
      throw new Error('client closed');
    });
    await expect(buildJudgeTasks(judgeArgs())).resolves.toEqual([]);
    expect(usageCalls(client, 'client.buildJudgeTasks')).toHaveLength(1);

    client.track.mockReset();
    await buildJudgeTasks(judgeArgs());
    expect(usageCalls(client, 'client.buildJudgeTasks')).toHaveLength(0);
  });

  it('leaves generation, duration, and token payloads unchanged', async () => {
    await shutdown();
    client = await install({
      model: { name: 'gpt-4o' },
      provider: { name: 'OpenAI' },
      instructions: 'Be helpful.',
      _ldMeta: { enabled: true, variationKey: 'v1', version: 1, mode: 'messages' },
    });
    const handler = vi.fn().mockResolvedValue({
      output: 'ok',
      usage: { input_tokens: 2, output_tokens: 3 },
    }) as unknown as ProviderHandler;
    handler.providesFor = ['OpenAI', 'messages'];

    await config({ key: 'flag', handler }).invoke('q', ctx);

    expectUsage(client, 'client.config.invoke');
    const others = client.track.mock.calls.filter(
      (call) => call[0] !== '$ld:ai:sdk:usage' && call[0] !== '$ld:ai:sdk:info',
    );
    expect(others.map((call) => call[0])).toEqual(
      expect.arrayContaining(['$ld:ai:duration:total', '$ld:ai:generation:success', '$ld:ai:tokens:total']),
    );
    for (const call of others) {
      expect(call[2]).not.toHaveProperty('helper');
      expect(call[2]).not.toHaveProperty('aiSdkName');
      expect(call[2]).not.toHaveProperty('aiSdkVersion');
      expect(call[2]).not.toHaveProperty('aiSdkLanguage');
    }
  });
});
