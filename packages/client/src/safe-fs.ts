/**
 * Symlink-refusing filesystem primitives.
 *
 * Split out because none of this knows what a skill is: it is the "write a file
 * under a directory an attacker may be racing you for" problem, solved once.
 * `skills-fs.ts` is the only caller today.
 *
 * The whole point is that a path check is only as good as the last path
 * resolution after it. **On this runtime that problem cannot be fully solved**,
 * and the limitation is a property of Node rather than of this code — see
 * {@link SUPPORTS_DIR_FD}. What is implemented here is a per-component `lstat`
 * check, hardened as far as Node allows: every directory is
 * opened with `O_NOFOLLOW`, every temp file is created exclusively in the
 * target's own directory, and the pinned directory's identity is re-checked
 * immediately before each destructive step.
 *
 * **Platform bound — the floor is what runs everywhere, deliberately.** The
 * Python SDK closes the swap window on POSIX with a descriptor walk; this module
 * cannot, on any platform, because Node exposes no `*at()` family at all (see
 * {@link SUPPORTS_DIR_FD}). So unlike Python, where the racy floor is the
 * Windows-only fallback, here it is the *only* implementation — Linux included.
 * Windows is additionally not a supported or tested platform for this release:
 * reparse-point checks (`GetFileAttributesW`, or opening with
 * `FILE_FLAG_OPEN_REPARSE_POINT`) are **not implemented, by decision rather than
 * oversight**, since neither SDK repository has a Windows CI runner and Node
 * gives this module no primitive that would make them meaningful.
 *
 * The consequence is a single sentence, and it belongs in every deployment
 * review: write permission on the managed root is *the* security boundary for
 * skills materialization, so the privilege-separated deployment the README
 * documents — reconcile identity separate from agent identity — is not advice but
 * the mitigation. Relatedly, this bound retroactively lowers the priority of the
 * Windows reserved-device-name work in `skills-fs.ts`: that code stays, because
 * it keeps a managed root written on Linux usable when read from Windows, but it
 * is not evidence that Windows is a hardened target. It is not.
 */

import { randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { type FileHandle, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
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
 * This is the honest limit of what Node offers. It narrows the symlink-swap
 * window to the interval between this check and the path-based operation that follows;
 * it does not close it, because Node cannot address a rename or an unlink relative
 * to a descriptor. Narrowing is not a fix, which is why the exposure is
 * documented at {@link SUPPORTS_DIR_FD} rather than claimed away.
 */
async function assertUnswapped(directory: string, handle: FileHandle): Promise<void> {
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
 * `atomicWrite` against a directory this module does not already hold open.
 *
 * Used for the skills manifest, whose directory is the managed root. The handle is
 * taken with `O_NOFOLLOW`, so a root swapped for a symlink after the caller
 * validated it fails the write instead of redirecting it — the caller turns that
 * into a run-level `error` action.
 */
export async function atomicWriteIn(directory: string, name: string, data: Uint8Array): Promise<void> {
  const handle = await openDirectoryNoFollow(directory);
  try {
    await atomicWrite(directory, name, data, handle);
  } finally {
    await handle.close();
  }
}

/**
 * Removes `<directory>/<name>` without following a trailing symlink.
 *
 * `unlink` never follows a *trailing* symlink, so a symlinked target would have
 * the link removed rather than its victim — but it does resolve the directory
 * above it, which is what makes a swapped `<root>/<key>` a delete primitive with
 * an attacker-chosen target. The identity re-check narrows that window as far as
 * Node permits; see {@link SUPPORTS_DIR_FD} for why it cannot be closed here.
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
