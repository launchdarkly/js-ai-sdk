/**
 * Agent Skills — the FDv2 delivery transport.
 *
 * The store implementation that talks to LaunchDarkly. It sits *below* the
 * `SkillStore` seam: it produces raw wire objects in the shape `skills-core.ts`
 * documents, and everything above — the accessors, integrity verification, the
 * `Skill` type, materialization — is unaware of it.
 *
 * Layering:
 *
 * ```
 * @launchdarkly/ai-server
 *   └─ SkillStore (types.ts)              ── structurally typed accessor surface
 *         └─ FDv2SkillStore (this file)   ── deserialize, hold, serve
 *               └─ the SDK-facing FDv2 channel
 *                  GET /sdk/poll, GET /sdk/stream, authenticated with the
 *                  environment's server-side SDK key
 * ```
 *
 * Dependencies run one way. This module imports `skills-core.ts` for the seam's
 * kind constant and nothing else from the feature; `skills.ts` and `skills-fs.ts`
 * do not import it. It uses only platform globals — `fetch`, `AbortController`,
 * `TextDecoder` — so the content path adds no dependency.
 *
 * What this module does *not* do, on purpose:
 *
 * - **It does not verify content.** Verification lives at the accessor boundary
 *   in `skills-core.ts` so that it applies to every store equally, including
 *   `InMemorySkillStore` and a customer's own.
 * - **It does not skip verification when the wire envelope has no
 *   `contentHash`.** A hashless object is stored verbatim and *withheld* by
 *   verification with `missing_content_hash`; this module makes that outcome
 *   loud rather than papering over it.
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
 * Object kinds on the SDK-facing channel are open strings: every object in the
 * agent-skill payload carries the kind its producer registered, which for skills
 * is the bare category name. Delivery lower-cases the kind, so an exact
 * comparison is the whole test. The kind happens to equal `SKILL_OBJECT_KIND`
 * today; they are still separate constants, because one is a wire value
 * LaunchDarkly owns and the other is an SDK seam.
 *
 * Not to be confused with {@link FDV2_PAYLOAD_KIND}: this is the kind of the
 * *objects*, that one the kind of the *payload* they arrive in.
 */
export const FDV2_OBJECT_KIND = 'skill';

/**
 * The kind of the FDv2 payload skills are delivered in, declared on every
 * request as `?kinds=`.
 *
 * Delivery narrows a connection to the payload kinds it declares and defaults to
 * flags, so this is not an optimisation: a request that omits it receives the
 * environment's flag payload and no skills at all. Declaring it is also what
 * makes the connection carry exactly one payload — the shape
 * {@link ProtocolReader} is built for — since a skill-enabled environment
 * assigns both the flag payload and this one.
 *
 * The wire accepts a comma-separated list, but this store wants the skill
 * payload and nothing else, so it declares this one kind alone.
 */
export const FDV2_PAYLOAD_KIND = 'agent-skill';

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
 * Where `GET /sdk/poll` is served. Overridable for Federal instances, private
 * instances, and relay deployments.
 */
export const DEFAULT_BASE_URI = 'https://sdk.launchdarkly.com';

/**
 * Where `GET /sdk/stream` is served. LaunchDarkly serves streaming from a
 * different host than polling, matching the base server-side SDK's defaults.
 */
export const DEFAULT_STREAM_URI = 'https://stream.launchdarkly.com';

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
 * Skills are for server-side agent runtimes and skill content is
 * customer-confidential. A client-side credential may succeed against these
 * endpoints, so the SDK refuses one up front rather than deliver skill content
 * to a client-side process.
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

/** The only hosts a plain `http://` URI may name: a local test double. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '::1']);

/**
 * Refuses a URI that would send the SDK key in cleartext.
 *
 * Every request carries the environment's server-side SDK key in
 * `Authorization`, so the transport is `https://` only. The one exception is
 * `http://` to a loopback host (`localhost`, `127.0.0.1`, `::1`), which never
 * leaves the machine and is what a local test double listens on. Throws rather
 * than warns, for the same reason the credential check does: a store that would
 * leak its key should not exist.
 *
 * Returns the URI trimmed. The check is on the store, not on the socket it
 * happens to open, so it runs whether or not a `Requester` was injected.
 */
export function requireHttpsUri(uri: unknown, option: 'baseUri' | 'streamUri' = 'baseUri'): string {
  if (typeof uri !== 'string' || uri.trim() === '') {
    throw new Error(`FDv2SkillStore requires an https:// URI for ${option}; none was given.`);
  }
  const trimmed = uri.trim();
  let parsed: URL | null = null;
  try {
    parsed = new URL(trimmed);
  } catch {
    parsed = null;
  }
  // WHATWG `hostname` keeps the brackets on an IPv6 literal; the loopback list
  // names the address, as the Python SDK's does.
  const hostname = parsed?.hostname.replace(/^\[(.*)\]$/, '$1') ?? '';
  if (parsed?.protocol === 'https:' && hostname !== '') return trimmed;
  if (parsed?.protocol === 'http:' && LOOPBACK_HOSTS.has(hostname)) return trimmed;
  if (parsed?.protocol === 'http:') {
    throw new Error(
      `FDv2SkillStore refuses ${option} ${JSON.stringify(trimmed)}: a plain http:// URI would send the server-side ` +
        'SDK key in cleartext. Use https:// (the defaults are https://sdk.launchdarkly.com for polling and ' +
        'https://stream.launchdarkly.com for streaming). Plain http:// is allowed only for a loopback host ' +
        '(localhost, 127.0.0.1, ::1) serving a local test double.',
    );
  }
  throw new Error(
    `FDv2SkillStore refuses ${option} ${JSON.stringify(trimmed)}: expected an https:// URI with a host, such as ` +
      'https://sdk.launchdarkly.com.',
  );
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
  /**
   * Skill revocations applied: every `delete-object` event, plus every skill key
   * a full transfer dropped altogether.
   *
   * A key whose version merely moved does not count. A full transfer states the
   * whole payload, so a version bump arrives as a put for the new version and an
   * absence where the old one was; both halves still reach listeners, because a
   * listener that reads versions needs them, but a key that survives under a new
   * version was never revoked.
   */
  readonly objectsRevoked: number;
  /**
   * Transfers not applied because they completed a payload other than the one
   * skills arrive on. Zero while delivery sends one payload per connection.
   */
  readonly payloadsIgnored: number;
  /**
   * Skill objects whose envelope carried no `contentHash`, across all payloads.
   *
   * Verification withholds a hashless object with `missing_content_hash`, so a
   * nonzero count means such objects have arrived and the skills they carry will
   * not resolve. The field exists so that outcome is a number a caller can read
   * rather than an empty store they have to explain.
   *
   * Like the rest of this type it is **cumulative and never decreases.** Objects
   * are counted as their events are read, so the count includes objects from a
   * payload that never committed, and in polling mode it rises again every time
   * an unchanged payload is re-delivered. Read it as "this has happened", not as
   * the size of the currently withheld set.
   */
  readonly hashlessObjects: number;
  /**
   * Recoverable transport failures in a row. Back to zero on a completed
   * exchange — a committed payload, or a `none` intent saying the payload held
   * is current — and not raised by a connection the server closes normally
   * after reaching that point, which is how a long-lived stream is recycled. A
   * parsed transfer intent alone does not reset it: an announced transfer that
   * never commits delivered nothing. A connection closed without ever getting
   * there delivered nothing either, and does raise it.
   */
  readonly connectionFailures: number;
  /**
   * Requests answered with "no payload of the kind you asked for"
   * ({@link NoSkillPayloadError}). Cumulative, and never reset.
   *
   * It is deliberately not a `connectionFailures`: nothing is wrong, there is
   * nothing to deliver. Nonzero and rising alongside an empty store is the
   * difference between "this environment has no skills" and "delivery is
   * broken", which is the pair this whole type exists to separate.
   */
  readonly payloadUnavailable: number;
  /** The most recent transport error, if any. Human-readable; do not parse. */
  readonly lastError: string | null;
};

const HASHLESS_ADVICE =
  "The delivered skill object carries no 'contentHash', so integrity verification withholds it with reason_code " +
  "'missing_content_hash' and its content will not resolve. Contact LaunchDarkly support.";

/**
 * Ceiling on remembered hashless reports, so a process whose skills are
 * versioned often cannot accumulate an entry per version indefinitely. Oldest
 * out first; an evicted object can be reported a second time, which is the
 * cheaper of the two failure modes.
 */
const HASHLESS_MEMORY_LIMIT = 512;

/** Distinguishes the store-wide summary's entry from a per-object one. */
const SUMMARY_MARKER = '\u0000summary\u0000';

/**
 * What one reader has already reported hashless: one entry per
 * `(key, version)`, plus one describing the store-wide summary last spoken.
 *
 * Held **per `ProtocolReader`** — so per store — rather than at module scope.
 * Each error is then one per object per store rather than one per re-delivered
 * payload, which matters most in polling mode where the same payload arrives on
 * every interval; and two stores in one process do not share a memory, so a
 * second store seeing the same broken object is told about it too.
 */
class HashlessMemory {
  readonly seen = new Set<string>();

  private remember(entry: string): void {
    // Insertion-ordered iteration makes the first entry the oldest.
    while (this.seen.size >= HASHLESS_MEMORY_LIMIT) {
      const oldest = this.seen.values().next().value;
      if (oldest === undefined) break;
      this.seen.delete(oldest);
    }
    this.seen.add(entry);
  }

  /**
   * One error per `(key, version)` whose envelope had no `contentHash`.
   *
   * At error level rather than warn, and per object rather than once per store,
   * because this is the difference between a broken deployment and an
   * empty-by-design one.
   */
  warnHashless(raw: RawSkillObject): void {
    const identity = `${String(raw.key)}:${String(raw.version)}`;
    if (this.seen.has(identity)) return;
    this.remember(identity);
    error(
      `Skill '${String(raw.key)}' version ${String(raw.version)} arrived without a contentHash and will be ` +
        `withheld. ${HASHLESS_ADVICE}`,
    );
  }

  /** Forgets the summary, so a relapse after a recovery is reported afresh. */
  private forgetSummary(): void {
    for (const entry of this.seen) {
      if (entry.startsWith(SUMMARY_MARKER)) this.seen.delete(entry);
    }
  }

  /**
   * One error per *distinct* committed store in which nothing held can possibly
   * verify.
   *
   * Fires at delivery time, so the condition is visible in a process that
   * boots, materializes nothing, and exits — which is the shape a skills
   * deployment fails in. The accessor boundary's own withholding summary only
   * speaks once a caller asks.
   *
   * Spoken when the condition becomes true and whenever the hashless objects
   * change, and not again for a store that has not moved: an unchanging payload
   * re-delivered on every poll describes one problem, not one per interval. A
   * store that recovers and relapses is reported again.
   */
  warnIfNothingCanVerify(held: RawSkillObject[]): void {
    const hashless = held.filter((raw) => typeof raw.contentHash !== 'string');
    if (hashless.length === 0) {
      // Everything held verifies, so there is nothing outstanding to remember.
      this.seen.clear();
      return;
    }
    if (hashless.length !== held.length) {
      this.forgetSummary();
      return;
    }

    const summary =
      SUMMARY_MARKER +
      hashless
        .map((raw) => `${String(raw.key)}:${String(raw.version)}`)
        .sort()
        .join('\u0000');
    if (this.seen.has(summary)) return;
    this.forgetSummary();
    this.remember(summary);
    error(
      `All ${held.length} skill object(s) in the delivered payload arrived without a contentHash. No skill ` +
        `content will resolve from this store. ${HASHLESS_ADVICE}`,
    );
  }
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
 * would turn a normal payload into a reconnect loop.
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
 * `snapshot` collapses to one object per key at its newest version, because
 * `<root>/<key>/SKILL.md` is a single path and `allSkills` should return one
 * entry per skill. `get` still resolves a pinned version out of the full set.
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

  /**
   * One entry per skill key, at its newest version, keyed by the bare skill key.
   *
   * The key must be the skill key, never the wire `key:version`: `writeSkills('*')`
   * derives its prune keep-set from these keys, and a key it cannot parse as a
   * skill key drops out of the keep-set and takes the copy already on disk with
   * it. Use `allRaw` to see every held `(key, version)`.
   */
  snapshot(): Record<string, RawSkillObject> {
    const out: Record<string, RawSkillObject> = {};
    for (const [key, held] of this.versions) {
      if (held.size === 0) continue;
      const newest = Math.max(...held.keys());
      const raw = held.get(newest);
      if (raw) out[key] = raw;
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
  /**
   * Set by an event that proves the connection reached a working server and
   * completed an exchange with it: the `none` intent, which commits nothing
   * because the payload held is already current. A transfer intent does not
   * set it — an announced transfer that never commits is not health, and the
   * commit itself is reported through `committed`.
   */
  healthy?: boolean;
  /**
   * Set on a `disconnect` the server asked for while serving normally — a
   * non-catastrophic `goodbye`. The connection still ends and is retried. The
   * caller decides whether it counts as a failure, since only a connection that
   * had reached a working server was being served normally at all.
   */
  expected?: boolean;
};

/**
 * `(key, version)` as one comparable string. Objects with no usable version
 * compare alike, which is what holding them under their key alone already means.
 */
function identityOf(raw: RawSkillObject): string {
  return `${String(raw.key)}\u0000${isValidSkillVersion(raw.version) ? raw.version : ''}`;
}

/**
 * Tombstones for every object `next` no longer holds.
 *
 * A full transfer states the whole payload, so its revocations arrive as an
 * absence rather than as an event; this recovers them. At `(key, version)`
 * granularity to match `delete-object`, so a key whose version moved yields both
 * a put for the arrival and a tombstone for the departure — what a listener that
 * reads versions needs, and harmless to one that only needs "something changed".
 */
function revocationsBetween(current: SkillObjectSet, next: SkillObjectSet): RawSkillObject[] {
  const surviving = new Set(next.allRaw().map(identityOf));
  return current
    .allRaw()
    .filter((raw) => !surviving.has(identityOf(raw)))
    .map((raw) => ({ key: raw.key, version: isValidSkillVersion(raw.version) ? raw.version : null }));
}

/**
 * How many of `revoked` are true revocations rather than version moves.
 *
 * Counted per key, not per tombstone: a key `next` still holds under some other
 * version has moved, and only a key that left the payload entirely is gone. This
 * is what `objectsRevoked` counts; `changes` carries every tombstone regardless.
 */
function keysFullyRevoked(revoked: RawSkillObject[], next: SkillObjectSet): number {
  const departed = new Set<string>();
  for (const raw of revoked) {
    const key = String(raw.key);
    if (next.get(key, null) === null) departed.add(key);
  }
  return departed.size;
}

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
    payloadUnavailable: 0,
    lastError: null,
  };
}

/**
 * Applies FDv2 events to an object set. Pure — no sockets, no timers, no clock.
 *
 * Kept free of transport concerns so the protocol can be driven without a
 * server: the HTTP layer above it only has to turn bytes into
 * `[event name, data]` pairs.
 *
 * **Changes are buffered and committed at `payload-transferred`.** A payload
 * version is the unit of consistency: applying half of one would publish a state
 * the server never described, and on a full transfer it would briefly empty the
 * store — which, with pruning on, is the difference between a reconcile and
 * deleting a customer's skill files. Listeners therefore fire at commit — once
 * per changed object, all of them at `payload-transferred`.
 *
 * **The first payload intent is read, and is assumed to be the skill payload**,
 * as the protocol requires. Because an `xfer-full` for a different payload would
 * otherwise empty the skill set, this layer learns which payload skills arrive
 * on and declines to apply a transfer of any other, once at warning level and
 * counted. The first transfer of a connection is always applied: before a skill
 * has arrived there is nothing to compare a payload against.
 */
export class ProtocolReader {
  readonly diagnostics = freshDiagnostics();
  private readonly hashless = new HashlessMemory();
  /** What this reader has reported hashless. Exposed for tests; not API. */
  readonly _warnedHashless: Set<string> = this.hashless.seen;
  private intent: string | null = null;
  // Whether this intent's unknown code has been warned about. Reset per
  // `server-intent`, so the warning is once per announcement rather than once
  // per object or once per reader.
  private warnedUnknownIntent = false;
  private pending: SkillObjectSet | null = null;
  private changes: RawSkillObject[] = [];
  // The payload the current intent describes, and the payload skills have
  // actually arrived on. Kept apart so a transfer of some other payload can be
  // recognised and declined.
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
    this.warnedUnknownIntent = false;
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
    // Only the `none` intent is a completed exchange: the payload held is
    // current, and nothing more will follow, so it is the one sign of health a
    // connection that commits nothing can give. An `xfer-full` or
    // `xfer-changes` intent is a promise, not a delivery — a server that
    // announces a transfer and drops before `payload-transferred`, every time,
    // has delivered nothing, and counting the announcement as health would
    // retry it forever at the initial backoff.
    return { healthy: intent === INTENT_TRANSFER_NONE };
  }

  private target(): SkillObjectSet | null {
    if (this.pending === null && (this.intent === INTENT_TRANSFER_FULL || this.intent === INTENT_TRANSFER_CHANGES)) {
      // An object arrived before any server-intent. Treat it as a delta against
      // what we hold rather than dropping it.
      this.pending = this.committed.copy();
    }
    return this.pending;
  }

  /**
   * A skill object arrived under an intent this reader cannot apply — a future
   * intent code, or `none`, under which no objects should arrive at all.
   *
   * Dropped rather than guessed at, since guessing could empty the store; but
   * dropped **visibly**: counted under `objectsIgnored`, with one warning per
   * intent announcement so a payload of many objects is one line, not many.
   */
  private ignoreUnderUnknownIntent(): TransferOutcome {
    this.diagnostics.objectsIgnored += 1;
    if (!this.warnedUnknownIntent) {
      this.warnedUnknownIntent = true;
      warn(
        `Skill objects arrived under FDv2 intent code ${JSON.stringify(this.intent)}, which this SDK cannot ` +
          'apply; they are being ignored and counted under objectsIgnored. The skills held are unchanged. If ' +
          'this persists, update the SDK.',
      );
    }
    return {};
  }

  private putObject(data: unknown): TransferOutcome {
    if (!isSkillEvent(data)) {
      this.diagnostics.objectsIgnored += 1;
      return {};
    }
    if (this.pending === null && this.intent === null) this.intent = INTENT_TRANSFER_CHANGES;
    const target = this.target();
    if (target === null) return this.ignoreUnderUnknownIntent();

    const raw = seamObjectFromPut(data as Record<string, unknown>);
    if (raw === null) return {};
    target.put(raw);
    this.changes.push(raw);
    this.diagnostics.skillObjectsReceived += 1;
    this.skillsInPayload += 1;
    if (typeof raw.contentHash !== 'string') {
      this.diagnostics.hashlessObjects += 1;
      this.hashless.warnHashless(raw);
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
    if (target === null) return this.ignoreUnderUnknownIntent();

    const tombstone = tombstoneFromDelete(data as Record<string, unknown>);
    if (tombstone === null) return {};
    // Counted only when the delete removed something. A tombstone for a key
    // never held is still reported to listeners below, but `objectsRevoked` is
    // read precisely when somebody is working out whether a revocation landed,
    // and a delete of nothing would inflate the one number that answers that.
    if (target.delete(tombstone).length > 0) this.diagnostics.objectsRevoked += 1;
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
    // Regardless of whether a pending set exists: a `none` intent builds none,
    // and the transfer that completes it still names a payload whose selector
    // must not become the resume point if it is not the payload skills arrive on.
    const foreign = this.isForeignPayload(payloadId);
    if (foreign) {
      this.warnForeignPayload(payloadId);
      this.diagnostics.payloadsIgnored += 1;
      this.changes = [];
    } else if (this.pending !== null) {
      // A full transfer revokes by omission: whatever it did not carry is gone,
      // and no `delete-object` ever says so. Diffed before the swap, so those
      // departures reach listeners as tombstones like any other revocation.
      if (this.intent === INTENT_TRANSFER_FULL) {
        const revoked = revocationsBetween(this.committed, this.pending);
        this.changes.push(...revoked);
        // Every departure is reported; only a key that left counts as revoked.
        this.diagnostics.objectsRevoked += keysFullyRevoked(revoked, this.pending);
      }
      this.committed.replaceWith(this.pending);
      this.hashless.warnIfNothingCanVerify(this.committed.allRaw());
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
      // A declined payload must not move the resume point. Adopting the selector
      // of a transfer whose contents this layer just threw away would ask the
      // next poll or stream to resume from someone else's payload, and skill
      // updates could stop arriving while every diagnostic still read healthy.
      basis: foreign || typeof state !== 'string' || state === '' ? null : state,
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
    // Expected: the server is closing a connection it was serving, which is how
    // a long-lived stream gets recycled.
    return { disconnect: `server said goodbye: ${String(parsed.reason)}`, expected: true };
  }

  // -- payload identity ----------------------------------------------------

  /**
   * Whether a transfer completes a payload other than the one skills arrive on.
   *
   * `false` unless both payloads are known, so one-payload delivery and the
   * first transfer of a connection are always applied.
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

/**
 * A connection that ended and is worth retrying. Carries a server-requested
 * delay when given one.
 */
export class RecoverableTransportError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs: number | null = null,
    /**
     * Whether the server closed a connection it had been serving normally —
     * a `goodbye` on a connection that reached a working server. Retried like
     * any other, but neither logged as a failure nor counted against
     * `maxConsecutiveFailures`. A `goodbye` on a connection that never got that
     * far is not expected: it delivered nothing, so it counts.
     */
    readonly expected = false,
  ) {
    super(message);
  }
}

/**
 * An HTTP 400 for a request carrying client state — the `basis` selector, or an
 * `If-None-Match` etag. That state is the one part of the request that can go
 * stale, so it is dropped and a full transfer requested once before the status
 * is treated as fatal.
 */
export class StaleRequestStateError extends RecoverableTransportError {}

/**
 * An HTTP 422: delivery has no payload of the kind this store declared.
 *
 * That is the answer for every project in which no skill has ever been created,
 * since the agent-skill payload row is created with the first one. Neither of
 * the two obvious classifications is right, which is why this is its own class:
 *
 * - as a failure it would spend `maxConsecutiveFailures` and then give up
 *   permanently — "gave up after N consecutive failures" — on a configuration
 *   that is merely waiting for its first skill;
 * - as fatal, the skill created a minute later would never arrive, because
 *   nothing reopens delivery short of a process restart.
 *
 * `expected` is what keeps it off `connectionFailures`, `lastError` and the
 * per-attempt warning; the rest is in the delivery loop.
 */
export class NoSkillPayloadError extends RecoverableTransportError {
  constructor(message: string) {
    super(message, null, true);
  }
}

const REQUEST_ADVICE =
  'The request this adapter sent was not understood. It carries only the SDK key and, after the first payload, ' +
  "a 'basis' selector, so check the base URI and that the endpoint speaks FDv2.";

const FORBIDDEN_ADVICE =
  'The FDv2 protocol is opt-in per LaunchDarkly account and is served as HTTP 403 while it is off. Skill ' +
  'delivery needs it enabled; contact LaunchDarkly support to enable it for your account.';

/** `Retry-After` in milliseconds, when the server sent a usable one. */
export function retryAfterMs(headers: Headers | null | undefined): number | null {
  const raw = headers?.get('Retry-After');
  if (raw === null || raw === undefined) return null;
  const value = raw.trim();
  // A blank header is not a delay of zero. `Number('')` is 0 and finite, and a
  // proxy that sends the header empty would otherwise collapse every backoff.
  if (value === '') return null;
  const seconds = Number(value);
  // The HTTP-date form is legal and rare; falling back to our own backoff is
  // better than parsing a date to honour it approximately.
  if (!Number.isFinite(seconds)) return null;
  return Math.max(0, seconds * 1000);
}

/**
 * The fatal error for a 3xx. Both fetches are sent with `redirect: 'manual'`,
 * because the default `'follow'` copies every request header onto the
 * redirected request, `Authorization` included, so a 3xx from a proxy or a
 * misconfigured private instance would hand the SDK key to whatever host
 * `Location` names. Same-host redirects are refused too: the endpoints this
 * module calls do not redirect, and a 304 is not a redirect and never reaches
 * here.
 */
function redirectRefused(status: string): FatalTransportError {
  return new FatalTransportError(
    `LaunchDarkly returned ${status}, a redirect. Redirects are not followed, so the SDK key is never forwarded to a ` +
      'host other than the base URI. The SDK-facing FDv2 endpoints do not redirect; check the base URI, and any proxy ' +
      'in between, for the address being redirected to.',
  );
}

/**
 * The error for a response `fetch` answered with `redirect: 'manual'`, or
 * `null` when it was not a redirect. A runtime that withholds the status of a
 * redirect answers with an `opaqueredirect` response instead; that is still a
 * redirect and still refused.
 */
function refusedRedirect(response: Response): FatalTransportError | null {
  if (response.type === 'opaqueredirect') return redirectRefused('a 3xx status');
  if (response.status >= 300 && response.status < 400 && response.status !== 304) {
    return classifyStatus(response.status, response.headers);
  }
  return null;
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
  if (status >= 300 && status < 400 && status !== 304) return redirectRefused(`HTTP ${status}`);
  if (status === 404) {
    return new FatalTransportError(
      'LaunchDarkly returned HTTP 404 for the FDv2 endpoint. Check the base URI, and that this instance serves ' +
        '/sdk/poll and /sdk/stream.',
    );
  }
  // A 400 is the one rejection the adapter can act on: the selector it sent may
  // be one the server no longer accepts. Recoverable so the selector can be
  // dropped and a full transfer requested; fatal once that has been tried.
  if (status === 400) return new StaleRequestStateError(`LaunchDarkly returned HTTP 400. ${REQUEST_ADVICE}`);
  if (status === 422) {
    return new NoSkillPayloadError(
      'LaunchDarkly has no Agent Skills payload for this environment (HTTP 422). This is what it answers until the ' +
        'first skill is created in this project, so delivery keeps asking and picks one up without a restart. If ' +
        'this environment does have skills, check that this SDK key belongs to it.',
    );
  }
  if ([405, 406, 414, 501].includes(status)) {
    return new FatalTransportError(
      `LaunchDarkly returned HTTP ${status}, which retrying will not fix. ${REQUEST_ADVICE}`,
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
 * Reads a whole poll body, holding no more than `limit` UTF-16 code units of it.
 *
 * Read in chunks rather than all at once so a body that is never going to be
 * accepted is abandoned as soon as it crosses the bound, instead of being
 * buffered whole by `response.text()` and measured after — which is no bound at
 * all, because by then the allocation has already happened.
 *
 * Deliberately does not touch the caller's {@link ReadDeadline}. In `'poll'`
 * mode that deadline bounds the whole request, body included; touching it per
 * read would silently turn it into the per-read gap that `'stream'` mode wants
 * and polling does not.
 */
async function readBoundedText(body: ReadableStream<Uint8Array>, limit: number): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (text.length > limit) {
        throw new RecoverableTransportError(
          `polling response exceeded the ${limit} character transport bound ` +
            `(at least ${text.length} received); nothing from it was applied`,
        );
      }
    }
    // Flushes a truncated multi-byte sequence at the very end of the body as
    // U+FFFD rather than dropping it, so a cut-short body fails in `JSON.parse`
    // as the malformed payload it is.
    return text + decoder.decode();
  } finally {
    // Same contract as `iterSse`: cancelling closes the connection underneath,
    // so a body abandoned at the bound does not leave a socket open behind the
    // retry. Best effort — the stream may already be errored or closed.
    reader.cancel().catch(() => {});
    try {
      reader.releaseLock();
    } catch {
      // Already released, or the stream errored. Nothing to recover.
    }
  }
}

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
 * The most the transport will hold in memory from one response, in UTF-16 code
 * units: one whole poll body, or one streamed event — the unterminated tail of
 * its current line plus its accumulated `data:` lines.
 *
 * A memory backstop, not a content limit. Verification caps each skill's content
 * at 10 MiB (`MAX_SKILL_CONTENT_BYTES`) in `skills-core`, and content rides
 * inline in the `put-object` envelope, so this bound has to sit *above* that one
 * or a legitimate large skill becomes undeliverable: the decoder would reject
 * it, the rejection is deterministic, and every retried connection would meet it
 * again until the failure budget ran out and delivery gave up for the process
 * lifetime. It is set far above any payload LaunchDarkly legitimately serves —
 * the two bound different things and move independently.
 *
 * What it is really for is the unbounded case: a server or proxy that never sends
 * a newline, one event whose data never ends, a poll body with no end in sight.
 * Each of those would otherwise grow memory without limit. Crossing the bound is
 * a recoverable transport failure, so the connection is dropped and retried and
 * nothing from the payload in flight is committed, rather than the store giving
 * up.
 *
 * The same number as Python's `MAX_RESPONSE_BYTES`, deliberately, so the two
 * SDKs document one bound. The units are not identical and cannot be: Python
 * counts bytes off the socket, this counts UTF-16 code units after decoding, so
 * non-ASCII content is measured slightly differently either side. Acceptable in
 * a backstop this far above real payloads; it would not be in a limit either SDK
 * enforced as a contract.
 */
export const MAX_RESPONSE_CHARS = 64 * 1024 * 1024;

/**
 * Decodes an SSE byte stream into `[event name, data]` pairs.
 *
 * Minimal on purpose — this consumes one LaunchDarkly endpoint, not the whole
 * spec: `event:`/`data:` fields, multi-line `data` joined with newlines, a blank
 * line dispatching, and `:` comments skipped. Bounded by
 * {@link MAX_RESPONSE_CHARS} per event.
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
  let dataChars = 0;

  // Two distinct quantities, deliberately not summed into one predicate. The
  // data already accumulated for the current event is bounded on its own; the
  // unterminated tail is bounded only once every complete line in the read has
  // been consumed, at which point the tail is the current event's next line and
  // adding the two is the honest measure of what one event holds. Summing them
  // mid-split would measure whole finished events still waiting to be parsed.
  const dataOverBound = (): boolean => dataChars > MAX_RESPONSE_CHARS;
  const tailOverBound = (): boolean => buffer.length + dataChars > MAX_RESPONSE_CHARS;

  // Every block that ends clears the buffered fields, whether or not it turns
  // into an event: a block with no `event:` field is the default `message`
  // event, which this endpoint never sends, so dropping it is right — but its
  // `data:` lines must not be left behind to corrupt the block that follows.
  const dispatch = (): [string, unknown] | null => {
    const eventName = name;
    const payload = dataLines.join('\n');
    name = null;
    dataLines = [];
    dataChars = 0;
    if (eventName === null) return null;
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
          else if (field === 'data') {
            dataLines.push(value2);
            dataChars += value2.length + 1;
            if (dataOverBound()) {
              throw new RecoverableTransportError(
                `the FDv2 stream sent more than ${MAX_RESPONSE_CHARS} characters of data for one event`,
              );
            }
          }
        }
        newline = buffer.indexOf('\n');
      }
      if (tailOverBound()) {
        throw new RecoverableTransportError(
          `the FDv2 stream sent more than ${MAX_RESPONSE_CHARS} characters without completing an event`,
        );
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
 * The only place this module opens a connection. Uses platform globals only, so
 * the content path adds no HTTP client dependency.
 *
 * `readTimeoutMs` is applied to every request through a {@link ReadDeadline}:
 * connecting, waiting for headers and each body read are all bounded by the
 * same value, and there is deliberately no separate connect timeout.
 */
export class FetchRequester implements Requester {
  /** Origin `GET /sdk/poll` is sent to. */
  readonly baseUri: string;
  /** Origin `GET /sdk/stream` is sent to. Defaults to `baseUri`. */
  readonly streamUri: string;

  constructor(
    private readonly sdkKey: string,
    baseUri: string,
    readonly readTimeoutMs: number,
    streamUri: string = baseUri,
  ) {
    this.baseUri = baseUri.replace(/\/+$/, '');
    this.streamUri = streamUri.replace(/\/+$/, '');
  }

  /**
   * The request URL: the path, the payload kind this store accepts, and `basis`
   * once a payload has committed.
   *
   * `kinds` is on every request, including the first one, because it selects
   * what the connection is served rather than describing what it already holds
   * (see {@link FDV2_PAYLOAD_KIND}).
   *
   * Deliberately no `mv` (data model version). That parameter selects the *flag*
   * data model; delivery overrides whatever a request asks for with the
   * payload's own default for any non-flagging payload, so sending it would
   * state a preference that is ignored.
   */
  private url(origin: string, path: string, basis: string | null): string {
    const params = new URLSearchParams({ kinds: FDV2_PAYLOAD_KIND });
    if (basis) params.set('basis', basis);
    return `${origin}${path}?${params.toString()}`;
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
      // `redirect: 'manual'`: a 3xx comes back as itself and is refused below,
      // rather than being followed with the SDK key attached.
      const response = await fetch(this.url(this.baseUri, POLL_PATH, basis), {
        headers,
        signal: deadline.signal,
        redirect: 'manual',
      });
      // A 304 is a current answer, not a redirect; it is settled before either
      // check below can see it.
      if (response.status === 304) return { notModified: true, events: [], etag };
      const redirect = refusedRedirect(response);
      if (redirect) throw redirect;
      if (!response.ok) throw classifyStatus(response.status, response.headers);
      // A 200 with no body at all is not a payload; `decodePollBody` rejects the
      // empty string as the malformed response it is, under the same recoverable
      // error as any other unusable body.
      const body = response.body === null ? '' : await readBoundedText(response.body, MAX_RESPONSE_CHARS);
      return {
        notModified: false,
        events: decodePollBody(body),
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
      response = await fetch(this.url(this.streamUri, STREAM_PATH, basis), {
        headers,
        signal: deadline.signal,
        redirect: 'manual',
      });
    } catch (cause) {
      deadline.clear();
      throw readFailure(cause, 'streaming request', deadline);
    }

    const redirect = refusedRedirect(response);
    if (redirect) {
      deadline.clear();
      throw redirect;
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
   * seconds. `'poll'` exists for environments that cannot hold a long-lived
   * connection, and a revocation there arrives within one `pollIntervalMs`.
   */
  readonly mode?: FDv2Mode;
  /**
   * Origin for `GET /sdk/poll`. Default {@link DEFAULT_BASE_URI}. When given
   * without `streamUri`, it is used for streaming too, which is what a relay or
   * private instance serving both endpoints from one host needs.
   *
   * Must be `https://`; the constructor throws otherwise, because every request
   * carries the server-side SDK key in `Authorization`. Plain `http://` is
   * accepted only for a loopback host (`localhost`, `127.0.0.1`, `::1`) serving
   * a local test double. Redirects from it are never followed.
   */
  readonly baseUri?: string;
  /**
   * Origin for `GET /sdk/stream`. Default {@link DEFAULT_STREAM_URI}, or
   * `baseUri` when that is given, since LaunchDarkly serves streaming from a
   * separate host but a relay or private instance usually does not.
   *
   * Held to the same rule as `baseUri`: `https://`, or plain `http://` to a
   * loopback host only, and redirects from it are never followed.
   */
  readonly streamUri?: string;
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
   * payload or a `none` intent resets the count, and a connection the server
   * closes normally after that is exempt, so a stream being recycled never
   * approaches the bound, as is the one request built from nothing after a
   * stale selector is refused. A connection closed before either — including
   * one that announced a transfer and dropped before committing it — is a
   * failure like any other, which is what bounds a server that does nothing
   * but close connections.
   */
  readonly maxConsecutiveFailures?: number;
  /** Replaces the built-in `fetch` transport. Intended for testing. */
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
 * **The SDK key goes only where it was pointed.** `baseUri` and `streamUri` must
 * each be `https://` — plain `http://` is refused except to a loopback host, for
 * local test doubles — and redirects are never followed, so a 3xx from a proxy
 * or a private instance is a fatal failure rather than a request carrying the
 * key to whatever host `Location` named.
 *
 * **Delivery is in the background; retrieval is not.** A background task owns
 * the connection and fills memory, and `getObject` only ever reads what has
 * already arrived. A process that calls `getSkill` immediately after `start()`
 * may see an empty store; `waitForSkills` orders boot against the first payload.
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
  /**
   * The basis the current `etag` was issued against.
   *
   * An ETag validates one representation of one resource, and the basis is part
   * of the request that names it. Holding the pair is what lets `pollOnce` tell
   * an etag that still answers the question it is about to ask from one that
   * answers a question it has stopped asking.
   */
  private etagBasis: string | null = null;
  private controller: AbortController | null = null;
  private loop: Promise<void> | null = null;
  private failedReason: string | null = null;
  // Set by `close`, and deliberately not folded into `failedReason`: closing is
  // the caller's own decision, not a delivery failure, so `failed` stays `null`.
  // It is what lets `waitForSkills` answer a closed store immediately and
  // `start` refuse to reopen one.
  private closed = false;
  private firstPayload = false;
  private readonly firstPayloadWaiters: Array<() => void> = [];
  // Recoverable failures in a row, cleared by a completed exchange with a
  // working server: a payload that committed, or a `none` intent. Not cleared
  // by a transfer intent that never commits, and not cleared when a connection
  // returns, because a stream never returns normally — it only ends by being
  // dropped, which is a failure, or by a goodbye, which is a failure only when
  // the connection saying it never completed an exchange.
  private failures = 0;
  // Whether the connection now open has completed an exchange with a working
  // server. Reset per attempt: it is what tells a stream being recycled from
  // one that says goodbye having delivered nothing, and only the former escapes
  // the bound.
  private reachedServer = false;
  // Said once per store rather than once per attempt: the condition holds until
  // somebody creates a skill, and delivery keeps asking throughout.
  private warnedNoSkillPayload = false;

  constructor(sdkKey: string, options: FDv2SkillStoreOptions = {}) {
    const key = requireServerSideCredential(sdkKey);
    this.mode = options.mode ?? 'stream';
    if (this.mode !== 'stream' && this.mode !== 'poll') {
      throw new Error(`mode must be 'stream' or 'poll', got ${JSON.stringify(options.mode)}`);
    }
    this.pollIntervalMs = options.pollIntervalMs ?? 30_000;
    // `NaN` passes a bare `<= 0` guard, and `setTimeout(fn, NaN)` fires at once.
    if (typeof this.pollIntervalMs !== 'number' || !Number.isFinite(this.pollIntervalMs) || this.pollIntervalMs <= 0) {
      throw new Error(`pollIntervalMs must be a positive, finite number, got ${String(options.pollIntervalMs)}`);
    }
    const readTimeoutMs =
      options.readTimeoutMs ?? (this.mode === 'stream' ? DEFAULT_STREAM_READ_TIMEOUT_MS : DEFAULT_POLL_TIMEOUT_MS);
    if (typeof readTimeoutMs !== 'number' || !Number.isFinite(readTimeoutMs) || readTimeoutMs <= 0) {
      throw new Error(`readTimeoutMs must be positive, got ${String(options.readTimeoutMs)}`);
    }
    this.initialBackoffMs = options.initialBackoffMs ?? 1_000;
    this.maxBackoffMs = options.maxBackoffMs ?? 30_000;
    this.maxConsecutiveFailures = options.maxConsecutiveFailures ?? 10;
    const baseUri = requireHttpsUri(options.baseUri ?? DEFAULT_BASE_URI);
    // A custom `baseUri` alone means one host serves both endpoints; only the
    // LaunchDarkly defaults split them.
    const streamUri = requireHttpsUri(
      options.streamUri ?? (options.baseUri === undefined ? DEFAULT_STREAM_URI : baseUri),
      'streamUri',
    );
    this.requester = options.requester ?? new FetchRequester(key, baseUri, readTimeoutMs, streamUri);
  }

  // -- lifecycle ---------------------------------------------------------

  /**
   * Starts delivery. Idempotent; returns `this` so it chains.
   *
   * Does not await: use `waitForSkills` when boot ordering matters.
   *
   * Throws once the store has been closed. `close` is final — a store is not a
   * connection to be reopened — and restarting delivery on one would produce a
   * store that looks live and is not, which is the failure this whole surface is
   * built to refuse. Construct a new store instead.
   */
  start(): this {
    if (this.closed) {
      throw new Error(
        'this FDv2SkillStore has been closed and cannot be restarted; construct a new FDv2SkillStore instead. ' +
          'A closed store still answers from the content it received, so retrieval needs no restart.',
      );
    }
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
   * Final, and one-way: `start` throws afterwards rather than opening a second
   * delivery loop. `failed` stays `null` — closing is not a failure — and
   * `waitForSkills` answers `false` at once rather than waiting out its timeout
   * for a payload that cannot arrive.
   *
   * Aborting the signal is what interrupts an open stream: the delivery task
   * spends its life awaiting a read, and a flag it never checks would leave a
   * healthy stream running until the process exited.
   */
  async close(): Promise<void> {
    this.closed = true;
    this.controller?.abort();
    const loop = this.loop;
    this.loop = null;
    this.releaseWaiters();
    if (loop) await loop;
  }

  /**
   * Resolves once the first payload has been committed, or sooner if delivery
   * stops for good, or after `timeoutMs`.
   *
   * `true` means a payload committed, or a 304 confirmed the payload already
   * held is the current one — not that any skill in it verified, and not that
   * the environment has any skills. `false` means the wait timed out, the store
   * was closed, or delivery stopped for good and no payload will arrive; see
   * `failed` to tell the last case from the others. Boot ordering is all this
   * answers; `diagnostics` answers the rest.
   *
   * Neither a closed store nor one whose delivery has stopped for good waits:
   * both answer immediately, whether the wait was already pending when it
   * happened or started afterwards. A store that did receive a payload still
   * answers `true` after close, matching what it will still serve.
   */
  waitForSkills(timeoutMs = 10_000): Promise<boolean> {
    if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs < 0) {
      // `setTimeout(fn, NaN)` fires at once, which would read as "timed out" —
      // a wrong answer rather than a wrong wait.
      return Promise.reject(
        new Error(`waitForSkills timeoutMs must be a non-negative, finite number, got ${String(timeoutMs)}`),
      );
    }
    if (this.firstPayload) return Promise.resolve(true);
    // A closed store, and delivery that has already stopped for good, both have
    // no payload left to wait for: answer now rather than after the timeout.
    if (this.closed || this.failedReason !== null) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const waiter = (): void => {
        clearTimeout(timer);
        resolve(this.firstPayload);
      };
      const timer = setTimeout(() => {
        // The timed-out waiter takes itself out of the list. Left in, every
        // expired wait would be retained for the lifetime of the store.
        this.dropWaiter(waiter);
        resolve(this.firstPayload);
      }, timeoutMs);
      (timer as unknown as { unref?: () => void }).unref?.();
      this.firstPayloadWaiters.push(waiter);
    });
  }

  private dropWaiter(waiter: () => void): void {
    const index = this.firstPayloadWaiters.indexOf(waiter);
    if (index !== -1) this.firstPayloadWaiters.splice(index, 1);
  }

  private releaseWaiters(): void {
    while (this.firstPayloadWaiters.length > 0) this.firstPayloadWaiters.pop()?.();
  }

  private markFirstPayload(): void {
    this.firstPayload = true;
    this.releaseWaiters();
  }

  /**
   * Whether a payload has arrived, so reads reflect delivery rather than an
   * empty store still waiting for its first one.
   *
   * The optional half of the `SkillStore` seam, and the same fact
   * `waitForSkills` resolves to — without the wait. `writeSkills('*')` consults
   * it so a reconcile that runs before delivery reports the retrieval
   * unavailable rather than pruning every managed skill as though the
   * environment had revoked it.
   *
   * Stays `true` once a payload has arrived, including after `close`: a closed
   * store still answers from what it received, and a later reconcile against
   * that content is a reconcile against real delivery.
   */
  isInitialized(): boolean {
    return this.firstPayload;
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
   * Registers `fn` to be called for each changed object, at commit.
   *
   * Fires **once per changed object at payload-transferred**, not as objects
   * stream in, so a listener never observes a half-applied transfer.
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
   *
   * Throws for any `kind` but `'skill'`. This store notifies skill changes and
   * nothing else — flag and segment objects on the same connection are skipped,
   * never dispatched — so accepting a listener on another kind would hand back a
   * watcher that silently never fires, which is indistinguishable from one whose
   * objects never changed.
   */
  addListener(kind: string, fn: (raw: RawSkillObject) => unknown): void {
    if (kind !== SKILL_OBJECT_KIND) {
      throw new Error(
        `FDv2SkillStore notifies only '${SKILL_OBJECT_KIND}' changes, so a listener on ${JSON.stringify(kind)} ` +
          `would never fire. Register it on '${SKILL_OBJECT_KIND}'.`,
      );
    }
    const existing = this.listeners.get(kind);
    if (existing) existing.push(fn);
    else this.listeners.set(kind, [fn]);
  }

  /**
   * Unregisters `fn` from `kind`. Safe to call from inside a listener: a removal
   * during one commit takes effect from the next.
   *
   * Removes one occurrence; removing a callable that is not registered is a
   * no-op, so `SkillWatcher.close` can detach unconditionally. Unlike
   * `addListener` this tolerates any `kind` — a kind that holds no listeners is
   * simply nothing to remove — so detaching never has to know which kind it
   * attached under.
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
    const report = (cause: unknown): void => {
      error(
        `A skill store change listener threw; delivery continues: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      );
    };
    for (const raw of changes) {
      for (const listener of listeners) {
        try {
          const result = listener(raw);
          // An `async` listener rejects later rather than throwing now. Caught
          // and logged the same way, so it cannot become an unhandled rejection
          // — which in Node is a process-level event, not a delivery one.
          if (result instanceof Promise) result.catch(report);
        } catch (cause) {
          report(cause);
        }
      }
    }
  }

  // -- the delivery loop -------------------------------------------------

  private async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        this.reachedServer = false;
        if (this.mode === 'stream') await this.streamOnce(signal);
        else await this.pollOnce(signal);
        // A return because the store is closing is not the server answering.
        if (signal.aborted) return;
        // A poll that returned is a current answer even when it committed
        // nothing (HTTP 304). A stream never returns normally; its successes
        // are counted in `apply`, at each `none` intent and each commit.
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
        let repairingState = false;
        if (cause instanceof StaleRequestStateError) {
          // The selector and etag are the only client state in the request, so
          // a rejection of a request carrying neither is the request itself
          // being refused, and retrying cannot fix it. Carrying one, the state
          // may be stale: drop it, ask for a full transfer, and let the next
          // 400 be the fatal one.
          if (this.basis === null && this.etag === null) {
            this.giveUp(cause.message);
            return;
          }
          this.basis = null;
          this.etag = null;
          this.etagBasis = null;
          repairingState = true;
        }
        if (cause instanceof NoSkillPayloadError) {
          this.reader.diagnostics.payloadUnavailable += 1;
          if (!this.warnedNoSkillPayload) {
            this.warnedNoSkillPayload = true;
            warn(
              `Skill delivery is idle: ${cause.message} Retrying every ${Math.round(this.maxBackoffMs)}ms; this is ` +
                'the only time it will be said.',
            );
          }
        }
        // A connection the server closed while serving it normally ended
        // without being a failure — see `dispatch` for which ones qualify. It
        // reconnects like one, but it neither counts against
        // `maxConsecutiveFailures` nor shows up in the diagnostics: every
        // recycle of an up-to-date stream arrives this way, so counting them
        // would expire an environment whose skills never change.
        if (!cause.expected) {
          this.failures += 1;
          this.reader.diagnostics.connectionFailures = this.failures;
          this.reader.diagnostics.lastError = cause.message;
          // The one request built from nothing after a stale selector is
          // refused is exempt from the bound, so an outage that has already
          // spent the budget cannot swallow the one repair available. It
          // cannot unbound the loop either: the repaired request carries no
          // state, so a second 400 is fatal on its own, and any other failure
          // after it meets a budget still over the bound.
          if (this.failures > this.maxConsecutiveFailures && !repairingState) {
            this.giveUp(`gave up after ${this.failures} consecutive failures; last error: ${cause.message}`);
            return;
          }
        }
        const requested = cause.retryAfterMs;
        const delay =
          cause instanceof NoSkillPayloadError
            ? // At the cap rather than on the backoff schedule: `failures`
              // deliberately never moves, so the schedule would hold this at
              // the *initial* delay forever.
              this.maxBackoffMs
            : Math.min(
                requested !== null && Number.isFinite(requested)
                  ? // A server asking for no delay still gets one: honouring
                    // `Retry-After: 0` literally would reconnect in a loop and burn
                    // the whole retry bound in milliseconds.
                    Math.max(requested, this.initialBackoffMs)
                  : backoffDelayMs(this.failures, this.initialBackoffMs, this.maxBackoffMs),
                // `Retry-After` is a request and `maxBackoffMs` is a promise.
                this.maxBackoffMs,
              );
        if (!cause.expected) {
          warn(`Skill delivery failed (${cause.message}); retrying in ${Math.round(delay)}ms`);
        }
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
    // making them eat the full timeout. They resolve `false`: nothing arrived.
    this.releaseWaiters();
  }

  private apply(name: string, data: unknown): TransferOutcome {
    const outcome = this.reader.handle(name, data);
    // A completed exchange breaks the row of consecutive failures. A reconnect
    // whose basis is already current is answered with the `none` intent and
    // commits nothing, so waiting for a commit alone would leave an unchanging
    // environment counting healthy connections against its bound — but an
    // `xfer-*` intent is only a promise, so it does not count until it commits.
    if (outcome.healthy || outcome.committed) this.reachedServer = true;
    if (outcome.healthy) this.recordSuccess();
    if (outcome.committed) {
      if (outcome.basis) this.basis = outcome.basis;
      this.recordSuccess();
      this.markFirstPayload();
      if (outcome.changes && outcome.changes.length > 0) this.notify(outcome.changes);
    }
    return outcome;
  }

  private dispatch(outcome: TransferOutcome): void {
    if (outcome.fatal) throw new FatalTransportError(outcome.fatal);
    if (outcome.disconnect) {
      // A goodbye is only a normal end of service for a connection that got
      // there: one that says goodbye without ever sending a `server-intent`
      // delivered nothing, and is retried as the failure it is, under the bound.
      // Exempting it would let a server that only ever says goodbye reconnect
      // without limit and without any of it reaching `diagnostics` or `failed`.
      const expected = outcome.expected === true && this.reachedServer;
      throw new RecoverableTransportError(outcome.disconnect, null, expected);
    }
  }

  private async pollOnce(signal: AbortSignal): Promise<void> {
    const basis = this.basis;
    // Only while the pair still holds. The basis is part of the request, so an
    // etag issued before the basis moved validates a payload we have stopped
    // asking for, and a server that answered it `304` would be answering the
    // previous question. One unconditional request after each commit is the
    // whole cost: a payload that changed was never going to be a 304 anyway.
    const etag = this.etagBasis === basis ? this.etag : null;
    const result = await this.requester.poll(basis, etag, signal);
    if (result.notModified) {
      // A 304 is a successful, current answer: the payload we hold is the payload
      // the server has, because the etag that asked for it was issued for a body
      // this store applied in full. It counts as a first payload so a boot that
      // reconnects with a cached basis is not blocked on a transfer the server
      // has no reason to send.
      this.markFirstPayload();
      return;
    }
    for (const [name, data] of result.events) {
      this.dispatch(this.apply(name, data));
    }
    // Adopted only once the whole body has been applied. A body that threw
    // partway — an `error` or `goodbye` after an announced transfer — left the
    // payload it described unapplied, and keeping its etag would let the next
    // `304` report a store that is missing that payload as current and healthy.
    this.etag = result.etag;
    this.etagBasis = basis;
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
