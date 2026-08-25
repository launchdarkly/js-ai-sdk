/**
 * Agent Skills — filesystem materialization.
 *
 * The highest-blast-radius layer of the feature: this is the part that writes to a
 * customer's disk. Split out of `skills.ts` on that boundary — everything here
 * takes already-verified content and reconciles it against a managed root, while
 * `skills.ts` owns retrieval and verification and knows nothing about the
 * filesystem. The dependency runs one way only, and the symlink-refusing
 * primitives every destructive step goes through live in `safe-fs.ts`.
 *
 * The reconcile is manifest-driven and fails closed: destructive operations only
 * ever touch paths `<root>/.launchdarkly-skills.json` records under a matching
 * key, a corrupt manifest suppresses every destructive action, and an incomplete
 * retrieval suppresses pruning. Content is re-verified immediately before the
 * write, because a `Skill` can also be constructed directly by a caller.
 */

import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rmdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { atomicWrite, atomicWriteIn, openDirectoryNoFollow, openOrCreateDirectory, unlinkNoFollow } from './safe-fs.js';
import {
  allRawObjects,
  getStore,
  isVerificationFailure,
  NO_STORE_MESSAGE,
  type Resolution,
  recordMaterialized,
  recordRevoked,
  referenceTarget,
  resolveFromStore,
  verifiedBytes,
  verifyRawSkill,
} from './skills-core.js';
import type {
  OnUnavailable,
  ReconcileAction,
  ReconcileActionKind,
  ReconcileReport,
  Skill,
  SkillReference,
} from './types.js';
import {
  createReconcileAction,
  createReconcileReport,
  isValidSkillKey,
  isValidSkillVersion,
  SKILL_KEY_MAX_LENGTH,
} from './types.js';

/** The SDK's record of what it has written under a managed root. */
export const MANIFEST_FILENAME = '.launchdarkly-skills.json';

/** Manifest schema version this release writes, and the highest it can read. */
export const MANIFEST_VERSION = 1;

/** The single file each skill materializes to, under `<root>/<key>/`. */
export const SKILL_FILENAME = 'SKILL.md';

/**
 * Prefix on every error describing content that could not be retrieved. Tests
 * assert on it, so it lives in one place.
 */
const UNAVAILABLE_PREFIX = 'skill retrieval unavailable: ';

/**
 * `NAME_MAX` on Linux and macOS, and the component limit on Windows. A skill key
 * becomes a single directory name, and the data model permits keys up to 256
 * characters — one byte longer than any of those filesystems can represent. Such a
 * key is rejected before any filesystem call so the caller gets a reported action
 * rather than an `ENAMETOOLONG` escaping from a stat deep inside the reconcile.
 */
const MAX_PATH_COMPONENT_BYTES = 255;

/** Options for {@link writeSkills}. */
export type WriteSkillsOptions = {
  /** Remove formerly-managed skills no longer in the requested set. Default `true`. */
  prune?: boolean;
  /** Bound on the whole call, in **seconds** (not milliseconds). Default `10`. */
  timeout?: number;
  /** How to react to content that could not be retrieved. Default `'keep'`. */
  onUnavailable?: OnUnavailable;
};

/** One skill queued for the reconcile: resolved content, or why there is none. */
type PendingWrite = {
  readonly key: string;
  readonly skill?: Skill | null;
  readonly error?: string | null;
};

// -------------------------------------------------------------------------
// The reconcile entry point
// -------------------------------------------------------------------------

/**
 * Materializes skills under a managed root at `<root>/<key>/SKILL.md`.
 *
 * `skills` is an array of `Skill` / `SkillReference` / key strings, or the literal
 * `'*'` meaning everything `allSkills()` returns. `Skill` values are used as-is;
 * references and strings resolve through the accessors, so they need a configured
 * store.
 *
 * The reconcile is manifest-driven (`<root>/.launchdarkly-skills.json`):
 * destructive operations only ever touch paths the manifest records under a
 * matching key, so a file the SDK did not write is never overwritten or deleted.
 * `prune` removes formerly-managed skills that are no longer in the requested set
 * — which is also how revocation takes effect. `timeout` bounds the whole call,
 * including content retrieval, and is measured in **seconds** to match the
 * cross-language contract. `onUnavailable` chooses between reporting a failed
 * retrieval (`'keep'`, leaving existing managed files alone) and throwing.
 *
 * Resolves to a `ReconcileReport` in which every outcome is visible; throws for a
 * caller error such as an unusable root.
 *
 * `timeout` is checked between steps rather than interrupting one in progress.
 */
export async function writeSkills(
  skills: ReadonlyArray<Skill | SkillReference | string> | '*',
  root: string,
  options: WriteSkillsOptions = {},
): Promise<ReconcileReport> {
  const { prune = true, timeout = 10, onUnavailable = 'keep' } = options;

  // Both of these are typed as closed sets, but the values can still arrive from
  // untyped code, so they are checked rather than assumed.
  if (onUnavailable !== 'keep' && onUnavailable !== 'raise') {
    throw new Error(`onUnavailable must be "keep" or "raise", got ${JSON.stringify(onUnavailable)}`);
  }
  if (typeof timeout !== 'number' || Number.isNaN(timeout) || timeout < 0) {
    throw new Error(`timeout must be a non-negative number of seconds, got ${JSON.stringify(timeout)}`);
  }

  const deadline = performance.now() + timeout * 1000;
  const rootPath = await resolveRoot(root);
  const { manifest, error: manifestError } = await loadManifest(rootPath);
  const entries: Record<string, unknown> = (manifest.entries as Record<string, unknown>) ?? {};

  const actions: ReconcileAction[] = [];
  // Run-level failure: there is no single skill key to hang it off.
  if (manifestError !== null) actions.push(runError(manifestError));

  const { requests, incomplete: retrievalIncomplete } = await resolveRequests(skills, deadline, onUnavailable);

  const { actions: written, timedOut } = await writeAll(rootPath, requests, entries, deadline, timeout);
  actions.push(...written);
  const incomplete = retrievalIncomplete || timedOut;

  // Pruning is destructive, so it needs a trustworthy picture of both sides: a
  // corrupt manifest means we do not know what we own, and an incomplete run — a
  // retrieval that failed, or a deadline that expired mid-write — means we do not
  // know what is still current. Either way, deleting would be a guess.
  if (prune && manifestError === null && !incomplete) {
    actions.push(...(await pruneEntries(rootPath, entries, new Set(requests.map((r) => r.key)))));
  }

  if (manifestError === null) actions.push(...(await rewriteManifest(rootPath, manifest, entries)));

  return createReconcileReport(actions);
}

/**
 * A failure belonging to the run rather than to one skill.
 *
 * The empty key is the documented sentinel for that (see `ReconcileAction`); it is
 * spelled once, here, so every run-level error agrees.
 */
function runError(message: string): ReconcileAction {
  return createReconcileAction({ key: '', action: 'error', error: message });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Reconciles every pending write.
 *
 * The loop never aborts: a per-skill failure becomes an `error` action and the
 * next skill is attempted, because returning early would skip the caller's
 * manifest rewrite and orphan every file already written in this run.
 */
async function writeAll(
  root: string,
  requests: readonly PendingWrite[],
  entries: Record<string, unknown>,
  deadline: number,
  timeout: number,
): Promise<{ actions: ReconcileAction[]; timedOut: boolean }> {
  const actions: ReconcileAction[] = [];
  let timedOut = false;

  for (const request of requests) {
    if (!request.skill) {
      actions.push(
        createReconcileAction({
          key: request.key,
          action: 'error',
          error: request.error ?? `skill '${request.key}' could not be resolved`,
        }),
      );
      continue;
    }
    if (performance.now() >= deadline) {
      timedOut = true;
      actions.push(
        createReconcileAction({
          key: request.key,
          action: 'error',
          error: `the ${timeout}s timeout was exhausted before skill '${request.key}' could be written`,
        }),
      );
      continue;
    }
    try {
      actions.push(await writeOne(root, request.skill, entries));
    } catch (error) {
      // A safety net, not the primary defense: an unexpected filesystem
      // condition must not abort the loop.
      actions.push(
        createReconcileAction({
          key: request.skill.key,
          action: 'error',
          version: request.skill.version,
          error: `skill '${request.skill.key}' could not be reconciled: ${messageOf(error)}`,
        }),
      );
    }
  }

  return { actions, timedOut };
}

/**
 * Rebuilds `value` with object keys in sorted order.
 *
 * `JSON.stringify` emits insertion order, and the Python SDK writes this file
 * with `sort_keys=True`. Both parse either form, so this is not a correctness
 * requirement — but a repo where both SDKs run would otherwise see the manifest's
 * key order flip on every reconcile depending on which language wrote last. The
 * cheapest fix is to agree.
 */
function sortedForSerialization(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedForSerialization);
  if (typeof value !== 'object' || value === null) return value;
  const source = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) sorted[key] = sortedForSerialization(source[key]);
  return sorted;
}

/**
 * Every character `JSON.stringify` leaves as a raw UTF-8 byte but Python's
 * `json.dumps` escapes. Matched on UTF-16 code units, so an astral character is
 * escaped as its surrogate pair — which is exactly what CPython emits.
 */
const NON_ASCII = /[\u0080-\uffff]/g;

/**
 * Serializes the manifest the way the Python SDK does, byte for byte.
 *
 * `json.dumps(..., indent=2, sort_keys=True)` defaults to `ensure_ascii=True`,
 * so Python escapes every non-ASCII character as `\uXXXX` while
 * `JSON.stringify` emits raw UTF-8. Only reachable through preserved
 * unknown fields — every field this SDK writes is ASCII by construction — but
 * that path is live, and without the escape two SDKs reconciling one root would
 * rewrite the file with different bytes on alternating runs. That is the same
 * churn `sortedForSerialization` exists to prevent, so the two belong together.
 */
function serializeManifest(manifest: Record<string, unknown>): Buffer {
  const json = JSON.stringify(sortedForSerialization(manifest), null, 2);
  return Buffer.from(
    json.replace(NON_ASCII, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`),
    'utf-8',
  );
}

/** Writes the updated manifest. Returns an error action, or nothing. */
async function rewriteManifest(
  root: string,
  manifest: Record<string, unknown>,
  entries: Record<string, unknown>,
): Promise<ReconcileAction[]> {
  const updated = { ...manifest, manifestVersion: MANIFEST_VERSION, entries };
  try {
    // Serialization is inside the guard: unknown manifest fields are
    // round-tripped, so a deeply nested or circular planted field can throw here
    // — after every skill file is already on disk.
    //
    // Two-space indent, sorted keys, non-ASCII escaped, and no trailing newline:
    // byte-for-byte what the Python SDK's
    // json.dumps(..., indent=2, sort_keys=True) produces.
    const serialized = serializeManifest(updated);
    await atomicWriteIn(root, MANIFEST_FILENAME, serialized);
  } catch (error) {
    return [runError(`the skills manifest could not be written: ${messageOf(error)}`)];
  }
  return [];
}

// -------------------------------------------------------------------------
// Request resolution — content in, or a reason there is none
// -------------------------------------------------------------------------

/** Wraps `reason` as a retrieval-unavailable message. */
function unavailable(reason: string): string {
  return `${UNAVAILABLE_PREFIX}${reason}`;
}

/** A `Skill` and a `SkillReference` are both plain objects, so discriminate structurally. */
function isSkill(item: Skill | SkillReference | string): item is Skill {
  return (
    typeof item === 'object' &&
    item !== null &&
    typeof (item as Skill).content === 'string' &&
    typeof (item as Skill).contentHash === 'string'
  );
}

/**
 * Turns the caller's input into one request per skill.
 *
 * Also reports whether any retrieval was left incomplete — an absent store, a
 * throwing store, or an exhausted timeout. That flag suppresses pruning: deleting
 * managed files because retrieval failed would turn a transport outage into data
 * loss.
 */
async function resolveRequests(
  skills: ReadonlyArray<Skill | SkillReference | string> | '*',
  deadline: number,
  onUnavailable: OnUnavailable,
): Promise<{ requests: PendingWrite[]; incomplete: boolean }> {
  if (typeof skills === 'string') {
    if (skills !== '*') {
      throw new Error(`writeSkills takes an array of skills or the literal "*"; got ${JSON.stringify(skills)}`);
    }
    return resolveAll(deadline, onUnavailable);
  }

  const requests: PendingWrite[] = [];
  let incomplete = false;
  for (const item of skills) {
    if (isSkill(item)) {
      requests.push({ key: item.key, skill: item });
      continue;
    }

    const [key, wanted] = referenceTarget(item);
    const resolved = resolveReference(key, wanted, deadline);
    if (resolved.unavailable) {
      incomplete = true;
      if (onUnavailable === 'raise') throw new Error(resolved.error ?? unavailable(key));
    }
    requests.push({ key, skill: resolved.skill ?? null, error: resolved.error ?? null });
  }

  return { requests, incomplete };
}

/**
 * Resolves one reference for the materialization path.
 *
 * Same core as the accessors, plus the two conditions only this path treats as
 * data rather than as an exception: an exhausted deadline and an absent store.
 */
function resolveReference(key: string, wantedVersion: number | null, deadline: number): Resolution {
  if (performance.now() >= deadline) {
    return {
      error: unavailable(`the timeout was exhausted before '${key}' could be retrieved`),
      unavailable: true,
    };
  }

  const store = getStore();
  if (store === null) return { error: unavailable(NO_STORE_MESSAGE), unavailable: true };

  const resolved = resolveFromStore(store, key, wantedVersion);
  if (resolved.unavailable && resolved.error) {
    return { error: unavailable(resolved.error), unavailable: true };
  }
  return resolved;
}

/**
 * One run-level retrieval failure — thrown, or reported against the empty key.
 *
 * Always reports the run incomplete, which is what suppresses pruning: nothing was
 * retrieved, so every managed file on disk has to be assumed current.
 */
function unavailableRun(
  error: string,
  onUnavailable: OnUnavailable,
): { requests: PendingWrite[]; incomplete: boolean } {
  if (onUnavailable === 'raise') throw new Error(error);
  return { requests: [{ key: '', error }], incomplete: true };
}

/**
 * One raw store object as a pending write — verified, or reported as failed.
 *
 * Present but unverifiable is NOT the same as revoked. Dropping it silently would
 * leave the key out of the requested set, so prune would delete the last
 * known-good copy already on disk and report a routine `removed` with
 * `report.ok` still true. A failed request instead gets the same treatment the
 * reference path already gives: the outcome is surfaced, and the key stays in the
 * requested set so nothing is pruned.
 */
function pendingForRaw(objectKey: string, raw: unknown): PendingWrite {
  const skill = verifyRawSkill(raw);
  if (skill) return { key: skill.key, skill };
  if (!isValidSkillKey(objectKey)) {
    return { key: '', error: 'the skill store served an object under an invalid key; it was withheld' };
  }
  return {
    key: objectKey,
    error: `skill '${objectKey}' failed integrity verification and was withheld; the copy already on disk was left alone`,
  };
}

/** Resolves the `'*'` form — everything the store currently holds. */
function resolveAll(deadline: number, onUnavailable: OnUnavailable): { requests: PendingWrite[]; incomplete: boolean } {
  if (performance.now() >= deadline) {
    return unavailableRun(
      unavailable('the timeout was exhausted before the skill set could be retrieved'),
      onUnavailable,
    );
  }

  const store = getStore();
  if (store === null) return unavailableRun(unavailable(NO_STORE_MESSAGE), onUnavailable);

  // Deliberately not via allSkills(), which reports a throwing store as an empty
  // result — that would look like "every skill was revoked" and let prune delete
  // the lot.
  let objects: Record<string, unknown>;
  try {
    objects = allRawObjects(store);
  } catch (error) {
    const name = error instanceof Error ? error.constructor.name : 'unknown error';
    return unavailableRun(unavailable(`the skill store threw ${name}: ${messageOf(error)}`), onUnavailable);
  }

  return {
    requests: Object.entries(objects).map(([key, raw]) => pendingForRaw(key, raw)),
    incomplete: false,
  };
}

// -------------------------------------------------------------------------
// The managed root and its manifest
// -------------------------------------------------------------------------

/**
 * Resolves the managed root once, up front.
 *
 * An unusable root is a caller error rather than a per-skill outcome, so this
 * throws. Only the leaf directory is ever created — recursively creating missing
 * ancestors would let a typo scatter a directory tree.
 */
async function resolveRoot(root: string): Promise<string> {
  if (typeof root !== 'string' || root.length === 0) {
    throw new Error('the skills root must be a non-empty path string');
  }

  let info: Awaited<ReturnType<typeof lstat>> | null = null;
  try {
    info = await lstat(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(`the skills root could not be inspected: ${messageOf(error)}`);
    }
  }

  if (info?.isSymbolicLink()) {
    throw new Error(`the skills root must be a real directory, not a symlink: ${root}`);
  }

  if (info !== null) {
    if (!info.isDirectory()) throw new Error(`the skills root is not a directory: ${root}`);
  } else {
    const parent = path.dirname(root);
    let parentIsDirectory = false;
    try {
      parentIsDirectory = (await stat(parent)).isDirectory();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error(`the parent of the skills root could not be inspected: ${messageOf(error)}`);
      }
    }
    if (!parentIsDirectory) {
      throw new Error(
        `the parent of the skills root does not exist: ${parent}. writeSkills creates only the leaf directory.`,
      );
    }
    try {
      await mkdir(root);
    } catch (error) {
      throw new Error(`the skills root could not be created: ${messageOf(error)}`);
    }
  }

  return realpath(root);
}

/**
 * Loads the manifest.
 *
 * A manifest that cannot be read, cannot be parsed, is not an object, carries a
 * `manifestVersion` this release does not understand, or has a malformed `entries`
 * map is **corrupt**. The caller then performs no destructive action and leaves the
 * file itself alone: rewriting it would destroy the only record of what the SDK
 * owns, and acting on a manifest we cannot read would mean guessing at which of
 * the customer's files are ours.
 *
 * An absent manifest is not corrupt — that is simply a fresh root.
 */
async function loadManifest(root: string): Promise<{ manifest: Record<string, unknown>; error: string | null }> {
  const fresh = { manifestVersion: MANIFEST_VERSION, entries: {} };

  let text: string;
  try {
    text = await readFile(path.join(root, MANIFEST_FILENAME), 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { manifest: fresh, error: null };
    return {
      manifest: {},
      error: `the skills manifest ${MANIFEST_FILENAME} could not be read: ${messageOf(error)}`,
    };
  }

  // Non-UTF-8 bytes come back as U+FFFD rather than throwing, so the manifest
  // would parse as garbage JSON below — which is the same fail-closed outcome.
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    return {
      manifest: {},
      error: `the skills manifest ${MANIFEST_FILENAME} is not valid JSON (${messageOf(error)}); refusing every destructive action`,
    };
  }

  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return {
      manifest: {},
      error: `the skills manifest ${MANIFEST_FILENAME} is not a JSON object; refusing every destructive action`,
    };
  }

  const manifest = data as Record<string, unknown>;
  const version = manifest.manifestVersion;
  if (typeof version !== 'number' || !Number.isInteger(version) || version > MANIFEST_VERSION) {
    return {
      manifest: {},
      error: `the skills manifest ${MANIFEST_FILENAME} declares manifestVersion ${JSON.stringify(version)}, which this SDK cannot read; refusing every destructive action`,
    };
  }

  const { entries } = manifest;
  if (typeof entries !== 'object' || entries === null || Array.isArray(entries)) {
    return {
      manifest: {},
      error: `the skills manifest ${MANIFEST_FILENAME} has a malformed 'entries' map; refusing every destructive action`,
    };
  }

  return { manifest, error: null };
}

// -------------------------------------------------------------------------
// Per-skill reconcile
// -------------------------------------------------------------------------

/**
 * Why `key` must not become a directory name under the managed root, or `null`.
 *
 * Re-validated locally whatever any upstream layer already did, and
 * before any filesystem call, because a key becomes a path component. Shared by
 * the write and the prune paths so the two cannot disagree about which keys this
 * SDK could own; `agents.md` marks these checks non-relaxable, and maintaining
 * them twice is how they drift.
 */
function keyRejectionReason(key: unknown): string | null {
  if (!isValidSkillKey(key)) {
    return `${JSON.stringify(key)} is not a valid skill key (^[a-z0-9][a-z0-9-]*$, at most ${SKILL_KEY_MAX_LENGTH} characters)`;
  }
  // The data model allows 256 characters; no mainstream filesystem allows a
  // 256-byte path component. Catch it here so it is a reported action rather than
  // an ENAMETOOLONG thrown from the first stat in the caller.
  const keyBytes = Buffer.byteLength(key, 'utf-8');
  if (keyBytes > MAX_PATH_COMPONENT_BYTES) {
    return `skill key '${key.slice(0, 32)}...' is ${keyBytes} bytes, over the ${MAX_PATH_COMPONENT_BYTES}-byte limit for a single directory name`;
  }
  return null;
}

async function isSymlink(target: string): Promise<boolean> {
  try {
    return (await lstat(target)).isSymbolicLink();
  } catch {
    return false;
  }
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * The path defenses, in one place.
 *
 * Returns why `<root>/<key>/SKILL.md` must not be touched, or `null`. Shared by
 * the write and prune paths: `agents.md` marks these checks non-relaxable, and
 * maintaining them twice is how they drift.
 *
 * `requireDirectory` is the one genuine difference between the two callers. A
 * write needs a real directory to write into. A prune only needs to not follow a
 * link — an entry whose directory has been replaced by a plain file has already
 * lost the file this SDK owned, so reporting `removed` is what lets the stale
 * manifest entry be dropped rather than pinned forever.
 *
 * The containment check runs even when `skillDir` does not exist yet: `realpath`
 * on the deepest existing ancestor plus the remainder is what a fresh key under a
 * valid root has to satisfy.
 */
async function unsafePathReason(
  root: string,
  skillDir: string,
  target: string,
  key: string,
  requireDirectory: boolean,
): Promise<string | null> {
  if (await isSymlink(skillDir)) return `${key} is a symlink`;
  if (requireDirectory && (await pathExists(skillDir))) {
    if (!(await stat(skillDir).catch(() => null))?.isDirectory()) return `${key} exists and is not a directory`;
  }
  if (await isSymlink(target)) return 'the target file is a symlink';

  let resolvedParent: string;
  try {
    resolvedParent = await realpath(skillDir);
  } catch {
    // Not yet on disk: the parent is the root, which resolveRoot already
    // realpath'd, so resolve that instead and re-append the component.
    resolvedParent = path.join(await realpath(path.dirname(skillDir)), path.basename(skillDir));
  }
  if (path.dirname(resolvedParent) !== root) return `it resolves outside the managed root ${root}`;
  return null;
}

/** Reconciles one verified skill against the managed root. */
async function writeOne(root: string, skill: Skill, entries: Record<string, unknown>): Promise<ReconcileAction> {
  const key = skill.key;
  const failed = (message: string): ReconcileAction =>
    createReconcileAction({ key, action: 'error', version: skill.version, error: message });

  const rejection = keyRejectionReason(key);
  if (rejection !== null) return failed(`${rejection}; nothing was written`);
  if (!isValidSkillVersion(skill.version)) {
    return failed(
      `skill '${key}' has version ${JSON.stringify(skill.version)}, which is not an integer >= 1; nothing was written`,
    );
  }

  const skillDir = path.join(root, key);
  const target = path.join(skillDir, SKILL_FILENAME);
  const relative = `${key}/${SKILL_FILENAME}`;

  const unsafe = await unsafePathReason(root, skillDir, target, key, true);
  if (unsafe !== null) return failed(`'${relative}' was refused: ${unsafe}; nothing was written`);

  // Verify-then-write, through the same core the accessors use (the accessor
  // boundary verified once already, but a Skill can also be constructed directly
  // by a caller). Sharing it is what keeps the integrity signal's property set
  // from depending on which of the two layers caught the defect.
  const verified = verifiedBytes(key, skill.content, skill.contentHash, skill.version);
  if (isVerificationFailure(verified)) {
    return failed(
      `skill '${key}' failed verification immediately before writing: ${verified.reason}; nothing was written`,
    );
  }
  const { encoded, contentHash } = verified;

  // Overwrite only what the manifest records as ours under this key.
  const entry = entries[relative];
  const managed = typeof entry === 'object' && entry !== null && (entry as { key?: unknown }).key === key;
  const exists = await pathExists(target);

  if (exists && !managed) {
    return failed(
      `'${relative}' exists but the manifest does not record it as managed under key '${key}'; refusing to overwrite a file this SDK did not write`,
    );
  }

  let action: ReconcileActionKind = 'written';
  if (exists) {
    let onDisk: Buffer;
    try {
      onDisk = await readFile(target);
    } catch (error) {
      return failed(`'${relative}' could not be read: ${messageOf(error)}`);
    }

    if (createHash('sha256').update(onDisk).digest('hex') === contentHash) {
      updateEntry(entries, relative, skill, contentHash, false);
      recordMaterialized(key, encoded.byteLength, contentHash, 'skipped_current');
      return createReconcileAction({ key, action: 'skipped_current', version: skill.version, path: target });
    }
    // Stale version or local tampering — LD-resolved content wins.
    action = 'updated';
  }

  const writeError = await writeThroughPinnedDirectory(skillDir, encoded, key, relative);
  if (writeError !== null) return failed(writeError);

  updateEntry(entries, relative, skill, contentHash, true);
  recordMaterialized(key, encoded.byteLength, contentHash, action);
  return createReconcileAction({ key, action, version: skill.version, path: target });
}

/**
 * Performs the write itself. Returns a failure reason, or `null` on success.
 *
 * Split out of `writeOne` because everything above it decides *whether* to write
 * and this decides nothing: the directory is pinned to a handle and its identity
 * is re-checked immediately before the rename, which is as much of the
 * symlink-swap defense as Node permits (see `safe-fs.ts`).
 */
async function writeThroughPinnedDirectory(
  skillDir: string,
  encoded: Buffer,
  key: string,
  relative: string,
): Promise<string | null> {
  let handle: Awaited<ReturnType<typeof openOrCreateDirectory>>;
  try {
    handle = await openOrCreateDirectory(skillDir);
  } catch (error) {
    return `'${relative}' was refused: the directory for skill '${key}' could not be opened: ${messageOf(error)}`;
  }

  try {
    await atomicWrite(skillDir, SKILL_FILENAME, encoded, handle);
  } catch (error) {
    return `'${relative}' could not be written: ${messageOf(error)}`;
  } finally {
    await handle.close().catch(() => undefined);
  }
  return null;
}

/**
 * Records a managed path in the manifest.
 *
 * Merges into any existing entry rather than replacing it, so fields written by a
 * future SDK release survive this one's rewrite.
 */
function updateEntry(
  entries: Record<string, unknown>,
  relative: string,
  skill: Skill,
  contentHash: string,
  touch: boolean,
): void {
  const existing = entries[relative];
  const entry: Record<string, unknown> =
    typeof existing === 'object' && existing !== null && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : {};
  entry.key = skill.key;
  entry.version = skill.version;
  entry.sha256 = contentHash;
  if (touch || !('writtenAt' in entry)) entry.writtenAt = utcTimestamp();
  entries[relative] = entry;
}

function utcTimestamp(): string {
  return `${new Date().toISOString().slice(0, 19)}Z`;
}

// -------------------------------------------------------------------------
// Pruning — how revocation takes effect
// -------------------------------------------------------------------------

/**
 * A prune refusal. Mirrors `writeOne`'s local `failed` helper.
 *
 * `version` comes off the manifest, which is untrusted, so it is validated here
 * rather than at each call site — the same guard the `removed` action applies, so
 * a refusal and a removal report the field identically.
 * Callers that genuinely do not know a version pass nothing; none of them may
 * invent one.
 */
function pruneError(key: string, message: string, version: unknown = null): ReconcileAction {
  return createReconcileAction({
    key,
    action: 'error',
    version: isValidSkillVersion(version) ? version : null,
    error: message,
  });
}

/**
 * Removes managed skills that are no longer requested.
 *
 * This is also how revocation takes effect: a revoked skill is simply absent from
 * the resolved set, so the next reconcile removes it. There is deliberately no
 * opt-out.
 */
async function pruneEntries(
  root: string,
  entries: Record<string, unknown>,
  requested: ReadonlySet<string>,
): Promise<ReconcileAction[]> {
  const actions: ReconcileAction[] = [];

  for (const [relative, entry] of Object.entries(entries)) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const { key } = record;
    if (typeof key !== 'string' || requested.has(key)) continue;

    // Only a manifest path this SDK could have written is removable.
    if (keyRejectionReason(key) !== null || relative !== `${key}/${SKILL_FILENAME}`) {
      actions.push(
        pruneError(
          key,
          `manifest entry '${relative}' does not name a path this SDK could own under key '${key}'; it was left in place`,
          record.version,
        ),
      );
      continue;
    }

    try {
      actions.push(await pruneOne(root, relative, key, entries));
    } catch (error) {
      actions.push(pruneError(key, `'${relative}' could not be removed: ${messageOf(error)}`, record.version));
    }
  }

  return actions;
}

/** Removes one managed skill file, and its directory when that empties it. */
async function pruneOne(
  root: string,
  relative: string,
  key: string,
  entries: Record<string, unknown>,
): Promise<ReconcileAction> {
  const skillDir = path.join(root, key);
  const target = path.join(skillDir, SKILL_FILENAME);
  const version = (entries[relative] as Record<string, unknown>).version;

  const unsafe = await unsafePathReason(root, skillDir, target, key, false);
  if (unsafe !== null) return pruneError(key, `'${relative}' was not removed: ${unsafe}`, version);

  let removedFromDisk = false;
  if (await pathExists(target)) {
    let handle: Awaited<ReturnType<typeof openDirectoryNoFollow>>;
    try {
      handle = await openDirectoryNoFollow(skillDir);
    } catch (error) {
      return pruneError(key, `'${relative}' was not removed: ${messageOf(error)}`, version);
    }
    try {
      await unlinkNoFollow(skillDir, SKILL_FILENAME, handle);
    } catch (error) {
      return pruneError(key, `'${relative}' could not be removed: ${messageOf(error)}`, version);
    } finally {
      await handle.close().catch(() => undefined);
    }
    removedFromDisk = true;
    // Path-based, and safe that way: rmdir never follows a trailing symlink (it
    // fails ENOTDIR) and only ever succeeds on an empty directory. The customer
    // keeps their own files here too, so a failure is expected and ignored.
    await rmdir(skillDir).catch(() => undefined);
  }

  delete entries[relative];

  if (removedFromDisk) recordRevoked(key, isValidSkillVersion(version) ? version : null);

  return createReconcileAction({
    key,
    action: 'removed',
    version: isValidSkillVersion(version) ? version : null,
    path: target,
  });
}
