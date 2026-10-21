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
const WORKSPACES = ['client', 'ai-node', 'ai-otel', 'openai-messages', 'langchain-messages'];

/** Pinned to the versions reported in AIC-3370. */
const BUNDLER_DEPS = ['webpack@5.104.1', 'webpack-cli@6.0.1', 'webpack-node-externals@3.0.0'];

/** Type-checks the consumer's imports (see `typecheck`). */
const TYPESCRIPT_DEP = 'typescript@5.9.3';

export type Variant = 'externalized' | 'allowlisted';

/** Workspace name -> paths inside the tarball `npm publish` would upload. */
export const packedFiles = new Map<string, string[]>();

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

/** Drops any lifecycle-script output npm emitted before its `--json` payload. */
function stripPrefix(stdout: string): string {
  const start = stdout.search(/^\[$/m);
  return start === -1 ? stdout : stdout.slice(start);
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
      { npm_config_ignore_scripts: 'true' },
    );
    const [entry] = JSON.parse(stripPrefix(packed.stdout)) as Array<{
      filename: string;
      files: Array<{ path: string }>;
    }>;
    packedFiles.set(
      workspace,
      entry.files.map(({ path }) => path),
    );
    return join(tarballDir, entry.filename);
  });

  writeFileSync(
    join(consumerDir, 'package.json'),
    `${JSON.stringify({ name: 'ld-ai-commonjs-webpack-consumer', version: '0.0.0', private: true }, null, 2)}\n`,
  );
  cpSync(join(here, 'fixture'), consumerDir, { recursive: true });

  runOrThrow('npm', ['install', '--no-audit', '--no-fund', ...tarballs, ...BUNDLER_DEPS, TYPESCRIPT_DEP], consumerDir);

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

/** `moduleResolution` modes paired with the `module` setting each requires. */
export const RESOLUTION_MODES = {
  node10: 'commonjs',
  node16: 'node16',
  bundler: 'esnext',
} as const;

export type ResolutionMode = keyof typeof RESOLUTION_MODES;

/**
 * Type-checks `types.ts` against the installed tarballs' declarations. Runs the consumer's own
 * `tsc` rather than `npx`, whose npm config warnings would land in stderr. `--listFiles` prints
 * every file the program loaded, so a caller can check where each declaration came from.
 */
export function typecheck(mode: ResolutionMode): RunResult {
  return run(
    'node',
    [
      join('node_modules', 'typescript', 'bin', 'tsc'),
      '--noEmit',
      '--listFiles',
      // Only the consumer's own `@types`, not those of every ancestor `node_modules`.
      '--typeRoots',
      join('node_modules', '@types'),
      '--strict',
      '--skipLibCheck',
      '--module',
      RESOLUTION_MODES[mode],
      '--moduleResolution',
      mode,
      'types.ts',
    ],
    consumerDir,
  );
}

/** Runs an unbundled entry point against the installed tarballs. */
export function runEntrypoint(file: string): RunResult {
  return run('node', [file], consumerDir);
}
