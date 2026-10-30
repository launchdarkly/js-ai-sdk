/**
 * `$ld:ai:sdk:usage`.
 */
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockLdInit } = vi.hoisted(() => ({ mockLdInit: vi.fn() }));
vi.mock('@launchdarkly/node-server-sdk', () => ({
  init: (...args: unknown[]) => mockLdInit(...args),
}));
// initClient(client) sets up telemetry, and shutdown() in afterEach would otherwise flush the
// graph tests' spans to the real OTLP endpoint and time out on a slow network.
vi.mock('@opentelemetry/exporter-trace-otlp-http', () => ({
  OTLPTraceExporter: class {
    export(_spans: unknown, done: (result: { code: number }) => void) {
      done({ code: 0 });
    }
    shutdown() {
      return Promise.resolve();
    }
    forceFlush() {
      return Promise.resolve();
    }
  },
}));

import { usageRows } from '../../../../scripts/api-surface.mjs';
import { config } from '../client.js';
import * as experimentalEntry from '../experimental.js';
import { graph } from '../graph.js';
import * as rootEntry from '../index.js';
import { buildJudgeTasks } from '../judges.js';
import { initClient, shutdown } from '../lifecycle.js';
import { SDK_INFO_CONTEXT } from '../sdk-info.js';
import { reportUsage } from '../sdk-usage.js';
import { getSkill, InMemorySkillStore, setSkillStore, skillRefs } from '../skills.js';
import { watchSkills } from '../skills-watch.js';
import type {
  HandlerStreamEvent,
  JudgeTask,
  LDClientInterface,
  LDContext,
  ProviderHandler,
  RawSkillObject,
  ReconcileReport,
  TrackData,
} from '../types.js';
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

function usageHelpers(client: FakeClient): unknown[] {
  return usageCalls(client).map((call) => (call[2] as { helper?: string } | undefined)?.helper);
}

function nonUsageCalls(client: FakeClient): unknown[][] {
  return client.track.mock.calls.filter((call) => call[0] !== '$ld:ai:sdk:usage' && call[0] !== '$ld:ai:sdk:info');
}

function expectNoUsageFields(calls: unknown[][]): void {
  for (const call of calls) {
    expect(call[2]).not.toHaveProperty('helper');
    expect(call[2]).not.toHaveProperty('helperPackageName');
    expect(call[2]).not.toHaveProperty('helperPackageVersion');
    expect(call[2]).not.toHaveProperty('aiSdkName');
    expect(call[2]).not.toHaveProperty('aiSdkVersion');
    expect(call[2]).not.toHaveProperty('aiSdkLanguage');
  }
}

async function drain(stream: AsyncGenerator<unknown>): Promise<void> {
  for await (const _event of stream) {
    // Iterating runs the whole call; the events themselves are not under test here.
  }
}

const enabledConfig = {
  model: { name: 'gpt-4o' },
  provider: { name: 'OpenAI' },
  instructions: 'Be helpful.',
  _ldMeta: { enabled: true, variationKey: 'v1', version: 1, mode: 'messages' },
};

/** Serves a one-node graph at `graph-flag` and an enabled config at every other key. */
function graphVariation(key: string): unknown {
  if (key === 'graph-flag') return { root: 'root-node', edges: {} };
  return enabledConfig;
}

function okHandler(): ProviderHandler {
  const handler = vi.fn().mockResolvedValue({
    output: 'ok',
    usage: { input_tokens: 2, output_tokens: 3 },
  }) as unknown as ProviderHandler;
  handler.providesFor = ['OpenAI', 'messages'];
  return handler;
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
    helperPackageName: LD_AI_PACKAGE_NAME,
    helperPackageVersion: LD_AI_PACKAGE_VERSION,
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

const SKILL_CONTENT = '---\nname: Usage Skill\n---\nDo the thing.\n';

/** A store holding one valid skill, `usage-skill` v1. */
function skillStore(): InMemorySkillStore {
  return new InMemorySkillStore({
    'usage-skill': {
      key: 'usage-skill',
      version: 1,
      content: SKILL_CONTENT,
      contentHash: createHash('sha256').update(SKILL_CONTENT, 'utf-8').digest('hex'),
      name: 'Usage Skill',
      description: 'A skill used in the usage tests.',
    } as RawSkillObject,
  });
}

async function withSkillsRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'ld-usage-skills-'));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Each call receives the export the list names, whatever its signature. */
type Call = (fn: any) => Promise<void>;

const fire = (call: () => unknown): Promise<void> => {
  call();
  return Promise.resolve();
};

/**
 * How to call each usage-reporting helper. Which helpers are tested comes from
 * the approved lists' `usage=` fields, and each call receives the function the
 * entry point exports under the name the list gives, so a row proves that
 * name reports that ID.
 */
const CALLS: Record<string, Call> = {
  'client.config.invoke': (config) => settle(config({ key: 'k' }).invoke('q', ctx)),
  'client.config.stream': (config) => fire(() => config({ key: 'k' }).stream('q', ctx)),
  'client.graph.invoke': (graph) => settle(graph('k', {}).invoke('q', ctx)),
  'client.graph.stream': (graph) => fire(() => graph('k', {}).stream('q', ctx)),
  'client.resolveGraph': (resolveGraph) => settle(resolveGraph('k', { context: ctx })),
  'client.inspectConfig': (inspectConfig) => settle(inspectConfig('k', ctx)),
  'client.runJudge': (runJudge) => settle(runJudge({} as JudgeTask, [])),
  'client.buildJudgeTasks': (buildJudgeTasks) => settle(buildJudgeTasks(judgeArgs())),
  'client.createHandler': (createHandler) =>
    fire(() => createHandler(['OpenAI', 'messages'], async () => ({ output: '' }))),
  // Throws on missing credentials; the report is the first statement, so it still lands.
  'client.initEvaluations': (initEvaluations) =>
    fire(() => {
      try {
        initEvaluations({ projectKey: 'p', apiKey: 't', sdkKey: 's' });
      } catch {}
    }),
  // Agent Skills. install() runs shutdown(), which clears the store, so each call sets one.
  'client.skillRefs': (skillRefs) =>
    fire(() => skillRefs({ ...enabledConfig, skills: [{ key: 'usage-skill', version: 1 }] })),
  'client.getSkill': (getSkill) => {
    setSkillStore(skillStore());
    return settle(getSkill('usage-skill'));
  },
  'client.getSkillResult': (getSkillResult) => {
    setSkillStore(skillStore());
    return settle(getSkillResult('usage-skill'));
  },
  'client.getSkills': (getSkills) => {
    setSkillStore(skillStore());
    return settle(getSkills(['usage-skill']));
  },
  // Builds a source and does not read it.
  'client.configSkills': (configSkills) => fire(() => configSkills('k', ctx)),
  'client.allSkills': (allSkills) => {
    setSkillStore(skillStore());
    return settle(allSkills());
  },
  'client.writeSkills': (writeSkills) => {
    setSkillStore(skillStore());
    return withSkillsRoot(async (root) => {
      await writeSkills(['usage-skill'], root);
    });
  },
  'client.watchSkills': (watchSkills) => {
    setSkillStore(skillStore());
    return withSkillsRoot(async (root) => {
      const { watcher } = await watchSkills(['usage-skill'], root);
      await watcher.close();
    });
  },
};

const listRows = [
  ...usageRows('ai-server.txt', rootEntry),
  ...usageRows('ai-server.experimental.txt', experimentalEntry),
];

const rows: Array<[string, () => Promise<void>]> = listRows.map(({ id, fn }) => [id, () => CALLS[id](fn)]);

it('has a call for every usage ID the lists report, and none they do not', () => {
  expect(Object.keys(CALLS).sort()).toEqual([...new Set(listRows.map(({ id }) => id))].sort());
});

describe('helper usage', () => {
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
    expect(usageHelpers(client)).toEqual([helper]);
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

  it("keeps a held helper's own package name and version until the client exists", async () => {
    await shutdown();
    reportUsage('openai-messages.openaiMessages', '@launchdarkly/ai-openai-messages', '9.8.7');
    client = fakeClient();
    await initClient(client);
    const calls = usageCalls(client, 'openai-messages.openaiMessages');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[2]).toEqual({
      aiSdkName: LD_AI_PACKAGE_NAME,
      aiSdkVersion: LD_AI_PACKAGE_VERSION,
      aiSdkLanguage: 'javascript',
      helper: 'openai-messages.openaiMessages',
      helperPackageName: '@launchdarkly/ai-openai-messages',
      helperPackageVersion: '9.8.7',
    });
  });

  it('sends a pre-init helper on the fresh-init (SDK key) path', async () => {
    await shutdown();
    await buildJudgeTasks(judgeArgs());
    client = fakeClient();
    (client as unknown as { waitForInitialization: () => Promise<void> }).waitForInitialization = vi
      .fn()
      .mockResolvedValue(undefined);
    mockLdInit.mockReturnValue(client);
    expect(usageCalls(client, 'client.buildJudgeTasks')).toHaveLength(0);
    await initClient({ sdkKey: 'sdk-test-key' });
    expect(mockLdInit).toHaveBeenCalledWith('sdk-test-key', expect.any(Object));
    expectUsage(client, 'client.buildJudgeTasks');
  });

  it('sends a pre-init helper on the already-initialized path', async () => {
    await shutdown();
    await buildJudgeTasks(judgeArgs());
    // Install a client without going through initClient, as a test-only setter would.
    client = fakeClient();
    const singleton = (globalThis as any)[Symbol.for('@launchdarkly/ai-server:singleton')];
    singleton.client = client;
    singleton.initPromise = Promise.resolve(client);
    expect(usageCalls(client, 'client.buildJudgeTasks')).toHaveLength(0);
    await initClient();
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
      expect(call[2]).not.toHaveProperty('helperPackageName');
      expect(call[2]).not.toHaveProperty('helperPackageVersion');
      expect(call[2]).not.toHaveProperty('aiSdkName');
      expect(call[2]).not.toHaveProperty('aiSdkVersion');
      expect(call[2]).not.toHaveProperty('aiSdkLanguage');
    }
  });
});

describe('one call emits only its own helper', () => {
  let client: FakeClient;

  beforeEach(async () => {
    client = await install();
    client.variation.mockImplementation(async (key: string) => graphVariation(key));
  });

  afterEach(async () => {
    await shutdown();
  });

  it('config().invoke with skipJudges emits only client.config.invoke', async () => {
    await config({ key: 'flag', handler: okHandler(), skipJudges: true }).invoke('q', ctx);
    expect(usageHelpers(client)).toEqual(['client.config.invoke']);
  });

  it('config().stream emits only client.config.stream when drained', async () => {
    await drain(config({ key: 'flag', handler: okHandler() }).stream('q', ctx));
    expect(usageHelpers(client)).toEqual(['client.config.stream']);
  });

  it('graph().invoke emits only client.graph.invoke', async () => {
    const result = await graph('graph-flag', { handlers: [okHandler()] }).invoke('q', ctx);
    expect(result.response).toBe('ok');
    expect(usageHelpers(client)).toEqual(['client.graph.invoke']);
  });

  it('graph().stream emits only client.graph.stream when drained', async () => {
    await drain(graph('graph-flag', { handlers: [okHandler()] }).stream('q', ctx));
    expect(usageHelpers(client)).toEqual(['client.graph.stream']);
  });

  it('leaves graph payloads unchanged', async () => {
    await graph('graph-flag', { handlers: [okHandler()] }).invoke('q', ctx);
    const graphCalls = nonUsageCalls(client).filter((call) => String(call[0]).startsWith('$ld:ai:graph:'));
    expect(graphCalls.length).toBeGreaterThan(0);
    expectNoUsageFields(nonUsageCalls(client));
  });
});

describe('a helper called from application code inside a call still reports', () => {
  let client: FakeClient;

  beforeEach(async () => {
    client = await install({
      ...enabledConfig,
      tools: { lookup: { name: 'lookup', type: 'function', parameters: {} } },
    });
  });

  afterEach(async () => {
    await shutdown();
  });

  /** A user handler whose body calls a public helper, the way application code may. */
  function helperCallingHandler(): ProviderHandler {
    const handler = vi.fn(async () => {
      await buildJudgeTasks(judgeArgs());
      return { output: 'ok', usage: { input_tokens: 1, output_tokens: 1 } };
    }) as unknown as ProviderHandler;
    handler.providesFor = ['OpenAI', 'messages'];
    return handler;
  }

  /** A user handler that calls the `lookup` tool; the tool body calls a public helper. */
  function toolCallingHandler(): ProviderHandler {
    const handler = vi.fn(
      async (_config: unknown, _input?: string, toolHandlers?: Record<string, (...args: unknown[]) => unknown>) => {
        await toolHandlers?.lookup?.({ q: 'x' });
        return { output: 'ok', usage: { input_tokens: 1, output_tokens: 1 } };
      },
    ) as unknown as ProviderHandler;
    handler.providesFor = ['OpenAI', 'messages'];
    return handler;
  }

  const lookup = async () => {
    await buildJudgeTasks(judgeArgs());
    return 'found';
  };

  it('reports a helper the user handler calls during config().invoke', async () => {
    await config({ key: 'flag', handler: helperCallingHandler() }).invoke('q', ctx);
    expect(usageHelpers(client)).toEqual(['client.config.invoke', 'client.buildJudgeTasks']);
  });

  it('reports a helper the user handler calls during config().stream', async () => {
    await drain(config({ key: 'flag', handler: helperCallingHandler() }).stream('q', ctx));
    expect(usageHelpers(client)).toEqual(['client.config.stream', 'client.buildJudgeTasks']);
  });

  it('reports a helper a tool handler calls during config().invoke, and leaves the tool-call payload unchanged', async () => {
    await config({ key: 'flag', handler: toolCallingHandler(), toolHandlers: { lookup } }).invoke('q', ctx);
    expect(usageHelpers(client)).toEqual(['client.config.invoke', 'client.buildJudgeTasks']);
    const toolCalls = nonUsageCalls(client).filter((call) => call[0] === '$ld:ai:tool_call');
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]?.[2]).toMatchObject({ toolKey: 'lookup' });
    expectNoUsageFields(nonUsageCalls(client));
  });

  it('reports a helper a tool handler calls during config().stream', async () => {
    const handler = toolCallingHandler();
    handler.stream = async function* (
      _config: unknown,
      _input?: string,
      toolHandlers?: Record<string, (...args: unknown[]) => unknown>,
    ): AsyncGenerator<HandlerStreamEvent> {
      await toolHandlers?.lookup?.({ q: 'x' });
      yield { type: 'chunk', text: 'ok' };
      yield { type: 'done', usage: { input_tokens: 1, output_tokens: 1 } };
    };
    await drain(config({ key: 'flag', handler, toolHandlers: { lookup } }).stream('q', ctx));
    expect(usageHelpers(client)).toEqual(['client.config.stream', 'client.buildJudgeTasks']);
  });
});

describe('Agent Skills helper usage', () => {
  let client: FakeClient;

  beforeEach(async () => {
    client = await install();
  });

  afterEach(async () => {
    await shutdown();
  });

  it('getSkill reports once per client, and once more after shutdown and a new client', async () => {
    setSkillStore(skillStore());
    await getSkill('usage-skill');
    await getSkill('usage-skill');
    expectUsage(client, 'client.getSkill');

    await shutdown();
    client = await install();
    // shutdown clears the store, so configure it again.
    setSkillStore(skillStore());
    await getSkill('usage-skill');
    expectUsage(client, 'client.getSkill');
  });

  it('skillRefs called before a client exists reports once the client exists', async () => {
    await shutdown();
    // skillRefs needs neither a client nor a store.
    skillRefs({ ...enabledConfig, skills: [{ key: 'usage-skill', version: 1 }] });
    client = fakeClient();
    expect(usageCalls(client, 'client.skillRefs')).toHaveLength(0);
    await initClient(client);
    expectUsage(client, 'client.skillRefs');
  });

  it('a getSkill that raises with no store configured still reports', async () => {
    await expect(getSkill('usage-skill')).rejects.toThrow();
    expectUsage(client, 'client.getSkill');
  });

  it('watchSkills reports only itself, including when the watcher reconciles again', async () => {
    const store = skillStore();
    setSkillStore(store);
    await withSkillsRoot(async (root) => {
      let reconciled: (report: ReconcileReport) => void = () => {};
      const again = new Promise<ReconcileReport>((resolve) => {
        reconciled = resolve;
      });
      const { watcher } = await watchSkills(['usage-skill'], root, { debounceMs: 0, onReconcile: reconciled });
      try {
        const content = `${SKILL_CONTENT}Again.\n`;
        store.put({
          key: 'usage-skill',
          version: 2,
          content,
          contentHash: createHash('sha256').update(content, 'utf-8').digest('hex'),
          name: 'Usage Skill',
          description: 'A skill used in the usage tests.',
        } as RawSkillObject);
        await again;
      } finally {
        await watcher.close();
      }
    });
    expect(usageHelpers(client)).toEqual(['client.watchSkills']);
  });

  it('every skills usage ID on the lists is client.*', () => {
    const skillsIds = listRows.map(({ id }) => id).filter((id) => /skill/i.test(id));
    expect(skillsIds).toHaveLength(8);
    expect(skillsIds.filter((id) => !id.startsWith('client.'))).toEqual([]);
  });
});
