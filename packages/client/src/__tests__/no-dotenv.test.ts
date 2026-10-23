import { describe, expect, it, vi } from 'vitest';

// The library must never load `.env` as an import side effect: which file gets loaded would
// depend on the consumer's cwd, and dotenv fills in exactly the variables the app left unset.
// If any module reachable from a package entry imports `dotenv/config`, this factory runs.
const dotenv = vi.hoisted(() => ({ loaded: false }));
vi.mock('dotenv/config', () => {
  dotenv.loaded = true;
  return {};
});

describe('package entries', () => {
  it('do not load dotenv as an import side effect', async () => {
    // Both entries (`.` and `./experimental`), so every module either one reaches is covered.
    await import('../index.js');
    await import('../experimental.js');
    expect(dotenv.loaded).toBe(false);
  });
});
