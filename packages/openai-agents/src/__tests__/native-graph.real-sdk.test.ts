// The real `@openai/agents` package runs the graph; only the model is fake. native-graph.test.ts mocks
// the whole package, which is how the Python twin of this adapter shipped a tool builder that crashed on
// every node with a tool (AIC-3716). Kept in its own file because vi.mock applies per file.
import type { GraphDefinition, GraphNode } from '@launchdarkly/ai-server';
import {
  type Model,
  type ModelRequest,
  type ModelResponse,
  setDefaultModelProvider,
  setTracingDisabled,
  Usage,
} from '@openai/agents';
import { describe, expect, it } from 'vitest';
import { toOpenAIAgents } from '../native-graph.js';

// Not strict-mode shaped (`limit` optional, no additionalProperties), so a rewrite shows.
const schema = {
  type: 'object',
  properties: { q: { type: 'string' }, limit: { type: 'integer' } },
  required: ['q'],
};

const node: GraphNode = {
  key: 'root',
  config: {
    model: { name: 'gpt-4o' },
    provider: { name: 'OpenAI' },
    instructions: 'help',
    tools: { lookup: { name: 'lookup', type: 'function', description: 'Look up', parameters: schema } },
  },
  meta: { variationKey: 'v1', version: 1 },
  edges: [],
  isTerminal: true,
} as unknown as GraphNode;

const graphDef = {
  key: 'test-graph',
  enabled: true,
  root: node,
  getNode: (k: string) => (k === 'root' ? node : undefined),
  reverseTraverse: async (fn: (n: GraphNode, ctx: Record<string, unknown>) => Promise<void>) => fn(node, {}),
} as unknown as GraphDefinition;

// Turn 1 calls the tool; turn 2 answers with the tool's result.
class FakeModel implements Model {
  requests: ModelRequest[] = [];

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    const results = (Array.isArray(request.input) ? request.input : []).filter(
      (i) => i.type === 'function_call_result',
    );
    if (results.length === 0) {
      return {
        usage: new Usage(),
        output: [
          { type: 'function_call', callId: 'call1', name: 'lookup', arguments: '{"q":"hi"}', status: 'completed' },
        ],
      };
    }
    const last = results[results.length - 1] as { output: unknown };
    const text = typeof last.output === 'string' ? last.output : (last.output as { text: string }).text;
    return {
      usage: new Usage(),
      output: [
        {
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: `answer: ${text}` }],
        },
      ],
    };
  }

  async *getStreamedResponse(): AsyncIterable<never> {
    throw new Error('not streamed');
  }
}

describe('toOpenAIAgents on the real @openai/agents', () => {
  it('runs a node with a tool: the call reaches the handler and the run completes', async () => {
    const model = new FakeModel();
    // Module state, but vitest isolates each test file, so no other file sees it.
    setDefaultModelProvider({ getModel: () => model });
    // Never export this run's trace to OpenAI, whatever OPENAI_API_KEY is set.
    setTracingDisabled(true);
    const calls: unknown[] = [];

    const result = await toOpenAIAgents(Promise.resolve(graphDef), {
      toolHandlers: {
        lookup: (args: unknown) => {
          calls.push(args);
          return `found ${(args as { q: string }).q}`;
        },
      },
    }).invoke('q');

    expect(calls).toEqual([{ q: 'hi' }]);
    expect(result.response).toBe('answer: found hi');
    expect(model.requests[0].tools).toEqual([
      expect.objectContaining({
        type: 'function',
        name: 'lookup',
        description: 'Look up',
        parameters: schema,
        strict: false,
      }),
    ]);
  });
});
