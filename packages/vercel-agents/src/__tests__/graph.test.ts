import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createHandler: vi.fn(() => ({ providesFor: ['*', 'agent'] })),
  graph: vi.fn(() => ({ invoke: vi.fn() })),
}));

vi.mock('@launchdarkly/ai-server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@launchdarkly/ai-server')>();
  return { ...actual, graph: mocks.graph };
});

vi.mock('../handler.js', () => ({
  createVercelAgentsHandler: mocks.createHandler,
}));

import { vercelGraph } from '../graph.js';

describe('vercelGraph', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('passes the graph key through unchanged', () => {
    vercelGraph('vercel-graph', {});
    expect(mocks.graph).toHaveBeenCalledWith('vercel-graph', expect.any(Object));
  });

  it('pre-wires exactly one wildcard Vercel agent handler', () => {
    vercelGraph('vercel-graph', {
      handlers: [{ providesFor: ['malicious', 'agent'] }],
    } as any);
    const options = mocks.graph.mock.calls[0][1];
    expect(options.handlers).toEqual([{ providesFor: ['*', 'agent'] }]);
  });

  it('forwards graph options but routes model and capture options to the handler factory', () => {
    const model = { modelId: 'injected-model' };
    const modelFactory = vi.fn();
    const toolHandlers = { search: vi.fn() };
    vercelGraph('vercel-graph', {
      model,
      modelFactory,
      captureContent: true,
      toolHandlers,
    } as any);
    expect(mocks.createHandler).toHaveBeenCalledWith({ model, modelFactory, captureContent: true });
    expect(mocks.graph).toHaveBeenCalledWith(
      'vercel-graph',
      expect.objectContaining({
        toolHandlers,
        handlers: [{ providesFor: ['*', 'agent'] }],
      }),
    );
    const graphOptions = mocks.graph.mock.calls[0][1];
    expect(graphOptions).not.toHaveProperty('model');
    expect(graphOptions).not.toHaveProperty('modelFactory');
    expect(graphOptions).not.toHaveProperty('captureContent');
  });
});
