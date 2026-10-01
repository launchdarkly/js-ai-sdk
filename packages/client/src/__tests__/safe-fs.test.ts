/**
 * The filesystem primitives, tested directly: atomicity, exclusive temp creation,
 * `0644`, and symlink refusal.
 *
 * Needs `vi.mock('node:fs/promises')` to observe the flags a file is *opened*
 * with, which has to be hoisted above the module under test.
 */

import { constants as fsConstants } from 'node:fs';
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { openCalls, collide } = vi.hoisted(() => ({
  openCalls: [] as Array<{ target: string; flags: number }>,
  collide: { remainingTempFailures: 0 },
}));

vi.mock('node:fs/promises', async () => {
  const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return {
    ...real,
    async open(target: string, flags: number, mode?: number) {
      openCalls.push({ target: String(target), flags });
      // Simulate another process having just taken the temp name, so the O_EXCL
      // retry loop is what has to recover.
      if (String(target).endsWith('.tmp') && collide.remainingTempFailures > 0) {
        collide.remainingTempFailures -= 1;
        const error = new Error('EEXIST: file already exists') as NodeJS.ErrnoException;
        error.code = 'EEXIST';
        throw error;
      }
      return real.open(target, flags, mode);
    },
  };
});

const {
  atomicWrite,
  directoryAddress,
  isDescriptorAddressed,
  openDirectoryNoFollow,
  openOrCreateDirectory,
  SUPPORTS_PROC_FD,
  unlinkNoFollow,
} = await import('../safe-fs.js');

let scratch: string;

beforeEach(async () => {
  openCalls.length = 0;
  collide.remainingTempFailures = 0;
  scratch = await realpath(await mkdtemp(path.join(tmpdir(), 'ld-ai-safe-fs-')));
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

function tempOpens(): Array<{ target: string; flags: number }> {
  return openCalls.filter((call) => call.target.endsWith('.tmp'));
}

describe('openOrCreateDirectory', () => {
  it('creates a missing directory and pins it', async () => {
    const dir = path.join(scratch, 'fresh');
    const handle = await openOrCreateDirectory(dir);
    try {
      expect((await handle.stat()).isDirectory()).toBe(true);
    } finally {
      await handle.close();
    }
  });

  it('refuses an existing symlink-to-directory', async () => {
    // `mkdir(..., { recursive: true })` would treat this as "already there". The
    // plain mkdir plus an lstat on the EEXIST path is what refuses it.
    const outside = path.join(scratch, 'outside');
    await mkdir(outside);
    const link = path.join(scratch, 'link');
    await symlink(outside, link, 'dir');

    await expect(openOrCreateDirectory(link)).rejects.toThrow(/symlink/i);
  });

  it('refuses a path that exists as a file', async () => {
    const asFile = path.join(scratch, 'a-file');
    await writeFile(asFile, 'not a directory\n', 'utf-8');
    await expect(openOrCreateDirectory(asFile)).rejects.toThrow(/not a directory/i);
  });

  it('opens with O_NOFOLLOW so a symlink cannot be followed', async () => {
    const dir = path.join(scratch, 'fresh');
    const handle = await openOrCreateDirectory(dir);
    await handle.close();

    const call = openCalls.find((c) => c.target === dir);
    expect(call).toBeDefined();
    expect(call?.flags & fsConstants.O_NOFOLLOW).toBe(fsConstants.O_NOFOLLOW);
  });
});

describe('openDirectoryNoFollow', () => {
  it('refuses a symlinked directory', async () => {
    const outside = path.join(scratch, 'outside');
    await mkdir(outside);
    const link = path.join(scratch, 'link');
    await symlink(outside, link, 'dir');

    await expect(openDirectoryNoFollow(link)).rejects.toThrow();
  });
});

describe('atomicWrite', () => {
  it('creates the temp file exclusively, in the target directory, without following links', async () => {
    // Asserting only that two successive writes pick different names would be
    // satisfied by the randomness alone, so assert the flag itself.
    const dir = path.join(scratch, 'skill');
    const handle = await openOrCreateDirectory(dir);
    try {
      await atomicWrite(dir, 'SKILL.md', Buffer.from('body\n', 'utf-8'), handle);
    } finally {
      await handle.close();
    }

    const temps = tempOpens();
    expect(temps).toHaveLength(1);
    expect(temps[0].flags & fsConstants.O_EXCL).toBe(fsConstants.O_EXCL);
    expect(temps[0].flags & fsConstants.O_CREAT).toBe(fsConstants.O_CREAT);
    expect(temps[0].flags & fsConstants.O_NOFOLLOW).toBe(fsConstants.O_NOFOLLOW);
    // Same directory as the target, or the rename would cross devices and stop
    // being atomic.
    expect(path.dirname(temps[0].target)).toBe(dir);
    expect(await readFile(path.join(dir, 'SKILL.md'), 'utf-8')).toBe('body\n');
  });

  it('retries with a fresh name when the temp path is already taken', async () => {
    // Losing the race must produce a new name rather than writing through
    // whatever is already there.
    const dir = path.join(scratch, 'skill');
    collide.remainingTempFailures = 3;

    const handle = await openOrCreateDirectory(dir);
    try {
      await atomicWrite(dir, 'SKILL.md', Buffer.from('body\n', 'utf-8'), handle);
    } finally {
      await handle.close();
    }

    const temps = tempOpens();
    expect(temps).toHaveLength(4);
    expect(new Set(temps.map((t) => t.target)).size).toBe(4);
    expect(await readFile(path.join(dir, 'SKILL.md'), 'utf-8')).toBe('body\n');
  });

  it('leaves no temp file behind on success', async () => {
    const dir = path.join(scratch, 'skill');
    const handle = await openOrCreateDirectory(dir);
    try {
      await atomicWrite(dir, 'SKILL.md', Buffer.from('body\n', 'utf-8'), handle);
    } finally {
      await handle.close();
    }
    expect(await readdir(dir)).toEqual(['SKILL.md']);
  });
});

/**
 * On Node the identity re-check is the *whole* defense against a directory swapped
 * between validation and the destructive call: there is no `*at()` family, so the
 * rename and the unlink resolve their directory by path.
 *
 * Off `SUPPORTS_PROC_FD` it is the *whole* defense against a directory swapped
 * between validation and the destructive call: Node exposes no `*at()` family, so
 * the rename and the unlink resolve their directory by path. The swap-race cases
 * in `skills-fs.test.ts` cannot reach it — they fire the swap from the
 * rename/unlink hook, which by construction runs *after* the check. Verified by
 * mutation: with the check neutered, the entire suite stays green.
 *
 * So the swap is staged here instead: pin the handle, then replace the directory,
 * then invoke the primitive. Both primitives re-check independently, so both
 * halves are required.
 *
 * These call the primitives with a plain path, which is what keeps them
 * meaningful on Linux too: the check is skipped only for a directory addressed
 * through `directoryAddress`, so passing a path exercises the floor on every
 * platform rather than testing nothing wherever the fast path exists.
 */
describe('pinned-directory identity re-check', () => {
  /** Moves `dir` aside and leaves a symlink to `outside` in its place. */
  async function swapForSymlink(dir: string, outside: string): Promise<string> {
    const movedTo = `${dir}.real`;
    await rename(dir, movedTo);
    await symlink(outside, dir, 'dir');
    return movedTo;
  }

  it('atomicWrite refuses when the pinned directory was swapped for a symlink', async () => {
    const dir = path.join(scratch, 'skill');
    const outside = path.join(scratch, 'outside');
    await mkdir(dir);
    await mkdir(outside);

    const handle = await openDirectoryNoFollow(dir);
    try {
      await swapForSymlink(dir, outside);

      await expect(atomicWrite(dir, 'SKILL.md', Buffer.from('body\n', 'utf-8'), handle)).rejects.toThrow(/replaced/i);
      // The identity is re-checked *before* the temp file is opened as well as
      // before the rename, so nothing — not even a temp file — is written
      // through the swapped link. The outside directory was never touched.
      expect(await readdir(outside)).toEqual([]);
      expect(tempOpens()).toEqual([]);
    } finally {
      await handle.close();
    }
  });

  it('unlinkNoFollow refuses when the pinned directory was swapped for a symlink', async () => {
    // unlink never follows a *trailing* symlink, but it does resolve the directory
    // above it, so an unguarded delete through a swapped directory is a delete
    // primitive with an attacker-chosen target. The victim is a real file named
    // SKILL.md, so the trailing-symlink check passes and only the identity
    // re-check can stop this.
    const dir = path.join(scratch, 'skill');
    const outside = path.join(scratch, 'outside');
    await mkdir(dir);
    await mkdir(outside);
    await writeFile(path.join(dir, 'SKILL.md'), 'managed\n', 'utf-8');
    const victim = path.join(outside, 'SKILL.md');
    await writeFile(victim, 'victim content\n', 'utf-8');

    const handle = await openDirectoryNoFollow(dir);
    try {
      const movedTo = await swapForSymlink(dir, outside);

      await expect(unlinkNoFollow(dir, 'SKILL.md', handle)).rejects.toThrow(/replaced/i);
      expect(await readFile(victim, 'utf-8')).toBe('victim content\n');
      // The managed file is untouched too: refused, not redirected.
      expect(await readFile(path.join(movedTo, 'SKILL.md'), 'utf-8')).toBe('managed\n');
    } finally {
      await handle.close();
    }
  });
});

/**
 * The Linux fast path's own positive control.
 *
 * The block above tests the *floor* — deliberately, by passing a plain path, so it
 * exercises the identity re-check on every platform. That leaves the fast path
 * itself unproven by anything: on Linux the defense lives in how the call is
 * *addressed* rather than in a check a test can observe failing, and the §3.23.2
 * swap races in `skills-fs.test.ts` and `skills-fs-root-swap.test.ts` go through
 * the materialization layer, where the shared path check and the primitive's own
 * `O_NOFOLLOW` both stand in the way — so they pass when either layer alone works
 * and prove the pair rather than either member.
 *
 * So assert the property directly and at this layer: nothing else establishes that
 * `directoryAddress()` resolves from the inode the handle is pinned to rather than
 * from whatever the directory's *name* resolves to when the call is made. This is
 * the positive mirror of the floor tests — there the contract is a refusal, here it
 * is that the write lands in the right place despite the swap.
 *
 * Gated on `SUPPORTS_PROC_FD` because it tests that capability, not the floor;
 * that makes it **Linux-only**, and a green macOS run is no evidence about it.
 */
describe.skipIf(!SUPPORTS_PROC_FD)('descriptor addressing on the /proc/self/fd fast path', () => {
  it('atomicWrite lands in the pinned inode after the directory is swapped for a symlink', async () => {
    const dir = path.join(scratch, 'skill');
    const outside = path.join(scratch, 'outside');
    await mkdir(dir);
    await mkdir(outside);

    const handle = await openDirectoryNoFollow(dir);
    try {
      // Built *before* the swap, which is the point: the address holds the
      // descriptor, so it keeps naming this inode no matter what happens to the
      // name `dir`.
      const address = directoryAddress(handle, dir);
      expect(address).not.toBe(dir);

      const movedTo = `${dir}.real`;
      await rename(dir, movedTo);
      await symlink(outside, dir, 'dir');
      // The swap really is in place: `dir` now resolves outside.
      expect((await lstat(dir)).isSymbolicLink()).toBe(true);

      await atomicWrite(address, 'SKILL.md', Buffer.from('body\n', 'utf-8'), handle);

      // Landed in the directory that was pinned, which is now `movedTo`.
      expect(await readFile(path.join(movedTo, 'SKILL.md'), 'utf-8')).toBe('body\n');
      // And nothing at all reached the attacker's directory — not even a temp
      // file, unlike the floor, where the temp is created through the link before
      // the check fires.
      expect(await readdir(outside)).toEqual([]);
    } finally {
      await handle.close();
    }
  });

  it('unlinkNoFollow removes from the pinned inode after the directory is swapped for a symlink', async () => {
    // The destructive half. `unlink` never follows a trailing symlink, but it does
    // resolve the directory above it — so a path-addressed unlink through a
    // swapped directory removes the outside file. The victim is a real file with
    // the managed name, so only the addressing can be what saves it.
    const dir = path.join(scratch, 'skill');
    const outside = path.join(scratch, 'outside');
    await mkdir(dir);
    await mkdir(outside);
    await writeFile(path.join(dir, 'SKILL.md'), 'managed\n', 'utf-8');
    const victim = path.join(outside, 'SKILL.md');
    await writeFile(victim, 'victim content\n', 'utf-8');

    const handle = await openDirectoryNoFollow(dir);
    try {
      const address = directoryAddress(handle, dir);
      const movedTo = `${dir}.real`;
      await rename(dir, movedTo);
      await symlink(outside, dir, 'dir');

      await unlinkNoFollow(address, 'SKILL.md', handle);

      // The managed file — the one that was pinned — is the one that went.
      expect(await readdir(movedTo)).toEqual([]);
      expect(await readFile(victim, 'utf-8')).toBe('victim content\n');
    } finally {
      await handle.close();
    }
  });
});

describe('isDescriptorAddressed', () => {
  // Pure string logic, ungated: it decides whether the identity re-check is
  // skipped, so a lookalike must never be mistaken for the descriptor address.
  it('accepts exactly the address built for this handle, and nothing else on procfs', async () => {
    const handle = await openDirectoryNoFollow(scratch);
    try {
      expect(isDescriptorAddressed(`/proc/self/fd/${handle.fd}`, handle)).toBe(true);
      expect(isDescriptorAddressed(scratch, handle)).toBe(false);
      expect(isDescriptorAddressed('/tmp/proc/self/fd/3', handle)).toBe(false);
      for (const shape of [
        '/proc/self/fd',
        '/proc/self/fd/',
        `/proc/self/fd/${handle.fd}/`,
        `/proc/self/fd/${handle.fd}/child`,
        `/proc/self/fd/${handle.fd + 1}`,
        '/proc/self/fd/../../etc',
      ]) {
        expect(() => isDescriptorAddressed(shape, handle), shape).toThrow(/descriptor/i);
      }
    } finally {
      await handle.close();
    }
  });
});

describe('single path component names', () => {
  // `name` is the one argument that becomes part of a path this module writes
  // or unlinks; a caller passing `../x` would be addressing outside the pinned
  // directory. The check is structural rather than trusting every caller.
  const badNames = ['', '.', '..', 'a/b', '../SKILL.md', 'SKILL.md/', '/SKILL.md'];

  it.each(badNames)('atomicWrite refuses name %j', async (name) => {
    const dir = path.join(scratch, 'skill');
    await mkdir(dir);
    const handle = await openDirectoryNoFollow(dir);
    try {
      await expect(atomicWrite(dir, name, Buffer.from('body\n'), handle)).rejects.toThrow(/single path component/);
    } finally {
      await handle.close();
    }
    expect(tempOpens()).toEqual([]);
  });

  it.each(badNames)('unlinkNoFollow refuses name %j', async (name) => {
    const dir = path.join(scratch, 'skill');
    await mkdir(dir);
    await writeFile(path.join(dir, 'SKILL.md'), 'body\n', 'utf-8');
    const handle = await openDirectoryNoFollow(dir);
    try {
      await expect(unlinkNoFollow(dir, name, handle)).rejects.toThrow(/single path component/);
    } finally {
      await handle.close();
    }
    expect(await readdir(dir)).toEqual(['SKILL.md']);
  });
});

describe('unlinkNoFollow', () => {
  it('removes a real file', async () => {
    const dir = path.join(scratch, 'skill');
    await mkdir(dir);
    await writeFile(path.join(dir, 'SKILL.md'), 'body\n', 'utf-8');

    const handle = await openDirectoryNoFollow(dir);
    try {
      await unlinkNoFollow(dir, 'SKILL.md', handle);
    } finally {
      await handle.close();
    }
    expect(await readdir(dir)).toEqual([]);
  });

  it('refuses a symlinked target, leaving the link in place', async () => {
    // Unlinking a symlink never touches its victim, so "the victim survived" proves
    // nothing. The observable contract is the refusal, and that the link is still
    // there afterwards.
    const victim = path.join(scratch, 'victim.md');
    await writeFile(victim, 'victim content\n', 'utf-8');
    const dir = path.join(scratch, 'skill');
    await mkdir(dir);
    const link = path.join(dir, 'SKILL.md');
    await symlink(victim, link);

    const handle = await openDirectoryNoFollow(dir);
    try {
      await expect(unlinkNoFollow(dir, 'SKILL.md', handle)).rejects.toThrow(/symlink/i);
    } finally {
      await handle.close();
    }

    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readFile(victim, 'utf-8')).toBe('victim content\n');
  });
});
