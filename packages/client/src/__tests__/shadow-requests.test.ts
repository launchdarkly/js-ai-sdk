import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockLdInit } = vi.hoisted(() => ({ mockLdInit: vi.fn() }));
vi.mock('@launchdarkly/node-server-sdk', () => ({
  init: (...args: unknown[]) => mockLdInit(...args),
}));

import { config } from '../client.js';
import { runShadow, type ShadowTask, shadowConfig } from '../experimental.js';
import { initClient, shutdown } from '../lifecycle.js';
import { inSample, waitForShadowsForTesting } from '../shadow-requests.js';
import type { LDClientInterface, LDContext, Message, ProviderHandler, StreamEvent } from '../types.js';
import { SPAN_ATTRIBUTES_KEY, setLdSpanAttributes } from '../utils.js';

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
  variables: Record<string | symbol, unknown>;
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
      throw new Error('boom');
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
const primaryEvents = (client: FakeClient) => events(client).filter((e) => !e[1].isShadow);
const usageHelpers = (client: FakeClient) =>
  client.track.mock.calls.filter((c) => c[0] === '$ld:ai:sdk:usage').map((c) => c[2]?.helper);
const count = (names: string[], name: string) => names.filter((n) => n === name).length;

async function use(client: FakeClient): Promise<FakeClient> {
  await initClient(client);
  return client;
}

async function invoke(
  client: FakeClient,
  opts: {
    userInput?: string;
    history?: Message[];
    shadowTimeoutMs?: number;
    onTask?: (task: ShadowTask) => void;
    a?: ReturnType<typeof recorder>;
    b?: ReturnType<typeof recorder>;
  } = {},
) {
  await use(client);
  const a = opts.a ?? recorder('TestProvider', 'primary answer');
  const b = opts.b ?? recorder('ShadowProvider', 'shadow answer');
  const response = await shadowConfig({
    key: 'flag',
    handler: [a.handler, b.handler],
    shadowTimeoutMs: opts.shadowTimeoutMs,
    onTask: opts.onTask,
  }).invoke(opts.userInput ?? 'hi', CONTEXT, { topic: 'x' }, opts.history);
  await waitForShadowsForTesting();
  return { response, a, b };
}

async function collect(stream: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const seen: StreamEvent[] = [];
  for await (const e of stream) {
    seen.push(e);
  }
  return seen;
}

async function deferredTask(client: FakeClient, shadowTimeoutMs?: number): Promise<ShadowTask> {
  const tasks: ShadowTask[] = [];
  await invoke(client, { shadowTimeoutMs, onTask: (task) => tasks.push(task) });
  expect(tasks).toHaveLength(1);
  return tasks[0];
}

beforeEach(async () => {
  await shutdown();
});

afterEach(async () => {
  await shutdown();
});

describe('plain config()', () => {
  it('never calls variationDetail and runs no shadows', async () => {
    const client = await use(makeClient(variationA()));
    const a = recorder('TestProvider', 'primary answer');
    const b = recorder('ShadowProvider', 'shadow answer');
    await config({ key: 'flag', handler: [a.handler, b.handler] }).invoke('hi', CONTEXT);
    await collect(config({ key: 'flag', handler: [a.handler, b.handler] }).stream('hi', CONTEXT));
    await waitForShadowsForTesting();
    expect(client.variation).toHaveBeenCalledTimes(2);
    expect(client.variationDetail).not.toHaveBeenCalled();
    expect(b.calls).toHaveLength(0);
    expect(shadowEvents(client)).toEqual([]);
  });
});

describe('shadowConfig', () => {
  it('evaluates the flag once with variationDetail and runs the fallthrough shadow', async () => {
    const client = makeClient(variationA());
    const { response, a, b } = await invoke(client);
    expect(response.response).toBe('primary answer');
    expect(client.variationDetail).toHaveBeenCalledOnce();
    expect(client.variation).not.toHaveBeenCalled();
    expect(a.calls).toHaveLength(1);
    expect(b.calls).toHaveLength(1);
  });

  it('gives the primary handler the config without shadowConfiguration', async () => {
    const { a } = await invoke(makeClient(variationA()));
    expect(a.calls[0].config).not.toHaveProperty('shadowConfiguration');
  });

  it('produces the same primary response, usage and events as config()', async () => {
    const plainClient = await use(makeClient(variationA()));
    const plainHandler = recorder('TestProvider', 'primary answer');
    const plain = await config({ key: 'flag', handler: plainHandler.handler }).invoke('hi', CONTEXT, { topic: 'x' });
    await shutdown();

    const client = makeClient(variationA());
    const { response } = await invoke(client);
    expect(response.response).toBe(plain.response);
    expect(response.usage).toEqual(plain.usage);
    const strip = (es: Event[]) => es.map(([name, { runId: _r, ...data }, value]) => [name, data, value]);
    expect(strip(primaryEvents(client))).toEqual(strip(events(plainClient)));
  });

  it('starts shadows only after the primary handler returns', async () => {
    const order: string[] = [];
    const a = recorder('TestProvider', 'primary answer');
    const b = recorder('ShadowProvider', 'shadow answer');
    const traced = (name: string, inner: ProviderHandler) => {
      const handler = (async (...args: Parameters<ProviderHandler>) => {
        order.push(`${name} start`);
        const result = await inner(...args);
        order.push(`${name} end`);
        return result;
      }) as ProviderHandler;
      handler.providesFor = inner.providesFor;
      return { calls: [], handler };
    };
    await invoke(makeClient(variationA()), { a: traced('a', a.handler), b: traced('b', b.handler) });
    expect(order).toEqual(['a start', 'a end', 'b start', 'b end']);
  });

  it('runs no shadow when the primary handler fails', async () => {
    const client = await use(makeClient(variationA()));
    const a = recorder('TestProvider', 'x', { rejects: true });
    const b = recorder('ShadowProvider', 'shadow answer');
    await expect(shadowConfig({ key: 'flag', handler: [a.handler, b.handler] }).invoke('hi', CONTEXT)).rejects.toThrow(
      'boom',
    );
    await waitForShadowsForTesting();
    expect(b.calls).toHaveLength(0);
    expect(shadowEvents(client)).toEqual([]);
  });

  it('runs no shadows for a client without variationDetail', async () => {
    const client = makeClient(variationA());
    delete (client as Partial<FakeClient>).variationDetail;
    const { response, b } = await invoke(client);
    expect(response.response).toBe('primary answer');
    expect(client.variation).toHaveBeenCalledOnce();
    expect(b.calls).toHaveLength(0);
  });

  it.each([0, -1, Number.POSITIVE_INFINITY, Number.NaN, 2 ** 31])('rejects shadowTimeoutMs %s', (shadowTimeoutMs) => {
    expect(() => shadowConfig({ key: 'flag', shadowTimeoutMs })).toThrow(RangeError);
  });

  it('accepts the largest shadowTimeoutMs', () => {
    expect(() => shadowConfig({ key: 'flag', shadowTimeoutMs: 2 ** 31 - 1 })).not.toThrow();
  });

  it('gives the shadow the same input and a stripped config', async () => {
    const history: Message[] = [{ role: 'user', content: 'earlier' }];
    const { b } = await invoke(makeClient(variationA()), { userInput: 'question', history });
    const call = b.calls[0];
    expect(call.input).toBe('question');
    expect(call.history).toEqual(history);
    expect(call.variables.topic).toBe('x');
    expect(call.config.instructions).toBe('Shadow.');
    for (const key of ['_ldMeta', 'tools', 'judgeConfiguration', 'shadowConfiguration']) {
      expect(call.config).not.toHaveProperty(key);
    }
    expect(call.tools).toEqual({});
  });

  it('never adds the shadow answer to history', async () => {
    const history: Message[] = [{ role: 'user', content: 'earlier' }];
    await invoke(makeClient(variationA()), { history });
    expect(history).toEqual([{ role: 'user', content: 'earlier' }]);
  });

  it('keeps a failing shadow away from the caller', async () => {
    const client = makeClient(variationA());
    const { response } = await invoke(client, { b: recorder('ShadowProvider', 'x', { rejects: true }) });
    expect(response.response).toBe('primary answer');
    expect(primaryEvents(client).map((e) => e[0])).toContain('$ld:ai:generation:success');
    expect(shadowEvents(client).map((e) => e[0])).toContain('$ld:ai:generation:error');
  });

  it('tracks a timeout once and ignores the late result', async () => {
    const client = makeClient(variationA());
    await invoke(client, { shadowTimeoutMs: 20, b: recorder('ShadowProvider', 'late', { sleepMs: 100 }) });
    await new Promise((r) => setTimeout(r, 150));
    const names = shadowEvents(client).map((e) => e[0]);
    expect(count(names, '$ld:ai:generation:error')).toBe(1);
    expect(count(names, '$ld:ai:duration:total')).toBe(1);
    expect(names).not.toContain('$ld:ai:generation:success');
  });

  it('reports experimental.shadowConfig and not client.config', async () => {
    const client = makeClient(variationA());
    await invoke(client);
    const helpers = usageHelpers(client);
    expect(helpers).toContain('experimental.shadowConfig');
    expect(helpers.filter((h) => String(h).startsWith('client.config'))).toEqual([]);
  });
});

describe('stream', () => {
  it('streams the primary answer and runs the shadow as a plain invoke after done', async () => {
    const client = await use(makeClient(variationA()));
    const a = recorder('TestProvider', 'primary answer');
    const b = recorder('ShadowProvider', 'shadow answer');
    const streamed = vi.fn();
    b.handler.stream = streamed;
    const seen = await collect(shadowConfig({ key: 'flag', handler: [a.handler, b.handler] }).stream('hi', CONTEXT));
    await waitForShadowsForTesting();
    expect(seen.at(-1)).toMatchObject({ type: 'done', response: 'primary answer' });
    expect(b.calls).toHaveLength(1);
    expect(streamed).not.toHaveBeenCalled();
    const primaryRunId = primaryEvents(client)[0][1].runId;
    expect(shadowEvents(client)[0][1].runId).toBe(primaryRunId);
  });

  it('runs no shadow before the stream reaches done', async () => {
    await use(makeClient(variationA()));
    const a = recorder('TestProvider', 'primary answer');
    const b = recorder('ShadowProvider', 'shadow answer');
    const stream = shadowConfig({ key: 'flag', handler: [a.handler, b.handler] }).stream('hi', CONTEXT);
    await stream.next();
    await stream.return(undefined);
    await waitForShadowsForTesting();
    expect(b.calls).toHaveLength(0);
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
    [
      'invalid shadow config',
      { shadows: { fallthrough: [entry()] }, variations: { b: { _ldMeta: { enabled: true } } } },
    ],
  ])('ignores a malformed configuration (%s)', async (_name, shadowConfiguration) => {
    const value = variationA();
    value.shadowConfiguration = shadowConfiguration;
    const { response, b } = await invoke(makeClient(value));
    expect(response.response).toBe('primary answer');
    expect(b.calls).toHaveLength(0);
  });

  it('runs no shadow when the variation has no shadowConfiguration', async () => {
    const value = variationA();
    delete value.shadowConfiguration;
    const { response, b } = await invoke(makeClient(value));
    expect(response.response).toBe('primary answer');
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
    [{ kind: 'RULE_MATCH' }],
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
    const a = recorder('TestProvider', 'primary answer');
    const response = await shadowConfig({ key: 'flag', handler: a.handler }).invoke('hi', CONTEXT);
    await waitForShadowsForTesting();
    expect(response.response).toBe('primary answer');
    expect(shadowEvents(client)).toEqual([]);
  });

  it('runs no shadow when the sampling rate is 0', async () => {
    const { b } = await invoke(makeClient(variationA({ fallthrough: [entry({ samplingRate: 0 })] })));
    expect(b.calls).toHaveLength(0);
  });
});

describe('sampling', () => {
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

  it('buckets the same as the other SDKs', () => {
    expect(inSample('s1', CONTEXT, 0.73114)).toBe(true);
    expect(inSample('s1', CONTEXT, 0.73113)).toBe(false);
    expect(inSample('shadow-1', { kind: 'org', key: 'acme' }, 0.39897)).toBe(true);
    expect(inSample('shadow-1', { kind: 'org', key: 'acme' }, 0.39896)).toBe(false);
  });

  it('does not sample a context without a key', () => {
    expect(inSample('s1', { kind: 'user' } as unknown as LDContext, 1)).toBe(false);
  });
});

describe('onTask', () => {
  it('hands over each sampled shadow and runs nothing itself', async () => {
    const client = makeClient(variationA());
    const tasks: ShadowTask[] = [];
    const { b } = await invoke(client, { onTask: (task) => tasks.push(task) });
    expect(tasks).toHaveLength(1);
    expect(b.calls).toHaveLength(0);
    expect(shadowEvents(client)).toEqual([]);
  });

  it('logs and swallows a callback error', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { response } = await invoke(makeClient(variationA()), {
      onTask: () => {
        throw new Error('queue full');
      },
    });
    expect(response.response).toBe('primary answer');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('copies the context so later changes by the caller do not reach the task', async () => {
    const client = await use(makeClient(variationA()));
    const context = { kind: 'multi', user: { key: 'u1', name: 'Ann' } } as LDContext;
    const tasks: ShadowTask[] = [];
    await shadowConfig({
      key: 'flag',
      handler: [recorder('TestProvider', 'a').handler, recorder('ShadowProvider', 'b').handler],
      onTask: (task) => tasks.push(task),
    }).invoke('hi', context);
    (context as { user: { key: string } }).user.key = 'someone-else';
    expect(tasks).toHaveLength(1);
    expect(tasks[0].context).toEqual({ kind: 'multi', user: { key: 'u1', name: 'Ann' } });
  });

  it('still returns the served response when building the shadows fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await use(makeClient(variationA()));
    const context = { kind: 'user', key: 'u1', format: () => 'x' } as unknown as LDContext;
    const tasks: ShadowTask[] = [];
    const response = await shadowConfig({
      key: 'flag',
      handler: [recorder('TestProvider', 'primary answer').handler, recorder('ShadowProvider', 'b').handler],
      onTask: (task) => tasks.push(task),
    }).invoke('hi', context);
    expect(response.response).toBe('primary answer');
    expect(tasks).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('hands over a task that survives structuredClone', async () => {
    const task = await deferredTask(makeClient(variationA()));
    expect(structuredClone(task)).toEqual(task);
    expect(task.shadowRequestId).toBe('shadow-1');
  });

  it('runShadow tracks the same events as a background run', async () => {
    const deferredClient = makeClient(variationA());
    const task = await deferredTask(deferredClient);
    const result = await runShadow(task, [recorder('ShadowProvider', 'shadow answer').handler]);
    expect(result.error).toBeUndefined();
    expect(result.usage.total).toBe(5);
    expect(result.trackData).toMatchObject({ isShadow: true, variationKey: 'b' });
    const strip = (es: Event[]) => es.map(([name, { runId: _r, ...data }]) => [name, data]);
    const deferred = strip(shadowEvents(deferredClient));

    await shutdown();
    const backgroundClient = makeClient(variationA());
    await invoke(backgroundClient);
    expect(deferred).toEqual(strip(shadowEvents(backgroundClient)));
  });

  it('runShadow never rejects', async () => {
    const task = await deferredTask(makeClient(variationA()));
    const failed = await runShadow(task, [recorder('ShadowProvider', 'x', { rejects: true }).handler]);
    expect(failed.error).toBe('boom');
    const unhandled = await runShadow(task, []);
    expect(unhandled.error).toBeTruthy();
  });

  it('runShadow returns a timeout error', async () => {
    const client = makeClient(variationA());
    const task = await deferredTask(client, 20);
    const result = await runShadow(task, [recorder('ShadowProvider', 'late', { sleepMs: 100 }).handler]);
    await new Promise((r) => setTimeout(r, 150));
    expect(result.error).toBe('timeout');
    expect(shadowEvents(client).map((e) => e[0])).toEqual(['$ld:ai:duration:total', '$ld:ai:generation:error']);
  });

  it('runShadow reports experimental.runShadow', async () => {
    const client = makeClient(variationA());
    const task = await deferredTask(client);
    await runShadow(task, [recorder('ShadowProvider').handler]);
    expect(usageHelpers(client)).toContain('experimental.runShadow');
  });
});

describe('shutdown', () => {
  it('drops running shadows', async () => {
    await use(makeClient(variationA()));
    const a = recorder('TestProvider', 'primary answer');
    const hang = (() => new Promise(() => {})) as unknown as ProviderHandler;
    hang.providesFor = ['ShadowProvider', 'messages'];
    await shadowConfig({ key: 'flag', handler: [a.handler, hang] }).invoke('hi', CONTEXT);
    await shutdown();
    await waitForShadowsForTesting();
  });
});

describe('shadow events and spans', () => {
  it('describes the shadow variation on its events, with the primary run id', async () => {
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
      runId: response.trackData?.runId,
      isShadow: true,
      primaryVariationKey: 'a',
      shadowRequestId: 'shadow-1',
      ownerKind: 'member',
      ownerId: 'member-1',
    });
  });

  it('adds nothing to the primary events', async () => {
    const client = makeClient(variationA());
    const { response } = await invoke(client);
    for (const field of SHADOW_FIELDS) {
      expect(response.trackData).not.toHaveProperty(field);
      for (const [, data] of primaryEvents(client)) {
        expect(data).not.toHaveProperty(field);
      }
    }
  });

  it('passes the shadow span attributes to the shadow handler only', async () => {
    const { a, b } = await invoke(makeClient(variationA()));
    expect(b.calls[0].variables[SPAN_ATTRIBUTES_KEY]).toEqual({
      'launchdarkly.is_shadow': true,
      'launchdarkly.shadow.request.id': 'shadow-1',
      'launchdarkly.shadow.primary.variation.key': 'a',
    });
    expect(a.calls[0].variables).not.toHaveProperty([SPAN_ATTRIBUTES_KEY]);
    expect(Object.getOwnPropertySymbols(a.calls[0].variables)).toEqual([]);
  });

  it('sets the extra attributes on the root span', () => {
    const span = { setAttribute: vi.fn(), addEvent: vi.fn() };
    setLdSpanAttributes(
      span as never,
      {
        __ld: { configKey: 'flag', variationKey: 'b', runId: 'r' },
        [SPAN_ATTRIBUTES_KEY]: { 'launchdarkly.is_shadow': true },
      } as Record<string, unknown>,
    );
    expect(span.setAttribute).toHaveBeenCalledWith('launchdarkly.is_shadow', true);
  });

  it('never takes span attributes from template variables', () => {
    const span = { setAttribute: vi.fn(), addEvent: vi.fn() };
    setLdSpanAttributes(span as never, {
      __ld: { configKey: 'flag', variationKey: 'b', runId: 'r' },
      [String(SPAN_ATTRIBUTES_KEY)]: { 'launchdarkly.is_shadow': true },
      __ld_span: { 'launchdarkly.is_shadow': true },
    });
    expect(span.setAttribute).not.toHaveBeenCalledWith('launchdarkly.is_shadow', true);
  });
});
