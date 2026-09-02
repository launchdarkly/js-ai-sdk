import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushAiSdkInfo, registerAiSdkPackage, resetAiSdkInfo, SDK_INFO_CONTEXT, SDK_INFO_EVENT } from '../sdk-info.js';
import type { LDClientInterface } from '../types.js';

const SDK_INFO_KEY = Symbol.for('@launchdarkly/ai-server:sdk-info');

function fakeClient(): LDClientInterface & { track: ReturnType<typeof vi.fn> } {
  return {
    variation: vi.fn(),
    track: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as LDClientInterface & { track: ReturnType<typeof vi.fn> };
}

/** Drops all state, so each test starts with no package registered. */
function clearState(): void {
  delete (globalThis as Record<symbol, unknown>)[SDK_INFO_KEY];
}

describe('sdk-info', () => {
  beforeEach(() => {
    clearState();
  });

  it('sends one event per registered package', () => {
    const client = fakeClient();
    registerAiSdkPackage('@launchdarkly/ai-server', '0.1.1');
    registerAiSdkPackage('@launchdarkly/ai-openai-agents', '0.2.0');

    flushAiSdkInfo(client);

    expect(client.track).toHaveBeenCalledTimes(2);
    expect(client.track).toHaveBeenNthCalledWith(
      1,
      '$ld:ai:sdk:info',
      SDK_INFO_CONTEXT,
      { aiSdkName: '@launchdarkly/ai-server', aiSdkVersion: '0.1.1', aiSdkLanguage: 'javascript' },
      1,
    );
    expect(client.track).toHaveBeenNthCalledWith(
      2,
      '$ld:ai:sdk:info',
      SDK_INFO_CONTEXT,
      { aiSdkName: '@launchdarkly/ai-openai-agents', aiSdkVersion: '0.2.0', aiSdkLanguage: 'javascript' },
      1,
    );
  });

  it('uses the anonymous ld_ai context', () => {
    expect(SDK_INFO_CONTEXT).toEqual({ kind: 'ld_ai', key: 'ld-internal-tracking', anonymous: true });
    expect(SDK_INFO_EVENT).toBe('$ld:ai:sdk:info');
  });

  it('sends nothing when no package is registered', () => {
    const client = fakeClient();
    flushAiSdkInfo(client);
    expect(client.track).not.toHaveBeenCalled();
  });

  it('sends a package once, however many times it registers', () => {
    const client = fakeClient();
    registerAiSdkPackage('@launchdarkly/ai-server', '0.1.1');
    registerAiSdkPackage('@launchdarkly/ai-server', '0.1.1');
    registerAiSdkPackage('@launchdarkly/ai-server', '0.1.1');

    flushAiSdkInfo(client);

    expect(client.track).toHaveBeenCalledTimes(1);
  });

  it('sends nothing on a second flush', () => {
    const client = fakeClient();
    registerAiSdkPackage('@launchdarkly/ai-server', '0.1.1');

    flushAiSdkInfo(client);
    client.track.mockClear();
    flushAiSdkInfo(client);
    flushAiSdkInfo(client);

    expect(client.track).not.toHaveBeenCalled();
  });

  it('sends both copies when one package is present at two versions', () => {
    const client = fakeClient();
    registerAiSdkPackage('@launchdarkly/ai-openai-agents', '0.1.1');
    registerAiSdkPackage('@launchdarkly/ai-openai-agents', '0.2.0');

    flushAiSdkInfo(client);

    expect(client.track).toHaveBeenCalledTimes(2);
    const versions = client.track.mock.calls.map((call) => (call[2] as { aiSdkVersion: string }).aiSdkVersion);
    expect(versions).toEqual(['0.1.1', '0.2.0']);
  });

  it('sends a package that registers after the first flush', () => {
    const client = fakeClient();
    registerAiSdkPackage('@launchdarkly/ai-server', '0.1.1');
    flushAiSdkInfo(client);
    client.track.mockClear();

    registerAiSdkPackage('@launchdarkly/ai-claude-messages', '0.1.1');
    flushAiSdkInfo(client);

    expect(client.track).toHaveBeenCalledTimes(1);
    expect(client.track.mock.calls[0][2]).toEqual({
      aiSdkName: '@launchdarkly/ai-claude-messages',
      aiSdkVersion: '0.1.1',
      aiSdkLanguage: 'javascript',
    });
  });

  it('reports the known packages again after a reset', () => {
    const client = fakeClient();
    registerAiSdkPackage('@launchdarkly/ai-server', '0.1.1');
    flushAiSdkInfo(client);
    client.track.mockClear();

    // A reset stands in for shutdown(). Module-scope registration does not run
    // a second time, so the package has to report again without re-registering.
    resetAiSdkInfo();
    flushAiSdkInfo(client);

    expect(client.track).toHaveBeenCalledTimes(1);
  });

  it('does not let a failing track break the caller', () => {
    const client = fakeClient();
    client.track.mockImplementation(() => {
      throw new Error('client is closed');
    });
    registerAiSdkPackage('@launchdarkly/ai-server', '0.1.1');

    expect(() => flushAiSdkInfo(client)).not.toThrow();

    // The package counts as reported, so a failure is not retried on every call.
    client.track.mockReset();
    flushAiSdkInfo(client);
    expect(client.track).not.toHaveBeenCalled();
  });
});
