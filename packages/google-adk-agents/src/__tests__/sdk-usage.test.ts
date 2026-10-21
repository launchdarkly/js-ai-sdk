/**
 * TESTING.md §3.27 — `$ld:ai:sdk:usage` for google-adk-agents.
 */

import type { LDClientInterface, LDContext } from '@launchdarkly/ai-server';
import { initClient, shutdown } from '@launchdarkly/ai-server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LD_AI_PACKAGE_NAME as AI_SDK_NAME,
  LD_AI_PACKAGE_VERSION as AI_SDK_VERSION,
} from '../../../client/src/version.js';
import { googleAdkGraph } from '../graph.js';
import { createGoogleAdkAgentsHandler, googleAdkAgents } from '../handler.js';
import { toAdkAgents } from '../native-graph.js';
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

describe('§3.27 google-adk-agents helper usage', () => {
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
    ['google-adk-agents.googleAdkAgents', () => settle(googleAdkAgents('k', 'q', ctx))],
    ['google-adk-agents.createGoogleAdkAgentsHandler', () => settle(createGoogleAdkAgentsHandler())],
    ['google-adk-agents.googleAdkGraph', () => settle(googleAdkGraph('k'))],
    ['google-adk-agents.googleAdkGraph', () => settle(googleAdkGraph('k').invoke('q', ctx))],
    ['google-adk-agents.toAdkAgents', () => settle(toAdkAgents({ key: 'k', enabled: false } as never))],
    ['google-adk-agents.toAdkAgents', () => settle(toAdkAgents({ key: 'k', enabled: false } as never).call('q'))],
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
