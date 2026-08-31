/**
 * Agent Skills — value types, reference discovery, the `SkillStore` seam, the
 * content accessors, the accessor half of the telemetry seam, and the local
 * integrity-failure log record.
 *
 * No network, no real LaunchDarkly client, no real skill transport.
 */

import { createHash } from 'node:crypto';
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
  getSkillResult,
  getSkills,
  InMemorySkillStore,
  skillRefs,
} from '../skills.js';
import type { RawSkillObject, Skill, SkillOutcomeReason, SkillStore } from '../types.js';
import {
  createReconcileAction,
  createReconcileReport,
  createSkill,
  createSkillOutcome,
  createSkillReference,
} from '../types.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

// The wire delivers `content` as a JSON string; a verified `Skill` carries the
// encoded bytes. Tests need both forms.
const SKILL_BODY = '---\nname: Test Skill\n---\nDo the thing.\n';
const SKILL_BODY_BYTES = new TextEncoder().encode(SKILL_BODY);

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

function hash(content: string | Uint8Array): string {
  return createHash('sha256')
    .update(typeof content === 'string' ? Buffer.from(content, 'utf-8') : content)
    .digest('hex');
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

function skill(content: Uint8Array = SKILL_BODY_BYTES, key = 'test-skill', version = 1): Skill {
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
      (s as { content: Uint8Array }).content = new TextEncoder().encode('tampered');
    }).toThrow(TypeError);
    expect(s.content).toBe(SKILL_BODY_BYTES);
  });

  it('Skill carries optional metadata', () => {
    const s = createSkill({
      key: 'a',
      version: 2,
      content: SKILL_BODY_BYTES,
      contentHash: hash(SKILL_BODY_BYTES),
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

  it('returns the verified skill with verbatim content bytes and metadata', async () => {
    store.put(rawSkill({ key: 'pdf-extraction', version: 2 }));
    const found = await getSkill('pdf-extraction');
    expect(found).not.toBeNull();
    expect(found?.key).toBe('pdf-extraction');
    expect(found?.version).toBe(2);
    expect(found?.content).toEqual(SKILL_BODY_BYTES);
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
    expect((await getSkill('a'))?.content).toEqual(new TextEncoder().encode(emoji));
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

// ─── The local integrity-failure log record ────────────────────────────

describe('integrity-failure log record', () => {
  // A documented customer-facing contract: operators point a SIEM at this line
  // and alert on it, and it is the *only* detection surface when telemetry is
  // off. So these assertions parse the JSON back rather than matching message
  // text, and they cover the field set, not just the fact that something logged.
  const EVENT = 'ld.skills.integrity_failure';

  type LoggedRecord = { line: string; record: Record<string, unknown> };

  async function logged(run: () => Promise<unknown>): Promise<LoggedRecord[]> {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let calls: unknown[][] = [];
    try {
      await run();
    } finally {
      // Read the calls out before restoring: `mockRestore` also resets the
      // recorded history, so a read afterwards sees nothing.
      calls = [...spy.mock.calls];
      spy.mockRestore();
    }
    return calls
      .map(([first]) => String(first))
      .filter((line) => line.includes(EVENT))
      .map((line) => ({ line, record: JSON.parse(line.slice(line.indexOf('{'))) as Record<string, unknown> }));
  }

  const surrogate = 'hi \ud800 there';

  // `getSkill` reaches seven of the eight call sites. The eighth is only
  // reachable through the listing path: `resolveFromStore` treats a non-object
  // store entry as absence before `verifyRawSkill` ever sees it, while
  // `allSkills` hands every raw value straight in.
  const GET = () => getSkill('a');
  const ALL = () => allSkills();

  /** A one-key store serving exactly what a hostile store might serve. */
  const serving = (raw: unknown) => () => new DictStore({ a: raw as RawSkillObject });

  /** A store serving a wire-shaped object with fields spoiled or dropped. */
  const spoiled =
    (overrides: Partial<RawSkillObject> & { key?: unknown }, drop: Array<'content' | 'contentHash'> = []) =>
    () => {
      const raw = rawSkill({ key: 'a', ...overrides });
      for (const field of drop) delete raw[field];
      return new DictStore({ a: raw });
    };

  /** One store per `reason_code`, each reaching a different call site. */
  const cases: Array<[string, () => SkillStore, () => Promise<unknown>]> = [
    ['not_an_object', serving('not an object'), ALL],
    ['invalid_key', spoiled({ key: 'Not/A/Key' }), GET],
    ['invalid_version', spoiled({ version: 0 }), GET],
    ['missing_content', spoiled({}, ['content']), GET],
    ['missing_content_hash', spoiled({}, ['contentHash']), GET],
    ['not_utf8', spoiled({ content: surrogate, contentHash: hash(Buffer.from(surrogate, 'utf-8')) }), GET],
    ['over_size_cap', spoiled({ content: 'x'.repeat(64 * 1024 + 1) }), GET],
    ['hash_mismatch', spoiled({ contentHash: 'd'.repeat(64) }), GET],
  ];

  it.each(cases)('logs one record carrying reason_code %s', async (code, makeStore, run) => {
    _setStore(makeStore());

    const records = await logged(run);

    expect(records).toHaveLength(1);
    const { record } = records[0];
    expect(record.reason_code).toBe(code);
    expect(record.event).toBe(EVENT);
    expect(record.action).toBe('withheld');
    expect(record.language).toBe('typescript');
    expect(typeof record.reason).toBe('string');
  });

  it('covers the whole reason_code vocabulary and nothing else', () => {
    // The eight tokens are one per call site of `recordIntegrityFailure`, and
    // the Python SDK emits the same eight. A ninth on one side only is the
    // regression this test exists to catch.
    expect(cases.map(([code]) => code).sort()).toEqual([
      'hash_mismatch',
      'invalid_key',
      'invalid_version',
      'missing_content',
      'missing_content_hash',
      'not_an_object',
      'not_utf8',
      'over_size_cap',
    ]);
  });

  it('logs the event name and nothing but the record, so a grep finds it', async () => {
    _setStore(new DictStore({ a: rawSkill({ key: 'a', contentHash: 'd'.repeat(64) }) }));

    const [{ line, record }] = await logged(() => getSkill('a'));

    expect(line).toBe(`[LaunchDarkly] ${EVENT} ${JSON.stringify(record)}`);
  });

  it('orders keys alphabetically, so the JSON mirrors the Python SDK byte for byte', async () => {
    // Python emits json.dumps(record, sort_keys=True). Insertion order here is
    // what makes the two outputs comparable with one parser and one alert rule.
    _setStore(new DictStore({ a: rawSkill({ key: 'a', version: 7, contentHash: 'd'.repeat(64) }) }));
    const [{ record }] = await logged(() => getSkill('a'));
    const keys = Object.keys(record);
    expect(keys).toEqual([...keys].sort());
    expect(keys).toEqual([
      'action',
      'event',
      'expected_hash',
      'language',
      'observed_hash',
      'reason',
      'reason_code',
      'skill_key',
      'version',
    ]);
  });

  it('redacts a hostile key, body and all', async () => {
    // The key comes off the wire, so it gets the same shape-check-then-redact
    // treatment as the signal — the body must not reach the log line either.
    const body = 'UNIQUE-SECRET-BODY-VIA-BOTH/../x';
    _setStore(new DictStore({ [body]: { key: body, version: 1, content: body, contentHash: body } }));

    const [{ line, record }] = await logged(() => getSkill(body));

    expect(record.skill_key).toBe('<invalid-key>');
    expect(line).not.toContain(body);
  });

  it('redacts a non-sha256 expected hash while still reporting the failure', async () => {
    const raw = rawSkill({ key: 'a' });
    raw.contentHash = 'not-a-digest';
    _setStore(new DictStore({ a: raw }));

    const [{ record }] = await logged(() => getSkill('a'));

    expect(record.expected_hash).toBe('<not-a-sha256-digest>');
    expect(record.reason_code).toBe('hash_mismatch');
  });

  it('omits observed_hash when the failure happened before hashing', async () => {
    const raw = rawSkill({ key: 'a' });
    delete raw.content;
    _setStore(new DictStore({ a: raw }));

    const [{ record }] = await logged(() => getSkill('a'));

    expect('observed_hash' in record).toBe(false);
    expect('expected_hash' in record).toBe(false);
    expect(record.version).toBe(1);
  });

  it('carries both hashes on a mismatch — the possible-tampering case', async () => {
    _setStore(new DictStore({ a: rawSkill({ key: 'a', contentHash: 'd'.repeat(64) }) }));

    const [{ record }] = await logged(() => getSkill('a'));

    expect(record.expected_hash).toBe('d'.repeat(64));
    expect(record.observed_hash).toBe(hash(SKILL_BODY));
  });

  it('omits an invalid version rather than emitting it', async () => {
    const raw = rawSkill({ key: 'a' });
    raw.version = 0;
    _setStore(new DictStore({ a: raw }));

    const [{ record }] = await logged(() => getSkill('a'));

    expect('version' in record).toBe(false);
  });

  it('never emits a null or an empty value in any record', async () => {
    // Absent fields are omitted. A null would make a SIEM field mapping
    // ambiguous between "not computed" and "computed as nothing".
    for (const [, makeStore, run] of cases) {
      _clearState();
      _setStore(makeStore());
      const [{ line, record }] = await logged(run);
      expect(line).not.toContain('null');
      for (const [key, value] of Object.entries(record)) {
        expect(value, key).not.toBeNull();
        expect(value, key).not.toBe('');
        expect(value, key).toBeDefined();
      }
    }
  });

  it('never contains the skill content', async () => {
    const secret = 'UNIQUE-SECRET-BODY-IN-CONTENT';
    _setStore(new DictStore({ a: rawSkill({ key: 'a', content: secret, contentHash: 'd'.repeat(64) }) }));

    const [{ line }] = await logged(() => getSkill('a'));

    expect(line).not.toContain(secret);
  });

  it('is logged with no emitter configured — telemetry off is not detection off', async () => {
    // The reason this record exists: it is the whole detection story for a
    // customer whose telemetry is switched off, or who has no destination.
    _setStore(new DictStore({ a: rawSkill({ key: 'a', contentHash: 'd'.repeat(64) }) }));

    const records = await logged(() => getSkill('a'));

    expect(records).toHaveLength(1);
    expect(records[0].record.reason_code).toBe('hash_mismatch');
  });
});

// ─── getSkillResult ────────────────────────────────────────────────────

describe('getSkillResult', () => {
  // The finding this suite covers: `getSkill` returns `null` for four distinct
  // outcomes, so a caller cannot fail closed on suspected tampering while
  // tolerating a skill nobody configured. These tests pin the distinction, and
  // they pin that adding it changed nothing about `getSkill`.

  const TAMPERED_HASH = 'd'.repeat(64);

  /** A store that cannot answer at all — an outage, not an absence. */
  function throwingStore(): SkillStore {
    return {
      getObject() {
        throw new Error('transport failure');
      },
      allObjects() {
        throw new Error('transport failure');
      },
    };
  }

  function storeHolding(...raws: RawSkillObject[]): InMemorySkillStore {
    const store = new InMemorySkillStore();
    for (const raw of raws) store.put(raw);
    return store;
  }

  /**
   * One store per reason token. The stores are shaped so each reaches a
   * different construction site in `resolveFromStore`, which is what makes the
   * mapping — not just the union — the thing under test.
   */
  const cases: Array<[SkillOutcomeReason, () => SkillStore, () => Promise<unknown>]> = [
    ['ok', () => storeHolding(rawSkill({ key: 'a' })), () => getSkillResult('a')],
    ['absent', () => new InMemorySkillStore(), () => getSkillResult('a')],
    [
      'integrity_failure',
      () => storeHolding(rawSkill({ key: 'a', contentHash: TAMPERED_HASH })),
      () => getSkillResult('a'),
    ],
    ['store_unavailable', throwingStore, () => getSkillResult('a')],
    [
      'wrong_version',
      () => storeHolding(rawSkill({ key: 'a', version: 3 })),
      () => getSkillResult('a', { version: 2 }),
    ],
  ];

  it.each(cases)('reports reason %s', async (reason, makeStore, run) => {
    _setStore(makeStore());

    const outcome = (await run()) as Awaited<ReturnType<typeof getSkillResult>>;

    expect(outcome.reason).toBe(reason);
    if (reason === 'ok') {
      // `skill` is populated exactly when the reason is `ok`, and `detail` is
      // the null that says there is nothing to explain.
      expect(outcome.skill).not.toBeNull();
      expect(outcome.skill?.key).toBe('a');
      expect(outcome.detail).toBeNull();
    } else {
      expect(outcome.skill).toBeNull();
      // Every failure carries an explanation. An empty string would be a
      // reason token with no detail behind it, which is worse than useless to
      // whoever is reading the alert.
      expect(typeof outcome.detail).toBe('string');
      expect((outcome.detail as string).length).toBeGreaterThan(0);
    }
  });

  it('covers the whole reason vocabulary and nothing else', () => {
    expect(cases.map(([reason]) => reason).sort()).toEqual([
      'absent',
      'integrity_failure',
      'ok',
      'store_unavailable',
      'wrong_version',
    ]);
  });

  it('distinguishes a store that could not answer from one that answered no', async () => {
    // The pair the whole feature exists for on the operational side: an outage
    // and an absence must not read the same, or a caller cannot tell "retry or
    // page someone" from "this skill was never configured".
    _setStore(throwingStore());
    const outage = await getSkillResult('a');

    _clearState();
    _setStore(new InMemorySkillStore());
    const missing = await getSkillResult('a');

    expect(outage.reason).toBe('store_unavailable');
    expect(missing.reason).toBe('absent');
    expect(outage.reason).not.toBe(missing.reason);
  });

  it('distinguishes tampering from absence — the fail-closed case', async () => {
    _setStore(storeHolding(rawSkill({ key: 'a', contentHash: TAMPERED_HASH })));
    const tampered = await getSkillResult('a');

    _clearState();
    _setStore(new InMemorySkillStore());
    const missing = await getSkillResult('a');

    expect(tampered.reason).toBe('integrity_failure');
    expect(missing.reason).toBe('absent');
    // Both are `null` from `getSkill`. That is the defect.
    expect(tampered.skill).toBeNull();
    expect(missing.skill).toBeNull();
  });

  // ── The store seam carries the version ──────────────────────────────

  /**
   * A store that genuinely holds two versions of one key and honours the pin.
   *
   * Inline rather than a rebuilt `InMemorySkillStore`: the point is the seam, and
   * multi-version semantics for the bundled store is a separate question.
   */
  function twoVersionStore(key: string, versions: number[]): SkillStore {
    const held = new Map<number, RawSkillObject>(versions.map((v) => [v, rawSkill({ key, version: v })]));
    return {
      getObject(_kind: string, k: string, version?: number | null) {
        if (k !== key) return null;
        if (version === null || version === undefined) return held.get(Math.max(...held.keys())) ?? null;
        return held.get(version) ?? null;
      },
      allObjects() {
        return {};
      },
    };
  }

  it('resolves a pinned version against a store holding several, not the newest', async () => {
    // Without the version threaded into `getObject`, the store answers with
    // version 5, the equality check refuses it, and the outcome reports
    // `wrong_version` for a pin the store could have satisfied — a wrong reason,
    // which is worse than a coarse one.
    _setStore(twoVersionStore('a', [2, 5]));

    const pinned = await getSkillResult('a', { version: 2 });

    expect(pinned.reason).toBe('ok');
    expect(pinned.skill?.version).toBe(2);
  });

  it('an omitted version still means the newest the store holds', async () => {
    _setStore(twoVersionStore('a', [2, 5]));

    const newest = await getSkillResult('a');

    expect(newest.reason).toBe('ok');
    expect(newest.skill?.version).toBe(5);
  });

  it('passes the requested version through to the store lookup', async () => {
    const seen: Array<number | null | undefined> = [];
    _setStore({
      getObject(_kind: string, _key: string, version?: number | null) {
        seen.push(version);
        return null;
      },
      allObjects() {
        return {};
      },
    });

    await getSkillResult('a', { version: 7 });
    await getSkillResult('a');

    expect(seen).toEqual([7, null]);
  });

  it('still refuses an answer that is not the version that was asked for', async () => {
    // The equality check is a defense, not the selection mechanism. A store that
    // ignores the pin — or lies about it — must not get its answer through.
    _setStore({
      getObject(_kind: string, _key: string, _version?: number | null) {
        return rawSkill({ key: 'a', version: 9 });
      },
      allObjects() {
        return {};
      },
    });

    const outcome = await getSkillResult('a', { version: 1 });

    expect(outcome.reason).toBe('wrong_version');
    expect(outcome.skill).toBeNull();
    expect(outcome.detail).toContain('version 1');
  });

  // ── getSkill is unchanged ───────────────────────────────────────────

  it('getSkill still resolves to null, and never rejects, for all four failures', async () => {
    // The no-behaviour-change guarantee. `getSkill`'s documented contract is
    // "resolves to `null` — never rejects", and every existing caller treats
    // that `null` as "no skill". Reporting the reason is additive or it is a
    // silent breaking change.
    for (const [reason, makeStore] of cases) {
      if (reason === 'ok') continue;
      _clearState();
      _setStore(makeStore());

      const wanted = reason === 'wrong_version' ? { version: 2 } : {};
      await expect(getSkill('a', wanted)).resolves.toBeNull();
    }
  });

  it('agrees with getSkill on the skill itself when there is one', async () => {
    _setStore(storeHolding(rawSkill({ key: 'a', version: 4 })));

    const outcome = await getSkillResult('a');
    const direct = await getSkill('a');

    expect(outcome.skill).toEqual(direct);
  });

  // ── Same single throw as getSkill ───────────────────────────────────

  it('throws when no store is configured, with the same message as getSkill', async () => {
    // "Throws only when no store is configured" is the contract both accessors
    // share; a caller switching between them must not have to catch anything new.
    const fromResult = await getSkillResult('a').catch((e: unknown) => e as Error);
    const fromGetSkill = await getSkill('a').catch((e: unknown) => e as Error);

    expect(fromResult).toBeInstanceOf(Error);
    expect(fromResult.message).toBe(fromGetSkill.message);
    expect(fromResult.message).toMatch(/skillStore/);
  });

  // ── Telemetry and the log record are untouched ───────────────────────

  it('emits no second integrity record — the failure was already reported', async () => {
    // The `ld.skills.integrity_failure` record fires inside verification, before
    // the resolution returns. Recording anything here would double-log one
    // failure and inflate a customer's alert count.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const emitter = new RecordingEmitter();
    _setEmitterForTesting(emitter);
    _setStore(storeHolding(rawSkill({ key: 'a', contentHash: TAMPERED_HASH })));

    let lines: string[] = [];
    try {
      const outcome = await getSkillResult('a');
      expect(outcome.reason).toBe('integrity_failure');
    } finally {
      lines = spy.mock.calls.map(([first]) => String(first));
      spy.mockRestore();
    }

    expect(lines.filter((line) => line.includes('ld.skills.integrity_failure'))).toHaveLength(1);
    expect(emitter.signals(INTEGRITY_SIGNAL)).toHaveLength(1);
  });

  it('emits no signal at all for an absent skill', async () => {
    const emitter = new RecordingEmitter();
    _setEmitterForTesting(emitter);
    _setStore(new InMemorySkillStore());

    expect((await getSkillResult('a')).reason).toBe('absent');

    expect(emitter.records).toEqual([]);
  });

  it('detail never contains the skill content', async () => {
    // `detail` is documented as safe to surface, so it gets the same treatment
    // the log record gets: a hostile store must not be able to route the body
    // through it.
    const secret = 'UNIQUE-SECRET-BODY-IN-DETAIL';
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      for (const raw of [
        rawSkill({ key: 'a', content: secret, contentHash: TAMPERED_HASH }),
        { key: 'a', version: 1, content: secret, contentHash: secret },
      ]) {
        _clearState();
        _setStore(new DictStore({ a: raw as RawSkillObject }));

        const outcome = await getSkillResult('a');

        expect(outcome.reason).toBe('integrity_failure');
        expect(outcome.detail).not.toContain(secret);
      }
    } finally {
      spy.mockRestore();
    }
  });

  it('detail names the key and both versions on a mismatch, and no path', async () => {
    _setStore(storeHolding(rawSkill({ key: 'pdf-extraction', version: 3 })));

    const { detail } = await getSkillResult('pdf-extraction', { version: 2 });

    expect(detail).toContain('pdf-extraction');
    expect(detail).toContain('version 2');
    expect(detail).toContain('version 3');
  });
});

// ─── createSkillOutcome ────────────────────────────────────────────────

describe('createSkillOutcome', () => {
  it('returns a frozen value, like the other value-type factories', () => {
    const outcome = createSkillOutcome({ reason: 'absent' });

    expect(Object.isFrozen(outcome)).toBe(true);
    expect(() => {
      (outcome as { reason: string }).reason = 'ok';
    }).toThrow(TypeError);
    expect(outcome.reason).toBe('absent');
  });

  it('defaults skill and detail to null', () => {
    const outcome = createSkillOutcome({ reason: 'store_unavailable' });

    expect(outcome.skill).toBeNull();
    expect(outcome.detail).toBeNull();
  });

  it('carries what it was given', () => {
    const built = skill();
    const outcome = createSkillOutcome({ skill: built, reason: 'ok', detail: null });

    expect(outcome.skill).toBe(built);
    expect(outcome.reason).toBe('ok');
  });
});

// ─── Package exports ───────────────────────────────────────────────────

describe('getSkillResult package exports', () => {
  it('exports the accessor and the outcome factory from the package root', async () => {
    // Imported here rather than at the top of the file so this stays a
    // self-contained check of the barrel.
    const pkg = await import('../index.js');
    expect(typeof pkg.getSkillResult).toBe('function');
    expect(typeof pkg.createSkillOutcome).toBe('function');
  });

  it('the SkillOutcomeReason union admits exactly the five reason tokens', () => {
    // The five tokens are API — customers branch on them, and the Python SDK
    // publishes the same five for the same conditions. Adding a sixth here
    // should force a matching change on the Python side, not just a green test.
    const exhaustive: Record<SkillOutcomeReason, true> = {
      absent: true,
      integrity_failure: true,
      ok: true,
      store_unavailable: true,
      wrong_version: true,
    };
    expect(Object.keys(exhaustive).sort()).toEqual([
      'absent',
      'integrity_failure',
      'ok',
      'store_unavailable',
      'wrong_version',
    ]);
  });
});
