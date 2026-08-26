/**
 * Agent Skills — value types, `frontmatter()`, reference discovery, the
 * `SkillStore` seam, the content accessors, and the accessor half of the
 * telemetry seam.
 *
 * No network, no real LaunchDarkly client, no real skill transport.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Mock the optional OTel peer deps so the BYOC initClient path is inert ────

vi.mock('@opentelemetry/sdk-trace-node', () => ({
  NodeTracerProvider: class {
    register = vi.fn();
    shutdown = vi.fn().mockResolvedValue(undefined);
  },
}));
vi.mock('@opentelemetry/sdk-trace-base', () => ({ BatchSpanProcessor: class {} }));
vi.mock('@opentelemetry/exporter-trace-otlp-http', () => ({ OTLPTraceExporter: class {} }));
vi.mock('@opentelemetry/otlp-exporter-base', () => ({ CompressionAlgorithm: { GZIP: 'gzip' } }));
vi.mock('@opentelemetry/resources', () => ({ resourceFromAttributes: () => ({}) }));
vi.mock('@opentelemetry/context-async-hooks', () => ({ AsyncLocalStorageContextManager: class {} }));
vi.mock('@opentelemetry/core', () => ({
  CompositePropagator: class {},
  W3CBaggagePropagator: class {},
  W3CTraceContextPropagator: class {},
}));
vi.mock('@opentelemetry/api', () => ({
  trace: { getTracerProvider: () => ({ _delegate: {} }) },
  propagation: { setGlobalPropagator: vi.fn() },
}));
vi.mock('dotenv/config', () => ({}));

import * as packageIndex from '../index.js';
import { initClient, shutdown } from '../lifecycle.js';
import {
  _clearState,
  _setEmitterForTesting,
  _setStore,
  allSkills,
  getSkill,
  getSkills,
  InMemorySkillStore,
  skillRefs,
} from '../skills.js';
import type { RawSkillObject, Skill, SkillStore } from '../types.js';
import { createReconcileAction, createReconcileReport, createSkill, createSkillReference } from '../types.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const SKILL_BODY = '---\nname: Test Skill\n---\nDo the thing.\n';

const INTEGRITY_SIGNAL = 'AgentControl Skill Integrity Failure';
const MATERIALIZED_SIGNAL = 'AgentControl Skill Materialized';
const REVOKED_SIGNAL = 'AgentControl Skill Revoked Received';

/** The three signal names are an allowlist, not a floor. */
const APPROVED_SIGNALS = new Set([INTEGRITY_SIGNAL, MATERIALIZED_SIGNAL, REVOKED_SIGNAL]);

/**
 * Signal names that must never be emitted by the SDK — named explicitly so the
 * regression is unmissable.
 */
const REMOVED_SIGNALS = ['AgentControl Skill SDK Reference Returned', 'AgentControl Skill Content Retrieved'];

function hash(content: string): string {
  return createHash('sha256').update(Buffer.from(content, 'utf-8')).digest('hex');
}

/** A wire-shaped raw store object with a correct `contentHash`. */
function rawSkill(overrides: Partial<RawSkillObject> & { key?: unknown } = {}): RawSkillObject {
  const content = typeof overrides.content === 'string' ? overrides.content : SKILL_BODY;
  return {
    key: 'test-skill',
    version: 1,
    content,
    contentHash: hash(content),
    name: 'Test Skill',
    description: 'A skill used in tests.',
    ...overrides,
  } as RawSkillObject;
}

function skill(content: string = SKILL_BODY, key = 'test-skill', version = 1): Skill {
  return createSkill({ key, version, content, contentHash: hash(content) });
}

class RecordingEmitter {
  records: Array<[string, Record<string, unknown>]> = [];
  record(signal: string, properties: Record<string, unknown>): void {
    this.records.push([signal, properties]);
  }
  signals(name: string): Array<Record<string, unknown>> {
    return this.records.filter(([s]) => s === name).map(([, p]) => p);
  }
  names(): Set<string> {
    return new Set(this.records.map(([s]) => s));
  }
}

class ThrowingEmitter {
  record(): void {
    throw new Error('emitter exploded');
  }
}

/** A minimal store that serves exactly what it was handed, unvalidated. */
class DictStore implements SkillStore {
  constructor(private readonly objects: Record<string, RawSkillObject>) {}
  getObject(_kind: string, key: string): RawSkillObject | null {
    return this.objects[key] ?? null;
  }
  allObjects(): Record<string, RawSkillObject> {
    return { ...this.objects };
  }
}

function makeMockLdClient() {
  return {
    track: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    variation: vi.fn().mockResolvedValue(null),
  };
}

function clearClientSingleton() {
  const key = Symbol.for('@launchdarkly/ai-server:singleton');
  (globalThis as Record<symbol, unknown>)[key] = null;
}

beforeEach(() => {
  _clearState();
  clearClientSingleton();
  delete process.env.LD_SDK_KEY;
});

afterEach(() => {
  _clearState();
  clearClientSingleton();
  delete process.env.LD_SDK_KEY;
});

// ─── Skill types ───────────────────────────────────────────────────────

describe('skill value types', () => {
  it('SkillReference is immutable', () => {
    const ref = createSkillReference({ key: 'a', version: 1 });
    expect(() => {
      (ref as { key: string }).key = 'b';
    }).toThrow(TypeError);
    expect(ref.key).toBe('a');
  });

  it('Skill is immutable', () => {
    const s = skill();
    expect(() => {
      (s as { content: string }).content = 'tampered';
    }).toThrow(TypeError);
    expect(s.content).toBe(SKILL_BODY);
  });

  it('Skill carries optional metadata', () => {
    const s = createSkill({
      key: 'a',
      version: 2,
      content: SKILL_BODY,
      contentHash: hash(SKILL_BODY),
      name: 'PDF Extraction',
      description: 'Extracts text.',
    });
    expect(s.name).toBe('PDF Extraction');
    expect(s.description).toBe('Extracts text.');
  });

  it('Skill metadata defaults to null', () => {
    const s = skill();
    expect(s.name).toBeNull();
    expect(s.description).toBeNull();
  });

  it('ReconcileAction is immutable and defaults its optional fields to null', () => {
    const action = createReconcileAction({ key: 'a', action: 'written' });
    expect(action.version).toBeNull();
    expect(action.path).toBeNull();
    expect(action.error).toBeNull();
    expect(() => {
      (action as { action: string }).action = 'error';
    }).toThrow(TypeError);
  });
});

describe('ReconcileReport ok and errors', () => {
  const nonError = (key: string, action: 'written' | 'updated' | 'skipped_current' | 'removed') =>
    createReconcileAction({ key, action });
  const errored = (key: string) => createReconcileAction({ key, action: 'error', error: `${key} failed` });

  it('ok is true when no action is an error', () => {
    const report = createReconcileReport([
      nonError('a', 'written'),
      nonError('b', 'updated'),
      nonError('c', 'skipped_current'),
      nonError('d', 'removed'),
    ]);
    expect(report.ok).toBe(true);
  });

  it('ok is false when at least one action is an error', () => {
    const report = createReconcileReport([nonError('a', 'written'), errored('b')]);
    expect(report.ok).toBe(false);
  });

  it('an empty report is ok', () => {
    expect(createReconcileReport([]).ok).toBe(true);
  });

  it('errors lists the error actions in actions order', () => {
    const first = errored('first');
    const second = errored('second');
    const report = createReconcileReport([
      nonError('a', 'written'),
      first,
      nonError('b', 'updated'),
      second,
      nonError('c', 'removed'),
    ]);
    expect(report.errors).toEqual([first, second]);
  });

  it('errors is empty when no action is an error', () => {
    const report = createReconcileReport([nonError('a', 'written')]);
    expect(report.errors).toEqual([]);
  });

  it('ok and errors always agree', () => {
    for (const actions of [
      [],
      [nonError('a', 'written')],
      [errored('a')],
      [nonError('a', 'written'), errored('b'), nonError('c', 'removed')],
    ]) {
      const report = createReconcileReport(actions);
      expect(report.ok).toBe(report.errors.length === 0);
    }
  });
});

// ─── Package exports ───────────────────────────────────────────────────

describe('package exports', () => {
  it('exports the five fixed values from the package root with exact values', () => {
    // These are API, not implementation detail: a caller needs MANIFEST_FILENAME
    // to gitignore the manifest and MAX_SKILL_CONTENT_BYTES to pre-check content.
    expect(packageIndex.SKILL_OBJECT_KIND).toBe('skill');
    expect(packageIndex.SKILL_FILENAME).toBe('SKILL.md');
    expect(packageIndex.MANIFEST_FILENAME).toBe('.launchdarkly-skills.json');
    expect(packageIndex.MANIFEST_VERSION).toBe(1);
    expect(packageIndex.MAX_SKILL_CONTENT_BYTES).toBe(65536);
  });

  it('exports the skills functions and the in-memory store from the package root', () => {
    expect(typeof packageIndex.skillRefs).toBe('function');
    expect(typeof packageIndex.getSkill).toBe('function');
    expect(typeof packageIndex.getSkills).toBe('function');
    expect(typeof packageIndex.allSkills).toBe('function');
    expect(typeof packageIndex.writeSkills).toBe('function');
    expect(typeof packageIndex.createSkill).toBe('function');
    expect(typeof packageIndex.createSkillReference).toBe('function');
    expect(typeof packageIndex.InMemorySkillStore).toBe('function');
  });

  it('the ReconcileActionKind union admits exactly the five action strings', () => {
    // Assert the closed set by exhaustiveness over the union.
    // Adding a sixth member makes `exhaustive` fail to compile; removing one
    // leaves an entry in the record with no corresponding union member.
    const exhaustive: Record<packageIndex.ReconcileActionKind, true> = {
      written: true,
      updated: true,
      skipped_current: true,
      removed: true,
      error: true,
    };
    expect(Object.keys(exhaustive).sort()).toEqual(['error', 'removed', 'skipped_current', 'updated', 'written']);
  });

  it('the OnUnavailable union admits exactly keep and raise', () => {
    const exhaustive: Record<packageIndex.OnUnavailable, true> = { keep: true, raise: true };
    expect(Object.keys(exhaustive).sort()).toEqual(['keep', 'raise']);
  });
});

// ─── frontmatter() ─────────────────────────────────────────────────────

describe('Skill.frontmatter()', () => {
  it('parses valid frontmatter', async () => {
    const content = '---\nname: test\nversion: 1\n---\nBody text\n';
    await expect(skill(content).frontmatter()).resolves.toEqual({ name: 'test', version: 1 });
  });

  it('returns null when there is no frontmatter block', async () => {
    await expect(skill('# Just markdown\n\nNo frontmatter here.\n').frontmatter()).resolves.toBeNull();
  });

  it('returns null for an unterminated block', async () => {
    await expect(skill('---\nname: test\nnever closed\n').frontmatter()).resolves.toBeNull();
  });

  it('returns null for malformed YAML', async () => {
    await expect(skill('---\nname: [unclosed\n  bad: : :\n---\nBody\n').frontmatter()).resolves.toBeNull();
  });

  it('returns null for a non-mapping block', async () => {
    await expect(skill('---\n- one\n- two\n---\nBody\n').frontmatter()).resolves.toBeNull();
  });

  it('returns null for an oversize block', async () => {
    const big = Array.from({ length: 200 }, (_, i) => `key${i}: ${'x'.repeat(80)}`).join('\n');
    expect(big.length).toBeGreaterThan(8 * 1024);
    await expect(skill(`---\n${big}\n---\nBody\n`).frontmatter()).resolves.toBeNull();
  });

  it('returns null for a block nested deeper than 10 levels, promptly', async () => {
    const block = `${Array.from({ length: 14 }, (_, i) => `${'  '.repeat(i)}k${i}:`).join('\n')}\n${'  '.repeat(14)}v: 1\n`;
    const started = performance.now();
    await expect(skill(`---\n${block}---\nBody\n`).frontmatter()).resolves.toBeNull();
    expect(performance.now() - started).toBeLessThan(5000);
  });

  it('accepts a block at exactly the depth bound', async () => {
    // Positive control for the depth walk: 10 nested containers is allowed, so
    // the bound rejects "deeper than 10" rather than all nesting.
    const block = `${Array.from({ length: 9 }, (_, i) => `${'  '.repeat(i)}k${i}:`).join('\n')}\n${'  '.repeat(9)}v: 1\n`;
    await expect(skill(`---\n${block}---\nBody\n`).frontmatter()).resolves.not.toBeNull();
  });

  it('returns null for a block containing a single alias', async () => {
    // Alias resolution is *disabled*, not bounded, so one alias is
    // already disqualifying. This minimal case is the actual boundary the rule
    // draws; the billion-laughs bomb below is only a corollary of it.
    const content = '---\nname: test\nanchored: &a 1\naliased: *a\n---\nBody\n';
    await expect(skill(content).frontmatter()).resolves.toBeNull();
  });

  it('returns null for a merge key, which is an alias', async () => {
    await expect(skill('---\na: &a {x: 1}\nb:\n  <<: *a\n---\nBody\n').frontmatter()).resolves.toBeNull();
  });

  it('does not crash or hang on billion-laughs aliases', async () => {
    // The threat is not memory blow-up: with `maxAliasCount` left at its default
    // of 100 the `yaml` package resolves this bomb's 54 aliases and returns a
    // value in about a millisecond. Nor does any other bound catch it — it is
    // ~300 bytes and 6 levels deep, inside both the 8 KB and depth-10 limits.
    // The contract asserted is the alias rule; the elapsed-time bound below only
    // guards a parser that *does* expand.
    const bomb =
      '---\n' +
      "a: &a ['x','x','x','x','x','x','x','x','x']\n" +
      'b: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a]\n' +
      'c: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b]\n' +
      'd: &d [*c,*c,*c,*c,*c,*c,*c,*c,*c]\n' +
      'e: &e [*d,*d,*d,*d,*d,*d,*d,*d,*d]\n' +
      'f: &f [*e,*e,*e,*e,*e,*e,*e,*e,*e]\n' +
      'g: [*f,*f,*f,*f,*f,*f,*f,*f,*f]\n' +
      '---\nBody\n';
    const started = performance.now();
    await expect(skill(bomb).frontmatter()).resolves.toBeNull();
    expect(performance.now() - started).toBeLessThan(5000);
  });

  it('treats an object-construction tag as inert', async () => {
    const content = "---\nevil: !!python/object/apply:os.system ['echo pwned']\n---\nB\n";
    await expect(skill(content).frontmatter()).resolves.toBeNull();
  });

  it('treats a custom tag as inert', async () => {
    await expect(skill('---\nevil: !SomeType {a: 1}\n---\nBody\n').frontmatter()).resolves.toBeNull();
  });

  it('still resolves the standard safe tags', async () => {
    // Positive control: rejecting *unresolved* tags must not reject the core
    // schema's own tags, which both languages resolve without constructing.
    await expect(skill('---\nx: !!str 5\ny: !!int "7"\n---\nBody\n').frontmatter()).resolves.toEqual({
      x: '5',
      y: 7,
    });
  });

  it('does not crash on pathologically deep nesting', async () => {
    const deep = `a: ${'['.repeat(3000)}${']'.repeat(3000)}`;
    await expect(skill(`---\n${deep}\n---\nBody\n`).frontmatter()).resolves.toBeNull();
  });

  it('keeps yaml out of the package runtime dependencies', () => {
    // The YAML library is dev-only in both languages. A runtime
    // dependency would defeat the whole point of the lazy dynamic import.
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf-8'));
    expect(pkg.dependencies?.yaml).toBeUndefined();
    expect(pkg.peerDependencies?.yaml).toBeUndefined();
    expect(pkg.devDependencies?.yaml).toBeDefined();
  });
});

// ─── skillRefs ─────────────────────────────────────────────────────────

describe('skillRefs', () => {
  const base = { model: { name: 'gpt-4o' }, provider: { name: 'OpenAI' }, instructions: 'hi' };

  it('returns an empty list when skills is absent', () => {
    expect(skillRefs(base)).toEqual([]);
  });

  it('returns an empty list when skills is empty', () => {
    expect(skillRefs({ ...base, skills: [] })).toEqual([]);
  });

  it('returns typed references preserving input order', () => {
    const refs = skillRefs({
      ...base,
      skills: [
        { key: 'a', version: 1 },
        { key: 'b', version: 3 },
      ],
    });
    expect(refs).toEqual([
      { key: 'a', version: 1 },
      { key: 'b', version: 3 },
    ]);
  });

  it('returns an empty list for a null or undefined config', () => {
    expect(skillRefs(null)).toEqual([]);
    expect(skillRefs(undefined)).toEqual([]);
  });

  it('emits no telemetry', () => {
    const emitter = new RecordingEmitter();
    _setEmitterForTesting(emitter);
    skillRefs({ ...base, skills: [{ key: 'a', version: 1 }] });
    expect(emitter.records).toEqual([]);
  });

  it('needs no client and no configured store', () => {
    // No initClient, no _setStore — a pure projection must work regardless.
    expect(skillRefs({ ...base, skills: [{ key: 'a', version: 1 }] })).toHaveLength(1);
  });

  it('rides through inspectConfig without changing its signature', async () => {
    const mockClient = makeMockLdClient();
    const variation = {
      ...base,
      skills: [{ key: 'pdf-extraction', version: 2 }],
      _ldMeta: { enabled: true, variationKey: 'v1', version: 1 },
    };
    mockClient.variation.mockResolvedValue(variation);
    await initClient(mockClient);

    const { inspectConfig } = await import('../lifecycle.js');
    const result = await inspectConfig('doc-agent', { kind: 'user', key: 'u1' });

    expect(result.enabled).toBe(true);
    expect(skillRefs(result.config)).toEqual([{ key: 'pdf-extraction', version: 2 }]);
  });
});

// ─── InMemorySkillStore ────────────────────────────────────────────────

describe('InMemorySkillStore', () => {
  it('round-trips objects handed to the constructor', () => {
    const raw = rawSkill({ key: 'a' });
    const store = new InMemorySkillStore({ a: raw });
    expect(store.getObject('skill', 'a')).toEqual(raw);
  });

  it('returns null for an unknown key', () => {
    expect(new InMemorySkillStore().getObject('skill', 'nope')).toBeNull();
  });

  it('put then get', () => {
    const store = new InMemorySkillStore();
    const raw = rawSkill({ key: 'a' });
    store.put(raw);
    expect(store.getObject('skill', 'a')).toEqual(raw);
  });

  it('allObjects returns everything held, keyed by skill key', () => {
    const store = new InMemorySkillStore();
    store.put(rawSkill({ key: 'a' }));
    store.put(rawSkill({ key: 'b' }));
    expect(Object.keys(store.allObjects('skill')).sort()).toEqual(['a', 'b']);
  });

  it('returns nothing for a kind other than skill', () => {
    const store = new InMemorySkillStore();
    store.put(rawSkill({ key: 'a' }));
    expect(store.getObject('flag', 'a')).toBeNull();
    expect(store.allObjects('flag')).toEqual({});
  });

  it('notifies skill-kind listeners on put, verbatim and unverified', () => {
    const store = new InMemorySkillStore();
    const seen: RawSkillObject[] = [];
    store.addListener('skill', (raw) => seen.push(raw));
    // Deliberately hash-invalid: the store performs no validation, so the
    // callback must see exactly what was stored.
    const raw = rawSkill({ key: 'a', contentHash: 'deadbeef' });
    store.put(raw);
    expect(seen).toEqual([raw]);
    expect(seen[0]).toBe(raw);
  });

  it('records but never fires a listener registered for another kind', () => {
    const store = new InMemorySkillStore();
    const other = vi.fn();
    store.addListener('flag', other);
    store.put(rawSkill({ key: 'a' }));
    expect(other).not.toHaveBeenCalled();
  });

  it('rejects a raw object with no string key', () => {
    expect(() => new InMemorySkillStore().put({ version: 1 } as RawSkillObject)).toThrow();
  });
});

// ─── Store configuration on the lifecycle layer ────────────────────────

describe('store configuration', () => {
  it('is configured via initClient options', async () => {
    const store = new InMemorySkillStore();
    store.put(rawSkill({ key: 'a' }));
    await initClient(makeMockLdClient(), { skillStore: store });

    const found = await getSkill('a');
    expect(found?.key).toBe('a');
  });

  it('getSkill raises actionably when no store is configured', async () => {
    await expect(getSkill('a')).rejects.toThrow(/skill store/i);
  });

  it('getSkills raises actionably when no store is configured', async () => {
    await expect(getSkills([{ key: 'a', version: 1 }])).rejects.toThrow(/skill store/i);
  });

  it('allSkills raises actionably when no store is configured', async () => {
    await expect(allSkills()).rejects.toThrow(/skill store/i);
  });

  it('the no-store message says what to configure', async () => {
    // Assert the message content, not just the raise: a bare "not implemented"
    // would otherwise satisfy the test.
    await expect(getSkill('a')).rejects.toThrow(/skillStore/);
    await expect(getSkill('a')).rejects.toThrow(/InMemorySkillStore/);
  });

  it('shutdown clears the store', async () => {
    const store = new InMemorySkillStore();
    store.put(rawSkill({ key: 'a' }));
    await initClient(makeMockLdClient(), { skillStore: store });
    expect(await getSkill('a')).not.toBeNull();

    await shutdown();

    await expect(getSkill('a')).rejects.toThrow(/skill store/i);
  });

  it('applies skillStore on every initClient call, without replacing the client', async () => {
    // skillStore is applied before the client-singleton
    // idempotency check on purpose, so a client that was lazily auto-initialized
    // or initialized without a store can be given one afterwards. Both halves
    // are asserted on the same pair of calls; each is meaningless alone.
    //
    // The second call takes the *options* overload, which is where TypeScript's
    // early return lives: `initClient(client)` deliberately replaces the
    // singleton on this side, so a second BYOC call would not prove the store
    // was applied before an early return.
    const first = new InMemorySkillStore();
    first.put(rawSkill({ key: 'first' }));
    const second = new InMemorySkillStore();
    second.put(rawSkill({ key: 'second' }));

    const firstClient = makeMockLdClient();

    await initClient(firstClient, { skillStore: first });
    await initClient({ skillStore: second });

    // Half one: the client singleton is unchanged — the second call returned
    // early without touching it, and never reached the Node SDK path (which
    // would have thrown for a missing LD_SDK_KEY).
    const { getClient } = await import('../lifecycle.js');
    expect(getClient()).toBe(firstClient);

    // Half two: the store was nevertheless swapped.
    expect(await getSkill('second')).not.toBeNull();
    expect(await getSkill('first')).toBeNull();
  });

  it('an initClient call without a store leaves the configured one alone', async () => {
    // Otherwise a bare initClient() from an unrelated code path — the lazy
    // auto-init, say — would silently unconfigure skills.
    const store = new InMemorySkillStore();
    store.put(rawSkill({ key: 'a' }));
    await initClient(makeMockLdClient(), { skillStore: store });

    await initClient(makeMockLdClient());

    expect(await getSkill('a')).not.toBeNull();
  });

  it('the test-state reset clears the store and the emitter', async () => {
    const store = new InMemorySkillStore();
    store.put(rawSkill({ key: 'a' }));
    _setStore(store);
    const emitter = new RecordingEmitter();
    _setEmitterForTesting(emitter);
    expect(await getSkill('a')).not.toBeNull();

    _clearState();

    await expect(getSkill('a')).rejects.toThrow(/skill store/i);
    // The emitter went with it: re-configuring a store and triggering a failure
    // records nothing on the old emitter.
    _setStore(new DictStore({ bad: rawSkill({ key: 'bad', contentHash: '0'.repeat(64) }) }));
    expect(await getSkill('bad')).toBeNull();
    expect(emitter.records).toEqual([]);
  });
});

// ─── Accessor argument errors ──────────────────────────────────────────

describe('getSkills bare-string guard', () => {
  it('raises a TypeError, naming the fix', async () => {
    _setStore(new InMemorySkillStore());
    // A string is *never* a valid argument here; iterating one would look up a
    // skill per character. Deliberately a different error class from
    // writeSkills's bare-string rejection, where '*' is a valid string argument.
    const error = await getSkills('pdf-extraction' as unknown as string[]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TypeError);
    expect((error as Error).message).toContain('[key]');
  });

  it('rejects before the store is consulted', async () => {
    // Asserting the raise alone would also pass if the string were iterated
    // into single-character lookups that all missed, so pin that no lookup
    // happened at all.
    const lookedUp: string[] = [];
    _setStore({
      getObject(_kind: string, key: string) {
        lookedUp.push(key);
        return null;
      },
      allObjects() {
        return {};
      },
    });

    await expect(getSkills('abc' as unknown as string[])).rejects.toThrow(TypeError);
    expect(lookedUp).toEqual([]);
  });
});

// ─── getSkill ──────────────────────────────────────────────────────────

describe('getSkill', () => {
  let store: InMemorySkillStore;

  beforeEach(() => {
    store = new InMemorySkillStore();
    _setStore(store);
  });

  it('returns the verified skill with verbatim content and metadata', async () => {
    store.put(rawSkill({ key: 'pdf-extraction', version: 2 }));
    const found = await getSkill('pdf-extraction');
    expect(found).not.toBeNull();
    expect(found?.key).toBe('pdf-extraction');
    expect(found?.version).toBe(2);
    expect(found?.content).toBe(SKILL_BODY);
    expect(found?.contentHash).toBe(hash(SKILL_BODY));
    expect(found?.name).toBe('Test Skill');
    expect(found?.description).toBe('A skill used in tests.');
  });

  it('an omitted version means the newest available', async () => {
    store.put(rawSkill({ key: 'a', version: 7 }));
    expect((await getSkill('a'))?.version).toBe(7);
  });

  it('matches an exact requested version', async () => {
    store.put(rawSkill({ key: 'a', version: 3 }));
    expect((await getSkill('a', { version: 3 }))?.version).toBe(3);
  });

  it('returns null for a version the store does not hold', async () => {
    store.put(rawSkill({ key: 'a', version: 3 }));
    expect(await getSkill('a', { version: 2 })).toBeNull();
    expect(await getSkill('a', { version: 4 })).toBeNull();
  });

  it('returns null for a missing key, never raising', async () => {
    expect(await getSkill('nope')).toBeNull();
  });
});

// ─── getSkills ─────────────────────────────────────────────────────────

describe('getSkills', () => {
  let store: InMemorySkillStore;

  beforeEach(() => {
    store = new InMemorySkillStore();
    _setStore(store);
  });

  it('accepts a mixed sequence of references and bare strings', async () => {
    store.put(rawSkill({ key: 'a', version: 1 }));
    store.put(rawSkill({ key: 'b', version: 5 }));
    const found = await getSkills(['a', { key: 'b', version: 5 }]);
    expect(found.map((s) => s.key)).toEqual(['a', 'b']);
  });

  it('preserves input order for the skills found', async () => {
    for (const key of ['a', 'b', 'c']) store.put(rawSkill({ key }));
    const found = await getSkills(['c', 'a', 'b']);
    expect(found.map((s) => s.key)).toEqual(['c', 'a', 'b']);
  });

  it('omits missing entries rather than returning placeholders', async () => {
    store.put(rawSkill({ key: 'a' }));
    const found = await getSkills(['a', 'missing']);
    expect(found).toHaveLength(1);
    expect(found[0].key).toBe('a');
  });

  it('omits a wrong-version entry', async () => {
    store.put(rawSkill({ key: 'a', version: 2 }));
    expect(await getSkills([{ key: 'a', version: 1 }])).toEqual([]);
  });

  it('omits integrity failures and records the signal once', async () => {
    const emitter = new RecordingEmitter();
    _setEmitterForTesting(emitter);
    store.put(rawSkill({ key: 'good-one' }));
    store.put(rawSkill({ key: 'tampered', contentHash: '0'.repeat(64) }));
    store.put(rawSkill({ key: 'good-two' }));

    const found = await getSkills(['good-one', 'tampered', 'good-two']);

    expect(found.map((s) => s.key)).toEqual(['good-one', 'good-two']);
    expect(emitter.signals(INTEGRITY_SIGNAL)).toHaveLength(1);
  });

  it('returns an empty list for an empty input', async () => {
    expect(await getSkills([])).toEqual([]);
  });
});

// ─── allSkills ─────────────────────────────────────────────────────────

describe('allSkills', () => {
  it('returns every verified skill the store holds', async () => {
    const store = new InMemorySkillStore();
    for (const key of ['a', 'b', 'c']) store.put(rawSkill({ key }));
    _setStore(store);
    expect((await allSkills()).map((s) => s.key).sort()).toEqual(['a', 'b', 'c']);
  });

  it('omits skills that fail verification', async () => {
    const store = new InMemorySkillStore();
    store.put(rawSkill({ key: 'good' }));
    store.put(rawSkill({ key: 'bad', contentHash: '0'.repeat(64) }));
    _setStore(store);
    expect((await allSkills()).map((s) => s.key)).toEqual(['good']);
  });

  it('returns an empty list for an empty store', async () => {
    _setStore(new InMemorySkillStore());
    expect(await allSkills()).toEqual([]);
  });
});

// ─── Integrity verification ────────────────────────────────────────────

describe('integrity verification', () => {
  it('withholds a skill whose hash does not match', async () => {
    const emitter = new RecordingEmitter();
    _setEmitterForTesting(emitter);
    const store = new InMemorySkillStore();
    store.put(rawSkill({ key: 'a', contentHash: 'a'.repeat(64) }));
    _setStore(store);

    expect(await getSkill('a')).toBeNull();
    const [props] = emitter.signals(INTEGRITY_SIGNAL);
    expect(props.expected_hash).toBe('a'.repeat(64));
    expect(props.observed_hash).toBe(hash(SKILL_BODY));
  });

  it('withholds content tampered by a single byte', async () => {
    const raw = rawSkill({ key: 'a' });
    raw.content = `${raw.content as string}x`;
    _setStore(new DictStore({ a: raw }));
    expect(await getSkill('a')).toBeNull();
  });

  it('rejects content over 64 KiB even when its hash matches', async () => {
    const emitter = new RecordingEmitter();
    _setEmitterForTesting(emitter);
    const oversize = 'x'.repeat(64 * 1024 + 1);
    const store = new InMemorySkillStore();
    store.put(rawSkill({ key: 'a', content: oversize }));
    _setStore(store);

    expect(await getSkill('a')).toBeNull();
    expect(emitter.signals(INTEGRITY_SIGNAL)).toHaveLength(1);
  });

  it('accepts content at exactly the size cap', async () => {
    const atCap = 'x'.repeat(64 * 1024);
    const store = new InMemorySkillStore();
    store.put(rawSkill({ key: 'a', content: atCap }));
    _setStore(store);
    expect((await getSkill('a'))?.content).toHaveLength(64 * 1024);
  });

  it('accepts a key at the 256-character bound from the store', async () => {
    // The accepting side of the <= 256 bound. writeSkills cannot reach
    // it (a key is one directory name and NAME_MAX is 255), so config
    // validation and this accessor-side revalidation are the only two layers
    // where 256 is observable at all.
    const key = 'a'.repeat(256);
    const store = new InMemorySkillStore();
    store.put(rawSkill({ key }));
    _setStore(store);
    expect((await getSkill(key))?.key).toBe(key);
  });

  it.each([
    ['uppercase', 'Evil'],
    ['leading dash', '-leading-dash'],
    ['leading dot', '.hidden'],
    ['embedded space', 'has space'],
    ['path separator', 'a/b'],
    ['traversal', '../escape'],
    ['empty', ''],
    ['overlong', 'x'.repeat(257)],
    ['trailing newline', 'trailing\n'],
  ])('rejects an invalid key served by the store: %s', async (_label, badKey) => {
    // A hostile store may serve any key — the accessor revalidates.
    const raw = rawSkill({ key: 'placeholder' });
    raw.key = badKey;
    _setStore(new DictStore({ [badKey]: raw }));
    expect(await getSkill(badKey)).toBeNull();
  });

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['non-integer', 2.5],
    ['string', '2'],
    ['null', null],
    ['boolean', true],
    ['undefined', undefined],
    ['NaN', Number.NaN],
  ])('rejects an invalid version served by the store: %s', async (_label, badVersion) => {
    const raw = rawSkill({ key: 'a' });
    raw.version = badVersion as number;
    _setStore(new DictStore({ a: raw }));
    expect(await getSkill('a')).toBeNull();
  });

  it('rejects a raw object with no content', async () => {
    const raw = rawSkill({ key: 'a' });
    delete raw.content;
    _setStore(new DictStore({ a: raw }));
    expect(await getSkill('a')).toBeNull();
  });

  it('rejects a raw object with no contentHash', async () => {
    const raw = rawSkill({ key: 'a' });
    delete raw.contentHash;
    _setStore(new DictStore({ a: raw }));
    expect(await getSkill('a')).toBeNull();
  });

  it('rejects a non-object raw entry', async () => {
    _setStore(new DictStore({ a: 'not an object' as unknown as RawSkillObject }));
    expect(await getSkill('a')).toBeNull();
  });

  it('rejects an uppercase hash — hashes are lowercase hex', async () => {
    const store = new InMemorySkillStore();
    store.put(rawSkill({ key: 'a', contentHash: hash(SKILL_BODY).toUpperCase() }));
    _setStore(store);
    expect(await getSkill('a')).toBeNull();
  });

  it('verifies multi-byte UTF-8 content byte-exactly', async () => {
    const emoji = '---\nname: 🎉\n---\nUnicode ✨ body\n';
    const store = new InMemorySkillStore();
    store.put(rawSkill({ key: 'a', content: emoji }));
    _setStore(store);
    expect((await getSkill('a'))?.content).toBe(emoji);
  });

  it('withholds content that has no UTF-8 encoding, even when its hash matches', async () => {
    // An unpaired surrogate has
    // no UTF-8 encoding. Python's str.encode raises; Node's Buffer.from
    // *silently substitutes* U+FFFD, so only an explicit round-trip check
    // catches it — and without that check a store can supply the hash of the
    // substituted bytes and have fabricated content pass verification.
    //
    // contentHash is deliberately the hash of the lossy encoding, so the hash
    // comparison is NOT what rejects this. If the round-trip guard is removed,
    // this skill verifies and getSkill returns content LaunchDarkly never sent.
    const content = 'hi \ud800 there';
    const substituted = Buffer.from(content, 'utf-8');
    expect(substituted.toString('utf-8')).not.toBe(content); // the substitution really happens

    const store = new DictStore({
      a: { key: 'a', version: 1, content, contentHash: createHash('sha256').update(substituted).digest('hex') },
    });
    _setStore(store);

    expect(await getSkill('a')).toBeNull();
  });

  it('records the integrity signal for unencodable content', async () => {
    const emitter = new RecordingEmitter();
    _setEmitterForTesting(emitter);
    const content = 'hi \ud800 there';
    _setStore(
      new DictStore({
        a: {
          key: 'a',
          version: 1,
          content,
          contentHash: createHash('sha256').update(Buffer.from(content, 'utf-8')).digest('hex'),
        },
      }),
    );

    await getSkill('a');

    expect(emitter.signals(INTEGRITY_SIGNAL)).toHaveLength(1);
  });

  it('reports a throwing store as no result rather than propagating', async () => {
    _setStore({
      getObject() {
        throw new Error('transport failure');
      },
      allObjects() {
        throw new Error('transport failure');
      },
    });
    expect(await getSkill('a')).toBeNull();
    expect(await getSkills(['a'])).toEqual([]);
    expect(await allSkills()).toEqual([]);
  });
});

// ─── Key identity ──────────────────────────────────────────────────────

describe('key identity', () => {
  /**
   * A store that ignores the key it was asked for and always answers with its
   * own, self-consistent object. Nothing about it is detectable by integrity
   * verification: the body hashes correctly against its own `contentHash`.
   */
  class SubstitutingStore implements SkillStore {
    getObject(_kind: string, _key: string): RawSkillObject {
      return rawSkill({ key: 'substituted', version: 3 });
    }
    allObjects(): Record<string, RawSkillObject> {
      return { substituted: rawSkill({ key: 'substituted', version: 3 }) };
    }
  }

  beforeEach(() => {
    _setStore(new SubstitutingStore());
  });

  it('withholds an answer filed under a key other than the one asked for', async () => {
    expect(await getSkill('wanted')).toBeNull();
  });

  it('withholds it with the version pinned too — the version check does not catch it', async () => {
    expect(await getSkill('wanted', { version: 3 })).toBeNull();
  });

  it('withholds every substituted entry in a batch', async () => {
    expect(await getSkills(['wanted', 'also-wanted'])).toEqual([]);
  });

  it('logs the mismatch at error, since a store answering under another key is broken or hostile', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await getSkill('wanted');
      expect(logged).toHaveBeenCalledTimes(1);
      expect(logged.mock.calls[0][0]).toContain("'wanted'");
      expect(logged.mock.calls[0][0]).toContain("'substituted'");
    } finally {
      logged.mockRestore();
    }
  });

  it('records no integrity signal — the substituted content hashes correctly', async () => {
    const emitter = new RecordingEmitter();
    _setEmitterForTesting(emitter);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await getSkill('wanted');
      expect(emitter.signals(INTEGRITY_SIGNAL)).toEqual([]);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('still serves a store that answers with the key it was asked for', async () => {
    const store = new InMemorySkillStore();
    store.put(rawSkill({ key: 'wanted', version: 3 }));
    _setStore(store);
    expect((await getSkill('wanted'))?.key).toBe('wanted');
    expect((await getSkill('wanted', { version: 3 }))?.key).toBe('wanted');
    expect((await getSkills(['wanted'])).map((s) => s.key)).toEqual(['wanted']);
  });

  it('allSkills has no requested key to mismatch, so it serves what the store holds', async () => {
    expect((await allSkills()).map((s) => s.key)).toEqual(['substituted']);
  });
});

// ─── Telemetry seam (accessor half) ────────────────────────────────────

describe('telemetry seam, accessor half', () => {
  it('the default emitter is a no-op and never raises', async () => {
    const store = new InMemorySkillStore();
    store.put(rawSkill({ key: 'a', contentHash: '0'.repeat(64) }));
    _setStore(store);
    // No emitter injected.
    expect(await getSkill('a')).toBeNull();
  });

  it('records the integrity failure with the exact property keys', async () => {
    const emitter = new RecordingEmitter();
    _setEmitterForTesting(emitter);
    const store = new InMemorySkillStore();
    store.put(rawSkill({ key: 'a', version: 4, contentHash: 'b'.repeat(64) }));
    _setStore(store);

    await getSkill('a');

    const [props] = emitter.signals(INTEGRITY_SIGNAL);
    expect(props.skill_key).toBe('a');
    expect(props.version).toBe(4);
    expect(props.expected_hash).toBe('b'.repeat(64));
    expect(props.observed_hash).toBe(hash(SKILL_BODY));
    expect(props.language).toBe('typescript');
  });

  it('never puts the skill body in a signal', async () => {
    const emitter = new RecordingEmitter();
    _setEmitterForTesting(emitter);
    const store = new InMemorySkillStore();
    store.put(rawSkill({ key: 'a', contentHash: 'c'.repeat(64) }));
    _setStore(store);

    await getSkill('a');

    for (const [, props] of emitter.records) {
      for (const value of Object.values(props)) {
        expect(String(value)).not.toContain('Do the thing.');
      }
    }
  });

  // `skill_key` and `expected_hash` are copied off the wire,
  // so a hostile store can smuggle the body through either one. The sweep above
  // cannot detect that: it passes a well-formed 64-char digest, so neither
  // shape-check branch ever runs. These two cases are what make the rule
  // observable. Assert the body's absence, not the placeholder's spelling.

  it('redacts a skill body smuggled through contentHash', async () => {
    const emitter = new RecordingEmitter();
    _setEmitterForTesting(emitter);
    const body = 'UNIQUE-SECRET-BODY-VIA-HASH';
    _setStore(new DictStore({ a: { key: 'a', version: 1, content: body, contentHash: body } }));

    expect(await getSkill('a')).toBeNull();

    const signals = emitter.signals(INTEGRITY_SIGNAL);
    expect(signals).toHaveLength(1);
    for (const value of Object.values(signals[0])) {
      expect(String(value)).not.toContain(body);
    }
  });

  it('redacts a skill body smuggled through the key', async () => {
    const emitter = new RecordingEmitter();
    _setEmitterForTesting(emitter);
    // Not a valid skill key, so it is the invalid-key branch that must redact it.
    const body = 'UNIQUE-SECRET-BODY-VIA-KEY/../x';
    _setStore(new DictStore({ [body]: { key: body, version: 1, content: 'x', contentHash: 'y' } }));

    expect(await getSkill(body)).toBeNull();

    const signals = emitter.signals(INTEGRITY_SIGNAL);
    expect(signals).toHaveLength(1);
    for (const value of Object.values(signals[0])) {
      expect(String(value)).not.toContain(body);
    }
  });

  it('makes no client.track call from any accessor', async () => {
    const mockClient = makeMockLdClient();
    const store = new InMemorySkillStore();
    store.put(rawSkill({ key: 'a' }));
    store.put(rawSkill({ key: 'bad', contentHash: '0'.repeat(64) }));
    await initClient(mockClient, { skillStore: store });

    await getSkill('a');
    await getSkill('bad');
    await getSkills(['a']);
    await allSkills();
    skillRefs({ model: { name: 'm' }, provider: { name: 'p' }, instructions: 'i', skills: [{ key: 'a', version: 1 }] });

    expect(mockClient.track).not.toHaveBeenCalled();
  });

  it('a throwing emitter never breaks the operation', async () => {
    _setEmitterForTesting(new ThrowingEmitter());
    const store = new InMemorySkillStore();
    store.put(rawSkill({ key: 'bad', contentHash: '0'.repeat(64) }));
    store.put(rawSkill({ key: 'good' }));
    _setStore(store);

    expect(await getSkill('bad')).toBeNull();
    expect((await getSkill('good'))?.key).toBe('good');
  });

  it('records no signal outside the approved set', async () => {
    // The three names are an allowlist, not a floor. Asserted over the
    // recorded strings, so nothing here mandates a module-level constant.
    //
    // Guards the most likely regression: an implementation that also emits
    // `AgentControl Skill Content Retrieved` from getSkill, or
    // `AgentControl Skill SDK Reference Returned` from skillRefs, passes every
    // other test in this block.
    const emitter = new RecordingEmitter();
    _setEmitterForTesting(emitter);
    const store = new InMemorySkillStore();
    store.put(rawSkill({ key: 'good' }));
    store.put(rawSkill({ key: 'tampered', contentHash: '0'.repeat(64) }));
    _setStore(store);

    expect(await getSkill('good')).not.toBeNull();
    expect(await getSkill('tampered')).toBeNull();
    await getSkills(['good', 'tampered']);
    await allSkills();
    skillRefs({
      model: { name: 'm' },
      provider: { name: 'p' },
      instructions: 'i',
      skills: [{ key: 'good', version: 1 }],
    });

    const recorded = emitter.names();
    const unapproved = [...recorded].filter((name) => !APPROVED_SIGNALS.has(name));
    expect(unapproved).toEqual([]);
    for (const removed of REMOVED_SIGNALS) expect(recorded.has(removed)).toBe(false);
    // Positive control: a subset assertion is satisfied vacuously by an
    // implementation that records nothing at all.
    expect(recorded.has(INTEGRITY_SIGNAL)).toBe(true);
  });
});
