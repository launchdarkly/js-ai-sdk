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

import * as packageIndex from '../index.js';
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
import { allRawObjects, MAX_SKILL_CONTENT_BYTES, requireStore, SKILL_OBJECT_KIND } from '../skills-core.js';
import type { RawSkillObject, Skill, SkillStore } from '../types.js';
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

/**
 * One over-cap string for the whole file.
 *
 * At 10 MiB this costs real time and memory to allocate and to hash, and §3.21
 * asks for one true over-cap case rather than one per test — so the cases that
 * need it share this.
 */
const OVERSIZE = 'x'.repeat(MAX_SKILL_CONTENT_BYTES + 1);

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

// ─── Package exports ───────────────────────────────────────────────────

describe('package exports', () => {
  it('exports the three fixed values from the package root with exact values', () => {
    // These three are API, not implementation detail: a caller needs
    // MANIFEST_FILENAME to gitignore the manifest, and all three describe an
    // on-disk layout this SDK defines and a caller may have to agree with.
    expect(packageIndex.SKILL_FILENAME).toBe('SKILL.md');
    expect(packageIndex.MANIFEST_FILENAME).toBe('.launchdarkly-skills.json');
    expect(packageIndex.MANIFEST_VERSION).toBe(1);
  });

  it('does not export the object kind or the content cap from the package root', () => {
    // The absence is itself the contract, so it gets an assertion — an
    // accidental re-export from index.ts is caught here rather than shipping.
    //
    // SKILL_OBJECT_KIND is an SDK-side seam string rather than the wire format:
    // it is what the accessors hand SkillStore.getObject, and an adapter is free
    // to map it onto whatever its transport actually uses. MAX_SKILL_CONTENT_BYTES
    // is a local enforcement bound on content the platform produces, set well
    // above the platform's own limit precisely so that limit can move without
    // this constant following — a caller pre-flighting "will my skill fit?"
    // against it would be reading the backstop, not the real bound.
    expect('SKILL_OBJECT_KIND' in packageIndex).toBe(false);
    expect('MAX_SKILL_CONTENT_BYTES' in packageIndex).toBe(false);

    // Still reachable through the implementation module, for the store
    // implementer who has to agree with them. Asserted here rather than left
    // implicit so the absence above reads as "not published" rather than "gone".
    expect(SKILL_OBJECT_KIND).toBe('skill');
    expect(MAX_SKILL_CONTENT_BYTES).toBe(10 * 1024 * 1024);
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

  it('exports the delivery transport, the watcher, and their defaults from the package root', () => {
    // §3.25 / §3.26: the transport and the watcher are root exports in both
    // languages; the base-URI and debounce defaults are TypeScript-only root
    // exports (A.12).
    expect(typeof packageIndex.FDv2SkillStore).toBe('function');
    expect(typeof packageIndex.watchSkills).toBe('function');
    expect(typeof packageIndex.SkillWatcher).toBe('function');
    expect(packageIndex.DEFAULT_BASE_URI).toBe('https://sdk.launchdarkly.com');
    expect(packageIndex.DEFAULT_STREAM_URI).toBe('https://stream.launchdarkly.com');
    expect(packageIndex.DEFAULT_DEBOUNCE_MS).toBe(500);
  });

  it('exports getSkillResult and the outcome factory from the package root', () => {
    expect(typeof packageIndex.getSkillResult).toBe('function');
    expect(typeof packageIndex.createSkillOutcome).toBe('function');
  });

  it('the SkillOutcomeReason union admits exactly the five reason tokens', () => {
    // The five tokens are API — customers branch on them, and every SDK
    // publishes the same five for the same conditions. Adding a sixth here
    // should force a matching change in the other SDKs, not just a green test.
    //
    // Named through the package index rather than through types.js: it is the
    // *root* export that is fixed, and a union reachable only from the
    // implementation module is not reachable by a supported import.
    const exhaustive: Record<packageIndex.SkillOutcomeReason, true> = {
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

  it('drops a malformed entry and logs one warning per drop', async () => {
    // The silence is what makes this load-bearing rather than cosmetic. The
    // projection's output is what a caller hands `writeSkills`, and a shortened
    // list is indistinguishable there from "that skill is no longer requested" —
    // so with `prune: true` (the default) a silently dropped entry *deletes the
    // skill's files*. One warning per drop, each naming the position, is what
    // lets an operator find the offending entry.
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const refs = skillRefs({
        ...base,
        skills: [
          { key: 'ok', version: 1 },
          // Not an object at all.
          'nope' as unknown as { key: string; version: number },
          // An invalid key.
          { key: 'Not/A/Key', version: 1 },
          // An invalid version.
          { key: 'also-ok', version: 0 },
          { key: 'also-ok', version: 2 },
        ],
      });

      // The usable entries survive, in order.
      expect(refs).toEqual([
        { key: 'ok', version: 1 },
        { key: 'also-ok', version: 2 },
      ]);

      const lines = spy.mock.calls.map(([line]) => String(line));
      expect(lines).toHaveLength(3);
      // Each names its own position, so three drops are three distinct reports
      // rather than one summary an operator cannot act on.
      expect(lines[0]).toContain('skills[1]');
      expect(lines[1]).toContain('skills[2]');
      expect(lines[2]).toContain('skills[3]');
      for (const line of lines) expect(line).toContain('dropped from the projection');
    } finally {
      spy.mockRestore();
    }
  });

  it('warns about nothing when every entry is usable', async () => {
    // The positive control: a suite in which the warning never fires at all
    // cannot tell a per-drop warning from an unconditional one.
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(skillRefs({ ...base, skills: [{ key: 'a', version: 1 }] })).toHaveLength(1);
      expect(spy.mock.calls).toEqual([]);
    } finally {
      spy.mockRestore();
    }
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

  it('implements no isInitialized probe — a hand-populated store is never waiting (§3.21)', () => {
    expect('isInitialized' in new InMemorySkillStore()).toBe(false);
  });

  it('put then get', () => {
    const store = new InMemorySkillStore();
    const raw = rawSkill({ key: 'a' });
    store.put(raw);
    expect(store.getObject('skill', 'a')).toEqual(raw);
  });

  it("allObjects returns everything held, identified by each object's own key", () => {
    const store = new InMemorySkillStore();
    store.put(rawSkill({ key: 'a' }));
    store.put(rawSkill({ key: 'b' }));

    const held = Object.values(store.allObjects('skill'));

    // Deliberately not `Object.keys`: the record's keys are opaque
    // store-internal identifiers, and `SkillStore` says identity is read off
    // each object's own `key` and `version`. A test that asserted the spelling
    // would be pinning an implementation detail the interface disclaims.
    expect(held).toHaveLength(2);
    expect(held.map((raw) => raw.key).sort()).toEqual(['a', 'b']);
  });

  it('allObjects returns one entry per (key, version), not per key', () => {
    const store = new InMemorySkillStore();
    store.put(rawSkill({ key: 'a', version: 2 }));
    store.put(rawSkill({ key: 'a', version: 5 }));

    const held = Object.values(store.allObjects('skill'));

    expect(held).toHaveLength(2);
    expect(held.map((raw) => raw.version).sort()).toEqual([2, 5]);
  });

  it('replaces an object put twice under the same (key, version)', () => {
    const store = new InMemorySkillStore();
    store.put(rawSkill({ key: 'a', version: 2, content: 'first' }));
    store.put(rawSkill({ key: 'a', version: 2, content: 'second' }));

    const held = Object.values(store.allObjects('skill'));

    expect(held).toHaveLength(1);
    expect(held[0].content).toBe('second');
  });

  it('getObject with no version answers with the newest version held', () => {
    const store = new InMemorySkillStore();
    // Put the newer one first, so insertion order cannot pass for ordering.
    store.put(rawSkill({ key: 'a', version: 5 }));
    store.put(rawSkill({ key: 'a', version: 2 }));

    expect(store.getObject('skill', 'a')?.version).toBe(5);
    expect(store.getObject('skill', 'a', null)?.version).toBe(5);
  });

  it('getObject with a version answers with exactly that version', () => {
    const store = new InMemorySkillStore();
    store.put(rawSkill({ key: 'a', version: 2 }));
    store.put(rawSkill({ key: 'a', version: 5 }));

    expect(store.getObject('skill', 'a', 2)?.version).toBe(2);
    expect(store.getObject('skill', 'a', 5)?.version).toBe(5);
  });

  it('getObject returns null for a pin that misses while well-formed versions exist', () => {
    // A plain miss. Answering it with some other version the store happens to
    // hold would record an integrity failure for a skill whose integrity is not
    // in question.
    const store = new InMemorySkillStore();
    store.put(rawSkill({ key: 'a', version: 2 }));
    store.put(rawSkill({ key: 'a', version: 5 }));

    expect(store.getObject('skill', 'a', 3)).toBeNull();
  });

  it('serves a malformed object for a pinned request when nothing well-formed is held', () => {
    // An object too malformed to carry a usable version is still served, so
    // verification is what withholds it — with a signal. Reading it as simply
    // absent would let a tampered object look like a deleted one, and would let
    // a prune delete the last known-good copy on disk.
    const store = new InMemorySkillStore();
    const malformed = rawSkill({ key: 'a', version: 'not-a-version' as unknown as number });
    store.put(malformed);

    expect(store.getObject('skill', 'a', 4)).toBe(malformed);
    expect(store.getObject('skill', 'a')).toBe(malformed);
    expect(Object.values(store.allObjects('skill'))).toEqual([malformed]);
  });

  it('cannot be reached through the prototype', () => {
    // `constructor` satisfies the skill-key pattern, so it arrives as an
    // ordinary lookup. Backed by a plain object, an empty store would answer it
    // with the `Object` function. Asserted on the store's own answer rather than
    // an accessor's: verification already refuses a function as a non-object, so
    // this is about the store's semantics being right, not a content-integrity
    // hole.
    const empty = new InMemorySkillStore();
    expect(empty.getObject('skill', 'constructor')).toBeNull();
    expect(empty.getObject('skill', '__proto__')).toBeNull();
    expect(empty.getObject('skill', 'toString')).toBeNull();
    expect(Object.values(empty.allObjects('skill'))).toEqual([]);
  });

  it('cannot be corrupted by a put of an inherited name', () => {
    // Backed by a plain object, this `put` writes the *prototype*, and every
    // later lookup whose key happens to name a field of the planted object —
    // `name` and `description` both satisfy the skill-key pattern — answers with
    // that field's value instead of null.
    const store = new InMemorySkillStore();
    const planted = rawSkill({ key: '__proto__', version: 1 });
    store.put(planted);

    expect(store.getObject('skill', 'name')).toBeNull();
    expect(store.getObject('skill', 'description')).toBeNull();
    expect(store.getObject('skill', 'content')).toBeNull();

    store.put(rawSkill({ key: 'a', version: 1 }));
    expect(store.getObject('skill', 'a')?.key).toBe('a');

    // And the planted object is held under its own key rather than lost, so the
    // listing does not silently shrink.
    expect(store.getObject('skill', '__proto__')).toBe(planted);
    expect(Object.values(store.allObjects('skill'))).toHaveLength(2);
  });

  it('cannot be corrupted by an inherited name in the constructor map', () => {
    const planted = rawSkill({ key: '__proto__', version: 1 });
    const store = new InMemorySkillStore({ ['__proto__']: planted });

    expect(store.getObject('skill', 'name')).toBeNull();
    expect(store.getObject('skill', 'description')).toBeNull();
    expect(store.getObject('skill', '__proto__')).toBe(planted);
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

  it('refuses a listener for a kind it cannot notify', () => {
    const store = new InMemorySkillStore();
    expect(() => store.addListener('flag', vi.fn())).toThrow(/never fire/);
  });

  it('keeps no listener it refused', () => {
    const store = new InMemorySkillStore();
    const other = vi.fn();
    expect(() => store.addListener('flag', other)).toThrow();
    store.put(rawSkill({ key: 'a' }));
    expect(other).not.toHaveBeenCalled();
  });

  it('stops notifying a listener once removed', () => {
    const store = new InMemorySkillStore();
    const seen = vi.fn();
    store.addListener('skill', seen);
    store.removeListener('skill', seen);
    store.put(rawSkill({ key: 'a' }));
    expect(seen).not.toHaveBeenCalled();
  });

  it('removes one occurrence per removeListener call', () => {
    const store = new InMemorySkillStore();
    const seen = vi.fn();
    store.addListener('skill', seen);
    store.addListener('skill', seen);
    store.removeListener('skill', seen);
    store.put(rawSkill({ key: 'a' }));
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it('treats removing an unregistered listener as a no-op', () => {
    const store = new InMemorySkillStore();
    const fn = vi.fn();
    store.removeListener('skill', fn);
    store.addListener('skill', fn);
    store.removeListener('flag', fn);
    store.removeListener('skill', fn);
    store.removeListener('skill', fn);
    store.put(rawSkill({ key: 'a' }));
    expect(fn).not.toHaveBeenCalled();
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

  it('the no-store message names the delivery store first', async () => {
    // A deployment that hits this message must be pointed at the store that
    // receives content from LaunchDarkly, not only at the development one.
    const message = await getSkill('a').then(
      () => '',
      (cause: Error) => cause.message,
    );
    expect(message).toContain('FDv2SkillStore');
    expect(message).toContain('InMemorySkillStore');
    expect(message.indexOf('FDv2SkillStore')).toBeLessThan(message.indexOf('InMemorySkillStore'));
    expect(message).not.toContain('follow-up release');
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
    // The declared type, asserted before the value: `content` is an opaque byte
    // buffer and never a string, and `toEqual` alone passes for any
    // structurally-equal value — including a plain array of the same numbers.
    expect(found?.content).toBeInstanceOf(Uint8Array);
    expect(found?.content).toEqual(SKILL_BODY_BYTES);
    expect(found?.contentHash).toBe(hash(SKILL_BODY));
    expect(found?.name).toBe('Test Skill');
    expect(found?.description).toBe('A skill used in tests.');
  });

  it('an omitted version means the newest available', async () => {
    // Two versions, newer one seeded first: a store holding one version cannot
    // distinguish "newest" from "the only one", and insertion order must not
    // pass for ordering.
    store.put(rawSkill({ key: 'a', version: 7 }));
    store.put(rawSkill({ key: 'a', version: 4 }));
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

  it('withholds a store answering under a different key as integrity_failure, silently', async () => {
    // The key needs the same post-fetch defense the version already has.
    // Identity is read off the object itself, and the store is untrusted. An
    // answer served under a different key would otherwise be handed back under
    // the key the caller asked for while carrying its own.
    //
    // The token is `integrity_failure`, not `wrong_version`: content was
    // delivered and its identity did not verify, which is the one outcome a
    // caller is expected to fail closed on. `wrong_version` names a version
    // mismatch specifically and there is deliberately no `wrong_key`, so a
    // substituting store filed under it would be invisible to a caller
    // branching on the token. Pinned here because the choice is not recoverable
    // from the message.
    //
    // The silence is the other half, and it is asserted in both directions: the
    // check runs *after* verifyRawSkill has already passed, so neither §3.24
    // detection surface fires. A recorded signal or a logged record here would
    // mean the check had migrated into verification — a real change, not a
    // cosmetic one, since it would need a ninth reason_code to go with it.
    const aliasing: SkillStore = {
      getObject() {
        return rawSkill({ key: 'other-key' });
      },
      allObjects() {
        return {};
      },
    };
    _setStore(aliasing);

    const emitter = new RecordingEmitter();
    _setEmitterForTesting(emitter);

    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let errorCalls: unknown[][] = [];
    let collapsed: Skill | null;
    let outcome: Awaited<ReturnType<typeof getSkillResult>>;
    try {
      collapsed = await getSkill('asked-for');
      outcome = await getSkillResult('asked-for');
    } finally {
      // Read the calls out before restoring: `mockRestore` also resets the
      // recorded history, so a read afterwards sees nothing.
      errorCalls = [...spy.mock.calls];
      spy.mockRestore();
    }

    expect(collapsed).toBeNull();
    expect(outcome.skill).toBeNull();
    expect(outcome.reason).toBe('integrity_failure');
    // Branch on the token, not on the message: `detail` is for a human. Assert
    // only that it is present and carries no skill body.
    expect(outcome.detail).toBeTruthy();
    expect(outcome.detail).not.toContain('Do the thing.');

    expect(emitter.records).toEqual([]);
    const lines = errorCalls.map(([first]) => String(first));
    expect(lines.filter((line) => line.includes('ld.skills.integrity_failure'))).toEqual([]);
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

  it('returns the newest version per key', async () => {
    // A list carrying two versions of one key is not a set of skills, and
    // downstream `<root>/<key>/SKILL.md` is a single path. The store holds both,
    // so the collapse has to happen here. Newer seeded first, so insertion order
    // cannot pass for ordering.
    const store = new InMemorySkillStore();
    store.put(rawSkill({ key: 'a', version: 5 }));
    store.put(rawSkill({ key: 'a', version: 2 }));
    store.put(rawSkill({ key: 'b', version: 1 }));
    _setStore(store);

    const found = await allSkills();

    expect(found.filter((s) => s.key === 'a')).toHaveLength(1);
    expect(found.find((s) => s.key === 'a')?.version).toBe(5);
    expect(found.map((s) => s.key).sort()).toEqual(['a', 'b']);
  });

  it('keeps an unusable object in the set so verification withholds it with a signal', async () => {
    // Filtering it here instead would silently shrink the resolved set, which on
    // the materialization path is indistinguishable from a revocation and would
    // let prune delete a live skill's last good copy. The recorded signal is
    // what proves the object reached verification rather than being dropped.
    const emitter = new RecordingEmitter();
    _setEmitterForTesting(emitter);
    const store = new InMemorySkillStore();
    store.put(rawSkill({ key: 'good', version: 1 }));
    store.put(rawSkill({ key: 'unusable', version: 'nope' as unknown as number }));
    _setStore(store);

    const found = await allSkills();

    expect(found.map((s) => s.key)).toEqual(['good']);
    expect(emitter.signals(INTEGRITY_SIGNAL)).toHaveLength(1);
  });

  it('records no signal for a key an unusable sibling did not stop resolving', async () => {
    // The other side of the rule above. A store may hold a malformed object
    // beside a well-formed version of the same key; the well-formed one
    // resolves, so the key was never withheld and must not be reported as
    // though it were. Keeping the sibling could only add an integrity failure
    // for a skill whose integrity is not in question.
    const emitter = new RecordingEmitter();
    _setEmitterForTesting(emitter);
    const store = new InMemorySkillStore();
    store.put(rawSkill({ key: 'a', version: 1 }));
    store.put(rawSkill({ key: 'a', version: 'nope' as unknown as number }));
    _setStore(store);

    const found = await allSkills();

    expect(found.map((s) => s.key)).toEqual(['a']);
    expect(emitter.signals(INTEGRITY_SIGNAL)).toEqual([]);
  });

  it('returns an empty list for an empty store', async () => {
    _setStore(new InMemorySkillStore());
    expect(await allSkills()).toEqual([]);
  });

  it('reports a non-object listing as a broken store, not an empty one', async () => {
    // `allSkills` has no way to report the difference, so it returns an empty
    // list either way — but the reason has to reach the caller that does act on
    // it. Collapsing the answer to "no skills" reads downstream as "every skill
    // was revoked".
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const brokenListing: SkillStore = {
        getObject() {
          return null;
        },
        allObjects() {
          return null as unknown as Record<string, RawSkillObject>;
        },
      };
      _setStore(brokenListing);

      expect(await allSkills()).toEqual([]);

      const { objects, error } = allRawObjects(requireStore());
      expect(objects).toEqual({});
      expect(error).toBe('the skill store listed skills as null rather than an object');
      expect(spy.mock.calls.map(([line]) => String(line))).toEqual([
        '[LaunchDarkly] Skill store listed skills as null rather than an object',
        '[LaunchDarkly] Skill store listed skills as null rather than an object',
      ]);
    } finally {
      spy.mockRestore();
    }
  });

  it('names the type a broken listing came back as', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const listingAs = (value: unknown): SkillStore => ({
        getObject: () => null,
        allObjects: () => value as Record<string, RawSkillObject>,
      });
      expect(allRawObjects(listingAs([])).error).toBe('the skill store listed skills as array rather than an object');
      expect(allRawObjects(listingAs('x')).error).toBe('the skill store listed skills as string rather than an object');
      expect(allRawObjects(listingAs(undefined)).error).toBe(
        'the skill store listed skills as undefined rather than an object',
      );
      expect(allRawObjects(new InMemorySkillStore())).toEqual({ objects: {}, error: null });
    } finally {
      spy.mockRestore();
    }
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

  it('rejects content one byte over the size cap even when its hash matches', async () => {
    const emitter = new RecordingEmitter();
    _setEmitterForTesting(emitter);
    const store = new InMemorySkillStore();
    store.put(rawSkill({ key: 'a', content: OVERSIZE }));
    _setStore(store);

    expect(await getSkill('a')).toBeNull();
    expect(emitter.signals(INTEGRITY_SIGNAL)).toHaveLength(1);
  });

  it('reports over_size_cap, not not_utf8, for over-cap content that also carries a lone surrogate (§3.21)', async () => {
    // The checks run in a fixed order — shape, size, encoding, hash — and size
    // precedes encoding deliberately: running an encoding pass over a 10 MiB
    // body before rejecting it for being 10 MiB is a DoS foothold. This is the
    // one boundary where the order is observable.
    const emitter = new RecordingEmitter();
    _setEmitterForTesting(emitter);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    errorSpy.mockClear();
    const content = `\ud800${OVERSIZE}`;
    _setStore(new DictStore({ a: rawSkill({ key: 'a', content, contentHash: hash(Buffer.from(content, 'utf-8')) }) }));

    expect(await getSkill('a')).toBeNull();

    const logged = errorSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('"reason_code":"over_size_cap"');
    expect(logged).not.toContain('not_utf8');
    expect(emitter.signals(INTEGRITY_SIGNAL)).toHaveLength(1);
  });

  it('accepts content at exactly the size cap', async () => {
    const atCap = 'x'.repeat(MAX_SKILL_CONTENT_BYTES);
    const store = new InMemorySkillStore();
    store.put(rawSkill({ key: 'a', content: atCap }));
    _setStore(store);
    expect((await getSkill('a'))?.content).toHaveLength(MAX_SKILL_CONTENT_BYTES);
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

  it('rejects a non-object raw entry — absent when pinned, not_an_object when listed (§3.21)', async () => {
    // The asymmetry is the contract. A pinned lookup that comes back as a
    // non-object is a broken store adapter answering "nothing", reported as
    // `absent` with no signal and no log record — firing a tampering signal on
    // every broken adapter would drown the real ones. The listing path hands
    // every raw value straight to verification, which is where `not_an_object`
    // fires.
    const emitter = new RecordingEmitter();
    _setEmitterForTesting(emitter);
    // `spyOn` on an already-spied method hands back the existing spy with its
    // history, so clear it: only what *this* test logs may count.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    errorSpy.mockClear();
    _setStore(new DictStore({ a: 'not an object' as unknown as RawSkillObject }));

    expect(await getSkill('a')).toBeNull();
    const outcome = await getSkillResult('a');
    expect(outcome.reason).toBe('absent');
    expect(emitter.records).toEqual([]);
    expect(errorSpy).not.toHaveBeenCalled();

    expect(await allSkills()).toEqual([]);
    const signals = emitter.signals(INTEGRITY_SIGNAL);
    expect(signals).toHaveLength(1);
    expect(signals[0].skill_key).toBe('<invalid-key>');
    const logged = errorSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('"reason_code":"not_an_object"');
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
    // An unpaired surrogate has no UTF-8 encoding, and Node's Buffer.from
    // *silently substitutes* U+FFFD rather than raising, so only an explicit
    // round-trip check catches it — without that check a store can supply the
    // hash of the substituted bytes and have fabricated content pass
    // verification.
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

  it('verifies content that begins with a byte-order mark', async () => {
    // The counterpart to the surrogate case above, and the reason the round-trip
    // guard decodes with `ignoreBOM: true`. A default TextDecoder consumes a
    // leading U+FEFF, which would make authentic BOM-prefixed content round-trip
    // to a shorter string and be withheld as not_utf8 despite hashing correctly.
    const content = '\ufeff---\nname: bom\n---\nbody\n';
    const encoded = new TextEncoder().encode(content);
    const store = new DictStore({
      a: { key: 'a', version: 1, content, contentHash: createHash('sha256').update(encoded).digest('hex') },
    });
    _setStore(store);

    expect((await getSkill('a'))?.content).toEqual(encoded);
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
    // Exactly those five and no more: the signal's property set is a documented
    // allowlist, so the assertion is on the whole set rather than on each
    // member. The five present is half a test.
    expect(Object.keys(props).sort()).toEqual(['expected_hash', 'language', 'observed_hash', 'skill_key', 'version']);
  });

  it('keeps the four record-only fields out of the signal', async () => {
    // The log record is the larger of the two surfaces and carries four fields
    // the signal must not: a stable `event` identity, the `action` taken, the
    // human-readable `reason`, and the machine-parseable `reason_code`. Letting
    // them leak into the signal is the regression this guards — the signal's
    // property set is an allowlist that does not grow, and the two surfaces are
    // deliberately different sizes.
    const emitter = new RecordingEmitter();
    _setEmitterForTesting(emitter);
    _setStore(new DictStore({ a: rawSkill({ key: 'a', contentHash: 'b'.repeat(64) }) }));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await getSkill('a');
    } finally {
      spy.mockRestore();
    }

    const [props] = emitter.signals(INTEGRITY_SIGNAL);
    for (const field of ['event', 'action', 'reason', 'reason_code']) {
      expect(field in props, field).toBe(false);
    }
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

  type LoggedRecord = {
    /** The message text — the first argument. */
    line: string;
    /** The mapping parsed back out of the message text. */
    record: Record<string, unknown>;
    /** The structured attachment — every argument after the first. */
    rest: unknown[];
  };

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
      .filter(([first]) => String(first).includes(EVENT))
      .map(([first, ...rest]) => {
        const line = String(first);
        return { line, record: JSON.parse(line.slice(line.indexOf('{'))) as Record<string, unknown>, rest };
      });
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
    ['over_size_cap', spoiled({ content: OVERSIZE }), GET],
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
    // every language implementation emits the same eight. A ninth in one SDK
    // only is the
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

  it('emits the record twice over: in the message text and as structured data', async () => {
    // Both forms are required, and neither is sufficient alone. A default
    // `console.error` transport shows only the message text, so a
    // structured-only record is invisible under the setup most customers have —
    // and severity cannot stand in for it, because other store-failure paths in
    // this module also log at error level. A structured pipeline, conversely,
    // wants the mapping as *data* rather than as text it has to re-parse out of
    // a prefixed line. Python's half of this is `extra={"ld_skills": record}`.
    _setStore(new DictStore({ a: rawSkill({ key: 'a', version: 7, contentHash: 'd'.repeat(64) }) }));

    const [{ line, record, rest }] = await logged(() => getSkill('a'));

    // Form one: the event identity verbatim in the text, followed by the JSON.
    expect(line.startsWith(`[LaunchDarkly] ${EVENT} `)).toBe(true);
    // Form two: the same mapping, attached rather than serialized.
    expect(rest).toHaveLength(1);
    const attached = rest[0] as Record<string, unknown>;
    expect(typeof attached).toBe('object');
    expect(attached).not.toBeNull();
    // The *same* mapping — asserted field-for-field, because an attachment that
    // had drifted from the text would defeat the point of having both.
    expect(attached).toEqual(record);
    // And key order agrees too, which is what keeps the two halves from
    // diverging the day someone reorders one of them.
    expect(Object.keys(attached)).toEqual(Object.keys(record));
  });

  it('attaches the record on every reason_code, not just one path', async () => {
    // The attachment is added at the single `console.error` call site, so one
    // case would nearly prove it — but "nearly" is how a second call site gets
    // added later without one. Sweep the vocabulary.
    for (const [code, makeStore, run] of cases) {
      _clearState();
      _setStore(makeStore());

      const [{ record, rest }] = await logged(run);

      expect(rest, code).toHaveLength(1);
      expect(rest[0], code).toEqual(record);
    }
  });

  it('orders keys alphabetically, so the JSON is byte-identical across SDKs', async () => {
    // Every SDK emits these keys sorted. Insertion order here is what makes the
    // outputs comparable with one parser and one alert rule.
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

  it('agrees with the signal on every key the two surfaces share', async () => {
    // The record's fields are *spread* from the signal's rather than rebuilt,
    // and that is the property worth pinning: two independently assembled
    // mappings would drift, and the ones most likely to drift are exactly the
    // ones that matter — which fields are redacted and which are omitted. So
    // this captures both surfaces from one failure and compares them key by key.
    //
    // A *redacting* failure on purpose: `contentHash` is not a digest, so
    // `expected_hash` goes through the replacement branch on its way into both
    // surfaces. A well-formed failure would compare equal even against an
    // implementation that rebuilt the record by hand.
    const emitter = new RecordingEmitter();
    _setEmitterForTesting(emitter);
    _setStore(new DictStore({ a: rawSkill({ key: 'a', version: 7, contentHash: 'not-a-digest' }) }));

    const [{ record }] = await logged(() => getSkill('a'));
    const [props] = emitter.signals(INTEGRITY_SIGNAL);

    // Every key the signal carries is a key the record carries — the overlap is
    // the signal's whole property set, not an incidental one or two.
    expect(Object.keys(props).sort()).toEqual(['expected_hash', 'language', 'observed_hash', 'skill_key', 'version']);
    for (const key of Object.keys(props)) expect(record[key], key).toEqual(props[key]);
    // Including the redaction, which is the half a rebuilt record loses.
    expect(props.expected_hash).toBe('<not-a-sha256-digest>');
  });

  it('agrees with the signal on which fields are omitted, not only on values', async () => {
    // The other half of "spread, not rebuilt": a field neither surface knows has
    // to be missing from both. A record assembled separately is exactly where an
    // explicit `null` or a stale default creeps in on one side only.
    const emitter = new RecordingEmitter();
    _setEmitterForTesting(emitter);
    const raw = rawSkill({ key: 'a' });
    // No content and an unusable version: nothing was hashed, so neither hash is
    // known, and the version cannot be reported either.
    delete raw.content;
    raw.version = 0;
    _setStore(new DictStore({ a: raw }));

    const [{ record }] = await logged(() => getSkill('a'));
    const [props] = emitter.signals(INTEGRITY_SIGNAL);

    for (const key of ['version', 'expected_hash', 'observed_hash']) {
      expect(key in props, `signal ${key}`).toBe(false);
      expect(key in record, `record ${key}`).toBe(false);
    }
    // And what is left still agrees.
    expect(Object.keys(props).sort()).toEqual(['language', 'skill_key']);
    for (const key of Object.keys(props)) expect(record[key], key).toEqual(props[key]);
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
   * A store that answers a pinned lookup with some other version.
   *
   * `wrong_version` is not reachable through `InMemorySkillStore`, which honours
   * the pin and answers a miss with `null` — that is `absent`, correctly, because
   * the store said it holds nothing for that pin. The reason exists for a store
   * that *does* answer and answers with the wrong thing, so the test needs one:
   * `resolveFromStore`'s equality check is a defense against an untrusted store,
   * not the selection mechanism.
   */
  function wrongVersionStore(answeredVersion = 99): SkillStore {
    return {
      getObject(_kind: string, key: string) {
        return rawSkill({ key, version: answeredVersion });
      },
      allObjects() {
        return {};
      },
    };
  }

  /**
   * One store per reason token. The stores are shaped so each reaches a
   * different construction site in `resolveFromStore`, which is what makes the
   * mapping — not just the union — the thing under test.
   */
  const cases: Array<[packageIndex.SkillOutcomeReason, () => SkillStore, () => Promise<unknown>]> = [
    ['ok', () => storeHolding(rawSkill({ key: 'a' })), () => getSkillResult('a')],
    ['absent', () => new InMemorySkillStore(), () => getSkillResult('a')],
    [
      'integrity_failure',
      () => storeHolding(rawSkill({ key: 'a', contentHash: TAMPERED_HASH })),
      () => getSkillResult('a'),
    ],
    ['store_unavailable', throwingStore, () => getSkillResult('a')],
    ['wrong_version', () => wrongVersionStore(3), () => getSkillResult('a', { version: 2 })],
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

  it('reports absent, not wrong_version, for a pin a multi-version store does not hold', async () => {
    // The store honours the pin and answers `null`: it has told us it holds
    // nothing at that version, which is an absence. `wrong_version` is for a
    // store that answers *and answers wrongly* — the two are not the same
    // report, and a caller tolerating `absent` should not be handed a
    // tampering-shaped token for a version nobody published.
    _setStore(storeHolding(rawSkill({ key: 'a', version: 2 }), rawSkill({ key: 'a', version: 5 })));

    const outcome = await getSkillResult('a', { version: 3 });

    expect(outcome.reason).toBe('absent');
    expect(outcome.skill).toBeNull();
  });

  it('detail names the key and both versions on a mismatch, and no path', async () => {
    _setStore(wrongVersionStore(3));

    const { detail } = await getSkillResult('pdf-extraction', { version: 2 });

    expect(detail).toContain('pdf-extraction');
    expect(detail).toContain('version 2');
    expect(detail).toContain('version 3');
    // Safe to log: no path separator and no root path of any kind.
    expect(detail).not.toMatch(/[\\/]/);
    expect(detail).not.toContain(process.cwd());
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
