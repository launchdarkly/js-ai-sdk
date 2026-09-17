import { describe, expect, it, vi } from 'vitest';

const graphMock = vi.fn().mockReturnValue({ invoke: vi.fn() });

vi.mock('@launchdarkly/ai-server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@launchdarkly/ai-server')>();
  return {
    ...actual,
    graph: (...args: unknown[]) => graphMock(...args),
  };
});

import { bedrockGraph } from '../graph.js';

describe('bedrockGraph', () => {
  it('passes the flag key and user options through', () => {
    const toolHandlers = { lookup: vi.fn() };
    const registry = {};

    const result = bedrockGraph('bedrock-graph', { toolHandlers, registry } as any);

    expect(result).toBe(graphMock.mock.results[0].value);
    expect(graphMock).toHaveBeenCalledWith('bedrock-graph', expect.objectContaining({ toolHandlers, registry }));
  });

  it('prebinds exactly one Bedrock agent handler', () => {
    bedrockGraph('bedrock-graph', {});

    const [, options] = graphMock.mock.calls[0];
    expect(options.handlers).toHaveLength(1);
    expect(options.handlers[0].providesFor).toEqual(['Bedrock', 'agent']);
  });

  it('does not allow caller options to replace the Bedrock handler', () => {
    const wrongHandler = Object.assign(vi.fn(), { providesFor: ['Wrong', 'agent'] });

    bedrockGraph('bedrock-graph', { handlers: [wrongHandler] } as any);

    const [, options] = graphMock.mock.calls[0];
    expect(options.handlers).toHaveLength(1);
    expect(options.handlers[0]).not.toBe(wrongHandler);
    expect(options.handlers[0].providesFor).toEqual(['Bedrock', 'agent']);
  });
});
