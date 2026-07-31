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

import { AIMessage } from '@langchain/core/messages';
import { describe, expect, it, vi } from 'vitest';

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
