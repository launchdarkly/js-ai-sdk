/**
 * TESTING.md §3.27 — `$ld:ai:sdk:usage` for bedrock-agents.
 */

import type { LDClientInterface, LDContext } from '@launchdarkly/ai-server';
import { initClient, shutdown } from '@launchdarkly/ai-server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LD_AI_PACKAGE_NAME as AI_SDK_NAME,
  LD_AI_PACKAGE_VERSION as AI_SDK_VERSION,
} from '../../../client/src/version.js';
import { bedrockGraph } from '../graph.js';
import { bedrockAgents, createBedrockAgentsHandler } from '../handler.js';
import { LD_AI_PACKAGE_NAME, LD_AI_PACKAGE_VERSION } from '../version.js';

const ctx: LDContext = { kind: 'user', key: 'user-1' };

function fakeClient() {
  return {
    variation: vi.fn().mockResolvedValue(undefined),
    track: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as LDClientInterface & { track: ReturnType<typeof vi.fn> };
}

async function settle(value: unknown): Promise<void> {
  try {
    await value;
  } catch {
    // The report is the first statement. A later failure still leaves the event.
  }
}

describe('§3.27 bedrock-agents helper usage', () => {
  let client: ReturnType<typeof fakeClient>;

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
    ['bedrock-agents.bedrockAgents', () => settle(bedrockAgents('k', 'q', ctx))],
    ['bedrock-agents.createBedrockAgentsHandler', () => settle(createBedrockAgentsHandler())],
    ['bedrock-agents.bedrockGraph', () => settle(bedrockGraph('k', {}))],
    ['bedrock-agents.bedrockGraph', () => settle(bedrockGraph('k', {}).invoke('q', ctx))],
  ] as Array<[string, () => Promise<void>]>)('%s sends one $ld:ai:sdk:usage event', async (helper, call) => {
    await call();
    const calls = client.track.mock.calls.filter((entry) => entry[0] === '$ld:ai:sdk:usage');
    expect(calls.map((entry) => entry[2]?.helper)).toEqual([helper]);
    expect(calls[0]?.[2]).toEqual({
      aiSdkName: AI_SDK_NAME,
      aiSdkVersion: AI_SDK_VERSION,
      aiSdkLanguage: 'javascript',
      helper,
      helperPackageName: LD_AI_PACKAGE_NAME,
      helperPackageVersion: LD_AI_PACKAGE_VERSION,
    });
  });
});
