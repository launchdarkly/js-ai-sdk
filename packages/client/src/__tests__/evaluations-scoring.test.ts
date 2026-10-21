/**
 * Evaluations from Code: the evaluation phase. Criteria pinning, judge
 * resolution and selection, judge and scorer invocation, criterion events,
 * and phase sequencing. Judge resolution is stubbed at its seam
 * (`extractVariation`); judges and generation run on stub handlers.
 */

import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EvalTool, Judge, type RunOptions, Scorer } from '../experimental.js';
import { buildMessageHistory, FORMATTING_INSTRUCTIONS } from '../judge-scoring.js';
import { FORMATTING_INSTRUCTIONS as ONLINE_FORMATTING_INSTRUCTIONS } from '../judges.js';
import { parseTemplate } from '../utils.js';
import {
  completion,
  DATASET,
  datasetRow,
  EVALUATION_PATH,
  FakeApi,
  judgeReply,
  makeModule,
  PROJECT,
  RUN_PATH,
  routeHostedRun,
  routeInlineRun,
  type StubClient,
  SUMMARY_PATH,
  servedJudge,
  stubClient,
  stubHandler,
} from './evaluations-fakes.js';

const lifecycle = vi.hoisted(() => ({ client: undefined as unknown, init: vi.fn(), resolve: vi.fn() }));

vi.mock('../lifecycle.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lifecycle.js')>()),
  getClient: () => {
    if (!lifecycle.client) throw new Error('LaunchDarkly client not initialized.');
    return lifecycle.client;
  },
  initClient: (...args: unknown[]) => lifecycle.init(...args),
  extractVariation: (...args: unknown[]) => lifecycle.resolve(...args),
}));

let client: StubClient;
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  client = stubClient();
  lifecycle.client = client;
  lifecycle.init.mockReset();
  lifecycle.resolve.mockReset();
  lifecycle.resolve.mockImplementation(async () => servedJudge());
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
});

const CRITERION = '$ld:ai:offline-evals:criterion';
const GENERATION = '$ld:ai:offline-evals:generation';

const criterionEvents = () => client.tracked.filter((t) => t.name === CRITERION);

/** A generation stub that also answers as a judge, told apart by the judge-only variable. */
function dualHandler(provider = 'OpenAI', mode: 'agent' | 'messages' = 'messages', judge = judgeReply) {
  return stubHandler(provider, mode, async (_config, input, _tools, variables) =>
    variables && 'response_to_evaluate' in variables ? judge() : { output: `out:${input}` },
  );
}

const isJudgeCall = (call: unknown[]) => 'response_to_evaluate' in ((call[3] as Record<string, unknown>) ?? {});
const judgeCalls = (handler: ReturnType<typeof stubHandler>) => handler.mock.calls.filter(isJudgeCall);
const generationCalls = (handler: ReturnType<typeof stubHandler>) => handler.mock.calls.filter((c) => !isJudgeCall(c));

const run = (overrides: Record<string, unknown> = {}) =>
  ({
    key: 'eval-key',
    dataset: DATASET,
    handler: dualHandler(),
    generation: completion(),
    criteria: [new Judge('accuracy')],
    pollIntervalSeconds: 0,
    pollTimeoutSeconds: 5,
    ...overrides,
  }) as RunOptions;

const createBody = (api: FakeApi) =>
  api.calls.find((call) => call.path === EVALUATION_PATH)?.body as Record<string, unknown>;

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

// ---------------------------------------------------------------------------
// §8.8.2 Pinning
// ---------------------------------------------------------------------------

describe('criteria on the create body', () => {
  it('pins a judge left on its defaults, with both thresholds and no success direction', async () => {
    const api = routeHostedRun(new FakeApi());
    await makeModule(api).run(run());
    expect(createBody(api).criteria).toEqual([
      {
        criterionType: 'accuracy',
        kind: 'judge',
        judgeKey: 'accuracy',
        options: { threshold: 0.5, passRateThreshold: 0.95 },
      },
    ]);
  });

  it('pins a lower_is_better scorer with an explicit threshold, and a judge with ground truth, in order', async () => {
    const api = routeHostedRun(new FakeApi());
    await makeModule(api).run(
      run({
        criteria: [
          new Scorer('typos', () => 0, { threshold: 0.2, successDirection: 'lower_is_better' }),
          new Judge('accuracy', { groundTruthContext: 'The policy is {{policy}}' }),
        ],
      }),
    );
    expect(createBody(api).criteria).toEqual([
      {
        criterionType: 'typos',
        kind: 'scorer',
        successDirection: 'lower_is_better',
        options: { threshold: 0.2, passRateThreshold: 0.95 },
      },
      {
        criterionType: 'accuracy',
        kind: 'judge',
        judgeKey: 'accuracy',
        options: { threshold: 0.5, passRateThreshold: 0.95, groundTruthContext: 'The policy is {{policy}}' },
      },
    ]);
  });

  it('omits criteria from the body when the run has none', async () => {
    const api = routeHostedRun(new FakeApi());
    await makeModule(api).run(run({ criteria: [] }));
    expect('criteria' in createBody(api)).toBe(false);
    expect(criterionEvents()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// §8.8.2 Resolution
// ---------------------------------------------------------------------------

describe('judge resolution', () => {
  it('resolves with an evaluation context keyed on the project, once per run', async () => {
    const api = routeHostedRun(new FakeApi(), [datasetRow(0), datasetRow(1), datasetRow(2)]);
    await makeModule(api).run(run());
    expect(lifecycle.resolve).toHaveBeenCalledOnce();
    expect(lifecycle.resolve).toHaveBeenCalledWith('accuracy', { kind: 'evaluation', key: PROJECT });
  });

  it.each([
    ['an unknown judge', new Error('Invalid AI config for "accuracy": missing provider')],
    ['a disabled judge', new Error('Variation accuracy is not enabled')],
  ])('fails fast for %s, naming the key and the cause, before any request', async (_name, cause) => {
    lifecycle.resolve.mockRejectedValue(cause);
    const api = routeHostedRun(new FakeApi());
    const handler = dualHandler();
    const err = await makeModule(api)
      .run(run({ handler }))
      .catch((e: Error) => e);
    expect(err.message).toMatch(/judge 'accuracy'/);
    expect(err.message).toMatch(/create it/);
    expect((err as Error & { cause?: unknown }).cause).toBe(cause);
    expect(api.calls).toEqual([]);
    expect(handler).not.toHaveBeenCalled();
  });

  it('fails when the served config is not an object', async () => {
    lifecycle.resolve.mockResolvedValue({ config: 'nope', meta: {} });
    const api = routeHostedRun(new FakeApi());
    await expect(makeModule(api).run(run())).rejects.toThrow(/'accuracy' returned an invalid AI config/);
    expect(api.calls).toEqual([]);
  });

  it('runs after the AI Config reads and before the dataset request', async () => {
    const log: string[] = [];
    const api = routeHostedRun(new FakeApi(log));
    lifecycle.resolve.mockImplementation(async () => {
      log.push('resolve');
      return servedJudge();
    });
    await makeModule(api).run(run());
    expect(log.indexOf('resolve')).toBeLessThan(log.indexOf(`GET projects/${PROJECT}/datasets/${DATASET}`));
  });

  it('carries the variation key and version onto judge events, or "" and nothing when absent', async () => {
    await makeModule(routeHostedRun(new FakeApi())).run(run());
    expect(criterionEvents()[0].data).toMatchObject({ judgeKey: 'accuracy', variationKey: 'judge-v1', version: 7 });

    client.tracked.length = 0;
    lifecycle.resolve.mockResolvedValue(servedJudge({}, { variationKey: undefined, version: undefined }));
    await makeModule(routeHostedRun(new FakeApi())).run(run());
    const { data } = criterionEvents()[0];
    expect(data.variationKey).toBe('');
    expect('version' in data).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// §8.8.3 Judge handler selection
// ---------------------------------------------------------------------------

describe('judge handler selection', () => {
  it('runs a judge on another provider than generation', async () => {
    lifecycle.resolve.mockResolvedValue(servedJudge({ provider: { name: 'Anthropic' } }));
    const openai = stubHandler('OpenAI');
    const anthropic = stubHandler('Anthropic', 'messages', async () => judgeReply());
    await makeModule(routeHostedRun(new FakeApi(), [datasetRow(0), datasetRow(1)])).run(
      run({ handler: undefined, handlers: [openai, anthropic] }),
    );
    expect(openai).toHaveBeenCalledTimes(2);
    expect(anthropic).toHaveBeenCalledTimes(2);
    expect(judgeCalls(openai)).toEqual([]);
  });

  it('runs a judge in another mode than generation', async () => {
    const agent = stubHandler('OpenAI', 'agent');
    const messages = stubHandler('OpenAI', 'messages', async () => judgeReply());
    await makeModule(routeHostedRun(new FakeApi())).run(
      run({
        handler: undefined,
        handlers: [agent, messages],
        generation: completion({ mode: 'agent', messages: undefined }),
      }),
    );
    expect(agent).toHaveBeenCalledOnce();
    expect(judgeCalls(agent)).toEqual([]);
    expect(messages).toHaveBeenCalledOnce();
    expect(judgeCalls(messages)).toHaveLength(1);
  });

  it('never falls back to an agent handler for a messages judge', async () => {
    const agent = dualHandler('OpenAI', 'agent');
    const api = routeHostedRun(new FakeApi());
    await expect(
      makeModule(api).run(run({ handler: agent, generation: completion({ mode: 'agent', messages: undefined }) })),
    ).rejects.toThrow(/judge 'accuracy' \(provider 'OpenAI', mode 'messages'\) has no handler/);
    expect(api.calls).toEqual([]);
    expect(agent).not.toHaveBeenCalled();
  });

  it('uses one handler for both phases', async () => {
    const handler = dualHandler();
    await makeModule(routeHostedRun(new FakeApi())).run(run({ handler }));
    expect(generationCalls(handler)).toHaveLength(1);
    expect(judgeCalls(handler)).toHaveLength(1);
  });

  it('reports every judge without a handler and every prompt mismatch in one error, listing the pool', async () => {
    lifecycle.resolve.mockImplementation(async (key: string) => {
      if (key === 'a') return servedJudge({ provider: { name: 'Anthropic' } });
      if (key === 'b') return servedJudge({ provider: { name: 'Gemini' } });
      return servedJudge({ messages: undefined, instructions: 'Rate it' });
    });
    const api = routeHostedRun(new FakeApi());
    const err = await makeModule(api)
      .run(run({ criteria: [new Judge('a'), new Judge('b'), new Judge('c')] }))
      .catch((e: Error) => e);
    expect(err.message).toMatch(/judge 'a' \(provider 'Anthropic', mode 'messages'\) has no handler/);
    expect(err.message).toMatch(/judge 'b' \(provider 'Gemini', mode 'messages'\) has no handler/);
    expect(err.message).toMatch(/judge 'c' needs messages, not instructions/);
    expect(err.message).toContain('[OpenAI, messages]');
    expect(api.calls).toEqual([]);
  });

  it('rejects a judge with messages on an agent handler', async () => {
    lifecycle.resolve.mockResolvedValue(servedJudge({}, { mode: 'agent' }));
    const agent = stubHandler('OpenAI', 'agent');
    const api = routeHostedRun(new FakeApi());
    await expect(makeModule(api).run(run({ handler: undefined, handlers: [dualHandler(), agent] }))).rejects.toThrow(
      /judge 'accuracy' needs instructions, not messages/,
    );
    expect(api.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// §8.8.3 Judge invocation
// ---------------------------------------------------------------------------

describe('judge invocation', () => {
  it('passes the unrendered config without tools, the output as input, and no tool handlers', async () => {
    lifecycle.resolve.mockResolvedValue(
      servedJudge({ tools: { search: { name: 'search', type: 'function', parameters: {} } } }),
    );
    const handler = dualHandler();
    const api = routeHostedRun(new FakeApi()).on('GET', `projects/${PROJECT}/ai-tools/lookup`, {
      body: { version: 1 },
    });
    const evals = makeModule(api);
    const library = await evals.tools.get('lookup', { implementation: () => 1 });
    await evals.run(run({ handler, tools: [library, new EvalTool('notes', () => 2, {})] }));
    const [generation] = generationCalls(handler);
    expect(Object.keys(generation[2] ?? {})).toEqual(['lookup', 'notes']);
    const [config, input, tools] = judgeCalls(handler)[0];
    expect(input).toBe('out:question 0');
    expect(tools).toEqual({});
    expect('tools' in config).toBe(false);
    expect(config.messages).toEqual([
      { role: 'system', content: 'Rate {{response_to_evaluate}} against {{expected_output}}.' },
    ]);
  });

  it('leaves placeholders in generated output literal after the handler renders the rubric', async () => {
    let rendered = '';
    const handler = stubHandler('OpenAI', 'messages', async (config, _input, _tools, variables) => {
      if (!variables || !('response_to_evaluate' in variables)) return { output: 'see {{expected_output}}' };
      rendered = parseTemplate(config.messages?.[0].content as string, variables);
      return judgeReply();
    });
    await makeModule(routeHostedRun(new FakeApi())).run(run({ handler }));
    expect(rendered).toBe('Rate see {{expected_output}} against answer 0.');
  });

  it('gives the judge the row variables plus the closed set of judge keys', async () => {
    const handler = dualHandler();
    const row = datasetRow(0, {
      input: 'Where is {{order}}?',
      expectedOutput: 'Shipped {{order}}',
      variables: { order: 'A-17', tier: 'gold' },
    });
    await makeModule(routeHostedRun(new FakeApi(), [row])).run(run({ handler }));
    const variables = judgeCalls(handler)[0][3] as Record<string, unknown>;
    expect(Object.keys(variables).sort()).toEqual(
      [
        'order',
        'tier',
        'input',
        'expected_output',
        'response_to_evaluate',
        'ground_truth_context',
        'message_history',
        'formatting_instructions',
      ].sort(),
    );
    expect(variables).toMatchObject({
      order: 'A-17',
      tier: 'gold',
      input: 'Where is A-17?',
      response_to_evaluate: 'out:Where is A-17?',
      expected_output: 'Shipped A-17',
      ground_truth_context: 'Shipped A-17',
      formatting_instructions: FORMATTING_INSTRUCTIONS,
    });
  });

  it('uses empty strings, never null, for absent values', async () => {
    const handler = dualHandler();
    await makeModule(routeHostedRun(new FakeApi(), [datasetRow(0, { expectedOutput: undefined })])).run(
      run({ handler }),
    );
    const variables = judgeCalls(handler)[0][3] as Record<string, unknown>;
    expect(variables.expected_output).toBe('');
    expect(variables.ground_truth_context).toBe('');
  });

  it('renders the criterion ground truth against the row variables', async () => {
    const handler = dualHandler();
    const row = datasetRow(0, { variables: { policy: '30 days' } });
    await makeModule(routeHostedRun(new FakeApi(), [row])).run(
      run({ handler, criteria: [new Judge('accuracy', { groundTruthContext: 'Refunds within {{policy}}' })] }),
    );
    expect((judgeCalls(handler)[0][3] as Record<string, unknown>).ground_truth_context).toBe('Refunds within 30 days');
  });

  it('builds message_history as input, output and instructions when the row had no tools', async () => {
    const handler = dualHandler();
    await makeModule(routeHostedRun(new FakeApi())).run(run({ handler }));
    const history = (judgeCalls(handler)[0][3] as Record<string, unknown>).message_history;
    // Byte-identical to what the online judge path builds for the same input and output.
    expect(history).toBe(['question 0', 'out:question 0', FORMATTING_INSTRUCTIONS].join('\n\n'));
    expect(history).toBe(buildMessageHistory({ userInput: 'question 0', output: 'out:question 0' }));
  });

  it('places the trajectory between input and output, with a tool result kept literal', async () => {
    const handler = stubHandler('OpenAI', 'messages', async (_config, input, tools, variables) => {
      if (variables && 'response_to_evaluate' in variables) return judgeReply();
      (tools?.lookup as (args: unknown) => unknown)({ id: 'A-17' });
      return { output: `answer to ${input}` };
    });
    await makeModule(routeHostedRun(new FakeApi())).run(
      run({ handler, tools: [new EvalTool('lookup', () => '{{expected_output}}', {})] }),
    );
    const history = (judgeCalls(handler)[0][3] as Record<string, unknown>).message_history as string;
    const parts = history.split('\n\n');
    expect(parts[0]).toBe('question 0');
    expect(parts[1]).toBe(
      [
        'Tools available: lookup',
        'Tool calls made while producing the response, in order:',
        '1. lookup',
        '   arguments: {"id":"A-17"}',
        '   result: {{expected_output}}',
      ].join('\n'),
    );
    expect(parts[2]).toBe('answer to question 0');
    expect(parts.slice(3).join('\n\n')).toBe(FORMATTING_INSTRUCTIONS);
    expect(Object.keys(judgeCalls(handler)[0][3] as object)).not.toContain('trajectory');
  });

  it('shares the instruction text with the online judge path', () => {
    expect(FORMATTING_INSTRUCTIONS).toBe(ONLINE_FORMATTING_INSTRUCTIONS);
  });

  it('accepts fenced JSON and a reason alias', async () => {
    const handler = dualHandler('OpenAI', 'messages', () => ({
      output: '```json\n{"score": 0.6, "reason": "Close enough."}\n```',
    }));
    await makeModule(routeHostedRun(new FakeApi())).run(run({ handler }));
    expect(criterionEvents()[0].data).toMatchObject({ status: 'COMPLETE', score: 0.6, reason: 'Close enough.' });
  });

  it.each([
    ['prose', () => ({ output: 'the answer looks right to me' }), /^Invalid JSON from judge$/],
    ['an empty object', () => ({ output: '{}' }), /^Invalid JSON from judge$/],
    ['a non-object handler result', () => 'just text', /^judge handler result must be a mapping$/],
    ['no reasoning', () => ({ output: '{"score": 0.9}' }), /no reasoning/],
    ['empty reasoning', () => judgeReply(0.9, ''), /no reasoning/],
    [
      'a string score',
      () => judgeReply('high (0.9)'),
      /^judge score must be a number between 0 and 1, got 'high \(0.9\)'$/,
    ],
    ['a score of 3', () => judgeReply(3), /got 3$/],
    ['a NaN score', () => ({ output: { score: Number.NaN, reasoning: 'x' } }), /got nan$/],
    ['a boolean score', () => judgeReply(true), /got True$/],
  ])('records %s as an ERROR result with no score, and the run still completes', async (_name, reply, message) => {
    const handler = dualHandler('OpenAI', 'messages', reply as () => ReturnType<typeof judgeReply>);
    const api = routeHostedRun(new FakeApi());
    await makeModule(api).run(run({ handler }));
    const { data } = criterionEvents()[0];
    expect(data.status).toBe('ERROR');
    expect(data.errorMessage).toMatch(message);
    expect('score' in data).toBe(false);
    expect('reason' in data).toBe(false);
    expect(client.flush).toHaveBeenCalled();
    expect(api.sequence).toContain(`GET ${SUMMARY_PATH}`);
  });

  it('records a throwing judge handler as an ERROR result, called once', async () => {
    const handler = stubHandler('OpenAI', 'messages', async (_config, _input, _tools, variables) => {
      if (variables && 'response_to_evaluate' in variables) throw new Error('judge model down');
      return { output: 'x' };
    });
    await makeModule(routeHostedRun(new FakeApi())).run(run({ handler }));
    expect(criterionEvents()[0].data).toMatchObject({
      status: 'ERROR',
      errorMessage: 'judge handler raised: judge model down',
    });
    expect(judgeCalls(handler)).toHaveLength(1);
  });

  it('nests judge usage, and leaves it out when none was reported', async () => {
    await makeModule(routeHostedRun(new FakeApi())).run(run());
    expect(criterionEvents()[0].data.usage).toEqual({ inputTokens: 3, outputTokens: 4 });

    client.tracked.length = 0;
    const handler = dualHandler(
      'OpenAI',
      'messages',
      () => ({ output: JSON.stringify({ score: 1, reasoning: 'ok' }) }) as never,
    );
    await makeModule(routeHostedRun(new FakeApi())).run(run({ handler }));
    expect('usage' in criterionEvents()[0].data).toBe(false);
  });

  it('never retries a judge', async () => {
    const handler = dualHandler('OpenAI', 'messages', () => ({ output: 'garbage' }) as never);
    await makeModule(routeHostedRun(new FakeApi(), [datasetRow(0), datasetRow(1)])).run(run({ handler }));
    expect(judgeCalls(handler)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// §8.8.4 Scorers
// ---------------------------------------------------------------------------

describe('scorers', () => {
  it('receives the public row and the generated output, and makes no model call', async () => {
    const fn = vi.fn(() => 1);
    const handler = dualHandler();
    const row = datasetRow(0, { variables: { order: 'A-17' }, metadata: { tag: 'x' } });
    await makeModule(routeHostedRun(new FakeApi(), [row])).run(run({ handler, criteria: [new Scorer('exact', fn)] }));
    expect(fn).toHaveBeenCalledWith(
      {
        rowIndex: 0,
        input: 'question 0',
        expectedOutput: 'answer 0',
        variables: { order: 'A-17', input: 'question 0', expected_output: 'answer 0' },
        metadata: { tag: 'x' },
      },
      'out:question 0',
    );
    expect(handler).toHaveBeenCalledOnce();
  });

  it('awaits an async scorer and uses a sync one as is', async () => {
    await makeModule(routeHostedRun(new FakeApi())).run(
      run({ criteria: [new Scorer('sync', () => 0.25), new Scorer('async', async () => 0.75)] }),
    );
    const scores = Object.fromEntries(criterionEvents().map((e) => [e.data.criterionType, e.data.score]));
    expect(scores).toEqual({ sync: 0.25, async: 0.75 });
  });

  it.each([
    ['a boolean', () => true, /^scorer fn must return a finite number, got True$/],
    ['NaN', () => Number.NaN, /^scorer fn must return a finite number, got nan$/],
    ['an out-of-range number', () => 1.5, /^scorer fn score must be between 0 and 1, got 1.5$/],
    ['a string', () => '0.5', /^scorer fn must return a finite number, got '0.5'$/],
  ])('records %s as an invalid score naming the value', async (_name, fn, message) => {
    await makeModule(routeHostedRun(new FakeApi())).run(run({ criteria: [new Scorer('exact', fn as never)] }));
    const { data } = criterionEvents()[0];
    expect(data.status).toBe('ERROR');
    expect(data.errorMessage).toMatch(message);
    expect('score' in data).toBe(false);
  });

  it.each([
    [
      'throws',
      () => {
        throw new Error('regex blew up');
      },
    ],
    [
      'rejects',
      async () => {
        throw new Error('regex blew up');
      },
    ],
  ])('records a scorer that %s as an ERROR result', async (_name, fn) => {
    await makeModule(routeHostedRun(new FakeApi())).run(run({ criteria: [new Scorer('exact', fn)] }));
    expect(criterionEvents()[0].data).toMatchObject({
      status: 'ERROR',
      errorMessage: 'scorer fn raised: regex blew up',
    });
  });

  it('carries no reason, usage or judge fields', async () => {
    await makeModule(routeHostedRun(new FakeApi())).run(run({ criteria: [new Scorer('exact', () => 1)] }));
    const { data } = criterionEvents()[0];
    expect(data).toMatchObject({ kind: 'scorer', status: 'COMPLETE', score: 1 });
    for (const field of ['reason', 'usage', 'judgeKey', 'variationKey', 'version'])
      expect(field in data, field).toBe(false);
  });

  describe.each([1, 10])('with concurrency %d', (concurrency) => {
    it('cannot change the output that other criteria on the row see', async () => {
      const seen: unknown[] = [];
      let judged = '';
      const handler = stubHandler('OpenAI', 'messages', async (_config, _input, _tools, variables) => {
        if (variables && 'response_to_evaluate' in variables) {
          judged = variables.response_to_evaluate as string;
          return judgeReply();
        }
        return { output: { answer: 'original', tags: ['a'] } };
      });
      const mutate = new Scorer('mutate', (_row, output) => {
        const value = output as { answer: string; tags: string[] };
        value.answer = 'changed';
        value.tags.push('b');
        return 1;
      });
      const read = new Scorer('read', async (_row, output) => {
        await new Promise((resolve) => setTimeout(resolve, 2));
        seen.push(structuredClone(output));
        return 1;
      });
      await makeModule(routeHostedRun(new FakeApi())).run(
        run({ handler, concurrency, criteria: [mutate, read, new Judge('accuracy')] }),
      );
      expect(seen).toEqual([{ answer: 'original', tags: ['a'] }]);
      expect(judged).toBe("{'answer': 'original', 'tags': ['a']}");
      expect(criterionEvents().every((event) => event.data.status === 'COMPLETE')).toBe(true);
    });
  });

  it('still scores an output it cannot copy', async () => {
    const output = { answer: 'x', format: () => 'x' };
    const handler = stubHandler('OpenAI', 'messages', async () => ({ output }));
    const fn = vi.fn(() => 1);
    await makeModule(routeHostedRun(new FakeApi())).run(run({ handler, criteria: [new Scorer('exact', fn)] }));
    expect(fn).toHaveBeenCalledWith(expect.anything(), output);
    expect(criterionEvents()[0].data).toMatchObject({ status: 'COMPLETE', score: 1 });
  });

  it('cannot change the row that later criteria see', async () => {
    const seen: unknown[] = [];
    const mutate = new Scorer('mutate', (row) => {
      row.variables.order = 'changed';
      return 1;
    });
    const read = new Scorer('read', (row) => {
      seen.push(row.variables.order);
      return 1;
    });
    await makeModule(routeHostedRun(new FakeApi(), [datasetRow(0, { variables: { order: 'A-17' } })])).run(
      run({ criteria: [mutate, read], concurrency: 1 }),
    );
    expect(seen).toEqual(['A-17']);
  });
});

// ---------------------------------------------------------------------------
// §8.8.5 Criterion events
// ---------------------------------------------------------------------------

describe('criterion events', () => {
  it('carry the identity, criterionType, kind and result fields, and nothing else they must not', async () => {
    await makeModule(routeHostedRun(new FakeApi(), [datasetRow(0, { variables: { v: 1 }, metadata: { m: 1 } })])).run(
      run(),
    );
    const [event] = criterionEvents();
    expect(event.metric).toBe(1);
    expect(event.context).toEqual({ kind: 'evaluation', key: 'run-1', projectKey: PROJECT, evaluationId: 'ev-1' });
    const identity = {
      criterionType: 'accuracy',
      datasetId: 'ds-id',
      evaluationId: 'ev-1',
      evaluationRunId: 'run-1',
      projectKey: PROJECT,
      rowIndex: 0,
      runId: 'run-1',
    };
    expect(event.data).toMatchObject({
      ...identity,
      kind: 'judge',
      eventId: sha256(JSON.stringify(identity)),
      evaluationKey: 'eval-key',
      evaluationVersion: 3,
      datasetKey: DATASET,
      status: 'COMPLETE',
      score: 0.8,
      reason: 'Looks right.',
    });
    for (const field of ['emittedAt', 'startedAt', 'evaluatedAt']) {
      expect(event.data[field]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    }
    expect(Date.parse(event.data.evaluatedAt as string)).toBeGreaterThanOrEqual(
      Date.parse(event.data.startedAt as string),
    );
    expect(Number.isInteger(event.data.latencyMs)).toBe(true);
    for (const field of [
      'verdict',
      'passed',
      'successDirection',
      'input',
      'output',
      'expectedOutput',
      'metadata',
      'variables',
      'inputTokens',
      'outputTokens',
      'error',
      'errorCode',
      'trajectory',
      'contentHash',
    ]) {
      expect(field in event.data, field).toBe(false);
    }
    for (const value of Object.values(event.data)) expect(value).not.toBeNull();
  });

  it('give two criteria on one row different eventIds, stable across runs', async () => {
    const criteria = [new Judge('accuracy'), new Scorer('exact', () => 1)];
    await makeModule(routeHostedRun(new FakeApi())).run(run({ criteria }));
    const first = criterionEvents().map((e) => e.data.eventId);
    client.tracked.length = 0;
    await makeModule(routeHostedRun(new FakeApi())).run(run({ criteria }));
    expect(first[0]).not.toBe(first[1]);
    expect(criterionEvents().map((e) => e.data.eventId)).toEqual(first);
  });

  it('omit datasetId and datasetKey on an inline run', async () => {
    await makeModule(routeInlineRun(new FakeApi(), 1)).run(run({ dataset: [{ input: 'a' }] }));
    const { data } = criterionEvents()[0];
    expect('datasetId' in data).toBe(false);
    expect('datasetKey' in data).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// §8.8.6 Sequencing, concurrency and isolation
// ---------------------------------------------------------------------------

describe('phase sequencing', () => {
  it('queues every generation event before the first judge call, then flushes at the boundary and at the end', async () => {
    const log: string[] = [];
    client = stubClient(log);
    lifecycle.client = client;
    const handler = stubHandler('OpenAI', 'messages', async (_config, input, _tools, variables) => {
      if (variables && 'response_to_evaluate' in variables) {
        log.push('judge');
        return judgeReply();
      }
      log.push('generate');
      return { output: `out:${input}` };
    });
    const api = routeHostedRun(new FakeApi(log), [datasetRow(0), datasetRow(1)]);
    await makeModule(api).run(run({ handler }));
    const events = log.filter((entry) => !entry.startsWith('GET') && !entry.startsWith('POST'));
    expect(events).toEqual([
      'generate',
      'generate',
      `track ${GENERATION}`,
      `track ${GENERATION}`,
      'flush',
      'judge',
      'judge',
      `track ${CRITERION}`,
      `track ${CRITERION}`,
      'flush',
    ]);
    expect(log.at(-1)).toBe(`GET ${SUMMARY_PATH}`);
  });

  it('gives a row that did not generate no criterion at all', async () => {
    const fn = vi.fn(() => 1);
    const handler = stubHandler('OpenAI', 'messages', async (_config, input, _tools, variables) => {
      if (variables && 'response_to_evaluate' in variables) return judgeReply();
      if (input === 'question 1') throw new Error('generation failed');
      return { output: 'ok' };
    });
    const api = routeHostedRun(new FakeApi(), [datasetRow(0), datasetRow(1)]);
    await makeModule(api).run(run({ handler, criteria: [new Judge('accuracy'), new Scorer('exact', fn)] }));
    expect(criterionEvents().map((e) => e.data.rowIndex)).toEqual([0, 0]);
    expect(judgeCalls(handler)).toHaveLength(1);
    expect(fn).toHaveBeenCalledOnce();
    expect(api.sequence).toContain(`GET ${SUMMARY_PATH}`);
  });

  it('bounds concurrency across all (row, criterion) pairs', async () => {
    let live = 0;
    let peak = 0;
    const handler = stubHandler('OpenAI', 'messages', async (_config, _input, _tools, variables) => {
      if (!variables || !('response_to_evaluate' in variables)) return { output: 'x' };
      live++;
      peak = Math.max(peak, live);
      await new Promise((resolve) => setTimeout(resolve, 3));
      live--;
      return judgeReply();
    });
    const rows = [datasetRow(0), datasetRow(1), datasetRow(2)];
    await makeModule(routeHostedRun(new FakeApi(), rows)).run(run({ handler, concurrency: 2 }));
    expect(peak).toBe(2);
    expect(judgeCalls(handler)).toHaveLength(3);
  });

  it('keeps the other events when one criterion event fails to track', async () => {
    client.track.mockImplementation((name, context, data, metric) => {
      if (name === CRITERION && data.criterionType === 'bad') throw new Error('track exploded');
      client.tracked.push({ name, context, data, metric });
    });
    const api = routeHostedRun(new FakeApi());
    await makeModule(api).run(run({ criteria: [new Scorer('bad', () => 1), new Scorer('good', () => 1)] }));
    expect(criterionEvents().map((e) => e.data.criterionType)).toEqual(['good']);
    expect(client.tracked.some((e) => e.name === GENERATION)).toBe(true);
    expect(client.flush).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("criterion 'bad': track exploded"));
    expect(api.sequence).toContain(`GET ${SUMMARY_PATH}`);
  });

  it('still makes the final flush when the evaluation phase fails', async () => {
    client.flush.mockRejectedValueOnce(new Error('boundary flush failed')).mockResolvedValue(undefined);
    const api = routeHostedRun(new FakeApi());
    await expect(makeModule(api).run(run())).rejects.toThrow(/boundary flush failed/);
    expect(client.flush).toHaveBeenCalledTimes(2);
    expect(client.tracked.some((e) => e.name === GENERATION)).toBe(true);
  });

  it('logs criterion events too when logging is enabled', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      await makeModule(routeHostedRun(new FakeApi()), { logEvents: true }).run(run());
      const [event] = criterionEvents();
      expect(info).toHaveBeenCalledWith(
        `[LaunchDarkly] ${CRITERION} emittedAt=${event.data.emittedAt} eventId=${event.data.eventId}`,
      );
      expect(info).toHaveBeenCalledTimes(2);
    } finally {
      info.mockRestore();
    }
  });

  it('states the criteria count when the summary times out', async () => {
    const api = routeHostedRun(new FakeApi()).on('GET', SUMMARY_PATH, {
      body: { statusCounts: { total: 1, pending: 1 } },
    });
    await expect(
      makeModule(api).run(
        run({ criteria: [new Judge('accuracy'), new Scorer('exact', () => 1)], pollTimeoutSeconds: 0 }),
      ),
    ).rejects.toThrow(/2 criteria/);
  });
});

it('does not touch the management API between run creation and the first summary poll', async () => {
  const api = routeHostedRun(new FakeApi());
  await makeModule(api).run(run({ criteria: [new Judge('accuracy'), new Scorer('exact', () => 1)] }));
  const runIndex = api.sequence.indexOf(`POST ${RUN_PATH}`);
  expect(api.sequence[runIndex + 1]).toBe(`GET ${SUMMARY_PATH}`);
});
