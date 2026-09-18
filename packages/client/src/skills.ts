/**
 * Agent Skills — reference discovery and content accessors.
 *
 * The public retrieval surface: projecting the skill references a resolved AI
 * Config carries, and retrieving skill content through an injectable store seam.
 *
 * The three layers of the feature sit in three modules, and the dependencies run
 * one way only:
 *
 * - `skills-core.ts` — the store and telemetry seams, module state, integrity
 *   verification, and store resolution. Shared, and imports neither of the others.
 * - `skills.ts` (this file) — `skillRefs`, the accessors, and `InMemorySkillStore`.
 * - `skills-fs.ts` — the highest-blast-radius layer, the one that writes to a
 *   customer's disk. It owns the manifest format and the on-disk filenames;
 *   nothing here knows about the filesystem.
 *
 * `_setStore`, `_setEmitterForTesting`, and `_clearState` live here as the
 * injection path; the state they mutate lives in `skills-core.ts`.
 */

import {
  allRawObjects,
  clearState,
  newestByKey,
  referenceTarget,
  requireStore,
  resolveFromStore,
  SKILL_OBJECT_KIND,
  setEmitter,
  setStore,
  verifyRawSkill,
} from './skills-core.js';
import type { AiConfigRep, RawSkillObject, Skill, SkillOutcome, SkillReference, SkillStore } from './types.js';
import { createSkillOutcome, createSkillReference, isValidSkillKey, isValidSkillVersion } from './types.js';

// ---------------------------------------------------------------------------
// Injection points
// ---------------------------------------------------------------------------
//
// These three names are the injection seam: `initClient` and `shutdown` call
// them, and tests inject through them. They delegate to `skills-core.ts`, which
// owns the state, so that there is exactly one store and one emitter no matter
// which layer reaches for them.

/**
 * Installs the configured skill store.
 *
 * Called by the lifecycle layer from `initClient`, and by tests directly. There
 * is deliberately no test-only twin: the production setter is already reachable,
 * so one name for it is enough.
 */
export function _setStore(store: SkillStore): void {
  setStore(store);
}

/** Test helper — inject a recording emitter in place of the no-op default. */
export function _setEmitterForTesting(emitter: {
  record(signal: string, properties: Record<string, unknown>): void;
}): void {
  setEmitter(emitter);
}

/** Clears the configured store and emitter. Called by shutdown / test reset. */
export function _clearState(): void {
  clearState();
}

/**
 * A skill store backed by in-memory maps.
 *
 * Ships for local development, tests, and bring-your-own-content injection.
 * Holds raw wire objects verbatim and performs no validation of its own —
 * verification belongs at the accessor boundary, where it applies to every store
 * equally.
 *
 * Several versions of one key coexist here, because they coexist in a real
 * delivery payload: the newest version of every skill, plus every version a
 * variation currently pins. `getObject` therefore selects on `(key, version)`,
 * and an omitted version means "the newest held".
 *
 * An object whose `version` is not an integer >= 1 is still accepted and still
 * served, under its key alone. Withholding it is verification's job, not the
 * store's: a store that quietly refused it would make a malformed object
 * indistinguishable from an absent one, and no integrity signal would be
 * recorded.
 *
 * The backing maps are real `Map`s rather than plain objects. Skill keys come off
 * the wire, and a plain object inherits names that are not keys: a `put` of
 * `__proto__` would corrupt what every other key resolves to, and `constructor`
 * on an empty store would answer with the `Object` function. Nothing unverified
 * escapes to user code either way — verification rejects a function as a
 * non-object — but the store's own answers have to be right.
 */
export class InMemorySkillStore implements SkillStore {
  /** Well-formed objects, `key` -> `version` -> object. */
  private readonly versions = new Map<string, Map<number, RawSkillObject>>();

  /** Objects carrying no usable version, under their key alone. */
  private readonly loose = new Map<string, RawSkillObject>();

  private readonly listeners = new Map<string, Array<(raw: RawSkillObject) => unknown>>();

  constructor(objects: Record<string, RawSkillObject> = {}) {
    // Own enumerable entries only, so a map handed in with a `__proto__` entry
    // is filed like any other rather than reaching through to the prototype.
    for (const [objectKey, raw] of Object.entries(objects)) this.place(objectKey, raw);
  }

  /**
   * Files one raw object under its own identity, verbatim.
   *
   * `fallbackKey` is the map key it arrived under, used only when the object
   * carries no string `key` of its own — which the constructor admits and `put`
   * refuses.
   */
  private place(fallbackKey: string, raw: RawSkillObject): void {
    const own = typeof raw === 'object' && raw !== null ? raw.key : undefined;
    const key = typeof own === 'string' ? own : fallbackKey;
    const version = typeof raw === 'object' && raw !== null ? raw.version : undefined;
    if (isValidSkillVersion(version)) {
      const held = this.versions.get(key) ?? new Map<number, RawSkillObject>();
      held.set(version, raw);
      this.versions.set(key, held);
    } else {
      this.loose.set(key, raw);
    }
  }

  /**
   * Adds or replaces a raw skill object, keyed by its own `key` and `version`
   * fields.
   *
   * Putting a second version of a key keeps both; putting the same
   * `(key, version)` twice replaces it.
   *
   * Notifies every skill-kind listener with the raw object as a single argument.
   * No validation happens here — verification belongs at the accessor boundary,
   * where it applies to every store equally — so a listener sees exactly what was
   * put, unverified.
   */
  put(raw: RawSkillObject): void {
    const { key } = raw;
    if (typeof key !== 'string') throw new Error("a raw skill object must carry a string 'key'");
    this.place(key, raw);
    // A copy, so a listener that removes itself mid-notification does not
    // shift its neighbours out from under the iteration.
    for (const listener of [...(this.listeners.get(SKILL_OBJECT_KIND) ?? [])]) listener(raw);
  }

  /**
   * The raw object held for `key` at `version`, or the newest held when no
   * version is asked for.
   *
   * With nothing well-formed filed under the key, the version-less entry is all
   * there is: it is served, and verification withholds it with a signal rather
   * than it reading as simply absent. A pin that misses while well-formed
   * versions *do* exist is a plain miss, and answering it with a leftover
   * malformed object would record an integrity failure for a skill whose
   * integrity is not in question.
   */
  getObject(kind: string, key: string, version?: number | null): RawSkillObject | null {
    if (kind !== SKILL_OBJECT_KIND) return null;
    const held = this.versions.get(key);
    if (held === undefined || held.size === 0) return this.loose.get(key) ?? null;
    if (version !== undefined && version !== null) return held.get(version) ?? null;
    return held.get(Math.max(...held.keys())) ?? null;
  }

  /**
   * Every object held, one entry per `(key, version)`.
   *
   * The record's keys are **opaque store-internal identifiers**, as `SkillStore`
   * documents: identity is read from each object's own `key` and `version`. Do
   * not parse them and do not assume one entry per skill key.
   *
   * Null-prototype, because a loose object can be filed under the key
   * `__proto__` and assigning that name on a plain object would set its
   * prototype and silently drop the entry — shrinking a listing, which reads
   * downstream as a revocation.
   */
  allObjects(kind: string): Record<string, RawSkillObject> {
    if (kind !== SKILL_OBJECT_KIND) return {};
    const out: Record<string, RawSkillObject> = Object.create(null);
    for (const [key, held] of this.versions) {
      for (const [version, raw] of held) out[`${key}:${version}`] = raw;
    }
    for (const [key, raw] of this.loose) out[key] = raw;
    return out;
  }

  /**
   * Registers `fn` to be called with each raw object `put` under `kind`.
   *
   * Throws for any `kind` but `'skill'`. `put` accepts skill objects and nothing
   * else, so this store has no other kind to notify, and a listener it accepted
   * on one would silently never fire — indistinguishable from a store whose
   * objects never changed. `FDv2SkillStore.addListener` refuses the same way.
   */
  addListener(kind: string, fn: (raw: RawSkillObject) => unknown): void {
    if (kind !== SKILL_OBJECT_KIND) {
      throw new Error(
        `InMemorySkillStore notifies only '${SKILL_OBJECT_KIND}' changes, so a listener on ${JSON.stringify(kind)} ` +
          `would never fire. Register it on '${SKILL_OBJECT_KIND}'.`,
      );
    }
    const existing = this.listeners.get(kind);
    if (existing) existing.push(fn);
    else this.listeners.set(kind, [fn]);
  }

  /**
   * Unregisters `fn` from `kind`, so a subsequent `put` no longer calls it.
   *
   * Removes one occurrence: a callable registered twice must be removed twice.
   * Removing a callable that is not registered is a no-op, not an error, so a
   * consumer that detaches on close can do so unconditionally. Unlike
   * `addListener` this tolerates any `kind`, for the same reason.
   */
  removeListener(kind: string, fn: (raw: RawSkillObject) => unknown): void {
    const listeners = this.listeners.get(kind);
    if (!listeners) return;
    const index = listeners.indexOf(fn);
    if (index !== -1) listeners.splice(index, 1);
  }
}

// ---------------------------------------------------------------------------
// Reference discovery
// ---------------------------------------------------------------------------

/**
 * Projects a resolved AI Config's `skills` array into typed references.
 *
 * A pure projection — no network, no client, no store, no telemetry. Returns `[]`
 * when the config carries no skills. Compose it with the accessors for
 * per-context resolution: `await getSkills(skillRefs(config))`.
 */
export function skillRefs(config: AiConfigRep | null | undefined): SkillReference[] {
  if (typeof config !== 'object' || config === null) return [];

  const raw = (config as { skills?: unknown }).skills;
  if (!Array.isArray(raw)) return [];

  const refs: SkillReference[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { key, version } = entry as { key?: unknown; version?: unknown };
    if (isValidSkillKey(key) && isValidSkillVersion(version)) {
      refs.push(createSkillReference({ key, version }));
    }
  }
  return refs;
}

// ---------------------------------------------------------------------------
// Content accessors
// ---------------------------------------------------------------------------

/**
 * Retrieves one verified skill by key.
 *
 * An omitted `version` means the newest version the store holds; a specific
 * `version` returns the skill only when that exact version is available.
 * Resolves to `null` — never rejects — when the skill is missing, the requested
 * version is not the one held, or verification fails. Throws only when no skill
 * store is configured.
 *
 * There is no context parameter: skills have no targeting, so the SDK credentials
 * fully determine availability. Compose per-context resolution explicitly with
 * `getSkills(skillRefs(config))`.
 */
export async function getSkill(key: string, options: { version?: number } = {}): Promise<Skill | null> {
  return resolveFromStore(requireStore(), key, options.version ?? null).skill ?? null;
}

/**
 * Retrieves one skill and reports *why* — the accessor to reach for when a failed
 * retrieval needs a response rather than a fallback.
 *
 * Same lookup, same verification, and the same single rejection as
 * {@link getSkill}: only a missing store throws. The two differ in exactly one
 * respect, what they report. `getSkill` collapses four distinct outcomes into
 * `null`; this one names which it was, so a caller can **fail closed** on
 * `integrity_failure` — content and its declared digest disagreed, which is the
 * shape of active tampering with skill delivery — while treating `absent` as the
 * ordinary "no skill configured" it usually is, and `store_unavailable` as the
 * outage it is.
 *
 * `getSkill` is unchanged and remains the simpler default. Nothing else differs:
 * neither accessor retries or caches, and an integrity failure has already
 * written its `ld.skills.integrity_failure` log record and recorded its signal by
 * the time either returns, so reaching for this one costs no extra work and
 * double-logs nothing.
 *
 * `detail` is the human-readable reason — safe to surface, and carrying neither
 * skill content nor any filesystem path.
 *
 * There is no batch equivalent: `getSkills` and `allSkills` still omit entries
 * they could not return. Call this per key where the outcome matters.
 */
export async function getSkillResult(key: string, options: { version?: number } = {}): Promise<SkillOutcome> {
  const resolved = resolveFromStore(requireStore(), key, options.version ?? null);
  // A straight projection of the resolution: the reason is carried as a typed
  // token from the site that decided it, never re-derived from `error` here.
  return createSkillOutcome({
    skill: resolved.skill ?? null,
    reason: resolved.reason,
    detail: resolved.error ?? null,
  });
}

/**
 * Retrieves a batch of verified skills.
 *
 * Accepts a mixed sequence of `SkillReference` values and bare key strings, where
 * a string means "the latest version". Results follow input order for the skills
 * that were found; entries that are missing, are the wrong version, or fail
 * verification are omitted rather than returned as placeholders.
 */
export async function getSkills(refs: ReadonlyArray<SkillReference | string>): Promise<Skill[]> {
  if (typeof refs === 'string') {
    // A string is iterable, so this reaches here happily and would look up one
    // skill per character. Deliberately a TypeError — no string is a valid
    // argument here, unlike writeSkills, where the literal '*' is.
    throw new TypeError(
      `getSkills takes a sequence of references; pass [key] rather than a bare string. Got ${JSON.stringify(refs)}.`,
    );
  }

  const store = requireStore();

  const skills: Skill[] = [];
  for (const ref of refs) {
    const [key, wanted] = referenceTarget(ref);
    const { skill } = resolveFromStore(store, key, wanted);
    if (skill) skills.push(skill);
  }
  return skills;
}

/**
 * Retrieves every verified skill the store currently holds.
 *
 * Where the store holds several versions of one key, the newest is the one
 * returned. Skills that fail verification are omitted. Throws only when no skill
 * store is configured.
 */
export async function allSkills(): Promise<Skill[]> {
  const { objects, error } = allRawObjects(requireStore());
  if (error !== null) return [];

  // One entry per key at its newest version: `allObjects` may hold several
  // versions of one key, and a list carrying two of them is not a set of skills.
  const skills: Skill[] = [];
  for (const { raw } of newestByKey(objects)) {
    const skill = verifyRawSkill(raw);
    if (skill) skills.push(skill);
  }
  return skills;
}
