import { beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Hoisted mocks ────────────────────────────────────────────────────────────
//
// Only `lifecycle.js` is mocked — `tracking.js` and `judges.js` run for real, so these tests
// exercise the actual context-freeze, message_history-injection, dedupe, isolation, and timeout
// logic rather than a stand-in for it. This mirrors `client.test.ts`'s own style.

const { mockTrack } = vi.hoisted(() => ({ mockTrack: vi.fn() }));

vi.mock('../lifecycle.js', () => ({
  extractVariation: vi.fn(),
  initClient: vi.fn().mockResolvedValue(undefined),
  getClient: vi.fn().mockReturnValue({ track: mockTrack }),
  shutdown: vi.fn(),
  waitForTelemetry: vi.fn(),
  shutdownTelemetry: vi.fn(),
}));

import { config } from '../client.js';
import { buildJudgeTasks, FORMATTING_INSTRUCTIONS, runJudge } from '../judges.js';
import { extractVariation, getClient } from '../lifecycle.js';
import type { AiConfigRep, HandlerStreamEvent, JudgeTask, ProviderHandler, VariationMeta } from '../types.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const mockContext = { kind: 'user' as const, key: 'user-1' };

const mainMeta: VariationMeta = { enabled: true, variationKey: 'v1', version: 1, mode: 'messages' };

function makeMainConfig(judgeKeys: string[] = [], samplingRate = 1): AiConfigRep {
  return {
    model: { name: 'gpt-4o' },
    provider: { name: 'OpenAI' },
    instructions: 'Be helpful.',
    ...(judgeKeys.length > 0
      ? { judgeConfiguration: { judges: judgeKeys.map((key) => ({ key, samplingRate })) } }
      : {}),
  };
}

function makeJudgeConfig(modelName: string, overrides: Partial<AiConfigRep> = {}): AiConfigRep {
  return {
    model: { name: modelName },
    provider: { name: 'OpenAI' },
    instructions: 'You are a judge.',
    evaluationMetricKey: `${modelName}-metric`,
    ...overrides,
  };
}

const judgeMeta: VariationMeta = { enabled: true, variationKey: 'jv1', version: 1, mode: 'judge' };

/** Wires `extractVariation` to a fixed key -> { config, meta } map. Unknown keys reject. */
function wireExtractVariation(map: Record<string, { config: AiConfigRep; meta: VariationMeta }>) {
  (extractVariation as ReturnType<typeof vi.fn>).mockImplementation(async (key: string) => {
    if (key in map) return map[key];
    throw new Error(`Variation ${key} is not enabled`);
  });
}

type HandlerBehavior = string | (() => Promise<string>) | Error;

/**
 * A single handler that serves every config in the test: primary and every judge. Responses are
 * keyed by `config.model.name`, since every judge config in these tests uses a distinct model name.
 */
function makeMultiHandler(behaviors: Record<string, HandlerBehavior>): ProviderHandler {
  const h: ProviderHandler = vi.fn(async (cfg: AiConfigRep) => {
    const behavior = behaviors[cfg.model.name];
    if (behavior === undefined) throw new Error(`no mock behavior for model ${cfg.model.name}`);
    if (behavior instanceof Error) throw behavior;
    const output = typeof behavior === 'function' ? await behavior() : behavior;
    return { output, usage: { input_tokens: 1, output_tokens: 1 } };
  });
  h.providesFor = ['OpenAI', 'messages'];
  return h;
}

const BEGIN = 'UNTRUSTED_ACTUATOR_EVIDENCE_BEGIN';
const END = 'UNTRUSTED_ACTUATOR_EVIDENCE_END';

/** Extracts and JSON.parses the block between the two evidence delimiters. Throws if absent. */
function extractEvidence(messageHistory: string): unknown {
  const start = messageHistory.indexOf(BEGIN);
  const stop = messageHistory.indexOf(END);
  if (start === -1 || stop === -1) throw new Error('no evidence block found in message_history');
  const json = messageHistory.slice(start + BEGIN.length, stop).trim();
  return JSON.parse(json);
}

/** Finds the variables object passed to `handler` for the call whose config used `modelName`. */
function variablesForModel(handler: ProviderHandler, modelName: string): Record<string, unknown> {
  const fn = handler as unknown as ReturnType<typeof vi.fn>;
  const call = fn.mock.calls.find((c: unknown[]) => (c[0] as AiConfigRep).model.name === modelName);
  if (!call) throw new Error(`handler was never called with model ${modelName}`);
  return call[3] as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockTrack.mockReset();
  (getClient as ReturnType<typeof vi.fn>).mockReturnValue({ track: mockTrack });
});

// ─── Resolution timing and identity ────────────────────────────────────────────

describe('judgeContext resolution', () => {
  it('is resolved exactly once, after the primary handler, before parsing', async () => {
    const order: string[] = [];
    const mainConfig = makeMainConfig();
    wireExtractVariation({ flag: { config: mainConfig, meta: mainMeta } });

    const handler: ProviderHandler = vi.fn(async () => {
      order.push('handler');
      return { output: 'PRIMARY_OUTPUT', usage: {} };
    });
    handler.providesFor = ['OpenAI', 'messages'];

    const callback = vi.fn(async () => {
      order.push('context');
      return { foo: 'bar' };
    });

    const result = await config({ key: 'flag', handler, judgeContext: callback }).invoke('hi', mockContext);

    expect(callback).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['handler', 'context']);
    expect(result.judgeContext).toEqual({ foo: 'bar' });
    expect(result.response).toBe('PRIMARY_OUTPUT');
  });

  it('resolves even when no judge is configured at all', async () => {
    const mainConfig = makeMainConfig(); // no judgeConfiguration
    wireExtractVariation({ flag: { config: mainConfig, meta: mainMeta } });
    const handler = makeMultiHandler({ 'gpt-4o': 'PRIMARY_OUTPUT' });
    const callback = vi.fn().mockResolvedValue({ ok: true });

    const result = await config({ key: 'flag', handler, judgeContext: callback }).invoke('hi', mockContext);

    expect(callback).toHaveBeenCalledTimes(1);
    expect(result.judgeContext).toEqual({ ok: true });
  });

  it('resolves even when the only judge has samplingRate 0 (sampling controls execution, not the freeze boundary)', async () => {
    const mainConfig = makeMainConfig(['judge-1'], 0);
    wireExtractVariation({ flag: { config: mainConfig, meta: mainMeta } });
    const handler = makeMultiHandler({ 'gpt-4o': 'PRIMARY_OUTPUT' });
    const callback = vi.fn().mockResolvedValue({ sampled: false });

    const result = await config({ key: 'flag', handler, judgeContext: callback }).invoke('hi', mockContext);

    expect(callback).toHaveBeenCalledTimes(1);
    expect(result.judgeContext).toEqual({ sampled: false });
  });

  it('returns the resolved value on the response unchanged, never truncated or copied-with-changes', async () => {
    const mainConfig = makeMainConfig(['judge-1']);
    const judgeConfig = makeJudgeConfig('judge-1');
    wireExtractVariation({
      flag: { config: mainConfig, meta: mainMeta },
      'judge-1': { config: judgeConfig, meta: judgeMeta },
    });
    const contextValue = { nested: { a: [1, 2, 3], b: 'text' }, n: 42 };
    const handler = makeMultiHandler({
      'gpt-4o': 'PRIMARY_OUTPUT',
      'judge-1': '{"score":0.7,"reasoning":"fine"}',
    });

    const result = await config({ key: 'flag', handler, judgeContext: () => contextValue }).invoke('hi', mockContext);

    expect(result.judgeContext).toEqual(contextValue);
  });
});

// ─── message_history injection ─────────────────────────────────────────────────

describe('message_history injection', () => {
  it('deep-equals response.judgeContext when parsed out of the delimited block', async () => {
    const mainConfig = makeMainConfig(['judge-1']);
    const judgeConfig = makeJudgeConfig('judge-1');
    wireExtractVariation({
      flag: { config: mainConfig, meta: mainMeta },
      'judge-1': { config: judgeConfig, meta: judgeMeta },
    });
    const handler = makeMultiHandler({
      'gpt-4o': 'PRIMARY_OUTPUT',
      'judge-1': '{"score":0.9,"reasoning":"ok"}',
    });
    const contextValue = { verdict: 'clean', sources: ['a', 'b'], score: 0.5 };

    const result = await config({ key: 'flag', handler, judgeContext: () => contextValue }).invoke('hi', mockContext);

    const messageHistory = variablesForModel(handler, 'judge-1').message_history as string;
    expect(extractEvidence(messageHistory)).toEqual(contextValue);
    expect(extractEvidence(messageHistory)).toEqual(result.judgeContext);
  });

  it('is byte-identical to the pre-grounding format when no context is configured', async () => {
    const mainConfig = makeMainConfig(['judge-1']);
    const judgeConfig = makeJudgeConfig('judge-1');
    wireExtractVariation({
      flag: { config: mainConfig, meta: mainMeta },
      'judge-1': { config: judgeConfig, meta: judgeMeta },
    });
    const handler = makeMultiHandler({
      'gpt-4o': 'PRIMARY_OUTPUT',
      'judge-1': '{"score":0.9,"reasoning":"ok"}',
    });

    await config({ key: 'flag', handler }).invoke('hi', mockContext);

    const messageHistory = variablesForModel(handler, 'judge-1').message_history as string;
    expect(messageHistory).not.toContain('UNTRUSTED_ACTUATOR_EVIDENCE');
    expect(messageHistory).toBe(['hi', 'PRIMARY_OUTPUT', FORMATTING_INSTRUCTIONS].join('\n\n'));
  });
});

// ─── Context validation failures ───────────────────────────────────────────────

describe('judgeContext validation failures', () => {
  const cases: Array<{ name: string; code: string; callback: () => unknown }> = [
    {
      name: 'callback throws',
      code: 'context_callback_failed',
      callback: () => {
        throw new Error('boom');
      },
    },
    {
      name: 'non-JSON: object holding a function',
      code: 'context_invalid_json',
      callback: () => ({ fn: () => 1 }),
    },
    {
      name: 'non-JSON: cyclic object',
      code: 'context_invalid_json',
      callback: () => {
        const obj: Record<string, unknown> = {};
        obj.self = obj;
        return obj;
      },
    },
    {
      name: 'non-JSON: BigInt',
      code: 'context_invalid_json',
      callback: () => ({ big: BigInt(1) }),
    },
    {
      name: 'exceeds 64 KiB',
      code: 'context_too_large',
      callback: () => ({ blob: 'x'.repeat(70 * 1024) }),
    },
  ];

  for (const { name, code, callback } of cases) {
    it(`${name} -> ${code}, primary response preserved, all judges skipped, judgeContext undefined`, async () => {
      const mainConfig = makeMainConfig(['judge-1']);
      const judgeConfig = makeJudgeConfig('judge-1');
      wireExtractVariation({
        flag: { config: mainConfig, meta: mainMeta },
        'judge-1': { config: judgeConfig, meta: judgeMeta },
      });
      const handler = makeMultiHandler({
        'gpt-4o': 'PRIMARY_OUTPUT',
        'judge-1': '{"score":0.9,"reasoning":"ok"}',
      });

      const result = await config({
        key: 'flag',
        handler,
        judgeContext: callback as () => never,
      }).invoke('hi', mockContext);

      expect(result.response).toBe('PRIMARY_OUTPUT');
      expect(result.judgeContext).toBeUndefined();
      expect(result.judgeResults).toEqual({});
      expect(result.judgeDiagnostics).toEqual([{ status: 'skipped', stage: 'context', code }]);
      expect(handler).not.toHaveBeenCalledWith(
        expect.objectContaining({ model: { name: 'judge-1' } }),
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
      );
    });
  }
});

// ─── Duplicate judge keys ───────────────────────────────────────────────────────

describe('duplicate judge keys', () => {
  it('runs only the first occurrence and reports judge_duplicate_key for the rest', async () => {
    const mainConfig = makeMainConfig(['judge-1', 'judge-1']);
    const judgeConfig = makeJudgeConfig('judge-1');
    wireExtractVariation({
      flag: { config: mainConfig, meta: mainMeta },
      'judge-1': { config: judgeConfig, meta: judgeMeta },
    });
    const handler = makeMultiHandler({
      'gpt-4o': 'PRIMARY_OUTPUT',
      'judge-1': '{"score":0.9,"reasoning":"ok"}',
    });

    const result = await config({ key: 'flag', handler }).invoke('hi', mockContext);

    const judgeCalls = (handler as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: unknown[]) => (c[0] as AiConfigRep).model.name === 'judge-1',
    );
    expect(judgeCalls).toHaveLength(1);
    expect(result.judgeResults).toHaveProperty('judge-1');
    expect(result.judgeDiagnostics).toEqual([
      { judgeKey: 'judge-1', status: 'skipped', stage: 'config', code: 'judge_duplicate_key' },
    ]);
  });
});

// ─── Per-judge isolation ────────────────────────────────────────────────────────

describe('per-judge isolation', () => {
  it('config lookup throwing produces judge_config_failed and preserves the primary response and other judges', async () => {
    const mainConfig = makeMainConfig(['broken-judge', 'judge-2']);
    const judge2Config = makeJudgeConfig('judge-2');
    wireExtractVariation({
      flag: { config: mainConfig, meta: mainMeta },
      'judge-2': { config: judge2Config, meta: judgeMeta },
      // 'broken-judge' is intentionally absent from the map — wireExtractVariation rejects it.
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const handler = makeMultiHandler({ 'gpt-4o': 'PRIMARY_OUTPUT', 'judge-2': '{"score":0.5,"reasoning":"ok"}' });

    const result = await config({ key: 'flag', handler }).invoke('hi', mockContext);

    expect(result.response).toBe('PRIMARY_OUTPUT');
    expect(result.judgeResults).toHaveProperty('judge-2');
    expect(result.judgeDiagnostics).toEqual([
      { judgeKey: 'broken-judge', status: 'failed', stage: 'config', code: 'judge_config_failed' },
    ]);
    consoleError.mockRestore();
  });

  it('the provider throwing produces judge_provider_failed and preserves the primary response and other judges', async () => {
    const mainConfig = makeMainConfig(['broken-judge', 'judge-2']);
    wireExtractVariation({
      flag: { config: mainConfig, meta: mainMeta },
      'broken-judge': { config: makeJudgeConfig('broken-judge'), meta: judgeMeta },
      'judge-2': { config: makeJudgeConfig('judge-2'), meta: judgeMeta },
    });
    const handler = makeMultiHandler({
      'gpt-4o': 'PRIMARY_OUTPUT',
      'broken-judge': new Error('provider outage'),
      'judge-2': '{"score":0.5,"reasoning":"ok"}',
    });

    const result = await config({ key: 'flag', handler }).invoke('hi', mockContext);

    expect(result.response).toBe('PRIMARY_OUTPUT');
    expect(result.judgeResults).toHaveProperty('judge-2');
    expect(result.judgeResults).not.toHaveProperty('broken-judge');
    expect(result.judgeDiagnostics).toEqual([
      { judgeKey: 'broken-judge', status: 'failed', stage: 'provider', code: 'judge_provider_failed' },
    ]);
  });

  it('an invalid JSON verdict produces judge_response_invalid and preserves the primary response and other judges', async () => {
    const mainConfig = makeMainConfig(['broken-judge', 'judge-2']);
    wireExtractVariation({
      flag: { config: mainConfig, meta: mainMeta },
      'broken-judge': { config: makeJudgeConfig('broken-judge'), meta: judgeMeta },
      'judge-2': { config: makeJudgeConfig('judge-2'), meta: judgeMeta },
    });
    const handler = makeMultiHandler({
      'gpt-4o': 'PRIMARY_OUTPUT',
      'broken-judge': 'this is not json at all',
      'judge-2': '{"score":0.5,"reasoning":"ok"}',
    });

    const result = await config({ key: 'flag', handler }).invoke('hi', mockContext);

    expect(result.response).toBe('PRIMARY_OUTPUT');
    expect(result.judgeResults).toHaveProperty('judge-2');
    expect(result.judgeDiagnostics).toEqual([
      { judgeKey: 'broken-judge', status: 'failed', stage: 'parse', code: 'judge_response_invalid' },
    ]);
  });

  // Verdict policy belongs to LaunchDarkly, not to this SDK: a score the SDK rejected would be
  // lost for good, while a score passed through can be ruled on later, including for runs already
  // recorded. So only unparseable output is a failure — an odd score is still a result.
  it.each([
    ['a string score', '{"score":"high","reasoning":"ok"}', 'high'],
    ['a score above 1', '{"score":7,"reasoning":"ok"}', 7],
    ['a score below 0', '{"score":-1,"reasoning":"ok"}', -1],
  ])('passes through %s untouched, with no diagnostic', async (_label, raw, expected) => {
    const mainConfig = makeMainConfig(['judge-1']);
    wireExtractVariation({
      flag: { config: mainConfig, meta: mainMeta },
      'judge-1': { config: makeJudgeConfig('judge-1'), meta: judgeMeta },
    });
    const handler = makeMultiHandler({ 'gpt-4o': 'PRIMARY_OUTPUT', 'judge-1': raw });

    const result = await config({ key: 'flag', handler }).invoke('hi', mockContext);

    expect(result.judgeResults?.['judge-1']?.score).toBe(expected);
    expect(result.judgeResults?.['judge-1']?.response).toBe('ok');
    expect(result.judgeDiagnostics).toBeUndefined();
  });

  it('track() throwing keeps the successful judgeResult and adds judge_tracking_failed', async () => {
    const mainConfig = makeMainConfig(['judge-1']);
    wireExtractVariation({
      flag: { config: mainConfig, meta: mainMeta },
      'judge-1': { config: makeJudgeConfig('judge-1'), meta: judgeMeta },
    });
    const handler = makeMultiHandler({ 'gpt-4o': 'PRIMARY_OUTPUT', 'judge-1': '{"score":0.6,"reasoning":"ok"}' });
    mockTrack.mockImplementation((eventName: string) => {
      if (eventName === 'judge-1-metric') throw new Error('track backend down');
    });

    const result = await config({ key: 'flag', handler }).invoke('hi', mockContext);

    expect(result.judgeResults?.['judge-1']).toEqual({
      usage: { input: 1, output: 1, total: 2 },
      response: 'ok',
      score: 0.6,
    });
    expect(result.judgeDiagnostics).toEqual([
      { judgeKey: 'judge-1', status: 'failed', stage: 'track', code: 'judge_tracking_failed' },
    ]);
  });

  it('a per-judge timeout produces judge_timed_out and the late resolution is consumed silently', async () => {
    const mainConfig = makeMainConfig(['slow-judge']);
    wireExtractVariation({
      flag: { config: mainConfig, meta: mainMeta },
      'slow-judge': { config: makeJudgeConfig('slow-judge'), meta: judgeMeta },
    });
    const handler = makeMultiHandler({
      'gpt-4o': 'PRIMARY_OUTPUT',
      'slow-judge': async () => {
        await new Promise((resolve) => setTimeout(resolve, 60));
        return '{"score":0.9,"reasoning":"too late"}';
      },
    });

    const result = await config({ key: 'flag', handler, judgeTimeoutMs: 10 }).invoke('hi', mockContext);

    expect(result.judgeResults).toEqual({});
    expect(result.judgeDiagnostics).toEqual([
      { judgeKey: 'slow-judge', status: 'failed', stage: 'timeout', code: 'judge_timed_out' },
    ]);
    expect(mockTrack).not.toHaveBeenCalledWith('slow-judge-metric', expect.anything(), expect.anything(), 0.9);

    // Let the slow handler actually finish in the background, then confirm nothing changed.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(result.judgeResults).toEqual({});
    expect(mockTrack).not.toHaveBeenCalledWith('slow-judge-metric', expect.anything(), expect.anything(), 0.9);
  });

  it('caps successful judge reasoning at 4 KiB', async () => {
    const mainConfig = makeMainConfig(['judge-1']);
    wireExtractVariation({
      flag: { config: mainConfig, meta: mainMeta },
      'judge-1': { config: makeJudgeConfig('judge-1'), meta: judgeMeta },
    });
    const longReasoning = 'a'.repeat(10 * 1024);
    const handler = makeMultiHandler({
      'gpt-4o': 'PRIMARY_OUTPUT',
      'judge-1': JSON.stringify({ score: 0.5, reasoning: longReasoning }),
    });

    const result = await config({ key: 'flag', handler }).invoke('hi', mockContext);

    const reasoning = result.judgeResults?.['judge-1']?.response ?? '';
    expect(new TextEncoder().encode(reasoning).byteLength).toBeLessThanOrEqual(4 * 1024);
    expect(reasoning.length).toBeLessThan(longReasoning.length);
  });
});

// ─── skipJudges: buildJudgeTasks / runJudge ────────────────────────────────────

describe('skipJudges path', () => {
  it('carries the resolved judgeContext on every task, and runJudge injects the identical block', async () => {
    const mainConfig = makeMainConfig(['judge-1']);
    wireExtractVariation({
      flag: { config: mainConfig, meta: mainMeta },
      'judge-1': { config: makeJudgeConfig('judge-1'), meta: judgeMeta },
    });
    const handler = makeMultiHandler({ 'gpt-4o': 'PRIMARY_OUTPUT', 'judge-1': '{"score":0.5,"reasoning":"ok"}' });
    const contextValue = { grounded: true, ids: [1, 2] };

    const result = await config({ key: 'flag', handler, skipJudges: true, judgeContext: () => contextValue }).invoke(
      'hi',
      mockContext,
    );

    expect(result.judgeContext).toEqual(contextValue);
    expect(result.judgeTasks).toHaveLength(1);
    const task = result.judgeTasks?.[0] as JudgeTask;
    expect(task.judgeContext).toEqual(contextValue);

    const runResult = await runJudge(task, [handler]);
    const messageHistory = variablesForModel(handler, 'judge-1').message_history as string;
    expect(extractEvidence(messageHistory)).toEqual(contextValue);
    expect(runResult?.score).toBe(0.5);
  });

  it('returns build-step diagnostics (duplicate key) on ProviderResponse.judgeDiagnostics next to judgeTasks', async () => {
    const mainConfig = makeMainConfig(['judge-1', 'judge-1']);
    wireExtractVariation({
      flag: { config: mainConfig, meta: mainMeta },
      'judge-1': { config: makeJudgeConfig('judge-1'), meta: judgeMeta },
    });
    const handler = makeMultiHandler({ 'gpt-4o': 'PRIMARY_OUTPUT', 'judge-1': '{"score":0.5,"reasoning":"ok"}' });

    const result = await config({ key: 'flag', handler, skipJudges: true }).invoke('hi', mockContext);

    expect(result.judgeTasks).toHaveLength(1);
    expect(result.judgeDiagnostics).toEqual([
      { judgeKey: 'judge-1', status: 'skipped', stage: 'config', code: 'judge_duplicate_key' },
    ]);
  });

  it('buildJudgeTasks directly: reports judge_config_failed and skips the task', async () => {
    const mainConfig = makeMainConfig(['broken-judge']);
    wireExtractVariation({ flag: { config: mainConfig, meta: mainMeta } });
    const handler = makeMultiHandler({ 'gpt-4o': 'PRIMARY_OUTPUT' });

    const { judgeTasks, judgeDiagnostics } = await buildJudgeTasks({
      config: mainConfig,
      userContext: mockContext,
      handler,
      llmResponse: 'PRIMARY_OUTPUT',
      baseTrackData: {
        runId: 'r1',
        configKey: 'flag',
        variationKey: 'v1',
        version: 1,
        modelName: 'gpt-4o',
        providerName: 'OpenAI',
      },
    });

    expect(judgeTasks).toEqual([]);
    expect(judgeDiagnostics).toEqual([
      { judgeKey: 'broken-judge', status: 'failed', stage: 'config', code: 'judge_config_failed' },
    ]);
  });
});

// ─── stream() ───────────────────────────────────────────────────────────────────

function makeStreamingHandler(chunks: string[], judgeResponses: Record<string, HandlerBehavior>): ProviderHandler {
  const h: ProviderHandler = vi.fn(async (cfg: AiConfigRep) => {
    const behavior = judgeResponses[cfg.model.name];
    if (behavior === undefined) throw new Error(`no mock behavior for model ${cfg.model.name}`);
    if (behavior instanceof Error) throw behavior;
    const output = typeof behavior === 'function' ? await behavior() : behavior;
    return { output, usage: { input_tokens: 1, output_tokens: 1 } };
  });
  h.providesFor = ['OpenAI', 'messages'];
  h.stream = vi.fn(async function* (): AsyncGenerator<HandlerStreamEvent> {
    for (const text of chunks) yield { type: 'chunk', text };
    yield { type: 'done', output: chunks.join(''), usage: { input_tokens: 1, output_tokens: 1 } };
  });
  return h;
}

async function collectStream<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const events: T[] = [];
  for await (const event of gen) events.push(event);
  return events;
}

describe('stream()', () => {
  it('forwards chunks unchanged and yields exactly one final done event with context, results, and diagnostics', async () => {
    const mainConfig = makeMainConfig(['judge-1']);
    wireExtractVariation({
      flag: { config: mainConfig, meta: mainMeta },
      'judge-1': { config: makeJudgeConfig('judge-1'), meta: judgeMeta },
    });
    const handler = makeStreamingHandler(['Hello', ' world'], { 'judge-1': '{"score":0.8,"reasoning":"good"}' });
    const contextValue = { streamed: true };

    const events = await collectStream(
      config({ key: 'flag', handler, judgeContext: () => contextValue }).stream('hi', mockContext),
    );

    const chunks = events.filter((e) => e.type === 'chunk');
    expect(chunks).toEqual([
      { type: 'chunk', text: 'Hello' },
      { type: 'chunk', text: ' world' },
    ]);

    const doneEvents = events.filter((e) => e.type === 'done');
    expect(doneEvents).toHaveLength(1);
    const done = doneEvents[0] as Extract<(typeof events)[number], { type: 'done' }>;
    expect(done.judgeContext).toEqual(contextValue);
    expect(done.judgeResults).toHaveProperty('judge-1');
    expect(done.judgeDiagnostics).toBeUndefined();
  });
});
