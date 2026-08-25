/**
 * The filesystem primitives `writeSkills` is built on, tested directly:
 * atomicity, exclusive temp creation, `0644`, and symlink refusal.
 *
 * Its own file for two reasons. It needs `vi.mock('node:fs/promises')` to observe
 * the flags a file is *opened* with, which has to be hoisted above the module
 * under test. And the checks here are deliberately redundant with the ones in
 * `skills-fs.ts` — a symlinked skill directory is refused by both layers — so
 * mutating either one alone leaves every symlink-attack test in `skills-fs.test.ts`
 * passing. Exercising each layer on its own is what keeps the redundancy from
 * rotting into a single point of failure.
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
      // Simulate another process having just taken the temp name, so the
      // O_EXCL retry loop is what has to recover.
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

const { atomicWrite, atomicWriteIn, openDirectoryNoFollow, openOrCreateDirectory, unlinkNoFollow } = await import(
  '../safe-fs.js'
);

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
    // `mkdir(..., { recursive: true })` would treat this as "already there",
    // re-opening the very hole the caller's check just closed. The plain mkdir
    // plus an lstat on the EEXIST path is what refuses it.
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
    // O_EXCL is what makes "an existing temp path is never
    // reused" true. Asserting only that two successive writes pick different
    // names would be satisfied by the randomness alone, so assert the flag.
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
    // The other half of exclusive creation: losing the race must produce a new
    // name rather than writing through whatever is already there.
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

  it('atomicWriteIn refuses a symlinked directory', async () => {
    const outside = path.join(scratch, 'outside');
    await mkdir(outside);
    const link = path.join(scratch, 'link');
    await symlink(outside, link, 'dir');

    await expect(atomicWriteIn(link, 'SKILL.md', Buffer.from('body\n', 'utf-8'))).rejects.toThrow();
    expect(await readdir(outside)).toEqual([]);
  });
});

/**
 * The pinned-directory identity re-check needs a test of its own.
 *
 * On this runtime it is the *whole* defense against a directory swapped between
 * validation and the destructive call: Node exposes no `*at()` family, so the
 * rename and the unlink resolve their directory by path. The two
 * swap-race cases in `skills-fs.test.ts` cannot reach it — they fire the swap from the rename/unlink
 * hook, which by construction runs *after* the check, and they are skipped off
 * `SUPPORTS_DIR_FD` anyway. Verified by mutation: with the check neutered, the
 * entire suite stays green.
 *
 * So the swap is staged here instead: pin the handle, then replace the directory,
 * then invoke the primitive. Both primitives re-check independently, so both
 * halves are required.
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
      // Nothing durable lands outside the root. Note the honest limit: the temp
      // file *is* created through the swapped link before the check fires (only
      // the final component gets O_NOFOLLOW), so what this proves is that the
      // rename is refused and the temp is cleaned up — not that the operation
      // never touched the outside directory at all.
      expect(await readdir(outside)).toEqual([]);
    } finally {
      await handle.close();
    }
  });

  it('unlinkNoFollow refuses when the pinned directory was swapped for a symlink', async () => {
    // The prune side is the dangerous one: unlink never follows a *trailing*
    // symlink, but it does resolve the directory above it, so an unguarded prune
    // through a swapped directory is a delete primitive with an attacker-chosen
    // target. The victim is a real file named SKILL.md, so the trailing-symlink
    // check passes and only the identity re-check can stop this.
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
      // The managed file is untouched too — the operation was refused, not redirected.
      expect(await readFile(path.join(movedTo, 'SKILL.md'), 'utf-8')).toBe('managed\n');
    } finally {
      await handle.close();
    }
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
    // Unlinking a symlink never touches its victim, so "the victim survived"
    // proves nothing. The observable contract is the refusal — and that the link
    // itself is still there afterwards.
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
