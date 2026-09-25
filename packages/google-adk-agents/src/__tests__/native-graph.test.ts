/**
 * Native ADK workflow adapter. Reference: TESTING.md §2.2 and §2.x.4.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const created = vi.hoisted(() => ({
  agents: [] as Array<{ config: Record<string, unknown> }>,
  tools: [] as Array<{ name: string; execute: () => unknown }>,
  workflows: [] as Array<{ config: Record<string, unknown> }>,
  runners: [] as Array<{
    sessionService: { appendEvent: ReturnType<typeof vi.fn> };
  }>,
  runs: 0,
  followTransfer: false,
  explode: null as Error | null,
}));

const track = vi.hoisted(() => vi.fn());

vi.mock('@launchdarkly/ai-server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@launchdarkly/ai-server')>();
  return { ...actual, getClient: () => ({ track }) };
});

vi.mock('@google/adk', () => {
  class LlmAgent {
    config: Record<string, unknown>;
    constructor(config: Record<string, unknown>) {
      this.config = config;
      created.agents.push(this);
    }
  }
  class FunctionTool {
    name: string;
    execute: () => unknown;
    constructor(config: { name: string; execute: () => unknown }) {
      this.name = config.name;
      this.execute = config.execute;
      created.tools.push(this);
    }
  }
  class Workflow {
    config: Record<string, unknown>;
    constructor(config: Record<string, unknown>) {
      this.config = config;
      created.workflows.push(this);
    }
  }
  class InMemoryRunner {
    sessionService = {
      createSession: vi.fn(async () => ({ id: 'sess' })),
      appendEvent: vi.fn(async () => ({})),
    };
    constructor() {
      created.runners.push(this);
    }
    async *runAsync() {
      created.runs += 1;
      if (created.explode) throw created.explode;
      if (created.followTransfer && created.runs === 1) {
        const transfer = created.tools.find((tool) => tool.name === 'transfer_to_leaf');
        await Promise.resolve(transfer?.execute());
        yield {
          final: true,
          partial: false,
          content: { parts: [{ text: 'root' }] },
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
        };
        return;
      }
      yield {
        final: true,
        partial: false,
        content: { parts: [{ text: 'leaf-answer' }] },
        usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3, totalTokenCount: 5 },
      };
    }
  }
  class BasePlugin {}
  class Gemini {}
  return {
    BasePlugin,
    FunctionTool,
    Gemini,
    InMemoryRunner,
    LlmAgent,
    START: 'START',
    Workflow,
    createEvent: (event: unknown) => event,
    isFinalResponse: (event: { final?: boolean }) => Boolean(event.final),
  };
});

import { toAdkAgents } from '../native-graph.js';

function graphDef(enabled = true) {
  const leaf = {
    key: 'leaf',
    config: { model: { name: 'gemini-2.5-flash' }, provider: { name: 'Google' }, instructions: 'instructions-leaf' },
    edges: [],
    isTerminal: () => true,
  };
  const root = {
    key: 'root',
    config: { model: { name: 'gemini-2.5-flash' }, provider: { name: 'Google' }, instructions: 'instructions-root' },
    edges: [{ targetKey: 'leaf', key: 'root-leaf', sourceKey: 'root' }],
    isTerminal: () => false,
  };
  return {
    enabled,
    key: 'graph-flag',
    root: enabled ? root : null,
    getNode: (key: string) => (key === 'leaf' ? leaf : root),
  };
}

beforeEach(() => {
  created.agents.length = 0;
  created.tools.length = 0;
  created.workflows.length = 0;
  created.runners.length = 0;
  created.runs = 0;
  created.followTransfer = false;
  created.explode = null;
  track.mockClear();
});

describe('toAdkAgents', () => {
  it('throws when the graph is disabled', async () => {
    await expect(toAdkAgents(graphDef(false) as never).call('hi')).rejects.toThrow(/graph-flag/);
  });

  it('builds two agents, a START edge, and one transfer tool', async () => {
    const result = await toAdkAgents(graphDef() as never).call('hi');
    expect(created.agents).toHaveLength(2);
    expect(created.tools.map((tool) => tool.name)).toEqual(['transfer_to_leaf']);
    const edges = created.workflows[0]?.config.edges as unknown[];
    expect(edges[0]).toEqual(expect.arrayContaining(['START']));
    expect(result).toMatchObject({ response: 'leaf-answer', usage: { total: 5 } });
  });

  it('selects the target when the transfer tool runs', async () => {
    await toAdkAgents(graphDef() as never).call('hi');
    expect(String(created.tools[0]?.execute())).toContain('leaf');
  });

  it('seeds history on the root session only', async () => {
    await toAdkAgents(graphDef() as never).call('hi', { history: [{ role: 'user', content: 'earlier' }] });
    expect(created.runners[0]?.sessionService.appendEvent).toHaveBeenCalledTimes(1);
    expect(created.runners).toHaveLength(1);
  });

  it('forwards node-local tools', async () => {
    const def = graphDef();
    def.root!.config.tools = {
      lookup: { name: 'lookup', description: 'find', parameters: { type: 'object' } },
    };
    await toAdkAgents(def as never, { toolHandlers: { lookup: ({ q }: { q: string }) => q } }).call('hi');
    expect(created.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(['lookup', 'transfer_to_leaf']));
  });

  it('visits the target when a transfer runs and sums usage', async () => {
    created.followTransfer = true;
    const result = await toAdkAgents(graphDef() as never).call('hi');
    expect(created.runs).toBe(2);
    expect(result).toMatchObject({ response: 'leaf-answer', usage: { total: 7 } });
  });

  it('emits graph telemetry when a context is present', async () => {
    const { trace } = await import('@opentelemetry/api');
    const span = { setAttribute: vi.fn(), setStatus: vi.fn(), end: vi.fn(), recordException: vi.fn() };
    const startSpan = vi.fn(() => span);
    const spy = vi.spyOn(trace, 'getTracer').mockReturnValue({ startSpan } as never);
    await toAdkAgents(graphDef() as never).call('hi', { context: { kind: 'user', key: 'user-1' } });
    expect(startSpan).toHaveBeenCalledWith('launchdarkly.graph');
    const events = track.mock.calls.map((call) => call[0]);
    expect(events).toEqual(
      expect.arrayContaining([
        '$ld:ai:graph:invocation_success',
        '$ld:ai:graph:duration:total',
        '$ld:ai:graph:total_tokens',
      ]),
    );
    expect(span.end).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('tracks invocation failure and ends the span when the runner throws', async () => {
    const { trace } = await import('@opentelemetry/api');
    const span = { setAttribute: vi.fn(), setStatus: vi.fn(), end: vi.fn(), recordException: vi.fn() };
    const spy = vi.spyOn(trace, 'getTracer').mockReturnValue({ startSpan: () => span } as never);
    created.explode = new Error('runner broke');
    await expect(
      toAdkAgents(graphDef() as never).call('hi', { context: { kind: 'user', key: 'user-1' } }),
    ).rejects.toThrow('runner broke');
    expect(track).toHaveBeenCalledWith('$ld:ai:graph:invocation_failure', expect.anything(), expect.anything(), 1);
    expect(span.end).toHaveBeenCalled();
    spy.mockRestore();
  });
});
