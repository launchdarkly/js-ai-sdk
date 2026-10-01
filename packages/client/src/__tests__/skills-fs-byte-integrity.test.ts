/**
 * Which bytes `writeSkills` reads, and which bytes it writes.
 *
 * Two guarantees that the materialization suite cannot observe, because both are
 * about what happens *inside* a single reconcile rather than about its report:
 *
 * - the adoption comparison read is **bounded** at the resolved content's length
 *   plus one byte (§3.22), and
 * - the bytes that were hashed are the bytes that get **written** (§3.21) — the
 *   content is snapshotted before hashing, so a caller mutating `skill.content`
 *   during the awaits in between cannot substitute bytes nothing verified.
 *
 * Both need `vi.mock('node:fs/promises')`, which is file-wide, so they live here
 * rather than in `skills-fs.test.ts`: the first has to count the bytes a read
 * actually consumed, and the second has to fire a mutation from inside the window
 * between the hash and the write. This is the same reason
 * `skills-fs-root-swap.test.ts` is a file of its own.
 *
 * Nothing here is platform-gated: both properties hold on every platform, and
 * both tests run everywhere.
 */

import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ─── The read-counting / mutation hook ───────────────────────────────────────
//
// `open` is wrapped so the FileHandle it returns reports how much was read
// through it, and `mkdir` is wrapped so a test can act at a chosen point in the
// write path. Everything else `node:fs/promises` exports is the real thing.
//
// `reads` is keyed on the *basename*, because on Linux the implementation opens
// its targets through `/proc/self/fd/<fd>/<name>` rather than through a path
// anyone would recognize (see `SUPPORTS_PROC_FD`), so a key built from the full
// path would simply never match there and the assertions would pass vacuously.

const hook = vi.hoisted(() => ({
  /** Bytes consumed per opened basename, however the read was issued. */
  reads: new Map<string, number>(),
  /** Which basenames were read with an unbounded whole-file `readFile`. */
  wholeFileReads: new Set<string>(),
  /** Fires on `mkdir` of this basename, or `null` when disarmed. */
  onMkdir: null as string | null,
  fire: null as (() => void) | null,
  fired: false,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();

  const count = (name: string, bytes: number): void => {
    hook.reads.set(name, (hook.reads.get(name) ?? 0) + bytes);
  };

  return {
    ...actual,
    async mkdir(...args: unknown[]) {
      if (hook.onMkdir !== null && typeof args[0] === 'string' && path.basename(args[0]) === hook.onMkdir) {
        hook.fired = true;
        hook.fire?.();
      }
      return (actual.mkdir as (...a: unknown[]) => Promise<unknown>)(...args);
    },
    async open(...args: unknown[]) {
      const handle = await (actual.open as (...a: unknown[]) => Promise<import('node:fs/promises').FileHandle>)(
        ...args,
      );
      if (typeof args[0] !== 'string') return handle;
      const name = path.basename(args[0]);
      // A Proxy rather than a rebuilt object: a FileHandle carries internals the
      // implementation uses (`fd`, `stat`, `close`), and only the two read paths
      // need observing.
      return new Proxy(handle, {
        get(target, property, receiver) {
          if (property === 'readFile') {
            return async (...a: unknown[]) => {
              const data = await (target.readFile as (...x: unknown[]) => Promise<Buffer | string>)(...a);
              hook.wholeFileReads.add(name);
              count(name, typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength);
              return data;
            };
          }
          if (property === 'read') {
            return async (...a: unknown[]) => {
              const result = await (target.read as (...x: unknown[]) => Promise<{ bytesRead: number }>)(...a);
              count(name, result.bytesRead);
              return result;
            };
          }
          const value = Reflect.get(target, property, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
  };
});

const { mkdir, mkdtemp, readFile, realpath, rm, writeFile } = await import('node:fs/promises');
const { _clearState } = await import('../skills.js');
const { writeSkills } = await import('../skills-fs.js');
const { createSkill } = await import('../types.js');
const { fsOps } = await import('../safe-fs.js');

const SKILL_MD = 'SKILL.md';
const SKILL_BODY = '---\nname: Test Skill\n---\nDo the thing.\n';
const NEVER_FIRED = 'the hook never fired; the test proves nothing';

function hash(bytes: Uint8Array | string): string {
  return createHash('sha256')
    .update(typeof bytes === 'string' ? Buffer.from(bytes, 'utf-8') : bytes)
    .digest('hex');
}

function disarm(): void {
  hook.reads.clear();
  hook.wholeFileReads.clear();
  Object.assign(hook, { onMkdir: null, fire: null, fired: false });
}

let scratch: string;
let root: string;

beforeEach(async () => {
  _clearState();
  disarm();
  scratch = await realpath(await mkdtemp(path.join(tmpdir(), 'ld-ai-skills-bytes-')));
  root = path.join(scratch, 'skills');
  await mkdir(root);
});

afterEach(async () => {
  vi.restoreAllMocks();
  disarm();
  _clearState();
  await rm(scratch, { recursive: true, force: true });
});

// ─── The bounded comparison read ─────────────────────────────────────────────

/**
 * Adoption (§3.22) reads the file at `<root>/<key>/SKILL.md` and compares its
 * hash against the resolved content's. That read deliberately reaches files the
 * manifest does **not** vouch for — that is the whole crash-recovery self-heal —
 * so the file it opens may be one an attacker with write access to the root
 * planted, at whatever size they chose. Unbounded, it pulls that file into memory
 * before the comparison ever runs.
 *
 * The bound is `len(content) + 1`, and the `+ 1` is load-bearing rather than
 * slack: a file that is the content *plus* trailing bytes would, under a bound of
 * exactly `len(content)`, read back as exactly the content, hash equal, and be
 * adopted despite not being current. The extra byte is what proves inequality.
 */
describe('the adoption comparison read is bounded', () => {
  /** The post-crash state adoption exists for: a managed path, no manifest. */
  async function placeOrphaned(key: string, content: string | Uint8Array): Promise<string> {
    const target = path.join(root, key, SKILL_MD);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
    return target;
  }

  function skill(key: string, content = SKILL_BODY) {
    return createSkill({ key, version: 1, content: new TextEncoder().encode(content), contentHash: hash(content) });
  }

  it('reads at most one byte past the resolved content and refuses an over-large file', async () => {
    // A megabyte where the resolved content is a few dozen bytes. The size is
    // beside the point — what is asserted is that the read stopped at the bound,
    // which is the property that holds for a multi-gigabyte file too.
    const planted = Buffer.alloc(1024 * 1024, 0x41);
    const target = await placeOrphaned('a', planted);
    const encoded = new TextEncoder().encode(SKILL_BODY);

    const report = await writeSkills([skill('a')], root);

    // Refused — the bytes are not the resolved content, and no manifest entry
    // vouches for the path.
    expect(report.ok).toBe(false);
    const action = report.actions.find((a) => a.key === 'a');
    expect(action?.action).toBe('error');
    expect(action?.error).toContain('does not record it as managed');
    // Refused *after* a successful comparison, not because the read blew up:
    // "we could not look" and "we looked and the bytes are foreign" are
    // deliberately different refusals, and only the second proves the bound was
    // what stopped the read.
    expect(action?.error).not.toContain('could not be read');

    // The bound itself. `+ 1` and no more, and never the whole file.
    expect(hook.reads.get(SKILL_MD)).toBe(encoded.byteLength + 1);
    expect(hook.wholeFileReads.has(SKILL_MD)).toBe(false);
    // And the planted file is untouched.
    expect((await readFile(target)).byteLength).toBe(planted.byteLength);
  });

  it('refuses a file that is the resolved content plus trailing bytes', async () => {
    // The case a bound of exactly `len(content)` would adopt: the first
    // `len(content)` bytes *are* the resolved content, so a read truncated there
    // hashes equal. Only the extra byte distinguishes them.
    const trailing = `${SKILL_BODY}extra`;
    const target = await placeOrphaned('a', trailing);
    const renames: string[] = [];
    const realRename = fsOps.rename.bind(fsOps);
    vi.spyOn(fsOps, 'rename').mockImplementation(async (src: string, dst: string) => {
      if (dst.endsWith(SKILL_MD)) renames.push(dst);
      return realRename(src, dst);
    });

    const report = await writeSkills([skill('a')], root);

    expect(report.ok).toBe(false);
    const action = report.actions.find((a) => a.key === 'a');
    expect(action?.action).toBe('error');
    expect(action?.error).toContain('does not record it as managed');
    // Not adopted: nothing was claimed into the manifest, and the file is as it
    // was found.
    expect(await readFile(target, 'utf-8')).toBe(trailing);
    expect(renames).toEqual([]);
    expect(JSON.parse(await readFile(path.join(root, '.launchdarkly-skills.json'), 'utf-8')).entries).toEqual({});
  });

  it('still adopts an exact match, so the bound did not break the self-heal', async () => {
    // The positive control for the two above: a bound that refused everything
    // would satisfy both of them. Exactly `len(content)` bytes of the resolved
    // content is the one file adoption is *for*.
    await placeOrphaned('a', SKILL_BODY);
    const encoded = new TextEncoder().encode(SKILL_BODY);

    const report = await writeSkills([skill('a')], root);

    expect(report.ok).toBe(true);
    expect(report.actions.find((a) => a.key === 'a')?.action).toBe('skipped_current');
    // The read stops at EOF rather than at the bound, so it is one byte short of
    // what the over-large case consumed — which is what "anything longer cannot
    // match" means in practice.
    expect(hook.reads.get(SKILL_MD)).toBe(encoded.byteLength);
  });

  it('reads the manifest unbounded, because its length is not predictable', async () => {
    // The counterpart: `maxBytes` is opt-in, and the manifest does not opt in.
    // It is parsed rather than compared, no caller can predict its length, and it
    // is the one file under the root this SDK writes itself.
    await writeSkills([skill('a')], root);
    disarm();

    await writeSkills([skill('a')], root);

    expect(hook.wholeFileReads.has('.launchdarkly-skills.json')).toBe(true);
  });
});

// ─── The bytes that were hashed are the bytes that get written ───────────────

/**
 * `createSkill` freezes the wrapper, but a TypedArray's elements cannot be frozen
 * — `Object.freeze` throws on an array-buffer view — so a `Skill` shares its
 * buffer with whoever constructed it, and `types.ts` says so in terms.
 *
 * On the write path the hash is computed in `verifiedBytes` and the rename
 * happens several `await`s later: the existence check and, when the target
 * exists, the comparison read sit in between. So without a snapshot, a caller
 * mutating `skill.content` inside that window writes bytes that were never
 * hashed, and verify-then-write verifies nothing.
 *
 * This is a TypeScript-shaped hazard. Python's `bytes` are immutable, so the
 * guarantee is free there and its test asserts a property rather than a guard.
 */
describe('content is snapshotted before it is hashed', () => {
  /**
   * Both buffer kinds a caller can legally hand to `createSkill`.
   *
   * `Buffer` is not a curiosity here, it is the trap: it extends `Uint8Array`, so
   * it satisfies `Skill.content` without a cast, and `Buffer.prototype.slice` is
   * the legacy spelling that returns a *view* rather than a copy. A snapshot
   * written as `content.slice()` therefore protects a plain `Uint8Array` and
   * silently fails to protect a `Buffer` — present in the diff, absent in effect.
   * A pooled `Buffer` (a `subarray` into a larger allocation, which is what
   * `Buffer.from(string)` hands out for small strings anyway) is the third shape,
   * because a copy that respected `byteLength` but not `byteOffset` would pass the
   * other two.
   */
  const bufferKinds: Array<[string, (bytes: Uint8Array) => Uint8Array]> = [
    ['Uint8Array', (bytes) => Uint8Array.from(bytes)],
    ['Buffer', (bytes) => Buffer.from(bytes)],
    [
      'pooled Buffer view',
      (bytes) => {
        const pool = Buffer.alloc(bytes.byteLength + 8, 0x7a);
        pool.set(bytes, 4);
        return pool.subarray(4, 4 + bytes.byteLength);
      },
    ],
  ];

  it.each(bufferKinds)('a %s mutated between the hash and the write does not reach the file', async (_kind, make) => {
    const original = new TextEncoder().encode(SKILL_BODY);
    // The caller's own buffer, which `createSkill` will alias.
    const mutable = make(original);
    const contentHash = hash(original);
    const skill = createSkill({ key: 'a', version: 1, content: mutable, contentHash });
    // The alias is real — otherwise this test is about nothing.
    expect(skill.content).toBe(mutable);

    // `mkdir` of `<root>/a` runs after `verifiedBytes` has hashed and before
    // `atomicWrite` writes a byte, which is exactly the window. Fired from the
    // filesystem hook rather than from implementation internals, so the test is
    // not coupled to how the snapshot is taken.
    const tampered = new TextEncoder().encode('---\nname: Tampered\n---\nDo something else.\n');
    Object.assign(hook, {
      onMkdir: 'a',
      fire: () => {
        for (let i = 0; i < mutable.byteLength; i += 1) mutable[i] = tampered[i % tampered.byteLength];
      },
      fired: false,
    });

    const report = await writeSkills([skill], root);

    if (!hook.fired) throw new Error(NEVER_FIRED);
    // The mutation landed on the caller's buffer, so the window was real.
    expect(Buffer.from(mutable)).not.toEqual(Buffer.from(original));

    expect(report.ok).toBe(true);
    const action = report.actions.find((a) => a.key === 'a');
    expect(action?.action).toBe('written');

    // The file holds the bytes that were hashed, not the bytes the buffer held
    // when the write happened.
    const onDisk = await readFile(path.join(root, 'a', SKILL_MD));
    expect(Buffer.from(onDisk)).toEqual(Buffer.from(original));
    // And the hash recorded for it is the hash *of those bytes* — the two halves
    // agree, which is the whole claim.
    const entries = JSON.parse(await readFile(path.join(root, '.launchdarkly-skills.json'), 'utf-8')).entries;
    expect(entries[`a/${SKILL_MD}`].sha256).toBe(contentHash);
    expect(hash(onDisk)).toBe(contentHash);
  });

  it('a buffer mutated before writeSkills is called fails verification instead', async () => {
    // The mirror image, and the reason the snapshot is not a licence to ignore
    // the caller: bytes that disagree with `contentHash` when `writeSkills` is
    // *entered* are a verification failure, not something to snapshot and write.
    const mutable = Uint8Array.from(new TextEncoder().encode(SKILL_BODY));
    const skill = createSkill({ key: 'a', version: 1, content: mutable, contentHash: hash(SKILL_BODY) });
    mutable[0] = 0x58;

    const report = await writeSkills([skill], root);

    expect(report.ok).toBe(false);
    const action = report.actions.find((a) => a.key === 'a');
    expect(action?.action).toBe('error');
    expect(action?.error).toContain('failed verification');
  });
});
