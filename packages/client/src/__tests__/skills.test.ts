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
