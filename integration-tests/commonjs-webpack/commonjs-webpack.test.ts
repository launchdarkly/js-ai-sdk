import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { bundle, createConsumer, invoke, packedFiles, repoRoot, runEntrypoint } from './harness.js';

const SETUP_TIMEOUT_MS = 15 * 60 * 1000;
const CASE_TIMEOUT_MS = 5 * 60 * 1000;

const PACKAGES = [
  'client',
  'ai-node',
  'ai-otel',
  'claude-agents',
  'claude-messages',
  'openai-agents',
  'openai-messages',
  'langchain-agents',
  'langchain-messages',
];

/** Optional dependencies each package must reach through a runtime-only import. */
const OPTIONAL_DEPS: Record<string, string[]> = {
  client: [
    '@launchdarkly/node-server-sdk',
    '@opentelemetry/context-async-hooks',
    '@opentelemetry/core',
    '@opentelemetry/exporter-trace-otlp-http',
    '@opentelemetry/otlp-exporter-base',
    '@opentelemetry/resources',
    '@opentelemetry/sdk-trace-base',
    '@opentelemetry/sdk-trace-node',
  ],
  'langchain-agents': ['@langchain/anthropic', '@langchain/aws'],
  'langchain-messages': ['@langchain/anthropic', '@langchain/aws', '@langchain/openai'],
};

const RESOLVED_SYMBOLS = {
  aiNodeConfig: 'function',
  aiNodeInitClient: 'function',
  aiServerConfig: 'function',
  openaiMessages: 'function',
  langchainMessages: 'function',
};

describe('CommonJS consumer bundled with Webpack + webpack-node-externals', () => {
  beforeAll(() => {
    createConsumer();
  }, SETUP_TIMEOUT_MS);

  it(
    'loads when the LaunchDarkly AI packages stay external — the AIC-3370 repro',
    () => {
      expect(bundle('externalized').status).toBe(0);

      const result = invoke('externalized');

      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        config: 'function',
        initClient: 'function',
        openaiMessages: 'function',
        otelTracerProvider: 'function',
      });
    },
    CASE_TIMEOUT_MS,
  );

  it(
    'loads when /^@launchdarkly\\/ai-/ is allowlisted so the bundler inlines the packages',
    () => {
      expect(bundle('allowlisted').status).toBe(0);

      const result = invoke('allowlisted');

      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        config: 'function',
        initClient: 'function',
        openaiMessages: 'function',
        otelTracerProvider: 'function',
      });
    },
    CASE_TIMEOUT_MS,
  );

  it(
    'resolves every package root through require()',
    () => {
      const result = runEntrypoint('entrypoints.cjs');

      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(RESOLVED_SYMBOLS);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    'resolves every package root through import',
    () => {
      const result = runEntrypoint('entrypoints.mjs');

      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(RESOLVED_SYMBOLS);
    },
    CASE_TIMEOUT_MS,
  );

  it.each([...Object.keys(OPTIONAL_DEPS)])('keeps %s optional dependencies behind a dynamic import in CJS', (pkg) => {
    const cjs = readFileSync(join(repoRoot, 'packages', pkg, 'dist', 'index.cjs'), 'utf8');

    for (const dep of OPTIONAL_DEPS[pkg]) {
      expect(cjs).toContain(`import("${dep}")`);
      expect(cjs).not.toContain(`require("${dep}")`);
    }
  });

  it.each([
    'client',
    'ai-node',
    'ai-otel',
    'openai-messages',
    'langchain-messages',
  ])('packs both runtime formats and both declaration formats for %s', (workspace) => {
    expect(packedFiles.get(workspace)).toEqual(
      expect.arrayContaining(['dist/index.js', 'dist/index.cjs', 'dist/index.d.ts', 'dist/index.d.cts']),
    );
  });
});

describe('package manifests', () => {
  it.each(PACKAGES)('%s declares both conditions and aligned legacy fields', (pkg) => {
    const manifest = JSON.parse(readFileSync(join(repoRoot, 'packages', pkg, 'package.json'), 'utf8'));

    expect(manifest.exports['.']).toEqual({
      import: { types: './dist/index.d.ts', default: './dist/index.js' },
      require: { types: './dist/index.d.cts', default: './dist/index.cjs' },
    });
    expect(manifest.main).toBe('dist/index.cjs');
    expect(manifest.module).toBe('dist/index.js');
    expect(manifest.types).toBe('dist/index.d.ts');
  });
});
