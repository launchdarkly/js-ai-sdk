/**
 * Agent Skills — the FDv2 delivery transport.
 *
 * `FDv2SkillStore` is the `SkillStore` that receives skills from LaunchDarkly
 * over `GET /sdk/poll` or `GET /sdk/stream`, authenticated with the
 * environment's server-side SDK key. It holds raw wire objects and serves them to
 * the accessors; it uses only platform globals (`fetch`, `AbortController`,
 * `TextDecoder`).
 *
 * What it does not do:
 *
 * - **Verify content.** Integrity verification happens at the accessor boundary,
 *   so it applies to every store, including one you supply yourself.
 * - **Work around a missing `contentHash`.** Such an object is held as-is and
 *   then withheld by verification with `missing_content_hash`; the store logs an
 *   error and counts it in {@link StoreDiagnostics.hashlessObjects}.
 * - **Evaluate flags.** Non-skill objects are skipped and counted.
 */

import { SKILL_OBJECT_KIND } from './skills-core.js';
import type { RawSkillObject, SkillStore } from './types.js';
import { isValidSkillVersion } from './types.js';

// ---------------------------------------------------------------------------
// The wire contract
// ---------------------------------------------------------------------------

/**
 * The FDv2 object `kind` of a skill (exact, lower-case match).
 *
 * Distinct from {@link FDV2_PAYLOAD_KIND}, the kind of the payload skills arrive in.
 */
export const FDV2_OBJECT_KIND = 'skill';

/**
 * The FDv2 payload kind declared on every request as `?kinds=`.
 *
 * Required: a request without it is served the flag payload and no skills.
 */
export const FDV2_PAYLOAD_KIND = 'agent-skill';

/**
 * Separates key from version in a skill object's wire `key`
 * (`<key>:<version>`). Each version of a skill is a separate object.
 */
export const FDV2_KEY_DELIMITER = ':';

/**
 * Where `GET /sdk/poll` is served. Override for Federal, private, or relay
 * deployments.
 */
export const SKILLS_DEFAULT_BASE_URI = 'https://sdk.launchdarkly.com';

/**
 * Where `GET /sdk/stream` is served. LaunchDarkly streams from a different host
 * than it polls from; a `baseUri` given without a `streamUri` is used for both.
 */
export const SKILLS_DEFAULT_STREAM_URI = 'https://stream.launchdarkly.com';

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
 * Envelope fields copied verbatim. Never coerced or defaulted: filling in a
 * missing field would forge what verification checks.
 */
const ENVELOPE_FIELDS = ['contentType', 'content', 'contentHash', 'name', 'description'] as const;

/**
 * The payload id inside a transfer's selector, `(p:<id>:<version>)`. Used when
 * the intent named no `id`.
 */
const PAYLOAD_SELECTOR = /\(p:([^:()]+):\d+\)/;

export type FDv2Mode = 'stream' | 'poll';

const MOBILE_KEY_PREFIX = 'mob-';
const SERVER_KEY_PREFIX = 'sdk-';

/** A client-side environment ID: unprefixed lowercase hex. */
const CLIENT_SIDE_ID = /^[0-9a-f]{20,}$/;

function debug(message: string): void {
  // biome-ignore lint/suspicious/noConsole: this package has no logger abstraction; routine events log at debug
  console.debug(`[LaunchDarkly] ${message}`);
}

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
 * Throws for a missing key, a mobile key, or a client-side environment ID;
 * returns the key trimmed.
 *
 * Skill content is confidential, and the server may not refuse a client-side
 * credential itself, so the SDK does.
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
    // Warn only: private instances and test doubles may use unprefixed keys.
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
 * Throws for a URI that would send the SDK key in cleartext; returns it trimmed.
 *
 * Requires `https://` with a host; plain `http://` is allowed only to a loopback
 * host (`localhost`, `127.0.0.1`, `::1`) for local test doubles. Applies even
 * when a custom `requester` is supplied.
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
  // WHATWG `hostname` keeps the brackets on an IPv6 literal; strip them.
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
// Diagnostics
// ---------------------------------------------------------------------------

/**
 * Counters describing what the transport has seen. Read-only.
 *
 * Useful for telling "this environment has no skills" apart from "every skill
 * was withheld".
 */
export type StoreDiagnostics = {
  /** Completed `payload-transferred` commits since the store started. */
  readonly payloadsTransferred: number;
  /** `put-object` events identified as skills, across all payloads. */
  readonly skillObjectsReceived: number;
  /** Objects skipped because they were not skills. */
  readonly objectsIgnored: number;
  /**
   * Skill revocations: each `delete-object` that removed something, plus each
   * key a full transfer dropped entirely (not a key whose version moved).
   */
  readonly objectsRevoked: number;
  /**
   * Transfers not applied because they completed a payload other than the
   * skill payload. Normally zero.
   */
  readonly payloadsIgnored: number;
  /**
   * Skill objects whose envelope carried no `contentHash`.
   *
   * **Nonzero means skills are being withheld** with `missing_content_hash`.
   * Cumulative: read it as "this has happened", not as the current count.
   */
  readonly hashlessObjects: number;
  /**
   * Recoverable transport failures in a row; reset by a completed exchange (a
   * commit or a `none` intent). A server-initiated `goodbye` after such an
   * exchange is not counted.
   */
  readonly connectionFailures: number;
  /** The most recent transport error, if any. Human-readable; do not parse. */
  readonly lastError: string | null;
};

const HASHLESS_ADVICE =
  "The delivered skill object carries no 'contentHash', so integrity verification withholds it with reason_code " +
  "'missing_content_hash' and its content will not resolve. Contact LaunchDarkly support.";

/**
 * Ceiling on remembered hashless reports (oldest evicted first). An evicted
 * object may be reported again.
 */
const HASHLESS_MEMORY_LIMIT = 512;

/** Distinguishes the store-wide summary's entry from a per-object one. */
const SUMMARY_MARKER = '\u0000summary\u0000';

/**
 * Which hashless objects (and which store-wide summary) one reader has already
 * logged. Per store, so a re-delivered payload is not re-reported and each
 * store reports independently.
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
   * One error per `(key, version)` whose envelope had no `contentHash`, so
   * withheld skills are not mistaken for an environment with none.
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
   * One error per distinct committed state in which *nothing* held can verify.
   *
   * Fires at delivery time, so it shows even in a process that never reads a
   * skill. Repeated only when the set of hashless objects changes, or after a
   * recovery and relapse.
   */
  warnIfNothingCanVerify(held: RawSkillObject[]): void {
    const hashless = held.filter((raw) => typeof raw.contentHash !== 'string');
    if (hashless.length === 0) {
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
// Deserialization
// ---------------------------------------------------------------------------

/** A `delete-object` narrowed to the identity it revokes. */
export type Tombstone = { readonly key: string; readonly objectVersion: number | null };

/**
 * Whether one `put-object` / `delete-object` payload is a skill.
 *
 * Other kinds are ignored rather than rejected, so an unrecognised kind cannot
 * cause a reconnect loop.
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
 * Splits `<key>:<version>` from one object's wire `key`.
 *
 * Malformed versions are kept so verification can report them under a
 * recognisable key:
 *
 * - No delimiter: no version; verification reports `invalid_version`.
 * - Non-digit version (`"pdf:latest"`, `"pdf:"`, `"a:1:2"`): the text is kept
 *   as the version.
 * - Empty key (`":3"`): `null`; the object is dropped.
 *
 * Leading zeros are accepted (`"pdf:03"` is version 3).
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
 * Translates one FDv2 skill `put-object` into a raw `SkillStore` object.
 *
 * ```
 * wire `key`      →  stored `key` and `version`  (split on `:`)
 * wire `version`  →  dropped                     (the *payload* version)
 * ```
 *
 * The event's `version` is the payload's version, not the skill's; using it
 * would serve content under a meaningless version number.
 *
 * Returns `null` only when the wire `key` has no skill key. Other defects are
 * carried through so verification withholds them with a reason code.
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

  // Absent or malformed versions pass through for verification to report.
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
 * Narrows one FDv2 skill `delete-object` to the identity it revokes.
 *
 * A delete with no usable version (`objectVersion: null`) revokes every version
 * of the key, including a version-less malformed entry. Erring this way avoids
 * serving withdrawn content.
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
 * Several versions of a key can coexist (the newest plus any pinned by a
 * variation). An object with no usable version is held under its key alone so
 * verification can withhold it with a reason.
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
   * A `null` version removes every version of the key.
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
   * When only a version-less entry exists it is served so verification can
   * report it. A pin that misses while valid versions exist is a plain miss.
   */
  get(key: string, version: number | null): RawSkillObject | null {
    const held = this.versions.get(key);
    if (!held || held.size === 0) return this.loose.get(key) ?? null;
    if (version !== null) return held.get(version) ?? null;
    return held.get(Math.max(...held.keys())) ?? null;
  }

  /**
   * One entry per skill key, at its newest version, keyed by the bare skill key
   * (never `key:version`: `writeSkills('*')` prunes by these keys). Use `allRaw`
   * for every held `(key, version)`.
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

  /** Every object held, one per `(key, version)`. */
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
   * A `none` intent: the content held is current. Counts as a healthy exchange
   * though it commits nothing, like a 304 to a poll.
   */
  healthy?: boolean;
  /**
   * Set on a non-catastrophic `goodbye`. Still a disconnect; the caller decides
   * whether it counts as a failure.
   */
  expected?: boolean;
};

/** One object's comparable `(key, version)`; an unusable version is empty. */
function identityOf(raw: RawSkillObject): string {
  return `${String(raw.key)}\u0000${isValidSkillVersion(raw.version) ? raw.version : ''}`;
}

/**
 * Tombstones for every `(key, version)` `next` no longer holds.
 *
 * A full transfer revokes by omission; this recovers those revocations. A key
 * whose version moved yields a put for the new version and a tombstone for the
 * old one.
 */
function revocationsBetween(current: SkillObjectSet, next: SkillObjectSet): RawSkillObject[] {
  const surviving = new Set(next.allRaw().map(identityOf));
  return current
    .allRaw()
    .filter((raw) => !surviving.has(identityOf(raw)))
    .map((raw) => ({ key: raw.key, version: isValidSkillVersion(raw.version) ? raw.version : null }));
}

/**
 * How many keys in `revoked` left the payload entirely (not version moves).
 *
 * This is what `objectsRevoked` counts; `changes` carries every tombstone.
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
    lastError: null,
  };
}

/**
 * Applies FDv2 events to an object set. Pure: no sockets, timers, or clock.
 *
 * - **Changes commit at `payload-transferred`**, never half-applied, so a full
 *   transfer never briefly empties the store and listeners fire only at commit.
 * - **Only the first payload intent is read**, as the protocol requires, and it
 *   is taken to be the skill payload. The reader learns which payload carries
 *   skills and declines transfers of any other, which would otherwise empty the
 *   skill set.
 */
export class ProtocolReader {
  readonly diagnostics = freshDiagnostics();
  private readonly hashless = new HashlessMemory();
  /** What this reader has reported hashless. Exposed for tests; not API. */
  readonly _warnedHashless: Set<string> = this.hashless.seen;
  private intent: string | null = null;
  // Reset per `server-intent`: one warning per announcement.
  private warnedUnknownIntent = false;
  private pending: SkillObjectSet | null = null;
  private changes: RawSkillObject[] = [];
  // The payload the current intent describes, and the one skills arrive on;
  // kept apart so a transfer of another payload can be declined.
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
      // Built beside the live set so an interrupted transfer keeps it.
      this.pending = new SkillObjectSet();
    } else if (intent === INTENT_TRANSFER_CHANGES) {
      this.pending = this.committed.copy();
    } else if (intent === INTENT_TRANSFER_NONE) {
      // The basis is current, and later edits on this connection arrive as
      // objects with no second intent: read on as a delta with nothing pending.
      this.intent = INTENT_TRANSFER_CHANGES;
      this.pending = null;
    } else {
      // Unknown intent codes are ignored; guessing could empty the store.
      this.pending = null;
    }
    // Only `none` is a completed exchange; a transfer intent is not health
    // until it commits.
    return { healthy: intent === INTENT_TRANSFER_NONE };
  }

  private target(): SkillObjectSet | null {
    if (this.pending === null && (this.intent === INTENT_TRANSFER_FULL || this.intent === INTENT_TRANSFER_CHANGES)) {
      // An object with no preceding server-intent is treated as a delta.
      this.pending = this.committed.copy();
    }
    return this.pending;
  }

  /**
   * Drops a skill object that arrived under an intent this reader cannot apply
   * (an unknown code). Counted under `objectsIgnored`, with one
   * warning per intent.
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
    // Counted only if it removed something; listeners see it either way.
    if (target.delete(tombstone).length > 0) this.diagnostics.objectsRevoked += 1;
    // A revocation identifies the skill payload just as a put does.
    this.skillsInPayload += 1;
    this.changes.push({ key: tombstone.key, version: tombstone.objectVersion });
    return {};
  }

  private payloadTransferred(data: unknown): TransferOutcome {
    const state = (data as { state?: unknown } | null)?.state;
    const payloadId = this.intentPayloadId ?? payloadIdFromSelector(state);
    // Checked even with no pending set (a `none` intent), so a foreign payload's
    // selector never becomes the resume point.
    const foreign = this.isForeignPayload(payloadId);
    // Nothing is applied without a pending set — a `none` intent no object
    // followed, or an intent code this SDK does not recognise — and a foreign
    // payload's contents are declined below.
    const applied = !foreign && this.pending !== null;
    if (foreign) {
      this.warnForeignPayload(payloadId);
      this.diagnostics.payloadsIgnored += 1;
      this.changes = [];
    } else if (this.pending !== null) {
      // A full transfer revokes by omission. Diff before the swap so those
      // departures reach listeners as tombstones.
      if (this.intent === INTENT_TRANSFER_FULL) {
        const revoked = revocationsBetween(this.committed, this.pending);
        this.changes.push(...revoked);
        this.diagnostics.objectsRevoked += keysFullyRevoked(revoked, this.pending);
      }
      this.committed.replaceWith(this.pending);
      this.hashless.warnIfNothingCanVerify(this.committed.allRaw());
      if (this.skillsInPayload > 0 && payloadId !== null) {
        // The payload that carried a skill put or delete is the skill payload.
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
    if (!applied) {
      // Nothing applied, so nothing to report — and in particular not a commit,
      // because a commit publishes the first payload, and `isInitialized()` (what
      // `writeSkills('*')` authorizes a prune on) must not go true over a store
      // that received nothing. Not up to date either: only the `none` intent says
      // that, on its own event. The selector is withheld too — it names a payload
      // never applied.
      return { changes: [], basis: null };
    }
    return {
      committed: true,
      changes,
      basis: typeof state !== 'string' || state === '' ? null : state,
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
    // Debug only: a goodbye after a completed exchange is a routine recycle, and
    // the reader cannot tell. The delivery loop warns for one that counts.
    if (parsed.silent !== true) {
      debug(`FDv2 connection closing: ${String(parsed.reason)}`);
    }
    if (parsed.catastrophe === true) {
      return { fatal: `server sent a catastrophic goodbye: ${String(parsed.reason)}` };
    }
    // How the server recycles a long-lived stream.
    return { disconnect: `server said goodbye: ${String(parsed.reason)}`, expected: true };
  }

  // -- payload identity ----------------------------------------------------

  /**
   * Whether a transfer completes a payload other than the skill payload.
   * `false` unless both payload ids are known.
   */
  private isForeignPayload(payloadId: string | null): boolean {
    return this.skillPayloadId !== null && payloadId !== null && payloadId !== this.skillPayloadId;
  }

  /**
   * One warning per reader for an intent describing more than one payload: the
   * first is then not guaranteed to be the skill payload.
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
    /**
     * A `goodbye` after a completed exchange: retried, but not logged as a
     * failure or counted in `connectionFailures`.
     */
    readonly expected = false,
  ) {
    super(message);
  }
}

/**
 * An HTTP 400. If the request carried client state (`basis` or an
 * `If-None-Match` etag), that state is dropped and a full transfer requested
 * once; a 400 for a request with no state is fatal.
 */
export class StaleRequestStateError extends RecoverableTransportError {}

const REQUEST_ADVICE =
  'The request this adapter sent was not understood. It carries only the SDK key, a ' +
  "'kinds' parameter declaring the skill payload, and, after the first payload, a 'basis' selector, so check " +
  'the base URI and that the endpoint speaks FDv2.';

const FORBIDDEN_ADVICE =
  'The FDv2 protocol is opt-in per LaunchDarkly account and is served as HTTP 403 while it is off. Skill ' +
  'delivery needs it enabled; contact LaunchDarkly support to enable it for your account.';

/**
 * `Retry-After` in milliseconds, or `null` when absent or unusable (blank, the
 * HTTP-date form, or a non-finite number), in which case normal backoff applies.
 */
export function retryAfterMs(headers: Headers | null | undefined): number | null {
  const raw = headers?.get('Retry-After');
  if (raw === null || raw === undefined) return null;
  const value = raw.trim();
  // `Number('')` is 0, so a blank header would otherwise read as no delay.
  if (value === '') return null;
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) return null;
  return Math.max(0, seconds * 1000);
}

/**
 * The fatal error for a 3xx. Requests use `redirect: 'manual'` because following
 * a redirect would forward the `Authorization` header (the SDK key) to whatever
 * host `Location` names. The FDv2 endpoints never redirect.
 */
function redirectRefused(status: string): FatalTransportError {
  return new FatalTransportError(
    `LaunchDarkly returned ${status}, a redirect. Redirects are not followed, so the SDK key is never forwarded to a ` +
      'host other than the base URI. The SDK-facing FDv2 endpoints do not redirect; check the base URI, and any proxy ' +
      'in between, for the address being redirected to.',
  );
}

/**
 * The error for a redirect response (including an `opaqueredirect`), or `null`
 * when the response is not a redirect.
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
    // Typically a mistyped base URI; retrying will not help.
    return new FatalTransportError(
      'LaunchDarkly returned HTTP 404 for the FDv2 endpoint. Check the base URI, and that this instance serves ' +
        '/sdk/poll and /sdk/stream.',
    );
  }
  // The selector sent may be stale: recoverable once (see `StaleRequestStateError`).
  if (status === 400) return new StaleRequestStateError(`LaunchDarkly returned HTTP 400. ${REQUEST_ADVICE}`);

  // No payload matching the declared kinds is available on this connection,
  // most often because of a view-scoped SDK key. Fatal.
  if (status === 422) {
    return new FatalTransportError(
      'LaunchDarkly will not deliver Agent Skills on this connection (HTTP 422). The usual cause is a view-scoped ' +
        'SDK key. Check your SDK key or contact LaunchDarkly support.',
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
 * Reads a whole poll body in chunks, abandoning it as soon as it exceeds `limit`
 * UTF-16 code units (fatal; see {@link MAX_RESPONSE_CHARS}).
 *
 * Does not touch the {@link ReadDeadline}, so in `'poll'` mode the timeout
 * bounds the whole request.
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
        throw new FatalTransportError(
          `polling response exceeded the ${limit} character transport bound ` +
            `(at least ${text.length} received); nothing from it was applied. ${OVERSIZED_ADVICE}`,
        );
      }
    }
    // Flush a truncated trailing sequence as U+FFFD so `JSON.parse` rejects it.
    return text + decoder.decode();
  } finally {
    // Close the connection so an abandoned body leaves no socket open.
    reader.cancel().catch(() => {});
    try {
      reader.releaseLock();
    } catch {
      // Already released, or the stream errored. Nothing to recover.
    }
  }
}

/**
 * Unwraps `{"events": [...]}`. Poll and stream events are identical, so both
 * modes share one protocol reader.
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
 * The one network timeout: untouched in `'poll'` mode (bounds the whole
 * request), touched per read in `'stream'` mode (bounds the gap between reads).
 * `expired` distinguishes a timeout from the store closing.
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
    // Unreffed so the timer never keeps the process alive.
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
 * Wraps a failed request or read as `RecoverableTransportError`, unless the store
 * is closing (the abort passes through). The delivery loop treats other errors
 * as bugs and stops.
 */
function readFailure(cause: unknown, what: string, deadline: ReadDeadline | undefined): unknown {
  if (deadline?.parent.aborted) return cause;
  if (deadline?.expired) return new RecoverableTransportError(`${what} timed out: no bytes in ${deadline.ms}ms`);
  return new RecoverableTransportError(`${what} failed: ${cause instanceof Error ? cause.message : String(cause)}`);
}

/**
 * The most the transport holds in memory from one poll body or one streamed
 * event, in UTF-16 code units.
 *
 * A memory backstop set far above any real payload, separate from the per-skill
 * content limit verification enforces. Crossing it is fatal, like a 422: nothing
 * is applied and the store keeps its current content, but delivery stops. The
 * payload's size belongs to the environment, not the connection, so a retry
 * would download up to this much again on every backoff step and be refused the
 * same way.
 */
export const MAX_RESPONSE_CHARS = 64 * 1024 * 1024;

const OVERSIZED_ADVICE =
  'The payload is larger than this SDK will hold in memory, and a retry would be refused the same way. Contact ' +
  'LaunchDarkly support.';

/**
 * Decodes an SSE byte stream into `[event name, data]` pairs.
 *
 * Minimal: `event:`/`data:` fields, multi-line `data` joined with newlines,
 * blank line dispatches, `:` comments skipped. An event over
 * {@link MAX_RESPONSE_CHARS} throws a fatal error. An event whose data is not
 * JSON throws a recoverable one, ending the connection. Only read failures are
 * wrapped; errors thrown by the consumer pass through unchanged.
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

  // Checked separately: the tail is only added to the event's data once every
  // complete line in the buffer has been consumed.
  const dataOverBound = (): boolean => dataChars > MAX_RESPONSE_CHARS;
  const tailOverBound = (): boolean => buffer.length + dataChars > MAX_RESPONSE_CHARS;

  // Clears the buffered fields at every block end. A block with no `event:`
  // field is dropped. Data that is not JSON ends the connection rather than
  // being skipped: the `payload-transferred` after it would otherwise commit
  // the transfer without it and advance the basis past it, so a lost
  // `delete-object` would never be sent again. The reconnect resumes from the
  // last committed basis, as the base SDK's `PayloadStreamReader` does.
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
      throw new RecoverableTransportError(
        `the FDv2 stream sent a '${eventName}' event whose data was not JSON; the payload in flight was abandoned`,
      );
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
              throw new FatalTransportError(
                `the FDv2 stream sent more than ${MAX_RESPONSE_CHARS} characters of data for one event; ` +
                  `nothing from it was applied. ${OVERSIZED_ADVICE}`,
              );
            }
          }
        }
        newline = buffer.indexOf('\n');
      }
      if (tailOverBound()) {
        throw new FatalTransportError(
          `the FDv2 stream sent more than ${MAX_RESPONSE_CHARS} characters without completing an event; ` +
            `nothing from it was applied. ${OVERSIZED_ADVICE}`,
        );
      }
    }
  } finally {
    deadline?.clear();
    // Close the connection so a consumer that stops early leaves no socket open.
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
 * `readTimeoutMs` bounds every request through a {@link ReadDeadline} (connect,
 * headers, body); there is no separate connect timeout.
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
   * The request URL: `?kinds=` on every request (see {@link FDV2_PAYLOAD_KIND}),
   * plus `basis` once a payload has committed.
   *
   * No `mv` parameter: it selects the flag data model and does not apply to
   * skills.
   */
  private url(origin: string, path: string, basis: string | null): string {
    const params = new URLSearchParams({ kinds: FDV2_PAYLOAD_KIND });
    if (basis) params.set('basis', basis);
    return `${origin}${path}?${params.toString()}`;
  }

  /** One `GET /sdk/poll`. A 304 is a first-class outcome, not an error. */
  async poll(basis: string | null, etag: string | null, signal: AbortSignal): Promise<PollResult> {
    const headers: Record<string, string> = { Authorization: this.sdkKey, Accept: 'application/json' };
    if (etag) headers['If-None-Match'] = etag;

    // Never touched, so it bounds the whole request.
    const deadline = readDeadline(signal, this.readTimeoutMs);
    try {
      const response = await fetch(this.url(this.baseUri, POLL_PATH, basis), {
        headers,
        signal: deadline.signal,
        redirect: 'manual',
      });
      // Handled before the redirect check: a 304 means "unchanged".
      if (response.status === 304) return { notModified: true, events: [], etag };
      const redirect = refusedRedirect(response);
      if (redirect) throw redirect;
      if (!response.ok) throw classifyStatus(response.status, response.headers);
      // An empty body fails in `decodePollBody` as a recoverable error.
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

    // Bounds the connect, then (touched by `iterSse`) the gap between reads.
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
 * Exponential backoff with jitter, capped at `maximumMs`.
 *
 * Jitter is subtracted, never added, so `maximumMs` is a true ceiling.
 */
export function backoffDelayMs(attempt: number, baseMs: number, maximumMs: number, jitter = 0.5): number {
  // Retries are unbounded, so the attempt number is too. Clamped so the power
  // stays finite; 2^30 of any base passes any cap. The constructor refuses a
  // non-positive base, so a zero delay never comes out of here.
  const exponent = Math.min(Math.max(0, attempt - 1), 30);
  const ceiling = Math.min(maximumMs, baseMs * 2 ** exponent);
  return ceiling * (1 - jitter * Math.random());
}

/**
 * How long a stream must stay open for the reconnect after it to start again at
 * `initialBackoffMs`, as in the base server-side SDKs. Internal, not an option.
 */
export const BACKOFF_RESET_INTERVAL_MS = 60_000;

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
    // Unreffed so a pending backoff never keeps the process alive.
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
   * `'stream'` (default, recommended: revocations arrive in seconds) or
   * `'poll'` (revocations arrive within one `pollIntervalMs`).
   */
  readonly mode?: FDv2Mode;
  /**
   * Origin for `GET /sdk/poll` (default {@link SKILLS_DEFAULT_BASE_URI}). Given without
   * `streamUri`, it is used for streaming too (relays and private instances).
   *
   * Must be `https://`; `http://` is accepted only for `localhost`, `127.0.0.1`
   * or `::1`. The constructor throws otherwise.
   */
  readonly baseUri?: string;
  /**
   * Origin for `GET /sdk/stream` (default {@link SKILLS_DEFAULT_STREAM_URI}, or
   * `baseUri` when that is given). Same `https://` rule as `baseUri`.
   */
  readonly streamUri?: string;
  /** Milliseconds between polls; positive and finite. Default `30_000`. */
  readonly pollIntervalMs?: number;
  /**
   * The only network timeout, in milliseconds; positive and finite. In `'poll'`
   * mode it bounds the whole request ({@link DEFAULT_POLL_TIMEOUT_MS}); in
   * `'stream'` mode, each wait for more bytes
   * ({@link DEFAULT_STREAM_READ_TIMEOUT_MS}).
   */
  readonly readTimeoutMs?: number;
  /**
   * The first retry delay, in milliseconds; positive, finite, and no greater
   * than `maxBackoffMs`. Default `1_000`.
   */
  readonly initialBackoffMs?: number;
  /**
   * Caps every retry delay, including `Retry-After`; positive and finite.
   * Default `30_000`. Recoverable failures are retried for the life of the
   * store; only a fatal status stops delivery.
   */
  readonly maxBackoffMs?: number;
  /** Replaces the built-in `fetch` transport. Intended for testing. */
  readonly requester?: Requester;
};

/**
 * A `SkillStore` fed by LaunchDarkly's SDK-facing FDv2 delivery channel.
 *
 * Constructed with the environment's server-side SDK key, started explicitly,
 * and passed to `setSkillStore`:
 *
 * ```ts
 * const store = new FDv2SkillStore(process.env.LD_SDK_KEY!).start();
 * await store.waitForSkills(10_000);
 * setSkillStore(store);
 *
 * const skill = await getSkill('pdf-extraction');
 * // ...
 * await store.close();
 * ```
 *
 * - **Server-side only.** A mobile key or client-side environment ID throws.
 * - **The SDK key stays where you point it.** URIs must be `https://` (`http://`
 *   only to loopback) and redirects are never followed.
 * - **Delivery runs in the background.** `getObject` reads only what has
 *   arrived. Use `waitForSkills` or `isInitialized` before relying on content.
 * - **Last known good survives an outage.** A transport failure never empties
 *   the store or makes `getObject` throw; `diagnostics` and `failed` report it.
 * - **`close` is final.** A closed store still serves what it received, but
 *   `start` throws; construct a new store instead.
 * - **Content is verified by the accessors, not here.** An object with no
 *   `contentHash` is held and then withheld; see
 *   {@link StoreDiagnostics.hashlessObjects}.
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

  private basis: string | null = null;
  private etag: string | null = null;
  /** The basis `etag` was issued for; the etag is only sent with it. */
  private etagBasis: string | null = null;
  private controller: AbortController | null = null;
  private loop: Promise<void> | null = null;
  private failedReason: string | null = null;
  // Set by `close`. Separate from `failedReason`: closing is not a failure.
  private closed = false;
  private firstPayload = false;
  private readonly firstPayloadWaiters: Array<() => void> = [];
  // Recoverable failures in a row; reset by a completed exchange, not by a
  // connection ending (a stream only ends by being dropped or a goodbye).
  private failures = 0;
  // Whether the current attempt completed an exchange, which separates a
  // recycled healthy stream from a failed one.
  private reachedServer = false;
  // The backoff step, kept apart from `failures`: a completed exchange does not
  // reset it, or a server that answers and then drops would be reconnected at
  // `initialBackoffMs` for as long as it stayed degraded. It resets after a
  // stream outlives `_backoffResetIntervalMs`, or a completed poll.
  private backoffAttempt = 0;
  // When the current stream connection opened (`performance.now()`), or `null`
  // before it has.
  private connectedAt: number | null = null;
  /** {@link BACKOFF_RESET_INTERVAL_MS}. Exposed for tests; not API. */
  _backoffResetIntervalMs = BACKOFF_RESET_INTERVAL_MS;

  constructor(sdkKey: string, options: FDv2SkillStoreOptions = {}) {
    const key = requireServerSideCredential(sdkKey);
    this.mode = options.mode ?? 'stream';
    if (this.mode !== 'stream' && this.mode !== 'poll') {
      throw new Error(`mode must be 'stream' or 'poll', got ${JSON.stringify(options.mode)}`);
    }
    this.pollIntervalMs = options.pollIntervalMs ?? 30_000;
    // `NaN` passes a `<= 0` check, and `setTimeout(fn, NaN)` fires at once.
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
    // With no failure bound these two are the only limit on the retry loop: a
    // zero, negative or `NaN` delay is no wait at all, against a failing server.
    for (const [name, value] of [
      ['initialBackoffMs', this.initialBackoffMs],
      ['maxBackoffMs', this.maxBackoffMs],
    ] as const) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        throw new Error(`${name} must be a positive, finite number, got ${String(value)}`);
      }
    }
    if (this.initialBackoffMs > this.maxBackoffMs) {
      throw new Error(
        `initialBackoffMs (${this.initialBackoffMs}) must not exceed maxBackoffMs (${this.maxBackoffMs})`,
      );
    }
    const baseUri = requireHttpsUri(options.baseUri ?? SKILLS_DEFAULT_BASE_URI);
    // A lone `baseUri` serves both endpoints.
    const streamUri = requireHttpsUri(
      options.streamUri ?? (options.baseUri === undefined ? SKILLS_DEFAULT_STREAM_URI : baseUri),
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
   * Throws if the store has been closed. A store whose delivery stopped on its
   * own (`failed` is set) can be started again, with its failure count and
   * backoff started over.
   */
  start(): this {
    if (this.closed) {
      throw new Error(
        'this FDv2SkillStore has been closed and cannot be restarted; construct a new FDv2SkillStore instead. ' +
          'A closed store still answers from the content it received, so retrieval needs no restart.',
      );
    }
    if (this.loop !== null && this.failedReason === null) return this;
    // A loop that gave up has already returned, so a new one cannot overlap it.
    this.failedReason = null;
    this.failures = 0;
    this.reader.diagnostics.connectionFailures = 0;
    this.backoffAttempt = 0;
    this.controller = new AbortController();
    this.loop = this.run(this.controller.signal);
    return this;
  }

  /**
   * Stops delivery and resolves once the delivery loop has exited. Idempotent.
   *
   * **Final:** `start` throws afterwards; construct a new store to resume.
   * Held content is kept, so a closed store still serves what it received.
   * `failed` stays `null`, and pending `waitForSkills` calls resolve at once.
   * `shutdown()` detaches the store from the accessors.
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
   * Resolves once the first payload arrives, or after `timeoutMs`.
   *
   * Resolves `true` once a payload has committed or a 304 confirmed the one held
   * is current. That does not mean any skill verified, or that the environment
   * has skills; see `diagnostics`.
   *
   * Resolves `false` on timeout, or immediately if delivery has ended (`close`,
   * or a failure that will not be retried; `failed` tells them apart). A store
   * that gave up waits again once `start()` runs delivery again; only `close` is
   * final. Rejects for a negative or non-finite `timeoutMs`.
   */
  waitForSkills(timeoutMs = 10_000): Promise<boolean> {
    if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs < 0) {
      // `setTimeout(fn, NaN)` fires at once and would read as a timeout.
      return Promise.reject(
        new Error(`waitForSkills timeoutMs must be a non-negative, finite number, got ${String(timeoutMs)}`),
      );
    }
    if (this.firstPayload) return Promise.resolve(true);
    // No payload can arrive any more.
    if (this.closed || this.failedReason !== null) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const waiter = (): void => {
        clearTimeout(timer);
        resolve(this.firstPayload);
      };
      const timer = setTimeout(() => {
        // Remove the expired waiter so it is not retained.
        this.dropWaiter(waiter);
        resolve(this.firstPayload);
      }, timeoutMs);
      // Deliberately not unreffed, unlike every other timer here. During an
      // outage nothing else holds the process up, so an unreffed wait let `node`
      // exit mid-`await`. Bounded by `timeoutMs`, and cleared on release.
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
   * Whether a payload has arrived: `waitForSkills` without the wait.
   *
   * Optional `SkillStore` method. `writeSkills('*')` checks it so a reconcile
   * before first delivery reports "unavailable" instead of pruning every skill.
   * Stays `true` after `close`.
   */
  isInitialized(): boolean {
    return this.firstPayload;
  }

  /**
   * Why delivery stopped, or `null` while it is running. Cleared when `start`
   * runs delivery again.
   */
  get failed(): string | null {
    return this.failedReason;
  }

  /** A snapshot of what the transport has seen. See {@link StoreDiagnostics}. */
  get diagnostics(): StoreDiagnostics {
    return { ...this.reader.diagnostics };
  }

  // -- the SkillStore interface -----------------------------------------

  getObject(kind: string, key: string, version?: number | null): RawSkillObject | null {
    if (kind !== SKILL_OBJECT_KIND) return null;
    return this.objects.get(key, version ?? null);
  }

  allObjects(kind: string): Record<string, RawSkillObject> {
    if (kind !== SKILL_OBJECT_KIND) return {};
    return this.objects.snapshot();
  }

  /**
   * Registers `fn` to be called once per changed object, when a payload commits
   * (never mid-transfer).
   *
   * - A put passes the raw skill object.
   * - A revocation passes a `{ key, version }` tombstone with no `content`;
   *   check for `content` before reading it.
   *
   * `fn` runs inline on the delivery task: keep it cheap and non-blocking.
   * Errors it throws (or rejections, if async) are logged and swallowed.
   *
   * Throws for any `kind` other than `'skill'`, since such a listener would
   * never fire.
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
   * Unregisters one occurrence of `fn` from `kind`; a no-op if it is not
   * registered (any `kind` is accepted). Safe inside a listener (takes effect
   * from the next commit).
   */
  removeListener(kind: string, fn: (raw: RawSkillObject) => unknown): void {
    const listeners = this.listeners.get(kind);
    if (!listeners) return;
    const index = listeners.indexOf(fn);
    if (index !== -1) listeners.splice(index, 1);
  }

  private notify(changes: RawSkillObject[]): void {
    // Copied so a removal mid-commit does not disturb iteration.
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
          // Catch async rejections too, so they never go unhandled.
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
        this.connectedAt = null;
        if (this.mode === 'stream') await this.streamOnce(signal);
        else await this.pollOnce(signal);
        if (signal.aborted) return;
        // A returned poll is a current answer, even a 304. Stream successes are
        // recorded in `apply`.
        this.recordSuccess();
        // `pollIntervalMs` already spaces the requests, so a completed poll
        // also starts the backoff over.
        this.backoffAttempt = 0;
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
        if (cause instanceof StaleRequestStateError) {
          // With no basis or etag to drop, the 400 is fatal. Otherwise drop them
          // and request a full transfer once.
          if (this.basis === null && this.etag === null) {
            this.giveUp(cause.message);
            return;
          }
          this.basis = null;
          this.etag = null;
          this.etagBasis = null;
        }
        // A routine stream recycle (see `dispatch`) reconnects without counting
        // as a failure.
        if (!cause.expected) {
          this.failures += 1;
          this.reader.diagnostics.connectionFailures = this.failures;
          this.reader.diagnostics.lastError = cause.message;
        }
        // Every reconnect advances the step, a recycle included. Only a stream
        // that stayed open long enough starts it over.
        if (this.connectedAt !== null && performance.now() - this.connectedAt >= this._backoffResetIntervalMs) {
          this.backoffAttempt = 0;
        }
        this.backoffAttempt += 1;
        const requested = cause.retryAfterMs;
        const delay = Math.min(
          requested !== null && Number.isFinite(requested)
            ? // Floor at `initialBackoffMs` so `Retry-After: 0` cannot cause a
              // tight reconnect loop.
              Math.max(requested, this.initialBackoffMs)
            : backoffDelayMs(this.backoffAttempt, this.initialBackoffMs, this.maxBackoffMs),
          // Cap at `maxBackoffMs` even if `Retry-After` asks for more.
          this.maxBackoffMs,
        );
        if (!cause.expected) {
          warn(`Skill delivery failed (${cause.message}); retrying in ${Math.round(delay)}ms`);
        } else {
          // A routine recycle: nothing above debug.
          debug(`Skill delivery reconnecting (${cause.message}) in ${Math.round(delay)}ms`);
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
        'received, and skills will not update until delivery runs again: call start() on this store once the ' +
        'cause is fixed, or restart the process.',
    );
    // Release `waitForSkills` callers now; they resolve `false`.
    this.releaseWaiters();
  }

  private apply(name: string, data: unknown): TransferOutcome {
    const outcome = this.reader.handle(name, data);
    // A commit or a `none` intent is a completed exchange. Counting `none` keeps
    // a stream for an unchanging environment from reading as failing. Neither
    // resets the backoff step; see `backoffAttempt`.
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
      // A goodbye is routine only after a completed exchange; otherwise it
      // counts as a failure, so a server that only says goodbye is backed off.
      const expected = outcome.expected === true && this.reachedServer;
      throw new RecoverableTransportError(outcome.disconnect, null, expected);
    }
  }

  private async pollOnce(signal: AbortSignal): Promise<void> {
    const basis = this.basis;
    // Send the etag only with the basis it was issued for; a 304 to a stale pair
    // would describe the previous request.
    const etag = this.etagBasis === basis ? this.etag : null;
    const result = await this.requester.poll(basis, etag, signal);
    if (result.notModified) {
      // A 304 confirms the payload this store holds; it cannot establish one.
      // `isInitialized()` stays false until something commits, so a store that
      // has received nothing never authorizes a prune of the files on disk. `run`
      // counts the poll as a healthy answer.
      return;
    }
    let completed = false;
    for (const [name, data] of result.events) {
      const outcome = this.apply(name, data);
      completed = completed || outcome.committed === true || outcome.healthy === true;
      this.dispatch(outcome);
    }
    if (!completed) {
      // An etag describes the body it came with, so it is adopted only when that
      // body is also what the store now holds: a commit, or a `none` intent. A
      // transfer this SDK could not apply is neither, and keeping its etag would
      // let the next 304 confirm content never applied. Any etag already held
      // stays valid, so it is left alone, not cleared.
      return;
    }
    this.etag = result.etag;
    this.etagBasis = basis;
  }

  private async streamOnce(signal: AbortSignal): Promise<void> {
    const events = await this.requester.stream(this.basis, signal);
    this.connectedAt = performance.now();
    for await (const [name, data] of events) {
      if (signal.aborted) return;
      this.dispatch(this.apply(name, data));
    }
    // A stream that ends without a goodbye is a dropped connection.
    throw new RecoverableTransportError('the FDv2 stream closed unexpectedly');
  }
}
