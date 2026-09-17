import { describe, expect, it } from 'vitest';
import { newMultiContext } from './utils';

describe('newMultiContext', () => {
  it('returns a complex, unique LaunchDarkly multi-context', () => {
    const first = newMultiContext();
    const second = newMultiContext();

    expect(first).toMatchObject({
      kind: 'multi',
      organization: { key: 'example-org:west%region' },
    });
    expect(first.user.key).toMatch(/^example-user-[0-9a-f]{8}$/);
    expect(second.user.key).not.toBe(first.user.key);
  });
});
