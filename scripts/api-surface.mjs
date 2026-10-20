#!/usr/bin/env node
/**
 * Compares each entry point's exported names with its approved list in
 * `api-surface/`, and fails on any name the list does not allow.
 *
 * The exported names are read from the entry point's API Extractor report
 * (`packages/<package>/etc/*.api.md`), so type-only exports count. Regenerate
 * the reports with `yarn workspace <package> api:update` before running this.
 *
 * Each list line is one name in one of three states:
 *
 *   Name      public; must be exported
 *   - Name    leaving the public surface; may be exported or not
 *   + Name    joining the public surface; may be exported or not
 *
 * The lists in `api-surface/` are the approved public names. They change only
 * through sync PRs; never edit them by hand.
 *
 * Environment:
 *   API_SURFACE_DIR=<dir>   read the lists from <dir> instead of api-surface/
 *   API_SURFACE_STRICT=1    also fail on any `-` or `+` line (every major release)
 *
 * Usage: node scripts/api-surface.mjs
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Every entry point that has a list, with the API Extractor report its names
 * are read from. An entry point is added here when its package gains a report.
 */
export const ENTRY_POINTS = [
  { list: 'ai-server.txt', report: 'packages/client/etc/ai-server.api.md' },
  { list: 'ai-server.experimental.txt', report: 'packages/client/etc/ai-server-experimental.api.md' },
];

const LINE = /^(?<mark>[-+] )?(?<name>[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)(?: {2}usage=\S+)?(?: {2}# .+)?$/;

const EXPORT = /^export (?:declare )?(?:abstract )?(?:class|function|type|interface|const|enum|namespace|let|var) ([A-Za-z_][A-Za-z0-9_]*)/gm;

/**
 * Parse one list. Returns a map of name to its mark (`''`, `'-'` or `'+'`).
 * Throws when the list has no names or a line it cannot read: a list that
 * cannot be read must fail, never pass as empty.
 */
export function parseList(text, file) {
  const names = new Map();
  text.split('\n').forEach((line, index) => {
    if (line === '' || line.startsWith('#')) return;
    const match = LINE.exec(line);
    if (!match) throw new Error(`${file}:${index + 1}: cannot read line ${JSON.stringify(line)}`);
    names.set(match.groups.name, (match.groups.mark ?? '').trim());
  });
  if (names.size === 0) throw new Error(`${file}: the list has no names`);
  return names;
}

/** Every name an API Extractor report says the entry point exports, type-only names included. */
export function reportNames(text) {
  return new Set([...text.matchAll(EXPORT)].map((match) => match[1]));
}

/**
 * Apply the three checks to one entry point. Returns the failures and the gap
 * report: the `-` names still exported and the `+` names not yet exported.
 */
export function compare(file, list, exported, { strict = false } = {}) {
  const failures = [];
  for (const name of [...exported].sort()) {
    if (!list.has(name)) {
      failures.push(`${name} is exported but is not in ${file}. Add it there as "+ ${name}" first.`);
    }
  }
  const leaving = [];
  const joining = [];
  for (const [name, mark] of list) {
    if (mark === '' && !exported.has(name)) {
      failures.push(`${name} is public in ${file} but is not exported. Removing it is a breaking change.`);
    }
    if (mark === '-' && exported.has(name)) leaving.push(name);
    if (mark === '+' && !exported.has(name)) joining.push(name);
    if (strict && mark !== '') failures.push(`${file} still marks ${mark} ${name}; a major release needs no markers.`);
  }
  return { failures, leaving, joining };
}

/** Run every entry point. Returns the process exit code. */
export function main({ listDir = process.env.API_SURFACE_DIR, strict = process.env.API_SURFACE_STRICT === '1', log = console } = {}) {
  const dir = resolve(ROOT, listDir ?? 'api-surface');
  let failed = false;
  for (const { list: listFile, report } of ENTRY_POINTS) {
    const listPath = join(dir, listFile);
    const reportPath = join(ROOT, report);
    let list;
    let exported;
    try {
      if (!existsSync(listPath)) throw new Error(`${listPath}: the list is missing`);
      list = parseList(readFileSync(listPath, 'utf8'), listFile);
      if (!existsSync(reportPath)) throw new Error(`${reportPath}: the API report is missing`);
      exported = reportNames(readFileSync(reportPath, 'utf8'));
    } catch (err) {
      log.error(`✗ ${err.message}`);
      failed = true;
      continue;
    }
    const { failures, leaving, joining } = compare(listFile, list, exported, { strict });
    for (const failure of failures) log.error(`✗ ${failure}`);
    log.log(
      `${failures.length ? '✗' : '✓'} ${listFile}: ${exported.size} exported, ` +
        `${leaving.length} leaving and still exported, ${joining.length} joining and not yet exported`,
    );
    if (leaving.length) log.log(`    - ${leaving.join(', ')}`);
    if (joining.length) log.log(`    + ${joining.join(', ')}`);
    if (failures.length) failed = true;
  }
  return failed ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
