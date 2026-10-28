/**
 * Evaluations from Code: run orchestration, the AI Config source, the
 * generation phase, event emission, inline dataset upload, and summary
 * polling. Requests go through a recording fake; the SDK client is a stub
 * injected by mocking the core client's initialization.
 */

import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateRows, generationPayload, type RowResult, SUMMARY_POLL_DEFAULTS } from '../evaluations-runner.js';
import { EvalTool, type RunOptions } from '../experimental.js';
import { NativeTool } from '../types.js';
import {
  completion,
  DATASET,
  datasetRow,
  EVALUATION_PATH,
  FakeApi,
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
  // The judge resolution seam: flag delivery, stubbed.
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

const POLL = { pollIntervalSeconds: 0, pollTimeoutSeconds: 5 };

const hosted = (overrides: Record<string, unknown> = {}) =>
  ({
    key: 'eval-key',
    dataset: DATASET,
    handler: stubHandler(),
    generation: completion(),
    ...POLL,
    ...overrides,
  }) as RunOptions;

const inline = (rows: unknown[], overrides: Record<string, unknown> = {}) => hosted({ dataset: rows, ...overrides });

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

const generationEvents = () => client.tracked.filter((t) => t.name === '$ld:ai:offline-evals:generation');

const toolPath = (key: string) => `projects/${PROJECT}/ai-tools/${key}`;

// ---------------------------------------------------------------------------
// §8.5 Request sequence
// ---------------------------------------------------------------------------

describe('request sequence', () => {
  it('is tool GET, dataset GET, rows GET, evaluation POST, run POST, summary GET for a library tool', async () => {
    const api = routeHostedRun(new FakeApi()).on('GET', toolPath('lookup'), { body: { version: 2 } });
    const evals = makeModule(api);
    const tool = await evals.tools.get('lookup', { implementation: () => 'x' });
    await evals.run(hosted({ tools: [tool] }));
    expect(api.sequence).toEqual([
      `GET ${toolPath('lookup')}`,
      `GET projects/${PROJECT}/datasets/${DATASET}`,
      `GET projects/${PROJECT}/datasets/${DATASET}/rows`,
      `POST ${EVALUATION_PATH}`,
      `POST ${RUN_PATH}`,
      `GET ${SUMMARY_PATH}`,
    ]);
    expect(api.calls[2].query.get('mode')).toBe('all');
    expect(api.calls[2].query.get('limit')).toBe('200');
    expect(api.calls[2].query.get('offset')).toBe('0');
  });

  it('issues no tool request for an inline tool', async () => {
    const api = routeHostedRun(new FakeApi());
    await makeModule(api).run(hosted({ tools: [new EvalTool('lookup', () => 'x', {})] }));
    expect(api.sequence).toEqual([
      `GET projects/${PROJECT}/datasets/${DATASET}`,
      `GET projects/${PROJECT}/datasets/${DATASET}/rows`,
      `POST ${EVALUATION_PATH}`,
      `POST ${RUN_PATH}`,
      `GET ${SUMMARY_PATH}`,
    ]);
    expect(api.calls.some((call) => call.url.includes('/ai-tools'))).toBe(false);
  });

  it('records one GET per tools.get() call, all before run(), for a mixed run', async () => {
    const api = routeHostedRun(new FakeApi())
      .on('GET', toolPath('alpha'), { body: { version: 1 } })
      .on('GET', toolPath('beta'), { body: { version: 1 } });
    const evals = makeModule(api);
    const alpha = await evals.tools.get('alpha', { implementation: () => 1 });
    const beta = await evals.tools.get('beta', { implementation: () => 2 });
    await evals.run(hosted({ tools: [alpha, new EvalTool('gamma', () => 3, {}), beta] }));
    const toolGets = api.calls.filter((call) => call.path.includes('/ai-tools/'));
    expect(new Set(toolGets.map((call) => call.path.split('/').pop()))).toEqual(new Set(['alpha', 'beta']));
    expect(api.calls.indexOf(toolGets[1])).toBeLessThan(
      api.sequence.indexOf(`GET projects/${PROJECT}/datasets/${DATASET}`),
    );
  });

  it('is evaluation POST, run POST, row upload, summary GET for an inline dataset', async () => {
    const api = routeInlineRun(new FakeApi(), 2);
    await makeModule(api).run(inline([{ input: 'a' }, { input: 'b' }], { tools: [new EvalTool('t', () => 1, {})] }));
    expect(api.sequence).toEqual([
      `POST ${EVALUATION_PATH}`,
      `POST ${RUN_PATH}`,
      `POST ${RUN_PATH}/run-1/dataset-rows`,
      `GET ${SUMMARY_PATH}`,
    ]);
    expect(api.calls.some((call) => call.url.includes('/datasets/'))).toBe(false);
  });

  it('sends no request between run creation and the first summary poll on a hosted run', async () => {
    const api = routeHostedRun(new FakeApi(), [datasetRow(0), datasetRow(1)]);
    await makeModule(api).run(hosted());
    const runIndex = api.sequence.indexOf(`POST ${RUN_PATH}`);
    expect(api.sequence[runIndex + 1]).toBe(`GET ${SUMMARY_PATH}`);
  });

  it('never uses the run-status endpoint or a result-ingest endpoint', async () => {
    const api = routeHostedRun(new FakeApi());
    await makeModule(api).run(hosted());
    expect(api.calls.some((call) => call.path === `${RUN_PATH}/run-1`)).toBe(false);
    expect(api.calls.some((call) => /\/(generation|evaluation)-results$/.test(call.path))).toBe(false);
  });

  it('percent-encodes path segments', async () => {
    const api = new FakeApi()
      .on('GET', 'projects/my%2Fproj/datasets/d%20s', { body: { id: 'ds-id', key: 'd s' } })
      .on('GET', 'projects/my%2Fproj/datasets/d%20s/rows', { body: { items: [datasetRow(0)], totalCount: 1 } })
      .on('POST', 'projects/my%2Fproj/evaluations', { body: { id: 'ev/1', version: 1 } })
      .on('POST', 'projects/my%2Fproj/evaluations/ev%2F1/runs', {
        body: { id: 'run?1', evaluationId: 'ev/1', state: 'PENDING' },
      })
      .on('GET', 'projects/my%2Fproj/evaluations/ev%2F1/runs/run%3F1/summary', {
        body: { statusCounts: { total: 1, passed: 1 } },
      });
    const result = await makeModule(api, { projectKey: 'my/proj' }).run(hosted({ dataset: 'd s' }));
    expect(result.url).toBe('https://app.launchdarkly.com/projects/my%2Fproj/ai/evaluations/ev%2F1/runs/run%3F1');
  });
});

// ---------------------------------------------------------------------------
// §8.5 Dataset resolution and record bodies
// ---------------------------------------------------------------------------

describe('dataset resolution', () => {
  it('names the dataset key and project on a 404', async () => {
    const api = routeHostedRun(new FakeApi()).on('GET', `projects/${PROJECT}/datasets/${DATASET}`, { status: 404 });
    await expect(makeModule(api).run(hosted())).rejects.toThrow(/dataset 'ds' was not found in project 'proj'/);
  });

  it('requires a string id', async () => {
    const api = routeHostedRun(new FakeApi()).on('GET', `projects/${PROJECT}/datasets/${DATASET}`, {
      body: { key: 'ds' },
    });
    await expect(makeModule(api).run(hosted())).rejects.toThrow(/'id'/);
  });

  it('pages rows until totalCount is reached', async () => {
    const all = Array.from({ length: 250 }, (_, i) => datasetRow(i));
    const api = routeHostedRun(new FakeApi(), all).on(
      'GET',
      `projects/${PROJECT}/datasets/${DATASET}/rows`,
      { body: { items: all.slice(0, 200), totalCount: 250 } },
      { body: { items: all.slice(200), totalCount: 250 } },
    );
    await makeModule(api).run(hosted());
    const pages = api.calls.filter((call) => call.path.endsWith('/rows'));
    expect(pages.map((call) => call.query.get('offset'))).toEqual(['0', '200']);
    expect(generationEvents()).toHaveLength(250);
  });

  it('throws on an empty dataset before creating any record', async () => {
    const api = routeHostedRun(new FakeApi(), []);
    await expect(makeModule(api).run(hosted())).rejects.toThrow(/is empty/);
    expect(api.calls.every((call) => call.method === 'GET')).toBe(true);
  });

  it('throws on fewer rows than totalCount', async () => {
    const api = routeHostedRun(new FakeApi()).on(
      'GET',
      `projects/${PROJECT}/datasets/${DATASET}/rows`,
      { body: { items: [datasetRow(0)], totalCount: 3 } },
      { body: { items: [], totalCount: 3 } },
    );
    await expect(makeModule(api).run(hosted())).rejects.toThrow(/returned 1 of 3 rows/);
  });

  it.each([
    ['items is not a list', { items: {}, totalCount: 1 }],
    ['totalCount is not an integer', { items: [], totalCount: '1' }],
  ])('throws when %s', async (_name, body) => {
    const api = routeHostedRun(new FakeApi()).on('GET', `projects/${PROJECT}/datasets/${DATASET}/rows`, { body });
    await expect(makeModule(api).run(hosted())).rejects.toThrow(/invalid rows/);
  });

  it('throws on a row with no integer rowIndex', async () => {
    const api = routeHostedRun(new FakeApi(), [{ input: 'x' }]);
    await expect(makeModule(api).run(hosted())).rejects.toThrow(/rowIndex/);
  });
});

describe('evaluation create body', () => {
  const createBody = (api: FakeApi) => api.calls.find((call) => call.path === EVALUATION_PATH)?.body;

  it('carries the generation settings, with no mode field and no tools when there are none', async () => {
    const api = routeHostedRun(new FakeApi());
    await makeModule(api).run(
      hosted({
        handler: stubHandler('OpenAI', 'agent'),
        generation: {
          provider: 'OpenAI',
          model: 'gpt-4o',
          mode: 'agent',
          instructions: 'Use {{snippet.tone}}',
          parameters: { temperature: 0.2 },
          promptSnippets: { tone: 'a calm tone' },
        },
      }),
    );
    expect(createBody(api)).toEqual({
      name: 'eval-key',
      generationProvider: 'OpenAI',
      generationModel: 'gpt-4o',
      parameters: { temperature: 0.2 },
      messages: [{ role: 'system', content: 'Use {{snippet.tone}}' }],
      promptSnippets: { tone: 'a calm tone' },
    });
  });

  it('sends the generation messages, or [] when there is no prompt', async () => {
    const api = routeHostedRun(new FakeApi());
    await makeModule(api).run(hosted());
    expect((createBody(api) as { messages: unknown }).messages).toEqual([{ role: 'user', content: '{{input}}' }]);

    const empty = routeHostedRun(new FakeApi());
    await makeModule(empty).run(hosted({ generation: completion({ messages: undefined }) }));
    expect((createBody(empty) as { messages: unknown }).messages).toEqual([]);
  });

  it('shapes each tool entry by its source, in list order', async () => {
    const api = routeHostedRun(new FakeApi()).on('GET', toolPath('alpha'), { body: { version: 5, description: 'A' } });
    const evals = makeModule(api);
    const alpha = await evals.tools.get('alpha', { implementation: () => 1 });
    await evals.run(hosted({ tools: [new EvalTool('beta', () => 2, { type: 'object' }), alpha] }));
    expect((createBody(api) as { tools: unknown }).tools).toEqual([
      { key: 'beta', schema: { type: 'object' }, description: '', source: 'inline' },
      { key: 'alpha', version: 5, source: 'library' },
    ]);
  });

  it.each([
    ['the response name', { name: 'from-name', label: 'from-label' }, 'from-name'],
    ['the response label when there is no name', { label: 'from-label' }, 'from-label'],
    ['the caller key when the response has neither', {}, 'eval-key'],
  ])('takes evaluationKey from %s', async (_name, fields, expected) => {
    const api = routeHostedRun(new FakeApi()).on('POST', EVALUATION_PATH, {
      status: 201,
      body: { id: 'ev-1', version: 3, ...fields },
    });
    await makeModule(api).run(hosted());
    expect(generationEvents()[0].data.evaluationKey).toBe(expected);
  });

  it('requires a version in the response', async () => {
    const api = routeHostedRun(new FakeApi()).on('POST', EVALUATION_PATH, { body: { id: 'ev-1' } });
    await expect(makeModule(api).run(hosted())).rejects.toThrow(/'version'/);
  });

  it('is not changed by a handler that changes its config', async () => {
    const schema = { type: 'object', properties: {} };
    const handler = stubHandler('OpenAI', 'messages', async (config) => {
      (config.tools?.lookup?.parameters as Record<string, unknown>).mutated = true;
      return { output: 'x' };
    });
    const api = routeHostedRun(new FakeApi());
    const tool = new EvalTool('lookup', () => 1, schema);
    await makeModule(api).run(hosted({ handler, tools: [tool] }));
    expect((createBody(api) as { tools: Array<{ schema: unknown }> }).tools[0].schema).toEqual(schema);
    expect(tool.schema).toEqual(schema);
  });
});

describe('run create body', () => {
  it('is exactly { source, datasetId } for a hosted dataset', async () => {
    const api = routeHostedRun(new FakeApi());
    await makeModule(api).run(hosted());
    expect(api.calls.find((call) => call.path === RUN_PATH)?.body).toEqual({ source: 'api', datasetId: 'ds-id' });
  });

  it('is exactly { source } for an inline dataset', async () => {
    const api = routeInlineRun(new FakeApi(), 1);
    await makeModule(api).run(inline([{ input: 'a' }]));
    expect(api.calls.find((call) => call.path === RUN_PATH)?.body).toEqual({ source: 'api' });
  });

  it('requires id, evaluationId and state in the response', async () => {
    const api = routeHostedRun(new FakeApi()).on('POST', RUN_PATH, { body: { id: 'run-1', evaluationId: 'ev-1' } });
    await expect(makeModule(api).run(hosted())).rejects.toThrow(/'state'/);
  });
});

// ---------------------------------------------------------------------------
// §8.4 / §8.5 AI Config source
// ---------------------------------------------------------------------------

describe('aiConfig source', () => {
  const CONFIG = `projects/${PROJECT}/ai-configs/support`;
  const VARIATION = `${CONFIG}/variations/v1`;
  const MODEL_CONFIG = `projects/${PROJECT}/ai-configs/model-configs/OpenAI.gpt-4o`;

  const aiRun = (overrides: Record<string, unknown> = {}) =>
    ({
      key: 'eval-key',
      dataset: DATASET,
      handler: stubHandler(),
      aiConfig: { key: 'support', variation: 'v1' },
      criteria: [],
      ...POLL,
      ...overrides,
    }) as RunOptions;

  const variation = (fields: Record<string, unknown>, older: Record<string, unknown> = {}) => ({
    body: {
      items: [
        {
          version: 1,
          model: { modelName: 'old-model', parameters: { temperature: 0.9 } },
          messages: [{ role: 'user', content: 'old' }],
          ...older,
        },
        { version: 2, modelConfigKey: 'OpenAI.gpt-4o', ...fields },
      ],
    },
  });

  function routeAi(api: FakeApi, mode: string | undefined, fields: Record<string, unknown>) {
    return routeHostedRun(api)
      .on('GET', CONFIG, { body: mode === undefined ? {} : { mode } })
      .on('GET', VARIATION, variation(fields))
      .on('GET', MODEL_CONFIG, {
        body: { provider: 'OpenAI', id: 'gpt-4o', params: { max_tokens: 100, temperature: 0.5 } },
      });
  }

  const configSeen = (handler: ReturnType<typeof stubHandler>) => handler.mock.calls[0][0];

  it('reads the config, the latest variation and its model config, then runs steps 2–6', async () => {
    const api = routeAi(new FakeApi(), 'completion', {
      model: { modelName: 'OpenAI.gpt-4o', parameters: { temperature: 0.1 } },
      modelConfigVersion: 3,
      messages: [{ role: 'user', content: 'new {{input}}' }],
      tools: [{ key: 'lookup', version: 2 }],
    }).on('GET', toolPath('lookup'), { body: { version: 2 } });
    const evals = makeModule(api);
    const tool = await evals.tools.get('lookup', { implementation: () => 1 });
    const handler = stubHandler();
    await evals.run(aiRun({ handler, tools: [tool] }));
    expect(api.sequence).toEqual([
      `GET ${toolPath('lookup')}`,
      `GET ${CONFIG}`,
      `GET ${VARIATION}`,
      `GET ${MODEL_CONFIG}`,
      `GET projects/${PROJECT}/datasets/${DATASET}`,
      `GET projects/${PROJECT}/datasets/${DATASET}/rows`,
      `POST ${EVALUATION_PATH}`,
      `POST ${RUN_PATH}`,
      `GET ${SUMMARY_PATH}`,
    ]);
    expect(api.calls[3].query.get('version')).toBe('3');
    const config = configSeen(handler);
    expect(config.provider).toEqual({ name: 'OpenAI' });
    // The model config's id, not the variation's modelName; variation parameters over model config params.
    expect(config.model).toEqual({ name: 'gpt-4o', parameters: { max_tokens: 100, temperature: 0.1 } });
    expect(config.messages).toEqual([{ role: 'user', content: 'new {{input}}' }]);
    expect(JSON.stringify(config)).not.toContain('old');
  });

  it("resolves the variation's prompt snippets, with overrides merged over them by key", async () => {
    const api = routeAi(new FakeApi(), 'completion', {
      messages: [{ role: 'system', content: 'Be {{snippet.tone}} and {{snippet.length}}.' }],
      promptSnippets: { tone: 'calm', length: 'brief', ignored: 7 },
    });
    const handler = stubHandler();
    await makeModule(api).run(aiRun({ handler, generation: { promptSnippets: { length: 'thorough' } } }));
    expect(configSeen(handler).messages).toEqual([{ role: 'system', content: 'Be calm and thorough.' }]);
    const body = api.calls.find((call) => call.path === EVALUATION_PATH)?.body as { promptSnippets: unknown };
    expect(body.promptSnippets).toEqual({ tone: 'calm', length: 'thorough' });
  });

  it('skips the model config read when none is linked, and takes the provider from the overrides', async () => {
    const api = routeAi(new FakeApi(), 'completion', {
      modelConfigKey: '',
      model: { modelName: 'gpt-4o' },
      messages: [{ role: 'user', content: 'hi' }],
    });
    await makeModule(api).run(aiRun({ generation: { provider: 'OpenAI' } }));
    expect(api.calls.some((call) => call.path.includes('model-configs'))).toBe(false);
  });

  it('requires generation.provider when no model config is linked, after the variation read', async () => {
    const api = routeAi(new FakeApi(), 'completion', { modelConfigKey: undefined, model: { modelName: 'gpt-4o' } });
    await expect(makeModule(api).run(aiRun())).rejects.toThrow(/^generation.provider is required$/);
    expect(api.sequence).toEqual([`GET ${CONFIG}`, `GET ${VARIATION}`]);
  });

  it('stops after the config read when no handler has its mode', async () => {
    const api = routeAi(new FakeApi(), 'agent', {});
    await expect(makeModule(api).run(aiRun())).rejects.toThrow(/'support' has mode 'agent'.*\[OpenAI, messages\]/);
    expect(api.sequence).toEqual([`GET ${CONFIG}`]);
  });

  it('treats an absent mode as completion and a judge mode as messages', async () => {
    for (const mode of [undefined, 'judge']) {
      const api = routeAi(new FakeApi(), mode, { messages: [{ role: 'user', content: 'hi' }] });
      await makeModule(api).run(aiRun());
      expect(api.sequence).toContain(`POST ${RUN_PATH}`);
    }
  });

  it('rejects an unknown mode, naming the config and the value', async () => {
    const api = routeAi(new FakeApi(), 'chat', {});
    await expect(makeModule(api).run(aiRun())).rejects.toThrow(/'support' has mode "chat"/);
  });

  it('names the config and project on a config 404, and the variation on a variation 404', async () => {
    const missingConfig = routeAi(new FakeApi(), 'completion', {}).on('GET', CONFIG, { status: 404 });
    await expect(makeModule(missingConfig).run(aiRun())).rejects.toThrow(/'support' was not found in project 'proj'/);
    const missingVariation = routeAi(new FakeApi(), 'completion', {}).on('GET', VARIATION, { status: 404 });
    await expect(makeModule(missingVariation).run(aiRun())).rejects.toThrow(
      /'support'\/'v1' was not found in project 'proj'/,
    );
  });

  it('names the model config and project on a model config 404', async () => {
    const api = routeAi(new FakeApi(), 'completion', {}).on('GET', MODEL_CONFIG, { status: 404 });
    await expect(makeModule(api).run(aiRun())).rejects.toThrow(
      /model config 'OpenAI.gpt-4o' was not found in project 'proj'/,
    );
  });

  it('rejects a variation with no integer version, and a non-string modelConfigKey', async () => {
    const noVersions = routeAi(new FakeApi(), 'completion', {}).on('GET', VARIATION, {
      body: { items: [{ version: 'x' }] },
    });
    await expect(makeModule(noVersions).run(aiRun())).rejects.toThrow(/has no versions/);
    const badKey = routeAi(new FakeApi(), 'completion', { modelConfigKey: 7 });
    await expect(makeModule(badKey).run(aiRun())).rejects.toThrow(/non-string modelConfigKey/);
  });

  it('stops after the model config read when no handler has its provider', async () => {
    const api = routeAi(new FakeApi(), 'completion', { messages: [{ role: 'user', content: 'hi' }] });
    await expect(makeModule(api).run(aiRun({ handler: stubHandler('Anthropic') }))).rejects.toThrow(
      /provider 'OpenAI'/,
    );
    expect(api.sequence).toEqual([`GET ${CONFIG}`, `GET ${VARIATION}`, `GET ${MODEL_CONFIG}`]);
  });

  describe('prompt by mode', () => {
    const both = { instructions: 'be brief', messages: [{ role: 'user', content: 'hello' }] };

    it('runs a completion variation that has both fields with its messages', async () => {
      const handler = stubHandler();
      await makeModule(routeAi(new FakeApi(), 'completion', both)).run(aiRun({ handler }));
      expect(configSeen(handler).messages).toEqual(both.messages);
      expect(configSeen(handler).instructions).toBeUndefined();
    });

    it('runs an agent variation that has both fields with its instructions', async () => {
      const handler = stubHandler('OpenAI', 'agent');
      await makeModule(routeAi(new FakeApi(), 'agent', both)).run(aiRun({ handler }));
      expect(configSeen(handler).instructions).toBe('be brief');
      expect(configSeen(handler).messages).toBeUndefined();
    });

    it('rejects a completion variation with only instructions after two GETs', async () => {
      const api = routeAi(new FakeApi(), 'completion', { instructions: 'be brief' });
      await expect(makeModule(api).run(aiRun())).rejects.toThrow(/'support'\/'v1' has mode 'completion'.*messages/);
      expect(api.sequence).toEqual([`GET ${CONFIG}`, `GET ${VARIATION}`]);
    });

    it('runs that variation with a messages override', async () => {
      const handler = stubHandler();
      const messages = [{ role: 'user', content: 'override' }];
      await makeModule(routeAi(new FakeApi(), 'completion', { instructions: 'be brief' })).run(
        aiRun({ handler, generation: { messages } }),
      );
      expect(configSeen(handler).messages).toEqual(messages);
    });

    it('runs a completion variation with neither field with an empty prompt', async () => {
      const handler = stubHandler();
      const api = routeAi(new FakeApi(), 'completion', {});
      await makeModule(api).run(aiRun({ handler }));
      expect(configSeen(handler).messages).toBeUndefined();
      expect((api.calls.find((call) => call.path === EVALUATION_PATH)?.body as { messages: unknown }).messages).toEqual(
        [],
      );
    });
  });

  it('merges parameter overrides key by key, and replaces other fields', async () => {
    const handler = stubHandler();
    const api = routeAi(new FakeApi(), 'completion', {
      model: { parameters: { temperature: 0.1 } },
      outputFormat: { type: 'object' },
    });
    await makeModule(api).run(
      aiRun({ handler, generation: { model: 'gpt-4o-mini', parameters: { temperature: 0.7 } } }),
    );
    expect(configSeen(handler).model).toEqual({
      name: 'gpt-4o-mini',
      parameters: { max_tokens: 100, temperature: 0.7 },
    });
    expect(configSeen(handler).outputFormat).toEqual({ type: 'object' });
  });

  describe('variation tools', () => {
    it('throws when tools is omitted and the variation lists tools, naming each', async () => {
      const api = routeAi(new FakeApi(), 'completion', {
        tools: [
          { key: 'a', version: 1 },
          { key: 'b', version: 1 },
        ],
      });
      await expect(makeModule(api).run(aiRun())).rejects.toThrow(/'a', 'b'.*Pass tools/);
      expect(api.sequence).toEqual([`GET ${CONFIG}`, `GET ${VARIATION}`, `GET ${MODEL_CONFIG}`]);
    });

    it('runs with no tools when tools is []', async () => {
      const api = routeAi(new FakeApi(), 'completion', { tools: [{ key: 'a', version: 1 }] });
      await makeModule(api).run(aiRun({ tools: [] }));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("attaches tool 'a', which this run does not use"));
    });

    it('warns when a library tool version differs from the pinned one, and uses the read version', async () => {
      const api = routeAi(new FakeApi(), 'completion', { tools: [{ key: 'lookup', version: 1 }] }).on(
        'GET',
        toolPath('lookup'),
        { body: { version: 4 } },
      );
      const evals = makeModule(api);
      const tool = await evals.tools.get('lookup', { implementation: () => 1 });
      await evals.run(aiRun({ tools: [tool] }));
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/'lookup' at version 1; the run uses version 4/));
      const body = api.calls.find((call) => call.path === EVALUATION_PATH)?.body as { tools: unknown };
      expect(body.tools).toEqual([{ key: 'lookup', version: 4, source: 'library' }]);
    });
  });

  describe('variation judges', () => {
    const judged = { judgeConfiguration: { judges: [{ judgeConfigKey: 'accuracy' }] } };

    it('become the default criteria, with default thresholds', async () => {
      const api = routeAi(new FakeApi(), 'completion', judged);
      await makeModule(api).run(aiRun({ criteria: undefined }));
      expect(lifecycle.resolve).toHaveBeenCalledWith('accuracy', expect.anything());
      const body = api.calls.find((call) => call.path === EVALUATION_PATH)?.body as { criteria: unknown };
      expect(body.criteria).toEqual([
        {
          criterionType: 'accuracy',
          kind: 'judge',
          judgeKey: 'accuracy',
          options: { threshold: 0.5 },
        },
      ]);
    });

    it('fail the run when one cannot be resolved and criteria is omitted', async () => {
      lifecycle.resolve.mockRejectedValue(new Error('Variation accuracy is not enabled'));
      const api = routeAi(new FakeApi(), 'completion', judged);
      await expect(makeModule(api).run(aiRun({ criteria: undefined }))).rejects.toThrow(/'accuracy'/);
      expect(api.calls.some((call) => call.method === 'POST')).toBe(false);
    });

    it('are replaced by criteria: [], and never resolved', async () => {
      lifecycle.resolve.mockRejectedValue(new Error('must not be resolved'));
      const api = routeAi(new FakeApi(), 'completion', judged);
      await makeModule(api).run(aiRun({ criteria: [] }));
      expect(api.sequence).toContain(`POST ${RUN_PATH}`);
      expect(lifecycle.resolve).not.toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// §8.7 Generation phase
// ---------------------------------------------------------------------------

describe('handler selection', () => {
  it('selects by provider', async () => {
    const openai = stubHandler('OpenAI');
    const anthropic = stubHandler('Anthropic');
    await makeModule(routeHostedRun(new FakeApi())).run(
      hosted({ handler: undefined, handlers: [openai, anthropic], generation: completion({ provider: 'Anthropic' }) }),
    );
    expect(anthropic).toHaveBeenCalledOnce();
    expect(openai).not.toHaveBeenCalled();
  });

  it('selects by mode', async () => {
    const messages = stubHandler('OpenAI', 'messages');
    const agent = stubHandler('OpenAI', 'agent');
    await makeModule(routeHostedRun(new FakeApi())).run(
      hosted({
        handler: undefined,
        handlers: [messages, agent],
        generation: completion({ mode: 'agent', messages: undefined }),
      }),
    );
    expect(agent).toHaveBeenCalledOnce();
    expect(messages).not.toHaveBeenCalled();
  });

  it('prefers an exact provider over a wildcard, and uses a wildcard alone', async () => {
    const exact = stubHandler('OpenAI');
    const wildcard = stubHandler('*');
    await makeModule(routeHostedRun(new FakeApi())).run(hosted({ handler: undefined, handlers: [wildcard, exact] }));
    expect(exact).toHaveBeenCalledOnce();
    expect(wildcard).not.toHaveBeenCalled();

    const only = stubHandler('*');
    await makeModule(routeHostedRun(new FakeApi())).run(hosted({ handler: only }));
    expect(only).toHaveBeenCalledOnce();
  });

  it('uses one handler for every row', async () => {
    const handler = stubHandler();
    await makeModule(routeHostedRun(new FakeApi(), [datasetRow(0), datasetRow(1), datasetRow(2)])).run(
      hosted({ handler }),
    );
    expect(handler).toHaveBeenCalledTimes(3);
  });
});

describe('handler config', () => {
  it('carries provider, model and null parameters when none are supplied', async () => {
    const handler = stubHandler();
    await makeModule(routeHostedRun(new FakeApi())).run(hosted({ handler }));
    const [config] = handler.mock.calls[0];
    expect(config.provider).toEqual({ name: 'OpenAI' });
    expect(config.model).toEqual({ name: 'gpt-4o', parameters: null });
    expect(config.tools).toEqual({});
    expect('outputFormat' in config).toBe(false);
  });

  it('forwards outputFormat when supplied', async () => {
    const handler = stubHandler();
    await makeModule(routeHostedRun(new FakeApi())).run(
      hosted({ handler, generation: completion({ outputFormat: { type: 'object' } }) }),
    );
    expect(handler.mock.calls[0][0].outputFormat).toEqual({ type: 'object' });
  });

  it('gives a library tool and the same inline tool the same config', async () => {
    const schema = { type: 'object', properties: { id: { type: 'string' } } };
    const api = routeHostedRun(new FakeApi()).on('GET', toolPath('lookup'), {
      body: { version: 1, description: 'Find', schema },
    });
    const evals = makeModule(api);
    const library = await evals.tools.get('lookup', { implementation: () => 1 });
    const fromLibrary = stubHandler();
    await evals.run(hosted({ handler: fromLibrary, tools: [library] }));
    const fromInline = stubHandler();
    await makeModule(routeHostedRun(new FakeApi())).run(
      hosted({ handler: fromInline, tools: [new EvalTool('lookup', () => 1, schema, 'Find')] }),
    );
    expect(fromLibrary.mock.calls[0][0]).toEqual(fromInline.mock.calls[0][0]);
    expect(fromInline.mock.calls[0][0].tools).toEqual({ lookup: { description: 'Find', parameters: schema } });
  });

  it('resolves prompt snippets and leaves row placeholders and non-string content alone', async () => {
    const handler = stubHandler();
    const blocks = [{ type: 'text', text: '{{snippet.tone}}' }];
    await makeModule(routeHostedRun(new FakeApi())).run(
      hosted({
        handler,
        generation: completion({
          promptSnippets: { tone: 'calm' },
          messages: [
            { role: 'system', content: 'Be {{snippet.tone}}.' },
            { role: 'user', content: '{{input}}' },
            { role: 'user', content: blocks },
          ],
        }),
      }),
    );
    expect(handler.mock.calls[0][0].messages).toEqual([
      { role: 'system', content: 'Be calm.' },
      { role: 'user', content: '{{input}}' },
      { role: 'user', content: blocks },
    ]);
  });
});

describe('row execution', () => {
  it('passes the rendered input and the row variables with input and expected_output injected', async () => {
    const handler = stubHandler();
    const row = datasetRow(0, {
      input: 'Where is order {{order_id}}?',
      expectedOutput: 'Order {{order_id}} shipped',
      variables: { order_id: 'A-17' },
    });
    await makeModule(routeHostedRun(new FakeApi(), [row])).run(hosted({ handler }));
    const [, input, , variables] = handler.mock.calls[0];
    expect(input).toBe('Where is order A-17?');
    expect(variables).toEqual({
      order_id: 'A-17',
      input: 'Where is order A-17?',
      expected_output: 'Order A-17 shipped',
    });
  });

  it('renders a missing or non-string input as null and leaves unresolved placeholders', async () => {
    const handler = stubHandler();
    const rows = [datasetRow(0, { input: 5, expectedOutput: undefined }), datasetRow(1, { input: 'hi {{missing}}' })];
    await makeModule(routeHostedRun(new FakeApi(), rows)).run(hosted({ handler }));
    expect(handler.mock.calls[0][3]).toMatchObject({ input: null, expected_output: null });
    expect(handler.mock.calls[1][1]).toBe('hi {{missing}}');
  });

  it('renders an inline row like a hosted one', async () => {
    const handler = stubHandler();
    await makeModule(routeInlineRun(new FakeApi(), 1)).run(
      inline([{ input: 'Where is order {{order_id}}?', variables: { order_id: 'A-17' } }], { handler }),
    );
    expect(handler.mock.calls[0][1]).toBe('Where is order A-17?');
    expect(handler.mock.calls[0][3]).toMatchObject({ input: 'Where is order A-17?', expected_output: null });
  });

  it('hands the handler every tool under its key, each calling what the caller supplied', async () => {
    const api = routeHostedRun(new FakeApi()).on('GET', toolPath('alpha'), { body: { version: 1 } });
    const evals = makeModule(api);
    const alphaImpl = vi.fn(() => 'from alpha');
    const betaImpl = vi.fn(async () => 'from beta');
    const alpha = await evals.tools.get('alpha', { implementation: alphaImpl });
    let results: unknown[] = [];
    const handler = stubHandler('OpenAI', 'messages', async (_config, _input, tools) => {
      results = [(tools?.alpha as () => unknown)(), await (tools?.beta as () => Promise<unknown>)()];
      return { output: 'done' };
    });
    await evals.run(hosted({ handler, tools: [alpha, new EvalTool('beta', betaImpl, {})] }));
    expect(Object.keys(handler.mock.calls[0][2] ?? {})).toEqual(['alpha', 'beta']);
    expect(results).toEqual(['from alpha', 'from beta']);
    expect(alphaImpl).toHaveBeenCalledOnce();
    expect(betaImpl).toHaveBeenCalledOnce();
  });

  it('keeps at most `concurrency` invocations in flight, and runs every row', async () => {
    let live = 0;
    let peak = 0;
    const handler = stubHandler('OpenAI', 'messages', async () => {
      live++;
      peak = Math.max(peak, live);
      await new Promise((resolve) => setTimeout(resolve, 2));
      live--;
      return { output: 'x' };
    });
    const rows = Array.from({ length: 9 }, (_, i) => datasetRow(i));
    await makeModule(routeHostedRun(new FakeApi(), rows)).run(hosted({ handler, concurrency: 3 }));
    expect(peak).toBe(3);
    expect(handler).toHaveBeenCalledTimes(9);
  });

  it('defaults concurrency to 10', async () => {
    let live = 0;
    let peak = 0;
    const handler = stubHandler('OpenAI', 'messages', async () => {
      live++;
      peak = Math.max(peak, live);
      await new Promise((resolve) => setTimeout(resolve, 2));
      live--;
      return { output: 'x' };
    });
    const rows = Array.from({ length: 25 }, (_, i) => datasetRow(i));
    await makeModule(routeHostedRun(new FakeApi(), rows)).run(hosted({ handler }));
    expect(peak).toBe(10);
  });

  it('records a throwing handler as an ERROR row with code 5001, runs the other rows, and still polls', async () => {
    const handler = stubHandler('OpenAI', 'messages', async (_config, input) => {
      if (input === 'question 1') throw new Error('provider exploded');
      return { output: 'fine' };
    });
    const api = routeHostedRun(new FakeApi(), [datasetRow(0), datasetRow(1), datasetRow(2)]);
    await makeModule(api).run(hosted({ handler }));
    expect(handler).toHaveBeenCalledTimes(3);
    const failed = generationEvents().find((event) => event.data.rowIndex === 1)?.data;
    expect(failed).toMatchObject({ status: 'ERROR', error: { code: 5001 } });
    expect((failed?.error as { message: string }).message).toContain('provider exploded');
    expect(failed?.errorMessage).toContain('provider exploded');
    expect(generationEvents().filter((event) => event.data.status === 'COMPLETE')).toHaveLength(2);
    expect(api.sequence).toContain(`GET ${SUMMARY_PATH}`);
  });

  it.each([
    ['a string', 'oops'],
    ['null', null],
    ['an array', [1]],
  ])('records a handler result that is %s as an ERROR row', async (_name, value) => {
    const handler = stubHandler('OpenAI', 'messages', async () => value);
    await makeModule(routeHostedRun(new FakeApi())).run(hosted({ handler }));
    expect(generationEvents()[0].data).toMatchObject({ status: 'ERROR', error: { code: 5001 } });
  });
});

describe('trajectory per row', () => {
  it('keeps each row to its own calls when rows interleave', async () => {
    const echo = async (value: unknown) => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return value;
    };
    const handler = stubHandler('OpenAI', 'messages', async (_config, input, tools) => {
      const call = tools?.echo as (v: unknown) => Promise<unknown>;
      await call(`${input}-a`);
      await call(`${input}-b`);
      return { output: 'x' };
    });
    const rows = [0, 1].map((rowIndex) => ({
      rowIndex,
      input: `r${rowIndex}`,
      expectedOutput: null,
      variables: {},
      metadata: null,
    }));
    const results = await generateRows(
      rows,
      handler,
      { provider: { name: 'OpenAI' }, model: { name: 'm' } },
      { echo },
      2,
    );
    expect(results.map((result) => result.trajectory.calls.map((call) => call.result))).toEqual([
      ['r0-a', 'r0-b'],
      ['r1-a', 'r1-b'],
    ]);
  });

  it('keeps the calls a row made before its handler raised', async () => {
    const handler = stubHandler('OpenAI', 'messages', async (_config, _input, tools) => {
      (tools?.lookup as () => string)();
      throw new Error('after the tool');
    });
    const rows = [{ rowIndex: 0, input: 'q', expectedOutput: null, variables: {}, metadata: null }];
    const [result] = await generateRows(
      rows,
      handler,
      { provider: { name: 'OpenAI' }, model: { name: 'm' } },
      { lookup: () => 'hit' },
      1,
    );
    expect(result.status).toBe('ERROR');
    expect(result.trajectory.calls).toEqual([{ key: 'lookup', result: 'hit', done: true }]);
  });

  it('leaves a native tool unwrapped', async () => {
    const native = new NativeTool(Symbol('s'), 'WebSearch');
    const handler = stubHandler();
    await makeModule(routeHostedRun(new FakeApi())).run(hosted({ handler, tools: [] }));
    const rows = [{ rowIndex: 0, input: 'q', expectedOutput: null, variables: {}, metadata: null }];
    await generateRows(rows, handler, { provider: { name: 'OpenAI' }, model: { name: 'm' } }, { search: native }, 1);
    expect(handler.mock.calls[1][2]?.search).toBe(native);
  });
});

// ---------------------------------------------------------------------------
// §8.6 / §8.7.3 Events
// ---------------------------------------------------------------------------

describe('generation events', () => {
  it('carries the identity, row detail and usage fields, and nothing the dataset owns', async () => {
    const row = datasetRow(0, { variables: { order_id: 'A-17' }, metadata: { tag: 'x' } });
    await makeModule(routeHostedRun(new FakeApi(), [row])).run(hosted());
    const [event] = generationEvents();
    expect(event.metric).toBe(1);
    expect(event.context).toEqual({ kind: 'evaluation', key: 'run-1', projectKey: PROJECT, evaluationId: 'ev-1' });
    const identity = {
      projectKey: PROJECT,
      evaluationId: 'ev-1',
      evaluationRunId: 'run-1',
      runId: 'run-1',
      datasetId: 'ds-id',
      rowIndex: 0,
    };
    expect(event.data).toMatchObject({
      ...identity,
      evaluationKey: 'eval-key',
      evaluationVersion: 3,
      datasetKey: DATASET,
      status: 'COMPLETE',
      output: 'out:question 0',
      usage: { inputTokens: 1, outputTokens: 2 },
    });
    // Keys sorted, compact separators.
    const canonical = JSON.stringify(
      Object.fromEntries(Object.entries(identity).sort(([a], [b]) => a.localeCompare(b))),
    );
    expect(event.data.eventId).toBe(sha256(canonical));
    for (const field of ['emittedAt', 'startedAt', 'generatedAt']) {
      expect(event.data[field]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
    }
    expect(Number.isInteger(event.data.latencyMs)).toBe(true);
    for (const field of [
      'input',
      'expectedOutput',
      'expected_output',
      'metadata',
      'variables',
      'inputTokens',
      'outputTokens',
      'trajectory',
      'tools',
      'toolCalls',
      'error',
      'errorMessage',
    ]) {
      expect(field in event.data, field).toBe(false);
    }
  });

  it('changes the eventId with the row index', async () => {
    await makeModule(routeHostedRun(new FakeApi(), [datasetRow(0), datasetRow(1)])).run(hosted());
    const [a, b] = generationEvents();
    expect(a.data.eventId).not.toBe(b.data.eventId);
    expect(a.data.eventId).toMatch(/^[0-9a-f]{64}$/);
  });

  it('omits output when it is null, and usage when none was reported', async () => {
    const handler = stubHandler('OpenAI', 'messages', async () => ({ output: null }));
    await makeModule(routeHostedRun(new FakeApi())).run(hosted({ handler }));
    expect('output' in generationEvents()[0].data).toBe(false);
    expect('usage' in generationEvents()[0].data).toBe(false);
  });

  it('falls back to "Unknown error" for an error with no message', () => {
    const result = {
      row: { rowIndex: 0 },
      status: 'ERROR',
      error: { code: 5001, message: '' },
      startedAt: '',
      generatedAt: '',
      latencyMs: 0,
    } as unknown as RowResult;
    const ids = {
      projectKey: 'p',
      evaluation: { id: 'e', key: 'k', version: 1 },
      run: { id: 'r', evaluationId: 'e', state: 'S' },
      dataset: { id: 'd', key: 'k' },
    };
    expect(generationPayload(ids, result).errorMessage).toBe('Unknown error');
  });

  describe('contentHash', () => {
    const ids = {
      projectKey: 'p',
      evaluation: { id: 'e', key: 'k', version: 1 },
      run: { id: 'r', evaluationId: 'e', state: 'S' },
      dataset: { id: 'd', key: 'k' },
    };
    const rowResult = (fields: Partial<RowResult>) =>
      ({
        row: { rowIndex: 0 },
        status: 'COMPLETE',
        startedAt: '2026-01-01T00:00:00.000Z',
        generatedAt: '2026-01-01T00:00:01.000Z',
        latencyMs: 1000,
        ...fields,
      }) as RowResult;

    // Shared with the Python SDK's test_canonical_json.py: sha256 of the RFC 8785 canonical JSON of
    // what was generated, which must be the same in every language.
    it.each([
      [
        'a completed row with non-ASCII output and usage',
        rowResult({ output: 'café 東京 😀', usage: { input_tokens: 1, output_tokens: 2 } }),
        'c413938130f9e5d632edbd07d529139b942e1c43c62fe3fb9ae09552dc7e7f71',
      ],
      [
        'an errored row',
        rowResult({ status: 'ERROR', error: { code: 5001, message: 'handler raised: boom' } }),
        '04e26552bf66f7afa68ba6307c9f9c162abd2bbd963cb7e42d9dcea337152848',
      ],
      [
        'a structured output with no usage',
        rowResult({ output: { b: 1, a: [true, null, 'x'] } }),
        '504de7cbb5f7d8b3ef260a99c69460c6b7f4fb3ea449c16cedde0ac0e120008c',
      ],
    ])('matches the Python SDK for %s', (_name, result, hash) => {
      expect(generationPayload(ids, result).contentHash).toBe(hash);
    });

    it('writes numbers as JSON.stringify does, so a float 1.0 from Python hashes as 1 does here', () => {
      const result = rowResult({
        output: { score: 1, p: 0.1, tiny: 1e-5, big: 1e16, list: [3, -0, 2.5e-7], neg: -2 },
        usage: { input_tokens: 7, output_tokens: 9 },
      });
      // {"error":null,"output":{"big":10000000000000000,"list":[3,0,2.5e-7],"neg":-2,"p":0.1,"score":1,"tiny":0.00001},...}
      expect(generationPayload(ids, result).contentHash).toBe(
        'ae920410735c7fe62767503ea2121965d264b0d26abe396736d03be6aac77ae7',
      );
    });

    it('sorts keys by UTF-16 code unit and writes non-ASCII as is', () => {
      // U+1F600 is the surrogate pair D83D DE00, so it sorts before U+FF61.
      const output = { z: 1, '\uff61': 2, '\u{1F600}': 3 };
      expect(generationPayload(ids, rowResult({ output })).contentHash).toBe(
        sha256('{"error":null,"output":{"z":1,"\u{1F600}":3,"\uff61":2},"status":"COMPLETE"}'),
      );
    });

    it('writes a missing array element as null, as Python writes None', () => {
      // Python: {"error":null,"output":{"list":[1,null,2]},"status":"COMPLETE"}
      const hash = '33728410ea55e9bc69710b426ff78fd1ca0eb437ebe69d4cca83a39403ab05f6';
      expect(generationPayload(ids, rowResult({ output: { list: [1, undefined, 2] } })).contentHash).toBe(hash);
      expect(generationPayload(ids, rowResult({ output: { list: [1, null, 2] } })).contentHash).toBe(hash);
    });

    it('drops object keys JSON cannot hold, at any depth', () => {
      const output = { kept: 'x', gone: undefined, fn: () => 1, sym: Symbol('s'), nested: [{ a: 1, b: undefined }] };
      // Python: {"error":null,"output":{"kept":"x","nested":[{"a":1}]},"status":"COMPLETE"}
      expect(generationPayload(ids, rowResult({ output })).contentHash).toBe(
        '4bfd217d300af0c0a32f037b5e8aa036a844bd71cb1713dbcf7a99ee656304eb',
      );
    });

    it('hashes the same JSON the tracked event carries', () => {
      const output = { list: [1, undefined, () => 2, Symbol('s'), { a: undefined, b: [undefined] }], text: 'café' };
      const asSent = JSON.parse(JSON.stringify(output));
      expect(generationPayload(ids, rowResult({ output })).contentHash).toBe(
        generationPayload(ids, rowResult({ output: asSent })).contentHash,
      );
    });

    it('covers what was generated, not when or for which row', () => {
      const a = generationPayload(ids, rowResult({ output: 'same' }));
      const b = generationPayload(
        { ...ids, run: { ...ids.run, id: 'other' } },
        rowResult({ output: 'same', row: { rowIndex: 4 } as RowResult['row'], latencyMs: 5, startedAt: 'x' }),
      );
      const c = generationPayload(ids, rowResult({ output: 'different' }));
      expect(a.contentHash).toBe(b.contentHash);
      expect(a.contentHash).not.toBe(c.contentHash);
    });

    it('is on every generation event', async () => {
      const handler = stubHandler('OpenAI', 'messages', async (_config, input) => {
        if (input === 'question 1') throw new Error('nope');
        return { output: 'ok' };
      });
      await makeModule(routeHostedRun(new FakeApi(), [datasetRow(0), datasetRow(1)])).run(hosted({ handler }));
      for (const event of generationEvents()) expect(event.data.contentHash).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  it('omits datasetId and datasetKey on an inline run, including from the eventId identity', async () => {
    await makeModule(routeInlineRun(new FakeApi(), 1)).run(inline([{ input: 'a' }]));
    const { data } = generationEvents()[0];
    expect('datasetId' in data).toBe(false);
    expect('datasetKey' in data).toBe(false);
    expect(data.eventId).toBe(
      sha256(
        JSON.stringify({
          evaluationId: 'ev-1',
          evaluationRunId: 'run-1',
          projectKey: PROJECT,
          rowIndex: 0,
          runId: 'run-1',
        }),
      ),
    );
  });

  it('keeps the hosted eventId over the full identity, with datasetId and no upload', async () => {
    const api = routeHostedRun(new FakeApi());
    await makeModule(api).run(hosted());
    expect(api.calls.some((call) => call.path.endsWith('/dataset-rows'))).toBe(false);
    expect(generationEvents()[0].data.eventId).toBe(
      sha256(
        JSON.stringify({
          datasetId: 'ds-id',
          evaluationId: 'ev-1',
          evaluationRunId: 'run-1',
          projectKey: PROJECT,
          rowIndex: 0,
          runId: 'run-1',
        }),
      ),
    );
  });

  it('emits without reading a flag', async () => {
    await makeModule(routeHostedRun(new FakeApi())).run(hosted());
    expect(client.variation).not.toHaveBeenCalled();
    expect(generationEvents()).toHaveLength(1);
  });
});

describe('event logging', () => {
  it('is off by default', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      await makeModule(routeHostedRun(new FakeApi())).run(hosted());
      expect(info).not.toHaveBeenCalled();
    } finally {
      info.mockRestore();
    }
  });

  it('logs each queued event with its emittedAt and eventId when enabled', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      await makeModule(routeHostedRun(new FakeApi(), [datasetRow(0), datasetRow(1)]), { logEvents: true }).run(
        hosted(),
      );
      const events = generationEvents();
      expect(info.mock.calls.map(([line]) => line)).toEqual(
        events.map(
          (event) =>
            `[LaunchDarkly] $ld:ai:offline-evals:generation emittedAt=${event.data.emittedAt} eventId=${event.data.eventId}`,
        ),
      );
    } finally {
      info.mockRestore();
    }
  });
});

describe('flushing', () => {
  it('flushes once, after every event and before the first summary poll, awaiting the flush', async () => {
    const api = routeHostedRun(new FakeApi(), [datasetRow(0), datasetRow(1)]);
    let requestsAtFlush = -1;
    let settled = false;
    client.flush.mockImplementation(async () => {
      requestsAtFlush = api.calls.length;
      await new Promise((resolve) => setTimeout(resolve, 1));
      settled = true;
    });
    api.on('GET', SUMMARY_PATH, () => {
      expect(settled).toBe(true);
      return { body: { statusCounts: { total: 2, passed: 2 } } };
    });
    await makeModule(api).run(hosted());
    expect(client.flush).toHaveBeenCalledOnce();
    expect(api.sequence[requestsAtFlush - 1]).toBe(`POST ${RUN_PATH}`);
    expect(api.sequence[requestsAtFlush]).toBe(`GET ${SUMMARY_PATH}`);
  });

  it('flushes each time the bound is reached', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => datasetRow(i));
    await makeModule(routeHostedRun(new FakeApi(), rows), { flushBound: 2 }).run(hosted());
    // At 2 and 4 events, then the final flush.
    expect(client.flush).toHaveBeenCalledTimes(3);
  });
});

describe('client resolution', () => {
  it('reuses an initialized client without initializing one', async () => {
    await makeModule(routeHostedRun(new FakeApi()), { sdkKey: undefined }).run(hosted());
    expect(lifecycle.init).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns that the evaluations SDK key is ignored when a client already exists', async () => {
    await makeModule(routeHostedRun(new FakeApi())).run(hosted());
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('SDK key is ignored'));
  });

  it('initializes the client with exactly the evaluations SDK key', async () => {
    lifecycle.client = undefined;
    lifecycle.init.mockResolvedValue(client);
    await makeModule(routeHostedRun(new FakeApi())).run(hosted());
    expect(lifecycle.init).toHaveBeenCalledWith({ sdkKey: 'sdk-key' });
    expect(generationEvents()).toHaveLength(1);
  });

  it('fails before any request when initialization throws', async () => {
    lifecycle.client = undefined;
    lifecycle.init.mockRejectedValue(new Error('bad key'));
    const api = routeHostedRun(new FakeApi());
    await expect(makeModule(api).run(hosted())).rejects.toThrow(/bad key/);
    expect(api.calls).toEqual([]);
  });

  it('fails before any request with no client and no SDK key', async () => {
    lifecycle.client = undefined;
    const api = routeHostedRun(new FakeApi());
    await expect(makeModule(api, { sdkKey: undefined }).run(hosted())).rejects.toThrow(
      /no initialized LaunchDarkly client/,
    );
    expect(api.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// §8.5 Inline dataset upload
// ---------------------------------------------------------------------------

describe('inline dataset upload', () => {
  const UPLOAD = `${RUN_PATH}/run-1/dataset-rows`;
  const uploads = (api: FakeApi) => api.calls.filter((call) => call.path === UPLOAD);

  it('sends every key on every row, defaulting the optional ones', async () => {
    const api = routeInlineRun(new FakeApi(), 2);
    await makeModule(api).run(
      inline([
        { input: 'a' },
        { rowIdx: 1, input: 'b', expectedOutput: 'B', variables: { x: 1 }, metadata: { m: true } },
      ]),
    );
    expect(uploads(api)[0].body).toEqual({
      rows: [
        { rowIdx: 0, input: 'a', expectedOutput: null, variables: {}, metadata: null },
        { rowIdx: 1, input: 'b', expectedOutput: 'B', variables: { x: 1 }, metadata: { m: true } },
      ],
    });
  });

  it('uploads rows unrendered, while the handler gets them rendered', async () => {
    const handler = stubHandler();
    const api = routeInlineRun(new FakeApi(), 1);
    await makeModule(api).run(
      inline([{ input: 'Where is order {{order_id}}?', variables: { order_id: 'A-17' } }], { handler }),
    );
    expect((uploads(api)[0].body as { rows: Array<{ input: string }> }).rows[0].input).toBe(
      'Where is order {{order_id}}?',
    );
    expect(handler.mock.calls[0][1]).toBe('Where is order A-17?');
  });

  it('uploads in sequential batches of at most 500', async () => {
    const rows = Array.from({ length: 1001 }, (_, i) => ({ input: `q${i}` }));
    const api = routeInlineRun(new FakeApi(), 1001);
    await makeModule(api).run(inline(rows, { concurrency: 50 }));
    const batches = uploads(api).map((call) => (call.body as { rows: Array<{ rowIdx: number }> }).rows);
    expect(batches.map((batch) => batch.length)).toEqual([500, 500, 1]);
    expect(batches.flat().map((row) => row.rowIdx)).toEqual(Array.from({ length: 1001 }, (_, i) => i));
  });

  it('lands every batch before the first event is tracked', async () => {
    const log: string[] = [];
    client = stubClient(log);
    lifecycle.client = client;
    const api = routeInlineRun(new FakeApi(log), 501);
    await makeModule(api).run(inline(Array.from({ length: 501 }, (_, i) => ({ input: `q${i}` }))));
    expect(log.lastIndexOf(`POST ${UPLOAD}`)).toBeLessThan(log.findIndex((entry) => entry.startsWith('track')));
  });

  it('retries an upload as an idempotent POST', async () => {
    const api = routeInlineRun(new FakeApi(), 1).on('POST', UPLOAD, { status: 503 }, { body: {} });
    await makeModule(api).run(inline([{ input: 'a' }]));
    expect(uploads(api)).toHaveLength(2);
  });

  it('cancels the run and throws, generating nothing, when the first batch fails', async () => {
    const handler = stubHandler();
    const api = routeInlineRun(new FakeApi(), 1).on('POST', UPLOAD, { status: 400, body: 'bad row' });
    const err = await makeModule(api)
      .run(inline([{ input: 'a' }], { handler }))
      .catch((e: Error) => e);
    expect(err.message).toMatch(/rows 0-0 of 1 to evaluation run run-1/);
    expect((err as Error & { cause?: unknown }).cause).toMatchObject({ status: 400 });
    expect(api.sequence.slice(-2)).toEqual([`POST ${UPLOAD}`, `POST ${RUN_PATH}/run-1/cancel`]);
    expect(api.calls.at(-1)?.body).toBeUndefined();
    expect(handler).not.toHaveBeenCalled();
    expect(client.track).not.toHaveBeenCalled();
    expect(api.sequence).not.toContain(`GET ${SUMMARY_PATH}`);
  });

  it('names the failing batch when a later one fails', async () => {
    const api = routeInlineRun(new FakeApi(), 501).on('POST', UPLOAD, { body: {} }, { status: 400 });
    await expect(
      makeModule(api).run(inline(Array.from({ length: 501 }, (_, i) => ({ input: `q${i}` })))),
    ).rejects.toThrow(/rows 500-500 of 501/);
    expect(uploads(api)).toHaveLength(2);
    expect(api.sequence.at(-1)).toBe(`POST ${RUN_PATH}/run-1/cancel`);
  });

  it('still throws the upload error when the cancel fails, and warns naming the run', async () => {
    const api = routeInlineRun(new FakeApi(), 1)
      .on('POST', UPLOAD, { status: 400 })
      .on('POST', `${RUN_PATH}/run-1/cancel`, { status: 409, body: 'already terminal' });
    await expect(makeModule(api).run(inline([{ input: 'a' }]))).rejects.toThrow(/rows 0-0 of 1/);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('cancel evaluation run run-1'));
  });
});

// ---------------------------------------------------------------------------
// §8.9 Summary polling and result
// ---------------------------------------------------------------------------

describe('summary polling', () => {
  it('needs one poll for a realistic terminal payload with no state', async () => {
    const api = routeHostedRun(new FakeApi(), [datasetRow(0), datasetRow(1)]).on('GET', SUMMARY_PATH, {
      body: { statusCounts: { total: 2, passed: 2, failed: 0, error: 0, pending: 0 }, runId: 'run-1' },
    });
    const result = await makeModule(api).run(hosted());
    expect(api.calls.filter((call) => call.path === SUMMARY_PATH)).toHaveLength(1);
    expect(result.summary).toEqual({ totalRows: 2, passedRows: 2, failedRows: 0, errorRows: 0, pendingRows: 0 });
  });

  it('reads counts from top-level keys too', async () => {
    const api = routeHostedRun(new FakeApi()).on('GET', SUMMARY_PATH, { body: { total: 1, passed: 1 } });
    expect((await makeModule(api).run(hosted())).passed).toBe(true);
  });

  it('polls again after a pending summary or an empty body', async () => {
    const api = routeHostedRun(new FakeApi()).on(
      'GET',
      SUMMARY_PATH,
      { body: { statusCounts: { total: 1, pending: 1 } } },
      { body: {} },
      { body: { statusCounts: { total: 1, passed: 1 } } },
    );
    const sleep = vi.fn(async () => {});
    await makeModule(api, { sleep }).run(hosted({ pollIntervalSeconds: 1.5 }));
    expect(api.calls.filter((call) => call.path === SUMMARY_PATH)).toHaveLength(3);
    expect(sleep).toHaveBeenCalledWith(1.5);
  });

  it('does not treat a state field as terminal', async () => {
    const api = routeHostedRun(new FakeApi()).on('GET', SUMMARY_PATH, {
      body: { state: 'COMPLETED', statusCounts: { total: 1, pending: 1 } },
    });
    await expect(makeModule(api).run(hosted({ pollTimeoutSeconds: 0 }))).rejects.toThrow(/Timed out/);
  });

  it('times out naming the counts and an event transport problem when nothing was accounted', async () => {
    const api = routeHostedRun(new FakeApi()).on('GET', SUMMARY_PATH, {
      body: { statusCounts: { total: 3, pending: 3 } },
    });
    const err = await makeModule(api)
      .run(hosted({ pollTimeoutSeconds: 0 }))
      .catch((e: Error) => e);
    expect(err.message).toMatch(/total_rows=3, accounted_rows=0, pending_rows=3/);
    expect(err.message).toMatch(/No rows were accounted for.*same project/);
  });

  it('times out naming undelivered events when some rows are short', async () => {
    const api = routeHostedRun(new FakeApi()).on('GET', SUMMARY_PATH, {
      body: { statusCounts: { total: 3, passed: 2, pending: 1 } },
    });
    await expect(makeModule(api).run(hosted({ pollTimeoutSeconds: 0 }))).rejects.toThrow(
      /accounted_rows=2.*not delivered/,
    );
  });

  it('uses patchable defaults of 2 and 180 seconds', async () => {
    expect(SUMMARY_POLL_DEFAULTS).toEqual({ intervalSeconds: 2, timeoutSeconds: 180 });
    const saved = { ...SUMMARY_POLL_DEFAULTS };
    SUMMARY_POLL_DEFAULTS.timeoutSeconds = 0;
    try {
      const api = routeHostedRun(new FakeApi()).on('GET', SUMMARY_PATH, { body: {} });
      const options = { ...hosted() } as Record<string, unknown>;
      delete options.pollTimeoutSeconds;
      delete options.pollIntervalSeconds;
      await expect(makeModule(api).run(options as RunOptions)).rejects.toThrow(/Timed out after 0 seconds/);
    } finally {
      Object.assign(SUMMARY_POLL_DEFAULTS, saved);
    }
  });

  it.each([
    [{ total: 2, passed: 1, error: 1 }, false],
    [{ total: 2, passed: 1, failed: 1 }, false],
    [{ total: 2, passed: 2 }, true],
  ])('reports passed for %j as %s', async (statusCounts, passed) => {
    const api = routeHostedRun(new FakeApi()).on('GET', SUMMARY_PATH, { body: { statusCounts } });
    const result = await makeModule(api).run(hosted());
    expect(result.passed).toBe(passed);
    expect(result.runId).toBe('run-1');
    expect(result.url).toBe(`https://app.launchdarkly.com/projects/${PROJECT}/ai/evaluations/ev-1/runs/run-1`);
  });
});
