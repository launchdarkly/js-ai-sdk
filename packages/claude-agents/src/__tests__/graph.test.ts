import { describe, expect, it, vi } from 'vitest';

const graphMock = vi.fn().mockReturnValue({ call: vi.fn() });
const mockQuery = vi.fn();

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  tool: vi.fn(),
  createSdkMcpServer: vi.fn(),
}));

vi.mock('@launchdarkly/ai-server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@launchdarkly/ai-server')>();
  return {
    ...actual,
    graphInternal: (...args: unknown[]) => graphMock(...args),
  };
});

import type { ProviderHandler } from '@launchdarkly/ai-server';
import { claudeGraph } from '../graph.js';

/** Runs the handler `claudeGraph` bound and returns the options its `query()` received. */
async function boundHandlerQueryOptions(): Promise<Record<string, unknown>> {
  const handler: ProviderHandler = graphMock.mock.calls.at(-1)?.[1].handlers[0];
  mockQuery.mockImplementation(async function* () {
    yield { type: 'result', subtype: 'success', result: 'ok', usage: { input_tokens: 1, output_tokens: 1 } };
  });
  await handler({ model: { name: 'claude-opus-4-5' }, provider: { name: 'Anthropic' }, instructions: 'hi' }, 'q');
  return mockQuery.mock.calls.at(-1)?.[0].options;
}

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

  it('binds a handler that sends settingSources: [] and no cwd by default', async () => {
    claudeGraph('graph-flag', {});
    const options = await boundHandlerQueryOptions();
    expect(options.settingSources).toEqual([]);
    expect(Object.hasOwn(options, 'cwd')).toBe(false);
  });

  it('forwards cwd and settingSources to the bound handler, not to graph()', async () => {
    claudeGraph('graph-flag', { cwd: '/srv/app', settingSources: ['user'] });
    const [, graphOptions] = graphMock.mock.calls.at(-1) ?? [];
    expect(graphOptions).not.toHaveProperty('cwd');
    expect(graphOptions).not.toHaveProperty('settingSources');
    const options = await boundHandlerQueryOptions();
    expect(options.cwd).toBe('/srv/app');
    expect(options.settingSources).toEqual(['user']);
  });
});
