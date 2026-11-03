/**
 * `$ld:ai:sdk:usage` for typesafe.
 */

import type { LDClientInterface } from '@launchdarkly/ai-server';
import { initClient, shutdown } from '@launchdarkly/ai-server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LD_AI_PACKAGE_NAME as AI_SDK_NAME,
  LD_AI_PACKAGE_VERSION as AI_SDK_VERSION,
} from '../../../client/src/version.js';
import { createTypesafeHandler } from '../handler.js';
import { LD_AI_PACKAGE_NAME, LD_AI_PACKAGE_VERSION } from '../version.js';

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

describe('typesafe helper usage', () => {
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
    [
      'typesafe.createTypesafeHandler',
      () => {
        createTypesafeHandler();
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
    expect(calls[0]?.[2]).toEqual(expectedPayload(helper));
    expect(calls[0]?.[3]).toBe(1);
  });

  it('sends a helper called before a client exists with its package fields once the client exists', async () => {
    await shutdown();
    try {
      createTypesafeHandler();
    } catch {
      // A factory may throw after the report. The held record is what is under test.
    }
    client = fakeClient();
    await initClient(client);
    const calls = client.track.mock.calls.filter((entry) => entry[0] === '$ld:ai:sdk:usage');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[2]).toEqual(expectedPayload('typesafe.createTypesafeHandler'));
  });
});
