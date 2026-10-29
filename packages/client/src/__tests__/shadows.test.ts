import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockLdInit } = vi.hoisted(() => ({ mockLdInit: vi.fn() }));
vi.mock('@launchdarkly/node-server-sdk', () => ({
  init: (...args: unknown[]) => mockLdInit(...args),
}));

import { config } from '../client.js';
import { initClient, shutdown } from '../lifecycle.js';
import { inSample, runShadow, waitForShadowsForTesting } from '../shadows.js';
import type { ConfigArgs, LDClientInterface, LDContext, Message, ProviderHandler, ShadowTask } from '../types.js';
import { setLdSpanAttributes } from '../utils.js';

const CONTEXT: LDContext = { kind: 'user', key: 'u1' };
const FUTURE = Date.now() + 3_600_000;
const PAST = Date.now() - 1;
const FALLTHROUGH = { kind: 'FALLTHROUGH' };
const SHADOW_FIELDS = ['isShadow', 'primaryVariationKey', 'shadowRequestId', 'ownerKind', 'ownerId'];
const BOOKKEEPING = new Set(['$ld:ai:sdk:usage', '$ld:ai:sdk:info']);

function entry(overrides: Record<string, unknown> = {}) {
  return {
    id: 'shadow-1',
    variationKey: 'b',
    samplingRate: 1,
    endsAt: FUTURE,
    ownerKind: 'member',
    ownerId: 'member-1',
    ...overrides,
  };
}

function variationB() {
  return {
    _ldMeta: { enabled: true, variationKey: 'b', version: 7, mode: 'messages', modelKey: 'claude', modelVersion: 2 },
    model: { name: 'claude-x' },
    provider: { name: 'ShadowProvider' },
    instructions: 'Shadow.',
    tools: { search: { name: 'search', type: 'function', parameters: {} } },
    judgeConfiguration: { judges: [{ key: 'j', samplingRate: 1 }] },
  };
}

function variationA(shadows?: Record<string, unknown>, variations?: Record<string, unknown>): Record<string, unknown> {
  return {
    _ldMeta: { enabled: true, variationKey: 'a', version: 1, mode: 'messages' },
    model: { name: 'gpt-4' },
    provider: { name: 'TestProvider' },
    instructions: 'Be helpful.',
    shadowConfiguration: {
      shadows: shadows ?? { fallthrough: [entry()] },
      variations: variations ?? { b: variationB() },
    },
  };
}

type FakeClient = LDClientInterface & {
  track: ReturnType<typeof vi.fn>;
  variation: ReturnType<typeof vi.fn>;
  variationDetail: ReturnType<typeof vi.fn>;
};

function makeClient(value: Record<string, unknown>, reason: unknown = FALLTHROUGH): FakeClient {
  return {
    variation: vi.fn().mockResolvedValue(value),
    variationDetail: vi.fn().mockResolvedValue({ value, reason }),
    track: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as FakeClient;
}

type Call = {
  config: Record<string, unknown>;
  input: string | undefined;
  tools: unknown;
  variables: Record<string, unknown>;
  history: Message[] | undefined;
};

function recorder(provider: string, output = 'ok', opts: { rejects?: boolean; sleepMs?: number; error?: Error } = {}) {
  const calls: Call[] = [];
  const handler = (async (cfg, input, tools, variables, history) => {
    calls.push({ config: cfg as Record<string, unknown>, input, tools, variables: variables ?? {}, history });
    if (opts.sleepMs) {
      await new Promise((r) => setTimeout(r, opts.sleepMs));
    }
    if (opts.error) {
      throw opts.error;
    }
    if (opts.rejects) {
      throw new Error('shadow boom');
    }
    return { output, usage: { input_tokens: 3, output_tokens: 2 } };
  }) as ProviderHandler;
  handler.providesFor = [provider, 'messages'];
  return { calls, handler };
}

type Event = [name: string, data: Record<string, unknown>, value: unknown];

function events(client: FakeClient): Event[] {
  return client.track.mock.calls
    .filter((c) => !BOOKKEEPING.has(c[0]))
    .map((c) => [c[0], (c[2] ?? {}) as Record<string, unknown>, c[3]]);
}
const shadowEvents = (client: FakeClient) => events(client).filter((e) => e[1].isShadow);
const realEvents = (client: FakeClient) => events(client).filter((e) => !e[1].isShadow);

async function use(client: FakeClient): Promise<FakeClient> {
  await initClient(client);
  return client;
}

async function invoke(
  client: FakeClient,
  opts: { userInput?: string; history?: Message[] } & Partial<ConfigArgs> = {},
) {
  const { userInput, history, ...configArgs } = opts;
  await use(client);
  const a = recorder('TestProvider', 'real answer');
  const b = recorder('ShadowProvider', 'shadow answer');
  const response = await config({ key: 'flag', handler: [a.handler, b.handler], ...configArgs }).invoke(
    userInput ?? 'hi',
    CONTEXT,
    { topic: 'x' },
    history,
  );
  await waitForShadowsForTesting();
  return { response, a, b };
}

async function deferredTask(client: FakeClient): Promise<ShadowTask> {
  const { response } = await invoke(client, { skipShadows: true });
  expect(response.shadowTasks).toHaveLength(1);
  return (response.shadowTasks as ShadowTask[])[0];
}

const count = (names: string[], name: string) => names.filter((n) => n === name).length;

beforeEach(async () => {
  await shutdown();
});

afterEach(async () => {
  await shutdown();
});

describe('running shadows', () => {
  it('runs the fallthrough shadow', async () => {
    const client = makeClient(variationA());
    const { a, b } = await invoke(client);
    expect(a.calls).toHaveLength(1);
    expect(b.calls).toHaveLength(1);
    expect(client.variationDetail).toHaveBeenCalledOnce();
    expect(client.variation).not.toHaveBeenCalled();
  });

  it('starts the shadow after the caller handler', async () => {
    await use(makeClient(variationA()));
    const order: string[] = [];
    const a = recorder('TestProvider', 'real answer');
    const b = recorder('ShadowProvider', 'shadow answer');
    const first = (name: string, handler: ProviderHandler) => {
      const wrapped = ((...args: Parameters<ProviderHandler>) => {
        order.push(name);
        return handler(...args);
      }) as ProviderHandler;
      wrapped.providesFor = handler.providesFor;
      return wrapped;
    };
    await config({ key: 'flag', handler: [first('a', a.handler), first('b', b.handler)] }).invoke('hi', CONTEXT);
    await waitForShadowsForTesting();
    expect(order).toEqual(['a', 'b']);
  });

  it('runs no shadows for a client without variationDetail', async () => {
    const client = makeClient(variationA());
    delete (client as Partial<FakeClient>).variationDetail;
    const { response, a, b } = await invoke(client);
    expect(response.response).toBe('real answer');
    expect(a.calls).toHaveLength(1);
    expect(b.calls).toHaveLength(0);
  });

  it.each([0, -1, Number.POSITIVE_INFINITY, Number.NaN, 2 ** 31])('rejects shadowTimeoutMs %s', (shadowTimeoutMs) => {
    expect(() => config({ key: 'flag', shadowTimeoutMs })).toThrow(RangeError);
  });

  it('accepts the largest shadowTimeoutMs', () => {
    expect(() => config({ key: 'flag', shadowTimeoutMs: 2 ** 31 - 1 })).not.toThrow();
  });

  it('gets the same input and a stripped config', async () => {
    const history: Message[] = [{ role: 'user', content: 'earlier' }];
    const { a, b } = await invoke(makeClient(variationA()), { userInput: 'question', history });
    const call = b.calls[0];
    expect(call.input).toBe('question');
    expect(call.history).toEqual(history);
    expect(call.variables.topic).toBe('x');
    expect(call.config).not.toHaveProperty('tools');
    expect(call.config).not.toHaveProperty('judgeConfiguration');
    expect(call.config).not.toHaveProperty('shadowConfiguration');
    expect(a.calls[0].config).not.toHaveProperty('shadowConfiguration');
    expect(call.tools ?? {}).toEqual({});
  });

  it('never adds the shadow answer to history', async () => {
    const history: Message[] = [{ role: 'user', content: 'earlier' }];
    await invoke(makeClient(variationA()), { history });
    expect(history).toEqual([{ role: 'user', content: 'earlier' }]);
  });

  it('keeps a failing shadow away from the caller', async () => {
    const client = await use(makeClient(variationA()));
    const a = recorder('TestProvider', 'real answer');
    const b = recorder('ShadowProvider', 'ok', { rejects: true });
    const response = await config({ key: 'flag', handler: [a.handler, b.handler] }).invoke('hi', CONTEXT);
    await waitForShadowsForTesting();
    expect(response.response).toBe('real answer');
    expect(realEvents(client).map((e) => e[0])).toContain('$ld:ai:generation:success');
    expect(shadowEvents(client).map((e) => e[0])).toContain('$ld:ai:generation:error');
  });

  it('tracks a timeout once and ignores the late result', async () => {
    const client = await use(makeClient(variationA()));
    const a = recorder('TestProvider', 'real answer');
    const b = recorder('ShadowProvider', 'ok', { sleepMs: 100 });
    await config({ key: 'flag', handler: [a.handler, b.handler], shadowTimeoutMs: 20 }).invoke('hi', CONTEXT);
    await waitForShadowsForTesting();
    await new Promise((r) => setTimeout(r, 150));
    const names = shadowEvents(client).map((e) => e[0]);
    expect(count(names, '$ld:ai:generation:error')).toBe(1);
    expect(count(names, '$ld:ai:duration:total')).toBe(1);
    expect(names).not.toContain('$ld:ai:generation:success');
  });

  it('returns a timeout error from runShadow', async () => {
    const client = makeClient(variationA());
    const { response } = await invoke(client, { skipShadows: true, shadowTimeoutMs: 20 });
    const task = (response.shadowTasks as ShadowTask[])[0];
    const result = await runShadow(task, [recorder('ShadowProvider', 'ok', { sleepMs: 100 }).handler]);
    await new Promise((r) => setTimeout(r, 150));
    expect(result.error).toBe('timeout');
    expect(result.trackData).toMatchObject({ isShadow: true, variationKey: 'b' });
    expect(shadowEvents(client).map((e) => e[0])).toEqual(['$ld:ai:duration:total', '$ld:ai:generation:error']);
  });

  it('tracks a handler timeout error once', async () => {
    const client = makeClient(variationA());
    const task = await deferredTask(client);
    const timeoutError = Object.assign(new Error('provider timeout'), { name: 'TimeoutError' });
    const result = await runShadow(task, [recorder('ShadowProvider', 'ok', { error: timeoutError }).handler]);
    expect(result.error).toBe('provider timeout');
    expect(
      count(
        shadowEvents(client).map((e) => e[0]),
        '$ld:ai:generation:error',
      ),
    ).toBe(1);
  });

  it('leaves the real run unchanged', async () => {
    const baselineClient = makeClient(variationA({}));
    const baseline = await invoke(baselineClient);
    await shutdown();
    const client = makeClient(variationA());
    const shadowed = await invoke(client);
    expect(shadowed.response.response).toBe(baseline.response.response);
    expect(shadowed.response.usage).toEqual(baseline.response.usage);
    expect(realEvents(client).map((e) => e[0])).toEqual(realEvents(baselineClient).map((e) => e[0]));
  });

  it('runs the shadow as a blocking call for stream()', async () => {
    await use(makeClient(variationA()));
    const a = recorder('TestProvider', 'real answer');
    const b = recorder('ShadowProvider', 'shadow answer');
    const seen = [];
    for await (const e of config({ key: 'flag', handler: [a.handler, b.handler] }).stream('hi', CONTEXT)) {
      seen.push(e);
    }
    await waitForShadowsForTesting();
    const done = seen.at(-1);
    expect(done?.type).toBe('done');
    expect(done).not.toHaveProperty('shadowTasks');
    expect(b.calls).toHaveLength(1);
  });
});

describe('payload shape', () => {
  it.each([
    ['not an object', 'nope'],
    ['entries not a list', { shadows: { fallthrough: 'nope' }, variations: { b: variationB() } }],
    ['entry missing fields', { shadows: { fallthrough: [{ id: 'x' }] }, variations: { b: variationB() } }],
    [
      'non-numeric rate',
      { shadows: { fallthrough: [entry({ samplingRate: 'high' })] }, variations: { b: variationB() } },
    ],
  ])('ignores a malformed configuration (%s)', async (_name, shadowConfiguration) => {
    const value = variationA();
    value.shadowConfiguration = shadowConfiguration;
    const { response, b } = await invoke(makeClient(value));
    expect(response.response).toBe('real answer');
    expect(b.calls).toHaveLength(0);
  });
});

describe('selecting shadows', () => {
  it('uses only the matched rule', async () => {
    const shadows = { r1: [entry({ id: 'rule-shadow' })], fallthrough: [entry({ id: 'ft-shadow' })] };
    const client = makeClient(variationA(shadows), { kind: 'RULE_MATCH', ruleId: 'r1', ruleIndex: 0 });
    await invoke(client);
    expect(new Set(shadowEvents(client).map((e) => e[1].shadowRequestId))).toEqual(new Set(['rule-shadow']));
  });

  it.each([
    [{ kind: 'TARGET_MATCH' }],
    [{ kind: 'OFF' }],
    [{ kind: 'PREREQUISITE_FAILED' }],
    [{ kind: 'ERROR' }],
    [null],
  ])('runs nothing for reason %j', async (reason) => {
    const { b } = await invoke(makeClient(variationA(), reason));
    expect(b.calls).toHaveLength(0);
  });

  it('skips an entry past its end', async () => {
    const client = makeClient(
      variationA({ fallthrough: [entry({ id: 'ended', endsAt: PAST }), entry({ id: 'live' })] }),
    );
    await invoke(client);
    expect(new Set(shadowEvents(client).map((e) => e[1].shadowRequestId))).toEqual(new Set(['live']));
  });

  it('skips a missing variation', async () => {
    const { b } = await invoke(makeClient(variationA({ fallthrough: [entry({ variationKey: 'gone' })] })));
    expect(b.calls).toHaveLength(0);
  });

  it('skips a disabled variation', async () => {
    const disabled = { ...variationB(), _ldMeta: { ...variationB()._ldMeta, enabled: false } };
    const { b } = await invoke(makeClient(variationA(undefined, { b: disabled })));
    expect(b.calls).toHaveLength(0);
  });

  it('skips a shadow with no matching handler', async () => {
    const client = await use(makeClient(variationA()));
    const a = recorder('TestProvider', 'real answer');
    const response = await config({ key: 'flag', handler: a.handler }).invoke('hi', CONTEXT);
    await waitForShadowsForTesting();
    expect(response.response).toBe('real answer');
    expect(shadowEvents(client)).toEqual([]);
  });

  it('samples the same context the same way every time', () => {
    expect(inSample('s1', CONTEXT, 0.5)).toBe(inSample('s1', CONTEXT, 0.5));
  });

  it('honors the sampling rate', () => {
    let hits = 0;
    for (let i = 0; i < 10_000; i++) {
      if (inSample('s1', { kind: 'user', key: `k${i}` }, 0.2)) {
        hits++;
      }
    }
    expect(hits).toBeGreaterThanOrEqual(1800);
    expect(hits).toBeLessThanOrEqual(2200);
  });

  it('samples everyone at 1 and no one at 0', () => {
    const contexts = Array.from({ length: 200 }, (_, i) => ({ kind: 'user', key: `k${i}` }));
    expect(contexts.every((c) => inSample('s1', c, 1))).toBe(true);
    expect(contexts.some((c) => inSample('s1', c, 0))).toBe(false);
  });

  it('buckets the same as the Python SDK', () => {
    expect(inSample('s1', CONTEXT, 0.732)).toBe(true);
    expect(inSample('s1', CONTEXT, 0.731)).toBe(false);
    expect(inSample('shadow-1', { kind: 'org', key: 'acme' }, 0.399)).toBe(true);
    expect(inSample('shadow-1', { kind: 'org', key: 'acme' }, 0.398)).toBe(false);
  });

  it('does not sample a context without a key', () => {
    expect(inSample('s1', { kind: 'user' } as unknown as LDContext, 1)).toBe(false);
  });
});

describe('skipShadows', () => {
  it('returns tasks and runs nothing', async () => {
    const client = makeClient(variationA());
    const { response, a, b } = await invoke(client, { skipShadows: true });
    expect(a.calls).toHaveLength(1);
    expect(b.calls).toHaveLength(0);
    expect(response.shadowTasks).toHaveLength(1);
    expect(shadowEvents(client)).toEqual([]);
  });

  it('returns an empty list when no shadow is sampled', async () => {
    const { response } = await invoke(makeClient(variationA({})), { skipShadows: true });
    expect(response.shadowTasks).toEqual([]);
  });

  it('leaves shadowTasks undefined when shadows ran in the background', async () => {
    const { response } = await invoke(makeClient(variationA()));
    expect(response.shadowTasks).toBeUndefined();
  });

  it('puts the tasks on the stream done event', async () => {
    await use(makeClient(variationA()));
    const a = recorder('TestProvider', 'real answer');
    const seen = [];
    for await (const e of config({ key: 'flag', handler: a.handler, skipShadows: true }).stream('hi', CONTEXT)) {
      seen.push(e);
    }
    expect(seen.at(-1)).toMatchObject({ type: 'done', shadowTasks: [] });
  });

  it('hands over a task that survives structuredClone and JSON', async () => {
    const task = await deferredTask(makeClient(variationA()));
    expect(structuredClone(task)).toEqual(task);
    expect(JSON.parse(JSON.stringify(task)).shadowRequestId).toBe('shadow-1');
  });

  it('runShadow tracks the same events as a background run', async () => {
    const deferredClient = makeClient(variationA());
    const task = await deferredTask(deferredClient);
    const result = await runShadow(task, [recorder('ShadowProvider', 'shadow answer').handler]);
    expect(result.error).toBeUndefined();
    expect(result.trackData).toMatchObject({ isShadow: true });
    const strip = (es: Event[]) => es.map(([name, { runId: _r, ...data }]) => [name, data]);
    const deferred = strip(shadowEvents(deferredClient));

    await shutdown();
    const backgroundClient = makeClient(variationA());
    await invoke(backgroundClient);
    expect(deferred).toEqual(strip(shadowEvents(backgroundClient)));
  });

  it('runShadow never rejects', async () => {
    const task = await deferredTask(makeClient(variationA()));
    const result = await runShadow(task, [recorder('ShadowProvider', 'ok', { rejects: true }).handler]);
    expect(result.error).toBeTruthy();
  });

  it('runShadow reports usage', async () => {
    const client = makeClient(variationA());
    const task = await deferredTask(client);
    await runShadow(task, [recorder('ShadowProvider').handler]);
    const helpers = client.track.mock.calls.filter((c) => c[0] === '$ld:ai:sdk:usage').map((c) => c[2]?.helper);
    expect(helpers).toContain('client.runShadow');
  });
});

describe('shutdown', () => {
  it('drops running shadows', async () => {
    await use(makeClient(variationA()));
    const a = recorder('TestProvider', 'real answer');
    const hang = (() => new Promise(() => {})) as unknown as ProviderHandler;
    hang.providesFor = ['ShadowProvider', 'messages'];
    await config({ key: 'flag', handler: [a.handler, hang] }).invoke('hi', CONTEXT);
    await shutdown();
    await waitForShadowsForTesting();
  });
});

describe('shadow events and spans', () => {
  it('describes the shadow variation on its events', async () => {
    const client = makeClient(variationA());
    const { response } = await invoke(client);
    const names = shadowEvents(client).map((e) => e[0]);
    for (const name of ['$ld:ai:duration:total', '$ld:ai:generation:success', '$ld:ai:tokens:total']) {
      expect(names).toContain(name);
    }
    expect(shadowEvents(client)[0][1]).toMatchObject({
      configKey: 'flag',
      variationKey: 'b',
      version: 7,
      modelName: 'claude-x',
      providerName: 'ShadowProvider',
      modelKey: 'claude',
      modelVersion: 2,
      runId: response.trackData.runId,
      isShadow: true,
      primaryVariationKey: 'a',
      shadowRequestId: 'shadow-1',
      ownerKind: 'member',
      ownerId: 'member-1',
    });
  });

  it('adds nothing to real events', async () => {
    const client = makeClient(variationA());
    const { response } = await invoke(client);
    for (const field of SHADOW_FIELDS) {
      expect(response.trackData).not.toHaveProperty(field);
      for (const [, data] of realEvents(client)) {
        expect(data).not.toHaveProperty(field);
      }
    }
  });

  it('sets the extra attributes on the root span', () => {
    const span = { setAttribute: vi.fn(), addEvent: vi.fn() };
    setLdSpanAttributes(span as never, {
      __ld: { configKey: 'flag', variationKey: 'b', runId: 'r' },
      __ld_span: { 'launchdarkly.is_shadow': true },
    });
    expect(span.setAttribute).toHaveBeenCalledWith('launchdarkly.is_shadow', true);
  });

  it('passes the shadow span attributes to the handler', async () => {
    const { b } = await invoke(makeClient(variationA()));
    expect(b.calls[0].variables.__ld_span).toEqual({
      'launchdarkly.is_shadow': true,
      'launchdarkly.shadow.request.id': 'shadow-1',
      'launchdarkly.shadow.primary.variation.key': 'a',
    });
  });

  it('does not let template variables set span attributes', async () => {
    await use(makeClient(variationA()));
    const a = recorder('TestProvider', 'real answer');
    await config({ key: 'flag', handler: a.handler }).invoke('hi', CONTEXT, { __ld_span: { x: 1 } });
    expect(a.calls[0].variables).not.toHaveProperty('__ld_span');
  });
});
