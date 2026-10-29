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

import {
  AIMessage,
  AIMessageChunk,
  type BaseMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  ToolMessageChunk,
} from '@langchain/core/messages';
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

import { toLangGraph, toNeutralHistory } from '../native-graph.js';

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

/** An AI message with tool calls; each call is [name, id] or [name, id, args]. */
const toolCallMsg = (calls: [string, string, Record<string, unknown>?][], content: any = '') =>
  new AIMessage({
    content,
    tool_calls: calls.map(([name, id, args]) => ({ name, args: args ?? {}, id, type: 'tool_call' })),
  });

/** [type, content] of each message a node's model received on one call. */
function sent(model: any, call = 0): [string, unknown][] {
  return (model.invoke.mock.calls[call][0] as BaseMessage[]).map((m) => [m.getType(), m.content]);
}

/** No tool role, tool calls or non-text blocks reach a node that was handed to. */
function expectNeutral(model: any) {
  for (const m of model.invoke.mock.calls[0][0] as BaseMessage[]) {
    expect(ToolMessage.isInstance(m)).toBe(false);
    expect((m as AIMessage).tool_calls ?? []).toHaveLength(0);
    expect(typeof m.content).toBe('string');
  }
}

// Same literal as the Python tests' _REASONING, so the two rewrite tests share one input.
const REASONING = { type: 'reasoning_content', reasoning_content: { text: 'hmm' } };

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
      router: [toolCallMsg([['transfer_to_manor_butler', 'call_1']], [REASONING, { type: 'text', text: 'Routing.' }])],
      'manor.butler': [new AIMessage('the butler did it')],
      cook: [],
    });

    const result = await toLangGraph(Promise.resolve(makeHandoffDef(['manor.butler', 'cook'])), {
      modelFactory,
      context: { kind: 'user', key: 'u' },
    }).invoke('who did it?');

    expect(result.response).toBe('the butler did it');
    expect(models.router.invoke).toHaveBeenCalledTimes(1);
    expect(models.cook.invoke).not.toHaveBeenCalled();
    // A target with no tools gets the router's turn as plain text: reasoning dropped, the
    // call and its result as lines. The result text uses the raw target key; the tool name
    // uses the sanitized one.
    expect(sent(models['manor.butler'])).toEqual([
      ['system', 'you are manor.butler'],
      ['human', 'who did it?'],
      ['ai', 'Routing.\n[Tool call] transfer_to_manor_butler {}'],
      ['human', '[Tool result] transfer_to_manor_butler: Handed off to manor.butler.'],
    ]);
    expectNeutral(models['manor.butler']);
    expect(handoffSuccessCount()).toBe(1);
  });

  it('never passes parallel_tool_calls to bindTools (Bedrock Converse rejects it)', async () => {
    const { modelFactory, models } = scriptedModels({
      router: [toolCallMsg([['transfer_to_butler', 'call_1']])],
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
      router: [
        toolCallMsg([
          ['lookup', 'call_a', { room: 'library' }],
          ['transfer_to_butler', 'call_b'],
        ]),
      ],
      butler: [new AIMessage('done')],
      cook: [],
    });
    const def = makeHandoffDef(['butler', 'cook'], {
      lookup: {
        description: 'look up',
        parameters: { type: 'object', properties: { room: { type: 'string' } } },
      },
    });

    const result = await toLangGraph(Promise.resolve(def), { modelFactory, toolHandlers: { lookup } }).invoke('hi');

    expect(result.response).toBe('done');
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup.mock.calls[0][0]).toEqual({ room: 'library' });
    expect(models.router.invoke).toHaveBeenCalledTimes(1);
    // Both results become one user message, in the call order.
    expect(sent(models.butler).slice(2)).toEqual([
      ['ai', '[Tool call] lookup {"room":"library"}\n[Tool call] transfer_to_butler {}'],
      ['human', '[Tool result] lookup: clue\n[Tool result] transfer_to_butler: Handed off to butler.'],
    ]);
    expectNeutral(models.butler);
  });

  it('routes only the first hand-off when one message has two', async () => {
    const { modelFactory, models } = scriptedModels({
      router: [
        toolCallMsg([
          ['transfer_to_butler', 'call_1'],
          ['transfer_to_cook', 'call_2'],
        ]),
      ],
      butler: [new AIMessage('butler answer')],
      cook: [],
    });

    const result = await toLangGraph(Promise.resolve(makeHandoffDef(['butler', 'cook'])), {
      modelFactory,
      context: { kind: 'user', key: 'u' },
    }).invoke('hi');

    expect(result.response).toBe('butler answer');
    expect(models.cook.invoke).not.toHaveBeenCalled();
    expect(sent(models.butler).at(-1)).toEqual([
      'human',
      '[Tool result] transfer_to_butler: Handed off to butler.\n' +
        '[Tool result] transfer_to_cook: Ignored: only the first transfer in a turn routes.',
    ]);
    expect(handoffSuccessCount()).toBe(1);
  });

  it('a single-child node hands off once and is not run again', async () => {
    const { modelFactory, models } = scriptedModels({
      router: [toolCallMsg([['transfer_to_butler', 'call_1']])],
      butler: [new AIMessage('the butler did it')],
    });

    const result = await toLangGraph(Promise.resolve(makeHandoffDef(['butler'])), { modelFactory }).invoke('hi');

    expect(result.response).toBe('the butler did it');
    expect(models.router.invoke).toHaveBeenCalledTimes(1);
    expect(sent(models.butler).slice(2)).toEqual([
      ['ai', '[Tool call] transfer_to_butler {}'],
      ['human', '[Tool result] transfer_to_butler: Handed off to butler.'],
    ]);
    expectNeutral(models.butler);
  });

  it("keeps a node's own tool loop native", async () => {
    // Only the history from before a node was entered is rewritten: its own tool call and
    // result reach its next model call unchanged.
    const { modelFactory, models } = scriptedModels({
      router: [toolCallMsg([['lookup', 'call_x']], [REASONING]), new AIMessage('answer')],
    });
    const def = makeHandoffDef([], {
      lookup: { description: 'look up', parameters: { type: 'object', properties: {} } },
    });

    const result = await toLangGraph(Promise.resolve(def), {
      modelFactory,
      toolHandlers: { lookup: vi.fn().mockResolvedValue('clue') },
    }).invoke('hi');

    expect(result.response).toBe('answer');
    const second = models.router.invoke.mock.calls[1][0] as BaseMessage[];
    expect(second.map((m) => m.getType())).toEqual(['system', 'human', 'ai', 'tool']);
    expect((second[2] as AIMessage).tool_calls?.[0].id).toBe('call_x');
    expect(second[2].content).toEqual([REASONING]);
    expect((second[3] as ToolMessage).tool_call_id).toBe('call_x');
  });
});

describe('toNeutralHistory', () => {
  // The rewrite rules in spec §2.x.3, on one input that hits each of them. The Python test
  // uses the same input and expects the same output.
  it('rewrites every case', () => {
    const image = [
      { type: 'text', text: 'look' },
      { type: 'image_url', image_url: { url: 'data:x' } },
    ];
    const history = [
      new SystemMessage('sys'),
      new HumanMessage({ content: image }),
      new AIMessage({
        content: [
          REASONING,
          { type: 'text', text: 'a' },
          { type: 'text', text: null },
          { type: 'text', text: 'b' },
        ] as any,
        tool_calls: [
          { name: 'first', args: { q: 'café', n: { x: [1, 2] } }, id: 'c1' },
          { name: 'second', args: {}, id: 'c2' },
        ],
      }),
      new ToolMessage({ content: 'orphan', tool_call_id: 'zz', name: 'lost' }),
      new ToolMessage({ content: [{ type: 'text', text: 'two' }], tool_call_id: 'c2' }),
      new ToolMessage({ content: 'one', tool_call_id: 'c1' }),
      new AIMessage({ content: [REASONING] as any }),
      new AIMessageChunk({ content: 'chunk', tool_calls: [{ name: 't', args: {}, id: 'c3' }] }),
      new ToolMessageChunk({ content: 'three', tool_call_id: 'c3' }),
    ];

    const out = toNeutralHistory(history);

    expect(out.map((m) => [m.getType(), m.content])).toEqual([
      ['system', 'sys'],
      ['human', image],
      ['ai', 'ab\n[Tool call] first {"q":"café","n":{"x":[1,2]}}\n[Tool call] second {}'],
      ['human', '[Tool result] first: one\n[Tool result] second: two\n[Tool result] lost: orphan'],
      ['ai', 'chunk\n[Tool call] t {}'],
      ['human', '[Tool result] t: three'],
    ]);
    for (const m of out) expect((m as AIMessage).tool_calls ?? []).toHaveLength(0);
  });
});
