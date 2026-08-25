/**
 * `Skill.frontmatter()` with no YAML library installed.
 *
 * Its own file because the mock has to be hoisted above the module under test,
 * and every other frontmatter case needs the real parser.
 */

import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

// Make the dynamic `import('yaml')` reject, exactly as an
// uninstalled devDependency would.
vi.mock('yaml', () => {
  throw new Error("Cannot find module 'yaml'");
});

import { createSkill } from '../types.js';

describe('Skill.frontmatter() with yaml unavailable', () => {
  const content = '---\nname: test\n---\nBody\n';
  const skill = createSkill({
    key: 'a',
    version: 1,
    content,
    contentHash: createHash('sha256').update(Buffer.from(content, 'utf-8')).digest('hex'),
  });

  it('returns null instead of raising', async () => {
    // The module itself imported fine — which is the other half of the
    // contract: the YAML library must not be loaded at package import time, or
    // it would be a de-facto runtime dependency.
    await expect(skill.frontmatter()).resolves.toBeNull();
  });

  it('leaves the rest of the skill usable', async () => {
    expect(skill.content).toBe(content);
    expect(skill.key).toBe('a');
  });
});
