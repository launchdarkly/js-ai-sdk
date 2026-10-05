/**
 * Agent Skills — filesystem materialization.
 *
 * Writes already-verified skill content to disk under a managed root. Retrieval
 * and verification live in `skills.ts`; the symlink-refusing primitives live in
 * `safe-fs.ts`.
 *
 * Safety invariants:
 *
 * - The root is pinned to a descriptor once per reconcile, and every path below
 *   it is built from {@link PinnedDirectory.address}, so on Linux a root swapped
 *   mid-run cannot redirect anything. See `safe-fs.ts` for other platforms.
 * - Destructive operations only touch paths `<root>/.launchdarkly-skills.json`
 *   records under a matching key.
 * - A corrupt manifest suppresses every destructive action; an incomplete
 *   retrieval suppresses pruning.
 * - Content is re-verified immediately before the write.
 *
 * These checks are non-relaxable; see `agents.md`, "Relaxing a path or manifest
 * check in `skills-fs.ts`".
 */

import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { type FileHandle, lstat, mkdir, open, readdir, realpath, rmdir, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  atomicWrite,
  directoryAddress,
  openDirectoryNoFollow,
  openOrCreateDirectory,
  tempNamePattern,
  unlinkNoFollow,
} from './safe-fs.js';
import {
  allRawObjects,
  getStore,
  isVerificationFailure,
  NO_STORE_MESSAGE,
  newestByKey,
  type Resolution,
  recordMaterialized,
  recordRevoked,
  referenceTarget,
  resolveFromStore,
  storeIsInitialized,
  verifiedBytes,
  verifyRawSkill,
} from './skills-core.js';
import type {
  OnUnavailable,
  RawSkillObject,
  ReconcileAction,
  ReconcileActionKind,
  ReconcileReport,
  Skill,
  SkillReference,
  SkillStore,
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

/**
 * Hard cap on the manifest read, far above any real manifest. A larger file is
 * treated as corrupt rather than read into memory. Not exported from the
 * package index.
 */
export const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;

/** The single file each skill materializes to, under `<root>/<key>/`. */
export const SKILL_FILENAME = 'SKILL.md';

/**
 * A directory held open for an operation, with its two names (identical except
 * on Linux):
 *
 * - `path`: the real location, used for containment checks and the only name
 *   shown to callers.
 * - `address`: what filesystem calls use. On Linux, `/proc/self/fd/<fd>`, which
 *   resolves from the pinned inode so a renamed directory cannot redirect a call.
 */
type PinnedDirectory = {
  readonly path: string;
  readonly address: string;
  readonly handle: FileHandle;
};

/** Pairs a freshly opened directory handle with the two names for it. */
function pin(realPath: string, handle: FileHandle): PinnedDirectory {
  return { path: realPath, address: directoryAddress(handle, realPath), handle };
}

/** Prefix on every error describing content that could not be retrieved. */
const UNAVAILABLE_PREFIX = 'skill retrieval unavailable: ';

/**
 * The single path-component limit on Linux, macOS and Windows. Skill keys may be
 * longer, so an over-long key is reported rather than failing with `ENAMETOOLONG`.
 */
const MAX_PATH_COMPONENT_BYTES = 255;

/**
 * Windows reserved device names, which cannot be directory names there. Rejected
 * on every platform so a managed root is usable on any OS. The key grammar
 * (lowercase, no `.` or `$`) makes forms like `con.txt` unreachable.
 */
const WINDOWS_RESERVED_NAMES: ReadonlySet<string> = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  'com1',
  'com2',
  'com3',
  'com4',
  'com5',
  'com6',
  'com7',
  'com8',
  'com9',
  'lpt1',
  'lpt2',
  'lpt3',
  'lpt4',
  'lpt5',
  'lpt6',
  'lpt7',
  'lpt8',
  'lpt9',
]);

/** Options for {@link writeSkills}. */
export type WriteSkillsOptions = {
  /** Remove previously managed skills that are no longer requested. Default `true`. */
  prune?: boolean;
  /** Bound on the whole call, in **seconds** (not milliseconds). Non-negative and finite. Default `10`. */
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
 * `skills` is an array of `Skill` / `SkillReference` / key strings, or `'*'` for
 * every skill the store holds. `Skill` values are written as-is; references and
 * keys resolve through the configured store.
 *
 * The reconcile is driven by a manifest, `<root>/.launchdarkly-skills.json`: it
 * only overwrites or deletes files the manifest records as written by the SDK.
 *
 * - `prune`: remove previously managed skills that are no longer requested. This
 *   is how revocation takes effect.
 * - `timeout`: **seconds**, non-negative and finite. Bounds retrieval, writes and
 *   pruning; checked between steps, not mid-operation. The manifest rewrite
 *   always runs.
 * - `onUnavailable`: `'keep'` reports content that could not be retrieved and
 *   leaves existing files alone; `'raise'` throws.
 *
 * Resolves to a `ReconcileReport` listing every outcome. Throws for an invalid
 * argument or an unusable root.
 *
 * Run at most one reconcile per root at a time: concurrent runs can lose each
 * other's manifest entries.
 */
export async function writeSkills(
  skills: ReadonlyArray<Skill | SkillReference | string> | '*',
  root: string,
  options: WriteSkillsOptions = {},
): Promise<ReconcileReport> {
  const { prune = true, timeout = 10, onUnavailable = 'keep' } = options;

  // Typed as closed sets, but untyped callers can pass anything.
  if (onUnavailable !== 'keep' && onUnavailable !== 'raise') {
    throw new Error(`onUnavailable must be "keep" or "raise", got ${JSON.stringify(onUnavailable)}`);
  }
  // `NaN` and `Infinity` both pass `< 0` and would leave the deadline unbounded
  // (or, for `NaN`, inconsistently expired).
  if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout < 0) {
    // `JSON.stringify` would show `NaN` and `Infinity` as `null`.
    const shown = typeof timeout === 'number' ? String(timeout) : JSON.stringify(timeout);
    throw new Error(`timeout must be a non-negative, finite number of seconds, got ${shown}`);
  }

  // Validated before the root is resolved, so a failed call creates no directory.
  if (typeof skills === 'string' && skills !== '*') {
    throw new Error(`writeSkills takes an array of skills or the literal "*"; got ${JSON.stringify(skills)}`);
  }

  const deadline = performance.now() + timeout * 1000;
  const rootPath = await resolveRoot(root);

  // Pinned once and held for the whole reconcile. If the root was swapped since
  // `resolveRoot` validated it, the open fails: reported, not thrown.
  let rootHandle: FileHandle;
  try {
    rootHandle = await openDirectoryNoFollow(rootPath);
  } catch (error) {
    return createReconcileReport([runError(`the skills root could not be pinned: ${messageOf(error)}`)]);
  }

  try {
    return await reconcile(pin(rootPath, rootHandle), skills, { prune, timeout, onUnavailable, deadline });
  } finally {
    await rootHandle.close().catch(() => undefined);
  }
}

/** Everything `writeSkills` does once the managed root is pinned. */
async function reconcile(
  root: PinnedDirectory,
  skills: ReadonlyArray<Skill | SkillReference | string> | '*',
  options: { prune: boolean; timeout: number; onUnavailable: OnUnavailable; deadline: number },
): Promise<ReconcileReport> {
  const { prune, timeout, onUnavailable, deadline } = options;
  const { manifest, error: manifestError } = await loadManifest(root);
  const entries: Record<string, unknown> = (manifest.entries as Record<string, unknown>) ?? {};

  const actions: ReconcileAction[] = [];
  // Run-level failure: there is no single skill key to hang it off.
  if (manifestError !== null) actions.push(runError(manifestError));

  const { requests, incomplete: retrievalIncomplete } = await resolveRequests(skills, deadline, onUnavailable);

  const { actions: written, timedOut } = await writeAll(root, requests, entries, deadline, timeout);
  actions.push(...written);
  const incomplete = retrievalIncomplete || timedOut;

  // Remove temp files a killed reconcile left behind, before pruning so they
  // cannot block its `rmdir`. Skipped on a corrupt manifest or expired deadline.
  if (manifestError === null && performance.now() < deadline) {
    actions.push(...(await sweepOrphanTemps(root, sweepableKeys(requests, entries))));
  }

  // Prune only when the SDK knows both what it owns (manifest intact) and what is
  // current (retrieval and writes completed).
  if (prune && manifestError === null && !incomplete) {
    actions.push(...(await pruneEntries(root, entries, new Set(requests.map((r) => r.key)), deadline, timeout)));
  }

  if (manifestError === null) actions.push(...(await rewriteManifest(root, manifest, entries)));

  return createReconcileReport(actions);
}

/** A failure belonging to the run rather than to one skill (empty key). */
function runError(message: string): ReconcileAction {
  return createReconcileAction({ key: '', action: 'error', error: message });
}

/** A {@link directoryAddress} prefix as it appears inside an `errno` message. */
const DESCRIPTOR_ADDRESS_IN_MESSAGE = /\/proc\/self\/fd\/\d+\//g;

/**
 * An error's message with `/proc/self/fd/<fd>/` prefixes stripped, leaving names
 * relative to the pinned directory (e.g. `a/SKILL.md`).
 */
function messageOf(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(DESCRIPTOR_ADDRESS_IN_MESSAGE, '');
}

/**
 * Reconciles every pending write.
 *
 * Never aborts: a per-skill failure becomes an `error` action, so the manifest
 * rewrite still records every file already written.
 */
async function writeAll(
  root: PinnedDirectory,
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
          error: request.error ?? `skill ${shownKey(request.key)} could not be resolved`,
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
      // Safety net: an unexpected filesystem error must not abort the loop.
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
 * Rebuilds `value` with object keys sorted, matching the manifest the other
 * LaunchDarkly AI SDKs write so a shared root does not churn.
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
 * Non-ASCII UTF-16 code units, to be escaped as `\uXXXX` (astral characters
 * become surrogate pairs).
 */
const NON_ASCII = /[\u0080-\uffff]/g;

/**
 * Serializes the manifest in the on-disk form shared with the other LaunchDarkly
 * AI SDKs: two-space indent, sorted keys, non-ASCII escaped as `\uXXXX`, and no
 * trailing newline.
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
  root: PinnedDirectory,
  manifest: Record<string, unknown>,
  entries: Record<string, unknown>,
): Promise<ReconcileAction[]> {
  const updated = { ...manifest, manifestVersion: MANIFEST_VERSION, entries };
  try {
    // Inside the guard: unknown fields are round-tripped, so a deeply nested
    // planted field can throw here.
    const serialized = serializeManifest(updated);
    await atomicWrite(root.address, MANIFEST_FILENAME, serialized, root.handle);
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
    (item as Skill).content instanceof Uint8Array &&
    typeof (item as Skill).contentHash === 'string'
  );
}

/**
 * Turns the caller's input into one request per skill.
 *
 * Also reports whether any retrieval was incomplete (no store, an uninitialized
 * or throwing store, or an exhausted timeout). An `absent` reference is not
 * incomplete; it stays requested, so it is not pruned either. The flag
 * suppresses pruning, so an outage never deletes managed files.
 */
async function resolveRequests(
  skills: ReadonlyArray<Skill | SkillReference | string> | '*',
  deadline: number,
  onUnavailable: OnUnavailable,
): Promise<{ requests: PendingWrite[]; incomplete: boolean }> {
  if (typeof skills === 'string') {
    // Already checked by `writeSkills`; repeated here to narrow the type.
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

/** Retrieval could not happen at all; `blocked` is the caller-facing reason. */
type RetrievalBlocked = { readonly blocked: string };

function isBlocked(result: SkillStore | RetrievalBlocked): result is RetrievalBlocked {
  return 'blocked' in result;
}

/**
 * The configured store, or why retrieval must not be attempted.
 *
 * The single gate for both single references and `'*'`. It blocks on an
 * exhausted deadline, no configured store, or a store without its initial data;
 * each marks the run incomplete, which suppresses pruning.
 */
function availableStore(deadline: number, subject: string): SkillStore | RetrievalBlocked {
  if (performance.now() >= deadline) {
    return { blocked: unavailable(`the timeout was exhausted before ${subject} could be retrieved`) };
  }
  const store = getStore();
  if (store === null) return { blocked: unavailable(NO_STORE_MESSAGE) };
  if (!storeIsInitialized(store)) {
    // Before its first delivery a store answers "nothing", which `'*'` would
    // read as every skill revoked.
    return {
      blocked: unavailable(
        `the skill store has not received its initial data, so ${subject} could not be retrieved and nothing on ` +
          'disk was changed. Wait for delivery before reconciling: FDv2SkillStore.waitForSkills(timeoutMs) ' +
          'resolves true once the first payload has arrived.',
      ),
    };
  }
  return store;
}

/**
 * Resolves one reference for the materialization path.
 *
 * Same core as the accessors, but a blocked store (see {@link availableStore}) is
 * reported as unavailable rather than thrown.
 */
function resolveReference(key: string, wantedVersion: number | null, deadline: number): Resolution {
  const store = availableStore(deadline, `'${key}'`);
  if (isBlocked(store)) return { error: store.blocked, reason: 'store_unavailable', unavailable: true };

  const resolved = resolveFromStore(store, key, wantedVersion);
  if (resolved.unavailable && resolved.error) {
    return { error: unavailable(resolved.error), reason: resolved.reason, unavailable: true };
  }
  return resolved;
}

/**
 * One run-level retrieval failure — thrown, or reported against the empty key.
 *
 * Always marks the run incomplete, so nothing is pruned.
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
 * Unverifiable is not revoked: a failed object keeps its key in the requested
 * set, so prune leaves the last known-good copy on disk.
 */
function pendingForRaw(objectKey: string, raw: unknown): PendingWrite {
  const skill = verifyRawSkill(raw);
  if (skill) return { key: skill.key, skill };

  // Prefer the object's own key (the on-disk directory name); a custom store may
  // use a different map key, such as `key:version`.
  const candidate = typeof raw === 'object' && raw !== null ? (raw as RawSkillObject).key : undefined;
  const key = isValidSkillKey(candidate) ? candidate : objectKey;
  if (!isValidSkillKey(key)) {
    // No usable key: report at run level, which `resolveAll` treats as an
    // incomplete run.
    return { key: '', error: 'the skill store served an object under an invalid key; it was withheld' };
  }
  return {
    key,
    error: `skill '${key}' failed integrity verification and was withheld; the copy already on disk was left alone`,
  };
}

/** Resolves the `'*'` form — everything the store currently holds. */
function resolveAll(deadline: number, onUnavailable: OnUnavailable): { requests: PendingWrite[]; incomplete: boolean } {
  const store = availableStore(deadline, 'the skill set');
  if (isBlocked(store)) return unavailableRun(store.blocked, onUnavailable);

  // Not via allSkills(), which reports a throwing store as empty — that would
  // read as every skill revoked.
  const { objects, error } = allRawObjects(store);
  if (error !== null) return unavailableRun(unavailable(error), onUnavailable);

  // One object per key, at its newest version: each key has a single path.
  const requests = newestByKey(objects).map(({ objectKey, raw }) => pendingForRaw(objectKey, raw));
  // A failure with no key cannot protect its copy on disk, so it suppresses
  // pruning for the whole run.
  const unattributed = requests.some((request) => !request.skill && request.key === '');
  return { requests, incomplete: unattributed };
}

// -------------------------------------------------------------------------
// The managed root and its manifest
// -------------------------------------------------------------------------

/**
 * Resolves the managed root once, up front.
 *
 * Throws for an unusable root. Only the leaf directory is created, so a typo
 * cannot create a directory tree.
 *
 * A caller-error check, not a security boundary: the pin that `writeSkills` takes
 * immediately afterwards is what guards against a swap.
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
 * A manifest that cannot be read or parsed, is not an object, has a
 * `manifestVersion` outside `[1, MANIFEST_VERSION]`, or has a malformed `entries`
 * map is **corrupt**: the caller then takes no destructive action and leaves the
 * file alone. An absent manifest is a fresh root.
 *
 * Read through the pinned root; a symlink or FIFO at the manifest's name is
 * treated as corrupt rather than followed.
 */
async function loadManifest(
  root: PinnedDirectory,
): Promise<{ manifest: Record<string, unknown>; error: string | null }> {
  const fresh = { manifestVersion: MANIFEST_VERSION, entries: {} };

  let raw: Buffer;
  try {
    raw = await readRegularFile(path.join(root.address, MANIFEST_FILENAME), MAX_MANIFEST_BYTES);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { manifest: fresh, error: null };
    return {
      manifest: {},
      error: `the skills manifest ${MANIFEST_FILENAME} could not be read: ${messageOf(error)}`,
    };
  }
  // The read stops one byte past the cap, which is enough to detect an overage.
  if (raw.byteLength > MAX_MANIFEST_BYTES) {
    return {
      manifest: {},
      error: `the skills manifest ${MANIFEST_FILENAME} is larger than the ${MAX_MANIFEST_BYTES} byte cap; refusing every destructive action`,
    };
  }
  const text = raw.toString('utf-8');

  // Non-UTF-8 bytes decode as U+FFFD, so they surface as invalid JSON.
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
  // Bounded at both ends: a future schema cannot be interpreted, and versions
  // below 1 were never written.
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1 || version > MANIFEST_VERSION) {
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

/** How much of an untrusted key an error message echoes. */
const SHOWN_KEY_CHARS = 32;

/**
 * A key as shown in an error message: truncated to {@link SHOWN_KEY_CHARS} and
 * JSON-quoted so control characters are escaped.
 */
function shownKey(key: unknown): string {
  if (typeof key !== 'string') return JSON.stringify(key) ?? String(key);
  return key.length > SHOWN_KEY_CHARS ? `${JSON.stringify(key.slice(0, SHOWN_KEY_CHARS))}...` : JSON.stringify(key);
}

/**
 * Why `key` must not become a directory name under the managed root, or `null`.
 *
 * Always re-validated before any filesystem call, since a key becomes a path
 * component. Shared by the write and prune paths.
 */
function keyRejectionReason(key: unknown): string | null {
  if (!isValidSkillKey(key)) {
    return `${shownKey(key)} is not a valid skill key (^[a-z0-9][a-z0-9-]*$, at most ${SKILL_KEY_MAX_LENGTH} characters)`;
  }
  const keyBytes = Buffer.byteLength(key, 'utf-8');
  if (keyBytes > MAX_PATH_COMPONENT_BYTES) {
    return `skill key ${shownKey(key)} is ${keyBytes} bytes, over the ${MAX_PATH_COMPONENT_BYTES}-byte limit for a single directory name`;
  }
  // Checked here rather than in the key grammar, so one such key fails only its
  // own write rather than the whole AI Config.
  if (WINDOWS_RESERVED_NAMES.has(key)) {
    return `skill key '${key}' is a Windows reserved device name, which cannot be a directory name on that platform`;
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
 * Why `<root>/<key>/SKILL.md` must not be touched, or `null`.
 *
 * Shared by the write and prune paths. Defense in depth: these are path-based
 * checks, so the descriptor pin is the real boundary where available.
 * `requireDirectory` is set for writes, which need a real directory; a prune only
 * needs to not follow a link. `root` is a real path; `skillDir` and `target` are
 * addresses, which `realpath` resolves for the containment check.
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
    // Not yet on disk: resolve the parent and re-append the component.
    resolvedParent = path.join(await realpath(path.dirname(skillDir)), path.basename(skillDir));
  }
  if (path.dirname(resolvedParent) !== root) return `it resolves outside the managed root ${root}`;
  return null;
}

/** Reconciles one verified skill against the managed root. */
async function writeOne(
  root: PinnedDirectory,
  skill: Skill,
  entries: Record<string, unknown>,
): Promise<ReconcileAction> {
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

  // `skillDir` is addressed through the pinned root; `reportedPath` is the
  // caller-facing name.
  const skillDir = path.join(root.address, key);
  const target = path.join(skillDir, SKILL_FILENAME);
  const reportedPath = path.join(root.path, key, SKILL_FILENAME);
  const relative = `${key}/${SKILL_FILENAME}`;

  const unsafe = await unsafePathReason(root.path, skillDir, target, key, true);
  if (unsafe !== null) return failed(`'${relative}' was refused: ${unsafe}; nothing was written`);

  // Re-verify: a Skill can also be constructed directly by a caller.
  const verified = verifiedBytes(key, skill.content, skill.contentHash, skill.version);
  if (isVerificationFailure(verified)) {
    return failed(
      `skill '${key}' failed verification immediately before writing: ${verified.reason}; nothing was written`,
    );
  }
  const { encoded, contentHash } = verified;

  // Overwrite only what the manifest records as the SDK's under this key.
  const entry = entries[relative];
  const managed = typeof entry === 'object' && entry !== null && (entry as { key?: unknown }).key === key;
  const exists = await pathExists(target);

  let action: ReconcileActionKind = 'written';
  if (exists) {
    // Compare bytes before checking the manifest, so a file whose manifest entry
    // was never written (process killed mid-run) can be adopted below. Bounded
    // at the content length, since the file may be unmanaged and of any size.
    let onDisk: Buffer;
    try {
      onDisk = await readRegularFile(target, encoded.byteLength);
    } catch (error) {
      // A failed read must never become an overwrite.
      return failed(
        `'${relative}' exists but could not be read (${messageOf(error)}); refusing to overwrite a file whose current content is unknown`,
      );
    }

    if (createHash('sha256').update(onDisk).digest('hex') === contentHash) {
      // Adoption: a file byte-identical to the resolved content is recorded as
      // managed even without a manifest entry. Only exact matches are adopted.
      // Nothing was written, so `writtenAt` is kept if already set.
      updateEntry(entries, relative, skill, contentHash, false);
      recordMaterialized(key, encoded.byteLength, contentHash, 'skipped_current');
      return createReconcileAction({ key, action: 'skipped_current', version: skill.version, path: reportedPath });
    }

    if (!managed) {
      return failed(
        `'${relative}' exists but the manifest does not record it as managed under key '${key}'; refusing to overwrite a file this SDK did not write`,
      );
    }
    // Stale version or local tampering — LD-resolved content wins.
    action = 'updated';
  }

  const writeError = await writeThroughPinnedDirectory(skillDir, encoded, key, relative);
  if (writeError !== null) return failed(writeError);

  updateEntry(entries, relative, skill, contentHash, true);
  recordMaterialized(key, encoded.byteLength, contentHash, action);
  return createReconcileAction({ key, action, version: skill.version, path: reportedPath });
}

/**
 * Reads `target`, refusing anything that is not a regular file.
 *
 * - `O_NONBLOCK`: opening a FIFO with no writer would otherwise hang forever.
 * - `O_NOFOLLOW`: refuses a trailing symlink.
 * - The type check uses `stat` on the handle, not the path.
 *
 * Reads at most `maxBytes + 1` bytes; the extra byte keeps a longer file from
 * hashing equal to its prefix. `maxBytes` is required so no call site can read
 * unbounded.
 *
 * Throws for anything the caller must turn into a refusal.
 */
async function readRegularFile(target: string, maxBytes: number): Promise<Buffer> {
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0);
  const handle = await open(target, flags);
  try {
    if (!(await handle.stat()).isFile()) throw new Error('the path is not a regular file');
    // Buffer sized to the bound, not the file; looped since `read` may return short.
    const limit = maxBytes + 1;
    const buffer = Buffer.alloc(limit);
    let filled = 0;
    while (filled < limit) {
      const { bytesRead } = await handle.read(buffer, filled, limit - filled, filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    return buffer.subarray(0, filled);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * Writes `SKILL.md`. Returns a failure reason, or `null` on success.
 *
 * Opens (or creates) and pins the skill directory, then writes relative to that
 * handle so a swapped directory name cannot redirect the write.
 */
async function writeThroughPinnedDirectory(
  skillDir: string,
  encoded: Uint8Array,
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
    await atomicWrite(directoryAddress(handle, skillDir), SKILL_FILENAME, encoded, handle);
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
 * Merges into any existing entry so fields written by a newer SDK release
 * survive. `sha256` and `writtenAt` are informational; currency is always decided
 * by hashing the bytes on disk. `touch` refreshes `writtenAt`.
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
 * A prune refusal.
 *
 * `version` comes from the untrusted manifest, so an invalid one is reported as
 * `null`, the same as for a `removed` action.
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
 * This is how revocation takes effect. The deadline is checked per entry; an
 * entry left unpruned is reported as an error and stays in the manifest for the
 * next reconcile.
 */
async function pruneEntries(
  root: PinnedDirectory,
  entries: Record<string, unknown>,
  requested: ReadonlySet<string>,
  deadline: number,
  timeout: number,
): Promise<ReconcileAction[]> {
  const actions: ReconcileAction[] = [];

  for (const [relative, entry] of Object.entries(entries)) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const { key } = record;
    if (typeof key !== 'string' || requested.has(key)) continue;

    if (performance.now() >= deadline) {
      actions.push(
        pruneError(
          key,
          `the ${timeout}s timeout was exhausted before '${relative}' could be pruned; it was left in place`,
          record.version,
        ),
      );
      continue;
    }

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
  root: PinnedDirectory,
  relative: string,
  key: string,
  entries: Record<string, unknown>,
): Promise<ReconcileAction> {
  const skillDir = path.join(root.address, key);
  const target = path.join(skillDir, SKILL_FILENAME);
  const reportedPath = path.join(root.path, key, SKILL_FILENAME);
  const version = (entries[relative] as Record<string, unknown>).version;

  const unsafe = await unsafePathReason(root.path, skillDir, target, key, false);
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
      await unlinkNoFollow(directoryAddress(handle, skillDir), SKILL_FILENAME, handle);
    } catch (error) {
      return pruneError(key, `'${relative}' could not be removed: ${messageOf(error)}`, version);
    } finally {
      await handle.close().catch(() => undefined);
    }
    removedFromDisk = true;
    // Through the pinned root; rmdir refuses a symlink and a non-empty
    // directory, and a non-empty directory is expected, so failure is ignored.
    await rmdir(skillDir).catch(() => undefined);
  }

  delete entries[relative];

  // Raw manifest values: `recordRevoked` validates them itself.
  if (removedFromDisk) recordRevoked(key, version);

  return createReconcileAction({
    key,
    action: 'removed',
    version: isValidSkillVersion(version) ? version : null,
    path: reportedPath,
  });
}

// -------------------------------------------------------------------------
// Orphaned temp files
// -------------------------------------------------------------------------

/**
 * Every key whose directory may hold an orphaned temp file: the requested set plus
 * every manifest key (including those prune is about to remove).
 */
function sweepableKeys(requests: readonly PendingWrite[], entries: Record<string, unknown>): Set<string> {
  const keys = new Set<string>();
  for (const request of requests) {
    // The empty key is the run-level sentinel, not a directory name.
    if (request.key !== '') keys.add(request.key);
  }
  for (const entry of Object.values(entries)) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    const { key } = entry as Record<string, unknown>;
    if (typeof key === 'string') keys.add(key);
  }
  return keys;
}

/** Sweeps each key's directory. Failures are reported, never thrown. */
async function sweepOrphanTemps(root: PinnedDirectory, keys: ReadonlySet<string>): Promise<ReconcileAction[]> {
  const actions: ReconcileAction[] = [];
  for (const key of keys) actions.push(...(await sweepSkillDirectory(root, key)));
  return actions;
}

/**
 * Removes temp files a killed reconcile left behind under `<root>/<key>/`.
 *
 * This is the only removal of a file the manifest does not list, so it is
 * tightly bounded: a valid key's directory only, only names
 * {@link tempNamePattern} matches, only regular files, all via the pinned handle.
 * A missing or non-directory path is skipped; only a failed removal is reported.
 */
async function sweepSkillDirectory(root: PinnedDirectory, key: string): Promise<ReconcileAction[]> {
  if (keyRejectionReason(key) !== null) return [];

  const skillDir = path.join(root.address, key);
  const pattern = tempNamePattern(SKILL_FILENAME);

  let handle: Awaited<ReturnType<typeof openDirectoryNoFollow>>;
  try {
    handle = await openDirectoryNoFollow(skillDir);
  } catch {
    return [];
  }

  // List and unlink through the same pinned handle.
  const inside = directoryAddress(handle, skillDir);

  const actions: ReconcileAction[] = [];
  try {
    let names: string[];
    try {
      names = await readdir(inside);
    } catch {
      return [];
    }
    for (const name of names) {
      if (!pattern.test(name)) continue;
      try {
        // Never a symlink and never a directory, whatever the name says.
        if (!(await lstat(path.join(inside, name))).isFile()) continue;
        await unlinkNoFollow(inside, name, handle);
      } catch (error) {
        actions.push(
          createReconcileAction({
            key,
            action: 'error',
            error: `an orphaned temporary file '${key}/${name}' could not be removed: ${messageOf(error)}`,
          }),
        );
      }
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
  return actions;
}
