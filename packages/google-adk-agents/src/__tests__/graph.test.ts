/**
 * Graph convenience wrapper. Reference: TESTING.md §2.1 and §2.x.4.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@launchdarkly/ai-server', async () => {
  const actual = await vi.importActual<typeof import('@launchdarkly/ai-server')>('@launchdarkly/ai-server');
  return { ...actual, graph: vi.fn(() => ({ invoke: vi.fn() })) };
});

import { graph } from '@launchdarkly/ai-server';
import { googleAdkGraph } from '../graph.js';

describe('googleAdkGraph', () => {
  it('pre-wires one wildcard handler and forwards the key', () => {
    googleAdkGraph('my-flag', { toolHandlers: { lookup: () => 'ok' }, handlers: [] });
    const call = vi.mocked(graph).mock.calls.at(-1);
    expect(call?.[0]).toBe('my-flag');
    const options = call?.[1] as {
      handlers: Array<{ providesFor: [string, string] }>;
      toolHandlers: Record<string, unknown>;
    };
    expect(options.handlers).toHaveLength(1);
    expect(options.handlers[0]?.providesFor).toEqual(['*', 'agent']);
    expect(options.toolHandlers.lookup).toBeTypeOf('function');
  });
});
