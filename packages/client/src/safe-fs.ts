/**
 * Symlink-refusing filesystem primitives.
 *
 * Split out because none of this knows what a skill is: it is the "write a file
 * under a directory an attacker may be racing you for" problem, solved once.
 * `skills-fs.ts` is the only caller today.
 *
 * The whole point is that a path check is only as good as the last path
 * resolution after it. There are two implementations of that idea here, and which
 * one runs is a platform property rather than a configuration choice:
 *
 * - **Linux — the swap window is closed.** Node exposes no `*at()` family (see
 *   {@link SUPPORTS_DIR_FD}), but it does not need one: a directory is pinned to a
 *   descriptor and its children are addressed as `/proc/self/fd/<fd>/<name>`,
 *   which the kernel resolves from the pinned *inode* rather than from the name.
 *   Renaming or symlinking the directory afterwards cannot redirect the
 *   operation. Gated on {@link SUPPORTS_PROC_FD}.
 * - **Everywhere else — the window is narrowed, not closed.** A per-component
 *   `lstat` check, hardened as far as Node allows: every directory is opened with
 *   `O_NOFOLLOW`, every temp file is created exclusively in the target's own
 *   directory, and the pinned directory's identity is re-checked immediately
 *   before each destructive step. That last check is the floor, and a floor is not
 *   a fix — see {@link SUPPORTS_DIR_FD}.
 *
 * Windows is additionally not a supported or tested platform for this release:
 * reparse-point checks (`GetFileAttributesW`, or opening with
 * `FILE_FLAG_OPEN_REPARSE_POINT`) are **not implemented, by decision rather than
 * oversight**, since neither SDK repository has a Windows CI runner and Node
 * gives this module no primitive that would make them meaningful. That is also
 * why a Linux-only fast path is an acceptable shape for the fix rather than a
 * half-measure: the platforms it leaves on the floor are macOS, which is a
 * development target, and Windows, which is out of scope.
 *
 * The consequence for the platforms on the floor is a single sentence, and it
 * belongs in every deployment review: write permission on the managed root **or
 * on any of its ancestors** is *the* security boundary for skills
 * materialization, so the privilege-separated deployment the README
 * documents — reconcile identity separate from agent identity — is not advice but
 * the mitigation. Relatedly, this bound retroactively lowers the priority of the
 * Windows reserved-device-name work in `skills-fs.ts`: that code stays, because
 * it keeps a managed root written on Linux usable when read from Windows, but it
 * is not evidence that Windows is a hardened target. It is not.
 */

import { randomBytes } from 'node:crypto';
import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, statSync } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { type FileHandle, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Mode set explicitly on every written file — never inherited from the umask, and
 * never executable.
 */
const FILE_MODE = 0o644;

/** Attempts before giving up on finding an unused temp name. */
const TEMP_NAME_ATTEMPTS = 128;

/** The `*at()` members a descriptor-relative implementation would need. */
const AT_FAMILY = ['renameat', 'unlinkat', 'openat'] as const;

/**
 * Whether this runtime offers a descriptor-relative rename, unlink, and open — the
 * `*at()` syscall family.
 *
 * The Python SDK uses it to close the symlink-swap window rather than merely
 * narrow it: a descriptor refers to the inode that was checked,
 * so replacing `<root>/<key>` with a symlink after the check cannot redirect a
 * write or an unlink out of the root.
 *
 * **Node exposes none of it.** `fs` and `fs/promises` have no `renameat`,
 * `unlinkat`, or `openat`, and `FileHandle` has no `rename` or `unlink` — a
 * descriptor can be held, but nothing destructive can be addressed relative to
 * it. So this is `false` on every Node release to date, and a residual exposure
 * follows: an attacker with write
 * permission on the managed root can still swap a validated directory for a
 * symlink between the identity check below and the path-based operation.
 *
 * A genuine feature probe rather than a hardcoded `false`, for two reasons: the
 * swap-race tests are skipped off this same constant, so a hardcoded
 * answer would let a wrong one silently skip the tests that would have caught it;
 * and if Node ever ships the family, this flips and the descriptor-relative path
 * can be added behind it without touching the public API.
 */
export const SUPPORTS_DIR_FD: boolean = (() => {
  // Spread into a plain object rather than indexing the namespace directly:
  // reading an *absent* export off a module namespace is exactly the access
  // pattern that bundlers and test-time module proxies reject, and a probe that
  // throws on the answer "no" is worse than useless. A spread enumerates only
  // the exports that exist, so a missing one reads back as `undefined`.
  const exported: Record<string, unknown> = { ...fsPromises };
  return AT_FAMILY.every((name) => typeof exported[name] === 'function');
})();

/** procfs's per-process descriptor table, where each open fd appears as a magic symlink. */
const PROC_SELF_FD = '/proc/self/fd';

/**
 * Whether children can be addressed relative to a held descriptor by *path*,
 * through `/proc/self/fd/<fd>/<name>`.
 *
 * This is the way around {@link SUPPORTS_DIR_FD} on Linux. Node cannot pass a
 * directory descriptor to `rename`, `unlink` or `open` — but it does not have to:
 * the kernel resolves the `/proc/self/fd/<fd>` component to *the inode the
 * descriptor holds*, not to the name it was opened under. So a path built on that
 * prefix has the same property an `*at()` call would: renaming or symlinking the
 * directory's name afterwards cannot redirect the operation, because the name is
 * no longer part of the resolution. Every remaining component gets the usual
 * `O_NOFOLLOW` treatment.
 *
 * `false` off Linux, where procfs does not exist — macOS has `/dev/fd/<fd>`, but
 * it is not a directory-traversable prefix, so `/dev/fd/<fd>/<name>` does not
 * resolve and there is nothing to gate on. Those platforms keep the per-component
 * `lstat` floor described at {@link SUPPORTS_DIR_FD}, and for them write
 * permission on the managed root *and its ancestors* remains the security
 * boundary. Windows is not a supported platform for this release (see the module
 * docblock), so a Linux-only fast path is the accepted design rather than a gap.
 *
 * A genuine probe rather than a platform string alone, for the same reason
 * {@link SUPPORTS_DIR_FD} is: the swap-race tests are gated on this constant, so a
 * wrong hardcoded answer would silently skip the tests that would have caught it.
 * Linux without a mounted `/proc` — some minimal containers — answers `false` here
 * and falls back correctly. The probe checks the property the fast path actually
 * depends on: that the entry is procfs's magic symlink, and that resolving it
 * reaches the very inode the descriptor is pinned to.
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
 * The prefix to build child paths on for a directory this process holds open.
 *
 * Returns the descriptor address on the fast path and `realPath` otherwise, so a
 * caller writes `path.join(directoryAddress(handle, dir), name)` once and gets
 * descriptor-relative addressing where the platform has it and the previous
 * path-based behaviour where it does not.
 *
 * The returned string is for the *filesystem*, not for people: it is never what a
 * report or an error message should show a caller. `skills-fs.ts` keeps the real
 * path alongside it for that.
 */
export function directoryAddress(handle: FileHandle, realPath: string): string {
  return SUPPORTS_PROC_FD ? `${PROC_SELF_FD}/${handle.fd}` : realPath;
}

/** Whether `directory` is a descriptor address rather than an ordinary path. */
function isDescriptorAddressed(directory: string): boolean {
  return directory === PROC_SELF_FD || directory.startsWith(`${PROC_SELF_FD}/`);
}

/**
 * The destructive filesystem operations, as a replaceable record.
 *
 * The final rename and the prune unlink must each be a single interceptable call
 * site, so tests can prove that an injected failure is what produced an error, that no
 * operation was attempted for a rejected key, and that a directory swapped at the
 * instant of the operation cannot redirect it. `vi.spyOn` cannot replace a direct
 * call to a module-local function under Vite's ESM transform, so the calls are
 * made as properties of this object — which *is* the hook. Not exported from the
 * package index.
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
 * `O_NOFOLLOW` makes the *open* refuse a symlink outright, which is stronger than
 * an `lstat` followed by a second path resolution. `O_DIRECTORY` guarantees the
 * target is a directory wherever the platform defines it; the explicit `isDirectory`
 * check covers the platforms that do not.
 *
 * Throws when the path will not open as a real directory — the caller reports that
 * as a refusal rather than letting it escape.
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
 * `mkdir(..., { recursive: true })` treats an existing symlink-to-directory as
 * "already there", which would re-open the very hole the caller's check just
 * closed. A plain `mkdir` plus an `lstat` on the `EEXIST` path does not: a link
 * reports as a link, and is refused.
 */
export async function openOrCreateDirectory(directory: string): Promise<FileHandle> {
  try {
    await mkdir(directory, 0o755);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const info = await lstat(directory);
    if (info.isSymbolicLink()) throw new Error('the directory is a symlink');
    if (!info.isDirectory()) throw new Error('the path is not a directory');
  }
  return openDirectoryNoFollow(directory);
}

/**
 * Confirms `directory` still resolves to the inode `handle` was pinned to.
 *
 * The floor for platforms without {@link SUPPORTS_PROC_FD}. It narrows the
 * symlink-swap window to the interval between this check and the path-based
 * operation that follows; it does not close it, because Node cannot address a
 * rename or an unlink relative to a descriptor. Narrowing is not a fix, which is
 * why the exposure is documented at {@link SUPPORTS_DIR_FD} rather than claimed
 * away.
 *
 * Skipped — not weakened — when the caller addressed `directory` through
 * {@link directoryAddress} on the fast path. There the kernel resolved the path
 * *from* the pinned inode, so there is no name left for a swap to have redirected
 * and nothing for a second resolution to disagree with. Running the check anyway
 * would also fail outright: `lstat` of `/proc/self/fd/<fd>` reports procfs's magic
 * symlink, not a directory.
 */
async function assertUnswapped(directory: string, handle: FileHandle): Promise<void> {
  if (isDescriptorAddressed(directory)) return;
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
 * Exported so the orphaned-temp sweep in `skills-fs.ts` derives its pattern from
 * the generator instead of carrying a second copy of the naming rule. That sweep
 * is only allowed to unlink a file because its *name* identifies it as one this
 * module created, so the day two spellings of the rule drift is the day the sweep
 * either stops finding orphans or starts removing something it did not write.
 * Anchored at both ends for the same reason: an unanchored match would also
 * accept `.SKILL.md.<hex>.tmp.keep-this`.
 */
export function tempNamePattern(target: string): RegExp {
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^\\.${escaped}\\.[0-9a-f]{${TEMP_NAME_RANDOM_BYTES * 2}}\\.tmp$`);
}

/**
 * Writes `data` to `<directory>/<name>` so no partial file is ever observable.
 *
 * The temp file is created exclusively in the target's *own* directory — one
 * anywhere else would make the rename cross-device, and therefore not atomic —
 * written, fsynced, renamed over the target, and the directory fsynced so the
 * rename itself survives a crash. Mode is set on the *handle* rather than the
 * path, so it cannot be redirected by anything swapping the temp path underneath
 * us, and it is independent of the process umask.
 *
 * `fsOps.rename` is the one and only rename call site, so tests can intercept it.
 */
export async function atomicWrite(
  directory: string,
  name: string,
  data: Uint8Array,
  pinned: FileHandle,
): Promise<void> {
  const target = path.join(directory, name);
  const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0);

  let temp = '';
  let handle: FileHandle | null = null;
  for (let attempt = 0; attempt < TEMP_NAME_ATTEMPTS; attempt += 1) {
    const candidate = path.join(directory, tempName(name));
    try {
      handle = await open(candidate, flags, 0o600);
      temp = candidate;
      break;
    } catch (error) {
      // O_EXCL: an existing temp path is never reused, and a planted one is
      // never written through.
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
 * Removes `<directory>/<name>` without following a trailing symlink.
 *
 * `unlink` never follows a *trailing* symlink, so a symlinked target would have
 * the link removed rather than its victim — but it does resolve the directory
 * above it, which is what makes a swapped `<root>/<key>` a delete primitive with
 * an attacker-chosen target. Pass a `directory` produced by
 * {@link directoryAddress} and that resolution starts at the pinned inode, which
 * closes the window; off {@link SUPPORTS_PROC_FD} the identity re-check narrows it
 * as far as Node permits without closing it.
 *
 * `fsOps.unlink` is the one and only unlink call site for a managed file, so tests
 * can intercept it.
 */
export async function unlinkNoFollow(directory: string, name: string, pinned: FileHandle): Promise<void> {
  const target = path.join(directory, name);
  if ((await lstat(target)).isSymbolicLink()) throw new Error('the target file is a symlink');
  await assertUnswapped(directory, pinned);
  await fsOps.unlink(target);
}

/** Best effort — not every platform allows fsync on a directory handle. */
async function fsyncDirectory(handle: FileHandle): Promise<void> {
  await handle.sync().catch(() => undefined);
}
