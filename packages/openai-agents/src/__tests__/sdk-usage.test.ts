/**
 * TESTING.md §3.27 — `$ld:ai:sdk:usage` for openai-agents.
 */

import type { LDClientInterface, LDContext } from '@launchdarkly/ai-server';
import { initClient, shutdown } from '@launchdarkly/ai-server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LD_AI_PACKAGE_NAME as AI_SDK_NAME,
  LD_AI_PACKAGE_VERSION as AI_SDK_VERSION,
} from '../../../client/src/version.js';
import { openaiGraph } from '../graph.js';
import { createOpenAIAgentHandler, openaiAgents } from '../handler.js';
import { toOpenAIAgents } from '../native-graph.js';
import { LD_AI_PACKAGE_NAME, LD_AI_PACKAGE_VERSION } from '../version.js';

const ctx: LDContext = { kind: 'user', key: 'user-1' };
const anonymous = { kind: 'ld_ai', key: 'ld-internal-tracking', anonymous: true };

/** The core client identity, plus this package's own name and version as it registers with `$ld:ai:sdk:info`. */
function expectedPayload(helper: string) {
  return {
    aiSdkName: AI_SDK_NAME,
    aiSdkVersion: AI_SDK_VERSION,
    aiSdkLanguage: 'javascript',
    helper,
    helperPackageName: LD_AI_PACKAGE_NAME,
    helperPackageVersion: LD_AI_PACKAGE_VERSION,
  };
}

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

async function drainSettled(stream: AsyncGenerator<unknown>): Promise<void> {
  try {
    for await (const _event of stream) {
      // Iterating runs the graph walk; a failure after the report still leaves the event.
    }
  } catch {
    // The graph is disabled in this fixture, so iteration throws.
  }
}

describe('§3.27 openai-agents helper usage', () => {
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
    ['openai-agents.openaiAgents', () => settle(openaiAgents('k', 'q', ctx))],
    [
      'openai-agents.createOpenAIAgentHandler',
      () => {
        createOpenAIAgentHandler();
        return Promise.resolve();
      },
    ],
    [
      'openai-agents.openaiGraph',
      () => {
        openaiGraph('k', {});
        return Promise.resolve();
      },
    ],
    // The returned caller's methods run later; they must not add client.graph.* events.
    ['openai-agents.openaiGraph', () => settle(openaiGraph('k', {}).invoke('q', ctx))],
    ['openai-agents.openaiGraph', () => drainSettled(openaiGraph('k', {}).stream('q', ctx))],
    [
      'openai-agents.toOpenAIAgents',
      () => {
        toOpenAIAgents(Promise.resolve({} as never));
        return Promise.resolve();
      },
    ],
    [
      'openai-agents.toOpenAIAgents',
      () => settle(toOpenAIAgents(Promise.resolve({ key: 'k', enabled: false } as never)).invoke('q')),
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
    expect(calls[0]?.[2]).toEqual(expectedPayload(helper));
    expect(calls[0]?.[3]).toBe(1);
  });

  it('sends a helper called before a client exists with its package fields once the client exists', async () => {
    await shutdown();
    try {
      createOpenAIAgentHandler();
    } catch {
      // A factory may throw after the report. The held record is what is under test.
    }
    client = fakeClient();
    await initClient(client);
    const calls = client.track.mock.calls.filter((entry) => entry[0] === '$ld:ai:sdk:usage');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[2]).toEqual(expectedPayload('openai-agents.createOpenAIAgentHandler'));
  });
});
