#!/usr/bin/env node
/**
 * Checks that the published packages install and load outside this workspace.
 *
 * 1. Every bare specifier in a package's built `dist/*.js` and `dist/*.cjs` — static
 *    `import`/`require` and dynamic `import()` alike — is a Node builtin, the package
 *    itself, or declared in its `dependencies` or `peerDependencies`. A dynamic import
 *    of an undeclared package passes every workspace test, because the workspace
 *    installs every package's dependencies at once, and fails for the first user who
 *    takes that path.
 * 2. Every workspace is packed the way `npm publish` would pack it, all the tarballs
 *    are installed into one empty project, and every `exports` subpath of every
 *    package loads there through both `require()` and `import()`.
 *
 * Run `yarn build` first: both steps read `dist/`.
 *
 * Usage: node scripts/check-packaging.mjs [--skip-install]
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(import.meta.url), '..', '..');
const BUILTINS = new Set(builtinModules);

// The capture admits only what a package specifier can contain, so a string such as
// `from "${key}"` in an error message is not read as an import.
const SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)["']((?:@[a-z0-9][\w.~-]*\/)?[a-z0-9][\w.~-]*(?:\/[\w.~-]+)*|node:[\w/]+)["']/gm;

/** The bare package names a built file imports or requires, deduplicated. */
export function importedPackages(source) {
  const names = new Set();
  for (const [, specifier] of source.matchAll(SPECIFIER)) {
    if (specifier.startsWith('node:')) continue;
    const parts = specifier.split('/');
    const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
    if (!BUILTINS.has(name)) names.add(name);
  }
  return [...names].sort();
}

/** The names `manifest` imports from `files` without declaring them. */
export function undeclaredImports(manifest, files) {
  const declared = new Set([
    manifest.name,
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
  ]);
  const found = new Set(files.flatMap((source) => importedPackages(source)));
  return [...found].filter((name) => !declared.has(name)).sort();
}

function workspaces() {
  return readdirSync(join(repoRoot, 'packages'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const dir = join(repoRoot, 'packages', entry.name);
      return { dir, manifest: JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) };
    })
    .filter(({ manifest }) => !manifest.private);
}

function builtFiles(dir) {
  const dist = join(dir, 'dist');
  return readdirSync(dist)
    .filter((file) => file.endsWith('.js') || file.endsWith('.cjs'))
    .map((file) => readFileSync(join(dist, file), 'utf8'));
}

function entryPoints(manifest) {
  return Object.keys(manifest.exports ?? { '.': null })
    .filter((subpath) => subpath !== './package.json')
    .map((subpath) => (subpath === '.' ? manifest.name : `${manifest.name}/${subpath.slice(2)}`));
}

function run(command, args, cwd) {
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, npm_config_ignore_scripts: 'true' },
  });
}

function installAndLoad(packages, log) {
  const staging = mkdtempSync(join(tmpdir(), 'ld-ai-packaging-'));
  try {
    const tarballs = packages.map(({ dir }) => {
      const [entry] = JSON.parse(run('npm', ['pack', dir, '--pack-destination', staging, '--json'], staging));
      return join(staging, entry.filename);
    });
    const consumer = join(staging, 'consumer');
    run('mkdir', [consumer], staging);
    writeFileSync(join(consumer, 'package.json'), '{ "name": "ld-ai-packaging-consumer", "private": true }\n');
    run('npm', ['install', '--no-audit', '--no-fund', ...tarballs], consumer);

    const specifiers = packages.flatMap(({ manifest }) => entryPoints(manifest));
    const list = JSON.stringify(specifiers);
    writeFileSync(join(consumer, 'load.cjs'), `for (const s of ${list}) require(s);\n`);
    writeFileSync(join(consumer, 'load.mjs'), `for (const s of ${list}) await import(s);\n`);
    run('node', ['load.cjs'], consumer);
    run('node', ['load.mjs'], consumer);
    log.log(`ok   ${specifiers.length} entry points load through require() and import()`);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

export function main(argv = process.argv.slice(2), log = console) {
  const packages = workspaces();
  let failed = false;
  for (const { dir, manifest } of packages) {
    const undeclared = undeclaredImports(manifest, builtFiles(dir));
    if (undeclared.length) {
      log.error(`FAIL ${manifest.name} imports undeclared packages: ${undeclared.join(', ')}`);
      failed = true;
    } else {
      log.log(`ok   ${manifest.name}: every import is declared`);
    }
  }
  if (failed) return 1;
  if (!argv.includes('--skip-install')) installAndLoad(packages, log);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
