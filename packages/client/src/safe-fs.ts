/**
 * Symlink-refusing filesystem primitives for writing files under a directory
 * another process may be racing to replace.
 *
 * A path check is only as good as the last path resolution after it. Which of
 * the two implementations runs is a platform property:
 *
 * - **Linux — the swap window is closed.** A directory is pinned to a descriptor
 *   and its children are addressed as `/proc/self/fd/<fd>/<name>`, which the
 *   kernel resolves from the pinned inode, not the name. Gated on
 *   {@link SUPPORTS_PROC_FD}.
 * - **Everywhere else — the window is narrowed, not closed.** Directories are
 *   opened with `O_NOFOLLOW`, temp files are created exclusively in the target's
 *   own directory, and the pinned directory's identity is re-checked just before
 *   each destructive step.
 *
 * Windows is not a supported platform: reparse-point checks are not implemented.
 *
 * Off the Linux fast path, write permission on the managed root **or any of its
 * ancestors** is the security boundary; the README's privilege-separated
 * deployment (reconcile identity separate from agent identity) is the mitigation.
 */

import { randomBytes } from 'node:crypto';
import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, statSync } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { type FileHandle, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** Mode set explicitly on every written file: never from the umask, never executable. */
const FILE_MODE = 0o644;

/**
 * Mode set explicitly on every directory this module creates, because `mkdir`'s
 * mode argument is masked by the umask: under `0077` a separate agent identity
 * could not traverse the directory to read what is inside.
 */
const DIRECTORY_MODE = 0o755;

/** Bound on the `O_EXCL` retry loop; with 64-bit random names it only keeps the loop finite. */
const TEMP_NAME_ATTEMPTS = 5;

/** The `*at()` members a descriptor-relative implementation would need. */
const AT_FAMILY = ['renameat', 'unlinkat', 'openat'] as const;

/**
 * Whether this runtime offers descriptor-relative rename, unlink and open (the
 * `*at()` syscall family), which would close the symlink-swap window.
 *
 * `false` on every Node release to date. Off {@link SUPPORTS_PROC_FD}, that
 * leaves a residual race: someone with write permission on the managed root can
 * swap a validated directory for a symlink between the identity check and the
 * path-based operation. Probed rather than hardcoded so a descriptor-relative
 * path can be added if Node ships the family.
 */
export const SUPPORTS_DIR_FD: boolean = (() => {
  // Spread rather than index the namespace: bundlers and module proxies reject
  // reading an absent export, while a spread only enumerates the ones that exist.
  const exported: Record<string, unknown> = { ...fsPromises };
  return AT_FAMILY.every((name) => typeof exported[name] === 'function');
})();

/** procfs's per-process descriptor table, where each open fd appears as a magic symlink. */
const PROC_SELF_FD = '/proc/self/fd';

/**
 * Whether children can be addressed through a held descriptor as
 * `/proc/self/fd/<fd>/<name>`.
 *
 * The kernel resolves `/proc/self/fd/<fd>` to the inode the descriptor holds,
 * so renaming or symlinking the directory afterwards cannot redirect the
 * operation — the same guarantee as an `*at()` call.
 *
 * `false` off Linux (macOS's `/dev/fd/<fd>` is not traversable) and on Linux
 * without a mounted `/proc`. Probed for real, checking that the entry is a magic
 * symlink resolving to the pinned inode, because the swap-race tests are gated
 * on it.
 */
export const SUPPORTS_PROC_FD: boolean = (() => {
  if (process.platform !== 'linux') return false;
  let fd: number | null = null;
  try {
    fd = openSync(tmpdir(), fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0));
    if (!lstatSync(`${PROC_SELF_FD}/${fd}`).isSymbolicLink()) return false;
    const pinned = fstatSync(fd, { bigint: true });
    const resolved = statSync(`${PROC_SELF_FD}/${fd}`, { bigint: true });
    return resolved.dev === pinned.dev && resolved.ino === pinned.ino;
  } catch {
    return false;
  } finally {
    if (fd !== null) closeSync(fd);
  }
})();

/**
 * The prefix to build child paths on for a directory this process holds open:
 * the descriptor address on the fast path, `realPath` otherwise.
 *
 * For the filesystem only — never show it in a report or error message.
 */
export function directoryAddress(handle: FileHandle, realPath: string): string {
  return SUPPORTS_PROC_FD ? `${PROC_SELF_FD}/${handle.fd}` : realPath;
}

/**
 * Whether `directory` is exactly the {@link directoryAddress} for `handle`.
 *
 * Exact equality, because a `true` here skips the identity re-check in
 * {@link assertUnswapped}. Any other `/proc/self/fd` path (another descriptor,
 * a child, a trailing slash, `..`) throws as a caller error. Exported for tests;
 * not API.
 */
export function isDescriptorAddressed(directory: string, handle: FileHandle): boolean {
  if (directory === `${PROC_SELF_FD}/${handle.fd}`) return true;
  if (directory === PROC_SELF_FD || directory.startsWith(`${PROC_SELF_FD}/`)) {
    throw new Error(
      `a descriptor address must be exactly ${PROC_SELF_FD}/<fd> for the pinned handle; got ${JSON.stringify(directory)}`,
    );
  }
  return false;
}

/**
 * Refuses a `name` that is not a single path component. A separator, `.` or
 * `..` would escape the pinned directory.
 */
function assertSingleComponent(name: string): void {
  if (name === '' || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
    throw new Error(`name must be a single path component, got ${JSON.stringify(name)}`);
  }
}

/**
 * The destructive filesystem operations, as a replaceable record so tests can
 * intercept them (`vi.spyOn` cannot replace module-local calls under Vite's ESM
 * transform).
 */
export const fsOps = {
  rename(src: string, dst: string): Promise<void> {
    return rename(src, dst);
  },
  unlink(target: string): Promise<void> {
    return unlink(target);
  },
};

/** `(dev, ino)` — a directory's identity, independent of its name. */
export type DirectoryIdentity = { dev: number; ino: bigint };

async function identityOf(handle: FileHandle): Promise<DirectoryIdentity> {
  const info = await handle.stat({ bigint: true });
  return { dev: Number(info.dev), ino: info.ino };
}

/**
 * Opens `directory` without following a final symlink, and pins it.
 *
 * `O_NOFOLLOW` refuses a symlink at open time. The explicit `isDirectory` check
 * covers platforms without `O_DIRECTORY`.
 *
 * Throws when the path will not open as a real directory.
 */
export async function openDirectoryNoFollow(directory: string): Promise<FileHandle> {
  const flags = fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | (fsConstants.O_NOFOLLOW ?? 0);
  let handle: FileHandle;
  try {
    handle = await open(directory, flags);
  } catch (error) {
    throw new Error(
      `the directory could not be opened without following links: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    if (!(await handle.stat()).isDirectory()) throw new Error('the path is not a directory');
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
  return handle;
}

/**
 * Creates `directory` if absent and returns a handle pinned to it.
 *
 * Uses a plain `mkdir` plus an `lstat` on `EEXIST`, because
 * `mkdir(..., { recursive: true })` accepts an existing symlink-to-directory.
 */
export async function openOrCreateDirectory(directory: string): Promise<FileHandle> {
  let created = false;
  try {
    await mkdir(directory, DIRECTORY_MODE);
    created = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const info = await lstat(directory);
    if (info.isSymbolicLink()) throw new Error('the directory is a symlink');
    if (!info.isDirectory()) throw new Error('the path is not a directory');
  }
  const handle = await openDirectoryNoFollow(directory);
  // Only a directory this call created: an existing one keeps the mode its
  // owner gave it. Set on the handle, never chmod on the path, which a swap
  // between mkdir and open could redirect.
  if (created) {
    try {
      await handle.chmod(DIRECTORY_MODE);
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
  }
  return handle;
}

/**
 * Confirms `directory` still resolves to the inode `handle` was pinned to.
 *
 * Off {@link SUPPORTS_PROC_FD} this narrows the swap window to the gap before
 * the next path-based operation; it cannot close it.
 *
 * Skipped for a {@link directoryAddress} on the fast path: the kernel already
 * resolves from the pinned inode, and `lstat` of `/proc/self/fd/<fd>` reports a
 * symlink, so the check would fail anyway.
 */
async function assertUnswapped(directory: string, handle: FileHandle): Promise<void> {
  if (isDescriptorAddressed(directory, handle)) return;
  const pinned = await identityOf(handle);
  const onDisk = await lstat(directory, { bigint: true });
  if (!onDisk.isDirectory() || Number(onDisk.dev) !== pinned.dev || onDisk.ino !== pinned.ino) {
    throw new Error('the directory was replaced while it was being written to');
  }
}

/** Random bytes behind every temp name. Hex-encoded, so twice this many characters. */
const TEMP_NAME_RANDOM_BYTES = 8;

/** An unpredictable temp name, so a planted path is never the one we write. */
function tempName(target: string): string {
  return `.${target}.${randomBytes(TEMP_NAME_RANDOM_BYTES).toString('hex')}.tmp`;
}

/**
 * Matches exactly the names {@link tempName} produces for `target`, anchored at
 * both ends.
 *
 * The orphan sweep in `skills-fs.ts` uses this to decide what it may delete, so
 * it is derived from the generator rather than copied. Anchoring keeps it from
 * matching e.g. `.SKILL.md.<hex>.tmp.keep-this`.
 */
export function tempNamePattern(target: string): RegExp {
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^\\.${escaped}\\.[0-9a-f]{${TEMP_NAME_RANDOM_BYTES * 2}}\\.tmp$`);
}

/**
 * Writes `data` to `<directory>/<name>` so no partial file is ever observable.
 *
 * The temp file is created exclusively in the target's own directory (so the
 * rename is not cross-device), written, fsynced, renamed over the target, and
 * the directory fsynced so the rename survives a crash. The mode is set on the
 * handle, so a swap of the temp path cannot redirect it, and is never executable.
 *
 * Off {@link SUPPORTS_PROC_FD}, the directory's identity is re-checked before the
 * temp file is opened and again before the rename. This narrows the race but
 * does not close it.
 */
export async function atomicWrite(
  directory: string,
  name: string,
  data: Uint8Array,
  pinned: FileHandle,
): Promise<void> {
  assertSingleComponent(name);
  const target = path.join(directory, name);
  const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0);

  await assertUnswapped(directory, pinned);

  let temp = '';
  let handle: FileHandle | null = null;
  for (let attempt = 0; attempt < TEMP_NAME_ATTEMPTS; attempt += 1) {
    const candidate = path.join(directory, tempName(name));
    try {
      handle = await open(candidate, flags, 0o600);
      temp = candidate;
      break;
    } catch (error) {
      // O_EXCL: an existing temp path is never reused, nor written through.
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  if (handle === null) throw new Error('no usable temporary file name was found');

  try {
    try {
      await handle.chmod(FILE_MODE);
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await assertUnswapped(directory, pinned);
    await fsOps.rename(temp, target);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }

  await fsyncDirectory(pinned);
}

/**
 * Removes `<directory>/<name>`, refusing to follow a symlink at `name`.
 *
 * `unlink` resolves the directory above the name, so a swapped `<directory>`
 * would otherwise delete an attacker-chosen file. Pass a {@link directoryAddress}
 * to close that window; off {@link SUPPORTS_PROC_FD} the identity re-check only
 * narrows it.
 *
 * Throws when `name` is a symlink.
 */
export async function unlinkNoFollow(directory: string, name: string, pinned: FileHandle): Promise<void> {
  assertSingleComponent(name);
  const target = path.join(directory, name);
  if ((await lstat(target)).isSymbolicLink()) throw new Error('the target file is a symlink');
  await assertUnswapped(directory, pinned);
  await fsOps.unlink(target);
}

/** Best effort — not every platform allows fsync on a directory handle. */
async function fsyncDirectory(handle: FileHandle): Promise<void> {
  await handle.sync().catch(() => undefined);
}
