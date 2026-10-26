/**
 * TESTING.md §2.x "Claude Agents Skills Integration", A.21.
 *
 * `query()` is mocked; everything else is real: the skills store, `writeSkills`, the filesystem
 * under a per-test temp directory, and an OTel tracer provider for the span assertion. What the
 * run sees is captured from inside the mocked `query()`, while the per-invoke directory exists.
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import {
  InMemorySkillStore,
  NATIVE_TOOL_KEY,
  NativeTool,
  type RawSkillObject,
  setSkillStore,
  shutdown,
} from '@launchdarkly/ai-server';
import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mockQuery = vi.fn();

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (...args: any[]) => mockQuery(...args),
  tool: vi.fn().mockReturnValue({}),
  createSdkMcpServer: vi.fn().mockReturnValue({}),
}));

import { createClaudeAgentsHandler } from '../handler.js';
import * as packageRoot from '../index.js';
import { createClaudeAgentsSkillsHandler } from '../skills.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const exporter = new InMemorySpanExporter();
/** While `on`, `onEnd` throws, as an application's span processor might. The SDK doesn't catch it. */
const failOnEnd = { on: false };
const throwingProcessor: SpanProcessor = {
  onStart: () => undefined,
  onEnd: () => {
    if (failOnEnd.on) throw new Error('span processor failed');
  },
  forceFlush: async () => undefined,
  shutdown: async () => undefined,
};
const provider = new BasicTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter), throwingProcessor],
});
const contextManager = new AsyncLocalStorageContextManager();

beforeAll(() => {
  contextManager.enable();
  context.setGlobalContextManager(contextManager);
  trace.setGlobalTracerProvider(provider);
});

afterAll(() => {
  trace.disable();
  context.disable();
});

const baseConfig = {
  model: { name: 'claude-opus-4-5' },
  provider: { name: 'Anthropic' },
  instructions: 'You are helpful.',
};

const withSkills = (skills: Array<{ key: string; version: number }>, extra: Record<string, unknown> = {}) => ({
  ...baseConfig,
  ...extra,
  skills,
});

const sha256 = (text: string) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');

const rawSkill = (key: string, version: number, content = `# ${key} v${version}\n`): RawSkillObject => ({
  key,
  version,
  content,
  contentHash: sha256(content),
});

const nativeStub = (toolName: string, spy = vi.fn()) => {
  const stub = (...args: unknown[]) => spy(...args);
  (stub as any)[NATIVE_TOOL_KEY] = new NativeTool(Symbol(toolName), toolName);
  return stub;
};

/** What one run saw, captured inside `query()` while its directory existed. */
type Seen = { options: Record<string, any>; files: Record<string, string>; skillsDir: string | undefined };

function skillFiles(skillsDir: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    files[entry.name] = readFileSync(join(skillsDir, entry.name, 'SKILL.md'), 'utf8');
  }
  return files;
}

/** A `query()` that records what the run saw and then answers with a success result. */
function recordingQuery(seen: Seen[], before?: (options: Record<string, any>) => Promise<void> | void) {
  return async function* ({ options }: { options: Record<string, any> }) {
    const pluginPath: string | undefined = options.plugins?.[0]?.path;
    const skillsDir = pluginPath === undefined ? undefined : join(pluginPath, 'skills');
    seen.push({ options, files: skillsDir && existsSync(skillsDir) ? skillFiles(skillsDir) : {}, skillsDir });
    await before?.(options);
    yield {
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'ok' } },
    };
    yield { type: 'result', subtype: 'success', result: 'ok', usage: { input_tokens: 1, output_tokens: 1 } };
  };
}

async function drain(stream: AsyncGenerator<unknown> | undefined): Promise<void> {
  for await (const _ of stream ?? []) {
    // drain
  }
}

let parent: string;
let store: InMemorySkillStore;

beforeEach(async () => {
  vi.clearAllMocks();
  exporter.reset();
  await shutdown();
  parent = await realpath(await mkdtemp(join(tmpdir(), 'ld-skills-test-')));
  store = new InMemorySkillStore();
  setSkillStore(store);
});

afterEach(async () => {
  await shutdown();
  await rm(parent, { recursive: true, force: true });
});

const handlerFor = (options: Record<string, unknown> = {}) =>
  createClaudeAgentsSkillsHandler({ skillsTempDir: parent, ...options } as any);

const parentIsEmpty = () => expect(readdirSync(parent)).toEqual([]);

// ─── Routing, options and the no-skills path ─────────────────────────────────

describe('routing and options', () => {
  it('routes as the core handler does', () => {
    expect(handlerFor().providesFor).toEqual(['Anthropic', 'agent']);
  });

  it('forwards the core host options', async () => {
    store.put(rawSkill('a', 1));
    const seen: Seen[] = [];
    mockQuery.mockImplementation(recordingQuery(seen));
    await handlerFor({ cwd: '/srv/app', settingSources: [] })(withSkills([{ key: 'a', version: 1 }]) as any, 'q');
    expect(seen[0].options.cwd).toBe('/srv/app');
    expect(seen[0].options.settingSources).toEqual([]);
  });

  it('loads the same settings sources as the core handler when skills are enabled', async () => {
    store.put(rawSkill('a', 1));
    const seen: Seen[] = [];
    mockQuery.mockImplementation(recordingQuery(seen));
    await handlerFor()(withSkills([{ key: 'a', version: 1 }]) as any, 'q');
    await createClaudeAgentsHandler()(withSkills([{ key: 'a', version: 1 }]) as any, 'q');
    expect(seen[0].options.settingSources).toEqual([]);
    expect(seen[0].options.settingSources).toEqual(seen[1].options.settingSources);
  });
});

describe('entry points', () => {
  it('exports the integration from the package root', () => {
    expect(packageRoot.createClaudeAgentsSkillsHandler).toBe(createClaudeAgentsSkillsHandler);
  });
});

describe('a config with no skills', () => {
  it.each([
    ['absent', baseConfig],
    ['empty', withSkills([])],
  ])('runs exactly as the core handler would when skills are %s', async (_label, config) => {
    // No store either: a config with no skills needs none.
    await shutdown();
    const seen: Seen[] = [];
    mockQuery.mockImplementation(recordingQuery(seen));
    await handlerFor({ captureContent: false })(config as any, 'q');
    await createClaudeAgentsHandler({ captureContent: false })(config as any, 'q');
    const [skillsRun, coreRun] = seen.map((s) => s.options);
    expect(Object.hasOwn(skillsRun, 'plugins')).toBe(false);
    expect(Object.hasOwn(skillsRun, 'skills')).toBe(false);
    expect(skillsRun.tools).toEqual([]);
    expect(skillsRun).toEqual(coreRun);
    parentIsEmpty();
  });
});

// ─── Materialization ─────────────────────────────────────────────────────────

describe('materialization', () => {
  it("writes the variation's skills into a private plugin directory for the run", async () => {
    store.put(rawSkill('a', 1));
    store.put(rawSkill('b', 1));
    const seen: Seen[] = [];
    mockQuery.mockImplementation(recordingQuery(seen));
    await handlerFor()(
      withSkills([
        { key: 'a', version: 1 },
        { key: 'b', version: 1 },
      ]) as any,
      'q',
    );
    const pluginPath: string = seen[0].options.plugins[0].path;
    expect(basename(pluginPath)).toBe('launchdarkly');
    expect(basename(dirname(pluginPath)).startsWith('ld-skills-')).toBe(true);
    expect(dirname(dirname(pluginPath))).toBe(parent);
    expect(seen[0].files).toEqual({ a: '# a v1\n', b: '# b v1\n' });
  });

  it('honors a pinned version', async () => {
    for (const version of [1, 2, 3]) store.put(rawSkill('a', version));
    const seen: Seen[] = [];
    mockQuery.mockImplementation(recordingQuery(seen));
    await handlerFor()(withSkills([{ key: 'a', version: 2 }]) as any, 'q');
    expect(seen[0].files).toEqual({ a: '# a v2\n' });
  });

  describe('removes the directory when the run ends', () => {
    const config = withSkills([{ key: 'a', version: 1 }]);
    beforeEach(() => store.put(rawSkill('a', 1)));

    it('after a successful run', async () => {
      mockQuery.mockImplementation(recordingQuery([]));
      await handlerFor()(config as any, 'q');
      parentIsEmpty();
    });

    it('after query() throws', async () => {
      mockQuery.mockImplementation(async function* () {
        yield* [];
        throw new Error('cli crashed');
      });
      await expect(handlerFor()(config as any, 'q')).rejects.toThrow('cli crashed');
      parentIsEmpty();
    });

    it('after a non-success result', async () => {
      mockQuery.mockImplementation(async function* () {
        yield { type: 'result', subtype: 'error_max_turns', errors: [], usage: {} };
      });
      await expect(handlerFor()(config as any, 'q')).rejects.toThrow(/error_max_turns/);
      parentIsEmpty();
    });

    it('after a stream completes', async () => {
      mockQuery.mockImplementation(recordingQuery([]));
      await drain(handlerFor().stream?.(config as any, 'q'));
      parentIsEmpty();
    });

    it('after a stream consumer stops early', async () => {
      mockQuery.mockImplementation(recordingQuery([]));
      const stream = handlerFor().stream?.(config as any, 'q');
      await stream?.next();
      await stream?.return(undefined);
      parentIsEmpty();
    });

    it('after closing the stream spans throws', async () => {
      mockQuery.mockImplementation(recordingQuery([]));
      const stream = handlerFor().stream?.(config as any, 'q');
      await stream?.next();
      failOnEnd.on = true;
      try {
        await expect(stream?.return(undefined)).rejects.toThrow('span processor failed');
      } finally {
        failOnEnd.on = false;
      }
      parentIsEmpty();
    });
  });

  it('gives concurrent invokes their own directories', async () => {
    store.put(rawSkill('a', 1));
    // Each run parks inside query() until released. Runs may enter in either order, so each
    // release is paired with the directory of the run it belongs to.
    const runs: Array<{ dir: string; release: () => void }> = [];
    let bothEntered: () => void = () => undefined;
    const entered = new Promise<void>((resolve) => {
      bothEntered = resolve;
    });
    mockQuery.mockImplementation(async function* ({ options }: { options: Record<string, any> }) {
      await new Promise<void>((release) => {
        runs.push({ dir: dirname(options.plugins[0].path), release });
        if (runs.length === 2) bothEntered();
      });
      yield { type: 'result', subtype: 'success', result: 'ok', usage: { input_tokens: 1, output_tokens: 1 } };
    });
    const handler = handlerFor();
    const config = withSkills([{ key: 'a', version: 1 }]);
    const invokes = [handler(config as any, 'q'), handler(config as any, 'q')];
    await entered;
    const [early, late] = runs;
    expect(early.dir).not.toBe(late.dir);
    expect(existsSync(early.dir) && existsSync(late.dir)).toBe(true);
    early.release();
    await Promise.race(invokes);
    expect(existsSync(early.dir)).toBe(false);
    expect(existsSync(late.dir)).toBe(true);
    late.release();
    await Promise.all(invokes);
    parentIsEmpty();
  });

  it('stops writing a skill once the variation no longer references it', async () => {
    store.put(rawSkill('a', 1));
    store.put(rawSkill('b', 1));
    const seen: Seen[] = [];
    mockQuery.mockImplementation(recordingQuery(seen));
    const handler = handlerFor();
    await handler(
      withSkills([
        { key: 'a', version: 1 },
        { key: 'b', version: 1 },
      ]) as any,
      'q',
    );
    await handler(withSkills([{ key: 'a', version: 1 }]) as any, 'q');
    expect(Object.keys(seen[0].files).sort()).toEqual(['a', 'b']);
    expect(Object.keys(seen[1].files)).toEqual(['a']);
  });
});

// ─── Fail closed ─────────────────────────────────────────────────────────────

describe('fail closed', () => {
  const config = withSkills([{ key: 'a', version: 1 }]);

  it.each([
    [
      'no store is configured',
      async () => {
        await shutdown();
      },
    ],
    [
      'the store has not initialized',
      () => {
        setSkillStore({ getObject: () => null, allObjects: () => ({}), isInitialized: () => false } as any);
      },
    ],
    [
      'the skill fails verification',
      () => {
        store.put({ ...rawSkill('a', 1), contentHash: sha256('something else') });
      },
    ],
    ['the pinned skill is absent', () => undefined],
  ] as Array<[string, () => unknown]>)('throws before query() when %s', async (_label, arrange) => {
    await arrange();
    mockQuery.mockImplementation(recordingQuery([]));
    await expect(handlerFor()(config as any, 'q')).rejects.toThrow(/\ba\b/);
    expect(mockQuery).not.toHaveBeenCalled();
    parentIsEmpty();
  });

  it('does not start the run with the skills that did resolve', async () => {
    store.put(rawSkill('a', 1));
    store.put({ ...rawSkill('b', 1), contentHash: sha256('tampered') });
    mockQuery.mockImplementation(recordingQuery([]));
    const both = withSkills([
      { key: 'a', version: 1 },
      { key: 'b', version: 1 },
    ]);
    await expect(handlerFor()(both as any, 'q')).rejects.toThrow(/\bb\b/);
    expect(mockQuery).not.toHaveBeenCalled();
    parentIsEmpty();
  });

  it('never puts skill content in the error', async () => {
    store.put({ ...rawSkill('a', 1, 'SECRET-SKILL-BODY'), contentHash: sha256('other') });
    mockQuery.mockImplementation(recordingQuery([]));
    const error = await handlerFor()(config as any, 'q').catch((e: unknown) => e);
    expect(String((error as Error).message)).not.toContain('SECRET-SKILL-BODY');
  });

  it('fails the stream path the same way', async () => {
    mockQuery.mockImplementation(recordingQuery([]));
    await expect(drain(handlerFor().stream?.(config as any, 'q'))).rejects.toThrow(/\ba\b/);
    expect(mockQuery).not.toHaveBeenCalled();
    parentIsEmpty();
  });
});

// ─── What query() receives ───────────────────────────────────────────────────

describe('query() options', () => {
  beforeEach(() => {
    store.put(rawSkill('b', 1));
    store.put(rawSkill('a', 1));
  });
  const refs = [
    { key: 'b', version: 1 },
    { key: 'a', version: 1 },
  ];

  it.each(['invoke', 'stream'] as const)('passes one local plugin and the qualified skills (%s)', async (path) => {
    const seen: Seen[] = [];
    mockQuery.mockImplementation(recordingQuery(seen));
    const handler = handlerFor();
    if (path === 'invoke') await handler(withSkills(refs) as any, 'q');
    else await drain(handler.stream?.(withSkills(refs) as any, 'q'));
    const { options, skillsDir } = seen[0];
    const pluginPath = dirname(skillsDir as string);
    expect(options.plugins).toEqual([{ type: 'local', path: pluginPath, skipMcpDiscovery: true }]);
    expect(options.skills).toEqual(['launchdarkly:b', 'launchdarkly:a']);
    expect(options.tools).toEqual(['Skill']);
    expect(options.allowedTools ?? []).not.toContain('Skill');
  });

  it('writes no plugin manifest', async () => {
    let manifestDir: boolean | undefined;
    mockQuery.mockImplementation(
      recordingQuery([], (options) => {
        manifestDir = existsSync(join(options.plugins[0].path, '.claude-plugin'));
      }),
    );
    await handlerFor()(withSkills(refs) as any, 'q');
    expect(manifestDir).toBe(false);
  });

  it('adds Skill after the native tools, once', async () => {
    const seen: Seen[] = [];
    mockQuery.mockImplementation(recordingQuery(seen));
    await handlerFor()(withSkills(refs) as any, 'q', { read: nativeStub('Read') } as any);
    expect(seen[0].options.tools).toEqual(['Read', 'Skill']);
  });

  it('keeps the handler-owned keys over anything in model.parameters', async () => {
    const seen: Seen[] = [];
    mockQuery.mockImplementation(recordingQuery(seen));
    const config = withSkills(refs, {
      model: {
        name: 'claude-opus-4-5',
        parameters: { plugins: [{ type: 'local', path: '/evil' }], skills: 'all', tools: ['Bash'] },
      },
    });
    await handlerFor()(config as any, 'q');
    expect(seen[0].options.plugins).toHaveLength(1);
    expect(seen[0].options.plugins[0].path).not.toBe('/evil');
    expect(seen[0].options.skills).toEqual(['launchdarkly:b', 'launchdarkly:a']);
    expect(seen[0].options.tools).toEqual(['Skill']);
  });

  it('gives a Skill call an execute_tool span and no native tool-call tracking', async () => {
    const readSpy = vi.fn();
    mockQuery.mockImplementation(async function* ({ options }: { options: Record<string, any> }) {
      const pre = options.hooks?.PreToolUse?.[0]?.hooks?.[0];
      const post = options.hooks?.PostToolUse?.[0]?.hooks?.[0];
      const call = { tool_name: 'Skill', tool_use_id: 'toolu_1', tool_input: { skill: 'launchdarkly:a' } };
      await pre?.({ hook_event_name: 'PreToolUse', ...call });
      await post?.({ hook_event_name: 'PostToolUse', ...call, tool_response: 'loaded' });
      yield { type: 'result', subtype: 'success', result: 'ok', usage: { input_tokens: 1, output_tokens: 1 } };
    });
    await handlerFor()(withSkills(refs) as any, 'q', { read: nativeStub('Read', readSpy) } as any);
    const spans = exporter.getFinishedSpans();
    const skillSpan = spans.find((span) => span.name === 'execute_tool Skill');
    expect(skillSpan?.attributes['gen_ai.tool.name']).toBe('Skill');
    const root = spans.find((span) => span.name === 'invoke_agent');
    expect(skillSpan?.parentSpanContext?.spanId).toBe(root?.spanContext().spanId);
    expect(readSpy).not.toHaveBeenCalled();
  });

  it('installs the tool hooks when Skill is the only tool', async () => {
    const seen: Seen[] = [];
    mockQuery.mockImplementation(recordingQuery(seen));
    await handlerFor()(withSkills(refs) as any, 'q');
    expect(seen[0].options.hooks?.PreToolUse).toBeDefined();
  });
});
