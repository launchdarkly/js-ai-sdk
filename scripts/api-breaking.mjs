#!/usr/bin/env node
/**
 * Fails on an undeclared breaking change to the public API.
 *
 *   node scripts/api-breaking.mjs pr --base <ref> --title <PR title> [--labels a,b]
 *   node scripts/api-breaking.mjs release --base <ref> [--labels a,b]
 *
 * `pr` compares each API Extractor report (`packages/<package>/etc/*.api.md`)
 * with the same report at `--base`. A breaking change passes only if the PR
 * title declares it with `!` (`feat!: ...`, `fix(client)!: ...`), which makes
 * release-please cut a major version (a minor one before 1.0.0), or if an
 * owner applied the `api-compatible` label because they judge the flagged
 * change compatible.
 *
 * `release` runs on the release PR. For each package whose version changes,
 * it compares the package's reports with the ones at its last release tag,
 * and fails on a breaking change unless the new version is a major one (a
 * minor one before 1.0.0), or an owner applied the `api-compatible` label.
 *
 * API Extractor does not classify changes, so every removed or changed
 * declaration counts as breaking and an added one does not. A report that is
 * removed (a removed entry point or package) is breaking too. Experimental
 * reports (`*-experimental.api.md`) are skipped: an experimental feature may
 * change in a minor release.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const BREAKING_TITLE = /^[a-z]+(\([^)]*\))?!:/;
export const COMPATIBLE_LABEL = 'api-compatible';

const DECLARATION =
  /^export (?:declare )?(?:abstract )?(?:class|function|type|interface|const|enum|namespace|let|var) ([A-Za-z_$][A-Za-z0-9_$]*)/;
const REPORT = /^packages\/[^/]+\/etc\/[^/]+\.api\.md$/;

/**
 * Every exported declaration in a report, by name. A declaration runs from its
 * `export` line to the next blank line, which is how API Extractor separates
 * them. Comment lines are dropped: an added doc comment, `(undocumented)` note
 * or `@deprecated` tag is not a change. A name declared more than once
 * (overloads, a type and a const) keeps all of them.
 */
export function declarations(text) {
  const found = new Map();
  let current = null;
  for (const line of text.split('\n')) {
    const match = DECLARATION.exec(line);
    if (match) {
      current = match[1];
      found.set(current, [...(found.get(current) ?? []), line]);
    } else if (line.trim() === '' || line.startsWith('```')) {
      current = null;
    } else if (current && !line.trim().startsWith('//')) {
      found.get(current).push(line);
    }
  }
  return new Map([...found].map(([name, lines]) => [name, lines.join('\n')]));
}

/** Explain every breaking difference between two versions of one report. `head` is null when the report was removed. */
export function compare(report, base, head) {
  if (head === null) return [`${report}: the report was removed (a removed entry point or package)`];
  const before = declarations(base);
  const after = declarations(head);
  const found = [];
  for (const [name, text] of before) {
    if (!after.has(name)) found.push(`${report}: ${name} was removed`);
    else if (after.get(name) !== text)
      found.push(`${report}: ${name} changed\n  was: ${indent(text)}\n  now: ${indent(after.get(name))}`);
  }
  return found;
}

const indent = (text) => text.replaceAll('\n', '\n       ');

const stable = (path) => REPORT.test(path) && !path.endsWith('-experimental.api.md');

function git(root, ...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** The stable reports at `ref`, or in the working tree when `ref` is null, under `dirs` (default: every package). */
function reports(root, ref, dirs = null) {
  const paths =
    ref === null
      ? readdirSync(join(root, 'packages')).flatMap((pkg) => {
          const etc = join(root, 'packages', pkg, 'etc');
          return existsSync(etc) ? readdirSync(etc).map((file) => `packages/${pkg}/etc/${file}`) : [];
        })
      : git(root, 'ls-tree', '-r', '--name-only', ref, '--', 'packages').split('\n');
  return paths.filter((path) => stable(path) && (dirs === null || dirs.some((dir) => path.startsWith(`${dir}/`))));
}

const read = (root, ref, path) =>
  ref === null ? readFileSync(join(root, path), 'utf8') : git(root, 'show', `${ref}:${path}`);

/** Every breaking change to the reports under `dirs` since `ref`. */
function changesSince(root, ref, dirs = null) {
  const now = new Set(reports(root, null, dirs));
  return reports(root, ref, dirs).flatMap((path) =>
    compare(path, read(root, ref, path), now.has(path) ? read(root, null, path) : null),
  );
}

export function checkPr({ root = ROOT, base, title, labels = [], log = console }) {
  const found = changesSince(root, base);
  if (found.length === 0) {
    log.log('No breaking changes to the public API.');
    return 0;
  }
  log.log(found.join('\n'));
  if (BREAKING_TITLE.test(title)) {
    log.log(
      '\nDeclared breaking with `!` in the PR title: release-please will cut a major version (a minor one before 1.0.0).',
    );
    return 0;
  }
  if (labels.includes(COMPATIBLE_LABEL)) {
    log.log(`\nAn owner judged these changes compatible (\`${COMPATIBLE_LABEL}\` label).`);
    return 0;
  }
  log.log(
    `\n${found.length} breaking change(s) to the public API. Declare a breaking change with \`!\` in the PR title ` +
      `(\`feat!: ...\`, \`fix(scope)!: ...\`). If an owner judges the change compatible, they apply the ` +
      `\`${COMPATIBLE_LABEL}\` label instead.`,
  );
  return 1;
}

const version = (text) => text.match(/\d+/g).slice(0, 3).map(Number);

/** True if `old` → `next` is a major bump, or a minor one before 1.0.0. */
export function allowsBreaking(old, next) {
  const [oMajor, oMinor] = version(old);
  const [nMajor, nMinor] = version(next);
  return nMajor > oMajor || (oMajor === 0 && nMajor === 0 && nMinor > oMinor);
}

export function checkRelease({ root = ROOT, base, labels = [], log = console }) {
  const config = JSON.parse(readFileSync(join(root, 'release-please-config.json'), 'utf8')).packages;
  const next = JSON.parse(readFileSync(join(root, '.release-please-manifest.json'), 'utf8'));
  const old = JSON.parse(git(root, 'show', `${base}:.release-please-manifest.json`));
  let failed = false;
  for (const pkg of Object.keys(next).sort()) {
    if (old[pkg] === undefined || old[pkg] === next[pkg]) continue;
    const tag = `${config[pkg].component}-${old[pkg]}`;
    try {
      git(root, 'rev-parse', '--verify', '--quiet', `refs/tags/${tag}`);
    } catch {
      log.log(`${pkg}: no release tag ${tag}, so there is nothing to compare with`);
      continue;
    }
    if (reports(root, tag, [pkg]).length === 0) {
      log.log(`${pkg}: no API report at ${tag}, so there is nothing to compare with`);
      continue;
    }
    const found = changesSince(root, tag, [pkg]);
    if (found.length === 0 || allowsBreaking(old[pkg], next[pkg])) {
      log.log(`${pkg}: ${old[pkg]} -> ${next[pkg]} matches its changes since ${tag}`);
      continue;
    }
    failed = true;
    log.log(found.join('\n'));
    log.log(
      `${pkg}: ${old[pkg]} -> ${next[pkg]}, but the changes above since ${tag} are breaking. It needs a major ` +
        'version (a minor one before 1.0.0): a merged PR that made one of them was not declared with `!` in its title.',
    );
  }
  if (failed && labels.includes(COMPATIBLE_LABEL)) {
    log.log(`\nAn owner judged these changes compatible (\`${COMPATIBLE_LABEL}\` label).`);
    return 0;
  }
  if (failed) {
    log.log(
      `\nIf an owner judges these changes compatible, they apply the \`${COMPATIBLE_LABEL}\` label to this release PR.`,
    );
  }
  return failed ? 1 : 0;
}

export function main(argv) {
  const [command, ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    options: { base: { type: 'string' }, title: { type: 'string' }, labels: { type: 'string', default: '' } },
  });
  const labels = values.labels
    .split(',')
    .map((label) => label.trim())
    .filter(Boolean);
  if (!values.base || !['pr', 'release'].includes(command) || (command === 'pr' && values.title === undefined)) {
    console.error(
      'usage: api-breaking.mjs pr --base <ref> --title <title> [--labels a,b]\n       api-breaking.mjs release --base <ref> [--labels a,b]',
    );
    return 2;
  }
  if (command === 'pr') return checkPr({ base: values.base, title: values.title, labels });
  return checkRelease({ base: values.base, labels });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
