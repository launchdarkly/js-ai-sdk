import { type SpawnSyncReturns, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export const repoRoot = join(here, '..', '..');
export const stagingDir = join(here, '.staging');
export const consumerDir = join(stagingDir, 'consumer');

const tarballDir = join(stagingDir, 'tarballs');

/** Workspaces a CommonJS Lambda consumer installs from npm. */
const WORKSPACES = ['client', 'ai-node', 'ai-otel', 'openai-messages'];

/** Pinned to the versions reported in AIC-3370. */
const BUNDLER_DEPS = ['webpack@5.104.1', 'webpack-cli@6.0.1', 'webpack-node-externals@3.0.0'];

export type Variant = 'externalized' | 'allowlisted';

export interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = {}): RunResult {
  const result: SpawnSyncReturns<string> = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    maxBuffer: 32 * 1024 * 1024,
  });

  if (result.error) {
    throw result.error;
  }

  return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

function runOrThrow(command: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv): RunResult {
  const result = run(command, args, cwd, env);
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed (${result.status}):\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

/**
 * Builds the workspaces, packs them the way `npm publish` would, and installs the tarballs into an
 * isolated CommonJS consumer alongside the Serverless-style bundler toolchain.
 */
export function createConsumer(): string {
  runOrThrow('yarn', ['build'], repoRoot);

  rmSync(stagingDir, { recursive: true, force: true });
  mkdirSync(tarballDir, { recursive: true });
  mkdirSync(consumerDir, { recursive: true });

  const tarballs = WORKSPACES.map((workspace) => {
    const packed = runOrThrow(
      'npm',
      ['pack', join(repoRoot, 'packages', workspace), '--pack-destination', tarballDir, '--json'],
      repoRoot,
    );
    const [entry] = JSON.parse(packed.stdout) as Array<{ filename: string }>;
    return join(tarballDir, entry.filename);
  });

  writeFileSync(
    join(consumerDir, 'package.json'),
    `${JSON.stringify({ name: 'ld-ai-commonjs-webpack-consumer', version: '0.0.0', private: true }, null, 2)}\n`,
  );
  cpSync(join(here, 'fixture'), consumerDir, { recursive: true });

  runOrThrow('npm', ['install', '--no-audit', '--no-fund', ...tarballs, ...BUNDLER_DEPS], consumerDir);

  return consumerDir;
}

export function bundle(variant: Variant): RunResult {
  return run('npx', ['webpack', '--config', 'webpack.config.cjs'], consumerDir, {
    LD_AI_ALLOWLIST: variant === 'allowlisted' ? '1' : '0',
  });
}

export function invoke(variant: Variant): RunResult {
  return run('node', ['invoke.cjs', `./dist-${variant}/handler.js`], consumerDir);
}
