import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const driver = join(here, 'canary.mjs');

const VERSIONS = ['--ai-server=0.4.0', '--ai-node=0.3.0', '--openai-messages=0.3.0', '--ai-otel=0.2.0'];

const PAYLOAD = {
  ok: true,
  runtime: 'v22.11.0',
  versions: {
    '@launchdarkly/ai-server': '0.4.0',
    '@launchdarkly/ai-node': '0.3.0',
    '@launchdarkly/ai-openai-messages': '0.3.0',
    '@launchdarkly/ai-otel': '0.2.0',
  },
  capabilities: {
    aiServer: 'object',
    config: 'function',
    initClient: 'function',
    shutdown: 'function',
    openaiMessages: 'function',
    aiOtel: 'object',
  },
};

function writePayload(payload: unknown): string {
  const file = join(mkdtempSync(join(tmpdir(), 'ld-canary-')), 'response.json');
  writeFileSync(file, JSON.stringify(payload));
  return file;
}

function assertPayload(payload: unknown, versions: string[] = VERSIONS) {
  return spawnSync('node', [driver, 'assert', `--response=${writePayload(payload)}`, ...versions], {
    encoding: 'utf8',
  });
}

describe('release canary driver', () => {
  it('accepts a capability payload from the expected versions on Node 22', () => {
    const result = assertPayload(PAYLOAD);

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it('rejects versions that are not exact', () => {
    const result = assertPayload(PAYLOAD, [
      '--ai-server=0.4.0',
      '--ai-node=latest',
      '--openai-messages=0.3.0',
      '--ai-otel=0.2.0',
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('not an exact version');
  });

  it('rejects a payload built from different versions than were published', () => {
    const result = assertPayload({
      ...PAYLOAD,
      versions: { ...PAYLOAD.versions, '@launchdarkly/ai-node': '0.2.0' },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('expected 0.3.0');
  });

  it('rejects a payload from a runtime other than Node 22', () => {
    const result = assertPayload({ ...PAYLOAD, runtime: 'v20.11.0' });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Expected a Node 22 runtime');
  });

  it('rejects a capability the Lambda could not resolve — the AIC-3370 failure mode', () => {
    const result = assertPayload({
      ...PAYLOAD,
      capabilities: { ...PAYLOAD.capabilities, config: 'undefined' },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Capability config resolved to undefined');
  });

  it('rejects a callable export that resolves to the wrong type', () => {
    const result = assertPayload({
      ...PAYLOAD,
      capabilities: { ...PAYLOAD.capabilities, initClient: 'object' },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Capability initClient resolved to object, expected function');
  });

  it('rejects a payload that drops an expected export', () => {
    const { shutdown: _dropped, ...capabilities } = PAYLOAD.capabilities;
    const result = assertPayload({ ...PAYLOAD, capabilities });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Capability shutdown resolved to nothing');
  });

  it('reports a Lambda invocation error instead of passing', () => {
    const result = assertPayload({
      errorType: 'Error',
      errorMessage: 'No "exports" main defined in @launchdarkly/ai-node/package.json',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Lambda returned an error');
  });
});
