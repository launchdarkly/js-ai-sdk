import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LD_AI_PACKAGE_NAME, LD_AI_PACKAGE_VERSION } from '../version.js';

describe('version', () => {
  it('matches package.json', () => {
    const pkg = JSON.parse(
      readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../package.json'), 'utf8'),
    ) as { name: string; version: string };
    expect(LD_AI_PACKAGE_NAME).toBe(pkg.name);
    expect(LD_AI_PACKAGE_VERSION).toBe(pkg.version);
  });
});
