/**
 * `writeSkills` — the swap one level up: the managed *root* replaced by a
 * symlink, not `<root>/<key>`.
 *
 * The defect these were written against: `resolveRoot`
 * validated the root once and returned a path, and nothing held it open. Each
 * write and each prune then opened `<root>/<key>` *by path* with
 * `O_NOFOLLOW | O_DIRECTORY` and pinned that. `O_NOFOLLOW` guards only the final
 * component, so the root and every ancestor were re-resolved on every such open,
 * and a root swapped for a symlink after validation redirected the open into the
 * attacker's directory. `assertUnswapped` did not notice, because it compared the
 * handle against an `lstat` of the *same swapped path*. Only the manifest write
 * pinned the root, and by then the skill file was already outside it. The
 * precondition is write permission on the root's *parent* — in the documented
 * layout (`<app>/.claude/skills`) that is `.claude`, which the agent identity
 * typically owns.
 *
 * The fix pins the root to a descriptor for the whole reconcile and addresses
 * every child as `/proc/self/fd/<fd>/<name>`, which the kernel resolves against
 * the pinned inode rather than against the name. That exists on Linux only, so
 * this file is gated on `SUPPORTS_PROC_FD`: it runs on CI and is skipped on macOS
 * development machines, where the per-component `lstat` floor applies and the
 * mitigation is the README's privilege-separation checklist — now including the
 * root's ancestors.
 *
 * Every test states the contract rather than the mechanism: nothing lands outside
 * the root, no outside file is overwritten, no outside file is removed — **and**,
 * for the three races where the swap lands after the containment check, that the
 * operation went through in the root that was pinned. That second half is not
 * decoration. The negative assertions alone are all satisfied by an
 * implementation that refuses every write once anything has been swapped, which
 * is precisely the regression the Linux fast path could introduce, so guarding
 * them on `report.ok` would invert the test.
 *
 * The trigger matches both the path-based and descriptor-based spellings of the
 * child path (see the hook below), so these same bodies fail against an unpinned
 * root and pass against a pinned one — which is the only thing that makes them
 * evidence.
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

import { SUPPORTS_PROC_FD } from '../safe-fs.js';
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
// Pass-throughs until a test arms one of them; everything else
// `node:fs/promises` exports is the real thing. `nth` picks which matching call
// fires, because a run can open the same skill directory more than once and only
// the open *after* the last containment check is the one that counts.
//
// The trigger matches on the operation's **final component plus the shape of its
// parent**, not on one exact string. That is deliberate and it is what makes
// these tests worth anything: the fixed code addresses `<root>/<key>` as
// `/proc/self/fd/<fd>/<key>`, so a trigger pinned to `path.join(root, key)`
// would stop matching the moment the fix landed — the swap would never fire, the
// contract would never be tested, and the suite would go green for the wrong
// reason. Matching both spellings means one test body runs against either
// implementation, which is the only way the red-to-green transition means
// anything.

const race = vi.hoisted(() => ({
  /** Which operation the swap rides on, or `null` when disarmed. */
  on: null as 'mkdir' | 'open' | null,
  /** `'child'` matches an operation on a child of the root; `'root'` the root open itself. */
  mode: 'child' as 'child' | 'root',
  /** For `'child'`: the final component the operation must target. */
  name: '',
  /** The realpath'd managed root — the name a child carries before the fix. */
  root: '',
  nth: 1,
  seen: 0,
  fire: null as (() => Promise<void>) | null,
  fired: false,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const call = (fn: unknown, args: unknown[]) => (fn as (...a: unknown[]) => Promise<unknown>)(...args);
  const PROC = '/proc/self/fd';

  function matches(op: 'mkdir' | 'open', target: unknown): boolean {
    if (race.on !== op || race.fired || typeof target !== 'string') return false;
    if (race.mode === 'root') return target === race.root;
    if (path.basename(target) !== race.name) return false;
    // A child of the managed root, named either through the root's own path
    // (unfixed) or through a held descriptor (fixed).
    const parent = path.dirname(target);
    return parent === race.root || parent.startsWith(`${PROC}/`);
  }

  async function maybeFire(op: 'mkdir' | 'open', target: unknown): Promise<void> {
    if (!matches(op, target)) return;
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

/** Fires `fire` on the `nth` `op` targeting `<root-or-descriptor>/<name>`. */
function arm(on: 'mkdir' | 'open', name: string, fire: () => Promise<void>, nth = 1): void {
  Object.assign(race, { on, mode: 'child', name, nth, seen: 0, fire, fired: false });
}

/** Fires `fire` on the open of the managed root itself — i.e. just before it is pinned. */
function armRootOpen(fire: () => Promise<void>): void {
  Object.assign(race, { on: 'open', mode: 'root', name: '', nth: 1, seen: 0, fire, fired: false });
}

function disarm(): void {
  Object.assign(race, { on: null, mode: 'child', name: '', nth: 1, seen: 0, fire: null, fired: false });
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

/**
 * The `entries` map of the manifest in the root that was actually pinned.
 *
 * After a swap that is the moved-aside directory, which is where every
 * descriptor-addressed operation — including the manifest rewrite — lands.
 */
async function realManifestEntries(): Promise<Record<string, unknown>> {
  const raw = JSON.parse(await readFile(path.join(movedTo(), MANIFEST_NAME), 'utf-8'));
  return raw.entries as Record<string, unknown>;
}

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
  race.root = root;
});

afterEach(async () => {
  disarm();
  _clearState();
  await rm(scratch, { recursive: true, force: true });
});

// ─── The three root-swap races ───────────────────────────────────────────────

describe.skipIf(!SUPPORTS_PROC_FD)('writeSkills root swap races', () => {
  it('a root swapped at the skill directory create cannot redirect the write', async () => {
    // First reconcile against a fresh root: `<root>/a` does not exist, so
    // `openOrCreateDirectory` calls `mkdir(<root>/a)`. The swap fires there;
    // the mkdir, the O_NOFOLLOW open and assertUnswapped's lstat all resolve
    // through the link, and SKILL.md is written into `<outside>/a/`.
    const outside = path.join(scratch, 'outside');
    await mkdir(outside);
    arm('mkdir', 'a', () => swapRoot(outside));

    const report = await writeSkills([skill('a')], root);

    if (!race.fired) throw new Error(NEVER_FIRED);
    expect(await readdir(outside)).toEqual([]);
    // Unconditionally, and that is the point: guarding this on `report.ok` would
    // hand a pass to an implementation that refuses every write once anything
    // has been swapped — which is exactly the regression the fast path could
    // introduce, and which "the outside directory is empty" cannot distinguish
    // from a write that landed correctly. The swap fires at the `mkdir`, after
    // `unsafePathReason` has already run, so the containment check is not what
    // is under test here: the descriptor addressing is, and it must deliver the
    // file into the root that was validated.
    expect(report.ok).toBe(true);
    expect(await readFile(path.join(movedTo(), 'a', SKILL_MD), 'utf-8')).toBe(SKILL_BODY);
  });

  it('a root swapped at the skill directory open cannot clobber an outside file', async () => {
    // Update of an already-managed skill: `<root>/a` exists, so the mkdir
    // fails EEXIST and the swap fires at the O_NOFOLLOW open that follows.
    // `<outside>/a/SKILL.md` — a file the manifest never recorded — is
    // replaced with LaunchDarkly-served content.
    const outside = path.join(scratch, 'outside');
    await mkdir(path.join(outside, 'a'), { recursive: true });
    const victim = path.join(outside, 'a', SKILL_MD);
    await writeFile(victim, 'precious\n', 'utf-8');
    await placeManaged(root, 'a', SKILL_BODY);
    arm('open', 'a', () => swapRoot(outside));

    const report = await writeSkills([skill('a', 2, 'served update\n')], root);

    if (!race.fired) throw new Error(NEVER_FIRED);
    expect(await readFile(victim, 'utf-8')).toBe('precious\n');
    // Unconditional for the reason given above: "the victim is unchanged" holds
    // for an implementation that wrote nothing at all, so the landing has to be
    // asserted too.
    expect(report.ok).toBe(true);
    expect(await readFile(path.join(movedTo(), 'a', SKILL_MD), 'utf-8')).toBe('served update\n');
  });

  it('a root swapped at the prune cannot redirect the unlink', async () => {
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
    arm('open', 'a', () => swapRoot(outside), 2);

    const report = await writeSkills([], root);

    if (!race.fired) throw new Error(NEVER_FIRED);
    expect(await exists(victim)).toBe(true);
    expect(await readFile(victim, 'utf-8')).toBe('precious\n');
    // Unconditional, and on the destructive side it matters most: an
    // implementation that pruned nothing satisfies "the outside file survives"
    // perfectly. The managed file — the one this SDK owns — is the one that had
    // to go, and the report has to say so.
    expect(report.ok).toBe(true);
    expect(report.actions.map((action) => [action.key, action.action])).toContainEqual(['a', 'removed']);
    expect(await exists(path.join(movedTo(), 'a', SKILL_MD))).toBe(false);
  });

  /**
   * The manifest read, which is not itself a destructive step but decides every
   * destructive step.
   *
   * It runs after the root is pinned and is addressed through the descriptor, so
   * the property holds by construction — which is exactly why it is worth pinning
   * rather than assuming. An implementation that read the manifest by path before
   * pinning, or that re-derived `<root>/<name>` afterwards, passes every other
   * case in this file: the writes and the unlinks would still be
   * descriptor-addressed and would still land in the real root. Only the
   * *decisions* would come from the attacker's directory, and `rewriteManifest`
   * would then commit those decisions back over the real manifest — destroying
   * the ownership record that protects the customer's files on every later run.
   *
   * **What these do not assert, and why.** Not that the run succeeds. A swapped
   * root is also caught by `unsafePathReason`'s containment check — `realpath` of
   * the descriptor-addressed skill directory lands under the moved-aside root,
   * whose parent is no longer the validated root — so both runs below refuse at
   * that layer, which is the correct fail-closed outcome and is defense in depth
   * working as documented. Asserting "the write happened" would therefore be
   * asserting the wrong thing, and would fail against a *correct* implementation.
   *
   * The observable that isolates the manifest read is **whose entries the run
   * acted on**: the attacker's manifest names a key the real root has never heard
   * of, so if theirs were read, that key would appear in the report (prune walks
   * manifest entries) and in the rewritten manifest. Both assertions come in a
   * pair — the real key present, the attacker's key absent — because either alone
   * would pass against an implementation that read neither.
   */
  /** The attacker's own manifest, naming a key the real root never managed. */
  async function plantForeignManifest(outside: string): Promise<void> {
    await mkdir(path.join(outside, 'zz'), { recursive: true });
    await writeFile(path.join(outside, 'zz', SKILL_MD), 'attacker planted\n', 'utf-8');
    await writeManifest(outside, {
      manifestVersion: 1,
      entries: {
        [`zz/${SKILL_MD}`]: {
          key: 'zz',
          version: 1,
          sha256: hash('attacker planted\n'),
          writtenAt: '2026-08-14T19:00:00Z',
        },
      },
    });
  }

  it('a root swapped at the manifest read reconciles from the real entries, not the attacker’s', async () => {
    const outside = path.join(scratch, 'outside');
    await mkdir(outside);
    await plantForeignManifest(outside);
    await placeManaged(root, 'a', SKILL_BODY);
    arm('open', MANIFEST_NAME, () => swapRoot(outside));

    const report = await writeSkills([skill('a', 2, 'served update\n')], root);

    if (!race.fired) throw new Error(NEVER_FIRED);
    // The real manifest's key is the one the run reasoned about...
    expect(report.actions.map((action) => action.key)).toContain('a');
    // ...and the attacker's key never entered the run. Were their manifest read,
    // `zz` is not in the requested set, so prune would have reported it.
    expect(report.actions.some((action) => action.key === 'zz')).toBe(false);

    // The ownership record survives in the real root: still `a`, never `zz`.
    const entries = await realManifestEntries();
    expect(Object.keys(entries)).toEqual([`a/${SKILL_MD}`]);
    expect((entries[`a/${SKILL_MD}`] as { key: string }).key).toBe('a');
    // And nothing was done to the attacker's directory.
    expect(await readFile(path.join(outside, 'zz', SKILL_MD), 'utf-8')).toBe('attacker planted\n');
  });

  it('a root swapped at the manifest read prunes from the real entries, not the attacker’s', async () => {
    // Same property on the destructive path, where reading the wrong manifest
    // would aim the prune: `zz` is unrequested, so the attacker's entry is
    // precisely what a prune driven by their manifest would go after.
    const outside = path.join(scratch, 'outside');
    await mkdir(outside);
    await plantForeignManifest(outside);
    await placeManaged(root, 'a', SKILL_BODY);
    arm('open', MANIFEST_NAME, () => swapRoot(outside));

    const report = await writeSkills([], root);

    if (!race.fired) throw new Error(NEVER_FIRED);
    expect(report.actions.map((action) => action.key)).toContain('a');
    expect(report.actions.some((action) => action.key === 'zz')).toBe(false);

    // The prune was refused by containment, so `a` stays listed — and `zz` was
    // never listed. The next run, against an unswapped root, prunes `a`.
    const entries = await realManifestEntries();
    expect(Object.keys(entries)).toEqual([`a/${SKILL_MD}`]);
    expect(await readFile(path.join(outside, 'zz', SKILL_MD), 'utf-8')).toBe('attacker planted\n');
  });

  it('a root swapped before it is pinned is refused with a run-level error', async () => {
    // The one window pinning cannot cover, and the reason the pin is not the
    // whole story: `resolveRoot` validated the root's *name*, and the swap lands
    // between that and the open that turns the name into a descriptor. The
    // O_NOFOLLOW open then fails on the symlink.
    //
    // Refused as a run-level `error` action rather than thrown. `resolveRoot`
    // throws because an unusable root is a caller mistake; a root that was a
    // real directory an instant ago and is a symlink now is an attack in
    // flight, and it belongs in the report next to every other refusal.
    const outside = path.join(scratch, 'outside');
    await mkdir(outside);
    await placeManaged(root, 'a', SKILL_BODY);
    armRootOpen(() => swapRoot(outside));

    const report = await writeSkills([skill('a', 2, 'served update\n')], root);

    if (!race.fired) throw new Error(NEVER_FIRED);
    expect(report.ok).toBe(false);
    expect(report.errors.some((action) => action.key === '')).toBe(true);
    // Nothing was attempted through the link, and the real root is untouched.
    expect(await readdir(outside)).toEqual([]);
    expect(await readFile(path.join(movedTo(), 'a', SKILL_MD), 'utf-8')).toBe(SKILL_BODY);
  });
});
