/**
 * Agent Skills — the FDv2 delivery transport.
 *
 * The store implementation that actually talks to LaunchDarkly. It sits *below*
 * the `SkillStore` seam, not above it: it produces raw wire objects in the shape
 * `skills-core.ts` documents, and everything above — the accessors, integrity
 * verification, the `Skill` type, materialization — is unchanged and unaware of
 * it. That is the whole point of the seam, and the fact that replacing the
 * transport design wholesale cost nothing above this line is the evidence it was
 * drawn in the right place.
 *
 * Layering:
 *
 * ```
 * @launchdarkly/ai-server
 *   └─ SkillStore (types.ts)              ── structurally typed accessor surface
 *         └─ FDv2SkillStore (this file)   ── deserialize, hold, serve
 *               └─ the SDK-facing FDv2 channel on FDCore
 *                  GET /sdk/poll, GET /sdk/stream, authenticated with the
 *                  environment's server-side SDK key
 * ```
 *
 * Dependencies run one way. This module imports `skills-core.ts` for the seam's
 * kind constant and nothing else from the feature; `skills.ts` and `skills-fs.ts`
 * do not import it. It uses only platform globals — `fetch`, `AbortController`,
 * `TextDecoder` — so the content path adds no dependency.
 *
 * **There is no bespoke private route here, deliberately.** An earlier design had
 * this adapter poll `/private/flagdlv/payloads/{id}/latest/obj/skill/{key}`.
 * Those are gonfalon private endpoints authenticated by Cognito machine-token
 * OAuth scopes with no per-tenant authorization; the security review ruled out
 * both relaxing that auth and shipping a machine credential to a customer host.
 * This transport uses the genuinely SDK-facing channel instead, which is also the
 * channel payload signing will eventually cover. Do not reintroduce the private
 * route.
 *
 * This is a port of the Python SDK's `skills_fdv2.py` and is deliberately
 * mechanical: same protocol boundary, same constants, same wire semantics, same
 * diagnostics vocabulary. A change to one belongs in both.
 *
 * What this module does *not* do, on purpose:
 *
 * - **It does not verify content.** Verification lives at the accessor boundary
 *   in `skills-core.ts` so that it applies to every store equally, including
 *   `InMemorySkillStore` and a customer's own.
 * - **It does not skip verification when the wire envelope has no
 *   `contentHash`.** A hashless object is stored verbatim and *withheld* by
 *   verification with `missing_content_hash`; this module's job is to make that
 *   outcome loud rather than to paper over it.
 * - **It does not evaluate anything.** No flags, no segments, no targeting.
 */

import { SKILL_OBJECT_KIND } from './skills-core.js';
import type { RawSkillObject, SkillStore } from './types.js';
import { isValidSkillVersion } from './types.js';

// ---------------------------------------------------------------------------
// The wire contract
// ---------------------------------------------------------------------------

/**
 * The FDv2 `kind` skills are delivered under.
 *
 * Object kinds on the SDK-facing channel are open strings: the agent-skill
 * payload is classified `generic` and every object in it carries the kind its
 * producer registered, which for skills is the bare category name. Delivery
 * lower-cases the kind, so an exact comparison is the whole test. The kind
 * happens to equal `SKILL_OBJECT_KIND` today; they are still separate constants,
 * because one is a wire value LaunchDarkly owns and the other is an SDK seam.
 */
export const FDV2_OBJECT_KIND = 'skill';

/**
 * What separates a skill's key from its version inside the object's wire `key`.
 *
 * A generic object is identified on the wire as `<key>:<version>` — the skill's
 * own key, one delimiter, the skill's own version — because each version of a
 * skill is a distinct object in the payload. Delivery forbids the delimiter
 * inside a registered category and skill keys cannot contain it, so a
 * well-formed wire key has exactly one.
 */
export const FDV2_KEY_DELIMITER = ':';

/**
 * Where the SDK-facing FDv2 endpoints live. Overridable for Federal instances,
 * private instances, and the fake endpoint the tests run against.
 */
export const DEFAULT_BASE_URI = 'https://sdk.launchdarkly.com';

export const POLL_PATH = '/sdk/poll';
export const STREAM_PATH = '/sdk/stream';

/** Default `readTimeoutMs` in `'poll'` mode: the bound on one whole request. */
export const DEFAULT_POLL_TIMEOUT_MS = 10_000;

/**
 * Default `readTimeoutMs` in `'stream'` mode: the longest gap tolerated between
 * two reads. LaunchDarkly's heartbeats arrive well inside this.
 */
export const DEFAULT_STREAM_READ_TIMEOUT_MS = 300_000;

const EVENT_SERVER_INTENT = 'server-intent';
const EVENT_PUT_OBJECT = 'put-object';
const EVENT_DELETE_OBJECT = 'delete-object';
const EVENT_PAYLOAD_TRANSFERRED = 'payload-transferred';
const EVENT_HEARTBEAT = 'heart-beat';
const EVENT_GOODBYE = 'goodbye';
const EVENT_ERROR = 'error';

const INTENT_TRANSFER_FULL = 'xfer-full';
const INTENT_TRANSFER_CHANGES = 'xfer-changes';
const INTENT_TRANSFER_NONE = 'none';

/**
 * The skill object envelope's fields, copied through verbatim.
 *
 * `contentHash` is listed here and is the field the whole content path waits on.
 * Nothing here is coerced, defaulted, or normalized — everything a store serves
 * is untrusted input and is revalidated above the seam, so a transport that
 * "helpfully" filled in a field would be forging the very thing verification
 * exists to check.
 */
const ENVELOPE_FIELDS = ['contentType', 'content', 'contentHash', 'name', 'description'] as const;

/**
 * The payload identity inside a transfer's selector, `(p:<id>:<version>)`.
 *
 * The selector is the only place a completed transfer names its own payload:
 * `put-object`, `delete-object` and `payload-transferred` carry no payload id of
 * their own. `ProtocolReader` reads it as a fallback for an intent that named no
 * `id`.
 */
const PAYLOAD_SELECTOR = /\(p:([^:()]+):\d+\)/;

export type FDv2Mode = 'stream' | 'poll';

const MOBILE_KEY_PREFIX = 'mob-';
const SERVER_KEY_PREFIX = 'sdk-';

/**
 * A client-side environment ID: bare lowercase hex, no prefix. Server-side keys
 * and mobile keys both carry a prefix, so "hex with no prefix" is an unambiguous
 * client-side credential rather than a heuristic.
 */
const CLIENT_SIDE_ID = /^[0-9a-f]{20,}$/;

function warn(message: string): void {
  // biome-ignore lint/suspicious/noConsole: this package has no logger abstraction; delivery problems must be visible
  console.warn(`[LaunchDarkly] ${message}`);
}

function error(message: string): void {
  // biome-ignore lint/suspicious/noConsole: this package has no logger abstraction; delivery problems must be visible
  console.error(`[LaunchDarkly] ${message}`);
}

// ---------------------------------------------------------------------------
// Server-side only
// ---------------------------------------------------------------------------

/**
 * Refuses a mobile key or a client-side environment ID.
 *
 * Skills are for server-side agent runtimes. The payload assignment that carries
 * them is shared by every auth type, so the skill payload ID is appended for
 * mobile and environment-ID auth too — which means a client-side credential may
 * well *succeed* against these endpoints and deliver customer-confidential skill
 * content to a client-side process. Throwing here is the SDK-side half of that
 * boundary; excluding skills at assignment time is the platform-side half, and is
 * an open ask on FDN.
 *
 * Throws rather than warning, because there is no degraded mode that is correct:
 * a store built on the wrong credential should not exist.
 */
export function requireServerSideCredential(sdkKey: unknown): string {
  if (typeof sdkKey !== 'string' || sdkKey.trim() === '') {
    throw new Error('FDv2SkillStore requires a LaunchDarkly server-side SDK key (sdk-...); none was given.');
  }
  const key = sdkKey.trim();
  if (key.startsWith(MOBILE_KEY_PREFIX)) {
    throw new Error(
      'FDv2SkillStore was given a mobile key (mob-...). Agent Skills are a server-side feature: skill content is ' +
        "customer-confidential and is never delivered to a mobile or client-side process. Use the environment's " +
        'server-side SDK key (sdk-...).',
    );
  }
  if (CLIENT_SIDE_ID.test(key)) {
    throw new Error(
      'FDv2SkillStore was given what looks like a client-side environment ID. Agent Skills are a server-side ' +
        'feature: skill content is customer-confidential and is never delivered to a client-side process. Use the ' +
        "environment's server-side SDK key (sdk-...).",
    );
  }
  if (!key.startsWith(SERVER_KEY_PREFIX)) {
    // Not rejected: private instances and test doubles issue credentials that do
    // not carry the public prefix, and refusing them would break a deployment
    // that is perfectly correct. The two shapes above are refused because they
    // are unambiguously *not* server-side.
    warn(
      'The credential given to FDv2SkillStore does not look like a LaunchDarkly server-side SDK key (sdk-...). ' +
        'Skills are delivered only to server-side credentials; if this is a client-side or mobile credential the ' +
        'connection will be rejected or will deliver nothing.',
    );
  }
  return key;
}

// ---------------------------------------------------------------------------
// Diagnostics — and the contentHash gap in particular
// ---------------------------------------------------------------------------

/**
 * What the transport has seen. Read-only from a caller's perspective.
 *
 * Not part of the `SkillStore` seam — nothing above the seam reads this — but the
 * difference between "this environment has no skills" and "every skill was
 * withheld" is the single most confusing failure this feature can produce, and a
 * counter a caller can assert on beats reading logs.
 */
export type StoreDiagnostics = {
  /** Completed `payload-transferred` commits since the store started. */
  readonly payloadsTransferred: number;
  /** `put-object` events identified as skills, across all payloads. */
  readonly skillObjectsReceived: number;
  /**
   * Objects skipped because they were not skills — flags, segments, and any
   * future kind. Skipping is the contract, not a failure; the count exists so a
   * mixed payload is visibly mixed.
   */
  readonly objectsIgnored: number;
  /** `delete-object` events applied to skills. */
  readonly objectsRevoked: number;
  /**
   * Transfers not applied because they completed a payload other than the one
   * skills arrive on. Zero while delivery sends one payload per connection.
   */
  readonly payloadsIgnored: number;
  /**
   * Skill objects whose envelope carried no `contentHash`.
   *
   * **Nonzero means skills are being withheld.** Verification withholds a
   * hashless object with `missing_content_hash`, so every one of these is a skill
   * that will never resolve. The field exists so that outcome is a number a
   * caller can read rather than an empty store they have to explain.
   */
  readonly hashlessObjects: number;
  /** Recoverable transport failures since the last successful transfer. */
  readonly connectionFailures: number;
  /** The most recent transport error, if any. Human-readable; do not parse. */
  readonly lastError: string | null;
};

const HASHLESS_ADVICE =
  "The delivered skill object carries no 'contentHash', so integrity verification withholds it with reason_code " +
  "'missing_content_hash' and its content will never resolve. This is not a fault in this store and not something " +
  'the SDK can work around: verification hashes the verbatim bytes and compares, and there is nothing to compare ' +
  'against. The field is specified as an additive sha256-over-verbatim-UTF-8 value on the skill envelope ' +
  '(LaunchDarkly AIC-2905) and has not shipped yet. Until it does, expect an empty result from every skill accessor.';

/**
 * `(key, version)` pairs already reported hashless.
 *
 * Module-scoped so the error is one per object per process rather than one per
 * re-delivered payload; exported for the tests, which need to clear it.
 */
export const _warnedHashless = new Set<string>();

/**
 * One error per `(key, version)` whose envelope had no `contentHash`.
 *
 * At error level rather than warn, and per object rather than once per process,
 * because this is the difference between a broken deployment and an
 * empty-by-design one — the exact confusion the blocking gap produces.
 */
function warnHashless(raw: RawSkillObject): void {
  const identity = `${String(raw.key)}:${String(raw.version)}`;
  if (_warnedHashless.has(identity)) return;
  _warnedHashless.add(identity);
  error(
    `Skill '${String(raw.key)}' version ${String(raw.version)} arrived without a contentHash and will be ` +
      `withheld. ${HASHLESS_ADVICE}`,
  );
}

/**
 * One error per committed payload in which *nothing* the store now holds can
 * possibly verify.
 *
 * Fires at delivery time, so the condition is visible in a process that boots,
 * materializes nothing, and exits — which is the shape a skills deployment fails
 * in. The accessor boundary's own withholding summary only speaks once a caller
 * asks.
 */
function warnIfNothingCanVerify(held: RawSkillObject[]): void {
  if (held.length === 0) return;
  const hashless = held.filter((raw) => typeof raw.contentHash !== 'string');
  if (hashless.length !== held.length) return;
  error(
    `All ${held.length} skill object(s) in the delivered payload arrived without a contentHash. No skill content ` +
      `will resolve from this store. ${HASHLESS_ADVICE}`,
  );
}

// ---------------------------------------------------------------------------
// Deserialization — where the skill's version lives in the key, not in version
// ---------------------------------------------------------------------------

/** A `delete-object` narrowed to the identity it revokes. */
export type Tombstone = { readonly key: string; readonly objectVersion: number | null };

/**
 * Whether one `put-object` / `delete-object` payload is a skill.
 *
 * The kind alone decides it. Every other kind is **ignored, not rejected**,
 * because flag and segment objects share the connection and erroring on them
 * would turn a normal payload into a reconnect loop — exactly the unknown-kind
 * failure this feature must not reproduce.
 */
export function isSkillEvent(data: unknown): boolean {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return false;
  return (data as { kind?: unknown }).kind === FDV2_OBJECT_KIND;
}

/**
 * A skill object's wire `key`, split into the skill's key and version.
 *
 * `version` is a number when the wire carried one, the offending text when it
 * did not, and absent (`undefined`, with `hasVersion === false`) when the wire
 * key had no delimiter at all.
 */
export type WireIdentity = { readonly key: string; readonly hasVersion: boolean; readonly version?: unknown };

const DIGITS_ONLY = /^[0-9]+$/;

/**
 * Reads `<key>:<version>` off one object's wire `key`.
 *
 * Lenient where leniency keeps the object diagnosable and strict only where
 * there is nothing to diagnose:
 *
 * - No delimiter: the whole wire key is the skill key and there is no version,
 *   so the object is held version-less and verification reports
 *   `invalid_version` under a key the caller can recognise.
 * - A version that is not a run of ASCII digits (`"pdf:latest"`, `"pdf:"`,
 *   `"a:1:2"`): the text is carried through *as the version*, for the same
 *   reason — the caller learns that `pdf` arrived broken, not that it is absent.
 * - An empty key before the delimiter (`":3"`): there is no identity to hold it
 *   under, so `null`, and the caller drops it.
 *
 * Leading zeros are accepted (`"pdf:03"` is version 3) since the number is the
 * identity a reference pins, not the spelling.
 */
export function splitWireKey(wireKey: unknown): WireIdentity | null {
  if (typeof wireKey !== 'string' || wireKey === '') return null;
  const delimiter = wireKey.indexOf(FDV2_KEY_DELIMITER);
  if (delimiter === -1) return { key: wireKey, hasVersion: false };
  const key = wireKey.slice(0, delimiter);
  if (key === '') return null;
  const versionText = wireKey.slice(delimiter + 1);
  if (DIGITS_ONLY.test(versionText)) return { key, hasVersion: true, version: Number(versionText) };
  return { key, hasVersion: true, version: versionText };
}

/**
 * Translates one FDv2 skill `put-object` into a seam-shaped raw object.
 *
 * **The translation this whole module exists to get right:**
 *
 * ```
 * wire `key`      →  seam `key` and `version`   (split on `:`)
 * wire `version`  →  dropped                    (the *payload* version)
 * ```
 *
 * Each version of a skill is its own object on the wire, identified as
 * `<key>:<version>`; that version is what a `{key, version}` reference pins. The
 * event's `version` field is the version of the payload the object arrived in and
 * moves whenever anything in the environment moves, including a flag that has
 * nothing to do with skills. Confusing them fails silently: the object verifies,
 * the hash matches, and the caller is handed a skill under a version number that
 * means nothing.
 *
 * `null` only when the wire `key` carries no skill key at all, since such an
 * object has no identity to store it under. Every other defect is carried through
 * verbatim so that *verification* withholds it, with a reason code and an
 * integrity signal, rather than the transport dropping it silently. A silent drop
 * is indistinguishable from "no such skill" and would additionally let a prune
 * delete the last known-good copy on disk.
 */
export function seamObjectFromPut(data: Record<string, unknown>): RawSkillObject | null {
  const identity = splitWireKey(data.key);
  if (identity === null) {
    warn(
      `An FDv2 skill put-object carried no usable 'key' (${JSON.stringify(data.key)}) and could not be stored ` +
        'under any identity; it was dropped.',
    );
    return null;
  }

  const raw: RawSkillObject = { key: identity.key };

  // Absent stays absent and malformed stays malformed, so verification sees what
  // arrived (as `invalid_version`) rather than something invented here.
  if (identity.hasVersion) raw.version = identity.version;

  const envelope = data.object;
  if (typeof envelope === 'object' && envelope !== null && !Array.isArray(envelope)) {
    for (const field of ENVELOPE_FIELDS) {
      if (field in envelope) raw[field] = (envelope as Record<string, unknown>)[field];
    }
  }
  return raw;
}

/** The payload id one payload intent names, when it names a usable one. */
function payloadIdOf(intent: unknown): string | null {
  if (typeof intent !== 'object' || intent === null) return null;
  const { id } = intent as { id?: unknown };
  return typeof id === 'string' && id !== '' ? id : null;
}

/** The payload id inside a transfer's selector, when it carries one. */
function payloadIdFromSelector(state: unknown): string | null {
  if (typeof state !== 'string') return null;
  const match = PAYLOAD_SELECTOR.exec(state);
  return match ? match[1] : null;
}

/**
 * Narrows one FDv2 skill `delete-object` to the identity it revokes, reading the
 * wire `key` the same way a put does.
 *
 * A delete for a skill **is revocation** — the object leaves the payload, this
 * store drops it, the accessors stop resolving it, and the next reconcile prunes
 * its files.
 *
 * An `objectVersion` of `null` means the delete named no usable version, and is
 * read as "revoke every version of this key". That is the safe direction: the
 * alternative is ignoring an unparseable revocation and continuing to serve
 * content LaunchDarkly has withdrawn. It also removes whatever a malformed put of
 * the same wire key left held, since that was stored version-less under the same
 * skill key.
 */
export function tombstoneFromDelete(data: Record<string, unknown>): Tombstone | null {
  const identity = splitWireKey(data.key);
  if (identity === null) {
    warn(`An FDv2 skill delete-object carried no usable 'key' (${JSON.stringify(data.key)}); it was ignored.`);
    return null;
  }
  return {
    key: identity.key,
    objectVersion: identity.hasVersion && isValidSkillVersion(identity.version) ? identity.version : null,
  };
}

// ---------------------------------------------------------------------------
// The held object set
// ---------------------------------------------------------------------------

/**
 * Raw skill objects held in memory, keyed by `(key, version)`.
 *
 * Several versions of one key coexist, because they coexist in a real payload:
 * the newest version of every skill plus every version a variation currently
 * pins. An object too malformed to carry a usable version is still held, under
 * its key alone, so verification withholds it with a signal rather than the
 * transport dropping it into indistinguishable absence.
 *
 * **`snapshot` collapses to one object per key at its newest version, and that is
 * load-bearing here in a way it is not in Python.** `<root>/<key>/SKILL.md` is a
 * single path, so a whole-store consumer must see one object per key or a `'*'`
 * reconcile writes the same path twice in one run and `allSkills` returns a list
 * holding two versions of one skill. The Python SDK collapses in
 * `newest_by_key`, above the seam; that helper has not been ported to this SDK
 * yet, so the collapse happens here instead. The observable end-to-end behaviour
 * is identical, and `getObject` still resolves a pinned version out of the full
 * set — which is the case the collapse must not break. When `newestByKey` lands
 * in `skills-core.ts`, move it and delete this note.
 */
export class SkillObjectSet {
  private versions = new Map<string, Map<number, RawSkillObject>>();
  private loose = new Map<string, RawSkillObject>();

  put(raw: RawSkillObject): void {
    const key = raw.key as string;
    const { version } = raw;
    if (isValidSkillVersion(version)) {
      const held = this.versions.get(key) ?? new Map<number, RawSkillObject>();
      held.set(version, raw);
      this.versions.set(key, held);
    } else {
      this.loose.set(key, raw);
    }
  }

  /**
   * Removes what `tombstone` revokes; returns the raw objects that went away.
   *
   * A tombstone with no usable version removes every version of the key — see
   * {@link tombstoneFromDelete} for why that is the safe reading.
   */
  delete(tombstone: Tombstone): RawSkillObject[] {
    const removed: RawSkillObject[] = [];
    if (tombstone.objectVersion === null) {
      for (const raw of this.versions.get(tombstone.key)?.values() ?? []) removed.push(raw);
      this.versions.delete(tombstone.key);
      const loose = this.loose.get(tombstone.key);
      if (loose) {
        removed.push(loose);
        this.loose.delete(tombstone.key);
      }
      return removed;
    }

    const held = this.versions.get(tombstone.key);
    const gone = held?.get(tombstone.objectVersion);
    if (gone) {
      removed.push(gone);
      held?.delete(tombstone.objectVersion);
    }
    if (held && held.size === 0) this.versions.delete(tombstone.key);
    return removed;
  }

  /**
   * The object for `key` at `version`, or the newest held when `version` is null.
   *
   * Falls through to the version-less entry when the pin matches nothing
   * well-formed, so a malformed object reaches verification and is withheld with a
   * signal rather than reading as simply absent.
   */
  get(key: string, version: number | null): RawSkillObject | null {
    const held = this.versions.get(key);
    if (version !== null) return held?.get(version) ?? this.loose.get(key) ?? null;
    if (held && held.size > 0) {
      const newest = Math.max(...held.keys());
      return held.get(newest) ?? null;
    }
    return this.loose.get(key) ?? null;
  }

  /** One entry per skill key, at its newest version. See the class docstring. */
  snapshot(): Record<string, RawSkillObject> {
    const out: Record<string, RawSkillObject> = {};
    for (const [key, held] of this.versions) {
      if (held.size === 0) continue;
      const newest = Math.max(...held.keys());
      const raw = held.get(newest);
      if (raw) out[`${key}:${newest}`] = raw;
    }
    for (const [key, raw] of this.loose) {
      if (!this.versions.has(key)) out[key] = raw;
    }
    return out;
  }

  /** Every object held, one per `(key, version)`. Diagnostics, not the seam. */
  allRaw(): RawSkillObject[] {
    const out: RawSkillObject[] = [];
    for (const held of this.versions.values()) out.push(...held.values());
    out.push(...this.loose.values());
    return out;
  }

  /** Adopts `other`'s contents wholesale — how a full transfer commits. */
  replaceWith(other: SkillObjectSet): void {
    this.versions = other.versions;
    this.loose = other.loose;
  }

  copy(): SkillObjectSet {
    const clone = new SkillObjectSet();
    clone.versions = new Map([...this.versions].map(([key, held]) => [key, new Map(held)]));
    clone.loose = new Map(this.loose);
    return clone;
  }

  get size(): number {
    let total = this.loose.size;
    for (const held of this.versions.values()) total += held.size;
    return total;
  }
}

// ---------------------------------------------------------------------------
// The protocol state machine — pure, no I/O
// ---------------------------------------------------------------------------

/** What one event did. Aggregated by the caller; nothing here does I/O. */
export type TransferOutcome = {
  committed?: boolean;
  changes?: RawSkillObject[];
  basis?: string | null;
  fatal?: string | null;
  disconnect?: string | null;
};

type MutableDiagnostics = { -readonly [K in keyof StoreDiagnostics]: StoreDiagnostics[K] };

function freshDiagnostics(): MutableDiagnostics {
  return {
    payloadsTransferred: 0,
    skillObjectsReceived: 0,
    objectsIgnored: 0,
    objectsRevoked: 0,
    payloadsIgnored: 0,
    hashlessObjects: 0,
    connectionFailures: 0,
    lastError: null,
  };
}

/**
 * Applies FDv2 events to an object set. Pure — no sockets, no timers, no clock.
 *
 * Split out so the protocol is testable without a server: every wire case in
 * `skills-fdv2.test.ts` drives this directly, and the HTTP layer above it only has
 * to turn bytes into `[event name, data]` pairs.
 *
 * **Changes are buffered and committed at `payload-transferred`**, matching how
 * the base SDK's FDv2 data source applies a change set. A payload version is the
 * unit of consistency: applying half of one would publish a state the server
 * never described, and on a full transfer it would briefly empty the store —
 * which, with pruning on, is the difference between a reconcile and deleting a
 * customer's skill files. Listeners therefore fire once per commit, not once per
 * object, which is also exactly the granularity the re-reconcile wants.
 *
 * **The first payload intent is read, and is assumed to be the skill payload.**
 * Delivery provides one payload per credential and the protocol requires a client
 * to ignore all but the first payload intent, so `payloads[0]` is both what
 * arrives and what the protocol says to read. If that ever widens, an `xfer-full`
 * for somebody else's payload would empty the skill set and the next
 * `payload-transferred` would publish it empty — with pruning on, the difference
 * between a reconcile and deleting a customer's files. This layer therefore learns
 * which payload skills arrive on and declines to apply a transfer of any other,
 * once at warning level and counted. The residual is the first transfer of a
 * connection: before a skill has arrived there is nothing to compare a payload
 * against.
 */
export class ProtocolReader {
  readonly diagnostics = freshDiagnostics();
  private intent: string | null = null;
  private pending: SkillObjectSet | null = null;
  private changes: RawSkillObject[] = [];
  // The payload the current intent describes, and the payload skills have
  // actually arrived on. One payload per connection makes these the same
  // payload; the class docstring says why they are kept apart regardless.
  private intentPayloadId: string | null = null;
  private skillPayloadId: string | null = null;
  private skillsInPayload = 0;
  private warnedMultiplePayloads = false;
  private warnedForeignPayload = false;

  constructor(private readonly committed: SkillObjectSet) {}

  /** Routes one event. Unknown event names are ignored, by contract. */
  handle(name: string, data: unknown): TransferOutcome {
    switch (name) {
      case EVENT_SERVER_INTENT:
        return this.serverIntent(data);
      case EVENT_PUT_OBJECT:
        return this.putObject(data);
      case EVENT_DELETE_OBJECT:
        return this.deleteObject(data);
      case EVENT_PAYLOAD_TRANSFERRED:
        return this.payloadTransferred(data);
      case EVENT_ERROR:
        return this.error(data);
      case EVENT_GOODBYE:
        return this.goodbye(data);
      case EVENT_HEARTBEAT:
        return {};
      default:
        return {};
    }
  }

  private serverIntent(data: unknown): TransferOutcome {
    const payloads = (data as { payloads?: unknown } | null)?.payloads;
    if (!Array.isArray(payloads) || payloads.length === 0) {
      return { disconnect: 'server-intent carried no payload description' };
    }
    if (payloads.length > 1) this.warnMultiplePayloads(payloads);
    // The first payload only, as the protocol requires.
    const first = payloads[0] as { intentCode?: unknown } | null;
    const intent = typeof first?.intentCode === 'string' ? first.intentCode : null;
    this.intent = intent;
    this.intentPayloadId = payloadIdOf(first);
    this.changes = [];
    this.skillsInPayload = 0;
    if (intent === INTENT_TRANSFER_FULL) {
      // A fresh set: the payload about to arrive replaces everything held. Built
      // alongside the live set rather than in place, so an interrupted transfer
      // leaves last-known-good intact.
      this.pending = new SkillObjectSet();
    } else if (intent === INTENT_TRANSFER_CHANGES) {
      this.pending = this.committed.copy();
    } else if (intent === INTENT_TRANSFER_NONE) {
      // The payload we hold is current. Nothing to apply, nothing to replace.
      this.pending = null;
    } else {
      // Any future intent code. Ignored rather than guessed at, for the same
      // reason an unknown kind is: guessing could empty the store.
      this.pending = null;
    }
    return {};
  }

  private target(): SkillObjectSet | null {
    if (this.pending === null && (this.intent === INTENT_TRANSFER_FULL || this.intent === INTENT_TRANSFER_CHANGES)) {
      // An object arrived before any server-intent. Treat it as a delta against
      // what we hold rather than dropping it.
      this.pending = this.committed.copy();
    }
    return this.pending;
  }

  private putObject(data: unknown): TransferOutcome {
    if (!isSkillEvent(data)) {
      this.diagnostics.objectsIgnored += 1;
      return {};
    }
    if (this.pending === null && this.intent === null) this.intent = INTENT_TRANSFER_CHANGES;
    const target = this.target();
    if (target === null) return {};

    const raw = seamObjectFromPut(data as Record<string, unknown>);
    if (raw === null) return {};
    target.put(raw);
    this.changes.push(raw);
    this.diagnostics.skillObjectsReceived += 1;
    this.skillsInPayload += 1;
    if (typeof raw.contentHash !== 'string') {
      this.diagnostics.hashlessObjects += 1;
      warnHashless(raw);
    }
    return {};
  }

  private deleteObject(data: unknown): TransferOutcome {
    if (!isSkillEvent(data)) {
      this.diagnostics.objectsIgnored += 1;
      return {};
    }
    if (this.pending === null && this.intent === null) this.intent = INTENT_TRANSFER_CHANGES;
    const target = this.target();
    if (target === null) return {};

    const tombstone = tombstoneFromDelete(data as Record<string, unknown>);
    if (tombstone === null) return {};
    target.delete(tombstone);
    this.diagnostics.objectsRevoked += 1;
    // A revocation identifies the payload as ours just as a put does.
    this.skillsInPayload += 1;
    // A tombstone, not a skill object: it carries identity and no content, so a
    // listener that only needs "something changed" works unchanged while one that
    // reads content sees no `content` field. Documented on `addListener`.
    this.changes.push({ key: tombstone.key, version: tombstone.objectVersion });
    return {};
  }

  private payloadTransferred(data: unknown): TransferOutcome {
    const state = (data as { state?: unknown } | null)?.state;
    const payloadId = this.intentPayloadId ?? payloadIdFromSelector(state);
    if (this.pending !== null && this.isForeignPayload(payloadId)) {
      this.warnForeignPayload(payloadId);
      this.diagnostics.payloadsIgnored += 1;
      this.changes = [];
    } else if (this.pending !== null) {
      this.committed.replaceWith(this.pending);
      warnIfNothingCanVerify(this.committed.allRaw());
      if (this.skillsInPayload > 0 && payloadId !== null) {
        // Learnt, not configured: nothing below the seam is told which payload
        // is which, so the payload that carried a skill put or revocation is
        // the payload skills arrive on.
        this.skillPayloadId = payloadId;
      }
    }
    this.pending = null;
    this.intent = null;
    this.intentPayloadId = null;
    this.skillsInPayload = 0;
    const { changes } = this;
    this.changes = [];
    this.diagnostics.payloadsTransferred += 1;
    return {
      committed: true,
      changes,
      basis: typeof state === 'string' && state !== '' ? state : null,
    };
  }

  /** Drops the in-flight payload and keeps what is committed. */
  private abandonInFlight(): void {
    this.pending = null;
    this.intent = null;
    this.intentPayloadId = null;
    this.skillsInPayload = 0;
    this.changes = [];
  }

  private error(data: unknown): TransferOutcome {
    const reason = (data as { reason?: unknown } | null)?.reason;
    this.abandonInFlight();
    return { disconnect: `server sent error: ${String(reason)}` };
  }

  private goodbye(data: unknown): TransferOutcome {
    const parsed = (data ?? {}) as { reason?: unknown; silent?: unknown; catastrophe?: unknown };
    this.abandonInFlight();
    if (parsed.silent !== true) {
      warn(`FDv2 connection closing: ${String(parsed.reason)}`);
    }
    if (parsed.catastrophe === true) {
      return { fatal: `server sent a catastrophic goodbye: ${String(parsed.reason)}` };
    }
    return { disconnect: `server said goodbye: ${String(parsed.reason)}` };
  }

  // -- payload identity ----------------------------------------------------

  /**
   * Whether a transfer completes a payload other than the one skills arrive on.
   *
   * `false` unless both payloads are known, so one-payload delivery and the
   * first transfer of a connection behave exactly as they did before this check
   * existed.
   */
  private isForeignPayload(payloadId: string | null): boolean {
    return this.skillPayloadId !== null && payloadId !== null && payloadId !== this.skillPayloadId;
  }

  /**
   * One warning per reader for an intent describing more than one payload.
   *
   * Not an error: reading only the first is what the protocol asks for. But it
   * means the first payload is no longer *guaranteed* to be the skill payload,
   * and an intent for another payload arriving before any skill has been seen is
   * the one case `isForeignPayload` cannot catch.
   */
  private warnMultiplePayloads(payloads: unknown[]): void {
    if (this.warnedMultiplePayloads) return;
    this.warnedMultiplePayloads = true;
    warn(
      `An FDv2 server-intent described ${payloads.length} payloads (${payloads
        .map((p) => String(payloadIdOf(p)))
        .join(', ')}). Only the first is read, as the protocol requires, and it is taken to be the payload skills ` +
        'arrive on. If skills stop resolving from this point, that is the assumption that broke; contact ' +
        'LaunchDarkly support.',
    );
  }

  /** One warning per reader for a transfer this layer declined to apply. */
  private warnForeignPayload(payloadId: string | null): void {
    if (this.warnedForeignPayload) return;
    this.warnedForeignPayload = true;
    warn(
      `An FDv2 transfer of payload ${String(payloadId)} was not applied to the skills held, which arrive on ` +
        `payload ${String(this.skillPayloadId)}. Applying it would have replaced them with whatever that payload ` +
        'carried — nothing, in the case of a flag payload. The skills held are unchanged.',
    );
  }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

/** A failure retrying cannot fix: bad credential, forbidden, wrong URI. */
export class FatalTransportError extends Error {}

/** A failure worth retrying. Carries a server-requested delay when given one. */
export class RecoverableTransportError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
  }
}

const FORBIDDEN_ADVICE =
  'The FDv2 protocol is opt-in per LaunchDarkly account and is served as HTTP 403 while it is off. Skill ' +
  'delivery needs it enabled; contact LaunchDarkly support to enable it for your account.';

/** `Retry-After` in milliseconds, when the server sent a usable one. */
export function retryAfterMs(headers: Headers | null | undefined): number | null {
  const raw = headers?.get('Retry-After');
  if (raw === null || raw === undefined) return null;
  const seconds = Number(raw.trim());
  // The HTTP-date form is legal and rare; falling back to our own backoff is
  // better than parsing a date to honour it approximately.
  if (!Number.isFinite(seconds)) return null;
  return Math.max(0, seconds * 1000);
}

/** Turns an HTTP error status into the right error type. */
export function classifyStatus(status: number, headers?: Headers | null): Error {
  if (status === 401) {
    return new FatalTransportError(
      'LaunchDarkly rejected the SDK key (HTTP 401). Skill delivery cannot start. Check that the key is the ' +
        "environment's server-side SDK key.",
    );
  }
  if (status === 403) return new FatalTransportError(`LaunchDarkly returned HTTP 403. ${FORBIDDEN_ADVICE}`);
  if (status === 404) {
    return new FatalTransportError(
      'LaunchDarkly returned HTTP 404 for the FDv2 endpoint. Check the base URI, and that this instance serves ' +
        '/sdk/poll and /sdk/stream.',
    );
  }
  if ([400, 405, 406, 414, 501].includes(status)) {
    return new FatalTransportError(
      `LaunchDarkly returned HTTP ${status}, which retrying will not fix. The request this adapter sent was not ` +
        "understood. It carries only the SDK key and, after the first payload, a 'basis' selector, so check the " +
        'base URI and that the endpoint speaks FDv2.',
    );
  }
  return new RecoverableTransportError(`LaunchDarkly returned HTTP ${status}`, retryAfterMs(headers));
}

export type PollResult = {
  readonly notModified: boolean;
  readonly events: Array<[string, unknown]>;
  readonly etag: string | null;
};

/**
 * Unwraps `{"events": [...]}`.
 *
 * Polling and streaming carry the *identical* event objects — polling just wraps
 * them in an envelope — which is why the protocol state machine above is shared
 * and neither mode has its own copy of the semantics.
 */
export function decodePollBody(body: string): Array<[string, unknown]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (cause) {
    throw new RecoverableTransportError(
      `polling response was not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  const wrapped = parsed as { events?: unknown } | null;
  if (typeof wrapped !== 'object' || wrapped === null || !Array.isArray(wrapped.events)) {
    throw new RecoverableTransportError("polling response had no 'events' array");
  }
  const events: Array<[string, unknown]> = [];
  for (const entry of wrapped.events) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { event, data } = entry as { event?: unknown; data?: unknown };
    if (typeof event === 'string') events.push([event, data]);
  }
  return events;
}

/**
 * A signal that aborts when `parent` does, or when `ms` pass without `touch()`.
 *
 * This is the one network timeout. In `'poll'` mode nothing touches it, so it
 * bounds the whole request; in `'stream'` mode every completed read touches it,
 * so it bounds the gap between reads. `expired` tells the two abort causes
 * apart: a store closing is not a failure, a stream gone quiet is.
 */
export type ReadDeadline = {
  readonly signal: AbortSignal;
  readonly parent: AbortSignal;
  readonly ms: number;
  readonly expired: boolean;
  /** Restarts the clock. Call after each successful read. */
  touch(): void;
  /** Stops the clock and detaches from `parent`. Idempotent. */
  clear(): void;
};

export function readDeadline(parent: AbortSignal, ms: number): ReadDeadline {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let expired = false;
  const stopTimer = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const onParentAbort = (): void => {
    stopTimer();
    controller.abort(parent.reason);
  };
  const arm = (): void => {
    stopTimer();
    if (controller.signal.aborted) return;
    timer = setTimeout(() => {
      expired = true;
      controller.abort(new Error(`no response within ${ms}ms`));
    }, ms);
    // Unreffed for the same reason the backoff timer is: a background store is
    // not a reason for `node` to keep running.
    (timer as unknown as { unref?: () => void }).unref?.();
  };
  if (parent.aborted) controller.abort(parent.reason);
  else parent.addEventListener('abort', onParentAbort, { once: true });
  arm();
  return {
    signal: controller.signal,
    parent,
    ms,
    get expired() {
      return expired;
    },
    touch: arm,
    clear: () => {
      stopTimer();
      parent.removeEventListener('abort', onParentAbort);
    },
  };
}

/**
 * Presents a failed body read as retryable — unless the store is closing, in
 * which case the abort is passed through untouched so the delivery loop reads it
 * as the shutdown it is.
 *
 * A live stream dies mid-body far more often than it refuses to open: a read
 * timeout on a stream that went quiet, a reset, a truncated chunk. Each of those
 * arrives as whatever `fetch` threw, and the delivery loop retries only the
 * transport errors this module defines — anything else it reads as a bug and
 * stops for the process lifetime. Connecting is already wrapped in
 * `FetchRequester.stream`; this is the same promise for the body.
 */
function readFailure(cause: unknown, what: string, deadline: ReadDeadline | undefined): unknown {
  if (deadline?.parent.aborted) return cause;
  if (deadline?.expired) return new RecoverableTransportError(`${what} timed out: no bytes in ${deadline.ms}ms`);
  return new RecoverableTransportError(`${what} failed: ${cause instanceof Error ? cause.message : String(cause)}`);
}

/**
 * Decodes an SSE byte stream into `[event name, data]` pairs.
 *
 * Minimal on purpose — this consumes one LaunchDarkly endpoint, not the whole
 * spec: `event:`/`data:` fields, multi-line `data` joined with newlines, a blank
 * line dispatching, and `:` comments skipped.
 *
 * Only the read itself is wrapped as recoverable (see {@link readFailure}).
 * Whatever the consumer's loop body throws while this generator is suspended at
 * a `yield` — a protocol reader bug, a fatal goodbye — passes through `finally`
 * untouched and still surfaces as what it is.
 */
export async function* iterSse(
  body: ReadableStream<Uint8Array>,
  deadline?: ReadDeadline,
): AsyncGenerator<[string, unknown], void, undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let name: string | null = null;
  let dataLines: string[] = [];

  const dispatch = (): [string, unknown] | null => {
    if (name === null) return null;
    const payload = dataLines.join('\n');
    const eventName = name;
    name = null;
    dataLines = [];
    if (payload === '') return [eventName, null];
    try {
      return [eventName, JSON.parse(payload)];
    } catch {
      warn(`Discarding FDv2 '${eventName}' event whose data was not JSON`);
      return null;
    }
  };

  try {
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (cause) {
        throw readFailure(cause, 'reading the FDv2 stream', deadline);
      }
      deadline?.touch();
      const { done, value } = chunk;
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        if (line === '') {
          const dispatched = dispatch();
          if (dispatched !== null) yield dispatched;
        } else if (!line.startsWith(':')) {
          const colon = line.indexOf(':');
          const field = colon === -1 ? line : line.slice(0, colon);
          let value2 = colon === -1 ? '' : line.slice(colon + 1);
          if (value2.startsWith(' ')) value2 = value2.slice(1);
          if (field === 'event') name = value2;
          else if (field === 'data') dataLines.push(value2);
        }
        newline = buffer.indexOf('\n');
      }
    }
  } finally {
    deadline?.clear();
    // Cancelling closes the connection underneath, so a consumer that stops
    // early — a goodbye, an error event — does not leave a socket open behind
    // the reconnect. Best effort: the stream may already be errored or closed.
    reader.cancel().catch(() => {});
    try {
      reader.releaseLock();
    } catch {
      // Already released, or the stream errored. Nothing to recover.
    }
  }
}

/** What the store needs from a transport. Swapped wholesale in tests. */
export type Requester = {
  poll(basis: string | null, etag: string | null, signal: AbortSignal): Promise<PollResult>;
  stream(basis: string | null, signal: AbortSignal): Promise<AsyncIterable<[string, unknown]>>;
};

/**
 * The only place this module opens a connection.
 *
 * Platform globals only, on purpose: this package's runtime dependencies are
 * `@opentelemetry/api` and `dotenv`, and its LaunchDarkly base-SDK dependency is
 * an optional peer, so the content path must not smuggle in an HTTP client.
 *
 * `readTimeoutMs` is applied to every request through a {@link ReadDeadline}:
 * connecting, waiting for headers and each body read are all bounded by the
 * same value, and there is deliberately no separate connect timeout.
 */
export class FetchRequester implements Requester {
  private readonly baseUri: string;

  constructor(
    private readonly sdkKey: string,
    baseUri: string,
    readonly readTimeoutMs: number,
  ) {
    this.baseUri = baseUri.replace(/\/+$/, '');
  }

  /**
   * The request URL: the path, plus `basis` once a payload has committed.
   *
   * Deliberately no `mv` (data model version). That parameter selects the *flag*
   * data model and the connection rejects any value but the flag default; the
   * agent-skill payload is generic, is served regardless of it, and has no model
   * version of its own to ask for.
   */
  private url(path: string, basis: string | null): string {
    if (!basis) return `${this.baseUri}${path}`;
    return `${this.baseUri}${path}?${new URLSearchParams({ basis }).toString()}`;
  }

  /**
   * One `GET /sdk/poll`. Honours `If-None-Match` and returns 304 as a
   * first-class outcome rather than as an error.
   */
  async poll(basis: string | null, etag: string | null, signal: AbortSignal): Promise<PollResult> {
    const headers: Record<string, string> = { Authorization: this.sdkKey, Accept: 'application/json' };
    if (etag) headers['If-None-Match'] = etag;

    // Nothing touches the deadline, so it bounds the whole request: connect,
    // headers and body together.
    const deadline = readDeadline(signal, this.readTimeoutMs);
    try {
      const response = await fetch(this.url(POLL_PATH, basis), { headers, signal: deadline.signal });
      if (response.status === 304) return { notModified: true, events: [], etag };
      if (!response.ok) throw classifyStatus(response.status, response.headers);
      return {
        notModified: false,
        events: decodePollBody(await response.text()),
        etag: response.headers.get('ETag') ?? etag,
      };
    } catch (cause) {
      if (cause instanceof FatalTransportError || cause instanceof RecoverableTransportError) throw cause;
      throw readFailure(cause, 'polling request', deadline);
    } finally {
      deadline.clear();
    }
  }

  /** Opens `GET /sdk/stream` and yields `[event name, data]` pairs. */
  async stream(basis: string | null, signal: AbortSignal): Promise<AsyncIterable<[string, unknown]>> {
    const headers = {
      Authorization: this.sdkKey,
      Accept: 'text/event-stream',
      'Cache-Control': 'no-cache',
    };

    // The same deadline bounds the connect and then, touched by `iterSse` on
    // every read, the gap between reads.
    const deadline = readDeadline(signal, this.readTimeoutMs);
    let response: Response;
    try {
      response = await fetch(this.url(STREAM_PATH, basis), { headers, signal: deadline.signal });
    } catch (cause) {
      deadline.clear();
      throw readFailure(cause, 'streaming request', deadline);
    }

    if (!response.ok) {
      deadline.clear();
      throw classifyStatus(response.status, response.headers);
    }
    if (response.body === null) {
      deadline.clear();
      throw new RecoverableTransportError('the FDv2 stream carried no body');
    }
    deadline.touch();
    return iterSse(response.body, deadline);
  }
}

// ---------------------------------------------------------------------------
// Backoff
// ---------------------------------------------------------------------------

/**
 * Exponential backoff with decorrelating jitter, capped at `maximumMs`.
 *
 * Jitter is subtractive over the *whole* range rather than added on top, so the
 * cap is a real ceiling: a fleet of agent processes restarted together must not
 * reconnect in lockstep, and must not exceed the interval the cap promises.
 */
export function backoffDelayMs(attempt: number, baseMs: number, maximumMs: number, jitter = 0.5): number {
  const ceiling = Math.min(maximumMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return ceiling * (1 - jitter * Math.random());
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    // Unreffed so a pending backoff never holds the process open: the store is a
    // background concern, not a reason for `node` to keep running.
    (timer as unknown as { unref?: () => void }).unref?.();
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

export type FDv2SkillStoreOptions = {
  /**
   * `'stream'` by default. Prefer it: a `delete-object` reaches a live stream in
   * seconds, which is what makes revocation seconds-latent instead of
   * restart-latent, and is why the change-listener re-reconcile is worth wiring
   * at all. `'poll'` exists for environments that cannot hold a long-lived
   * connection, and revocation there is one `pollIntervalMs` late.
   */
  readonly mode?: FDv2Mode;
  readonly baseUri?: string;
  readonly pollIntervalMs?: number;
  /**
   * The only network timeout, in milliseconds. Its meaning and default follow
   * the mode: in `'poll'` it bounds the whole request
   * ({@link DEFAULT_POLL_TIMEOUT_MS}); in `'stream'` it bounds each wait for the
   * next bytes ({@link DEFAULT_STREAM_READ_TIMEOUT_MS}), so a stream that goes
   * quiet reconnects instead of hanging. Must be positive and finite when given.
   */
  readonly readTimeoutMs?: number;
  readonly initialBackoffMs?: number;
  /**
   * Caps every delay between retries, including one the server asks for with
   * `Retry-After`. The header may come from a proxy rather than LaunchDarkly,
   * and a value in the hours would park revocation for that long.
   */
  readonly maxBackoffMs?: number;
  /**
   * Bounds the retry loop. On exceeding it the transport stops, logs an error,
   * and the store keeps serving last known good rather than pretending to be
   * live — `failed` reports it. Only failures in a row count: a committed
   * payload resets the count.
   */
  readonly maxConsecutiveFailures?: number;
  /** Test seam: a transport double in place of `FetchRequester`. */
  readonly requester?: Requester;
};

/**
 * A `SkillStore` fed by LaunchDarkly's SDK-facing FDv2 delivery channel.
 *
 * The transport half of Agent Skills. Constructed with the environment's
 * server-side SDK key, started explicitly, and passed to `initClient`:
 *
 * ```ts
 * const store = new FDv2SkillStore(process.env.LD_SDK_KEY!).start();
 * await store.waitForSkills(10_000);
 * await initClient({ skillStore: store });
 *
 * const skill = await getSkill('pdf-extraction');
 * // ...
 * await store.close();
 * ```
 *
 * **Server-side only.** Skills are for server-side agent runtimes and skill
 * content is customer-confidential. A mobile key or a client-side environment ID
 * throws from the constructor.
 *
 * **Delivery is in the background; retrieval is not.** `SkillStore` is a
 * synchronous seam, so a background task owns the connection and fills memory,
 * and `getObject` only ever reads what has already arrived. Nothing here blocks a
 * retrieval on the network. The corollary is that a process which calls
 * `getSkill` immediately after `start()` may see an empty store; `waitForSkills`
 * is how you order boot against the first payload.
 *
 * **Last known good survives an outage.** A transport failure never empties the
 * store and never makes `getObject` throw: it keeps serving what it last
 * received, which is what makes `writeSkills({ onUnavailable: 'keep' })` correct.
 * `diagnostics` and `failed` report the degradation.
 *
 * **What arrives is untrusted.** This store holds raw wire objects verbatim and
 * verifies nothing — integrity verification lives at the accessor boundary so it
 * applies to every store equally. In particular an object with no `contentHash`
 * is held and then *withheld* by verification; see
 * {@link StoreDiagnostics.hashlessObjects}.
 */
export class FDv2SkillStore implements SkillStore {
  private readonly objects = new SkillObjectSet();
  private readonly reader = new ProtocolReader(this.objects);
  private readonly listeners = new Map<string, Array<(raw: RawSkillObject) => unknown>>();
  private readonly requester: Requester;
  private readonly mode: FDv2Mode;
  private readonly pollIntervalMs: number;
  private readonly initialBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly maxConsecutiveFailures: number;

  private basis: string | null = null;
  private etag: string | null = null;
  private controller: AbortController | null = null;
  private loop: Promise<void> | null = null;
  private failedReason: string | null = null;
  private firstPayload = false;
  private readonly firstPayloadWaiters: Array<() => void> = [];
  // Recoverable failures since the last committed payload. Reset at the commit
  // rather than when a connection returns: a stream only ever ends by being
  // dropped, so resetting on return would count every healthy, server-recycled
  // connection as a failure.
  private failures = 0;

  constructor(sdkKey: string, options: FDv2SkillStoreOptions = {}) {
    const key = requireServerSideCredential(sdkKey);
    this.mode = options.mode ?? 'stream';
    if (this.mode !== 'stream' && this.mode !== 'poll') {
      throw new Error(`mode must be 'stream' or 'poll', got ${JSON.stringify(options.mode)}`);
    }
    this.pollIntervalMs = options.pollIntervalMs ?? 30_000;
    if (this.pollIntervalMs <= 0) {
      throw new Error(`pollIntervalMs must be positive, got ${JSON.stringify(options.pollIntervalMs)}`);
    }
    const readTimeoutMs =
      options.readTimeoutMs ?? (this.mode === 'stream' ? DEFAULT_STREAM_READ_TIMEOUT_MS : DEFAULT_POLL_TIMEOUT_MS);
    if (typeof readTimeoutMs !== 'number' || !Number.isFinite(readTimeoutMs) || readTimeoutMs <= 0) {
      throw new Error(`readTimeoutMs must be positive, got ${String(options.readTimeoutMs)}`);
    }
    this.initialBackoffMs = options.initialBackoffMs ?? 1_000;
    this.maxBackoffMs = options.maxBackoffMs ?? 30_000;
    this.maxConsecutiveFailures = options.maxConsecutiveFailures ?? 10;
    this.requester = options.requester ?? new FetchRequester(key, options.baseUri ?? DEFAULT_BASE_URI, readTimeoutMs);
  }

  // -- lifecycle ---------------------------------------------------------

  /**
   * Starts delivery. Idempotent; returns `this` so it chains.
   *
   * Does not await: use `waitForSkills` when boot ordering matters.
   */
  start(): this {
    if (this.loop !== null) return this;
    this.controller = new AbortController();
    this.loop = this.run(this.controller.signal);
    return this;
  }

  /**
   * Stops delivery. Idempotent, and safe to call twice.
   *
   * Held content is *not* dropped: a closed store still answers from what it
   * received, so shutting the transport down does not turn into an integrity
   * failure or an empty reconcile mid-flight. `shutdown()` is what detaches the
   * store from the accessors.
   *
   * Aborting the signal is what interrupts an open stream: the delivery task
   * spends its life awaiting a read, and a flag it never checks would leave a
   * healthy stream running until the process exited.
   */
  async close(): Promise<void> {
    this.controller?.abort();
    const loop = this.loop;
    this.loop = null;
    this.releaseWaiters();
    if (loop) await loop;
  }

  /**
   * Resolves once the first payload has been committed, or after `timeoutMs`.
   *
   * `true` means a payload arrived — not that any skill in it verified, and not
   * that the environment has any skills. Boot ordering is all this answers;
   * `diagnostics` answers the rest.
   */
  waitForSkills(timeoutMs = 10_000): Promise<boolean> {
    if (this.firstPayload) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(this.firstPayload), timeoutMs);
      (timer as unknown as { unref?: () => void }).unref?.();
      this.firstPayloadWaiters.push(() => {
        clearTimeout(timer);
        resolve(this.firstPayload);
      });
    });
  }

  private releaseWaiters(): void {
    while (this.firstPayloadWaiters.length > 0) this.firstPayloadWaiters.pop()?.();
  }

  private markFirstPayload(): void {
    this.firstPayload = true;
    this.releaseWaiters();
  }

  /** Why delivery stopped for good, or `null` while it is running. */
  get failed(): string | null {
    return this.failedReason;
  }

  /** A snapshot of what the transport has seen. See {@link StoreDiagnostics}. */
  get diagnostics(): StoreDiagnostics {
    return { ...this.reader.diagnostics };
  }

  // -- the SkillStore seam ----------------------------------------------

  getObject(kind: string, key: string, version?: number | null): RawSkillObject | null {
    if (kind !== SKILL_OBJECT_KIND) return null;
    return this.objects.get(key, version ?? null);
  }

  allObjects(kind: string): Record<string, RawSkillObject> {
    if (kind !== SKILL_OBJECT_KIND) return {};
    return this.objects.snapshot();
  }

  /**
   * Registers `fn` to be called once per committed change.
   *
   * Fires **once per changed object at payload-transferred**, not as objects
   * stream in: a payload version is the unit of consistency, and a listener that
   * reacted to a half-applied full transfer would see the store briefly empty.
   * `watchSkills` is the intended consumer.
   *
   * A put notifies with the raw skill object. A revocation notifies with a
   * `{ key, version }` tombstone — it names what went away and carries no
   * content, since there is none. A listener that only needs "something changed"
   * works with both; one that reads content must check for `content` rather than
   * assume it.
   *
   * `fn` runs inline on the delivery task. Keep it cheap and non-blocking: work
   * done there delays the next event. An exception it throws is logged and
   * swallowed, because a broken listener must not be able to kill delivery.
   */
  addListener(kind: string, fn: (raw: RawSkillObject) => unknown): void {
    const existing = this.listeners.get(kind);
    if (existing) existing.push(fn);
    else this.listeners.set(kind, [fn]);
  }

  /**
   * Unregisters `fn` from `kind`. Safe to call from inside a listener: a removal
   * during one commit takes effect from the next.
   *
   * Removes one occurrence; removing a callable that is not registered is a
   * no-op, so `SkillWatcher.close` can detach unconditionally.
   */
  removeListener(kind: string, fn: (raw: RawSkillObject) => unknown): void {
    const listeners = this.listeners.get(kind);
    if (!listeners) return;
    const index = listeners.indexOf(fn);
    if (index !== -1) listeners.splice(index, 1);
  }

  private notify(changes: RawSkillObject[]): void {
    // A copy, so a listener removed mid-commit does not shift its neighbours
    // out from under the iteration.
    const listeners = [...(this.listeners.get(SKILL_OBJECT_KIND) ?? [])];
    for (const raw of changes) {
      for (const listener of listeners) {
        try {
          listener(raw);
        } catch (cause) {
          error(
            `A skill store change listener threw; delivery continues: ${
              cause instanceof Error ? cause.message : String(cause)
            }`,
          );
        }
      }
    }
  }

  // -- the delivery loop -------------------------------------------------

  private async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        if (this.mode === 'stream') await this.streamOnce(signal);
        else await this.pollOnce(signal);
        // A poll that returned is a current answer even when it committed
        // nothing (HTTP 304). A stream never returns normally; its successes
        // are counted at each commit in `apply`.
        this.recordSuccess();
      } catch (cause) {
        if (signal.aborted) return;
        if (cause instanceof FatalTransportError) {
          this.giveUp(cause.message);
          return;
        }
        if (!(cause instanceof RecoverableTransportError)) {
          this.giveUp(`unexpected error in skill delivery: ${cause instanceof Error ? cause.message : String(cause)}`);
          return;
        }
        this.failures += 1;
        const failures = this.failures;
        this.reader.diagnostics.connectionFailures = failures;
        this.reader.diagnostics.lastError = cause.message;
        if (failures > this.maxConsecutiveFailures) {
          this.giveUp(`gave up after ${failures} consecutive failures; last error: ${cause.message}`);
          return;
        }
        const requested = cause.retryAfterMs;
        const delay = Math.min(
          requested !== null && Number.isFinite(requested)
            ? requested
            : backoffDelayMs(failures, this.initialBackoffMs, this.maxBackoffMs),
          // `Retry-After` is a request and `maxBackoffMs` is a promise.
          this.maxBackoffMs,
        );
        warn(`Skill delivery failed (${cause.message}); retrying in ${Math.round(delay)}ms`);
        await sleep(delay, signal);
        continue;
      }

      if (this.mode === 'poll') await sleep(this.pollIntervalMs, signal);
    }
  }

  private recordSuccess(): void {
    this.failures = 0;
    this.reader.diagnostics.connectionFailures = 0;
  }

  private giveUp(reason: string): void {
    this.failedReason = reason;
    this.reader.diagnostics.lastError = reason;
    error(
      `Skill delivery has stopped and will not retry: ${reason}. The store keeps serving the last content it ` +
        'received; skills will not update until the process restarts with a working connection.',
    );
    // Release anyone waiting on a first payload that is never coming, rather than
    // making them eat the full timeout.
    this.markFirstPayload();
  }

  private apply(name: string, data: unknown): TransferOutcome {
    const outcome = this.reader.handle(name, data);
    if (outcome.committed) {
      if (outcome.basis) this.basis = outcome.basis;
      // A commit breaks the row of consecutive failures.
      this.recordSuccess();
      this.markFirstPayload();
      if (outcome.changes && outcome.changes.length > 0) this.notify(outcome.changes);
    }
    return outcome;
  }

  private dispatch(outcome: TransferOutcome): void {
    if (outcome.fatal) throw new FatalTransportError(outcome.fatal);
    if (outcome.disconnect) throw new RecoverableTransportError(outcome.disconnect);
  }

  private async pollOnce(signal: AbortSignal): Promise<void> {
    const result = await this.requester.poll(this.basis, this.etag, signal);
    this.etag = result.etag;
    if (result.notModified) {
      // A 304 is a successful, current answer: the payload we hold is the payload
      // the server has. It counts as a first payload so a boot that reconnects
      // with a cached basis is not blocked on a transfer the server has no reason
      // to send.
      this.markFirstPayload();
      return;
    }
    for (const [name, data] of result.events) {
      this.dispatch(this.apply(name, data));
    }
  }

  private async streamOnce(signal: AbortSignal): Promise<void> {
    const events = await this.requester.stream(this.basis, signal);
    for await (const [name, data] of events) {
      if (signal.aborted) return;
      this.dispatch(this.apply(name, data));
    }
    // A stream that ends without a goodbye is a dropped connection, not a
    // completed operation: reconnect through the backoff path.
    throw new RecoverableTransportError('the FDv2 stream closed unexpectedly');
  }
}
