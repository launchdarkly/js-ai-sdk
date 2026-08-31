import { describe, expect, it } from 'vitest';
import { contextIdentity, getCanonicalKey, getContextKeys } from '../context.js';
import type { LDContext } from '../types.js';

// Fixtures 1-6 are ported from the observability browser SDK's
// integrations/launchdarkly/getContextKeys.test.ts. Both SDKs must derive the
// same keys from the same context, so the fixtures travel together.
describe('getContextKeys', () => {
  it.each<[string, LDContext, Record<string, string>]>([
    ['legacy user with no kind', { key: 'bob' }, { user: 'bob' }],
    ['single kind user', { kind: 'user', key: 'bob' }, { user: 'bob' }],
    ['single kind org', { kind: 'org', key: 'org123' }, { org: 'org123' }],
    ['single kind device', { kind: 'device', key: 'device456' }, { device: 'device456' }],
    [
      'multi kind',
      {
        kind: 'multi',
        user: { kind: 'user', key: 'user-key', name: 'Test User' },
        org: { kind: 'org', key: 'org-key' },
      },
      { org: 'org-key', user: 'user-key' },
    ],
    [
      'multi kind declared out of order',
      { kind: 'multi', device: { kind: 'device', key: 'device-key' }, user: { kind: 'user', key: 'user-key' } },
      { device: 'device-key', user: 'user-key' },
    ],
  ])('derives per-kind keys for a %s', (_name, context, expected) => {
    expect(getContextKeys(context)).toEqual(expected);
  });

  it('does not escape keys in the per-kind map', () => {
    // Only the canonical key is escaped; the map holds raw keys, matching the
    // browser SDK. A consumer filtering on `context.contextKeys.org` compares
    // against the key the customer actually sent.
    expect(getContextKeys({ kind: 'org', key: 'a:b%c' })).toEqual({ org: 'a:b%c' });
  });

  it('skips a multi-kind entry with no usable key', () => {
    const context = { kind: 'multi', user: { kind: 'user', key: 'bob' }, org: {} } as unknown as LDContext;
    expect(getContextKeys(context)).toEqual({ user: 'bob' });
  });

  it('returns an empty map for a context with no key', () => {
    expect(getContextKeys({} as unknown as LDContext)).toEqual({});
  });
});

describe('getCanonicalKey', () => {
  it.each<[string, LDContext, string]>([
    ['legacy user with no kind', { key: 'bob' }, 'bob'],
    ['single kind user', { kind: 'user', key: 'bob' }, 'bob'],
    ['single kind org', { kind: 'org', key: 'org123' }, 'org:org123'],
    [
      'multi kind, sorted by kind',
      { kind: 'multi', user: { kind: 'user', key: 'user-key' }, org: { kind: 'org', key: 'org-key' } },
      'org:org-key:user:user-key',
    ],
    [
      'multi kind declared out of order, still sorted',
      { kind: 'multi', device: { kind: 'device', key: 'device-key' }, user: { kind: 'user', key: 'user-key' } },
      'device:device-key:user:user-key',
    ],
  ])('canonicalises a %s', (_name, context, expected) => {
    expect(getCanonicalKey(context)).toBe(expected);
  });

  it('escapes percent before colon', () => {
    // `%` first, then `:`, so an escape sequence is never double-escaped.
    expect(getCanonicalKey({ kind: 'org', key: 'a:b%c' })).toBe('org:a%3Ab%25c');
  });

  it('returns an empty string for a context with no key', () => {
    expect(getCanonicalKey({} as unknown as LDContext)).toBe('');
  });
});

describe('contextIdentity', () => {
  it('returns the canonical key and the per-kind keys together', () => {
    expect(
      contextIdentity({ kind: 'multi', user: { kind: 'user', key: 'u1' }, org: { kind: 'org', key: 'o1' } }),
    ).toEqual({
      canonicalKey: 'org:o1:user:u1',
      contextKeys: { org: 'o1', user: 'u1' },
    });
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a string', 'user-key'],
    ['an empty object', {}],
    ['a context whose key is not a string', { kind: 'user', key: 42 }],
    ['a multi-kind context with no usable sub-context', { kind: 'multi', user: {} }],
  ])('returns undefined for %s', (_name, input) => {
    expect(contextIdentity(input)).toBeUndefined();
  });
});
