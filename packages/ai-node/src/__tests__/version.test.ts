import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LD_AI_PACKAGE_NAME, LD_AI_PACKAGE_VERSION } from '../version.js';

/**
 * `version.ts` is what this package reports to LaunchDarkly, and release-please
 * rewrites it from `release-please-config.json`. These tests fail if the two
 * ever disagree — for example after a version bump by hand.
 */
const packageJson = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json'), 'utf8'),
) as { name: string; version: string };

describe('package identity', () => {
  it('reports the name in package.json', () => {
    expect(LD_AI_PACKAGE_NAME).toBe(packageJson.name);
  });

  it('reports the version in package.json', () => {
    expect(LD_AI_PACKAGE_VERSION).toBe(packageJson.version);
  });
});
