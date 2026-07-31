import * as server from '@launchdarkly/ai-server';
import { describe, expect, it } from 'vitest';
import * as node from '../index.js';

describe('@launchdarkly/ai-node re-exports', () => {
  it('exports every named export from @launchdarkly/ai-server', () => {
    const serverKeys = Object.keys(server);
    const nodeKeys = new Set(Object.keys(node));

    const missing = serverKeys.filter((k) => !nodeKeys.has(k));
    expect(missing, `Missing re-exports: ${missing.join(', ')}`).toHaveLength(0);
  });

  it('re-exported values are the same references as the server package', () => {
    const representativeSamples = [
      'config',
      'graph',
      'resolveGraph',
      'createHandler',
      'parseTemplate',
      'NativeTool',
    ] as const;

    for (const key of representativeSamples) {
      expect((node as any)[key]).toBe(
        (server as any)[key],
        `Expected node.${key} to be the same reference as server.${key}`,
      );
    }
  });
});
