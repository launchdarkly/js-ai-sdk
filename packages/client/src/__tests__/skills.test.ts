/**
 * Agent Skills — the value types.
 *
 * No network, no real LaunchDarkly client, no real skill transport.
 */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import type { Skill } from '../types.js';
import { createReconcileAction, createReconcileReport, createSkill, createSkillReference } from '../types.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const SKILL_BODY = new TextEncoder().encode('---\nname: Test Skill\n---\nDo the thing.\n');

function hash(content: Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

function skill(content: Uint8Array = SKILL_BODY, key = 'test-skill', version = 1): Skill {
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
      (s as { content: Uint8Array }).content = new TextEncoder().encode('tampered');
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
