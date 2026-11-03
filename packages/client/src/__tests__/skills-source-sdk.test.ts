/**
 * `watchSkills(configSkills(...))` against the real Node server SDK.
 *
 * The fake clients in `skills-source.test.ts` encode a belief about the change
 * signal: the event name (`update:<key>`, not only `update`) and that the
 * client detects changes at all. This drives a version bump through the SDK's
 * own `TestData` source, whose updates go through change detection, so the
 * `update:<key>` events are the SDK's own.
 */

import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { init, type LDClient } from '@launchdarkly/node-server-sdk';
import { TestData } from '@launchdarkly/node-server-sdk/integrations';
import { afterEach, expect, it } from 'vitest';

import { initClient, shutdown } from '../lifecycle.js';
import { _setStore, InMemorySkillStore } from '../skills.js';
import { configSkills } from '../skills-source.js';
import { watchSkills } from '../skills-watch.js';
import type { ReconcileReport } from '../types.js';

const CONFIG_KEY = 'support-agent';

function hash(content: string): string {
  return createHash('sha256').update(Buffer.from(content, 'utf-8')).digest('hex');
}

function body(version: number): string {
  return `---\nname: PDF extraction\n---\nv${version}\n`;
}

function rawSkill(version: number) {
  return { key: 'pdf-extraction', version, content: body(version), contentHash: hash(body(version)) };
}

function aiConfig(version: number): Record<string, unknown> {
  return {
    model: { name: 'gpt-4o' },
    provider: { name: 'OpenAI' },
    instructions: 'Extract.',
    skills: [{ key: 'pdf-extraction', version }],
    _ldMeta: { enabled: true, variationKey: 'v1', version: 1, mode: 'agent' },
  };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return predicate();
}

const silent = { error() {}, warn() {}, info() {}, debug() {} };
let scratch: string | null = null;
let ldClient: LDClient | null = null;

afterEach(async () => {
  // shutdown() closes the base client it was given.
  await shutdown();
  ldClient = null;
  if (scratch) await rm(scratch, { recursive: true, force: true });
  scratch = null;
});

it('follows a config moving a skill from v2 to v3 through the base SDK update:<key> event', async () => {
  const td = new TestData();
  await td.update(td.flag(CONFIG_KEY).valueForAll(aiConfig(2)));
  ldClient = init('sdk-test-key', {
    updateProcessor: td.getFactory(),
    sendEvents: false,
    diagnosticOptOut: true,
    logger: silent,
  });
  await ldClient.waitForInitialization({ timeout: 5 });
  await initClient(ldClient);

  const store = new InMemorySkillStore();
  store.put(rawSkill(2));
  _setStore(store);

  scratch = await mkdtemp(path.join(tmpdir(), 'ld-skills-source-sdk-'));
  const root = path.join(scratch, 'skills');
  const reports: ReconcileReport[] = [];
  const { report, watcher } = await watchSkills(configSkills(CONFIG_KEY, { kind: 'user', key: 'user-1' }), root, {
    debounceMs: 10,
    onReconcile: (r) => {
      reports.push(r);
    },
  });
  try {
    expect(report.actions.find((a) => a.key === 'pdf-extraction')).toMatchObject({ action: 'written', version: 2 });

    // Config first: v3 is not in the store yet, so v2 stays.
    await td.update(td.flag(CONFIG_KEY).valueForAll(aiConfig(3)));
    expect(await waitUntil(() => reports.length >= 1)).toBe(true);
    expect(reports[0]?.actions.find((a) => a.key === 'pdf-extraction')?.action).toBe('error');
    expect(await readFile(path.join(root, 'pdf-extraction', 'SKILL.md'), 'utf-8')).toBe(body(2));

    // Then v3 arrives in the store, and replaces v2.
    store.put(rawSkill(3));
    expect(await waitUntil(() => reports.length >= 2)).toBe(true);
    const done = reports[reports.length - 1] as ReconcileReport;
    expect(done.ok).toBe(true);
    expect(done.actions.find((a) => a.key === 'pdf-extraction')).toMatchObject({ action: 'updated', version: 3 });
    expect(await readFile(path.join(root, 'pdf-extraction', 'SKILL.md'), 'utf-8')).toBe(body(3));
    for (const r of reports) expect(r.actions.some((a) => a.action === 'removed')).toBe(false);

    // A change to some other flag does not wake the watcher.
    const seen = watcher.reconciles;
    await td.update(td.flag('unrelated-flag').valueForAll(true));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(watcher.reconciles).toBe(seen);
  } finally {
    await watcher.close();
  }
  expect(ldClient.listenerCount(`update:${CONFIG_KEY}`)).toBe(0);
});
