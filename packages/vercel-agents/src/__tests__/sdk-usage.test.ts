/**
 * TESTING.md §3.27 — `$ld:ai:sdk:usage` for vercel-agents. JavaScript only.
 */

import type { LDClientInterface, LDContext } from '@launchdarkly/ai-server';
import { initClient, shutdown } from '@launchdarkly/ai-server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('ai', () => ({
  jsonSchema: vi.fn(),
  Output: { object: vi.fn() },
  stepCountIs: vi.fn(),
  tool: vi.fn(),
  ToolLoopAgent: class ToolLoopAgent {},
}));

import { LD_AI_PACKAGE_NAME, LD_AI_PACKAGE_VERSION } from '../../../client/src/version.js';
import { vercelGraph } from '../graph.js';
import { createVercelAgentsHandler, vercelAgents } from '../handler.js';
import { toVercelAgents } from '../native-graph.js';

const ctx: LDContext = { kind: 'user', key: 'user-1' };
const anonymous = { kind: 'ld_ai', key: 'ld-internal-tracking', anonymous: true };

type FakeClient = LDClientInterface & { track: ReturnType<typeof vi.fn> };

function fakeClient(): FakeClient {
  return {
    variation: vi.fn().mockResolvedValue(undefined),
    track: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as FakeClient;
}

async function settle(value: Promise<unknown>): Promise<void> {
  try {
    await value;
  } catch {
    // The report is the first statement. A later failure still leaves the event.
  }
}

describe('§3.27 vercel-agents helper usage', () => {
  let client: FakeClient;

  beforeEach(async () => {
    await shutdown();
    client = fakeClient();
    await initClient(client);
    client.track.mockClear();
  });

  afterEach(async () => {
    await shutdown();
  });

  it.each([
    ['vercel-agents.vercelAgents', () => settle(vercelAgents('k', 'q', ctx))],
    [
      'vercel-agents.createVercelAgentsHandler',
      () => {
        createVercelAgentsHandler();
        return Promise.resolve();
      },
    ],
    [
      'vercel-agents.vercelGraph',
      () => {
        vercelGraph('k', {});
        return Promise.resolve();
      },
    ],
    [
      'vercel-agents.toVercelAgents',
      () => {
        toVercelAgents(Promise.resolve({} as never));
        return Promise.resolve();
      },
    ],
  ] as Array<[string, () => Promise<void>]>)('%s sends one $ld:ai:sdk:usage event', async (helper, call) => {
    try {
      await call();
    } catch {
      // A factory may throw after the report. The assertion is the event.
    }
    const calls = client.track.mock.calls.filter((entry) => entry[0] === '$ld:ai:sdk:usage');
    expect(calls.map((entry) => entry[2]?.helper)).toEqual([helper]);
    expect(calls[0]?.[1]).toEqual(anonymous);
    expect(calls[0]?.[2]).toEqual({
      aiSdkName: LD_AI_PACKAGE_NAME,
      aiSdkVersion: LD_AI_PACKAGE_VERSION,
      aiSdkLanguage: 'javascript',
      helper,
    });
    expect(calls[0]?.[3]).toBe(1);
  });
});
