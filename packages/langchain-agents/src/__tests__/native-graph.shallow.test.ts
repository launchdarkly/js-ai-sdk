/**
 * Shallow-mock tests for toLangGraph that use the REAL @langchain/langgraph package.
 *
 * These mirror the Python test_workflow_state_annotations_resolve test and guard the
 * TypeScript side against regressions in the StateAnnotation.Root({ reducer: addMessages })
 * wiring.  The primary safety net is that `addMessages` is referenced at module load time
 * (not lazily inside a function) so the Annotation.Root(...) call succeeds immediately.
 *
 * This file intentionally does NOT vi.mock('@langchain/langgraph') so the real StateGraph,
 * Annotation, and addMessages are exercised.  Only infrastructure mocks (LD client, OTel)
 * and the LLM are substituted.
 */

import { AIMessage, type BaseMessage, ToolMessage } from '@langchain/core/messages';
import { getClient } from '@launchdarkly/ai-server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Infrastructure mocks (not the code under test) ──────────────────────────

vi.mock('@launchdarkly/ai-server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@launchdarkly/ai-server')>();
  return {
    ...actual,
    getClient: vi.fn().mockReturnValue({ track: vi.fn() }),
  };
});

vi.mock('@opentelemetry/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@opentelemetry/api')>();
  return {
    ...actual,
    trace: {
      ...actual.trace,
      getTracer: vi.fn().mockReturnValue({
        startActiveSpan: vi.fn().mockImplementation((_name: string, fn: Function) =>
          fn({
            setAttribute: vi.fn(),
            addEvent: vi.fn(),
            setStatus: vi.fn(),
            end: vi.fn(),
            recordException: vi.fn(),
          }),
        ),
      }),
    },
  };
});

import { toLangGraph } from '../native-graph.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeSingleNodeDef() {
  const root = {
    key: 'root',
    config: {
      model: { name: 'gpt-4o' },
      provider: { name: 'LangChain' },
      instructions: 'be helpful',
    },
    meta: { variationKey: 'v1', version: 1 },
    isTerminal: () => true,
    edges: [],
  } as any;

  return {
    key: 'test-graph',
    enabled: true,
    root,
    edgesFrom: (_key: string) => [],
    traverse: async (fn: (node: any) => Promise<void>) => {
      await fn(root);
    },
  } as any;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('toLangGraph — StateAnnotation and addMessages resolve with real StateGraph', () => {
  it('completes without error and returns { response, usage } when using real StateGraph', async () => {
    const fakeResponse = new AIMessage({
      content: 'real graph answer',
      usage_metadata: { input_tokens: 3, output_tokens: 7, total_tokens: 10 },
    });

    // Mock only the LLM's invoke — no real network call
    const mockModel = {
      bindTools: vi.fn().mockReturnThis(),
      invoke: vi.fn().mockResolvedValue(fakeResponse),
    } as any;

    const result = await toLangGraph(Promise.resolve(makeSingleNodeDef()), {
      modelFactory: () => mockModel,
    }).invoke('hello');

    expect(result).toMatchObject({
      response: 'real graph answer',
      usage: {
        input: 3,
        output: 7,
        total: 10,
      },
    });
  });

  it('StateAnnotation.Root with real addMessages does not throw at module load', () => {
    // Importing toLangGraph already exercised this at module load time.
    // This explicit assertion documents the invariant: the module-level
    // StateAnnotation construction succeeded — if addMessages were missing or
    // lazily imported inside a function this import would have thrown.
    expect(toLangGraph).toBeTypeOf('function');
  });
});

// ─── Hand-offs through a real StateGraph (AIC-3592) ──────────────────────────

function makeHandoffDef(children: string[], routerTools?: Record<string, unknown>) {
  const makeNode = (key: string, edges: string[], tools?: Record<string, unknown>) =>
    ({
      key,
      config: {
        model: { name: 'm' },
        provider: { name: 'LangChain' },
        instructions: `you are ${key}`,
        ...(tools ? { tools } : {}),
      },
      meta: { variationKey: 'v1', version: 1 },
      isTerminal: () => edges.length === 0,
      edges: edges.map((c) => ({ key: `${key}-${c}`, sourceKey: key, targetKey: c })),
    }) as any;

  const router = makeNode('router', children, routerTools);
  const nodes = [router, ...children.map((c) => makeNode(c, []))];
  return {
    key: 'test-graph',
    enabled: true,
    root: router,
    edgesFrom: (key: string) => nodes.find((n) => n.key === key)?.edges ?? [],
    traverse: async (fn: (node: any) => Promise<void>) => {
      for (const n of nodes) await fn(n);
    },
  } as any;
}

/** One mock model per node; each invoke returns that node's next scripted reply. */
function scriptedModels(replies: Record<string, AIMessage[]>) {
  const models = Object.fromEntries(
    Object.entries(replies).map(([key, msgs]) => {
      const invoke = vi.fn();
      for (const m of msgs) invoke.mockResolvedValueOnce(m);
      const model = { invoke, bindTools: vi.fn() } as any;
      model.bindTools.mockReturnValue(model);
      return [key, model];
    }),
  );
  return { modelFactory: (node: any) => models[node.key], models };
}

const toolCallMsg = (...calls: [string, string][]) =>
  new AIMessage({ content: '', tool_calls: calls.map(([name, id]) => ({ name, args: {}, id, type: 'tool_call' })) });

function toolMessagesSentTo(model: any): ToolMessage[] {
  const sent: BaseMessage[] = model.invoke.mock.calls[0][0];
  return sent.filter((m): m is ToolMessage => ToolMessage.isInstance(m));
}

function handoffSuccessCount(): number {
  const track = (getClient() as any).track as ReturnType<typeof vi.fn>;
  return track.mock.calls.filter(([evt]) => evt === '$ld:ai:graph:handoff_success').length;
}

describe('toLangGraph — hand-offs through a real StateGraph', () => {
  beforeEach(() => {
    ((getClient() as any).track as ReturnType<typeof vi.fn>).mockClear();
  });

  it('a multi-child router hands off once and is not run again', async () => {
    const { modelFactory, models } = scriptedModels({
      router: [toolCallMsg(['transfer_to_butler', 'call_1'])],
      butler: [new AIMessage('the butler did it')],
      cook: [],
    });

    const result = await toLangGraph(Promise.resolve(makeHandoffDef(['butler', 'cook'])), {
      modelFactory,
      context: { kind: 'user', key: 'u' },
    }).invoke('who did it?');

    expect(result.response).toBe('the butler did it');
    expect(models.router.invoke).toHaveBeenCalledTimes(1);
    expect(models.cook.invoke).not.toHaveBeenCalled();
    const [answer] = toolMessagesSentTo(models.butler);
    expect(answer.tool_call_id).toBe('call_1');
    expect(answer.content).toBe('Handed off to butler.');
    expect(handoffSuccessCount()).toBe(1);
  });

  it('never passes parallel_tool_calls to bindTools (Bedrock Converse rejects it)', async () => {
    const { modelFactory, models } = scriptedModels({
      router: [toolCallMsg(['transfer_to_butler', 'call_1'])],
      butler: [new AIMessage('done')],
      cook: [],
    });

    await toLangGraph(Promise.resolve(makeHandoffDef(['butler', 'cook'])), { modelFactory }).invoke('hi');

    expect(models.router.bindTools).toHaveBeenCalledTimes(1);
    expect(models.router.bindTools.mock.calls[0]).toHaveLength(1);
  });

  it('runs a normal tool call and a hand-off from the same message, then hands off', async () => {
    const lookup = vi.fn().mockResolvedValue('clue');
    const { modelFactory, models } = scriptedModels({
      router: [toolCallMsg(['lookup', 'call_a'], ['transfer_to_butler', 'call_b'])],
      butler: [new AIMessage('done')],
      cook: [],
    });
    const def = makeHandoffDef(['butler', 'cook'], {
      lookup: { description: 'look up', parameters: { type: 'object', properties: {} } },
    });

    const result = await toLangGraph(Promise.resolve(def), { modelFactory, toolHandlers: { lookup } }).invoke('hi');

    expect(result.response).toBe('done');
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(models.router.invoke).toHaveBeenCalledTimes(1);
    const answers = Object.fromEntries(toolMessagesSentTo(models.butler).map((m) => [m.tool_call_id, m.content]));
    expect(answers).toEqual({ call_a: 'clue', call_b: 'Handed off to butler.' });
  });

  it('routes only the first hand-off when one message has two', async () => {
    const { modelFactory, models } = scriptedModels({
      router: [toolCallMsg(['transfer_to_butler', 'call_1'], ['transfer_to_cook', 'call_2'])],
      butler: [new AIMessage('butler answer')],
      cook: [],
    });

    const result = await toLangGraph(Promise.resolve(makeHandoffDef(['butler', 'cook'])), {
      modelFactory,
      context: { kind: 'user', key: 'u' },
    }).invoke('hi');

    expect(result.response).toBe('butler answer');
    expect(models.cook.invoke).not.toHaveBeenCalled();
    const answers = Object.fromEntries(toolMessagesSentTo(models.butler).map((m) => [m.tool_call_id, m.content]));
    expect(answers).toEqual({
      call_1: 'Handed off to butler.',
      call_2: 'Ignored: only the first transfer in a turn routes.',
    });
    expect(handoffSuccessCount()).toBe(1);
  });

  it('a single-child node hands off once and is not run again', async () => {
    const { modelFactory, models } = scriptedModels({
      router: [toolCallMsg(['transfer_to_butler', 'call_1'])],
      butler: [new AIMessage('the butler did it')],
    });

    const result = await toLangGraph(Promise.resolve(makeHandoffDef(['butler'])), { modelFactory }).invoke('hi');

    expect(result.response).toBe('the butler did it');
    expect(models.router.invoke).toHaveBeenCalledTimes(1);
    const [answer] = toolMessagesSentTo(models.butler);
    expect(answer.tool_call_id).toBe('call_1');
  });
});
