import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushAiSdkInfo, registerAiSdkPackage, resetAiSdkInfo, SDK_INFO_CONTEXT, SDK_INFO_EVENT } from '../sdk-info.js';
import type { LDClientInterface } from '../types.js';

function fakeClient(): LDClientInterface & { track: ReturnType<typeof vi.fn> } {
  return {
    variation: vi.fn(),
    track: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as LDClientInterface & { track: ReturnType<typeof vi.fn> };
}

describe('sdk-info', () => {
  beforeEach(() => {
    resetAiSdkInfo({ clearKnown: true });
  });

  it('sends one event per registered package', () => {
    const client = fakeClient();
    registerAiSdkPackage('@launchdarkly/ai-server', '0.1.1');
    registerAiSdkPackage('@launchdarkly/ai-openai-agents', '0.1.1');

    flushAiSdkInfo(client);

    expect(client.track).toHaveBeenCalledTimes(2);
    expect(client.track).toHaveBeenNthCalledWith(
      1,
      '$ld:ai:sdk:info',
      SDK_INFO_CONTEXT,
      {
        aiSdkName: '@launchdarkly/ai-server',
        aiSdkVersion: '0.1.1',
        aiSdkLanguage: 'javascript',
      },
      1,
    );
    expect(client.track).toHaveBeenNthCalledWith(
      2,
      '$ld:ai:sdk:info',
      SDK_INFO_CONTEXT,
      {
        aiSdkName: '@launchdarkly/ai-openai-agents',
        aiSdkVersion: '0.1.1',
        aiSdkLanguage: 'javascript',
      },
      1,
    );
  });

  it('uses the anonymous ld_ai context', () => {
    expect(SDK_INFO_EVENT).toBe('$ld:ai:sdk:info');
    expect(SDK_INFO_CONTEXT).toEqual({
      kind: 'ld_ai',
      key: 'ld-internal-tracking',
      anonymous: true,
    });
  });

  it('deduplicates repeated registration and flushing', () => {
    const client = fakeClient();
    registerAiSdkPackage('@launchdarkly/ai-server', '0.1.1');
    registerAiSdkPackage('@launchdarkly/ai-server', '0.1.1');

    flushAiSdkInfo(client);
    flushAiSdkInfo(client);

    expect(client.track).toHaveBeenCalledOnce();
  });

  it('reports two loaded versions of one package', () => {
    const client = fakeClient();
    registerAiSdkPackage('@launchdarkly/ai-server', '0.1.0');
    registerAiSdkPackage('@launchdarkly/ai-server', '0.1.1');

    flushAiSdkInfo(client);

    expect(client.track.mock.calls.map((call) => call[2].aiSdkVersion)).toEqual(['0.1.0', '0.1.1']);
  });

  it('reports a package registered after the first flush', () => {
    const client = fakeClient();
    registerAiSdkPackage('@launchdarkly/ai-server', '0.1.1');
    flushAiSdkInfo(client);
    client.track.mockClear();

    registerAiSdkPackage('@launchdarkly/ai-claude-agents', '0.1.1');
    flushAiSdkInfo(client);

    expect(client.track).toHaveBeenCalledOnce();
    expect(client.track.mock.calls[0][2].aiSdkName).toBe('@launchdarkly/ai-claude-agents');
  });

  it('reports known packages again after reset', () => {
    const client = fakeClient();
    registerAiSdkPackage('@launchdarkly/ai-server', '0.1.1');
    flushAiSdkInfo(client);
    client.track.mockClear();

    resetAiSdkInfo();
    flushAiSdkInfo(client);

    expect(client.track).toHaveBeenCalledOnce();
  });

  it('does not let a failing track call break or retry', () => {
    const client = fakeClient();
    client.track.mockImplementation(() => {
      throw new Error('client closed');
    });
    registerAiSdkPackage('@launchdarkly/ai-server', '0.1.1');

    expect(() => flushAiSdkInfo(client)).not.toThrow();
    client.track.mockReset();
    flushAiSdkInfo(client);

    expect(client.track).not.toHaveBeenCalled();
  });
});
