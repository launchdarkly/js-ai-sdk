import { describe, expect, it, vi } from 'vitest';

const graphMock = vi.fn().mockReturnValue({ call: vi.fn() });

vi.mock('@launchdarkly/ai-server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@launchdarkly/ai-server')>();
  return {
    ...actual,
    graph: (...args: unknown[]) => graphMock(...args),
  };
});

import { claudeGraph } from '../graph.js';

describe('claudeGraph', () => {
  it('passes the flag key through unchanged to graph()', () => {
    claudeGraph('my-unique-graph-key', {});
    expect(graphMock).toHaveBeenCalledWith('my-unique-graph-key', expect.any(Object));
  });

  it('forwards user-supplied options to graph()', () => {
    const toolHandlers = { search: vi.fn() };
    claudeGraph('graph-flag', { toolHandlers });
    expect(graphMock).toHaveBeenCalledWith('graph-flag', expect.objectContaining({ toolHandlers }));
  });

  it('pre-binds exactly one Anthropic agent handler', () => {
    claudeGraph('graph-flag', {});
    const [, options] = graphMock.mock.calls[0];
    expect(options.handlers).toHaveLength(1);
    expect(options.handlers[0].providesFor).toEqual(['Anthropic', 'agent']);
  });
});
