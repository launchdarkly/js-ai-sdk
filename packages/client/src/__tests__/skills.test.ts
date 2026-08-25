/**
 * Agent Skills — the value types and `Skill.frontmatter()`.
 *
 * No network, no real LaunchDarkly client, no real skill transport.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import type { Skill } from '../types.js';
import { createReconcileAction, createReconcileReport, createSkill, createSkillReference } from '../types.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const SKILL_BODY = '---\nname: Test Skill\n---\nDo the thing.\n';

function hash(content: string): string {
  return createHash('sha256').update(Buffer.from(content, 'utf-8')).digest('hex');
}

function skill(content: string = SKILL_BODY, key = 'test-skill', version = 1): Skill {
  return createSkill({ key, version, content, contentHash: hash(content) });
}

// ─── Skill types ───────────────────────────────────────────────────────

describe('skill value types', () => {
  it('SkillReference is immutable', () => {
    const ref = createSkillReference({ key: 'a', version: 1 });
    expect(() => {
      (ref as { key: string }).key = 'b';
    }).toThrow(TypeError);
    expect(ref.key).toBe('a');
  });

  it('Skill is immutable', () => {
    const s = skill();
    expect(() => {
      (s as { content: string }).content = 'tampered';
    }).toThrow(TypeError);
    expect(s.content).toBe(SKILL_BODY);
  });

  it('Skill carries optional metadata', () => {
    const s = createSkill({
      key: 'a',
      version: 2,
      content: SKILL_BODY,
      contentHash: hash(SKILL_BODY),
      name: 'PDF Extraction',
      description: 'Extracts text.',
    });
    expect(s.name).toBe('PDF Extraction');
    expect(s.description).toBe('Extracts text.');
  });

  it('Skill metadata defaults to null', () => {
    const s = skill();
    expect(s.name).toBeNull();
    expect(s.description).toBeNull();
  });

  it('ReconcileAction is immutable and defaults its optional fields to null', () => {
    const action = createReconcileAction({ key: 'a', action: 'written' });
    expect(action.version).toBeNull();
    expect(action.path).toBeNull();
    expect(action.error).toBeNull();
    expect(() => {
      (action as { action: string }).action = 'error';
    }).toThrow(TypeError);
  });
});

describe('ReconcileReport ok and errors', () => {
  const nonError = (key: string, action: 'written' | 'updated' | 'skipped_current' | 'removed') =>
    createReconcileAction({ key, action });
  const errored = (key: string) => createReconcileAction({ key, action: 'error', error: `${key} failed` });

  it('ok is true when no action is an error', () => {
    const report = createReconcileReport([
      nonError('a', 'written'),
      nonError('b', 'updated'),
      nonError('c', 'skipped_current'),
      nonError('d', 'removed'),
    ]);
    expect(report.ok).toBe(true);
  });

  it('ok is false when at least one action is an error', () => {
    const report = createReconcileReport([nonError('a', 'written'), errored('b')]);
    expect(report.ok).toBe(false);
  });

  it('an empty report is ok', () => {
    expect(createReconcileReport([]).ok).toBe(true);
  });

  it('errors lists the error actions in actions order', () => {
    const first = errored('first');
    const second = errored('second');
    const report = createReconcileReport([
      nonError('a', 'written'),
      first,
      nonError('b', 'updated'),
      second,
      nonError('c', 'removed'),
    ]);
    expect(report.errors).toEqual([first, second]);
  });

  it('errors is empty when no action is an error', () => {
    const report = createReconcileReport([nonError('a', 'written')]);
    expect(report.errors).toEqual([]);
  });

  it('ok and errors always agree', () => {
    for (const actions of [
      [],
      [nonError('a', 'written')],
      [errored('a')],
      [nonError('a', 'written'), errored('b'), nonError('c', 'removed')],
    ]) {
      const report = createReconcileReport(actions);
      expect(report.ok).toBe(report.errors.length === 0);
    }
  });
});

// ─── frontmatter() ─────────────────────────────────────────────────────

describe('Skill.frontmatter()', () => {
  it('parses valid frontmatter', async () => {
    const content = '---\nname: test\nversion: 1\n---\nBody text\n';
    await expect(skill(content).frontmatter()).resolves.toEqual({ name: 'test', version: 1 });
  });

  it('returns null when there is no frontmatter block', async () => {
    await expect(skill('# Just markdown\n\nNo frontmatter here.\n').frontmatter()).resolves.toBeNull();
  });

  it('returns null for an unterminated block', async () => {
    await expect(skill('---\nname: test\nnever closed\n').frontmatter()).resolves.toBeNull();
  });

  it('returns null for malformed YAML', async () => {
    await expect(skill('---\nname: [unclosed\n  bad: : :\n---\nBody\n').frontmatter()).resolves.toBeNull();
  });

  it('returns null for a non-mapping block', async () => {
    await expect(skill('---\n- one\n- two\n---\nBody\n').frontmatter()).resolves.toBeNull();
  });

  it('returns null for an oversize block', async () => {
    const big = Array.from({ length: 200 }, (_, i) => `key${i}: ${'x'.repeat(80)}`).join('\n');
    expect(big.length).toBeGreaterThan(8 * 1024);
    await expect(skill(`---\n${big}\n---\nBody\n`).frontmatter()).resolves.toBeNull();
  });

  it('returns null for a block nested deeper than 10 levels, promptly', async () => {
    const block = `${Array.from({ length: 14 }, (_, i) => `${'  '.repeat(i)}k${i}:`).join('\n')}\n${'  '.repeat(14)}v: 1\n`;
    const started = performance.now();
    await expect(skill(`---\n${block}---\nBody\n`).frontmatter()).resolves.toBeNull();
    expect(performance.now() - started).toBeLessThan(5000);
  });

  it('accepts a block at exactly the depth bound', async () => {
    // Positive control for the depth walk: 10 nested containers is allowed, so
    // the bound rejects "deeper than 10" rather than all nesting.
    const block = `${Array.from({ length: 9 }, (_, i) => `${'  '.repeat(i)}k${i}:`).join('\n')}\n${'  '.repeat(9)}v: 1\n`;
    await expect(skill(`---\n${block}---\nBody\n`).frontmatter()).resolves.not.toBeNull();
  });

  it('returns null for a block containing a single alias', async () => {
    // Alias resolution is *disabled*, not bounded, so one alias is
    // already disqualifying. This minimal case is the actual boundary the rule
    // draws; the billion-laughs bomb below is only a corollary of it.
    const content = '---\nname: test\nanchored: &a 1\naliased: *a\n---\nBody\n';
    await expect(skill(content).frontmatter()).resolves.toBeNull();
  });

  it('returns null for a merge key, which is an alias', async () => {
    await expect(skill('---\na: &a {x: 1}\nb:\n  <<: *a\n---\nBody\n').frontmatter()).resolves.toBeNull();
  });

  it('does not crash or hang on billion-laughs aliases', async () => {
    // The threat is not memory blow-up: with `maxAliasCount` left at its default
    // of 100 the `yaml` package resolves this bomb's 54 aliases and returns a
    // value in about a millisecond. Nor does any other bound catch it — it is
    // ~300 bytes and 6 levels deep, inside both the 8 KB and depth-10 limits.
    // The contract asserted is the alias rule; the elapsed-time bound below only
    // guards a parser that *does* expand.
    const bomb =
      '---\n' +
      "a: &a ['x','x','x','x','x','x','x','x','x']\n" +
      'b: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a]\n' +
      'c: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b]\n' +
      'd: &d [*c,*c,*c,*c,*c,*c,*c,*c,*c]\n' +
      'e: &e [*d,*d,*d,*d,*d,*d,*d,*d,*d]\n' +
      'f: &f [*e,*e,*e,*e,*e,*e,*e,*e,*e]\n' +
      'g: [*f,*f,*f,*f,*f,*f,*f,*f,*f]\n' +
      '---\nBody\n';
    const started = performance.now();
    await expect(skill(bomb).frontmatter()).resolves.toBeNull();
    expect(performance.now() - started).toBeLessThan(5000);
  });

  it('treats an object-construction tag as inert', async () => {
    const content = "---\nevil: !!python/object/apply:os.system ['echo pwned']\n---\nB\n";
    await expect(skill(content).frontmatter()).resolves.toBeNull();
  });

  it('treats a custom tag as inert', async () => {
    await expect(skill('---\nevil: !SomeType {a: 1}\n---\nBody\n').frontmatter()).resolves.toBeNull();
  });

  it('still resolves the standard safe tags', async () => {
    // Positive control: rejecting *unresolved* tags must not reject the core
    // schema's own tags, which both languages resolve without constructing.
    await expect(skill('---\nx: !!str 5\ny: !!int "7"\n---\nBody\n').frontmatter()).resolves.toEqual({
      x: '5',
      y: 7,
    });
  });

  it('does not crash on pathologically deep nesting', async () => {
    const deep = `a: ${'['.repeat(3000)}${']'.repeat(3000)}`;
    await expect(skill(`---\n${deep}\n---\nBody\n`).frontmatter()).resolves.toBeNull();
  });

  it('keeps yaml out of the package runtime dependencies', () => {
    // The YAML library is dev-only in both languages. A runtime
    // dependency would defeat the whole point of the lazy dynamic import.
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf-8'));
    expect(pkg.dependencies?.yaml).toBeUndefined();
    expect(pkg.peerDependencies?.yaml).toBeUndefined();
    expect(pkg.devDependencies?.yaml).toBeDefined();
  });
});
