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
 * Distinct from `SKILL_OBJECT_KIND` (`'skill'`), which is the *seam* value the
 * SDK asks a store for. Translating this pair — kind `inline-resource` plus
 * category `skill` — onto that single value is exactly the adapter's job.
 */
export const FDV2_OBJECT_KIND = 'inline-resource';

/** The `category` that narrows `inline-resource` to an agent skill. */
export const FDV2_OBJECT_CATEGORY = 'skill';

/**
 * Where the SDK-facing FDv2 endpoints live. Overridable for Federal instances,
 * private instances, and the fake endpoint the tests run against.
 */
export const DEFAULT_BASE_URI = 'https://sdk.launchdarkly.com';

export const POLL_PATH = '/sdk/poll';
export const STREAM_PATH = '/sdk/stream';

/**
 * The `mv` request parameter — the SDK data model version this adapter speaks.
 *
 * Overridable through `new FDv2SkillStore(key, { dataModelVersion })` because it
 * is the one request parameter this side cannot verify: the LaunchDarkly base
 * SDK's own FDv2 data source does not send `mv` at all today, and the streamer
 * branch that carries skills is unmerged, so the value the server expects has not
 * been observed. Confirm it with FDN before Beta rather than trusting this
 * default.
 */
export const SDK_DATA_MODEL_VERSION = 1;

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
// Deserialization — where objectVersion is not version
// ---------------------------------------------------------------------------

/** A `delete-object` narrowed to the identity it revokes. */
export type Tombstone = { readonly key: string; readonly objectVersion: number | null };

/**
 * Whether one `put-object` / `delete-object` payload is a skill.
 *
 * `kind === 'inline-resource' && category === 'skill'`, and nothing else. Both
 * halves are required: `inline-resource` is a broad kind that may carry other
 * categories, and flags and segments omit `category` entirely.
 *
 * Every other kind is **ignored, not rejected**. An environment's payload
 * assignment carries the flagging payload alongside the agent-skill payload, so a
 * connection delivers flag and segment objects as a matter of course. Throwing on
 * them would turn a normal payload into a permanent failure — which is exactly
 * the unknown-kind reconnect loop this feature must not reproduce.
 */
export function isSkillEvent(data: unknown): boolean {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return false;
  const candidate = data as { kind?: unknown; category?: unknown };
  return candidate.kind === FDV2_OBJECT_KIND && candidate.category === FDV2_OBJECT_CATEGORY;
}

/**
 * Translates one FDv2 skill `put-object` into a seam-shaped raw object.
 *
 * `null` when the event cannot be filed at all — only when `key` is not a string,
 * since a keyless object has no identity to store it under and no key to
 * attribute a failure to. Every other defect is carried through verbatim so that
 * *verification* withholds it, with a reason code and an integrity signal, rather
 * than the transport dropping it silently. A silent drop is indistinguishable
 * from "no such skill" and would additionally let a prune delete the last
 * known-good copy on disk.
 *
 * **The translation this whole module exists to get right:**
 *
 * ```
 * wire `objectVersion`  →  seam `version`      (the skill's own version)
 * wire `version`        →  dropped              (the *payload* version)
 * ```
 *
 * `objectVersion` is what a `{key, version}` reference pins. `version` is the
 * version of the payload the object arrived in — it changes when anything in the
 * environment changes, including a flag that has nothing to do with skills.
 * Reading it as the skill's version resolves the wrong content with no error
 * anywhere: the object verifies, the hash matches, and the caller is handed a
 * skill under a version number that means nothing. Flags and segments carry only
 * `version`, which is why the two fields look interchangeable and are not.
 */
export function seamObjectFromPut(data: Record<string, unknown>): RawSkillObject | null {
  const { key } = data as { key?: unknown };
  if (typeof key !== 'string' || key === '') {
    warn(
      "An FDv2 skill put-object carried no string 'key' and could not be stored under any identity; it was dropped.",
    );
    return null;
  }

  const raw: RawSkillObject = { key };

  // The single translation. Written as a property-presence test rather than a
  // defaulted read so an explicitly-null objectVersion stays null and reaches
  // verification as `invalid_version`, instead of being invented here.
  if ('objectVersion' in data) raw.version = data.objectVersion;

  const envelope = data.object;
  if (typeof envelope === 'object' && envelope !== null && !Array.isArray(envelope)) {
    for (const field of ENVELOPE_FIELDS) {
      if (field in envelope) raw[field] = (envelope as Record<string, unknown>)[field];
    }
  }
  return raw;
}

/**
 * Narrows one FDv2 skill `delete-object` to the identity it revokes.
 *
 * A delete for an inline resource **is revocation** — the object leaves the
 * payload, this store drops it, the accessors stop resolving it, and the next
 * reconcile prunes its files. Same `objectVersion` translation as a put.
 *
 * An `objectVersion` of `null` means the delete named no usable version, and is
 * read as "revoke every version of this key". That is the safe direction: the
 * alternative is ignoring an unparseable revocation and continuing to serve
 * content LaunchDarkly has withdrawn.
 */
export function tombstoneFromDelete(data: Record<string, unknown>): Tombstone | null {
  const { key } = data as { key?: unknown };
  if (typeof key !== 'string' || key === '') {
    warn("An FDv2 skill delete-object carried no string 'key'; it was ignored.");
    return null;
  }
  const objectVersion = data.objectVersion;
  return { key, objectVersion: isValidSkillVersion(objectVersion) ? objectVersion : null };
}

// ---------------------------------------------------------------------------
// The held object set
// ---------------------------------------------------------------------------

/**
 * Raw skill objects held in memory, keyed by `(key, objectVersion)`.
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
 */
export class ProtocolReader {
  readonly diagnostics = freshDiagnostics();
  private intent: string | null = null;
  private pending: SkillObjectSet | null = null;
  private changes: RawSkillObject[] = [];

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
    const first = payloads[0] as { intentCode?: unknown } | null;
    const intent = typeof first?.intentCode === 'string' ? first.intentCode : null;
    this.intent = intent;
    this.changes = [];
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
    // A tombstone, not a skill object: it carries identity and no content, so a
    // listener that only needs "something changed" works unchanged while one that
    // reads content sees no `content` field. Documented on `addListener`.
    this.changes.push({ key: tombstone.key, version: tombstone.objectVersion });
    return {};
  }

  private payloadTransferred(data: unknown): TransferOutcome {
    const state = (data as { state?: unknown } | null)?.state;
    if (this.pending !== null) {
      this.committed.replaceWith(this.pending);
      warnIfNothingCanVerify(this.committed.allRaw());
    }
    this.pending = null;
    this.intent = null;
    const { changes } = this;
    this.changes = [];
    this.diagnostics.payloadsTransferred += 1;
    return {
      committed: true,
      changes,
      basis: typeof state === 'string' && state !== '' ? state : null,
    };
  }

  private error(data: unknown): TransferOutcome {
    const reason = (data as { reason?: unknown } | null)?.reason;
    // An error abandons the in-flight payload and keeps what is committed.
    this.pending = null;
    this.intent = null;
    this.changes = [];
    return { disconnect: `server sent error: ${String(reason)}` };
  }

  private goodbye(data: unknown): TransferOutcome {
    const parsed = (data ?? {}) as { reason?: unknown; silent?: unknown; catastrophe?: unknown };
    this.pending = null;
    this.intent = null;
    this.changes = [];
    if (parsed.silent !== true) {
      warn(`FDv2 connection closing: ${String(parsed.reason)}`);
    }
    if (parsed.catastrophe === true) {
      return { fatal: `server sent a catastrophic goodbye: ${String(parsed.reason)}` };
    }
    return { disconnect: `server said goodbye: ${String(parsed.reason)}` };
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
  "FDv2 is opt-in per account: the 'fdv2-protocol-control' setting defaults to 'forbid', which is served as " +
  'HTTP 403. Skill delivery over this channel needs that flag flipped for the account, and needs the ' +
  'FDCore/streamer inline-resource support merged and deployed.';

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
        `understood; the 'mv' data model version (${SDK_DATA_MODEL_VERSION}) is the parameter most likely to be wrong.`,
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
 * Decodes an SSE byte stream into `[event name, data]` pairs.
 *
 * Minimal on purpose — this consumes one LaunchDarkly endpoint, not the whole
 * spec: `event:`/`data:` fields, multi-line `data` joined with newlines, a blank
 * line dispatching, and `:` comments skipped.
 */
export async function* iterSse(body: ReadableStream<Uint8Array>): AsyncGenerator<[string, unknown], void, undefined> {
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
      const { done, value } = await reader.read();
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
 */
export class FetchRequester implements Requester {
  private readonly baseUri: string;

  constructor(
    private readonly sdkKey: string,
    baseUri: string,
    private readonly dataModelVersion: number,
  ) {
    this.baseUri = baseUri.replace(/\/+$/, '');
  }

  private url(path: string, basis: string | null): string {
    const params = new URLSearchParams({ mv: String(this.dataModelVersion) });
    if (basis) params.set('basis', basis);
    return `${this.baseUri}${path}?${params.toString()}`;
  }

  /**
   * One `GET /sdk/poll`. Honours `If-None-Match` and returns 304 as a
   * first-class outcome rather than as an error.
   */
  async poll(basis: string | null, etag: string | null, signal: AbortSignal): Promise<PollResult> {
    const headers: Record<string, string> = { Authorization: this.sdkKey, Accept: 'application/json' };
    if (etag) headers['If-None-Match'] = etag;

    let response: Response;
    try {
      response = await fetch(this.url(POLL_PATH, basis), { headers, signal });
    } catch (cause) {
      if (signal.aborted) throw cause;
      throw new RecoverableTransportError(
        `polling request failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }

    if (response.status === 304) return { notModified: true, events: [], etag };
    if (!response.ok) throw classifyStatus(response.status, response.headers);
    return {
      notModified: false,
      events: decodePollBody(await response.text()),
      etag: response.headers.get('ETag') ?? etag,
    };
  }

  /** Opens `GET /sdk/stream` and yields `[event name, data]` pairs. */
  async stream(basis: string | null, signal: AbortSignal): Promise<AsyncIterable<[string, unknown]>> {
    const headers = {
      Authorization: this.sdkKey,
      Accept: 'text/event-stream',
      'Cache-Control': 'no-cache',
    };

    let response: Response;
    try {
      response = await fetch(this.url(STREAM_PATH, basis), { headers, signal });
    } catch (cause) {
      if (signal.aborted) throw cause;
      throw new RecoverableTransportError(
        `streaming request failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }

    if (!response.ok) throw classifyStatus(response.status, response.headers);
    if (response.body === null) throw new RecoverableTransportError('the FDv2 stream carried no body');
    return iterSse(response.body);
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
  readonly initialBackoffMs?: number;
  readonly maxBackoffMs?: number;
  /**
   * Bounds the retry loop. On exceeding it the transport stops, logs an error,
   * and the store keeps serving last known good rather than pretending to be
   * live — `failed` reports it.
   */
  readonly maxConsecutiveFailures?: number;
  readonly dataModelVersion?: number;
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
    this.initialBackoffMs = options.initialBackoffMs ?? 1_000;
    this.maxBackoffMs = options.maxBackoffMs ?? 30_000;
    this.maxConsecutiveFailures = options.maxConsecutiveFailures ?? 10;
    this.requester =
      options.requester ??
      new FetchRequester(key, options.baseUri ?? DEFAULT_BASE_URI, options.dataModelVersion ?? SDK_DATA_MODEL_VERSION);
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

  private notify(changes: RawSkillObject[]): void {
    const listeners = this.listeners.get(SKILL_OBJECT_KIND) ?? [];
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
    let failures = 0;
    while (!signal.aborted) {
      try {
        if (this.mode === 'stream') await this.streamOnce(signal);
        else await this.pollOnce(signal);
        failures = 0;
        this.reader.diagnostics.connectionFailures = 0;
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
        failures += 1;
        this.reader.diagnostics.connectionFailures = failures;
        this.reader.diagnostics.lastError = cause.message;
        if (failures > this.maxConsecutiveFailures) {
          this.giveUp(`gave up after ${failures} consecutive failures; last error: ${cause.message}`);
          return;
        }
        const delay = cause.retryAfterMs ?? backoffDelayMs(failures, this.initialBackoffMs, this.maxBackoffMs);
        warn(`Skill delivery failed (${cause.message}); retrying in ${Math.round(delay)}ms`);
        await sleep(delay, signal);
        continue;
      }

      if (this.mode === 'poll') await sleep(this.pollIntervalMs, signal);
    }
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
