/**
 * `writeSkills` — the swap one level up: the managed *root* replaced by a
 * symlink, not `<root>/<key>`.
 *
 * `resolveRoot` validates the root once and returns a path; nothing holds it
 * open. Each write and each prune then opens `<root>/<key>` *by path* with
 * `O_NOFOLLOW | O_DIRECTORY` and pins that. `O_NOFOLLOW` guards only the final
 * component, so the root and every ancestor are re-resolved on every such open,
 * and a root swapped for a symlink after validation redirects the open into the
 * attacker's directory. `assertUnswapped` does not notice: it compares the
 * handle against an `lstat` of the *same swapped path*, so the two agree.
 * `atomicWriteIn` does refuse the manifest rewrite afterwards, but by then the
 * skill file is already outside the root.
 *
 * The `<root>/<key>` swap races in `skills-fs.test.ts` are skipped off
 * `SUPPORTS_DIR_FD`, because Node cannot close that window. These are not
 * skipped: they show that the *documented* mitigation for the residual exposure
 * is not sufficient either. The README's privilege-separation checklist denies
 * the agent identity the root, the skill directories, the files and the
 * manifest, and says nothing about the root's parent. In the documented layout
 * (`<app>/.claude/skills`) that parent is `.claude`, which the agent identity
 * typically owns, and write permission there is all this takes.
 *
 * Every test states the contract — nothing lands outside the root, no outside
 * file is overwritten, no outside file is removed — and runs under `knownGap`,
 * which passes only while the contract is violated. On Linux the fix is to hold
 * the root handle and address children through `/proc/self/fd/<fd>/<name>`,
 * which the kernel resolves against the pinned inode rather than the name;
 * everywhere else it is adding the root's parent to the README checklist.
 *
 * In its own file because the swap has to land *before* the per-skill directory
 * is opened, which means intercepting `mkdir` and `open` from `node:fs/promises`
 * rather than the `fsOps` rename/unlink hook, and `vi.mock` is file-wide.
 */

import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { _clearState } from '../skills.js';
import { writeSkills } from '../skills-fs.js';
import type { Skill } from '../types.js';
import { createSkill } from '../types.js';

const SKILL_MD = 'SKILL.md';
const MANIFEST_NAME = '.launchdarkly-skills.json';
const SKILL_BODY = '---\nname: Test Skill\n---\nDo the thing.\n';
const NEVER_FIRED = 'the race never fired; the test proves nothing';

// ─── The mkdir/open interception hook ────────────────────────────────────────
//
// Pass-throughs until a test arms one of them for one exact path; everything
// else `node:fs/promises` exports is the real thing. `nth` picks which matching
// call fires, because a run can open the same skill directory more than once
// and only the open *after* the last containment check is the one that counts.

const race = vi.hoisted(() => ({
  on: null as 'mkdir' | 'open' | null,
  trigger: '',
  nth: 1,
  seen: 0,
  fire: null as (() => Promise<void>) | null,
  fired: false,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const call = (fn: unknown, args: unknown[]) => (fn as (...a: unknown[]) => Promise<unknown>)(...args);
  async function maybeFire(op: 'mkdir' | 'open', target: unknown): Promise<void> {
    if (race.on !== op || race.fired || target !== race.trigger) return;
    race.seen += 1;
    if (race.seen < race.nth) return;
    race.fired = true;
    await race.fire?.();
  }
  return {
    ...actual,
    mkdir: async (...args: unknown[]) => {
      await maybeFire('mkdir', args[0]);
      return call(actual.mkdir, args);
    },
    open: async (...args: unknown[]) => {
      await maybeFire('open', args[0]);
      return call(actual.open, args);
    },
  };
});

function arm(on: 'mkdir' | 'open', trigger: string, fire: () => Promise<void>, nth = 1): void {
  Object.assign(race, { on, trigger, nth, seen: 0, fire, fired: false });
}

function disarm(): void {
  Object.assign(race, { on: null, trigger: '', nth: 1, seen: 0, fire: null, fired: false });
}

/**
 * pytest's `xfail(strict=True, raises=AssertionError)`, which `it.fails` is not.
 *
 * `it.fails` accepts *any* throw as the expected failure, so a harness bug — a
 * race that never fires, a `writeSkills` that rejects — would masquerade as the
 * known gap. This accepts only a failed assertion, rethrows everything else, and
 * fails loudly the day the body passes, so the wrapper cannot outlive the fix.
 */
async function knownGap(body: () => Promise<void>): Promise<void> {
  try {
    await body();
  } catch (error) {
    if ((error as Error | undefined)?.name === 'AssertionError') return;
    throw error;
  }
  throw new Error('the root-swap gap is closed: drop knownGap() and assert the contract directly');
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function hash(content: string): string {
  return createHash('sha256').update(Buffer.from(content, 'utf-8')).digest('hex');
}

function skill(key: string, version = 1, content = SKILL_BODY): Skill {
  return createSkill({ key, version, content: new TextEncoder().encode(content), contentHash: hash(content) });
}

async function writeManifest(root: string, raw: unknown): Promise<void> {
  await writeFile(path.join(root, MANIFEST_NAME), JSON.stringify(raw), 'utf-8');
}

/** Pre-create a file AND its manifest entry — i.e. an SDK-managed path. */
async function placeManaged(root: string, key: string, content: string, version = 1): Promise<void> {
  await mkdir(path.join(root, key), { recursive: true });
  await writeFile(path.join(root, key, SKILL_MD), content, 'utf-8');
  await writeManifest(root, {
    manifestVersion: 1,
    entries: { [`${key}/${SKILL_MD}`]: { key, version, sha256: hash(content), writtenAt: '2026-08-14T19:00:00Z' } },
  });
}

async function exists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch {
    return false;
  }
}

// ─── Per-test scratch directory ──────────────────────────────────────────────

let scratch: string;
let root: string;

/** Where the real root ends up after the swap. */
const movedTo = (): string => `${root}.real`;

/** Renames the managed root aside and leaves a symlink to `outside` in its place. */
async function swapRoot(outside: string): Promise<void> {
  await rename(root, movedTo());
  await symlink(outside, root, 'dir');
}

beforeEach(async () => {
  _clearState();
  disarm();
  // realpath, as in skills-fs.test.ts: writeSkills resolves the root, and the
  // trigger has to compare equal to the path the implementation actually opens.
  scratch = await realpath(await mkdtemp(path.join(tmpdir(), 'ld-ai-skills-root-swap-')));
  root = path.join(scratch, 'skills');
  await mkdir(root);
});

afterEach(async () => {
  disarm();
  _clearState();
  await rm(scratch, { recursive: true, force: true });
});

// ─── The three root-swap races ───────────────────────────────────────────────

describe('writeSkills root swap races', () => {
  it('a root swapped at the skill directory create cannot redirect the write', () =>
    knownGap(async () => {
      // First reconcile against a fresh root: `<root>/a` does not exist, so
      // `openOrCreateDirectory` calls `mkdir(<root>/a)`. The swap fires there;
      // the mkdir, the O_NOFOLLOW open and assertUnswapped's lstat all resolve
      // through the link, and SKILL.md is written into `<outside>/a/`.
      const outside = path.join(scratch, 'outside');
      await mkdir(outside);
      arm('mkdir', path.join(root, 'a'), () => swapRoot(outside));

      const report = await writeSkills([skill('a')], root);

      if (!race.fired) throw new Error(NEVER_FIRED);
      expect(await readdir(outside)).toEqual([]);
      // Either the skill landed in the real root or the run says it did not.
      if (report.ok) expect(await readFile(path.join(movedTo(), 'a', SKILL_MD), 'utf-8')).toBe(SKILL_BODY);
    }));

  it('a root swapped at the skill directory open cannot clobber an outside file', () =>
    knownGap(async () => {
      // Update of an already-managed skill: `<root>/a` exists, so the mkdir
      // fails EEXIST and the swap fires at the O_NOFOLLOW open that follows.
      // `<outside>/a/SKILL.md` — a file the manifest never recorded — is
      // replaced with LaunchDarkly-served content.
      const outside = path.join(scratch, 'outside');
      await mkdir(path.join(outside, 'a'), { recursive: true });
      const victim = path.join(outside, 'a', SKILL_MD);
      await writeFile(victim, 'precious\n', 'utf-8');
      await placeManaged(root, 'a', SKILL_BODY);
      arm('open', path.join(root, 'a'), () => swapRoot(outside));

      const report = await writeSkills([skill('a', 2, 'served update\n')], root);

      if (!race.fired) throw new Error(NEVER_FIRED);
      expect(await readFile(victim, 'utf-8')).toBe('precious\n');
      if (report.ok) expect(await readFile(path.join(movedTo(), 'a', SKILL_MD), 'utf-8')).toBe('served update\n');
    }));

  it('a root swapped at the prune cannot redirect the unlink', () =>
    knownGap(async () => {
      // The destructive side. The orphan-temp sweep opens `<root>/a` first and
      // `pruneOne` re-runs the realpath containment check after it, so a swap
      // at that open would be caught; the second open — pruneOne's own, after
      // the check — is not. The unlink and the rmdir then both resolve through
      // the swapped root, and an outside file and its directory are removed.
      const outside = path.join(scratch, 'outside');
      await mkdir(path.join(outside, 'a'), { recursive: true });
      const victim = path.join(outside, 'a', SKILL_MD);
      await writeFile(victim, 'precious\n', 'utf-8');
      await placeManaged(root, 'a', SKILL_BODY);
      arm('open', path.join(root, 'a'), () => swapRoot(outside), 2);

      const report = await writeSkills([], root);

      if (!race.fired) throw new Error(NEVER_FIRED);
      expect(await exists(victim)).toBe(true);
      expect(await readFile(victim, 'utf-8')).toBe('precious\n');
      if (report.ok) expect(await exists(path.join(movedTo(), 'a', SKILL_MD))).toBe(false);
    }));
});
