/**
 * `writeSkills` — filesystem materialization, manifest reconcile semantics, and
 * the full security abuse matrix.
 *
 * Every test writes only inside its own `os.tmpdir()` scratch directory. No
 * network, no real LaunchDarkly client, no real skill transport.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fsOps, SUPPORTS_DIR_FD } from '../safe-fs.js';
import { _clearState, _setEmitterForTesting, _setStore, InMemorySkillStore, skillRefs } from '../skills.js';
import { writeSkills } from '../skills-fs.js';
import type { RawSkillObject, ReconcileAction, ReconcileReport, Skill, SkillStore } from '../types.js';
import { createSkill, isValidSkillKey, parseAiConfig } from '../types.js';

// ─── Constants spelled out by hand ───────────────────────────────────────────
//
// These two strings are a cross-language on-disk contract, so
// the filesystem tests write them literally. A test that imported the
// implementation's own constant could not detect a change to it.

const SKILL_MD = 'SKILL.md';
const MANIFEST_NAME = '.launchdarkly-skills.json';

const SKILL_BODY = '---\nname: Test Skill\n---\nDo the thing.\n';
const INJECTED = 'simulated crash between write and rename';

const INTEGRITY_SIGNAL = 'AgentControl Skill Integrity Failure';
const MATERIALIZED_SIGNAL = 'AgentControl Skill Materialized';
const REVOKED_SIGNAL = 'AgentControl Skill Revoked Received';

const APPROVED_SIGNALS = new Set([INTEGRITY_SIGNAL, MATERIALIZED_SIGNAL, REVOKED_SIGNAL]);
const REMOVED_SIGNALS = ['AgentControl Skill SDK Reference Returned', 'AgentControl Skill Content Retrieved'];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function hash(content: string): string {
  return createHash('sha256').update(Buffer.from(content, 'utf-8')).digest('hex');
}

function skill(key = 'test-skill', version = 1, content = SKILL_BODY): Skill {
  // A `Skill` carries the verified bytes; the string form here is only test
  // convenience, hashed identically to its UTF-8 encoding.
  return createSkill({ key, version, content: new TextEncoder().encode(content), contentHash: hash(content) });
}

function rawSkill(key: string, version = 1, content = SKILL_BODY): RawSkillObject {
  return { key, version, content, contentHash: hash(content) };
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

class RecordingEmitter {
  records: Array<[string, Record<string, unknown>]> = [];
  record(signal: string, properties: Record<string, unknown>): void {
    this.records.push([signal, properties]);
  }
  signals(name: string): Array<Record<string, unknown>> {
    return this.records.filter(([s]) => s === name).map(([, p]) => p);
  }
  names(): Set<string> {
    return new Set(this.records.map(([s]) => s));
  }
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

/** The prune-side hook — one interceptable call site, same filter. */
function interceptUnlink(options: { fail?: boolean } = {}): string[] {
  const calls: string[] = [];
  const real = fsOps.unlink.bind(fsOps);
  vi.spyOn(fsOps, 'unlink').mockImplementation(async (target: string) => {
    if (target.endsWith(SKILL_MD)) {
      calls.push(target);
      if (options.fail) throw new Error(INJECTED);
    }
    return real(target);
  });
  return calls;
}

/**
 * Assert the one recorded rename put `SKILL.md` into `skillDir`.
 *
 * The temp file must be created in the target's own
 * directory, so the rename is atomic rather than cross-device. TypeScript always
 * sees the **full-path** call shape,
 * because Node exposes no `renameat` (see the `SUPPORTS_DIR_FD` test below).
 */
function assertAtomicRenameOf(calls: RenameCall[], skillDir: string): void {
  expect(calls).toHaveLength(1);
  const { src, dst } = calls[0];
  expect(dst).toBe(path.join(skillDir, SKILL_MD));
  expect(path.dirname(src)).toBe(skillDir);
  expect(path.basename(src)).not.toBe(SKILL_MD);
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

// ─── Basic writes and the returned report ──────────────────────────────

describe('writeSkills basic writes', () => {
  it('writes a new skill verbatim and reports written', async () => {
    const report = await writeSkills([skill('pdf-extraction', 2)], root);

    const target = path.join(root, 'pdf-extraction', SKILL_MD);
    expect(await readFile(target, 'utf-8')).toBe(SKILL_BODY);
    expect(report.ok).toBe(true);
    const action = actionsByKey(report)['pdf-extraction'];
    expect(action.action).toBe('written');
    expect(action.version).toBe(2);
    expect(action.path).toBe(target);
  });

  it('accepts Skill inputs with no store configured', async () => {
    const report = await writeSkills([skill('a')], root);
    expect(report.ok).toBe(true);
  });

  it('resolves SkillReference inputs through the store', async () => {
    const store = new InMemorySkillStore();
    store.put(rawSkill('a', 3));
    _setStore(store);

    const report = await writeSkills([{ key: 'a', version: 3 }], root);

    expect(report.ok).toBe(true);
    expect(await readFile(path.join(root, 'a', SKILL_MD), 'utf-8')).toBe(SKILL_BODY);
  });

  it('resolves bare-string inputs as the latest version', async () => {
    const store = new InMemorySkillStore();
    store.put(rawSkill('a', 9));
    _setStore(store);

    const report = await writeSkills(['a'], root);

    expect(actionsByKey(report).a.version).toBe(9);
  });

  it('"*" writes everything the store holds', async () => {
    const store = new InMemorySkillStore();
    for (const key of ['a', 'b', 'c']) store.put(rawSkill(key));
    _setStore(store);

    const report = await writeSkills('*', root);

    expect(report.ok).toBe(true);
    expect(report.actions.filter((a) => a.action !== 'error')).toHaveLength(3);
  });

  it('reports one action per requested skill — no silent skips', async () => {
    const report = await writeSkills([skill('a'), skill('b')], root);
    expect(report.actions.map((a) => a.key).sort()).toEqual(['a', 'b']);
  });

  it('an empty request on an empty root is ok', async () => {
    const report = await writeSkills([], root);
    expect(report.ok).toBe(true);
  });
});

// ─── Manifest ──────────────────────────────────────────────────────────

describe('writeSkills manifest', () => {
  it('has the exact cross-language format', async () => {
    await writeSkills([skill('a', 2)], root);

    const manifest = await readManifest(root);
    expect(manifest.manifestVersion).toBe(1);
    const entries = manifest.entries as Record<string, Record<string, unknown>>;
    const entry = entries[`a/${SKILL_MD}`];
    expect(entry).toBeDefined();
    expect(entry.key).toBe('a');
    expect(entry.version).toBe(2);
    expect(entry.sha256).toBe(hash(SKILL_BODY));
    expect(typeof entry.writtenAt).toBe('string');
  });

  it('serializes exactly the way the Python SDK does', async () => {
    // Not a correctness requirement — both languages parse either form — but a
    // repo where both SDKs run would otherwise see the key order flip on every
    // reconcile depending on which wrote last. Python writes
    // json.dumps(..., indent=2, sort_keys=True): two-space indent, sorted keys,
    // no trailing newline.
    await writeManifest(root, { zeta: 'unknown field', manifestVersion: 1, entries: {}, alpha: 1 });
    await writeSkills([skill('b')], root);
    await writeSkills([skill('b'), skill('a')], root);

    const raw = await readFile(manifestPath(root), 'utf-8');
    expect(raw.endsWith('\n')).toBe(false);
    expect(raw).toContain('\n  "');
    const topLevel = [...raw.matchAll(/^ {2}"([^"]+)":/gm)].map((m) => m[1]);
    expect(topLevel).toEqual([...topLevel].sort());
    // Nested keys are sorted too, so entry order does not depend on write order.
    const entryPaths = Object.keys((await readManifest(root)).entries as object);
    expect(entryPaths).toEqual([...entryPaths].sort());
  });

  it('escapes non-ASCII exactly as Python does', async () => {
    // The manifest's bytes are a cross-language contract, and
    // Python writes it with json.dumps(..., indent=2, sort_keys=True), which
    // defaults to ensure_ascii=True. JSON.stringify emits raw UTF-8, so the two
    // SDKs would rewrite the same file with different bytes on alternating
    // reconciles — the churn the sorted-key rule already exists to prevent.
    //
    // Every field the SDK writes is ASCII by construction, so this is only
    // reachable through the preserved-unknown-field path — which is why
    // the seeded field is what carries the non-ASCII.
    await writeManifest(root, {
      manifestVersion: 1,
      entries: {},
      note: 'café ☕ 😀',
    });

    await writeSkills([skill('b')], root);

    const raw = await readFile(manifestPath(root), 'utf-8');
    // Escaped form, astral characters as a surrogate pair — byte-for-byte what
    // Python emits for the same value.
    expect(raw).toContain('"note": "caf\\u00e9 \\u2615 \\ud83d\\ude00"');
    expect(raw).not.toContain('café');
    // Still parses back to the original string, so preservation is unaffected.
    expect((await readManifest(root)).note).toBe('café ☕ 😀');
  });

  it('keys entries by root-relative forward-slash paths', async () => {
    await writeSkills([skill('a')], root);
    const entries = (await readManifest(root)).entries as Record<string, unknown>;
    expect(Object.keys(entries)).toEqual(['a/SKILL.md']);
  });

  it('preserves unknown top-level and per-entry fields on rewrite', async () => {
    await writeManifest(root, {
      manifestVersion: 1,
      futureTopLevel: 'keep me',
      entries: { [`a/${SKILL_MD}`]: { ...manifestEntry('a', 1, SKILL_BODY), futureEntryField: 'keep me too' } },
    });
    await mkdir(path.join(root, 'a'));
    await writeFile(path.join(root, 'a', SKILL_MD), SKILL_BODY, 'utf-8');

    await writeSkills([skill('a', 2, 'new content\n')], root);

    const manifest = await readManifest(root);
    expect(manifest.futureTopLevel).toBe('keep me');
    const entries = manifest.entries as Record<string, Record<string, unknown>>;
    expect(entries[`a/${SKILL_MD}`].futureEntryField).toBe('keep me too');
    expect(entries[`a/${SKILL_MD}`].version).toBe(2);
  });
});

// ─── Reconcile semantics ───────────────────────────────────────────────

describe('writeSkills reconcile semantics', () => {
  it('reports skipped_current for an unchanged managed file without rewriting it', async () => {
    await placeManaged(root, 'a', SKILL_BODY);
    const calls = interceptRename();

    const report = await writeSkills([skill('a')], root);

    expect(actionsByKey(report).a.action).toBe('skipped_current');
    expect(calls).toEqual([]);
  });

  it('reports updated when the resolved content differs', async () => {
    const target = await placeManaged(root, 'a', 'old content\n');

    const report = await writeSkills([skill('a', 2, 'new content\n')], root);

    expect(actionsByKey(report).a.action).toBe('updated');
    expect(await readFile(target, 'utf-8')).toBe('new content\n');
  });

  it('overwrites local tampering — LD-resolved content wins', async () => {
    const target = await placeManaged(root, 'a', SKILL_BODY);
    await writeFile(target, 'locally tampered\n', 'utf-8');

    const report = await writeSkills([skill('a')], root);

    expect(actionsByKey(report).a.action).toBe('updated');
    expect(await readFile(target, 'utf-8')).toBe(SKILL_BODY);
  });

  it('prunes a formerly-managed skill, file then empty directory', async () => {
    const target = await placeManaged(root, 'gone', SKILL_BODY);

    const report = await writeSkills([], root);

    const action = actionsByKey(report).gone;
    expect(action.action).toBe('removed');
    expect(action.version).toBe(1);
    expect(await exists(target)).toBe(false);
    expect(await exists(path.dirname(target))).toBe(false);
    const entries = (await readManifest(root)).entries as Record<string, unknown>;
    expect(entries).toEqual({});
  });

  it('prune: false keeps the file and reports no removal', async () => {
    const target = await placeManaged(root, 'gone', SKILL_BODY);

    const report = await writeSkills([], root, { prune: false });

    expect(await exists(target)).toBe(true);
    expect(report.actions.filter((a) => a.action === 'removed')).toEqual([]);
  });

  it('pruning never touches an unmanaged file inside the root', async () => {
    await placeManaged(root, 'gone', SKILL_BODY);
    const userFile = path.join(root, 'notes.md');
    await writeFile(userFile, 'user authored\n', 'utf-8');

    await writeSkills([], root);

    expect(await readFile(userFile, 'utf-8')).toBe('user authored\n');
  });

  it('keeps a skill directory that still holds other files', async () => {
    const target = await placeManaged(root, 'gone', SKILL_BODY);
    const sibling = path.join(path.dirname(target), 'README.md');
    await writeFile(sibling, 'user authored\n', 'utf-8');

    await writeSkills([], root);

    expect(await exists(target)).toBe(false);
    expect(await readFile(sibling, 'utf-8')).toBe('user authored\n');
  });

  it('a prune refusal reports the version it already knows', async () => {
    // The manifest entry is in hand at that point, so omitting the version
    // would make a prune *failure* strictly less informative than a prune
    // *success*. Here the manifest names a path this SDK could never own.
    await writeManifest(root, {
      manifestVersion: 1,
      entries: { 'gone/nested/SKILL.md': manifestEntry('gone', 7, SKILL_BODY) },
    });

    const report = await writeSkills([], root);

    expect(report.ok).toBe(false);
    const action = actionsByKey(report).gone;
    expect(action.action).toBe('error');
    expect(action.version).toBe(7);
  });

  it('a prune refusal for an unlink failure reports the version too', async () => {
    await placeManaged(root, 'gone', SKILL_BODY, 4);
    const calls = interceptUnlink({ fail: true });

    const report = await writeSkills([], root);

    expect(calls).toHaveLength(1);
    const action = actionsByKey(report).gone;
    expect(action.action).toBe('error');
    expect(action.version).toBe(4);
  });

  it('leaves version null when it genuinely is not known', async () => {
    // A retrieval that failed before any content arrived: no manifest entry and
    // no Skill, so there is no version to report. Do not invent one.
    const report = await writeSkills([{ key: 'a', version: 3 }], root);

    const action = actionsByKey(report).a;
    expect(action.action).toBe('error');
    expect(action.version).toBeNull();
  });
});

// ─── Root handling ─────────────────────────────────────────────────────

describe('writeSkills root handling', () => {
  it('creates an absent leaf directory whose parent exists', async () => {
    const fresh = path.join(scratch, 'fresh-root');

    const report = await writeSkills([skill('a')], fresh);

    expect(report.ok).toBe(true);
    expect(await readFile(path.join(fresh, 'a', SKILL_MD), 'utf-8')).toBe(SKILL_BODY);
  });

  it('raises rather than creating missing ancestors', async () => {
    await expect(writeSkills([skill('a')], path.join(scratch, 'a', 'b', 'c'))).rejects.toThrow();
    expect(await exists(path.join(scratch, 'a'))).toBe(false);
  });

  it('raises when the root is a file', async () => {
    const asFile = path.join(scratch, 'a-file');
    await writeFile(asFile, 'not a directory\n', 'utf-8');
    await expect(writeSkills([skill('a')], asFile)).rejects.toThrow();
  });

  it('a root error is not a TypeError — it is a caller value error', async () => {
    // TypeError is reserved for the accessors' bare-string guard,
    // and TypeError extends Error, so the negative half is what makes the
    // distinction observable in TypeScript at all.
    const error = await writeSkills([skill('a')], path.join(scratch, 'a', 'b')).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(TypeError);
  });
});

// ─── Argument errors ───────────────────────────────────────────────────

describe('writeSkills bare-string guard', () => {
  it('raises for a bare string that is not "*", naming the accepted forms', async () => {
    const error = await writeSkills('pdf-extraction' as unknown as Skill[], root).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    // Unlike the accessors' guard this is a *value* error: a string is an
    // accepted argument type here and only "*" is a valid one.
    expect(error).not.toBeInstanceOf(TypeError);
    expect((error as Error).message).toContain('"*"');
  });

  it('"*" is accepted — the positive control', async () => {
    const store = new InMemorySkillStore();
    store.put(rawSkill('a'));
    _setStore(store);

    const report = await writeSkills('*', root);

    expect(report.ok).toBe(true);
    expect(await exists(path.join(root, 'a', SKILL_MD))).toBe(true);
  });

  it('writes nothing before raising', async () => {
    // Asserting only the raise would also pass for an implementation that
    // created one directory per character before failing.
    await expect(writeSkills('abc' as unknown as Skill[], root)).rejects.toThrow();
    expect(await entryNames(root)).toEqual([]);
  });

  it('rejects an out-of-range onUnavailable value', async () => {
    await expect(writeSkills([skill('a')], root, { onUnavailable: 'explode' as 'keep' })).rejects.toThrow();
  });

  it('rejects a negative timeout', async () => {
    await expect(writeSkills([skill('a')], root, { timeout: -1 })).rejects.toThrow();
  });
});

// ─── Atomicity and permissions ─────────────────────────────────────────

describe('writeSkills atomicity and permissions', () => {
  it.skipIf(process.platform === 'win32')('writes files as 0644, never executable', async () => {
    await writeSkills([skill('a')], root);
    const mode = (await stat(path.join(root, 'a', SKILL_MD))).mode & 0o777;
    expect(mode).toBe(0o644);
    expect(mode & fsConstants.S_IXUSR).toBe(0);
    expect(mode & fsConstants.S_IXGRP).toBe(0);
    expect(mode & fsConstants.S_IXOTH).toBe(0);
  });

  it('goes through a single atomic rename with the temp file in the target directory', async () => {
    // Positive control for the interception hook. Without this,
    // the `calls === []` assertions in the failure tests below and in the
    // traversal matrix could pass in a suite where the hook is unreachable.
    const calls = interceptRename();

    const report = await writeSkills([skill('a')], root);

    expect(report.ok).toBe(true);
    assertAtomicRenameOf(calls, path.join(root, 'a'));
    expect(await readFile(path.join(root, 'a', SKILL_MD), 'utf-8')).toBe(SKILL_BODY);
  });

  it('leaves prior content byte-for-byte intact when the rename fails', async () => {
    const target = await placeManaged(root, 'a', SKILL_BODY);
    const calls = interceptRename({ fail: true });

    const report = await writeSkills([skill('a', 2, 'brand new content\n')], root);

    // The injected failure — not an unrelated rejection, and not an
    // implementation that attempted nothing — is what produced the error.
    assertAtomicRenameOf(calls, path.dirname(target));
    expect(report.ok).toBe(false);
    const action = actionsByKey(report).a;
    expect(action.action).toBe('error');
    expect(action.error).toContain(INJECTED);

    expect(await readFile(target, 'utf-8')).toBe(SKILL_BODY);
    // No temp artifact survives the failed run.
    expect(await entryNames(path.dirname(target))).toEqual([SKILL_MD]);
  });

  it('leaves no partial file and no temp file for a brand-new skill', async () => {
    const calls = interceptRename({ fail: true });

    const report = await writeSkills([skill('a')], root);

    assertAtomicRenameOf(calls, path.join(root, 'a'));
    expect(report.ok).toBe(false);
    expect(actionsByKey(report).a.error).toContain(INJECTED);
    expect(await exists(path.join(root, 'a', SKILL_MD))).toBe(false);
    const skillDir = path.join(root, 'a');
    expect((await exists(skillDir)) ? await entryNames(skillDir) : []).toEqual([]);
  });

  it('never reuses an existing temp path — creation is exclusive', async () => {
    // The temp name is unpredictable and created with O_EXCL, so two writes in a
    // row use different names and neither writes through a planted file.
    const first = interceptRename();
    await writeSkills([skill('a')], root);
    const firstTemp = first[0].src;
    vi.restoreAllMocks();

    const second = interceptRename();
    await writeSkills([skill('a', 2, 'new content\n')], root);

    expect(second[0].src).not.toBe(firstTemp);
  });

  it('leaves a valid JSON manifest after a run containing per-skill errors', async () => {
    const report = await writeSkills([skill('a'), skill('../evil')], root);
    expect(report.ok).toBe(false);
    expect(await readManifest(root)).toBeInstanceOf(Object);
  });
});

// ─── Resilience ────────────────────────────────────────────────────────

describe('writeSkills resilience', () => {
  it('keep is the default: existing managed files survive and nothing raises', async () => {
    const existing = await placeManaged(root, 'a', SKILL_BODY);

    const report = await writeSkills([{ key: 'a', version: 1 }], root);

    expect(report.ok).toBe(false);
    expect(actionsByKey(report).a.action).toBe('error');
    expect(await readFile(existing, 'utf-8')).toBe(SKILL_BODY);
  });

  it('raise mode propagates, with a message that says retrieval was unavailable', async () => {
    // Assert on the message, not just the raise — a bare "not implemented"
    // error would otherwise satisfy this.
    await expect(writeSkills([{ key: 'a', version: 1 }], root, { onUnavailable: 'raise' })).rejects.toThrow(
      /unavailable|skill store/i,
    );
  });

  it('reports a throwing store rather than raising', async () => {
    const exploding: SkillStore = {
      getObject() {
        throw new Error('transport failure');
      },
      allObjects() {
        throw new Error('transport failure');
      },
    };
    _setStore(exploding);

    const report = await writeSkills([{ key: 'a', version: 1 }], root);

    expect(report.ok).toBe(false);
    expect(actionsByKey(report).a.error).toMatch(/transport failure/);
  });

  it('does not prune when a store outage left the run incomplete', async () => {
    // Deleting managed files because a lookup failed would turn an outage into
    // data loss.
    const existing = await placeManaged(root, 'stays', SKILL_BODY);
    _setStore({
      getObject() {
        throw new Error('transport failure');
      },
      allObjects() {
        throw new Error('transport failure');
      },
    });

    const report = await writeSkills('*', root);

    expect(await readFile(existing, 'utf-8')).toBe(SKILL_BODY);
    expect(report.actions.filter((a) => a.action === 'removed')).toEqual([]);
  });

  it('an exhausted timeout behaves as unavailable', async () => {
    const store = new InMemorySkillStore();
    store.put(rawSkill('a'));
    _setStore(store);
    const calls = interceptRename();

    const report = await writeSkills([{ key: 'a', version: 1 }], root, { timeout: 0 });

    expect(report.ok).toBe(false);
    expect(calls).toEqual([]);
    expect(await exists(path.join(root, 'a', SKILL_MD))).toBe(false);
  });

  it('an exhausted timeout raises in raise mode', async () => {
    const store = new InMemorySkillStore();
    store.put(rawSkill('a'));
    _setStore(store);

    await expect(writeSkills([{ key: 'a', version: 1 }], root, { timeout: 0, onUnavailable: 'raise' })).rejects.toThrow(
      /timeout|unavailable/i,
    );
  });

  it('never corrupts the manifest on an unavailable run', async () => {
    await placeManaged(root, 'a', SKILL_BODY);
    const before = await readManifest(root);

    await writeSkills([{ key: 'b', version: 1 }], root);

    const after = await readManifest(root);
    expect((after.entries as Record<string, unknown>)[`a/${SKILL_MD}`]).toEqual(
      (before.entries as Record<string, unknown>)[`a/${SKILL_MD}`],
    );
  });

  it('invokes a throwing store exactly once per requested skill — no retries', async () => {
    // There is deliberately no retry contract in either
    // language. The number of times a throwing store is invoked is observable,
    // so a retry added on one side alone would make the two diverge.
    let calls = 0;
    _setStore({
      getObject() {
        calls += 1;
        throw new Error('transport failure');
      },
      allObjects() {
        return {};
      },
    });

    await writeSkills([{ key: 'a', version: 1 }], root);

    expect(calls).toBe(1);
  });
});

// ─── Verify-then-write ─────────────────────────────────────────────────

describe('writeSkills verify-then-write', () => {
  it('rejects a Skill whose hash does not match its content', async () => {
    const emitter = new RecordingEmitter();
    _setEmitterForTesting(emitter);
    const calls = interceptRename();
    const bad = createSkill({
      key: 'a',
      version: 1,
      content: new TextEncoder().encode('new content\n'),
      contentHash: 'f'.repeat(64),
    });

    const report = await writeSkills([bad], root);

    expect(report.ok).toBe(false);
    expect(actionsByKey(report).a.action).toBe('error');
    expect(calls).toEqual([]);
    expect(await exists(path.join(root, 'a', SKILL_MD))).toBe(false);
    expect(emitter.signals(INTEGRITY_SIGNAL)).toHaveLength(1);
  });

  it('rejects an oversize Skill', async () => {
    const oversize = 'x'.repeat(64 * 1024 + 1);
    const bad = createSkill({
      key: 'a',
      version: 1,
      content: new TextEncoder().encode(oversize),
      contentHash: hash(oversize),
    });

    const report = await writeSkills([bad], root);

    expect(report.ok).toBe(false);
    expect(await exists(path.join(root, 'a', SKILL_MD))).toBe(false);
  });

  it('does not disturb an existing managed file when verification fails', async () => {
    const target = await placeManaged(root, 'a', SKILL_BODY);
    const bad = createSkill({
      key: 'a',
      version: 2,
      content: new TextEncoder().encode('new content\n'),
      contentHash: 'f'.repeat(64),
    });

    await writeSkills([bad], root);

    expect(await readFile(target, 'utf-8')).toBe(SKILL_BODY);
  });
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

// ─── Crash-mid-reconcile recovery ────────────────────────────────────

/**
 * The reconcile writes every skill file and only then writes the manifest,
 * atomically, once, last. A process killed in between leaves files at managed
 * paths with no manifest entry — which is, to the clobber check, exactly what a
 * customer-placed file looks like. Adoption on an exact hash match is what stops
 * those skills being wedged forever, and it cannot weaken the guarantee, because
 * the only bytes ever adopted are bytes LaunchDarkly resolved.
 */
describe('writeSkills crash-mid-reconcile recovery', () => {
  /** The post-crash state: a file at a managed path, and no manifest at all. */
  async function placeOrphaned(key: string, content: string): Promise<string> {
    const target = path.join(root, key, SKILL_MD);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, 'utf-8');
    return target;
  }

  it('adopts an unmanaged file whose bytes already are the resolved content', async () => {
    const target = await placeOrphaned('a', SKILL_BODY);
    expect(await exists(manifestPath(root))).toBe(false);
    const calls = interceptRename();

    const report = await writeSkills([skill('a')], root);

    expect(report.ok).toBe(true);
    const action = actionsByKey(report).a;
    expect(action.action).toBe('skipped_current');
    expect(action.path).toBe(target);
    // Adoption, not a rewrite: the bytes on disk already match, so nothing is
    // written and the file is left exactly as it was found.
    expect(calls).toEqual([]);
    expect(await readFile(target, 'utf-8')).toBe(SKILL_BODY);
    // And the manifest now records it, which is what un-wedges the key.
    const entries = (await readManifest(root)).entries as Record<string, Record<string, unknown>>;
    expect(entries[`a/${SKILL_MD}`]).toMatchObject({ key: 'a', version: 1, sha256: hash(SKILL_BODY) });
  });

  it('the reconcile after an adoption is an ordinary no-op', async () => {
    await placeOrphaned('a', SKILL_BODY);
    const first = await writeSkills([skill('a')], root);
    expect(actionsByKey(first).a.action).toBe('skipped_current');

    // Second run: the entry exists now, so this takes the ordinary managed path
    // — nothing written, nothing removed, still ok.
    const calls = interceptRename();
    const second = await writeSkills([skill('a')], root);

    expect(second.ok).toBe(true);
    expect(actionsByKey(second).a.action).toBe('skipped_current');
    expect(calls).toEqual([]);
    expect(await readFile(path.join(root, 'a', SKILL_MD), 'utf-8')).toBe(SKILL_BODY);
  });

  it('adopts only on an exact byte match — one byte of difference is refused', async () => {
    const divergent = `${SKILL_BODY} `;
    const target = await placeOrphaned('a', divergent);
    const calls = interceptRename();

    const report = await writeSkills([skill('a')], root);

    expect(report.ok).toBe(false);
    const action = actionsByKey(report).a;
    expect(action.action).toBe('error');
    expect(action.error).toContain('does not record it as managed');
    expect(calls).toEqual([]);
    expect(await readFile(target, 'utf-8')).toBe(divergent);
    // Refused means refused all the way: no entry is created for it either, so
    // the next run cannot mistake the file for one this SDK manages.
    expect(await readManifest(root)).toMatchObject({ entries: {} });
  });

  it('adopts one skill and refuses another in the same run', async () => {
    await placeOrphaned('adopted', SKILL_BODY);
    const foreign = await placeOrphaned('foreign', 'user authored\n');

    const report = await writeSkills([skill('adopted'), skill('foreign')], root);

    const byKey = actionsByKey(report);
    expect(byKey.adopted.action).toBe('skipped_current');
    expect(byKey.foreign.action).toBe('error');
    expect(await readFile(foreign, 'utf-8')).toBe('user authored\n');
    expect(Object.keys((await readManifest(root)).entries as object)).toEqual([`adopted/${SKILL_MD}`]);
  });
});

// ─── Targets that must not be read as ordinary files ─────────────────

/** `chmod 000` proves nothing as root, and means something else on Windows. */
const CAN_TEST_UNREADABLE = process.platform !== 'win32' && process.getuid?.() !== 0;

describe('writeSkills non-regular and unreadable targets', () => {
  // Adoption widened the read to unmanaged, genuinely foreign files, so the read
  // itself has to be as defensive as the checks around it. A FIFO or a device
  // node is neither a symlink nor a directory, so `unsafePathReason` does not
  // see it at all.
  it.skipIf(process.platform === 'win32')(
    'refuses a FIFO at a managed path instead of blocking on the open',
    async () => {
      // `readFile` on a FIFO with no writer never returns, which would hang the
      // reconcile and the event loop with it. The explicit timeout is the point
      // of this test: a regression has to fail here rather than stall CI.
      const target = path.join(root, 'a', SKILL_MD);
      await mkdir(path.dirname(target));
      execFileSync('mkfifo', [target]);
      const calls = interceptRename();

      const report = await writeSkills([skill('a')], root);

      expect(report.ok).toBe(false);
      expect(actionsByKey(report).a.error).toContain('could not be read');
      expect(calls).toEqual([]);
      // Left exactly as it was: a refusal is not an invitation to clean up.
      expect((await lstat(target)).isFIFO()).toBe(true);
    },
    5_000,
  );

  it('refuses a directory standing where SKILL.md belongs', async () => {
    // The type check is an `fstat` on the handle rather than a `stat` on the
    // path, so this is refused for what the descriptor is, not what the name is.
    await mkdir(path.join(root, 'a', SKILL_MD), { recursive: true });
    const calls = interceptRename();

    const report = await writeSkills([skill('a')], root);

    expect(report.ok).toBe(false);
    expect(actionsByKey(report).a.error).toContain('could not be read');
    expect(calls).toEqual([]);
    expect((await lstat(path.join(root, 'a', SKILL_MD))).isDirectory()).toBe(true);
  });

  it.skipIf(!CAN_TEST_UNREADABLE)('refuses rather than overwriting when an unmanaged file cannot be read', async () => {
    // The dangerous failure mode: a read error on the adoption path falling
    // through to the write, which would turn "the bytes could not be checked"
    // into an overwrite of a file this SDK does not own.
    const target = path.join(root, 'a', SKILL_MD);
    await mkdir(path.dirname(target));
    await writeFile(target, 'user authored\n', 'utf-8');
    await chmod(target, 0o000);
    const calls = interceptRename();

    const report = await writeSkills([skill('a')], root);

    expect(report.ok).toBe(false);
    const { error } = actionsByKey(report).a;
    expect(error).toContain('could not be read');
    // Distinguishable from the collision refusal: "we could not look" and "we
    // looked, and the bytes are foreign" call for different operator responses.
    expect(error).not.toContain('does not record it as managed');
    expect(calls).toEqual([]);

    await chmod(target, 0o644);
    expect(await readFile(target, 'utf-8')).toBe('user authored\n');
  });
});

// ─── Windows reserved device names ───────────────────────────────────

/**
 * Every name Windows resolves as a device rather than as a path, all of which
 * the key grammar `^[a-z0-9][a-z0-9-]*$` admits. Spelled out here rather than
 * imported, for the same reason the on-disk filenames are: a test that read the
 * implementation's own set could not detect a change to it.
 */
const WINDOWS_RESERVED_KEYS = [
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
];

describe('writeSkills Windows reserved device names', () => {
  it('is exactly 22 names', () => {
    expect(WINDOWS_RESERVED_KEYS).toHaveLength(22);
    expect(new Set(WINDOWS_RESERVED_KEYS).size).toBe(22);
  });

  it.each(WINDOWS_RESERVED_KEYS)('refuses to write the reserved key %s', async (key) => {
    const calls = interceptRename();

    const report = await writeSkills([skill(key)], root);

    expect(report.ok).toBe(false);
    const action = actionsByKey(report)[key];
    expect(action.action).toBe('error');
    expect(action.error).toContain('reserved device name');
    // Rejected before any filesystem call, so nothing is attempted and no
    // directory is left behind on a platform that would have allowed one.
    expect(calls).toEqual([]);
    expect(await exists(path.join(root, key))).toBe(false);
  });

  it.each(WINDOWS_RESERVED_KEYS)('refuses to prune the reserved key %s', async (key) => {
    // `keyRejectionReason` is shared by the write and the prune paths, so the
    // same rejection has to hold on the destructive side: a manifest entry
    // naming a key this SDK could not have written is not authority to delete.
    const target = path.join(root, key, SKILL_MD);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, SKILL_BODY, 'utf-8');
    await writeManifest(root, {
      manifestVersion: 1,
      entries: { [`${key}/${SKILL_MD}`]: manifestEntry(key, 1, SKILL_BODY) },
    });

    const report = await writeSkills([], root);

    expect(report.ok).toBe(false);
    const action = actionsByKey(report)[key];
    expect(action.action).toBe('error');
    expect(action.error).toContain('could own');
    expect(await readFile(target, 'utf-8')).toBe(SKILL_BODY);
    // The entry is left in place rather than dropped, so the refusal stays
    // visible on every run instead of silently forgetting the file.
    expect(Object.keys((await readManifest(root)).entries as object)).toEqual([`${key}/${SKILL_MD}`]);
  });

  it('com0 and lpt0 are not reserved and still write', async () => {
    // The set is exactly the reserved names. Widening it to a `com[0-9]` shape
    // would break two keys that work fine on every platform.
    const report = await writeSkills([skill('com0'), skill('lpt0')], root);

    expect(report.ok).toBe(true);
    expect(await readFile(path.join(root, 'com0', SKILL_MD), 'utf-8')).toBe(SKILL_BODY);
    expect(await readFile(path.join(root, 'lpt0', SKILL_MD), 'utf-8')).toBe(SKILL_BODY);
  });

  it('a reserved name is still a valid key at the grammar level', () => {
    // This is the whole reason the check lives in the filesystem layer rather
    // than in `isValidSkillKey`. `parseAiConfig` fails closed on a bad skills
    // entry, so a grammar-level rejection would invalidate the *entire* AI
    // Config — model, provider, instructions, tools — for a Linux or macOS
    // customer, over a constraint that only exists on Windows. And `skillRefs`
    // would silently drop the reference, which lets prune delete the skill's
    // on-disk copy: "this fails to write on Windows" would become "this gets
    // deleted on Linux".
    for (const key of WINDOWS_RESERVED_KEYS) expect(isValidSkillKey(key)).toBe(true);

    const parsed = parseAiConfig({
      model: { name: 'gpt-4' },
      provider: { name: 'openai' },
      instructions: 'be helpful',
      skills: [{ key: 'con', version: 1 }],
    });

    expect(parsed.success).toBe(true);
    expect(skillRefs(parsed.success ? parsed.data : null).map((ref) => ref.key)).toEqual(['con']);
  });
});

// ─── Orphaned temp files ─────────────────────────────────────────────

/**
 * `atomicWrite` creates its temp file exclusively in the target's own directory
 * and removes it on any error it sees — but not after a SIGKILL. Prune walks
 * manifest entries only, so an orphan left that way is invisible to the rest of
 * the reconcile forever, and it also blocks the `rmdir` that would clean up an
 * emptied skill directory. The sweep is deliberately narrow, so most of what
 * follows is about what it must *not* remove.
 */
describe('writeSkills orphaned temp files', () => {
  /** Exactly the shape `safe-fs.ts` produces: `.SKILL.md.<16 lowercase hex>.tmp`. */
  function orphanName(hex = 'a1b2c3d4e5f60718'): string {
    return `.${SKILL_MD}.${hex}.tmp`;
  }

  it('sweeps an orphan left behind by a killed reconcile', async () => {
    const target = await placeManaged(root, 'a', SKILL_BODY);
    const orphan = path.join(root, 'a', orphanName());
    await writeFile(orphan, 'half-written\n', 'utf-8');

    const report = await writeSkills([skill('a')], root);

    expect(report.ok).toBe(true);
    expect(await exists(orphan)).toBe(false);
    expect(await readFile(target, 'utf-8')).toBe(SKILL_BODY);
  });

  it('sweeps ahead of the prune, so an orphan cannot block the rmdir', async () => {
    // The orphan is why the directory would otherwise survive its own emptying:
    // `rmdir` only ever succeeds on an empty directory.
    await placeManaged(root, 'gone', SKILL_BODY);
    await writeFile(path.join(root, 'gone', orphanName()), 'half-written\n', 'utf-8');

    const report = await writeSkills([], root);

    expect(report.ok).toBe(true);
    expect(actionsByKey(report).gone.action).toBe('removed');
    expect(await exists(path.join(root, 'gone'))).toBe(false);
  });

  it('leaves anything that is not one of its own temp names', async () => {
    await placeManaged(root, 'a', SKILL_BODY);
    const keepers = [
      'notes.md', // an ordinary customer file
      `.${SKILL_MD}.tmp`, // no random component
      `.${SKILL_MD}.a1b2c3d4e5f60718.tmp.bak`, // suffixed — the trailing anchor matters
      `.${SKILL_MD}.NOTHEXNOTHEX0000.tmp`, // not lowercase hex
      `.${SKILL_MD}.a1b2c3d4e5f607.tmp`, // fourteen hex digits, not sixteen
      `.other.a1b2c3d4e5f60718.tmp`, // a temp for some other target
    ];
    for (const name of keepers) await writeFile(path.join(root, 'a', name), 'keep\n', 'utf-8');

    const report = await writeSkills([skill('a')], root);

    expect(report.ok).toBe(true);
    expect(await entryNames(path.join(root, 'a'))).toEqual([...keepers, SKILL_MD].sort());
  });

  it('never sweeps outside a skill directory', async () => {
    // The sweep only ever opens `<root>/<key>/` for a key that passes
    // `keyRejectionReason`, so a temp-shaped name in the managed root itself —
    // where the manifest's own temp files live — is not its business.
    const atRoot = path.join(root, orphanName());
    await writeFile(atRoot, 'not swept\n', 'utf-8');
    await placeManaged(root, 'a', SKILL_BODY);

    const report = await writeSkills([skill('a')], root);

    expect(report.ok).toBe(true);
    expect(await readFile(atRoot, 'utf-8')).toBe('not swept\n');
  });

  it('does not unlink through a symlink named like a temp file', async () => {
    // Only a regular file is removed. Unlinking the link itself would in fact be
    // safe — `unlink` never follows a trailing symlink — but "only a regular
    // file" is the rule that stays correct if the primitive ever changes.
    const victim = path.join(scratch, 'victim.txt');
    await writeFile(victim, 'victim\n', 'utf-8');
    await placeManaged(root, 'a', SKILL_BODY);
    const link = path.join(root, 'a', orphanName());
    await symlink(victim, link);

    const report = await writeSkills([skill('a')], root);

    expect(report.ok).toBe(true);
    expect(await exists(link)).toBe(true);
    expect(await readFile(victim, 'utf-8')).toBe('victim\n');
  });

  it('a corrupt manifest suppresses the sweep along with every other destructive action', async () => {
    const target = path.join(root, 'a', SKILL_MD);
    await mkdir(path.dirname(target));
    await writeFile(target, SKILL_BODY, 'utf-8');
    const orphan = path.join(root, 'a', orphanName());
    await writeFile(orphan, 'half-written\n', 'utf-8');
    await writeManifest(root, { manifestVersion: 2, entries: {} });

    const report = await writeSkills([skill('a')], root);

    expect(report.ok).toBe(false);
    expect(await exists(orphan)).toBe(true);
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

// ─── A well-formed manifest naming a path the SDK could not have written ─────

/**
 * The three literal cases the security review names for the prune path.
 *
 * The distinction from the corrupt-manifest block above is the whole point: a
 * corrupt manifest suppresses every destructive action wholesale, so those tests
 * say nothing about these. Each manifest here is *well-formed* — parseable, a
 * `manifestVersion` this release understands, a real `entries` map, and an entry
 * whose `key` is a perfectly valid skill key genuinely absent from the requested
 * set. The implementation has every input it needs to prune, and must refuse
 * anyway, because the recorded *path* is not one this SDK could have written.
 *
 * The manifest is untrusted input: a plain file on the customer's disk that
 * anything with write access to the managed root can edit, and `prune` is the
 * one code path in the SDK that deletes. So a recorded path never authorizes its
 * own removal — it must match `<key>/SKILL.md` for a re-validated key, and the
 * target is recomputed from the *current* managed root rather than read back out
 * of the entry.
 */
const HOSTILE_RECORDED_PATHS: string[] = [
  // Absolute: the classic. A recorded path read back and unlinked as-is is a
  // delete of an attacker-chosen file with the reconcile's own privileges.
  '/etc/passwd',
  // Traversing: the same attack against an implementation that rejects a
  // leading slash and then joins the rest onto the managed root.
  '../../../etc/passwd',
];

/**
 * Records every prune unlink without performing it.
 *
 * Asserting only that `/etc/passwd` still exists proves nothing: the test
 * process cannot delete it anyway, so that assertion passes against an
 * implementation with no path check at all — permissions would be doing the
 * work. What has teeth is that the removal is never *attempted*: the refusal
 * happens above the syscall, on a path the SDK recomputes rather than trusts.
 * `fsOps.unlink` is the single call site the prune deletes through.
 */
function recordUnlinks(): string[] {
  const targets: string[] = [];
  vi.spyOn(fsOps, 'unlink').mockImplementation(async (target: string) => {
    targets.push(target);
  });
  return targets;
}

describe('writeSkills hostile manifest prune', () => {
  it.each(HOSTILE_RECORDED_PATHS)('refuses a recorded path outside the root: %s', async (recorded) => {
    const unlinked = recordUnlinks();
    await writeManifest(root, {
      manifestVersion: 1,
      entries: { [recorded]: manifestEntry('a', 1, SKILL_BODY) },
    });

    const report = await writeSkills([], root);

    expect(report.ok).toBe(false);
    const action = actionsByKey(report).a;
    expect(action.action).toBe('error');
    // The refusal is about ownership of the path, not about the file's state.
    expect(action.error).toContain('could own');
    expect(report.actions.filter((a) => a.action === 'removed')).toEqual([]);
    // Nothing was even attempted, let alone completed.
    expect(unlinked).toEqual([]);
    expect(await exists('/etc/passwd')).toBe(true);
    // Left in place rather than tidied away: dropping the entry would let a
    // single hostile edit erase the SDK's own record of what it manages.
    expect(await readManifest(root)).toHaveProperty(['entries', recorded]);
  });

  it('refuses an entry under a parent that has since become a symlink', async () => {
    // The recorded path is the SDK's own, and is still not enough. The entry is
    // exactly what a legitimate reconcile writes — `a/SKILL.md` under key `a` —
    // so the shape check that catches the two cases above passes here. What
    // changed is the disk underneath it. This is the case a validate-then-act
    // implementation fails: the manifest and the entry are both entirely
    // legitimate, and only the current state of the parent is not.
    const elsewhere = path.join(scratch, 'elsewhere');
    await mkdir(elsewhere);
    const victim = path.join(elsewhere, SKILL_MD);
    await writeFile(victim, 'victim content\n', 'utf-8');

    // Managed legitimately first, so the manifest entry is one this SDK really
    // did write...
    const managed = await placeManaged(root, 'a', SKILL_BODY);
    // ...then the parent directory is swapped for a link out of the root.
    await rm(managed);
    await rm(path.join(root, 'a'), { recursive: true });
    await symlink(elsewhere, path.join(root, 'a'), 'dir');

    const unlinked = recordUnlinks();
    const report = await writeSkills([], root);

    expect(report.ok).toBe(false);
    const action = actionsByKey(report).a;
    expect(action.action).toBe('error');
    expect(action.error).toContain('symlink');
    expect(report.actions.filter((a) => a.action === 'removed')).toEqual([]);
    expect(unlinked).toEqual([]);
    // The file the symlink pointed at is untouched, and so is the link.
    expect(await readFile(victim, 'utf-8')).toBe('victim content\n');
    expect((await lstat(path.join(root, 'a'))).isSymbolicLink()).toBe(true);
    expect(await readManifest(root)).toHaveProperty(['entries', `a/${SKILL_MD}`]);
  });
});

// ─── Telemetry seam (write half) ───────────────────────────────────────

describe('writeSkills telemetry', () => {
  it('records one Materialized signal per written, updated, and skipped_current', async () => {
    const emitter = new RecordingEmitter();
    _setEmitterForTesting(emitter);
    for (const [key, content] of [
      ['same', SKILL_BODY],
      ['stale', 'old\n'],
    ] as const) {
      await mkdir(path.join(root, key));
      await writeFile(path.join(root, key, SKILL_MD), content, 'utf-8');
    }
    await writeManifest(root, {
      manifestVersion: 1,
      entries: {
        [`same/${SKILL_MD}`]: manifestEntry('same', 1, SKILL_BODY),
        [`stale/${SKILL_MD}`]: manifestEntry('stale', 1, 'old\n'),
      },
    });

    await writeSkills([skill('same'), skill('stale', 2, 'fresh\n'), skill('brand-new')], root);

    const materialized = emitter.signals(MATERIALIZED_SIGNAL);
    expect(materialized).toHaveLength(3);
    expect(materialized.map((p) => p.reconcile_action).sort()).toEqual(['skipped_current', 'updated', 'written']);
  });

  it('records the Materialized signal with the exact property keys', async () => {
    const emitter = new RecordingEmitter();
    _setEmitterForTesting(emitter);

    await writeSkills([skill('a', 2)], root);

    const [props] = emitter.signals(MATERIALIZED_SIGNAL);
    expect(Object.keys(props).sort()).toEqual([
      'content_bytes',
      'content_hash',
      'language',
      'reconcile_action',
      'skill_key',
    ]);
    expect(props.skill_key).toBe('a');
    expect(props.content_bytes).toBe(Buffer.byteLength(SKILL_BODY, 'utf-8'));
    expect(props.content_hash).toBe(hash(SKILL_BODY));
    expect(props.reconcile_action).toBe('written');
    expect(props.language).toBe('typescript');
  });

  it('puts no filesystem path in telemetry', async () => {
    const emitter = new RecordingEmitter();
    _setEmitterForTesting(emitter);

    await writeSkills([skill('a')], root);

    for (const [, props] of emitter.records) {
      expect(props).not.toHaveProperty('target_path');
      for (const value of Object.values(props)) {
        expect(String(value)).not.toContain(root);
        expect(String(value)).not.toContain(SKILL_MD);
      }
    }
  });

  it('puts no skill body in telemetry', async () => {
    const emitter = new RecordingEmitter();
    _setEmitterForTesting(emitter);

    await writeSkills([skill('a')], root);

    for (const [, props] of emitter.records) {
      for (const value of Object.values(props)) {
        expect(String(value)).not.toContain('Do the thing.');
      }
    }
  });

  it('records the Revoked signal on a prune', async () => {
    const emitter = new RecordingEmitter();
    _setEmitterForTesting(emitter);
    await placeManaged(root, 'gone', SKILL_BODY, 3);

    await writeSkills([], root);

    const [props] = emitter.signals(REVOKED_SIGNAL);
    expect(props.skill_key).toBe('gone');
    expect(props.version).toBe(3);
    expect(props.removed_from_disk).toBe(true);
    expect(props.language).toBe('typescript');
  });

  it('records no Revoked signal when pruning is disabled', async () => {
    const emitter = new RecordingEmitter();
    _setEmitterForTesting(emitter);
    await placeManaged(root, 'gone', SKILL_BODY);

    await writeSkills([], root, { prune: false });

    expect(emitter.signals(REVOKED_SIGNAL)).toEqual([]);
  });

  it('records no signal outside the approved set across all four actions', async () => {
    const emitter = new RecordingEmitter();
    _setEmitterForTesting(emitter);
    for (const [key, content] of [
      ['same', SKILL_BODY],
      ['stale', 'old\n'],
      ['gone', 'g\n'],
    ] as const) {
      await mkdir(path.join(root, key));
      await writeFile(path.join(root, key, SKILL_MD), content, 'utf-8');
    }
    await writeManifest(root, {
      manifestVersion: 1,
      entries: {
        [`same/${SKILL_MD}`]: manifestEntry('same', 1, SKILL_BODY),
        [`stale/${SKILL_MD}`]: manifestEntry('stale', 1, 'old\n'),
        [`gone/${SKILL_MD}`]: manifestEntry('gone', 1, 'g\n'),
      },
    });

    const report = await writeSkills([skill('same'), skill('stale', 2, 'fresh\n'), skill('brand-new')], root);

    // Positive control: the subset assertion is vacuous unless the run really
    // did produce all four actions and record for them.
    expect(new Set(report.actions.map((a) => a.action))).toEqual(
      new Set(['skipped_current', 'updated', 'written', 'removed']),
    );
    const recorded = emitter.names();
    expect([...recorded].filter((name) => !APPROVED_SIGNALS.has(name))).toEqual([]);
    for (const removed of REMOVED_SIGNALS) expect(recorded.has(removed)).toBe(false);
    expect(recorded).toEqual(new Set([MATERIALIZED_SIGNAL, REVOKED_SIGNAL]));
  });

  it('a throwing emitter never breaks the reconcile', async () => {
    _setEmitterForTesting({
      record() {
        throw new Error('emitter exploded');
      },
    });

    const report = await writeSkills([skill('a')], root);

    expect(report.ok).toBe(true);
    expect(await readFile(path.join(root, 'a', SKILL_MD), 'utf-8')).toBe(SKILL_BODY);
  });

  it('records the same integrity property keys whichever layer caught the failure', async () => {
    // Verification runs twice by design: once at the accessor boundary and again
    // immediately before a write. `expected_hash` is an optional property,
    // so an implementation that populates it on one path and omits it on the
    // other passes every other assertion in this block while making the signal's
    // shape depend on which internal code path noticed. Oversize content is the
    // case reachable from both layers with the expected hash in hand throughout.
    const emitter = new RecordingEmitter();
    _setEmitterForTesting(emitter);
    const oversize = 'x'.repeat(64 * 1024 + 1);
    const contentHash = hash(oversize);

    // Layer 1 — the accessor boundary.
    const store = new InMemorySkillStore();
    store.put({ key: 'big', version: 1, content: oversize, contentHash });
    _setStore(store);
    const { getSkill } = await import('../skills.js');
    expect(await getSkill('big')).toBeNull();

    // Layer 2 — verify-then-write, on a directly constructed Skill.
    const report = await writeSkills(
      [createSkill({ key: 'big', version: 1, content: new TextEncoder().encode(oversize), contentHash })],
      root,
    );
    expect(report.ok).toBe(false);

    const failures = emitter.signals(INTEGRITY_SIGNAL);
    expect(failures).toHaveLength(2);
    const [accessorKeys, writeKeys] = failures.map((props) => Object.keys(props).sort());
    expect(accessorKeys).toEqual(writeKeys);
    expect(accessorKeys).toContain('expected_hash');
  });
});

// ─── Cleanup guard ───────────────────────────────────────────────────────────

describe('test hygiene', () => {
  it('restores the intercepted filesystem operations between tests', async () => {
    // `vi.restoreAllMocks` in afterEach must put the real functions back, or a
    // later test would silently run against a spy from an earlier one.
    await chmod(root, 0o755);
    expect(vi.isMockFunction(fsOps.rename)).toBe(false);
    expect(vi.isMockFunction(fsOps.unlink)).toBe(false);
  });
});
