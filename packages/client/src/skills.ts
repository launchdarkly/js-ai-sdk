/**
 * Agent Skills — reference discovery and content accessors.
 *
 * - `skillRefs` reads the skill references a resolved AI Config carries.
 * - `getSkill`, `getSkillResult`, `getSkills` and `allSkills` return verified
 *   skill content from the configured store.
 * - `InMemorySkillStore` is a simple store for local development and tests.
 *
 * Writing skills to disk lives in `skills-fs.ts` (`writeSkills`).
 */

import {
  allRawObjects,
  clearState,
  logWithholdingSummary,
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
import {
  createSkillOutcome,
  createSkillReference,
  isValidSkillKey,
  isValidSkillVersion,
  SKILL_KEY_MAX_LENGTH,
} from './types.js';

// ---------------------------------------------------------------------------
// Injection points
// ---------------------------------------------------------------------------
//
// Used by `setSkillStore` and `shutdown` (and tests). The state itself lives in
// `skills-core.ts`, so there is exactly one store and one emitter.

/** Installs the configured skill store. Called by `setSkillStore`. */
export function _setStore(store: SkillStore): void {
  setStore(store);
}

/** Test helper: replaces the no-op telemetry emitter. */
export function _setEmitterForTesting(emitter: {
  record(signal: string, properties: Record<string, unknown>): void;
}): void {
  setEmitter(emitter);
}

/** Clears the configured store and emitter. Called by `shutdown`. */
export function _clearState(): void {
  clearState();
}

/**
 * Sets the store the Agent Skills accessors read from. Without one, they throw.
 *
 * Applies on every call, including after `initClient`, so a lazily initialized
 * client can be given a store later; a second call replaces the first store. A
 * nullish argument is ignored and never clears the configured store — use
 * `shutdown()` for that.
 *
 * Replacing a store does not close the previous one; close it yourself if it
 * holds a connection. A running `watchSkills` keeps listening to the store it
 * started with, so close the watcher and start a new one to follow the
 * replacement.
 *
 * ```ts
 * import { FDv2SkillStore, setSkillStore } from '@launchdarkly/ai-server/experimental';
 *
 * setSkillStore(new FDv2SkillStore(process.env.LD_SDK_KEY!).start());
 * ```
 *
 * @throws TypeError if `store` is not nullish and has no `getObject` and
 * `allObjects` methods.
 */
export function setSkillStore(store: SkillStore | null | undefined): void {
  if (store == null) return;
  const missing = (['getObject', 'allObjects'] as const).filter(
    (name) => typeof (store as unknown as Record<string, unknown>)[name] !== 'function',
  );
  if (missing.length > 0) {
    const kind = typeof store === 'object' ? (store.constructor?.name ?? 'Object') : typeof store;
    throw new TypeError(`setSkillStore needs a SkillStore; ${kind} has no ${missing.join(' or ')} method.`);
  }
  _setStore(store);
}

/**
 * An in-memory skill store, for local development, tests, and
 * bring-your-own-content.
 *
 * - Holds raw skill objects verbatim and does no validation; the accessors
 *   verify everything they return.
 * - Can hold several versions of one key. `getObject` selects on
 *   `(key, version)`; an omitted version means the newest held.
 * - An object with an invalid `version` is still stored (under its key alone),
 *   so the accessors report it as an integrity failure rather than as absent.
 */
export class InMemorySkillStore implements SkillStore {
  // `Map`s, not plain objects: keys come off the wire, and `__proto__` or
  // `constructor` must behave like any other key.
  /** Well-formed objects, `key` -> `version` -> object. */
  private readonly versions = new Map<string, Map<number, RawSkillObject>>();

  /** Objects carrying no usable version, under their key alone. */
  private readonly loose = new Map<string, RawSkillObject>();

  private readonly listeners = new Map<string, Array<(raw: RawSkillObject) => unknown>>();

  constructor(objects: Record<string, RawSkillObject> = {}) {
    // Own entries only, so a `__proto__` entry is filed like any other key.
    for (const [objectKey, raw] of Object.entries(objects)) this.place(objectKey, raw);
  }

  /** Files one raw object under its own key, else under `fallbackKey`. */
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
   * A second version of a key is kept alongside the first; the same
   * `(key, version)` replaces it. Then calls every `'skill'` listener with the
   * raw, unverified object.
   *
   * @throws Error if `raw` has no string `key`.
   */
  put(raw: RawSkillObject): void {
    const { key } = raw;
    if (typeof key !== 'string') throw new Error("a raw skill object must carry a string 'key'");
    this.place(key, raw);
    // Iterate a copy, so a listener may remove itself mid-notification.
    for (const listener of [...(this.listeners.get(SKILL_OBJECT_KIND) ?? [])]) listener(raw);
  }

  /**
   * The raw object held for `key` at `version`, or the newest held when no
   * version is given.
   *
   * If only a malformed entry exists it is served, so verification reports it.
   * When well-formed versions exist, a missed pin is a plain miss.
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
   * The record keys are opaque identifiers: don't parse them or assume one entry
   * per skill key.
   */
  allObjects(kind: string): Record<string, RawSkillObject> {
    if (kind !== SKILL_OBJECT_KIND) return {};
    // Null-prototype, so a `__proto__` key is kept (a dropped entry would read
    // as a revocation).
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
   * @throws Error if `kind` is not `'skill'`. This store notifies no other kind,
   *   and a listener that silently never fires would look like one whose skills
   *   never changed.
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
   * Unregisters `fn` from `kind`.
   *
   * Removes one registration per call. Removing a callable that is not
   * registered is a no-op.
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
 * Why a present `skills` field is malformed, or `null` when it is valid. One
 * malformed reference rejects the whole field, never a partial list.
 */
function skillsFieldRejectionReason(raw: unknown): string | null {
  if (!Array.isArray(raw)) return 'skills must be an array of {key, version} objects';

  for (const [index, entry] of raw.entries()) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return `skills[${index}] must be an object with key and version`;
    }
    const { key, version } = entry as { key?: unknown; version?: unknown };
    if (!isValidSkillKey(key)) {
      return `skills[${index}].key must be a string matching ^[a-z0-9][a-z0-9-]*$ of at most ${SKILL_KEY_MAX_LENGTH} characters`;
    }
    if (!isValidSkillVersion(version)) return `skills[${index}].version must be an integer >= 1`;
  }
  return null;
}

/**
 * Returns the skill references attached to a resolved AI Config.
 *
 * Pure: no network, store, or telemetry. Returns `[]` when the config has no
 * `skills` field. Typical use: `await getSkills(skillRefs(config))`.
 *
 * A `config` that is not an object throws, `null` and `undefined` included.
 * `inspectConfig` answers `config: null` when the config could not be resolved,
 * and that is not a config with no skills: read as one, the pipeline
 * `writeSkills(skillRefs(info.config), root)` would prune every skill it
 * manages during an outage. Check `info.config` first, or let it throw.
 *
 * `parseAiConfig` does not validate `skills`, so a malformed field does not
 * fail core config calls. It is validated here instead, and rejected whole:
 * `writeSkills` with `prune: true` would delete the files of any skill missing
 * from the list, so a partial or empty list is never returned for a field that
 * is present.
 *
 * @throws TypeError if `config` is not an object (including `null` and
 * `undefined`), or if `skills` is present but is not an array of
 * `{ key, version }` objects with a valid key and an integer version >= 1,
 * including `skills: null`.
 */
export function skillRefs(config: AiConfigRep | null | undefined): SkillReference[] {
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    throw new TypeError(
      `skillRefs needs a resolved AI Config object, got ${
        config === null ? 'null' : Array.isArray(config) ? 'an array' : typeof config
      }. A config that could not be resolved has no skill list: returning [] would let writeSkills prune every ` +
        'skill it manages. Check that the config resolved before reading its skills.',
    );
  }

  const raw: unknown = config.skills;
  if (raw === undefined) return [];

  const rejection = skillsFieldRejectionReason(raw);
  if (rejection !== null) throw new TypeError(`Invalid skills field in AI Config: ${rejection}`);
  return (raw as Array<{ key: string; version: number }>).map(({ key, version }) =>
    createSkillReference({ key, version }),
  );
}

// ---------------------------------------------------------------------------
// Content accessors
// ---------------------------------------------------------------------------

/**
 * Retrieves one verified skill by key.
 *
 * Skills have no targeting, so there is no context parameter. For the skills a
 * given context's AI Config uses, call `getSkills(skillRefs(config))`.
 *
 * @param key The skill key.
 * @param options.version The exact version to return. Omit for the newest
 *   version the store holds.
 * @returns The `Skill`, or `null` if it is missing, not at the requested version,
 *   or fails verification. Use {@link getSkillResult} to learn which.
 * @throws Error if no skill store is configured.
 */
export async function getSkill(key: string, options: { version?: number } = {}): Promise<Skill | null> {
  return resolveFromStore(requireStore(), key, options.version ?? null).skill ?? null;
}

/**
 * Retrieves one verified skill, reporting *why* when there is none.
 *
 * Behaves exactly like {@link getSkill} (same lookup, verification, and
 * telemetry), but returns a `SkillOutcome` whose `reason` says what happened
 * instead of collapsing every failure to `null`. Use it to fail closed on
 * tampering while tolerating a missing skill:
 *
 * ```ts
 * const outcome = await getSkillResult('pdf-extraction');
 * if (outcome.reason === 'integrity_failure') throw new Error(`refusing to run: ${outcome.detail}`);
 * if (outcome.skill) console.log(outcome.skill.content);
 * ```
 *
 * `detail` is a human-readable message, safe to log: it never contains skill
 * content or filesystem paths. Branch on `reason`, not `detail`.
 *
 * @throws Error if no skill store is configured.
 */
export async function getSkillResult(key: string, options: { version?: number } = {}): Promise<SkillOutcome> {
  const resolved = resolveFromStore(requireStore(), key, options.version ?? null);
  return createSkillOutcome({
    skill: resolved.skill ?? null,
    reason: resolved.reason,
    detail: resolved.error ?? null,
  });
}

/**
 * Retrieves a batch of verified skills.
 *
 * @param refs `SkillReference` values and/or bare key strings (a string means the
 *   newest version).
 * @returns The skills found, in input order. Entries that are missing, at the
 *   wrong version, or fail verification are omitted. A warning logs how many
 *   failed verification; misses are not counted.
 * @throws TypeError if `refs` is a single string; pass `[key]` instead.
 * @throws Error if no skill store is configured.
 */
export async function getSkills(refs: ReadonlyArray<SkillReference | string>): Promise<Skill[]> {
  if (typeof refs === 'string') {
    // A string is iterable and would be looked up per character.
    throw new TypeError(
      `getSkills takes a sequence of references; pass [key] rather than a bare string. Got ${JSON.stringify(refs)}.`,
    );
  }

  const store = requireStore();

  const skills: Skill[] = [];
  // Only what the store served counts toward the summary: a miss or an outage is
  // not a verification failure, and the summary would report it as one.
  let served = 0;
  for (const ref of refs) {
    const [key, wanted] = referenceTarget(ref);
    const { skill, reason } = resolveFromStore(store, key, wanted);
    if (skill) skills.push(skill);
    if (reason === 'ok' || reason === 'integrity_failure') served += 1;
  }
  logWithholdingSummary('requested skills the store served', served, skills.length);
  return skills;
}

/**
 * Retrieves every verified skill the store currently holds.
 *
 * Returns the newest version of each key. Skills that fail verification are
 * omitted, and a warning logs how many.
 *
 * @throws Error if no skill store is configured.
 */
export async function allSkills(): Promise<Skill[]> {
  const { objects, error } = allRawObjects(requireStore());
  if (error !== null) return [];

  // The store may hold several versions per key; keep only the newest.
  const candidates = newestByKey(objects);
  const skills: Skill[] = [];
  for (const { raw } of candidates) {
    const skill = verifyRawSkill(raw);
    if (skill) skills.push(skill);
  }
  logWithholdingSummary('skills held by the store', candidates.length, skills.length);
  return skills;
}
