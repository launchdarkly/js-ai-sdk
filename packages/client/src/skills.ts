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
 * A skill store backed by a plain object.
 *
 * Ships for local development, tests, and bring-your-own-content injection.
 * Holds raw wire objects verbatim and performs no validation of its own —
 * verification belongs at the accessor boundary, where it applies to every store
 * equally.
 */
export class InMemorySkillStore implements SkillStore {
  private readonly objects: Record<string, RawSkillObject>;
  private readonly listeners = new Map<string, Array<(raw: RawSkillObject) => unknown>>();

  constructor(objects: Record<string, RawSkillObject> = {}) {
    this.objects = { ...objects };
  }

  /**
   * Adds or replaces a raw skill object, keyed by its own `key` field.
   *
   * Notifies every skill-kind listener with the raw object as a single argument.
   * No validation happens here — verification belongs at the accessor boundary,
   * where it applies to every store equally — so a listener sees exactly what was
   * put, unverified.
   */
  put(raw: RawSkillObject): void {
    const { key } = raw;
    if (typeof key !== 'string') throw new Error("a raw skill object must carry a string 'key'");
    this.objects[key] = raw;
    for (const listener of this.listeners.get(SKILL_OBJECT_KIND) ?? []) listener(raw);
  }

  /**
   * The raw object held for `key`, whatever version it happens to be.
   *
   * The parameter is accepted because the `SkillStore` seam carries it — a real
   * store may hold several versions of one key, and only the store can pick
   * between them. This one holds a single object per key, so it answers with
   * what it has and lets the accessor boundary refuse an answer that is not the
   * version that was asked for.
   *
   * Deliberately not a filter: returning `null` for a pin this store cannot
   * satisfy would make a version mismatch indistinguishable from an absence,
   * which is the whole distinction the typed outcome exists to preserve.
   */
  getObject(kind: string, key: string, _version?: number | null): RawSkillObject | null {
    if (kind !== SKILL_OBJECT_KIND) return null;
    return this.objects[key] ?? null;
  }

  allObjects(kind: string): Record<string, RawSkillObject> {
    if (kind !== SKILL_OBJECT_KIND) return {};
    return { ...this.objects };
  }

  /**
   * Registers `fn` to be called with each raw object `put` under `kind`.
   *
   * Only `kind === SKILL_OBJECT_KIND` is ever notified, because `put` only
   * accepts skill objects; a listener registered under any other kind is recorded
   * and never fires.
   */
  addListener(kind: string, fn: (raw: RawSkillObject) => unknown): void {
    const existing = this.listeners.get(kind);
    if (existing) existing.push(fn);
    else this.listeners.set(kind, [fn]);
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
 * Skills that fail verification are omitted. Throws only when no skill store is
 * configured.
 */
export async function allSkills(): Promise<Skill[]> {
  const store = requireStore();

  let objects: Record<string, RawSkillObject>;
  try {
    objects = allRawObjects(store);
  } catch (error) {
    // biome-ignore lint/suspicious/noConsole: this package has no logger abstraction; a failing store must be visible
    console.error(
      `[LaunchDarkly] Skill store threw while listing skills: ${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  }

  const skills: Skill[] = [];
  for (const raw of Object.values(objects)) {
    const skill = verifyRawSkill(raw);
    if (skill) skills.push(skill);
  }
  return skills;
}
