/**
 * `SkillSource`, `configSkills`, and the watcher following AI Config changes.
 *
 * Every test writes only inside its own `os.tmpdir()` scratch directory, and
 * drives a fake base client. `skills-source-sdk.test.ts` drives the real one.
 */

import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockLdInit } = vi.hoisted(() => ({ mockLdInit: vi.fn() }));
vi.mock('@launchdarkly/node-server-sdk', () => ({
  init: (...args: unknown[]) => mockLdInit(...args),
}));

import * as experimentalEntry from '../experimental.js';
import * as rootEntry from '../index.js';
import { getClient, initClient, shutdown } from '../lifecycle.js';
import { resetSdkUsage } from '../sdk-usage.js';
import { _setEmitterForTesting, _setStore } from '../skills.js';
import { SKILL_OBJECT_KIND } from '../skills-core.js';
import { writeSkills } from '../skills-fs.js';
import { configSkills } from '../skills-source.js';
import { watchSkills } from '../skills-watch.js';
import type {
  LDClientInterface,
  LDContext,
  RawSkillObject,
  ReconcileReport,
  SkillReference,
  SkillSource,
  SkillStore,
} from '../types.js';
import { createSkillReference, createSkillSource } from '../types.js';

const ctx: LDContext = { kind: 'user', key: 'user-1' };
const CONFIG_KEY = 'support-agent';
const MANIFEST_NAME = '.launchdarkly-skills.json';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function hash(content: string): string {
  return createHash('sha256').update(Buffer.from(content, 'utf-8')).digest('hex');
}

function body(key: string, version: number): string {
  return `---\nname: ${key}\n---\n${key} v${version}\n`;
}

function rawSkill(key: string, version: number, content = body(key, version)): RawSkillObject {
  return { key, version, content, contentHash: hash(content) };
}

function ref(key: string, version: number): SkillReference {
  return createSkillReference({ key, version });
}

/** A store whose held objects can be replaced wholesale, so a version can leave it. */
class MutableStore implements SkillStore {
  private objects = new Map<string, RawSkillObject>();
  private readonly listeners: Array<(raw: RawSkillObject) => unknown> = [];

  constructor(objects: RawSkillObject[] = []) {
    for (const raw of objects) this.objects.set(`${raw.key}:${raw.version}`, raw);
  }

  /** Adds `add`, drops `remove` (`key:version`), then notifies once per change. */
  change({ add = [], remove = [] }: { add?: RawSkillObject[]; remove?: string[] }): void {
    for (const id of remove) this.objects.delete(id);
    for (const raw of add) this.objects.set(`${raw.key}:${raw.version}`, raw);
    for (const raw of add) for (const listener of [...this.listeners]) listener(raw);
    for (const id of remove) for (const listener of [...this.listeners]) listener({ key: id.split(':')[0] });
  }

  getObject(kind: string, key: string, version?: number | null): RawSkillObject | null {
    if (kind !== SKILL_OBJECT_KIND) return null;
    const held = [...this.objects.values()].filter((raw) => raw.key === key);
    if (held.length === 0) return null;
    if (version !== undefined && version !== null) {
      return held.find((raw) => raw.version === version) ?? held[0] ?? null;
    }
    return held.sort((a, b) => (b.version as number) - (a.version as number))[0] ?? null;
  }

  allObjects(kind: string): Record<string, RawSkillObject> {
    return kind === SKILL_OBJECT_KIND ? Object.fromEntries(this.objects) : {};
  }

  addListener(kind: string, fn: (raw: RawSkillObject) => unknown): void {
    if (kind === SKILL_OBJECT_KIND) this.listeners.push(fn);
  }

  removeListener(_kind: string, fn: (raw: RawSkillObject) => unknown): void {
    const index = this.listeners.indexOf(fn);
    if (index !== -1) this.listeners.splice(index, 1);
  }

  get listenerCount(): number {
    return this.listeners.length;
  }
}

/** An AI Config variation value pinning `skills`. */
function aiConfig(skills?: unknown, enabled = true): Record<string, unknown> {
  return {
    model: { name: 'gpt-4o' },
    provider: { name: 'OpenAI' },
    instructions: 'Be helpful.',
    ...(skills === undefined ? {} : { skills }),
    _ldMeta: { enabled, variationKey: 'v1', version: 1, mode: 'agent' },
  };
}

/**
 * A base client with the Node server SDK's change-listener shape: an
 * `EventEmitter` whose `update:<key>` events carry `{ key }`.
 */
class FakeClient extends EventEmitter implements LDClientInterface {
  value: unknown = aiConfig([]);
  offline = false;
  readonly variation = vi.fn(async (_key: string, _context: LDContext, _default: unknown) =>
    typeof this.value === 'function' ? (this.value as () => unknown)() : this.value,
  );
  readonly track = vi.fn();
  readonly flush = vi.fn(async () => undefined);
  readonly close = vi.fn();
  isOffline(): boolean {
    return this.offline;
  }

  /** Fires a config change the way the Node client does. */
  change(key = CONFIG_KEY): void {
    this.emit('update', { key });
    this.emit(`update:${key}`, { key });
  }
}

/** A client brought to `initClient` that implements only the required members. */
function variationOnlyClient(value: unknown = aiConfig([])): LDClientInterface {
  return {
    variation: vi.fn(async () => value),
    track: vi.fn(),
    flush: vi.fn(async () => undefined),
    close: vi.fn(),
  };
}

/** A source answering whatever `answer` currently holds, counting reads. */
function countingSource(
  initial: ReadonlyArray<SkillReference | string>,
  configKeys: readonly string[] = [CONFIG_KEY],
): { source: SkillSource; reads: () => number; answer: (next: unknown) => void } {
  let current: unknown = initial;
  let count = 0;
  const source = createSkillSource({
    refs: () => {
      count += 1;
      if (current instanceof Error) throw current;
      return current as ReadonlyArray<SkillReference | string>;
    },
    configKeys,
  });
  return { source, reads: () => count, answer: (next) => (current = next) };
}

const tempRoots: string[] = [];

async function scratchRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'ld-skills-source-'));
  tempRoots.push(root);
  return path.join(root, 'skills');
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return predicate();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function manifestEntry(root: string, key: string): Promise<Record<string, unknown> | undefined> {
  const manifest = JSON.parse(await readFile(path.join(root, MANIFEST_NAME), 'utf-8'));
  return manifest.entries[`${key}/SKILL.md`];
}

async function skillFile(root: string, key: string): Promise<string> {
  return readFile(path.join(root, key, 'SKILL.md'), 'utf-8');
}

function shape(report: ReconcileReport): Array<[string, string, number | null]> {
  return report.actions.map((a) => [a.key, a.action, a.version]);
}

function actionFor(report: ReconcileReport, key: string) {
  return report.actions.find((a) => a.key === key);
}

let fake: FakeClient;

beforeEach(async () => {
  await shutdown();
  // A configSkills call made with no client is held until the next init.
  resetSdkUsage();
  fake = new FakeClient();
  mockLdInit.mockReset();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await shutdown();
  delete process.env.LD_SDK_KEY;
  while (tempRoots.length > 0) await rm(tempRoots.pop() as string, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

describe('createSkillSource', () => {
  it('is frozen, and holds a frozen copy of configKeys', () => {
    const keys = ['a', 'b'];
    const source = createSkillSource({ refs: () => [], configKeys: keys });
    keys.push('c');
    expect(source.configKeys).toEqual(['a', 'b']);
    expect(Object.isFrozen(source)).toBe(true);
    expect(Object.isFrozen(source.configKeys)).toBe(true);
    expect(() => {
      (source as { configKeys: readonly string[] }).configKeys = [];
    }).toThrow(TypeError);
    expect(() => (source.configKeys as string[]).push('d')).toThrow(TypeError);
  });

  it('defaults configKeys to empty', () => {
    expect(createSkillSource({ refs: () => [] }).configKeys).toEqual([]);
  });

  it.each([undefined, null, 'refs', 42, {}, [() => []]])('rejects a non-function refs (%j) with TypeError', (refs) => {
    expect(() => createSkillSource({ refs: refs as unknown as SkillSource['refs'] })).toThrow(TypeError);
  });

  it('rejects a bare-string configKeys with TypeError rather than following one key per character', () => {
    expect(() =>
      createSkillSource({ refs: () => [], configKeys: 'support-agent' as unknown as readonly string[] }),
    ).toThrow(TypeError);
  });

  it.each([
    [['']],
    [[42]],
    [[null]],
    [{ 0: 'a' }],
    [new Set(['a'])],
  ])('rejects configKeys %j with TypeError', (configKeys) => {
    expect(() => createSkillSource({ refs: () => [], configKeys: configKeys as unknown as string[] })).toThrow(
      TypeError,
    );
  });

  it('rejects a missing init with TypeError', () => {
    expect(() => createSkillSource(undefined as unknown as { refs: SkillSource['refs'] })).toThrow(TypeError);
  });
});

describe('entry points', () => {
  it('exports SkillSource, createSkillSource and configSkills from the experimental entry point only', () => {
    expect(typeof experimentalEntry.createSkillSource).toBe('function');
    expect(typeof experimentalEntry.configSkills).toBe('function');
    expect('createSkillSource' in rootEntry).toBe(false);
    expect('configSkills' in rootEntry).toBe(false);
    // `SkillSource` is a type; the API report check covers its absence from the root.
  });
});

// ---------------------------------------------------------------------------
// configSkills
// ---------------------------------------------------------------------------

describe('configSkills classification', () => {
  async function read(value: unknown): Promise<unknown> {
    fake.value = value;
    await initClient(fake);
    return configSkills(CONFIG_KEY, ctx).refs();
  }

  it('fails the read when no AI client is initialized, and does not initialize one', async () => {
    process.env.LD_SDK_KEY = 'sdk-test';
    const source = configSkills(CONFIG_KEY, ctx);
    await expect(source.refs()).rejects.toThrow(/support-agent[\s\S]*no AI client is initialized/);
    expect(mockLdInit).not.toHaveBeenCalled();
    expect(() => getClient()).toThrow();
  });

  it('fails the read when variation throws', async () => {
    fake.value = () => {
      throw new Error('boom');
    };
    await initClient(fake);
    await expect(configSkills(CONFIG_KEY, ctx).refs()).rejects.toThrow(/support-agent[\s\S]*variation threw: boom/);
  });

  it.each([
    ['the default (null)', null],
    ['undefined', undefined],
    ['a string', 'off'],
    ['a number', 3],
    ['a boolean', false],
    ['an array', [{ key: 'a', version: 1 }]],
  ])('fails the read when the value is %s', async (_label, value) => {
    await expect(read(value)).rejects.toThrow(/configSkills could not read AI Config 'support-agent'/);
  });

  it.each([
    ['no _ldMeta', { ...aiConfig([]), _ldMeta: undefined }],
    ['a non-object _ldMeta', { ...aiConfig([]), _ldMeta: 'meta' }],
    ['an _ldMeta without enabled', { ...aiConfig([]), _ldMeta: { variationKey: 'v1' } }],
    ['a non-boolean enabled', { ...aiConfig([]), _ldMeta: { enabled: 'true' } }],
  ])('fails the read for an object with %s', async (_label, value) => {
    await expect(read(value)).rejects.toThrow(/_ldMeta/);
  });

  it('fails the read when an enabled config fails to parse', async () => {
    const { model: _model, ...noModel } = aiConfig([{ key: 'a', version: 1 }]);
    await expect(read(noModel)).rejects.toThrow(/failed to parse[\s\S]*model\.name/);
  });

  it.each([
    ['a string', 'pdf-extraction'],
    ['null', null],
    ['an entry with no version', [{ key: 'a' }]],
    ['an invalid key', [{ key: 'Bad Key', version: 1 }]],
    ['one valid and one malformed entry', [{ key: 'a', version: 1 }, { key: 'b' }]],
  ])('fails the read, never answering [], when skills is %s', async (_label, skills) => {
    await expect(read(aiConfig(skills))).rejects.toThrow(/Invalid skills field/);
  });

  it('answers [] for a disabled variation', async () => {
    await expect(read(aiConfig([{ key: 'a', version: 1 }], false))).resolves.toEqual([]);
  });

  it('answers [] for an enabled config with no skills', async () => {
    await expect(read(aiConfig())).resolves.toEqual([]);
  });

  it("answers the config's references", async () => {
    await expect(read(aiConfig([{ key: 'a', version: 2 }]))).resolves.toEqual([ref('a', 2)]);
  });

  it('passes null as the variation default, not { enabled: false }', async () => {
    await read(aiConfig([]));
    expect(fake.variation).toHaveBeenCalledWith(CONFIG_KEY, ctx, null);
  });

  it('evaluates afresh on every read', async () => {
    await initClient(fake);
    const source = configSkills(CONFIG_KEY, ctx);
    fake.value = aiConfig([{ key: 'a', version: 2 }]);
    expect(await source.refs()).toEqual([ref('a', 2)]);
    fake.value = aiConfig([{ key: 'a', version: 3 }]);
    expect(await source.refs()).toEqual([ref('a', 3)]);
    expect(fake.variation).toHaveBeenCalledTimes(2);
  });

  it('names the config key in its configKeys', () => {
    expect(configSkills(CONFIG_KEY, ctx).configKeys).toEqual([CONFIG_KEY]);
  });

  it.each(['', undefined, 42])('rejects key %j with TypeError', (key) => {
    expect(() => configSkills(key as unknown as string, ctx)).toThrow(TypeError);
  });
});

describe('configSkills telemetry', () => {
  function usage(helper?: string): unknown[][] {
    return fake.track.mock.calls.filter(
      (call) => call[0] === '$ld:ai:sdk:usage' && (helper === undefined || call[2]?.helper === helper),
    );
  }

  it('reports experimental.configSkills when called, and nothing per read', async () => {
    const records: string[] = [];
    _setEmitterForTesting({ record: (signal) => records.push(signal) });
    fake.value = aiConfig([{ key: 'a', version: 1 }]);
    await initClient(fake);
    fake.track.mockClear();

    const source = configSkills(CONFIG_KEY, ctx);
    expect(usage('experimental.configSkills')).toHaveLength(1);
    const after = fake.track.mock.calls.length;

    for (let i = 0; i < 3; i += 1) await source.refs();
    // No usage, no AI telemetry, no skills signal: a read is only an evaluation.
    expect(fake.track.mock.calls.length).toBe(after);
    expect(records).toEqual([]);
  });

  it('adds no usage event, and no experimental.skillRefs, when writeSkills or watchSkills reads it', async () => {
    fake.value = aiConfig([{ key: 'a', version: 1 }]);
    await initClient(fake);
    const store = new MutableStore([rawSkill('a', 1)]);
    _setStore(store);
    const source = configSkills(CONFIG_KEY, ctx);
    fake.track.mockClear();

    await writeSkills(source, await scratchRoot());
    const { watcher } = await watchSkills(source, await scratchRoot(), { debounceMs: 5 });
    try {
      fake.change();
      expect(await waitUntil(() => watcher.reconciles === 1)).toBe(true);
    } finally {
      await watcher.close();
    }
    const helpers = usage().map((call) => (call[2] as { helper: string }).helper);
    expect(helpers).not.toContain('experimental.skillRefs');
    expect(helpers).not.toContain('experimental.configSkills');
    expect(fake.track.mock.calls.filter((call) => String(call[0]).startsWith('$ld:ai:'))).toEqual(usage());
  });
});

// ---------------------------------------------------------------------------
// writeSkills with a SkillSource
// ---------------------------------------------------------------------------

describe('writeSkills with a SkillSource', () => {
  let store: MutableStore;

  beforeEach(() => {
    store = new MutableStore([rawSkill('a', 1), rawSkill('b', 1)]);
    _setStore(store);
  });

  it('reconciles exactly as the list the source returned would', async () => {
    const listRoot = await scratchRoot();
    const sourceRoot = await scratchRoot();
    const twoRefs = [ref('a', 1), 'b'];

    const first = [
      await writeSkills(twoRefs, listRoot),
      await writeSkills(createSkillSource({ refs: () => twoRefs }), sourceRoot),
    ];
    expect(shape(first[1] as ReconcileReport)).toEqual(shape(first[0] as ReconcileReport));

    // A second run that drops 'b' and names a missing 'c': an error for 'c'
    // and a prune of 'b', identically in both forms.
    const next = [ref('a', 1), ref('c', 1)];
    const second = [
      await writeSkills(next, listRoot),
      await writeSkills(createSkillSource({ refs: async () => next }), sourceRoot),
    ];
    expect(shape(second[1] as ReconcileReport)).toEqual(shape(second[0] as ReconcileReport));
    expect(actionFor(second[1] as ReconcileReport, 'c')?.action).toBe('error');
    expect(actionFor(second[1] as ReconcileReport, 'b')?.action).toBe('removed');
  });

  it('reads refs exactly once, with no retry, when it throws', async () => {
    const refs = vi.fn(() => {
      throw new Error('source down');
    });
    const report = await writeSkills(createSkillSource({ refs }), await scratchRoot());
    expect(refs).toHaveBeenCalledTimes(1);
    expect(report.ok).toBe(false);
  });

  it('reads refs exactly once on success', async () => {
    const refs = vi.fn(() => [ref('a', 1)]);
    await writeSkills(createSkillSource({ refs }), await scratchRoot());
    expect(refs).toHaveBeenCalledTimes(1);
  });

  const failedReads: Array<[string, () => unknown]> = [
    [
      'throws',
      () => {
        throw new Error('source down');
      },
    ],
    ['rejects', () => Promise.reject(new Error('source down'))],
    ['answers null', () => null],
    ['answers undefined', () => undefined],
    ['answers "*"', () => '*'],
    ['answers a bare key', () => 'a'],
    ['answers an object', () => ({ a: 1 })],
    ['answers a promise of null', async () => null],
    ['answers a list holding a number', () => [ref('a', 1), 7]],
    ['answers a list holding null', () => [ref('a', 1), null]],
    ['answers a list holding "*"', () => ['*']],
    ['answers a list holding an invalid key', () => ['Not A Key']],
    ['answers a list holding a reference with no version', () => [ref('a', 1), { key: 'b' }]],
    ['answers a list holding a reference with version 0', () => [{ key: 'a', version: 0 }]],
    [
      'answers a list holding a Skill',
      () => [{ key: 'a', version: 1, content: new Uint8Array([1]), contentHash: 'x' }],
    ],
  ];

  it.each(failedReads)('treats a source that %s as an unavailable retrieval', async (_label, refs) => {
    const root = await scratchRoot();
    await writeSkills(['a', 'b'], root);
    const before = await readFile(path.join(root, MANIFEST_NAME), 'utf-8');

    const report = await writeSkills(createSkillSource({ refs: refs as SkillSource['refs'] }), root);

    expect(report.ok).toBe(false);
    expect(report.actions).toHaveLength(1);
    expect(report.actions[0]).toMatchObject({ key: '', action: 'error' });
    expect(report.actions[0]?.error).toMatch(/skill retrieval unavailable: [\s\S]*skill source/);
    // Nothing written or removed; the manifest's entries are intact.
    expect(await skillFile(root, 'a')).toBe(body('a', 1));
    expect(await skillFile(root, 'b')).toBe(body('b', 1));
    expect(JSON.parse(await readFile(path.join(root, MANIFEST_NAME), 'utf-8')).entries).toEqual(
      JSON.parse(before).entries,
    );
  });

  it.each(failedReads)("raises under 'raise', naming the skill source, when it %s", async (_label, refs) => {
    const root = await scratchRoot();
    await writeSkills(['a', 'b'], root);
    await expect(
      writeSkills(createSkillSource({ refs: refs as SkillSource['refs'] }), root, { onUnavailable: 'raise' }),
    ).rejects.toThrow(/skill retrieval unavailable: [\s\S]*skill source/);
    expect(existsSync(path.join(root, 'a', 'SKILL.md'))).toBe(true);
    expect(existsSync(path.join(root, 'b', 'SKILL.md'))).toBe(true);
  });

  it('keeps both skills and their manifest entries when a source answers null after writing them', async () => {
    const root = await scratchRoot();
    const { source, answer } = countingSource([ref('a', 1), ref('b', 1)], []);
    expect((await writeSkills(source, root)).ok).toBe(true);
    answer(null);
    const report = await writeSkills(source, root);
    expect(report.ok).toBe(false);
    expect(report.actions.some((a) => a.action === 'removed')).toBe(false);
    expect(await manifestEntry(root, 'a')).toMatchObject({ key: 'a', version: 1 });
    expect(await manifestEntry(root, 'b')).toMatchObject({ key: 'b', version: 1 });
    expect(await skillFile(root, 'a')).toBe(body('a', 1));
    expect(await skillFile(root, 'b')).toBe(body('b', 1));
  });

  it('does not invoke refs at all under timeout: 0', async () => {
    const refs = vi.fn(() => [ref('a', 1)]);
    const report = await writeSkills(createSkillSource({ refs }), await scratchRoot(), { timeout: 0 });
    expect(refs).not.toHaveBeenCalled();
    expect(report.ok).toBe(false);
    expect(report.errors[0]?.error).toMatch(/timeout/);
  });

  it('abandons a source still pending at the deadline and discards its result', async () => {
    const root = await scratchRoot();
    let settle: (refs: SkillReference[]) => void = () => undefined;
    const pending = new Promise<SkillReference[]>((resolve) => {
      settle = resolve;
    });
    const started = performance.now();
    const report = await writeSkills(createSkillSource({ refs: () => pending }), root, { timeout: 0.05 });
    expect(performance.now() - started).toBeLessThan(1000);
    expect(report.ok).toBe(false);
    expect(report.errors[0]).toMatchObject({ key: '' });
    expect(report.errors[0]?.error).toMatch(/timeout[\s\S]*skill source/);

    settle([ref('a', 1)]);
    await sleep(20);
    expect(existsSync(path.join(root, 'a'))).toBe(false);
  });

  it('abandons a pending source that later rejects without an unhandled rejection', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      let fail: (cause: Error) => void = () => undefined;
      const pending = new Promise<SkillReference[]>((_resolve, reject) => {
        fail = reject;
      });
      const report = await writeSkills(createSkillSource({ refs: () => pending }), await scratchRoot(), {
        timeout: 0.02,
      });
      expect(report.ok).toBe(false);
      fail(new Error('late'));
      await sleep(20);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('accepts a hand-built source object', async () => {
    const root = await scratchRoot();
    const report = await writeSkills({ refs: () => ['a'], configKeys: [] }, root);
    expect(actionFor(report, 'a')?.action).toBe('written');
  });
});

// ---------------------------------------------------------------------------
// watchSkills following config changes
// ---------------------------------------------------------------------------

describe('watchSkills with a fixed list or "*"', () => {
  it.each([
    ['*', '*' as const],
    ['a fixed list', [ref('a', 1)]],
  ])('%s never subscribes to config changes', async (_label, skills) => {
    _setStore(new MutableStore([rawSkill('a', 1)]));
    await initClient(fake);
    const on = vi.spyOn(fake, 'on');
    const { watcher } = await watchSkills(skills, await scratchRoot(), { debounceMs: 5 });
    await watcher.close();
    expect(on).not.toHaveBeenCalled();
    expect(fake.eventNames()).toEqual([]);
  });

  it.each([
    ['*', '*' as const],
    ['a fixed list', [ref('a', 1)]],
  ])('%s needs no change-listener API on the client', async (_label, skills) => {
    _setStore(new MutableStore([rawSkill('a', 1)]));
    await initClient(variationOnlyClient());
    const { watcher } = await watchSkills(skills, await scratchRoot(), { debounceMs: 5 });
    await watcher.close();
  });

  it('works with no client at all', async () => {
    _setStore(new MutableStore([rawSkill('a', 1)]));
    const { watcher } = await watchSkills('*', await scratchRoot(), { debounceMs: 5 });
    await watcher.close();
  });
});

describe('watchSkills with a SkillSource', () => {
  let store: MutableStore;

  beforeEach(async () => {
    store = new MutableStore([rawSkill('pdf-extraction', 2)]);
    _setStore(store);
    await initClient(fake);
  });

  it("subscribes to update:<key> once per config key, not to 'update'", async () => {
    const { source } = countingSource([ref('pdf-extraction', 2)], ['a', 'b', 'a']);
    const { watcher } = await watchSkills(source, await scratchRoot(), { debounceMs: 5 });
    try {
      expect(fake.eventNames().sort()).toEqual(['update:a', 'update:b']);
      expect(fake.listenerCount('update:a')).toBe(1);
    } finally {
      await watcher.close();
    }
  });

  it('reads the source once per reconcile, on a store change and on a config change', async () => {
    const { source, reads } = countingSource([ref('pdf-extraction', 2)]);
    const { watcher } = await watchSkills(source, await scratchRoot(), { debounceMs: 10 });
    try {
      expect(reads()).toBe(1);

      store.change({ add: [rawSkill('other', 1)] });
      expect(await waitUntil(() => watcher.reconciles === 1)).toBe(true);
      expect(reads()).toBe(2);

      fake.change();
      expect(await waitUntil(() => watcher.reconciles === 2)).toBe(true);
      expect(reads()).toBe(3);
    } finally {
      await watcher.close();
    }
  });

  it('reconciles on a change to a followed key, and is not woken by any other key', async () => {
    const { source } = countingSource([ref('pdf-extraction', 2)]);
    const { watcher } = await watchSkills(source, await scratchRoot(), { debounceMs: 10 });
    try {
      const notify = vi.spyOn(watcher, 'notify');
      fake.change('unrelated-config');
      fake.emit('update', { key: 'unrelated-config' });
      expect(notify).not.toHaveBeenCalled();

      fake.change(CONFIG_KEY);
      expect(notify).toHaveBeenCalledTimes(1);
      expect(await waitUntil(() => watcher.reconciles === 1)).toBe(true);
    } finally {
      await watcher.close();
    }
  });

  it('only signals from the config listener; the source is read after it returns', async () => {
    const { source, reads } = countingSource([ref('pdf-extraction', 2)]);
    const { watcher } = await watchSkills(source, await scratchRoot(), { debounceMs: 0 });
    try {
      const before = reads();
      fake.change();
      expect(reads()).toBe(before);
      expect(await waitUntil(() => watcher.reconciles === 1)).toBe(true);
      expect(reads()).toBe(before + 1);
    } finally {
      await watcher.close();
    }
  });

  it('registers the config listener before the initial reconcile', async () => {
    let first = true;
    const source = createSkillSource({
      refs: () => {
        if (first) {
          first = false;
          fake.change();
        }
        return [ref('pdf-extraction', 2)];
      },
      configKeys: [CONFIG_KEY],
    });
    const { watcher } = await watchSkills(source, await scratchRoot(), { debounceMs: 5 });
    try {
      expect(await waitUntil(() => watcher.reconciles === 1)).toBe(true);
    } finally {
      await watcher.close();
    }
  });

  it('schedules a reconcile from a public notify() with no argument', async () => {
    const { source, reads } = countingSource([ref('pdf-extraction', 2)], []);
    const { watcher } = await watchSkills(source, await scratchRoot(), { debounceMs: 5 });
    try {
      watcher.notify();
      expect(await waitUntil(() => watcher.reconciles === 1)).toBe(true);
      expect(reads()).toBe(2);
    } finally {
      await watcher.close();
    }
  });

  it('debounces store and config triggers together: one window, one read, one reconcile', async () => {
    const { source, reads } = countingSource([ref('pdf-extraction', 2)]);
    const { watcher } = await watchSkills(source, await scratchRoot(), { debounceMs: 600 });
    try {
      // Spread out, so only the debounce window, not the pending flag, can merge them.
      store.change({ add: [rawSkill('x', 1)] });
      await sleep(60);
      fake.change();
      await sleep(60);
      store.change({ add: [rawSkill('y', 1)] });
      await sleep(60);
      fake.change();

      expect(await waitUntil(() => watcher.reconciles >= 1, 5000)).toBe(true);
      await sleep(300);
      expect(watcher.reconciles).toBe(1);
      expect(reads()).toBe(2);
    } finally {
      await watcher.close();
    }
  });

  it('detaches the config listener on close, with off, and reads nothing afterwards', async () => {
    const { source, reads } = countingSource([ref('pdf-extraction', 2)]);
    const off = vi.spyOn(fake, 'off');
    const { watcher } = await watchSkills(source, await scratchRoot(), { debounceMs: 5 });
    await watcher.close();
    expect(off).toHaveBeenCalledWith(`update:${CONFIG_KEY}`, expect.any(Function));
    expect(fake.listenerCount(`update:${CONFIG_KEY}`)).toBe(0);

    fake.change();
    await sleep(40);
    expect(reads()).toBe(1);
    expect(watcher.reconciles).toBe(0);
  });

  it('closes cleanly when the client has on but no off', async () => {
    await shutdown();
    _setStore(store);
    const client = Object.assign(variationOnlyClient(), { on: vi.fn() });
    await initClient(client);
    const { source } = countingSource([ref('pdf-extraction', 2)]);
    const { watcher } = await watchSkills(source, await scratchRoot(), { debounceMs: 5 });
    expect(client.on).toHaveBeenCalledWith(`update:${CONFIG_KEY}`, expect.any(Function));
    await watcher.close();
    await watcher.close();
  });

  it('falls back to removeListener when the client has no off', async () => {
    await shutdown();
    _setStore(store);
    const client = Object.assign(variationOnlyClient(), { on: vi.fn(), removeListener: vi.fn() });
    await initClient(client);
    const { source } = countingSource([ref('pdf-extraction', 2)]);
    const { watcher } = await watchSkills(source, await scratchRoot(), { debounceMs: 5 });
    await watcher.close();
    expect(client.removeListener).toHaveBeenCalledWith(`update:${CONFIG_KEY}`, client.on.mock.calls[0]?.[1]);
  });

  it('logs, and still closes, when off throws', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(fake, 'off').mockImplementation(() => {
      throw new Error('off failed');
    });
    const { source } = countingSource([ref('pdf-extraction', 2)]);
    const { watcher } = await watchSkills(source, await scratchRoot(), { debounceMs: 5 });
    await watcher.close();
    expect(logged.mock.calls.some((call) => String(call[0]).includes('off failed'))).toBe(true);
  });

  it('re-validates a hand-built source, so a bare-string configKeys throws TypeError', async () => {
    const source = { refs: () => [], configKeys: 'support-agent' } as unknown as SkillSource;
    await expect(watchSkills(source, await scratchRoot())).rejects.toThrow(TypeError);
    expect(store.listenerCount).toBe(0);
  });
});

describe('watchSkills with no config-change signal', () => {
  let store: MutableStore;

  beforeEach(() => {
    store = new MutableStore([rawSkill('pdf-extraction', 2)]);
    _setStore(store);
  });

  async function expectNoSignal(pattern: RegExp): Promise<void> {
    const { source, reads } = countingSource([ref('pdf-extraction', 2)]);
    const root = await scratchRoot();
    let caught: unknown;
    try {
      await watchSkills(source, root);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toMatch(pattern);
    expect(message).toMatch(/support-agent/);
    // Both remedies: a base client, or an empty configKeys with notify().
    expect(message).toMatch(/initClient\(\)/);
    expect(message).toMatch(/empty configKeys[\s\S]*watcher\.notify\(\)/);
    expect(store.listenerCount).toBe(0);
    expect(reads()).toBe(0);
    expect(existsSync(root)).toBe(false);
  }

  it('throws when no AI client is initialized', async () => {
    await expectNoSignal(/no AI client is initialized/);
  });

  it('throws when the client has no on (a client brought to initClient with only variation)', async () => {
    await initClient(variationOnlyClient());
    await expectNoSignal(/no on\(event, listener\) method/);
  });

  it('throws when the client reports itself offline', async () => {
    fake.offline = true;
    await initClient(fake);
    await expectNoSignal(/offline/);
    expect(fake.eventNames()).toEqual([]);
  });

  it('treats a client without isOffline as online', async () => {
    await initClient(Object.assign(variationOnlyClient(), { on: vi.fn(), off: vi.fn() }));
    const { source } = countingSource([ref('pdf-extraction', 2)]);
    const { watcher } = await watchSkills(source, await scratchRoot(), { debounceMs: 5 });
    await watcher.close();
  });

  it('probes nothing for an empty configKeys, even with no client', async () => {
    const { source } = countingSource([ref('pdf-extraction', 2)], []);
    const { report, watcher } = await watchSkills(source, await scratchRoot(), { debounceMs: 5 });
    await watcher.close();
    expect(report.ok).toBe(true);
  });
});

describe('watchSkills following a version bump', () => {
  const V2 = body('pdf-extraction', 2);
  const V3 = body('pdf-extraction', 3);

  async function setup() {
    const store = new MutableStore([rawSkill('pdf-extraction', 2)]);
    _setStore(store);
    await initClient(fake);
    const { source, answer } = countingSource([ref('pdf-extraction', 2)]);
    const reports: ReconcileReport[] = [];
    const root = await scratchRoot();
    const { report, watcher } = await watchSkills(source, root, {
      debounceMs: 5,
      onReconcile: (r) => {
        reports.push(r);
      },
    });
    reports.push(report);
    expect(actionFor(report, 'pdf-extraction')?.action).toBe('written');
    return { store, answer, reports, root, watcher };
  }

  async function nextReport(reports: ReconcileReport[], count: number): Promise<ReconcileReport> {
    expect(await waitUntil(() => reports.length >= count)).toBe(true);
    return reports[count - 1] as ReconcileReport;
  }

  async function endState(root: string) {
    const entry = await manifestEntry(root, 'pdf-extraction');
    return { file: await skillFile(root, 'pdf-extraction'), version: entry?.version, sha256: entry?.sha256 };
  }

  it('converges when the config change arrives first', async () => {
    const { store, answer, reports, root, watcher } = await setup();
    try {
      answer([ref('pdf-extraction', 3)]);
      fake.change();
      const waiting = await nextReport(reports, 2);
      expect(actionFor(waiting, 'pdf-extraction')?.action).toBe('error');
      expect(await skillFile(root, 'pdf-extraction')).toBe(V2);
      expect((await manifestEntry(root, 'pdf-extraction'))?.version).toBe(2);

      store.change({ add: [rawSkill('pdf-extraction', 3)] });
      const done = await nextReport(reports, 3);
      expect(actionFor(done, 'pdf-extraction')).toMatchObject({ action: 'updated', version: 3 });
      expect(done.ok).toBe(true);
      expect(await endState(root)).toEqual({ file: V3, version: 3, sha256: hash(V3) });

      for (const report of reports) {
        expect(report.actions.some((a) => a.key === 'pdf-extraction' && a.action === 'removed')).toBe(false);
      }
    } finally {
      await watcher.close();
    }
  });

  it('converges when the store change arrives first, to the same end state', async () => {
    const { store, answer, reports, root, watcher } = await setup();
    try {
      store.change({ add: [rawSkill('pdf-extraction', 3)], remove: ['pdf-extraction:2'] });
      const waiting = await nextReport(reports, 2);
      expect(actionFor(waiting, 'pdf-extraction')?.action).toBe('error');
      expect(await skillFile(root, 'pdf-extraction')).toBe(V2);

      answer([ref('pdf-extraction', 3)]);
      fake.change();
      const done = await nextReport(reports, 3);
      expect(actionFor(done, 'pdf-extraction')).toMatchObject({ action: 'updated', version: 3 });
      expect(done.ok).toBe(true);
      expect(await endState(root)).toEqual({ file: V3, version: 3, sha256: hash(V3) });

      for (const report of reports) {
        expect(report.actions.some((a) => a.key === 'pdf-extraction' && a.action === 'removed')).toBe(false);
      }
    } finally {
      await watcher.close();
    }
  });
});

describe('watchSkills when a source drops a reference', () => {
  it('prunes it on the next complete reconcile, and not while another reference is unavailable', async () => {
    // 'c' is unavailable (its read throws), which makes the run incomplete.
    // An *absent* reference does not: it stays requested, and the run still prunes.
    let cDown = true;
    const store = new MutableStore([rawSkill('a', 1), rawSkill('b', 1)]);
    const getObject = store.getObject.bind(store);
    store.getObject = (kind, key, version) => {
      if (key === 'c' && cDown) throw new Error('store read failed');
      return getObject(kind, key, version);
    };
    _setStore(store);
    await initClient(fake);
    const { source, answer } = countingSource([ref('a', 1), ref('b', 1)]);
    const reports: ReconcileReport[] = [];
    const root = await scratchRoot();
    const { watcher } = await watchSkills(source, root, { debounceMs: 5, onReconcile: (r) => void reports.push(r) });
    try {
      // 'b' dropped, but 'c' could not be read: no prune this run.
      answer([ref('a', 1), ref('c', 1)]);
      fake.change();
      expect(await waitUntil(() => reports.length === 1)).toBe(true);
      expect(actionFor(reports[0] as ReconcileReport, 'c')?.action).toBe('error');
      expect(actionFor(reports[0] as ReconcileReport, 'b')).toBeUndefined();
      expect(await skillFile(root, 'b')).toBe(body('b', 1));

      // 'c' becomes readable: everything resolves, so 'b' is pruned.
      cDown = false;
      store.change({ add: [rawSkill('c', 1)] });
      expect(await waitUntil(() => reports.length === 2)).toBe(true);
      expect(actionFor(reports[1] as ReconcileReport, 'b')?.action).toBe('removed');
      expect(existsSync(path.join(root, 'b'))).toBe(false);
    } finally {
      await watcher.close();
    }
  });

  it('prunes a dropped reference in a clean run', async () => {
    _setStore(new MutableStore([rawSkill('a', 1), rawSkill('b', 1)]));
    await initClient(fake);
    const { source, answer } = countingSource([ref('a', 1), ref('b', 1)]);
    const reports: ReconcileReport[] = [];
    const root = await scratchRoot();
    const { watcher } = await watchSkills(source, root, { debounceMs: 5, onReconcile: (r) => void reports.push(r) });
    try {
      answer([ref('a', 1)]);
      fake.change();
      expect(await waitUntil(() => reports.length === 1)).toBe(true);
      expect(actionFor(reports[0] as ReconcileReport, 'b')?.action).toBe('removed');
    } finally {
      await watcher.close();
    }
  });
});

describe('watchSkills when the source cannot answer', () => {
  beforeEach(async () => {
    _setStore(new MutableStore([rawSkill('a', 1)]));
    await initClient(fake);
  });

  it("raises out of watchSkills under 'raise' on the initial reconcile, with every listener detached", async () => {
    const store = new MutableStore([rawSkill('a', 1)]);
    _setStore(store);
    const { source } = countingSource([]);
    const failing = createSkillSource({
      refs: () => {
        throw new Error('source down');
      },
      configKeys: source.configKeys,
    });
    await expect(watchSkills(failing, await scratchRoot(), { onUnavailable: 'raise' })).rejects.toThrow(
      /skill source failed: source down/,
    );
    expect(store.listenerCount).toBe(0);
    expect(fake.listenerCount(`update:${CONFIG_KEY}`)).toBe(0);
  });

  it("returns the run-level error under 'keep' on the initial reconcile", async () => {
    const { source } = countingSource([]);
    const failing = createSkillSource({ refs: () => null as never, configKeys: source.configKeys });
    const { report, watcher } = await watchSkills(failing, await scratchRoot(), { debounceMs: 5 });
    await watcher.close();
    expect(report.ok).toBe(false);
    expect(report.errors[0]).toMatchObject({ key: '', action: 'error' });
  });

  it("hands a later 'keep' failure to onReconcile, then reconciles normally on the next trigger", async () => {
    const { source, answer, reads } = countingSource([ref('a', 1)]);
    const reports: ReconcileReport[] = [];
    const root = await scratchRoot();
    const { watcher } = await watchSkills(source, root, { debounceMs: 5, onReconcile: (r) => void reports.push(r) });
    try {
      answer(new Error('source down'));
      fake.change();
      expect(await waitUntil(() => reports.length === 1)).toBe(true);
      expect(reports[0]?.ok).toBe(false);
      expect(reports[0]?.errors[0]?.key).toBe('');
      expect(await skillFile(root, 'a')).toBe(body('a', 1));
      expect((await manifestEntry(root, 'a'))?.version).toBe(1);

      answer([ref('a', 1)]);
      fake.change();
      expect(await waitUntil(() => reports.length === 2)).toBe(true);
      expect(reports[1]?.ok).toBe(true);
      expect(actionFor(reports[1] as ReconcileReport, 'a')?.action).toBe('skipped_current');
      expect(reads()).toBe(3);
    } finally {
      await watcher.close();
    }
  });

  it("logs a later 'raise' failure and reads the source again on the next trigger", async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { source, answer, reads } = countingSource([ref('a', 1)]);
    const root = await scratchRoot();
    const { watcher } = await watchSkills(source, root, { debounceMs: 5, onUnavailable: 'raise' });
    try {
      answer(new Error('source down'));
      fake.change();
      expect(await waitUntil(() => logged.mock.calls.some((c) => String(c[0]).includes('source down')))).toBe(true);
      expect(await skillFile(root, 'a')).toBe(body('a', 1));

      answer([ref('a', 1)]);
      fake.change();
      expect(await waitUntil(() => watcher.reconciles === 1)).toBe(true);
      expect(reads()).toBe(3);
    } finally {
      await watcher.close();
    }
  });
});

describe('notify() when following a config by hand', () => {
  it('lets an empty configKeys source follow changes through the caller own listener', async () => {
    _setStore(new MutableStore([rawSkill('a', 1), rawSkill('a', 2)]));
    let version = 1;
    const source = createSkillSource({ refs: () => [ref('a', version)] });
    const root = await scratchRoot();
    const { watcher } = await watchSkills(source, root, { debounceMs: 5 });
    try {
      version = 2;
      watcher.notify();
      expect(await waitUntil(() => watcher.reconciles === 1)).toBe(true);
      expect(await skillFile(root, 'a')).toBe(body('a', 2));
    } finally {
      await watcher.close();
    }
  });
});
