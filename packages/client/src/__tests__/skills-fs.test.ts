/**
 * `writeSkills` — the security abuse matrix: path traversal, symlink attacks,
 * clobber protection, and a corrupt manifest.
 *
 * Every test writes only inside its own `os.tmpdir()` scratch directory. No
 * network, no real LaunchDarkly client, no real skill transport.
 */

import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fsOps, SUPPORTS_DIR_FD } from '../safe-fs.js';
import { _clearState } from '../skills.js';
import { writeSkills } from '../skills-fs.js';
import type { ReconcileAction, ReconcileReport, Skill } from '../types.js';
import { createSkill } from '../types.js';

// ─── Constants spelled out by hand ───────────────────────────────────────────
//
// These two strings are a cross-language on-disk contract, so
// the filesystem tests write them literally. A test that imported the
// implementation's own constant could not detect a change to it.

const SKILL_MD = 'SKILL.md';
const MANIFEST_NAME = '.launchdarkly-skills.json';

const SKILL_BODY = '---\nname: Test Skill\n---\nDo the thing.\n';
const INJECTED = 'simulated crash between write and rename';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function hash(content: string): string {
  return createHash('sha256').update(Buffer.from(content, 'utf-8')).digest('hex');
}

function skill(key = 'test-skill', version = 1, content = SKILL_BODY): Skill {
  return createSkill({ key, version, content, contentHash: hash(content) });
}

function manifestPath(root: string): string {
  return path.join(root, MANIFEST_NAME);
}

async function readManifest(root: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(manifestPath(root), 'utf-8'));
}

async function writeManifest(root: string, raw: unknown): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(manifestPath(root), typeof raw === 'string' ? raw : JSON.stringify(raw), 'utf-8');
}

function manifestEntry(key: string, version: number, content: string): Record<string, unknown> {
  return { key, version, sha256: hash(content), writtenAt: '2026-08-14T19:00:00Z' };
}

/** Pre-create a file AND its manifest entry — i.e. an SDK-managed path. */
async function placeManaged(root: string, key: string, content: string, version = 1): Promise<string> {
  const target = path.join(root, key, SKILL_MD);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, 'utf-8');
  await writeManifest(root, {
    manifestVersion: 1,
    entries: { [`${key}/${SKILL_MD}`]: manifestEntry(key, version, content) },
  });
  return target;
}

function actionsByKey(report: ReconcileReport): Record<string, ReconcileAction> {
  return Object.fromEntries(report.actions.map((a) => [a.key, a]));
}

/**
 * All `error` action messages, regardless of which key they hang off.
 *
 * Run-level (manifest) errors carry the empty-string key sentinel, so
 * assertions about them scan every error action rather than looking one up.
 */
function errorMessages(report: ReconcileReport): string[] {
  return report.errors.map((a) => a.error ?? '');
}

async function exists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch {
    return false;
  }
}

async function entryNames(dir: string): Promise<string[]> {
  return (await readdir(dir)).sort();
}

// ─── The rename/unlink interception hook ─────────────────────────────────────

type RenameCall = { src: string; dst: string };

/**
 * Records — and optionally fails — every atomic rename of a `SKILL.md`.
 *
 * The implementation performs the
 * final rename through the single `fsOps.rename` call site, so spying on that
 * property observes it. Destinations other than `SKILL.md` — the manifest's own
 * atomic write — pass straight through, the same filter the Python SDK's tests apply.
 *
 * Used two ways: to prove an injected failure is what produced an `error` action
 * (atomicity), and to prove no write was *attempted* for a rejected key
 * — the OS would reject several hostile keys on its own, so a failed
 * write is not evidence of a defense.
 */
function interceptRename(options: { fail?: boolean } = {}): RenameCall[] {
  const calls: RenameCall[] = [];
  const real = fsOps.rename.bind(fsOps);
  vi.spyOn(fsOps, 'rename').mockImplementation(async (src: string, dst: string) => {
    if (dst.endsWith(SKILL_MD)) {
      calls.push({ src, dst });
      if (options.fail) throw new Error(INJECTED);
    }
    return real(src, dst);
  });
  return calls;
}

// ─── Per-test scratch directory ──────────────────────────────────────────────

let scratch: string;
let root: string;

beforeEach(async () => {
  _clearState();
  // realpath, because writeSkills resolves the
  // managed root and every path it reports is therefore canonical. On macOS
  // os.tmpdir() is `/var/folders/...`, a symlink to `/private/var/folders/...`,
  // so a harness that kept the unresolved form would compare a canonical path
  // against a non-canonical one and fail on the platform difference rather than
  // on anything the SDK did.
  scratch = await realpath(await mkdtemp(path.join(tmpdir(), 'ld-ai-skills-')));
  root = path.join(scratch, 'skills');
  await mkdir(root);
});

afterEach(async () => {
  vi.restoreAllMocks();
  _clearState();
  await rm(scratch, { recursive: true, force: true });
});

// ─── Path traversal matrix ───────────────────────────────────────────

const HOSTILE_KEYS: Array<[string, string]> = [
  ['parent traversal', '../evil'],
  ['dotdot', '..'],
  ['dot', '.'],
  ['empty', ''],
  ['absolute path', '/etc/cron.d/x'],
  ['backslash traversal', '..\\evil'],
  ['drive letter', 'c:evil'],
  ['NTFS alternate data stream', 'skill:ads'],
  ['embedded null byte', 'sk\0ill'],
  ['leading dash', '-skill'],
  ['uppercase', 'Evil'],
  ['embedded slash', 'a/b'],
  ['overlong', 'x'.repeat(257)],
  ['deep traversal', 'a/../../b'],
  ['leading dot-slash', './a'],
  ['leading space', ' leading-space'],
  ['trailing space', 'trailing-space '],
];

describe('writeSkills path traversal', () => {
  it.each(HOSTILE_KEYS)('rejects a hostile key and attempts no filesystem operation: %s', async (_label, key) => {
    const outsideBefore = await entryNames(scratch);
    const calls = interceptRename();

    const report = await writeSkills([skill(key)], root);

    expect(report.ok).toBe(false);
    expect(report.actions.filter((a) => a.key === key).map((a) => a.action)).toEqual(['error']);

    // The SDK's key validation — not the operating system — must be what
    // stopped this. An overlong key exceeds NAME_MAX, a null byte raises in the
    // path API, and an absolute path outside the root usually fails on
    // permissions, so "an error was reported" is not evidence of a defense (and
    // the absolute-path verdict would flip on a privileged runner).
    expect(calls).toEqual([]);

    // Nothing created outside the root, and no skill directory inside it.
    expect(await entryNames(scratch)).toEqual(outsideBefore);
    expect((await entryNames(root)).filter((n) => n !== MANIFEST_NAME)).toEqual([]);
  });

  it('the interception hook fires for a valid key — the positive control', async () => {
    const calls = interceptRename();

    const report = await writeSkills([skill('ok-key')], root);

    expect(report.ok).toBe(true);
    expect(calls.map((c) => path.basename(c.dst))).toEqual([SKILL_MD]);
  });

  it('writes a long but filesystem-legal key', async () => {
    // The <= 256 length bound cannot be exercised through writeSkills: a key
    // becomes a single directory name and NAME_MAX is 255 bytes on Linux and
    // macOS, so the longest key the data model permits cannot exist on disk at
    // all. Assert the accepting side at the largest writable length; the bound
    // itself is covered by the pure layers' own tests.
    const key = 'k'.repeat(255);
    const report = await writeSkills([skill(key)], root);

    expect(report.ok).toBe(true);
    expect(await readFile(path.join(root, key, SKILL_MD), 'utf-8')).toBe(SKILL_BODY);
  });

  it('reports rather than raises for a key at the data-model bound', async () => {
    // A 256-character key is valid to every pure layer but fits no filesystem,
    // so it reaches writeSkills legitimately and cannot become a directory.
    // Every outcome must be visible in the report, so it must
    // surface as an error action rather than an exception escaping the call —
    // which would also skip the manifest rewrite and orphan the file already
    // written in the same run.
    const calls = interceptRename();
    const longKey = 'a'.repeat(256);

    const report = await writeSkills([skill('good'), skill(longKey)], root);

    const byKey = actionsByKey(report);
    expect(byKey[longKey].action).toBe('error');
    expect(byKey.good.action).toBe('written');
    expect(calls.map((c) => path.dirname(c.dst))).toEqual([path.join(root, 'good')]);
    // The valid skill is fully reconciled: written AND recorded, not orphaned.
    expect(await exists(path.join(root, 'good', SKILL_MD))).toBe(true);
    expect(Object.keys((await readManifest(root)).entries as object)).toContain(`good/${SKILL_MD}`);
  });

  it('writes valid keys alongside rejected ones', async () => {
    const report = await writeSkills([skill('good'), skill('../evil')], root);

    const byKey = actionsByKey(report);
    expect(byKey.good.action).toBe('written');
    expect(byKey['../evil'].action).toBe('error');
    expect(await exists(path.join(root, 'good', SKILL_MD))).toBe(true);
  });

  it('creates nothing above the root for a traversal key', async () => {
    await writeSkills([skill('../../escaped')], root);
    expect(await exists(path.join(scratch, 'escaped'))).toBe(false);
    expect(await exists(path.join(path.dirname(scratch), 'escaped'))).toBe(false);
  });
});

// ─── Symlink attacks ─────────────────────────────────────────────────

describe('writeSkills symlink attacks', () => {
  it('raises for a symlinked root and writes nothing through it', async () => {
    const realDir = path.join(scratch, 'real');
    await mkdir(realDir);
    const linkRoot = path.join(scratch, 'link');
    await symlink(realDir, linkRoot, 'dir');

    await expect(writeSkills([skill('a')], linkRoot)).rejects.toThrow();
    expect(await entryNames(realDir)).toEqual([]);
  });

  it('refuses a symlinked skill directory', async () => {
    const outside = path.join(scratch, 'outside');
    await mkdir(outside);
    await symlink(outside, path.join(root, 'a'), 'dir');

    const report = await writeSkills([skill('a')], root);

    expect(report.ok).toBe(false);
    expect(actionsByKey(report).a.action).toBe('error');
    expect(await entryNames(outside)).toEqual([]);
  });

  it('refuses a symlinked target file', async () => {
    const victim = path.join(scratch, 'victim.md');
    await writeFile(victim, 'victim content\n', 'utf-8');
    await mkdir(path.join(root, 'a'));
    await symlink(victim, path.join(root, 'a', SKILL_MD));
    // Manifest lists the path so clobber protection is not what saves us.
    await writeManifest(root, {
      manifestVersion: 1,
      entries: { [`a/${SKILL_MD}`]: manifestEntry('a', 1, 'victim content\n') },
    });

    const report = await writeSkills([skill('a', 2, 'attacker payload\n')], root);

    expect(report.ok).toBe(false);
    expect(actionsByKey(report).a.action).toBe('error');
    expect(await readFile(victim, 'utf-8')).toBe('victim content\n');
  });

  it('refuses to prune a symlinked target file', async () => {
    // Asserting only that the victim survives proves nothing here: unlinking a
    // symlink never touches its target, so that assertion holds for an
    // implementation with no symlink check at all. The observable contract is
    // the refusal itself.
    const victim = path.join(scratch, 'victim.md');
    await writeFile(victim, 'victim content\n', 'utf-8');
    await mkdir(path.join(root, 'a'));
    const link = path.join(root, 'a', SKILL_MD);
    await symlink(victim, link);
    await writeManifest(root, {
      manifestVersion: 1,
      entries: { [`a/${SKILL_MD}`]: manifestEntry('a', 1, 'victim content\n') },
    });

    const report = await writeSkills([], root);

    expect(report.ok).toBe(false);
    const action = actionsByKey(report).a;
    expect(action.action).toBe('error');
    expect(action.error).not.toBeNull();
    expect(report.actions.filter((a) => a.action === 'removed')).toEqual([]);
    // The symlink itself is left in place and stays managed.
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(Object.keys((await readManifest(root)).entries as object)).toContain(`a/${SKILL_MD}`);
    expect(await readFile(victim, 'utf-8')).toBe('victim content\n');
  });
});

/**
 * The two symlink swap-race cases.
 *
 * They are defensible only where the platform provides the `*at()` syscall
 * family, so they are skipped off `SUPPORTS_DIR_FD` — the **same** capability
 * probe the implementation gates on, never off a platform string, so a probe
 * that silently reported "unsupported" could not also silently skip the tests
 * that would have caught it.
 *
 * On Node that probe is false: `fs`/`fs.promises` expose no `renameat` or
 * `unlinkat`, and `FileHandle` has no `rename`/`unlink`, so a destructive
 * operation cannot be addressed relative to a pinned descriptor at all. These
 * cases are therefore a documented residual exposure on this runtime — see
 * `SUPPORTS_DIR_FD` in `safe-fs.ts`. They are written out
 * in full so they become live the moment the probe flips.
 */
describe.skipIf(!SUPPORTS_DIR_FD)('writeSkills TOCTOU swap races', () => {
  /**
   * Fires the swap at the exact instant of an operation: renames
   * `<root>/<key>` aside and leaves a symlink to `outside` in its place, then
   * lets the intercepted call proceed. Driven from the `fsOps` hook rather
   * than from implementation internals, so the test is not coupled to how the
   * defense is built.
   */
  async function swapDirectory(skillDir: string, outside: string): Promise<string> {
    const movedTo = `${skillDir}.real`;
    await fsOps.rename(skillDir, movedTo);
    await symlink(outside, skillDir, 'dir');
    return movedTo;
  }

  it('a directory swapped at the rename cannot redirect the write', async () => {
    const outside = path.join(scratch, 'outside');
    await mkdir(outside);
    const skillDir = path.join(root, 'a');
    let swapped = false;
    let movedTo = '';

    const real = fsOps.rename.bind(fsOps);
    vi.spyOn(fsOps, 'rename').mockImplementation(async (src: string, dst: string) => {
      if (dst.endsWith(SKILL_MD) && !swapped) {
        swapped = true;
        movedTo = await swapDirectory(skillDir, outside);
      }
      return real(src, dst);
    });

    await writeSkills([skill('a')], root);

    expect(swapped).toBe(true);
    expect(await entryNames(outside)).toEqual([]);
    expect(await readFile(path.join(movedTo, SKILL_MD), 'utf-8')).toBe(SKILL_BODY);
  });

  it('a directory swapped at the prune cannot redirect the unlink', async () => {
    // `unlink` never follows a *trailing* symlink but it does resolve the
    // directory above it, so an unguarded prune deletes the outside file — a
    // delete primitive with an attacker-chosen target.
    const outside = path.join(scratch, 'outside');
    await mkdir(outside);
    const victim = path.join(outside, SKILL_MD);
    await writeFile(victim, 'victim content\n', 'utf-8');
    const skillDir = path.join(root, 'gone');
    await placeManaged(root, 'gone', SKILL_BODY);
    let swapped = false;

    const real = fsOps.unlink.bind(fsOps);
    vi.spyOn(fsOps, 'unlink').mockImplementation(async (target: string) => {
      if (target.endsWith(SKILL_MD) && !swapped) {
        swapped = true;
        await swapDirectory(skillDir, outside);
      }
      return real(target);
    });

    await writeSkills([], root);

    expect(swapped).toBe(true);
    expect(await readFile(victim, 'utf-8')).toBe('victim content\n');
    expect(await exists(path.join(`${skillDir}.real`, SKILL_MD))).toBe(false);
  });
});

describe('filesystem capability probe', () => {
  it('is a real feature test rather than a hardcoded answer', async () => {
    // Node exposes no `*at()` family, so TypeScript
    // runs a per-component lstat check instead and the two
    // swap-race cases above are skipped. If this ever fails, Node grew the
    // family and the descriptor-relative path can be implemented behind the same
    // probe — a welcome failure, not a regression.
    const fsp = await import('node:fs/promises');
    const family = ['renameat', 'unlinkat', 'openat'] as const;
    const present = family.filter((name) => typeof (fsp as unknown as Record<string, unknown>)[name] === 'function');
    expect(SUPPORTS_DIR_FD).toBe(present.length === family.length);
  });
});

// ─── Clobber protection ──────────────────────────────────────────────

describe('writeSkills clobber protection', () => {
  it('never overwrites a user-placed file with no manifest entry', async () => {
    const target = path.join(root, 'a', SKILL_MD);
    await mkdir(path.dirname(target));
    await writeFile(target, 'user authored\n', 'utf-8');

    const report = await writeSkills([skill('a')], root);

    expect(report.ok).toBe(false);
    expect(actionsByKey(report).a.action).toBe('error');
    expect(await readFile(target, 'utf-8')).toBe('user authored\n');
  });

  it('never deletes a user-placed file with no manifest entry', async () => {
    const target = path.join(root, 'a', SKILL_MD);
    await mkdir(path.dirname(target));
    await writeFile(target, 'user authored\n', 'utf-8');

    await writeSkills([], root);

    expect(await readFile(target, 'utf-8')).toBe('user authored\n');
  });

  it('a manifest entry with a mismatched key does not authorize destruction', async () => {
    const target = path.join(root, 'a', SKILL_MD);
    await mkdir(path.dirname(target));
    await writeFile(target, 'user authored\n', 'utf-8');
    await writeManifest(root, {
      manifestVersion: 1,
      // The path is listed, but under a different key than the skill being
      // written to it.
      entries: { [`a/${SKILL_MD}`]: manifestEntry('some-other-key', 1, 'user authored\n') },
    });

    const report = await writeSkills([skill('a')], root);

    expect(report.ok).toBe(false);
    expect(actionsByKey(report).a.action).toBe('error');
    expect(await readFile(target, 'utf-8')).toBe('user authored\n');
  });
});

// ─── Corrupt manifest ────────────────────────────────────────────────

const DIVERGENT_CONTENT = 'existing content\n';

/** A parseable entries map that really does claim `a/SKILL.md` as managed. */
function liveEntries(): Record<string, unknown> {
  return { [`a/${SKILL_MD}`]: manifestEntry('a', 1, DIVERGENT_CONTENT) };
}

/**
 * The first six variants are unparseable: `entries` is missing, the wrong type,
 * or the whole document is garbage. That makes "performed no destructive action"
 * arithmetic rather than a defense — with no entries to act on, a file at a
 * managed path is protected by clobber protection and there is nothing to prune,
 * so those cases pass against an implementation that simply treats a corrupt
 * manifest as an empty one.
 *
 * The `*_live_entries` variants are the ones that actually test the rule: corrupt
 * ONLY in `manifestVersion`, with a valid entries map listing the managed path
 * under a matching key. The implementation has everything it needs to overwrite
 * and to prune, and must refuse anyway.
 */
const CORRUPT_MANIFESTS: Array<[string, unknown]> = [
  ['garbage', '{not json at all'],
  ['empty', ''],
  ['wrong_types', { manifestVersion: 1, entries: [`a/${SKILL_MD}`] }],
  ['entries_missing', { manifestVersion: 1 }],
  ['future_version', { manifestVersion: 2, entries: {} }],
  ['version_not_int', { manifestVersion: '1', entries: {} }],
  ['future_version_live_entries', { manifestVersion: 2, entries: liveEntries() }],
  ['version_not_int_live_entries', { manifestVersion: '1', entries: liveEntries() }],
];

const LIVE_ENTRY_MANIFESTS = CORRUPT_MANIFESTS.filter(([name]) => name.endsWith('_live_entries'));

describe('writeSkills corrupt manifest', () => {
  it.each(CORRUPT_MANIFESTS)('performs no destructive action and reports an error: %s', async (_label, raw) => {
    const target = path.join(root, 'a', SKILL_MD);
    await mkdir(path.dirname(target));
    await writeFile(target, DIVERGENT_CONTENT, 'utf-8');
    await writeManifest(root, raw);

    const report = await writeSkills([skill('a', 2, 'new content\n')], root);

    expect(report.ok).toBe(false);
    // The error must name the manifest. For the unparseable variants the file at
    // the managed path is also unmanaged, so a bare "some error happened"
    // assertion is satisfied by clobber protection alone and says nothing about
    // whether the manifest state was detected at all.
    const errors = errorMessages(report);
    expect(errors.some((e) => e.toLowerCase().includes('manifest'))).toBe(true);
    expect(await readFile(target, 'utf-8')).toBe(DIVERGENT_CONTENT);
  });

  it('a run-level error carries the empty-key sentinel', async () => {
    // The empty string is public API surface: a caller grouping the report by
    // key has to know the sentinel exists.
    await writeManifest(root, '{not json at all');

    const report = await writeSkills([skill('a')], root);

    const manifestErrors = report.errors.filter((a) => (a.error ?? '').toLowerCase().includes('manifest'));
    expect(manifestErrors.length).toBeGreaterThan(0);
    for (const action of manifestErrors) expect(action.key).toBe('');
    // A per-skill error in the same report still carries its real key, so the
    // sentinel is not simply "every error action has an empty key".
    for (const action of report.errors.filter((a) => !manifestErrors.includes(a))) {
      expect(action.key).not.toBe('');
    }
  });

  it.each(
    LIVE_ENTRY_MANIFESTS,
  )('does not prune a managed file when only the version is corrupt: %s', async (_label, raw) => {
    // Here the implementation can read the entries map and knows exactly which
    // file it owns, so refusing to remove it is a real decision rather than an
    // absence of information.
    const target = path.join(root, 'a', SKILL_MD);
    await mkdir(path.dirname(target));
    await writeFile(target, DIVERGENT_CONTENT, 'utf-8');
    await writeManifest(root, raw);

    const report = await writeSkills([], root);

    expect(report.ok).toBe(false);
    expect(await readFile(target, 'utf-8')).toBe(DIVERGENT_CONTENT);
    expect(report.actions.filter((a) => a.action === 'removed')).toEqual([]);
    expect(errorMessages(report).some((e) => e.toLowerCase().includes('manifest'))).toBe(true);
  });

  it('prunes nothing under an unparseable manifest', async () => {
    const target = path.join(root, 'a', SKILL_MD);
    await mkdir(path.dirname(target));
    await writeFile(target, DIVERGENT_CONTENT, 'utf-8');
    await writeManifest(root, '{not json at all');

    const report = await writeSkills([], root);

    expect(report.ok).toBe(false);
    expect(await exists(target)).toBe(true);
    expect(report.actions.filter((a) => a.action === 'removed')).toEqual([]);
  });

  it('may still write brand-new paths', async () => {
    await writeManifest(root, '{not json at all');

    const report = await writeSkills([skill('fresh')], root);

    expect(actionsByKey(report).fresh.action).toBe('written');
    expect(await readFile(path.join(root, 'fresh', SKILL_MD), 'utf-8')).toBe(SKILL_BODY);
  });

  it('does not destroy the corrupt manifest file itself', async () => {
    await writeManifest(root, '{not json at all');

    await writeSkills([], root);

    expect(await readFile(manifestPath(root), 'utf-8')).toBe('{not json at all');
  });

  it('treats an unreadable manifest as corrupt', async () => {
    await placeManaged(root, 'a', DIVERGENT_CONTENT);
    // Non-UTF-8 bytes are corruption, and must fail closed like any other.
    await writeFile(manifestPath(root), Buffer.from([0xff, 0xfe, 0x00, 0x01]));

    const report = await writeSkills([], root);

    expect(report.ok).toBe(false);
    expect(await exists(path.join(root, 'a', SKILL_MD))).toBe(true);
  });
});
