#!/usr/bin/env node

// Release canary driver. It stages a clean CommonJS Serverless app.
// The app installs the exact published versions of the LaunchDarkly AI packages.
// The driver waits on npm, builds the app, or checks the payload from a deployed Lambda.
//
// Usage:
//   node canary.mjs wait   --ai-server=0.4.0 --ai-node=0.3.0 --openai-messages=0.3.0 --ai-otel=0.2.0
//   node canary.mjs build  <same version flags> [--package] [--stage=local]
//   node canary.mjs assert --response=<path> <same version flags>
//
// Versions may also be supplied as
// LD_AI_CANARY_VERSIONS='ai-server=0.4.0,ai-node=0.3.0,openai-messages=0.3.0,ai-otel=0.2.0'.

import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const appDir = join(here, '.canary', 'app');

// Short name -> published package name. The core package is installed directly, because
// ai-node depends on it with `*` and would otherwise resolve to any visible core version.
const PACKAGES = {
  'ai-server': '@launchdarkly/ai-server',
  'ai-node': '@launchdarkly/ai-node',
  'openai-messages': '@launchdarkly/ai-openai-messages',
  'ai-otel': '@launchdarkly/ai-otel',
};

/** Pinned to the Serverless 3 + Webpack 5 toolchain reported in AIC-3370. */
const TOOLCHAIN = {
  serverless: '3.40.0',
  'serverless-webpack': '5.15.4',
  webpack: '5.104.1',
  'webpack-cli': '6.0.1',
  'webpack-node-externals': '3.0.0',
};

/** The exact type each export must have inside the Lambda. */
const EXPECTED_CAPABILITIES = {
  aiServer: 'object',
  config: 'function',
  initClient: 'function',
  shutdown: 'function',
  openaiMessages: 'function',
  aiOtel: 'object',
};

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-.]+)?$/;

const NPM_WAIT_ATTEMPTS = 30;
const NPM_WAIT_INTERVAL_MS = 10_000;

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function run(command, args, cwd, options = {}) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', stdio: 'inherit', ...options });
  if (result.error) {
    throw result.error;
  }
  if (!options.allowFailure && result.status !== 0) {
    fail(`${command} ${args.join(' ')} failed with status ${result.status}`);
  }
  return result;
}

function capture(command, args, cwd) {
  return spawnSync(command, args, { cwd, encoding: 'utf8' });
}

function parseArgs(argv) {
  const args = {};
  for (const arg of argv) {
    const match = /^--([^=]+)(?:=(.*))?$/.exec(arg);
    if (!match) {
      fail(`Unrecognized argument: ${arg}`);
    }
    args[match[1]] = match[2] ?? 'true';
  }
  return args;
}

/** Resolves one exact version per package. Ranges, dist-tags, and workspace links are rejected. */
function resolveVersions(args) {
  const fromEnv = {};
  for (const pair of (process.env.LD_AI_CANARY_VERSIONS ?? '').split(',')) {
    const [name, version] = pair.split('=').map((part) => part.trim());
    if (name && version) {
      fromEnv[name] = version;
    }
  }

  const versions = {};
  for (const [shortName, packageName] of Object.entries(PACKAGES)) {
    const version = args[shortName] ?? fromEnv[shortName];
    if (!version) {
      fail(`Missing version for ${packageName}. Pass --${shortName}=<x.y.z> or set LD_AI_CANARY_VERSIONS.`);
    }
    if (!EXACT_VERSION.test(version)) {
      fail(`${packageName}@${version} is not an exact version. The canary never installs ranges or dist-tags.`);
    }
    versions[packageName] = version;
  }
  return versions;
}

async function waitForNpm(versions) {
  for (const [packageName, version] of Object.entries(versions)) {
    let visible = false;
    for (let attempt = 1; attempt <= NPM_WAIT_ATTEMPTS; attempt += 1) {
      const result = capture('npm', ['view', `${packageName}@${version}`, 'version'], here);
      if (result.status === 0 && result.stdout.trim() === version) {
        visible = true;
        process.stdout.write(`${packageName}@${version} is visible on npm\n`);
        break;
      }
      process.stdout.write(`${packageName}@${version} not on npm yet (attempt ${attempt}/${NPM_WAIT_ATTEMPTS})\n`);
      await sleep(NPM_WAIT_INTERVAL_MS);
    }
    if (!visible) {
      fail(`${packageName}@${version} never became visible on npm.`);
    }
  }
}

function writeApp(versions) {
  rmSync(join(here, '.canary'), { recursive: true, force: true });
  mkdirSync(appDir, { recursive: true });

  for (const file of ['handler.cjs', 'serverless.yml', 'webpack.config.cjs']) {
    cpSync(join(here, 'fixture', file), join(appDir, file));
  }

  const manifest = {
    name: 'ld-ai-lambda-canary-app',
    version: '0.0.0',
    private: true,
    description: 'Ephemeral CommonJS Lambda that loads the published LaunchDarkly AI packages.',
    license: 'Apache-2.0',
    dependencies: versions,
    devDependencies: TOOLCHAIN,
  };
  writeFileSync(join(appDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

/** Asserts npm installed the exact versions requested, and records them for the handler to echo. */
function recordInstalledVersions(versions) {
  const listed = capture('npm', ['ls', '--depth=0', '--json'], appDir);
  const installed = JSON.parse(listed.stdout || '{}').dependencies ?? {};

  const resolved = {};
  for (const [packageName, expected] of Object.entries(versions)) {
    const actual = installed[packageName]?.version;
    if (actual !== expected) {
      fail(`${packageName} resolved to ${actual ?? 'nothing'}, expected ${expected}.`);
    }
    resolved[packageName] = actual;
  }
  writeFileSync(join(appDir, 'versions.json'), `${JSON.stringify(resolved, null, 2)}\n`);
}

function build(versions, { packageApp, stage }) {
  writeApp(versions);
  run('npm', ['install', '--save-exact', '--no-audit', '--no-fund'], appDir);
  recordInstalledVersions(versions);

  if (packageApp) {
    run('npx', ['serverless', 'package', '--stage', stage], appDir, {
      env: { ...process.env, SLS_TELEMETRY_DISABLED: '1' },
    });
  }
}

function assertResponse(responsePath, versions) {
  const payload = JSON.parse(readFileSync(responsePath, 'utf8'));

  if (payload.errorType || payload.errorMessage) {
    fail(`Lambda returned an error: ${payload.errorType ?? ''} ${payload.errorMessage ?? ''}`);
  }
  if (payload.ok !== true) {
    fail(`Capability payload did not report ok: ${JSON.stringify(payload)}`);
  }
  if (!String(payload.runtime ?? '').startsWith('v22.')) {
    fail(`Expected a Node 22 runtime, got ${payload.runtime}.`);
  }

  for (const [symbol, expectedType] of Object.entries(EXPECTED_CAPABILITIES)) {
    const actualType = payload.capabilities?.[symbol];
    if (actualType !== expectedType) {
      fail(`Capability ${symbol} resolved to ${actualType ?? 'nothing'}, expected ${expectedType}.`);
    }
  }
  for (const [packageName, expected] of Object.entries(versions)) {
    if (payload.versions?.[packageName] !== expected) {
      fail(`Lambda loaded ${packageName}@${payload.versions?.[packageName]}, expected ${expected}.`);
    }
  }

  process.stdout.write(`Canary passed on ${payload.runtime}: ${JSON.stringify(payload.versions)}\n`);
}

const [command, ...rest] = process.argv.slice(2);
const args = parseArgs(rest);
const versions = resolveVersions(args);

switch (command) {
  case 'wait':
    await waitForNpm(versions);
    break;
  case 'build':
    build(versions, { packageApp: args.package === 'true', stage: args.stage ?? 'local' });
    break;
  case 'assert':
    if (!args.response) {
      fail('assert requires --response=<path to the invoke payload>');
    }
    assertResponse(args.response, versions);
    break;
  default:
    fail(`Unknown command: ${command ?? '(none)'}. Expected wait, build, or assert.`);
}
