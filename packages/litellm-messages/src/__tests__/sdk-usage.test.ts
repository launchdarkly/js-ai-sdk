/**
 * `$ld:ai:sdk:usage` for litellm-messages.
 */

import type { LDClientInterface, LDContext } from '@launchdarkly/ai-server';
import { initClient, shutdown } from '@launchdarkly/ai-server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LD_AI_PACKAGE_NAME as AI_SDK_NAME,
  LD_AI_PACKAGE_VERSION as AI_SDK_VERSION,
} from '../../../client/src/version.js';
import { createLiteLLMMessagesHandler, litellmMessages } from '../handler.js';
import { LD_AI_PACKAGE_NAME, LD_AI_PACKAGE_VERSION } from '../version.js';

const ctx: LDContext = { kind: 'user', key: 'user-1' };
const proxy = { baseURL: 'http://127.0.0.1:4000' };

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

describe('litellm-messages helper usage', () => {
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
    ['litellm-messages.litellmMessages', () => settle(litellmMessages('k', 'q', ctx, proxy))],
    ['litellm-messages.createLiteLLMMessagesHandler', () => settle(createLiteLLMMessagesHandler(proxy))],
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
