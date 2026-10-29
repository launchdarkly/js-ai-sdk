/**
 * Tool-call trajectory capture on the online paths: what an inline judge, a
 * deferred judge, a streaming judge and a graph node's judge are shown in
 * `message_history`. Runs the real `config()`, `graph()`, tracking and judge
 * code; only flag delivery and the LaunchDarkly client are stubbed.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockTrack, mockVariation, mockExtractVariation } = vi.hoisted(() => ({
  mockTrack: vi.fn(),
  mockVariation: vi.fn(),
  mockExtractVariation: vi.fn(),
}));

vi.mock('../lifecycle.js', () => ({
  getClient: vi.fn().mockReturnValue({ track: mockTrack, variation: mockVariation }),
  initClient: vi.fn().mockResolvedValue(undefined),
  extractVariation: mockExtractVariation,
  shutdown: vi.fn(),
  waitForTelemetry: vi.fn(),
  shutdownTelemetry: vi.fn(),
}));

import { config } from '../client.js';
import { graph } from '../graph.js';
import { FORMATTING_INSTRUCTIONS } from '../judge-scoring.js';
import { runJudge } from '../judges.js';
import { exposedToolKeys, TrajectoryRecorder } from '../trajectory.js';
import { type AiConfigRep, NativeTool, type ProviderHandler } from '../types.js';
import { createHandlerInternal } from '../utils.js';

const context = { kind: 'user' as const, key: 'user-1' };
const meta = { enabled: true, variationKey: 'v1', version: 1, mode: 'completion' as const };
const judgeMeta = { enabled: true, variationKey: 'jv1', version: 2, mode: 'judge' as const };

const tool = (name: string) => ({ name, type: 'function' as const, parameters: { type: 'object' } });

function mainConfig(overrides: Partial<AiConfigRep> = {}): AiConfigRep {
  return {
    provider: { name: 'OpenAI' },
    model: { name: 'gpt-4o' },
    messages: [{ role: 'system', content: 'You are a support agent.' }],
    tools: { lookup: tool('lookup') },
    judgeConfiguration: { judges: [{ key: 'judge', samplingRate: 1 }] },
    ...overrides,
  };
}

const judgeConfig: AiConfigRep = {
  provider: { name: 'OpenAI' },
  model: { name: 'gpt-4o' },
  messages: [{ role: 'system', content: 'Grade this.\n{{message_history}}' }],
};

function serve(configs: Record<string, AiConfigRep>) {
  mockExtractVariation.mockImplementation(async (key: string) => ({
    config: configs[key],
    meta: key.includes('judge') ? judgeMeta : meta,
  }));
}

type Call = { toolName: string; args: unknown };

/**
 * One handler for generation and judging. Generation calls each tool in
 * `calls`, then answers; a judge call (told apart by `message_history`) is
 * recorded and answers with a score.
 */
function makeHandler(calls: Call[] = [{ toolName: 'lookup', args: { id: 'A-17' } }]) {
  const histories: string[] = [];
  const fn = vi.fn(
    async (
      _config: AiConfigRep,
      input?: string,
      tools?: Record<string, unknown>,
      variables?: Record<string, unknown>,
    ) => {
      if (variables && 'message_history' in variables) {
        histories.push(variables.message_history as string);
        return { output: '{"score": 0.9, "reasoning": "fine"}' };
      }
      for (const { toolName, args } of calls) await (tools?.[toolName] as (a: unknown) => unknown)(args);
      return { output: `answer to ${input}` };
    },
  );
  const handler = createHandlerInternal(['OpenAI', 'messages'], fn as never) as ProviderHandler;
  return { handler, histories, fn };
}

const lookupBlock = [
  'Tools available: lookup',
  'Tool calls made while producing the response, in order:',
  '1. lookup',
  '   arguments: {"id":"A-17"}',
  '   result: order A-17 shipped',
].join('\n');

const history = (...parts: string[]) => [...parts, FORMATTING_INSTRUCTIONS].join('\n\n');

beforeEach(() => {
  vi.clearAllMocks();
  serve({ support: mainConfig(), judge: judgeConfig });
});

describe('inline judges (config().invoke)', () => {
  it('see the tool calls between the input and the output', async () => {
    const { handler, histories } = makeHandler();
    await config({ key: 'support', handler, toolHandlers: { lookup: () => 'order A-17 shipped' } }).invoke(
      'Where is A-17?',
      context,
    );
    expect(histories).toEqual([history('Where is A-17?', lookupBlock, 'answer to Where is A-17?')]);
  });

  it('still fire $ld:ai:tool_call underneath the recorder', async () => {
    const { handler } = makeHandler();
    await config({ key: 'support', handler, toolHandlers: { lookup: () => 'order A-17 shipped' } }).invoke(
      'q',
      context,
    );
    expect(mockTrack).toHaveBeenCalledWith(
      '$ld:ai:tool_call',
      context,
      expect.objectContaining({ toolKey: 'lookup' }),
      1,
    );
  });

  it('see only the tools the config offered, not the rest of a wider map', async () => {
    const { handler, histories, fn } = makeHandler();
    await config({
      key: 'support',
      handler,
      toolHandlers: { lookup: () => 'order A-17 shipped', extra: () => 'registry-only' },
    }).invoke('Where is A-17?', context);
    expect(Object.keys(fn.mock.calls[0][2] ?? {})).toEqual(['lookup']);
    expect(histories[0]).toContain(lookupBlock);
    expect(histories[0]).not.toContain('extra');
  });

  it('list a declared tool with no implementation as available', async () => {
    serve({
      support: mainConfig({ tools: { lookup: tool('lookup'), escalate: tool('escalate') } }),
      judge: judgeConfig,
    });
    const { handler, histories } = makeHandler([]);
    await config({ key: 'support', handler, toolHandlers: { lookup: () => 'x' } }).invoke('q', context);
    expect(histories[0]).toContain(
      'Tools available: lookup, escalate\nNo tool calls were made while producing the response.',
    );
  });

  it('leave a native tool out, while its $ld:ai:tool_call still fires', async () => {
    serve({ support: mainConfig({ tools: { lookup: tool('lookup'), search: tool('search') } }), judge: judgeConfig });
    const { handler, histories } = makeHandler([
      { toolName: 'search', args: undefined },
      { toolName: 'lookup', args: { id: 'A-17' } },
    ]);
    await config({
      key: 'support',
      handler,
      toolHandlers: { lookup: () => 'order A-17 shipped', search: new NativeTool(Symbol('s'), 'WebSearch') },
    }).invoke('Where is A-17?', context);
    expect(histories[0]).toContain(lookupBlock);
    expect(histories[0]).not.toContain('search');
    expect(mockTrack).toHaveBeenCalledWith(
      '$ld:ai:tool_call',
      context,
      expect.objectContaining({ toolKey: 'search' }),
      1,
    );
  });

  it('see an unchanged history when the config has no tools', async () => {
    serve({ support: mainConfig({ tools: undefined }), judge: judgeConfig });
    const { handler, histories } = makeHandler([]);
    await config({ key: 'support', handler, toolHandlers: { lookup: () => 'x' } }).invoke('Where is A-17?', context);
    expect(histories).toEqual([history('Where is A-17?', 'answer to Where is A-17?')]);
  });

  it('keep each concurrent invocation to its own calls', async () => {
    const { handler, histories } = makeHandler([{ toolName: 'lookup', args: { id: 'mine' } }]);
    const lookup = async (args: unknown) => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return `result for ${(args as { id: string }).id}`;
    };
    const caller = config({ key: 'support', handler, toolHandlers: { lookup } });
    await Promise.all([caller.invoke('first', context), caller.invoke('second', context)]);
    for (const text of histories) expect(text.match(/1\. lookup/g)).toHaveLength(1);
  });
});

describe('deferred judges (skipJudges + runJudge)', () => {
  it('carry the input and the rendered trajectory on a task that survives structured clone', async () => {
    const { handler } = makeHandler();
    const { judgeTasks } = await config({
      key: 'support',
      handler,
      toolHandlers: { lookup: () => 'order A-17 shipped' },
      skipJudges: true,
    }).invoke('Where is A-17?', context);
    expect(judgeTasks).toHaveLength(1);
    const task = structuredClone(judgeTasks?.[0]);
    expect(task?.userInput).toBe('Where is A-17?');
    expect(task?.trajectory).toBe(lookupBlock);
  });

  it('show a judge the byte-identical history the inline path shows', async () => {
    const inline = makeHandler();
    await config({
      key: 'support',
      handler: inline.handler,
      toolHandlers: { lookup: () => 'order A-17 shipped' },
    }).invoke('Where is A-17?', context);

    const deferred = makeHandler();
    const { judgeTasks } = await config({
      key: 'support',
      handler: deferred.handler,
      toolHandlers: { lookup: () => 'order A-17 shipped' },
      skipJudges: true,
    }).invoke('Where is A-17?', context);
    const result = await runJudge(structuredClone(judgeTasks?.[0]) as never, [deferred.handler]);
    expect(result?.score).toBe(0.9);
    expect(deferred.histories).toEqual(inline.histories);
  });
});

describe('streaming judges (config().stream)', () => {
  it('see the tool calls too', async () => {
    const { handler, histories } = makeHandler();
    for await (const _event of config({
      key: 'support',
      handler,
      toolHandlers: { lookup: () => 'order A-17 shipped' },
    }).stream('Where is A-17?', context)) {
      // drain
    }
    expect(histories).toEqual([history('Where is A-17?', lookupBlock, 'answer to Where is A-17?')]);
  });
});

describe('graph judges', () => {
  it("show a node's judge that node's calls, and a graph-level judge none", async () => {
    serve({ 'root-node': mainConfig(), judge: judgeConfig, 'graph-judge': judgeConfig });
    mockVariation.mockResolvedValue({ root: 'root-node', edges: {} });
    const { handler, histories } = makeHandler();
    await graph('support-graph', {
      handlers: [handler],
      toolHandlers: { lookup: () => 'order A-17 shipped' },
      graphJudge: 'graph-judge',
    }).invoke('Where is A-17?', context);
    expect(histories).toHaveLength(2);
    const [nodeJudge, graphJudge] = histories;
    expect(nodeJudge).toContain(lookupBlock);
    expect(graphJudge).not.toContain('Tool calls');
    expect(graphJudge).not.toContain('Tools available');
  });
});

describe('exposedToolKeys', () => {
  it('lists the config tools, without handoff or native tools', () => {
    const native = new NativeTool(Symbol('s'), 'WebSearch');
    const keys = exposedToolKeys(
      { tools: { lookup: {}, search: {}, __handoff_billing: {}, escalate: {} } },
      { lookup: () => 1, search: native },
    );
    expect(keys).toEqual(['lookup', 'escalate']);
  });

  it('keeps a handoff tool callable while leaving it unrecorded', () => {
    const recorder = new TrajectoryRecorder();
    const tools = recorder.wrap({ lookup: () => 1, __handoff_billing: () => 'routed' }, ['lookup']);
    expect((tools.__handoff_billing as () => string)()).toBe('routed');
    expect(recorder.calls).toEqual([]);
    expect(recorder.available).toEqual(['lookup']);
  });
});
