/**
 * §9 Shadow Requests (experimental). Reference: TESTING.md §9, A.22.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockLdInit } = vi.hoisted(() => ({ mockLdInit: vi.fn() }));
vi.mock('@launchdarkly/node-server-sdk', () => ({
  init: (...args: unknown[]) => mockLdInit(...args),
}));

import { config } from '../client.js';
import type { InvocationEvent } from '../invocation-hooks.js';
import { registerInvocationHook } from '../invocation-hooks.js';
import { initClient, shutdown } from '../lifecycle.js';
import {
  disableShadowRequests,
  enableShadowRequests,
  inSample,
  runShadow,
  type ShadowTask,
  waitForShadowsForTesting,
} from '../shadow-requests.js';
import type { LDClientInterface, LDContext, Message, ProviderHandler } from '../types.js';
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

function recorder(provider: string, output = 'ok', opts: { rejects?: boolean; sleepMs?: number } = {}) {
  const calls: Call[] = [];
  const handler = (async (cfg, input, tools, variables, history) => {
    calls.push({ config: cfg as Record<string, unknown>, input, tools, variables: variables ?? {}, history });
    if (opts.sleepMs) {
      await new Promise((r) => setTimeout(r, opts.sleepMs));
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

async function invoke(client: FakeClient, opts: { userInput?: string; history?: Message[] } = {}) {
  await use(client);
  const a = recorder('TestProvider', 'real answer');
  const b = recorder('ShadowProvider', 'shadow answer');
  const response = await config({ key: 'flag', handler: [a.handler, b.handler] }).invoke(
    opts.userInput ?? 'hi',
    CONTEXT,
    { topic: 'x' },
    opts.history,
  );
  await waitForShadowsForTesting();
  return { response, a, b };
}

beforeEach(async () => {
  await shutdown();
  disableShadowRequests();
});

afterEach(async () => {
  disableShadowRequests();
  await shutdown();
});

describe('§9.1 turning Shadow Requests on and off', () => {
  it('runs nothing until enabled', async () => {
    const client = makeClient(variationA());
    const { a, b } = await invoke(client);
    expect(a.calls).toHaveLength(1);
    expect(b.calls).toHaveLength(0);
    expect(shadowEvents(client)).toEqual([]);
    expect(client.variationDetail).not.toHaveBeenCalled();
    expect(client.variation).toHaveBeenCalledOnce();
  });

  it('runs the fallthrough shadow once enabled', async () => {
    enableShadowRequests();
    const client = makeClient(variationA());
    const { a, b } = await invoke(client);
    expect(a.calls).toHaveLength(1);
    expect(b.calls).toHaveLength(1);
    expect(client.variationDetail).toHaveBeenCalledOnce();
    expect(client.variation).not.toHaveBeenCalled();
  });

  it('requires a positive timeout', () => {
    expect(() => enableShadowRequests({ timeoutMs: 0 })).toThrow(RangeError);
  });

  it('turns off with disableShadowRequests', async () => {
    enableShadowRequests();
    disableShadowRequests();
    const { b } = await invoke(makeClient(variationA()));
    expect(b.calls).toHaveLength(0);
  });

  it('stops deferred mode on disable', async () => {
    const tasks: ShadowTask[] = [];
    enableShadowRequests({ onTask: (t) => tasks.push(t) });
    disableShadowRequests();
    await invoke(makeClient(variationA()));
    expect(tasks).toEqual([]);
  });

  it('replaces the settings when enabled again', async () => {
    const tasks: ShadowTask[] = [];
    enableShadowRequests({ onTask: (t) => tasks.push(t) });
    enableShadowRequests();
    const { b } = await invoke(makeClient(variationA()));
    expect(tasks).toEqual([]);
    expect(b.calls).toHaveLength(1);
  });

  it('turns off on shutdown', async () => {
    enableShadowRequests();
    await use(makeClient(variationA()));
    await shutdown();
    const { b } = await invoke(makeClient(variationA()));
    expect(b.calls).toHaveLength(0);
  });

  it('reports usage on enable', async () => {
    const client = await use(makeClient(variationA()));
    enableShadowRequests();
    const helpers = client.track.mock.calls.filter((c) => c[0] === '$ld:ai:sdk:usage').map((c) => c[2]?.helper);
    expect(helpers).toContain('experimental.enableShadowRequests');
  });
});

describe('§9.2 payload shape', () => {
  it('never passes shadowConfiguration to a handler', async () => {
    enableShadowRequests();
    const { a, b } = await invoke(makeClient(variationA()));
    expect(a.calls[0].config).not.toHaveProperty('shadowConfiguration');
    expect(b.calls[0].config).not.toHaveProperty('shadowConfiguration');
  });

  it.each([
    ['not an object', 'nope'],
    ['entries not a list', { shadows: { fallthrough: 'nope' }, variations: { b: variationB() } }],
    ['entry missing fields', { shadows: { fallthrough: [{ id: 'x' }] }, variations: { b: variationB() } }],
    [
      'non-numeric rate',
      { shadows: { fallthrough: [entry({ samplingRate: 'high' })] }, variations: { b: variationB() } },
    ],
  ])('ignores a malformed configuration (%s)', async (_name, shadowConfiguration) => {
    enableShadowRequests();
    const value = variationA();
    value.shadowConfiguration = shadowConfiguration;
    const { response, b } = await invoke(makeClient(value));
    expect(response.response).toBe('real answer');
    expect(b.calls).toHaveLength(0);
  });
});

describe('§9.3 selecting shadows', () => {
  it('uses only the matched rule', async () => {
    enableShadowRequests();
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
    enableShadowRequests();
    const { b } = await invoke(makeClient(variationA(), reason));
    expect(b.calls).toHaveLength(0);
  });

  it('skips an entry past its end', async () => {
    enableShadowRequests();
    const client = makeClient(
      variationA({ fallthrough: [entry({ id: 'ended', endsAt: PAST }), entry({ id: 'live' })] }),
    );
    await invoke(client);
    expect(new Set(shadowEvents(client).map((e) => e[1].shadowRequestId))).toEqual(new Set(['live']));
  });

  it('skips a missing variation', async () => {
    enableShadowRequests();
    const { b } = await invoke(makeClient(variationA({ fallthrough: [entry({ variationKey: 'gone' })] })));
    expect(b.calls).toHaveLength(0);
  });

  it('skips a shadow with no matching handler', async () => {
    enableShadowRequests();
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
      if (inSample('s1', { kind: 'user', key: `k${i}` }, 0.2)) hits++;
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

  it('runs the shadow as a blocking call for stream()', async () => {
    enableShadowRequests();
    await use(makeClient(variationA()));
    const a = recorder('TestProvider', 'real answer');
    const b = recorder('ShadowProvider', 'shadow answer');
    const seen = [];
    for await (const e of config({ key: 'flag', handler: [a.handler, b.handler] }).stream('hi', CONTEXT)) {
      seen.push(e);
    }
    await waitForShadowsForTesting();
    expect(seen.at(-1)?.type).toBe('done');
    expect(b.calls).toHaveLength(1);
  });
});

describe('§9.4 running a shadow', () => {
  it('gets the same input and a stripped config', async () => {
    enableShadowRequests();
    const history: Message[] = [{ role: 'user', content: 'earlier' }];
    const { b } = await invoke(makeClient(variationA()), { userInput: 'question', history });
    const call = b.calls[0];
    expect(call.input).toBe('question');
    expect(call.history).toEqual(history);
    expect(call.variables.topic).toBe('x');
    expect(call.config).not.toHaveProperty('tools');
    expect(call.config).not.toHaveProperty('judgeConfiguration');
    expect(call.tools ?? {}).toEqual({});
  });

  it('never adds the shadow answer to history', async () => {
    enableShadowRequests();
    const history: Message[] = [{ role: 'user', content: 'earlier' }];
    await invoke(makeClient(variationA()), { history });
    expect(history).toEqual([{ role: 'user', content: 'earlier' }]);
  });

  it('keeps a failing shadow away from the caller', async () => {
    enableShadowRequests();
    const client = await use(makeClient(variationA()));
    const a = recorder('TestProvider', 'real answer');
    const b = recorder('ShadowProvider', 'ok', { rejects: true });
    const response = await config({ key: 'flag', handler: [a.handler, b.handler] }).invoke('hi', CONTEXT);
    await waitForShadowsForTesting();
    expect(response.response).toBe('real answer');
    expect(realEvents(client).map((e) => e[0])).toContain('$ld:ai:generation:success');
    expect(shadowEvents(client).map((e) => e[0])).toContain('$ld:ai:generation:error');
  });

  it('records a timeout as an error', async () => {
    enableShadowRequests({ timeoutMs: 20 });
    const client = await use(makeClient(variationA()));
    const a = recorder('TestProvider', 'real answer');
    const b = recorder('ShadowProvider', 'ok', { sleepMs: 500 });
    const response = await config({ key: 'flag', handler: [a.handler, b.handler] }).invoke('hi', CONTEXT);
    await waitForShadowsForTesting();
    expect(response.response).toBe('real answer');
    const names = shadowEvents(client).map((e) => e[0]);
    expect(names).toContain('$ld:ai:generation:error');
    expect(names).toContain('$ld:ai:duration:total');
  });

  it('leaves the real run unchanged', async () => {
    const baselineClient = makeClient(variationA());
    const baseline = await invoke(baselineClient);
    await shutdown();
    enableShadowRequests();
    const client = makeClient(variationA());
    const shadowed = await invoke(client);
    expect(shadowed.response.response).toBe(baseline.response.response);
    expect(shadowed.response.usage).toEqual(baseline.response.usage);
    expect(realEvents(client).map((e) => e[0])).toEqual(realEvents(baselineClient).map((e) => e[0]));
  });
});

describe('§9.5 automatic and deferred modes', () => {
  it('runs nothing inline in deferred mode', async () => {
    const tasks: ShadowTask[] = [];
    enableShadowRequests({ onTask: (t) => tasks.push(t) });
    const client = makeClient(variationA());
    const { a, b } = await invoke(client);
    expect(a.calls).toHaveLength(1);
    expect(b.calls).toHaveLength(0);
    expect(tasks).toHaveLength(1);
    expect(shadowEvents(client)).toEqual([]);
  });

  it('hands over a task that survives structuredClone and JSON', async () => {
    const tasks: ShadowTask[] = [];
    enableShadowRequests({ onTask: (t) => tasks.push(t) });
    await invoke(makeClient(variationA()));
    expect(structuredClone(tasks[0])).toEqual(tasks[0]);
    expect(JSON.parse(JSON.stringify(tasks[0])).shadowRequestId).toBe('shadow-1');
  });

  it('runShadow tracks the same events as automatic mode', async () => {
    const tasks: ShadowTask[] = [];
    enableShadowRequests({ onTask: (t) => tasks.push(t) });
    const deferredClient = makeClient(variationA());
    await invoke(deferredClient);
    const result = await runShadow(tasks[0], [recorder('ShadowProvider', 'shadow answer').handler]);
    expect(result.error).toBeUndefined();
    expect(result.trackData).toMatchObject({ isShadow: true });
    const strip = (es: Event[]) => es.map(([name, { runId: _r, ...data }]) => [name, data]);
    const deferred = strip(shadowEvents(deferredClient));

    await shutdown();
    enableShadowRequests();
    const autoClient = makeClient(variationA());
    await invoke(autoClient);
    expect(deferred).toEqual(strip(shadowEvents(autoClient)));
  });

  it('does not fail the call when onTask throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    enableShadowRequests({
      onTask: () => {
        throw new Error('queue full');
      },
    });
    const { response, a } = await invoke(makeClient(variationA()));
    expect(response.response).toBe('real answer');
    expect(a.calls).toHaveLength(1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('runShadow never rejects', async () => {
    const tasks: ShadowTask[] = [];
    enableShadowRequests({ onTask: (t) => tasks.push(t) });
    await invoke(makeClient(variationA()));
    const result = await runShadow(tasks[0], [recorder('ShadowProvider', 'ok', { rejects: true }).handler]);
    expect(result.error).toBeTruthy();
  });

  it('runShadow reports usage', async () => {
    const tasks: ShadowTask[] = [];
    enableShadowRequests({ onTask: (t) => tasks.push(t) });
    const client = makeClient(variationA());
    await invoke(client);
    await runShadow(tasks[0], [recorder('ShadowProvider').handler]);
    const helpers = client.track.mock.calls.filter((c) => c[0] === '$ld:ai:sdk:usage').map((c) => c[2]?.helper);
    expect(helpers).toContain('experimental.runShadow');
  });
});

describe('§9.6 core invocation hook', () => {
  it('does not fail the call when a hook throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    registerInvocationHook('test-bad-hook', () => {
      throw new Error('hook boom');
    });
    try {
      const { response, a } = await invoke(makeClient(variationA()));
      expect(response.response).toBe('real answer');
      expect(a.calls).toHaveLength(1);
      expect(warn).toHaveBeenCalled();
    } finally {
      registerInvocationHook('test-bad-hook', undefined);
      warn.mockRestore();
    }
  });

  it('sees the run id of the real run', async () => {
    const seen: InvocationEvent[] = [];
    registerInvocationHook('test-seen', (e) => seen.push(e));
    try {
      const { response } = await invoke(makeClient(variationA()));
      expect(seen[0].runId).toBe(response.trackData.runId);
      expect(seen[0].reason).toEqual(FALLTHROUGH);
    } finally {
      registerInvocationHook('test-seen', undefined);
    }
  });
});

describe('§9.7 shadow events and spans', () => {
  it('describes variation b on shadow events', async () => {
    enableShadowRequests();
    const client = makeClient(variationA());
    const { response } = await invoke(client);
    const shadow = shadowEvents(client);
    for (const name of ['$ld:ai:duration:total', '$ld:ai:generation:success', '$ld:ai:tokens:total']) {
      expect(shadow.map((e) => e[0])).toContain(name);
    }
    expect(shadow[0][1]).toMatchObject({
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
    enableShadowRequests();
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
    enableShadowRequests();
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
