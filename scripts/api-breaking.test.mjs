/**
 * Tests of the breaking-change check, against fixture reports in a throwaway
 * git repository rather than the real ones. Run with
 * `node --test scripts/api-breaking.test.mjs`.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';
import { allowsBreaking, checkPr, checkRelease, declarations } from './api-breaking.mjs';

// Isolate git from the developer's config (hooks, signing, default branch).
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';
Object.assign(process.env, {
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
});

const report = (body) => `## API Report File for "x"

\`\`\`ts

import { Other } from 'elsewhere';

${body}

// (No @packageDocumentation comment for this package)

\`\`\`
`;

const BASE = report(`// @public (undocumented)
export function createHandler(input?: Options): Handler;

// @public
export type Mode = 'a' | 'b';

// @public
export interface Options {
    // (undocumented)
    capture?: boolean;
}`);

const STABLE = 'packages/a/etc/ai-a.api.md';
const EXPERIMENTAL = 'packages/a/etc/ai-a-experimental.api.md';

let root;
let lines;
const log = { log: (text) => lines.push(text), error: (text) => lines.push(text) };
const output = () => lines.join('\n');

function git(...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function write(files) {
  for (const [path, text] of Object.entries(files)) {
    if (text === null) {
      rmSync(join(root, path));
      continue;
    }
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

function commit(files) {
  write(files);
  git('add', '-A');
  git('commit', '-q', '-m', 'change', '--allow-empty');
  return git('rev-parse', 'HEAD');
}

const releaseFiles = (version) => ({
  'release-please-config.json': JSON.stringify({ packages: { 'packages/a': { component: '@scope/ai-a' } } }),
  '.release-please-manifest.json': JSON.stringify({ 'packages/a': version }),
});

/** Commit the base, then put `head` in the working tree; return the check's exit code. */
function pr(head, { title = 'feat: change', labels = [] } = {}) {
  const base = commit({ [STABLE]: BASE, [EXPERIMENTAL]: BASE });
  write(head);
  return checkPr({ root, base, title, labels, log });
}

/** Start again in a new, empty repository. */
function fresh() {
  if (root) rmSync(root, { recursive: true, force: true });
  root = mkdtempSync(join(tmpdir(), 'api-breaking-'));
  git('init', '-q');
  lines = [];
}

beforeEach(fresh);
after(() => rmSync(root, { recursive: true, force: true }));

describe('declarations', () => {
  it('keys each declaration by name, without comments', () => {
    const found = declarations(BASE);
    assert.deepEqual([...found.keys()], ['createHandler', 'Mode', 'Options']);
    assert.equal(found.get('Options'), 'export interface Options {\n    capture?: boolean;\n}');
  });
});

describe('pr', () => {
  it('passes with no change', () => {
    assert.equal(pr({}), 0);
    assert.match(output(), /No breaking changes/);
  });

  it('fails on a removed declaration', () => {
    assert.equal(pr({ [STABLE]: BASE.replace(/\/\/ @public\nexport type Mode.*\n/, '') }), 1);
    assert.match(output(), /ai-a\.api\.md: Mode was removed/);
  });

  it('fails on a changed signature', () => {
    assert.equal(pr({ [STABLE]: BASE.replace('input?: Options', 'input: Options') }), 1);
    assert.match(output(), /createHandler changed\n {2}was: .*input\?: Options.*\n {2}now: .*input: Options/);
  });

  it('fails on a changed type-only export', () => {
    assert.equal(pr({ [STABLE]: BASE.replace("'a' | 'b'", "'a'") }), 1);
    assert.match(output(), /Mode changed/);
  });

  it('flags a new optional member, which passes only with the label', () => {
    const head = { [STABLE]: BASE.replace('capture?: boolean;', 'capture?: boolean;\n    extra?: string;') };
    assert.equal(pr(head), 1);
    assert.match(output(), /Options changed/);
    lines = [];
    write({ [STABLE]: BASE });
    assert.equal(pr(head, { labels: ['api-compatible'] }), 0);
  });

  it('passes an added declaration', () => {
    assert.equal(
      pr({
        [STABLE]: BASE.replace(
          '// @public\nexport type Mode',
          '// @public\nexport const added: number;\n\n// @public\nexport type Mode',
        ),
      }),
      0,
    );
  });

  it('passes a changed doc comment or deprecation', () => {
    assert.equal(pr({ [STABLE]: BASE.replace('    // (undocumented)\n', '    // @deprecated\n') }), 0);
  });

  it('ignores an experimental report', () => {
    assert.equal(pr({ [EXPERIMENTAL]: report('') }), 0);
    assert.equal(pr({ [EXPERIMENTAL]: null }), 0);
  });

  it('fails on a removed report (entry point or package)', () => {
    assert.equal(pr({ [STABLE]: null }), 1);
    assert.match(output(), /ai-a\.api\.md: the report was removed/);
  });

  it('fails on a report that lost every declaration', () => {
    assert.equal(pr({ [STABLE]: report('') }), 1);
  });

  it('passes a breaking change declared with ! in the title', () => {
    const head = { [STABLE]: report('') };
    assert.equal(pr(head, { title: 'feat!: drop it' }), 0);
    assert.equal(pr(head, { title: 'fix(client)!: drop it' }), 0);
    assert.match(output(), /Declared breaking/);
    assert.equal(pr(head, { title: 'feat: drop it!' }), 1);
    assert.equal(pr(head, { title: 'feat(client): drop it' }), 1);
  });

  it('passes with the api-compatible label, and not with another', () => {
    const head = { [STABLE]: report('') };
    assert.equal(pr(head, { labels: ['api-compatible'] }), 0);
    assert.equal(pr(head, { labels: ['documentation'] }), 1);
    assert.match(output(), /apply the `api-compatible` label/);
  });
});

describe('release', () => {
  /** Tag a release of `a` at `released`, merge a change, and bump to `next`. */
  function release(released, next, head, { labels = [], tag = true } = {}) {
    commit({ ...releaseFiles(released), [STABLE]: BASE, [EXPERIMENTAL]: BASE });
    if (tag) git('tag', `@scope/ai-a-${released}`);
    const base = commit(head);
    write(releaseFiles(next));
    return checkRelease({ root, base, labels, log });
  }

  const breaking = { [STABLE]: report('') };

  it('fails on a breaking change with a patch version', () => {
    assert.equal(release('0.4.0', '0.4.1', breaking), 1);
    assert.match(output(), /0\.4\.0 -> 0\.4\.1, but the changes above since @scope\/ai-a-0\.4\.0 are breaking/);
  });

  it('passes a breaking change with a minor version before 1.0.0', () => {
    assert.equal(release('0.4.0', '0.5.0', breaking), 0);
  });

  it('fails a minor version after 1.0.0, and passes a major one', () => {
    assert.equal(release('1.2.0', '1.3.0', breaking), 1);
    fresh();
    assert.equal(release('1.2.0', '2.0.0', breaking), 0);
  });

  it('passes an additive change with a patch version', () => {
    assert.equal(
      release('0.4.0', '0.4.1', {
        [STABLE]: BASE.replace(
          '// @public\nexport type',
          '// @public\nexport const added: number;\n\n// @public\nexport type',
        ),
      }),
      0,
    );
    assert.match(output(), /matches its changes/);
  });

  it('ignores an experimental report', () => {
    assert.equal(release('0.4.0', '0.4.1', { [EXPERIMENTAL]: report('') }), 0);
  });

  it('fails on a removed report', () => {
    assert.equal(release('0.4.0', '0.4.1', { [STABLE]: null }), 1);
  });

  it('passes with the api-compatible label, and not with another', () => {
    assert.equal(release('0.4.0', '0.4.1', breaking, { labels: ['api-compatible'] }), 0);
    fresh();
    assert.equal(release('0.4.0', '0.4.1', breaking, { labels: ['other'] }), 1);
  });

  it('reports and skips a package with no release tag', () => {
    assert.equal(release('0.1.0', '0.1.1', breaking, { tag: false }), 0);
    assert.match(output(), /no release tag @scope\/ai-a-0\.1\.0/);
  });

  it('reports and skips a package with no report at its release tag', () => {
    commit({ ...releaseFiles('0.4.0'), 'packages/a/src/index.ts': '' });
    git('tag', '@scope/ai-a-0.4.0');
    const base = commit({ [STABLE]: BASE });
    write({ ...releaseFiles('0.4.1'), [STABLE]: report('') });
    assert.equal(checkRelease({ root, base, log }), 0);
    assert.match(output(), /no API report at @scope\/ai-a-0\.4\.0/);
  });

  it('skips a package whose version does not change', () => {
    assert.equal(release('0.4.0', '0.4.0', breaking), 0);
    assert.equal(output(), '');
  });
});

describe('allowsBreaking', () => {
  it('allows a major bump, or a minor one before 1.0.0', () => {
    assert.equal(allowsBreaking('0.9.0', '1.0.0'), true);
    assert.equal(allowsBreaking('0.4.0', '0.5.0'), true);
    assert.equal(allowsBreaking('0.4.0', '0.4.1'), false);
    assert.equal(allowsBreaking('1.0.0', '1.1.0'), false);
    assert.equal(allowsBreaking('1.4.2', '2.0.0'), true);
  });
});
