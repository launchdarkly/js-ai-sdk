/**
 * Agent Skills — the internals `skills` and `skills-fs` both need.
 *
 * Everything here is package-internal — nothing in this module is exported from
 * the package index except the two constants that are public API — and the
 * dependency runs one way: this module imports neither `skills` nor `skills-fs`.
 *
 * What lives here, and why it has to be one copy:
 *
 * - **The store seam and the configured store.** One place holds the store, so
 *   the accessors and the materialization path cannot disagree about whether one
 *   is configured.
 * - **The telemetry seam.** Every signal the feature can emit is constructed by a
 *   `record*` function in this file and nowhere else, which is what makes the
 *   three-signal allowlist enforceable by reading one section. `emit` is never
 *   called from outside this module. The documented `ld.skills.integrity_failure`
 *   log record is built in the same place and for the same reason: it is a
 *   customer-facing detection contract, so it has exactly one construction site.
 * - **Integrity verification.** `verifiedBytes` runs twice per skill by design —
 *   once at the accessor boundary, and again immediately before a write, since a
 *   `Skill` can also be constructed directly by a caller. Sharing the
 *   implementation keeps the two passes from drifting: the integrity signal's
 *   property keys must not depend on which layer caught the defect.
 * - **Store resolution.** `resolveFromStore` is the fetch-and-verify sequence the
 *   accessors and the reconcile share.
 *
 * The store and emitter are injected through `skills._setStore` and
 * `skills._setEmitterForTesting`, which delegate here.
 */

import { createHash } from 'node:crypto';
import type { RawSkillObject, Skill, SkillOutcomeReason, SkillReference, SkillStore } from './types.js';
import { createSkill, isValidSkillKey, isValidSkillVersion } from './types.js';

/** FDv2 object kind that carries skill content. */
export const SKILL_OBJECT_KIND = 'skill';

/**
 * Hard cap on skill content. The server caps skills at 50 KB, so anything larger
 * is not authentic regardless of whether its hash checks out.
 */
export const MAX_SKILL_CONTENT_BYTES = 64 * 1024;

const LANGUAGE = 'typescript';

/**
 * What a legitimate content hash looks like. Anything else is redacted before it
 * reaches telemetry — `contentHash` is attacker-controlled, and a store that put
 * the skill body there would otherwise leak it into a signal.
 */
const SHA256_HEX = /^[0-9a-f]{64}$/;

const SIGNAL_INTEGRITY_FAILURE = 'AgentControl Skill Integrity Failure';
const SIGNAL_MATERIALIZED = 'AgentControl Skill Materialized';
const SIGNAL_REVOKED = 'AgentControl Skill Revoked Received';

/**
 * Stable event identity for the local integrity-failure log record.
 *
 * Documented for customers as something to ingest and alert on, which makes this
 * string a compatibility surface: it must never be renamed. The local record is
 * the *primary* detection path rather than a fallback — the LaunchDarkly-side
 * signal is product telemetry a customer may switch off, and in some instances no
 * LaunchDarkly-side signal is possible even in principle.
 */
const EVENT_INTEGRITY_FAILURE = 'ld.skills.integrity_failure';

/**
 * Why a skill was withheld: a closed vocabulary with exactly one token per call
 * site of `recordIntegrityFailure`.
 *
 * Customers alert on these tokens, and the Python SDK emits the same eight for
 * the same conditions, so a polyglot fleet writes one detection rule rather than
 * two. A ninth token is a cross-language change — add it on both sides, or not at
 * all.
 */
export type IntegrityReasonCode =
  | 'hash_mismatch'
  | 'invalid_key'
  | 'invalid_version'
  | 'missing_content'
  | 'missing_content_hash'
  | 'not_an_object'
  | 'not_utf8'
  | 'over_size_cap';

export const NO_STORE_MESSAGE =
  'No skill store is configured, so skill content cannot be retrieved. Configure one with ' +
  'initClient({ skillStore: store }) — InMemorySkillStore is available for local development ' +
  'and testing. Retrieving LaunchDarkly-delivered skill content additionally requires the ' +
  'delivery transport, which ships in a follow-up release.';

// ---------------------------------------------------------------------------
// Telemetry seam
// ---------------------------------------------------------------------------

/**
 * The internal telemetry emitter. Private: not exported from the package index.
 *
 * No skills telemetry leaves the process in this release. `client.track()` is the
 * wrong channel — it needs an LD context, spends the customer's event volume, and
 * lands in their data export — and the diagnostic-event channel that would be
 * right has no wrapper-SDK extension point yet. Signals are recorded through this
 * seam so the eventual transport drops in behind it without touching a call site.
 */
type TelemetryEmitter = {
  record(signal: string, properties: Record<string, unknown>): void;
};

const NOOP_EMITTER: TelemetryEmitter = { record: () => undefined };

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

/**
 * Held on a symbol-keyed slot on `globalThis` rather than in a module-level
 * variable, for the same reason `lifecycle.ts` does it for the client singleton:
 * several workspace packages each importing `@launchdarkly/ai-server` resolve
 * separate module instances through their own symlinks, and a module-local store
 * would let `initClient({ skillStore })` called through one of them configure a
 * store that `getSkill` called through another could not see.
 *
 * A separate symbol from the client singleton's, so this module imports nothing
 * from `lifecycle.ts` and the dependency graph stays acyclic.
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

/**
 * Replaces the configured store. Reached through `skills._setStore`; see that
 * function for who calls it.
 */
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
 * Records one signal. Never throws into the calling operation — a broken emitter
 * must not be able to fail a retrieval or a reconcile.
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
 * Records an integrity failure: one machine-parseable local log record, and one
 * telemetry signal.
 *
 * The log record is the load-bearing half. It is written on every failure
 * regardless of how the customer configured telemetry, because it is the only
 * detection surface a customer with telemetry off has, and the only one that can
 * exist at all where no telemetry destination is reachable. Its field set is a
 * documented contract — see the README's observability subsection and `agents.md`
 * — so renaming a key, dropping a field, or emitting a null is a breaking change
 * to a security control, and a new `reason_code` token is a cross-language one.
 *
 * Two rules hold across both halves. Neither the skill body nor any filesystem
 * path ever appears: hashes, byte counts, the redacted key, and the fixed reason
 * vocabulary only. And the record's keys are inserted in **alphabetical order**
 * deliberately, so `JSON.stringify` here is byte-identical to the Python SDK's
 * `json.dumps(record, sort_keys=True, separators=(",", ":"))` for the same
 * failure, modulo `language`. Do not reorder.
 */
export function recordIntegrityFailure(
  skillKey: unknown,
  reasonCode: IntegrityReasonCode,
  reason: string,
  extra: { version?: unknown; expectedHash?: unknown; observedHash?: string } = {},
): void {
  // Both the key and the expected hash come off the wire, so neither may be
  // echoed verbatim: a store that set contentHash (or key) to the skill body
  // would otherwise publish the body itself. Shape-check, then redact — once,
  // for both the signal and the log record, so the two cannot disagree about how
  // much of an untrusted string escapes.
  const safeKey = isValidSkillKey(skillKey) ? skillKey : '<invalid-key>';
  let safeExpectedHash: string | null = null;
  if (typeof extra.expectedHash === 'string') {
    safeExpectedHash = SHA256_HEX.test(extra.expectedHash) ? extra.expectedHash : '<not-a-sha256-digest>';
  }

  const properties: Record<string, unknown> = { skill_key: safeKey, language: LANGUAGE };
  if (isValidSkillVersion(extra.version)) properties.version = extra.version;
  if (safeExpectedHash !== null) properties.expected_hash = safeExpectedHash;
  if (extra.observedHash !== undefined) properties.observed_hash = extra.observedHash;

  // `reason_code` is deliberately absent from `properties` above: the three
  // signal names and their property keys are a documented allowlist, and the
  // vocabulary belongs to the customer-owned detection path, not to LD's counter.
  //
  // Absent fields are omitted rather than emitted as null, so a consumer reads
  // "no hash was computed yet" off the key's absence rather than off a null.
  const record: Record<string, unknown> = { action: 'withheld', event: EVENT_INTEGRITY_FAILURE };
  if (safeExpectedHash !== null) record.expected_hash = safeExpectedHash;
  record.language = LANGUAGE;
  if (extra.observedHash !== undefined) record.observed_hash = extra.observedHash;
  record.reason = reason;
  record.reason_code = reasonCode;
  record.skill_key = safeKey;
  if (isValidSkillVersion(extra.version)) record.version = extra.version;

  // biome-ignore lint/suspicious/noConsole: this package has no logger abstraction; integrity failures must be visible
  console.error(`[LaunchDarkly] ${EVENT_INTEGRITY_FAILURE} ${JSON.stringify(record)}`);
  emit(SIGNAL_INTEGRITY_FAILURE, properties);
}

/**
 * Records a materialization. Deliberately carries no `target_path` and no
 * filesystem path of any kind — the same reasoning that keeps the skill body out
 * of telemetry keeps the customer's directory layout out. Paths live in the
 * returned `ReconcileReport`, which is user-facing API rather than telemetry.
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

/**
 * Records a revocation — a prune that removed a formerly managed skill.
 *
 * Lives here with the other two recorders rather than at the prune site so the
 * allowlist is maintained in one place: every signal this SDK can emit is visible
 * in this section of this module, and nothing outside it touches `emit`.
 */
export function recordRevoked(skillKey: string, version: number | null): void {
  emit(SIGNAL_REVOKED, {
    skill_key: skillKey,
    version,
    removed_from_disk: true,
    language: LANGUAGE,
  });
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
 * The whole content half of integrity verification: encode (when the content
 * arrives as a wire string), size, hash.
 *
 * The wire object delivers `content` as a JSON string; this is the one place it
 * is encoded to UTF-8 bytes, and everything downstream — the hash, the `Skill`,
 * the file on disk — carries those bytes. A `Skill` already holds bytes, so the
 * pre-write pass hands them straight in and they are hashed as-is.
 *
 * Returns the verbatim bytes and their locally computed sha256, or a
 * human-readable reason — having already recorded the integrity signal, so the
 * signal's property set cannot depend on which caller noticed. The hash handed
 * back is the one computed here, never the caller's expected value: the two are
 * equal on this path by construction, and returning the locally derived one keeps
 * an attacker-supplied string out of `Skill`.
 *
 * This runs twice per skill by design: once at the accessor boundary, and again
 * immediately before a write, because a `Skill` can also be constructed directly
 * by a caller. Sharing the implementation is what keeps those two passes from
 * drifting.
 */
export function verifiedBytes(
  key: string,
  content: string | Uint8Array,
  expectedHash: string,
  version: number,
): VerifiedContent | VerificationFailure {
  const encoded = typeof content === 'string' ? new TextEncoder().encode(content) : content;

  if (encoded.byteLength > MAX_SKILL_CONTENT_BYTES) {
    const reason = `content is ${encoded.byteLength} bytes, over the ${MAX_SKILL_CONTENT_BYTES} byte cap`;
    recordIntegrityFailure(key, 'over_size_cap', reason, { version, expectedHash });
    return { reason };
  }

  // A lone surrogate has no UTF-8 encoding; TextEncoder substitutes U+FFFD for
  // it rather than throwing, so the round-trip is what detects it. There are no
  // bytes the server could have hashed, so this is not authentic content — and
  // the substituted bytes must never be allowed to satisfy the hash comparison.
  // Only a wire string can carry a lone surrogate; bytes are already just bytes.
  if (typeof content === 'string' && new TextDecoder().decode(encoded) !== content) {
    const reason = 'content is not encodable as UTF-8';
    recordIntegrityFailure(key, 'not_utf8', reason, { version, expectedHash });
    return { reason };
  }

  // sha256, lowercase hex, over the verbatim bytes — no canonicalization and no
  // parsing of any kind anywhere in the integrity path.
  const observedHash = createHash('sha256').update(encoded).digest('hex');
  if (observedHash !== expectedHash) {
    recordIntegrityFailure(key, 'hash_mismatch', 'content hash mismatch', { version, expectedHash, observedHash });
    return { reason: 'content hash mismatch' };
  }

  return { encoded, contentHash: observedHash };
}

/**
 * Turns one untrusted raw store object into a `Skill`, or withholds it.
 *
 * On any failure the skill is treated as missing, the integrity signal is
 * recorded, and an error is logged. No unverified content is ever returned to
 * user code.
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

/** Lists every raw object the store holds. Propagates whatever it throws. */
export function allRawObjects(store: SkillStore): Record<string, RawSkillObject> {
  const objects = store.allObjects(SKILL_OBJECT_KIND);
  return typeof objects === 'object' && objects !== null && !Array.isArray(objects) ? objects : {};
}

// ---------------------------------------------------------------------------
// Resolution internals — shared with the materialization path
// ---------------------------------------------------------------------------

/** One key resolved against a store: the skill, or why there is none. */
export type Resolution = {
  readonly skill?: Skill | null;
  readonly error?: string | null;
  /**
   * Which of the five public outcomes this resolution is.
   *
   * Stated explicitly at every construction site, never derived from `error`.
   * `getSkillResult` publishes this token as API and customers branch on it, so
   * pattern-matching a prose string to decide what a fail-closed branch sees is
   * exactly the fragility the typed outcome exists to remove — and it is why the
   * field is required: a sixth internal outcome has to choose a public token
   * rather than inherit `'absent'` by omission.
   *
   * Distinct from `unavailable`, which is narrower and answers a different
   * question. See below.
   */
  readonly reason: SkillOutcomeReason;
  /**
   * `true` when the *store* could not answer — it threw — rather than when it
   * answered "no". Only the former suppresses pruning: deleting managed files
   * because a lookup failed would turn an outage into data loss.
   *
   * Kept alongside `reason` rather than folded into it: the materialization path
   * also sets it for conditions that never reach an accessor (an exhausted
   * deadline, an absent store), so the two fields are not redundant.
   */
  readonly unavailable?: boolean;
};

/**
 * Fetches one key and verifies it — the sequence the accessors and the
 * materialization path share.
 *
 * Written once on purpose: three call sites would otherwise each carry a copy,
 * and the raising-store policy is exactly the kind of detail that drifts.
 *
 * `wantedVersion` goes *into* the lookup, because a store may hold several
 * versions of one key and only it can pick between them; `null` asks for the
 * newest. The equality check afterwards is kept as a **defense**, not as the
 * selection mechanism: the store is untrusted, so an answer that is not the
 * version that was asked for is withheld rather than returned.
 */
export function resolveFromStore(store: SkillStore, key: string, wantedVersion: number | null): Resolution {
  let raw: RawSkillObject | null | undefined;
  try {
    raw = store.getObject(SKILL_OBJECT_KIND, key, wantedVersion);
  } catch (error) {
    const name = error instanceof Error ? error.constructor.name : 'unknown error';
    const message = error instanceof Error ? error.message : String(error);
    // biome-ignore lint/suspicious/noConsole: this package has no logger abstraction; a failing store must be visible
    console.error(`[LaunchDarkly] Skill store threw while retrieving '${key}': ${message}`);
    return { error: `the skill store threw ${name}: ${message}`, reason: 'store_unavailable', unavailable: true };
  }

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { error: `skill '${key}' is not available from the configured skill store`, reason: 'absent' };
  }

  const skill = verifyRawSkill(raw);
  if (skill === null) {
    return { error: `skill '${key}' failed integrity verification and was withheld`, reason: 'integrity_failure' };
  }
  if (wantedVersion !== null && skill.version !== wantedVersion) {
    return {
      error: `skill '${key}' version ${wantedVersion} is not available (the store holds version ${skill.version})`,
      reason: 'wrong_version',
    };
  }
  return { skill, reason: 'ok' };
}

/**
 * Normalizes a reference-or-key into `[key, wanted version]`.
 *
 * A bare string means "the latest version the store holds".
 */
export function referenceTarget(item: SkillReference | string): [string, number | null] {
  return typeof item === 'string' ? [item, null] : [item.key, item.version];
}
