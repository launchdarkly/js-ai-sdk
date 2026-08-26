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
 *   called from outside this module.
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
import type { RawSkillObject, Skill, SkillReference, SkillStore } from './types.js';
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
 * Records an integrity failure. Carries hashes and byte counts only — the skill
 * body never appears in a signal, a log line, or an error message.
 */
export function recordIntegrityFailure(
  skillKey: unknown,
  reason: string,
  extra: { version?: unknown; expectedHash?: unknown; observedHash?: string } = {},
): void {
  // Both the key and the expected hash come off the wire, so neither may be
  // echoed verbatim: a store that set contentHash (or key) to the skill body
  // would otherwise publish the body itself. Shape-check, then redact.
  const safeKey = isValidSkillKey(skillKey) ? skillKey : '<invalid-key>';
  const properties: Record<string, unknown> = { skill_key: safeKey, language: LANGUAGE };
  if (isValidSkillVersion(extra.version)) properties.version = extra.version;
  if (typeof extra.expectedHash === 'string') {
    properties.expected_hash = SHA256_HEX.test(extra.expectedHash) ? extra.expectedHash : '<not-a-sha256-digest>';
  }
  if (extra.observedHash !== undefined) properties.observed_hash = extra.observedHash;

  // biome-ignore lint/suspicious/noConsole: this package has no logger abstraction; integrity failures must be visible
  console.error(`[LaunchDarkly] Skill '${safeKey}' failed integrity verification: ${reason}`);
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
  /** The verbatim UTF-8 bytes, exactly as hashed. */
  readonly encoded: Buffer;
  /** The locally computed sha256 — never the caller's expected value. */
  readonly contentHash: string;
};

/** Why content did not pass. The reason is safe to show a caller. */
export type VerificationFailure = { readonly reason: string };

export function isVerificationFailure(result: VerifiedContent | VerificationFailure): result is VerificationFailure {
  return 'reason' in result;
}

/**
 * The whole content half of integrity verification: encode, size, hash.
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
  content: string,
  expectedHash: string,
  version: number,
): VerifiedContent | VerificationFailure {
  const encoded = Buffer.from(content, 'utf-8');

  if (encoded.byteLength > MAX_SKILL_CONTENT_BYTES) {
    const reason = `content is ${encoded.byteLength} bytes, over the ${MAX_SKILL_CONTENT_BYTES} byte cap`;
    recordIntegrityFailure(key, reason, { version, expectedHash });
    return { reason };
  }

  // A lone surrogate has no UTF-8 encoding; Buffer.from substitutes U+FFFD for
  // it rather than throwing, so the round-trip is what detects it. There are no
  // bytes the server could have hashed, so this is not authentic content — and
  // the substituted bytes must never be allowed to satisfy the hash comparison.
  if (encoded.toString('utf-8') !== content) {
    const reason = 'content is not encodable as UTF-8';
    recordIntegrityFailure(key, reason, { version, expectedHash });
    return { reason };
  }

  // sha256, lowercase hex, over the verbatim UTF-8 bytes — no canonicalization
  // and no frontmatter parsing anywhere in the integrity path.
  const observedHash = createHash('sha256').update(encoded).digest('hex');
  if (observedHash !== expectedHash) {
    recordIntegrityFailure(key, 'content hash mismatch', { version, expectedHash, observedHash });
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
    recordIntegrityFailure('<unknown>', 'raw skill object is not an object');
    return null;
  }

  const candidate = raw as RawSkillObject;

  const { key } = candidate;
  if (!isValidSkillKey(key)) {
    recordIntegrityFailure(key, 'key is not a valid skill key');
    return null;
  }

  const { version } = candidate;
  if (!isValidSkillVersion(version)) {
    recordIntegrityFailure(key, 'version is not an integer >= 1');
    return null;
  }

  const { content } = candidate;
  if (typeof content !== 'string') {
    recordIntegrityFailure(key, 'content is missing or not a string', { version });
    return null;
  }

  const expectedHash = candidate.contentHash;
  if (typeof expectedHash !== 'string') {
    recordIntegrityFailure(key, 'contentHash is missing or not a string', { version });
    return null;
  }

  const verified = verifiedBytes(key, content, expectedHash, version);
  if (isVerificationFailure(verified)) return null;

  return createSkill({
    key,
    version,
    content,
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
   * `true` when the *store* could not answer — it threw — rather than when it
   * answered "no". Only the former suppresses pruning: deleting managed files
   * because a lookup failed would turn an outage into data loss.
   */
  readonly unavailable?: boolean;
};

/**
 * Fetches one key and verifies it — the sequence the accessors and the
 * materialization path share.
 *
 * Written once on purpose: three call sites would otherwise each carry a copy,
 * and the raising-store policy is exactly the kind of detail that drifts.
 */
export function resolveFromStore(store: SkillStore, key: string, wantedVersion: number | null): Resolution {
  let raw: RawSkillObject | null | undefined;
  try {
    raw = store.getObject(SKILL_OBJECT_KIND, key);
  } catch (error) {
    const name = error instanceof Error ? error.constructor.name : 'unknown error';
    const message = error instanceof Error ? error.message : String(error);
    // biome-ignore lint/suspicious/noConsole: this package has no logger abstraction; a failing store must be visible
    console.error(`[LaunchDarkly] Skill store threw while retrieving '${key}': ${message}`);
    return { error: `the skill store threw ${name}: ${message}`, unavailable: true };
  }

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { error: `skill '${key}' is not available from the configured skill store` };
  }

  const skill = verifyRawSkill(raw);
  if (skill === null) {
    return { error: `skill '${key}' failed integrity verification and was withheld` };
  }
  // The store is untrusted, so the answer's own identity is re-checked against
  // what was asked for. Integrity verification cannot catch a substitution: a
  // different skill's object hashes correctly against its own contentHash, so
  // without this the caller would be handed agent instructions its AI Config
  // never referenced, with no signal that anything happened. Logged at error
  // because a store filing content under another key is broken or hostile
  // rather than routinely empty, and nothing yet reads the returned string.
  // `skill.key` passed `isValidSkillKey` inside `verifyRawSkill`, so it is
  // bounded and safe to echo.
  if (skill.key !== key) {
    // biome-ignore lint/suspicious/noConsole: this package has no logger abstraction; a substituting store must be visible
    console.error(
      `[LaunchDarkly] Skill store answered a lookup for '${key}' with content filed under '${skill.key}'; it was withheld.`,
    );
    return { error: `skill '${key}' was withheld: the store answered with content filed under '${skill.key}'` };
  }
  if (wantedVersion !== null && skill.version !== wantedVersion) {
    return {
      error: `skill '${key}' version ${wantedVersion} is not available (the store holds version ${skill.version})`,
    };
  }
  return { skill };
}

/**
 * Normalizes a reference-or-key into `[key, wanted version]`.
 *
 * A bare string means "the latest version the store holds".
 */
export function referenceTarget(item: SkillReference | string): [string, number | null] {
  return typeof item === 'string' ? [item, null] : [item.key, item.version];
}
