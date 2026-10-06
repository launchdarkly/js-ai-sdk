/**
 * Agent Skills internals shared by `skills` and `skills-fs`: the configured
 * store, telemetry, integrity verification, and store resolution.
 *
 * Package-internal: nothing here is exported from the package index. This module
 * imports neither `skills` nor `skills-fs`.
 *
 * **Everything a store returns is untrusted.** Key, version, size and content
 * hash are revalidated on every pass, and no store-supplied value reaches a
 * signal or log line without a shape check.
 */

import { createHash } from 'node:crypto';
import type { RawSkillObject, Skill, SkillOutcomeReason, SkillReference, SkillStore } from './types.js';
import { createSkill, isValidSkillKey, isValidSkillVersion } from './types.js';

/**
 * The kind the SDK passes to `SkillStore.getObject` and `SkillStore.allObjects`.
 * A store adapter may map it onto whatever its transport uses.
 */
export const SKILL_OBJECT_KIND = 'skill';

/**
 * Hard cap on skill content; anything larger is withheld even if its hash matches.
 *
 * A backstop against absurd input, set well above LaunchDarkly's own limit so that
 * limit can grow without this changing. Not the real limit, so do not pre-flight
 * skill sizes against it.
 */
export const MAX_SKILL_CONTENT_BYTES = 10 * 1024 * 1024;

const LANGUAGE = 'typescript';

/**
 * What a legitimate content hash looks like. Anything else is redacted before it
 * reaches telemetry, so a store cannot leak the skill body through `contentHash`.
 */
const SHA256_HEX = /^[0-9a-f]{64}$/;

const SIGNAL_INTEGRITY_FAILURE = 'AgentControl Skill Integrity Failure';
const SIGNAL_MATERIALIZED = 'AgentControl Skill Materialized';
const SIGNAL_REVOKED = 'AgentControl Skill Revoked Received';

/**
 * Stable event name for the local integrity-failure log record. SIEM rules match
 * on it, so it must never be renamed.
 */
const EVENT_INTEGRITY_FAILURE = 'ld.skills.integrity_failure';

/**
 * The closed, stable `reason_code` vocabulary for integrity failures; detection
 * rules can match on these tokens, and every SDK language emits the same ones.
 *
 * Eight come from `verifyRawSkill` and fire both the log record and the signal.
 * `key_mismatch` and `version_mismatch` are detected after verification and fire
 * the log record only (see `recordKeyMismatch`).
 */
export type IntegrityReasonCode =
  | 'hash_mismatch'
  | 'invalid_key'
  | 'invalid_version'
  | 'key_mismatch'
  | 'missing_content'
  | 'missing_content_hash'
  | 'not_an_object'
  | 'not_utf8'
  | 'over_size_cap'
  | 'version_mismatch';

/**
 * What the accessors report when no store is configured. Callers match on
 * "skill store"; keep that phrase if the wording changes.
 */
export const NO_STORE_MESSAGE =
  'No skill store is configured, so skill content cannot be retrieved. Configure one with ' +
  'setSkillStore(store) from @launchdarkly/ai-server/experimental — FDv2SkillStore receives content from LaunchDarkly, and ' +
  'InMemorySkillStore is available for local development and testing.';

// ---------------------------------------------------------------------------
// Telemetry seam
// ---------------------------------------------------------------------------

/**
 * The internal telemetry emitter. The default is a no-op: no skills telemetry
 * leaves the process. Signals are still built, so a transport can be installed
 * without touching call sites.
 */
type TelemetryEmitter = {
  record(signal: string, properties: Record<string, unknown>): void;
};

const NOOP_EMITTER: TelemetryEmitter = { record: () => undefined };

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

/**
 * State lives on a `globalThis` symbol slot rather than in a module variable, so
 * that separate module instances of `@launchdarkly/ai-server` (e.g. in a
 * workspace with several symlinked copies) share one configured store.
 */
const SKILLS_STATE_KEY = Symbol.for('@launchdarkly/ai-server:skills');

type SkillsState = {
  store: SkillStore | null;
  emitter: TelemetryEmitter | null;
};

function state(): SkillsState {
  const g = globalThis as Record<symbol, SkillsState | undefined>;
  let current = g[SKILLS_STATE_KEY];
  if (!current) {
    current = { store: null, emitter: null };
    g[SKILLS_STATE_KEY] = current;
  }
  return current;
}

/** Replaces the configured store. Reached through `skills._setStore`. */
export function setStore(store: SkillStore): void {
  state().store = store;
}

/** Replaces the telemetry emitter. Reached through `skills._setEmitterForTesting`. */
export function setEmitter(emitter: TelemetryEmitter): void {
  state().emitter = emitter;
}

/** Drops both the store and the emitter. Reached through `skills._clearState`. */
export function clearState(): void {
  const current = state();
  current.store = null;
  current.emitter = null;
}

/** The configured store, or `null`. The only reader of the slot. */
export function getStore(): SkillStore | null {
  return state().store;
}

export function requireStore(): SkillStore {
  const store = getStore();
  if (store === null) throw new Error(NO_STORE_MESSAGE);
  return store;
}

/**
 * Whether `store` has received its initial data.
 *
 * `true` if the store has no `isInitialized()`. A probe that throws counts as not
 * initialized. An uninitialized store is reported unavailable, which suppresses
 * pruning so a slow start cannot delete managed files.
 */
export function storeIsInitialized(store: SkillStore): boolean {
  const probe = (store as { isInitialized?: unknown }).isInitialized;
  if (typeof probe !== 'function') return true;
  try {
    return Boolean(probe.call(store));
  } catch (error) {
    // biome-ignore lint/suspicious/noConsole: this package has no logger abstraction; a failing store must be visible
    console.warn(
      `[LaunchDarkly] The skill store's isInitialized() threw; treating the store as not yet initialized: ${storeThrew(error)}`,
    );
    return false;
  }
}

/**
 * Records one signal. Never throws: a broken emitter must not fail a retrieval or
 * reconcile.
 */
function emit(signal: string, properties: Record<string, unknown>): void {
  const emitter = state().emitter ?? NOOP_EMITTER;
  try {
    emitter.record(signal, properties);
  } catch {
    // biome-ignore lint/suspicious/noConsole: the seam must not raise, but a broken emitter should still be visible
    console.warn('[LaunchDarkly] Skills telemetry emitter threw; ignoring.');
  }
}

/**
 * Records an integrity failure as one local log record and one signal.
 *
 * Carries hashes and byte counts only, never the skill body. The log record works
 * even with telemetry off; it adds the event name, action, reason and
 * `reason_code`. Its fields are a documented contract.
 */
export function recordIntegrityFailure(
  skillKey: unknown,
  reasonCode: IntegrityReasonCode,
  reason: string,
  extra: { version?: unknown; expectedHash?: unknown; observedHash?: string } = {},
): void {
  // Key and expected hash are store-supplied and could carry the skill body:
  // shape-check, then redact, once for both the signal and the log record.
  const safeKey = isValidSkillKey(skillKey) ? skillKey : '<invalid-key>';
  let safeExpectedHash: string | null = null;
  if (typeof extra.expectedHash === 'string') {
    safeExpectedHash = SHA256_HEX.test(extra.expectedHash) ? extra.expectedHash : '<not-a-sha256-digest>';
  }

  const properties: Record<string, unknown> = { skill_key: safeKey, language: LANGUAGE };
  if (isValidSkillVersion(extra.version)) properties.version = extra.version;
  if (safeExpectedHash !== null) properties.expected_hash = safeExpectedHash;
  if (extra.observedHash !== undefined) properties.observed_hash = extra.observedHash;

  // `reason_code` is log-record only; signal properties are a fixed allowlist.
  // Absent fields are omitted, never null. Keys are inserted in alphabetical
  // order so the JSON is identical across SDK languages (apart from `language`).
  // Do not reorder.
  const record: Record<string, unknown> = { action: 'withheld', event: EVENT_INTEGRITY_FAILURE };
  if (safeExpectedHash !== null) record.expected_hash = safeExpectedHash;
  record.language = LANGUAGE;
  if (extra.observedHash !== undefined) record.observed_hash = extra.observedHash;
  record.reason = reason;
  record.reason_code = reasonCode;
  record.skill_key = safeKey;
  if (isValidSkillVersion(extra.version)) record.version = extra.version;

  // Logged as text (for plain consoles and grep) and as a second structured
  // argument (for structured-console transports). Both are needed.
  // biome-ignore lint/suspicious/noConsole: this package has no logger abstraction; integrity failures must be visible
  console.error(`[LaunchDarkly] ${EVENT_INTEGRITY_FAILURE} ${JSON.stringify(record)}`, record);
  emit(SIGNAL_INTEGRITY_FAILURE, properties);
}

/**
 * Records a store answering under a key other than the one requested.
 *
 * **Log record only, no signal.** A substituted skill may indicate tampering, so
 * it is logged under `EVENT_INTEGRITY_FAILURE` for existing SIEM rules to catch.
 * The usual cause, though, is a broken store adapter (stale cache, colliding
 * key), so it is kept out of product telemetry. `recordVersionMismatch` follows
 * the same rule.
 *
 * Both keys are shape-checked and redacted, regardless of call order.
 */
export function recordKeyMismatch(requested: unknown, served: unknown): void {
  const record: Record<string, unknown> = {
    action: 'withheld',
    event: EVENT_INTEGRITY_FAILURE,
    language: LANGUAGE,
    reason: 'the skill store answered under a different key than the one requested',
    reason_code: 'key_mismatch' satisfies IntegrityReasonCode,
    // The key the store answered under, for diagnosing the adapter.
    served_key: isValidSkillKey(served) ? served : '<invalid-key>',
    // The key the caller asked for, as on every other record.
    skill_key: isValidSkillKey(requested) ? requested : '<invalid-key>',
  };
  // No hashes or version: verification passed, so neither disqualified it.
  // Keys are alphabetical, as in `recordIntegrityFailure`. Do not reorder.
  //
  // biome-ignore lint/suspicious/noConsole: this package has no logger abstraction; integrity failures must be visible
  console.error(`[LaunchDarkly] ${EVENT_INTEGRITY_FAILURE} ${JSON.stringify(record)}`, record);
}

/**
 * Records a store answering a version pin with a different version.
 *
 * **Log record only, no signal**, for the reason `recordKeyMismatch` gives. The
 * built-in stores answer a pin with that version or `null`, so only a custom
 * adapter reaches this. `getSkill` returns `null` for `wrong_version`, so this
 * record is what makes it visible.
 *
 * `served` is shape-checked, which also keeps it an integer in the JSON.
 * `requested` is the caller's own pin and is logged as given.
 */
export function recordVersionMismatch(key: unknown, requested: number, served: unknown): void {
  const record: Record<string, unknown> = {
    action: 'withheld',
    event: EVENT_INTEGRITY_FAILURE,
    language: LANGUAGE,
    reason: 'the skill store answered with a different version than the one requested',
    reason_code: 'version_mismatch' satisfies IntegrityReasonCode,
    // The version the store answered with, for diagnosing the adapter.
    served_version: isValidSkillVersion(served) ? served : '<invalid-version>',
    skill_key: isValidSkillKey(key) ? key : '<invalid-key>',
    // The version requested, as `version` means on every other record.
    version: requested,
  };
  // No hashes: verification passed, so they did not disqualify it.
  // Keys are alphabetical, as in `recordIntegrityFailure`. Do not reorder.
  //
  // biome-ignore lint/suspicious/noConsole: this package has no logger abstraction; integrity failures must be visible
  console.error(`[LaunchDarkly] ${EVENT_INTEGRITY_FAILURE} ${JSON.stringify(record)}`, record);
}

/**
 * Records a materialization. Carries no filesystem path; paths are reported in
 * the returned `ReconcileReport` instead.
 */
export function recordMaterialized(
  skillKey: string,
  contentBytes: number,
  contentHash: string,
  reconcileAction: string,
): void {
  emit(SIGNAL_MATERIALIZED, {
    skill_key: skillKey,
    content_bytes: contentBytes,
    content_hash: contentHash,
    reconcile_action: reconcileAction,
    language: LANGUAGE,
  });
}

/** Records a revocation: a prune that removed a formerly managed skill. */
export function recordRevoked(skillKey: unknown, version: unknown): void {
  // Both fields come from the manifest, which is untrusted: shape-check, then
  // redact.
  const safeKey = isValidSkillKey(skillKey) ? skillKey : '<invalid-key>';
  const properties: Record<string, unknown> = {
    skill_key: safeKey,
    removed_from_disk: true,
    language: LANGUAGE,
  };
  if (isValidSkillVersion(version)) properties.version = version;
  emit(SIGNAL_REVOKED, properties);
}

// ---------------------------------------------------------------------------
// Integrity verification
// ---------------------------------------------------------------------------

/** Content that passed integrity verification. */
export type VerifiedContent = {
  /** The verbatim bytes, exactly as hashed. */
  readonly encoded: Uint8Array;
  /** The locally computed sha256 — never the caller's expected value. */
  readonly contentHash: string;
};

/** Why content did not pass. The reason is safe to show a caller. */
export type VerificationFailure = { readonly reason: string };

export function isVerificationFailure(result: VerifiedContent | VerificationFailure): result is VerificationFailure {
  return 'reason' in result;
}

/**
 * Verifies content: size cap, then UTF-8 encoding, then sha256 hash.
 *
 * The fixed order means content failing several checks always reports the same
 * `reason_code`. A `string` (from the wire) is UTF-8 encoded here; a `Uint8Array`
 * (a `Skill.content`) is copied before hashing, because a `Skill`'s bytes can be
 * mutated by whoever created it, and the bytes written must be the bytes hashed.
 *
 * Returns the verbatim bytes and the locally computed hash, or a
 * `VerificationFailure` after recording the integrity failure.
 *
 * Runs at the accessor boundary and again before a write, because callers can
 * construct a `Skill` directly. Do not skip the second pass.
 */
export function verifiedBytes(
  key: string,
  content: string | Uint8Array,
  expectedHash: string,
  version: number,
): VerifiedContent | VerificationFailure {
  // `new Uint8Array(content)`, not `content.slice()`: `Buffer.prototype.slice`
  // returns a view over the same memory rather than a copy.
  const encoded = typeof content === 'string' ? new TextEncoder().encode(content) : new Uint8Array(content);

  if (encoded.byteLength > MAX_SKILL_CONTENT_BYTES) {
    const reason = `content is ${encoded.byteLength} bytes, over the ${MAX_SKILL_CONTENT_BYTES} byte cap`;
    recordIntegrityFailure(key, 'over_size_cap', reason, { version, expectedHash });
    return { reason };
  }

  // A lone surrogate has no UTF-8 encoding; TextEncoder silently substitutes
  // U+FFFD, so a decode round-trip detects it before the hash check.
  // `ignoreBOM: true` keeps a leading BOM from failing the round-trip.
  if (typeof content === 'string' && new TextDecoder('utf-8', { ignoreBOM: true }).decode(encoded) !== content) {
    const reason = 'content is not encodable as UTF-8';
    recordIntegrityFailure(key, 'not_utf8', reason, { version, expectedHash });
    return { reason };
  }

  // sha256, lowercase hex, over the verbatim bytes; no canonicalization.
  const observedHash = createHash('sha256').update(encoded).digest('hex');
  if (observedHash !== expectedHash) {
    recordIntegrityFailure(key, 'hash_mismatch', 'content hash mismatch', { version, expectedHash, observedHash });
    return { reason: 'content hash mismatch' };
  }

  return { encoded, contentHash: observedHash };
}

/**
 * Turns one untrusted raw store object into a `Skill`, or returns `null`.
 *
 * On failure, records the integrity failure and logs an error. Unverified
 * content is never returned.
 */
export function verifyRawSkill(raw: unknown): Skill | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    recordIntegrityFailure('<unknown>', 'not_an_object', 'raw skill object is not an object');
    return null;
  }

  const candidate = raw as RawSkillObject;

  const { key } = candidate;
  if (!isValidSkillKey(key)) {
    recordIntegrityFailure(key, 'invalid_key', 'key is not a valid skill key');
    return null;
  }

  const { version } = candidate;
  if (!isValidSkillVersion(version)) {
    recordIntegrityFailure(key, 'invalid_version', 'version is not an integer >= 1');
    return null;
  }

  const { content } = candidate;
  if (typeof content !== 'string') {
    recordIntegrityFailure(key, 'missing_content', 'content is missing or not a string', { version });
    return null;
  }

  const expectedHash = candidate.contentHash;
  if (typeof expectedHash !== 'string') {
    recordIntegrityFailure(key, 'missing_content_hash', 'contentHash is missing or not a string', { version });
    return null;
  }

  const verified = verifiedBytes(key, content, expectedHash, version);
  if (isVerificationFailure(verified)) return null;

  return createSkill({
    key,
    version,
    content: verified.encoded,
    contentHash: verified.contentHash,
    name: typeof candidate.name === 'string' ? candidate.name : null,
    description: typeof candidate.description === 'string' ? candidate.description : null,
  });
}

/**
 * Logs one warning per batch when content was withheld, with the counts.
 *
 * Makes withholding visible, especially when nothing verified and the empty
 * result would look like "no skills".
 */
export function logWithholdingSummary(subject: string, requested: number, resolved: number): void {
  const withheld = requested - resolved;
  if (withheld <= 0) return;
  if (resolved === 0) {
    // biome-ignore lint/suspicious/noConsole: this package has no logger abstraction; an empty result must not read as "no skills"
    console.warn(
      `[LaunchDarkly] All ${requested} ${subject} were withheld and no skill content is available. Every ` +
        'object failed verification — check that the delivered objects carry a contentHash matching the ' +
        'sha256 of their content.',
    );
    return;
  }
  // biome-ignore lint/suspicious/noConsole: this package has no logger abstraction; withheld skills must be visible
  console.warn(
    `[LaunchDarkly] ${withheld} of ${requested} ${subject} were withheld and are unavailable; see the ` +
      'preceding errors for the per-skill reason.',
  );
}

/** The one wording for "the store could not answer", used by every path. */
export function storeThrew(error: unknown): string {
  const name = error instanceof Error ? error.constructor.name : 'unknown error';
  const message = error instanceof Error ? error.message : String(error);
  return `the skill store threw ${name}: ${message}`;
}

/** Every raw object the store holds, or the reason it could not answer. */
export type RawListing = {
  readonly objects: Record<string, RawSkillObject>;
  /** `null` when the store answered; otherwise why it could not. */
  readonly error: string | null;
};

/**
 * Lists every raw object the store holds, or reports why it could not.
 *
 * One entry per (key, version); use `newestByKey` for one per key. A throwing
 * store is caught and reported in `error`. A non-object answer is treated as a
 * broken store, not an empty one, so it cannot read downstream as "every skill
 * was revoked".
 */
export function allRawObjects(store: SkillStore): RawListing {
  let objects: unknown;
  try {
    objects = store.allObjects(SKILL_OBJECT_KIND);
  } catch (error) {
    // biome-ignore lint/suspicious/noConsole: this package has no logger abstraction; a failing store must be visible
    console.error(`[LaunchDarkly] Skill store threw while listing skills: ${storeThrew(error)}`);
    return { objects: {}, error: storeThrew(error) };
  }
  if (typeof objects !== 'object' || objects === null || Array.isArray(objects)) {
    const typeName = Array.isArray(objects) ? 'array' : objects === null ? 'null' : typeof objects;
    // biome-ignore lint/suspicious/noConsole: this package has no logger abstraction; a failing store must be visible
    console.error(`[LaunchDarkly] Skill store listed skills as ${typeName} rather than an object`);
    return { objects: {}, error: `the skill store listed skills as ${typeName} rather than an object` };
  }
  return { objects: objects as Record<string, RawSkillObject>, error: null };
}

/** One raw object, paired with the store key it was served under. */
export type ServedObject = {
  /** The store's own map key — opaque, and only a fallback identity. */
  readonly objectKey: string;
  readonly raw: RawSkillObject;
};

/**
 * The highest version of each skill key, paired with its store key (used to
 * attribute failures when the object's own key is unusable).
 *
 * Objects without a usable key and version are **kept** so verification reports
 * them; dropping them would let prune delete the last good copy on disk. They are
 * dropped only when their key resolved from another version.
 */
export function newestByKey(objects: Record<string, RawSkillObject>): ServedObject[] {
  // The validated version is kept beside the object so the comparison needs no cast.
  const best = new Map<string, { served: ServedObject; version: number }>();
  const unusable: ServedObject[] = [];
  for (const [objectKey, raw] of Object.entries(objects)) {
    const key = typeof raw === 'object' && raw !== null ? raw.key : undefined;
    const version = typeof raw === 'object' && raw !== null ? raw.version : undefined;
    if (!isValidSkillKey(key) || !isValidSkillVersion(version)) {
      unusable.push({ objectKey, raw });
      continue;
    }
    const held = best.get(key);
    if (held === undefined || version > held.version) best.set(key, { served: { objectKey, raw }, version });
  }
  const withheld = unusable.filter(({ raw }) => {
    const key = typeof raw === 'object' && raw !== null ? raw.key : undefined;
    return !(isValidSkillKey(key) && best.has(key));
  });
  return [...[...best.values()].map(({ served }) => served), ...withheld];
}

// ---------------------------------------------------------------------------
// Resolution internals — shared with the materialization path
// ---------------------------------------------------------------------------

/** One key resolved against a store: the skill, or why there is none. */
export type Resolution = {
  readonly skill?: Skill | null;
  readonly error?: string | null;
  /**
   * Which of the five public outcomes this is; `getSkillResult` publishes it.
   * Required, so every construction site must choose one.
   */
  readonly reason: SkillOutcomeReason;
  /**
   * `true` when the store could not answer, rather than answered "no"; set
   * exactly when `reason` is `store_unavailable`. Suppresses pruning, so an
   * outage cannot delete managed files.
   */
  readonly unavailable?: boolean;
};

/**
 * Fetches one key from `store` and verifies it.
 *
 * `wantedVersion` is passed to the store (`null` for the newest). Because the
 * store is untrusted, an answer with a different key or version is still
 * withheld.
 */
export function resolveFromStore(store: SkillStore, key: string, wantedVersion: number | null): Resolution {
  let raw: RawSkillObject | null | undefined;
  try {
    raw = store.getObject(SKILL_OBJECT_KIND, key, wantedVersion);
  } catch (error) {
    // biome-ignore lint/suspicious/noConsole: this package has no logger abstraction; a failing store must be visible
    console.error(`[LaunchDarkly] Skill store threw while retrieving '${key}': ${storeThrew(error)}`);
    return { error: storeThrew(error), reason: 'store_unavailable', unavailable: true };
  }

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { error: `skill '${key}' is not available from the configured skill store`, reason: 'absent' };
  }

  const skill = verifyRawSkill(raw);
  if (skill === null) {
    return { error: `skill '${key}' failed integrity verification and was withheld`, reason: 'integrity_failure' };
  }
  if (skill.key !== key) {
    // `integrity_failure`, not `absent`: a substituted skill is something
    // callers should fail closed on. Log record only; see `recordKeyMismatch`.
    recordKeyMismatch(key, skill.key);
    return {
      error: `skill '${key}' is not available: the store answered under key '${skill.key}'`,
      reason: 'integrity_failure',
    };
  }
  if (wantedVersion !== null && skill.version !== wantedVersion) {
    // Log record only; see `recordVersionMismatch`.
    recordVersionMismatch(key, wantedVersion, skill.version);
    return {
      error: `skill '${key}' version ${wantedVersion} is not available (the store holds version ${skill.version})`,
      reason: 'wrong_version',
    };
  }
  return { skill, reason: 'ok' };
}

/**
 * Normalizes a reference or bare key into `[key, wanted version]`; a bare key
 * wants the newest version.
 */
export function referenceTarget(item: SkillReference | string): [string, number | null] {
  return typeof item === 'string' ? [item, null] : [item.key, item.version];
}
