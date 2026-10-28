/**
 * Evaluations from Code: initialization, criterion references, and `run()`
 * argument validation. Every validation test asserts that no request was sent.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EvalTool, EvaluationsError, initEvaluations, Judge, type RunOptions, Scorer } from '../index.js';
import { NativeTool } from '../types.js';
import {
  completion,
  FakeApi,
  makeModule,
  PROJECT,
  routeHostedRun,
  servedJudge,
  stubClient,
  stubHandler,
  throwingTransport,
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

beforeEach(() => {
  lifecycle.client = undefined;
  lifecycle.init.mockReset();
  lifecycle.resolve.mockReset();
  lifecycle.resolve.mockImplementation(async () => servedJudge());
  for (const name of ['LD_PROJECT_KEY', 'LD_API_TOKEN', 'LD_SDK_KEY']) vi.stubEnv(name, '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

describe('initEvaluations', () => {
  const init = (options: Parameters<typeof initEvaluations>[0] = {}) =>
    initEvaluations({ transport: throwingTransport, ...options });

  it('names LD_PROJECT_KEY first when everything is missing', () => {
    expect(() => init()).toThrow(/LD_PROJECT_KEY/);
  });

  it('names LD_API_TOKEN when only the project key is supplied', () => {
    expect(() => init({ projectKey: 'p' })).toThrow(/LD_API_TOKEN/);
  });

  it('names LD_SDK_KEY when only the SDK key is missing and no client exists', () => {
    expect(() => init({ projectKey: 'p', apiKey: 't' })).toThrow(/LD_SDK_KEY/);
  });

  it('treats blank environment values as unset', () => {
    vi.stubEnv('LD_PROJECT_KEY', '   ');
    expect(() => init()).toThrow(/LD_PROJECT_KEY/);
    vi.stubEnv('LD_PROJECT_KEY', 'p');
    vi.stubEnv('LD_API_TOKEN', ' ');
    expect(() => init()).toThrow(/LD_API_TOKEN/);
    vi.stubEnv('LD_API_TOKEN', 't');
    vi.stubEnv('LD_SDK_KEY', '\t');
    expect(() => init()).toThrow(/LD_SDK_KEY/);
  });

  it('reads all three from the environment', () => {
    vi.stubEnv('LD_PROJECT_KEY', 'env-project');
    vi.stubEnv('LD_API_TOKEN', 'env-token');
    vi.stubEnv('LD_SDK_KEY', 'env-sdk');
    const evals = init();
    expect(evals.projectKey).toBe('env-project');
    expect(evals.sdkKey).toBe('env-sdk');
  });

  it('prefers explicit options over the environment', () => {
    vi.stubEnv('LD_PROJECT_KEY', 'env-project');
    vi.stubEnv('LD_API_TOKEN', 'env-token');
    vi.stubEnv('LD_SDK_KEY', 'env-sdk');
    const evals = init({ projectKey: 'opt-project', apiKey: 'opt-token', sdkKey: 'opt-sdk' });
    expect(evals.projectKey).toBe('opt-project');
    expect(evals.sdkKey).toBe('opt-sdk');
  });

  it('uses the API token option over LD_API_TOKEN on requests', async () => {
    vi.stubEnv('LD_API_TOKEN', 'env-token');
    const api = new FakeApi().on('GET', `projects/p/ai-tools/t`, { body: { version: 1 } });
    const evals = initEvaluations({ projectKey: 'p', apiKey: 'opt-token', sdkKey: 's', transport: api.transport });
    await evals.tools.get('t', { implementation: () => 1 });
    expect(api.calls[0].headers.Authorization).toBe('opt-token');
  });

  it('falls back to LD_PROJECT_KEY when the explicit project key is blank', () => {
    vi.stubEnv('LD_PROJECT_KEY', 'env-project');
    expect(init({ projectKey: '  ', apiKey: 't', sdkKey: 's' }).projectKey).toBe('env-project');
  });

  it('accepts an initialized client that can track and flush in place of the SDK key', () => {
    lifecycle.client = stubClient();
    const evals = init({ projectKey: 'p', apiKey: 't' });
    expect(evals.sdkKey).toBeUndefined();
  });

  it('rejects an initialized client that cannot flush', () => {
    lifecycle.client = { track: () => {} };
    expect(() => init({ projectKey: 'p', apiKey: 't' })).toThrow(/LD_SDK_KEY/);
  });

  describe('hosts', () => {
    const keys = { projectKey: PROJECT, apiKey: 't', sdkKey: 's' };

    async function hostsUsed(options: Parameters<typeof initEvaluations>[0] = {}) {
      lifecycle.client = stubClient();
      const api = routeHostedRun(new FakeApi());
      const evals = initEvaluations({ ...keys, transport: api.transport, ...options });
      const result = await evals.run({
        key: 'eval-key',
        dataset: 'ds',
        handler: stubHandler(),
        generation: completion(),
        pollIntervalSeconds: 0,
      });
      return { apiUrls: api.calls.map((call) => call.url), runUrl: result.url, evals };
    }

    it('default to app.launchdarkly.com, ignoring the SDK event host LD_BASE_URI', async () => {
      vi.stubEnv('LD_BASE_URI', 'https://events.example.com');
      const { apiUrls, runUrl } = await hostsUsed();
      expect(apiUrls.every((url) => url.startsWith('https://app.launchdarkly.com/api/v2/'))).toBe(true);
      expect(runUrl).toBe(`https://app.launchdarkly.com/projects/${PROJECT}/ai/evaluations/ev-1/runs/run-1`);
    });

    it('read LD_API_BASE_URI and LD_UI_BASE_URI', async () => {
      vi.stubEnv('LD_API_BASE_URI', 'https://api.example.com');
      vi.stubEnv('LD_UI_BASE_URI', 'https://ui.example.com/');
      const { apiUrls, runUrl, evals } = await hostsUsed();
      expect(apiUrls.every((url) => url.startsWith('https://api.example.com/api/v2/'))).toBe(true);
      expect(runUrl).toBe(`https://ui.example.com/projects/${PROJECT}/ai/evaluations/ev-1/runs/run-1`);
      expect(evals.uiBaseUri).toBe('https://ui.example.com');
    });

    it('prefer the options over the environment', async () => {
      vi.stubEnv('LD_API_BASE_URI', 'https://api.example.com');
      vi.stubEnv('LD_UI_BASE_URI', 'https://ui.example.com');
      const { apiUrls, runUrl } = await hostsUsed({
        apiBaseUri: 'http://localhost:8080',
        uiBaseUri: 'http://localhost:3000',
      });
      expect(apiUrls.every((url) => url.startsWith('http://localhost:8080/api/v2/'))).toBe(true);
      expect(runUrl.startsWith('http://localhost:3000/projects/')).toBe(true);
    });

    it('do not derive the UI host from LD_API_BASE_URI', async () => {
      vi.stubEnv('LD_API_BASE_URI', 'https://api.example.com');
      const { apiUrls, runUrl } = await hostsUsed();
      expect(apiUrls.every((url) => url.startsWith('https://api.example.com/api/v2/'))).toBe(true);
      expect(runUrl.startsWith('https://app.launchdarkly.com/projects/')).toBe(true);
    });

    it('pass logEvents through to the run', async () => {
      const info = vi.spyOn(console, 'info').mockImplementation(() => {});
      try {
        await hostsUsed({ logEvents: true });
        expect(info).toHaveBeenCalledWith(
          expect.stringMatching(
            /^\[LaunchDarkly\] \$ld:ai:offline-evals:generation emittedAt=\S+Z eventId=[0-9a-f]{64}$/,
          ),
        );
      } finally {
        info.mockRestore();
      }
    });

    it('treat blank values as unset', async () => {
      vi.stubEnv('LD_API_BASE_URI', '  ');
      const { apiUrls, runUrl } = await hostsUsed({ uiBaseUri: ' ' });
      expect(apiUrls[0].startsWith('https://app.launchdarkly.com/api/v2/')).toBe(true);
      expect(runUrl.startsWith('https://app.launchdarkly.com/projects/')).toBe(true);
    });

    it('treat blank options and blank environment values alike', async () => {
      vi.stubEnv('LD_UI_BASE_URI', '  ');
      const { apiUrls, runUrl } = await hostsUsed({ apiBaseUri: ' ' });
      expect(apiUrls[0].startsWith('https://app.launchdarkly.com/api/v2/')).toBe(true);
      expect(runUrl.startsWith('https://app.launchdarkly.com/projects/')).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// Criterion references (construction only; the phase is not implemented)
// ---------------------------------------------------------------------------

describe('criterion references', () => {
  it('a Judge defaults its thresholds', () => {
    expect(new Judge('accuracy')).toMatchObject({ threshold: 0.5, passRateThreshold: 0.95 });
  });

  it('a Scorer defaults its thresholds and success direction', () => {
    expect(new Scorer('exact', () => true)).toMatchObject({
      threshold: 1.0,
      passRateThreshold: 0.95,
      successDirection: 'higher_is_better',
    });
  });

  it('rejects a blank judge key and a blank scorer name', () => {
    expect(() => new Judge(' ')).toThrow(/judge key must not be blank/);
    expect(() => new Scorer('', () => 1)).toThrow(/scorer name must not be blank/);
  });

  it('rejects a scorer fn that is not callable', () => {
    expect(() => new Scorer('exact', 'nope' as never)).toThrow(/'exact' fn must be callable/);
  });

  it('rejects an unknown success direction', () => {
    expect(() => new Scorer('exact', () => 1, { successDirection: 'up' as never })).toThrow(/successDirection/);
  });

  describe.each(['threshold', 'passRateThreshold'])('%s', (field) => {
    it.each([
      -0.5,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ])('rejects %d on a judge and a scorer, naming the field', (value) => {
      expect(() => new Judge('accuracy', { [field]: value })).toThrow(new RegExp(`^${field} must be a finite number`));
      expect(() => new Scorer('exact', () => 1, { [field]: value })).toThrow(
        new RegExp(`^${field} must be a finite number`),
      );
    });

    it.each([0, 1])('accepts %d', (value) => {
      expect(new Judge('accuracy', { [field]: value })[field as 'threshold']).toBe(value);
    });
  });

  it('supplied values override the defaults, including 0', () => {
    expect(new Judge('accuracy', { threshold: 0, passRateThreshold: 0.8 })).toMatchObject({
      threshold: 0,
      passRateThreshold: 0.8,
    });
    expect(new Scorer('hits', () => 0, { threshold: 0.2, successDirection: 'lower_is_better' })).toMatchObject({
      threshold: 0.2,
      successDirection: 'lower_is_better',
    });
  });
});

// ---------------------------------------------------------------------------
// run() argument validation — zero requests
// ---------------------------------------------------------------------------

describe('run() argument validation', () => {
  let api: FakeApi;

  beforeEach(() => {
    api = new FakeApi();
    lifecycle.client = stubClient();
  });

  const base = (overrides: Record<string, unknown> = {}) =>
    ({ key: 'eval-key', dataset: 'ds', handler: stubHandler(), generation: completion(), ...overrides }) as RunOptions;

  async function rejects(options: RunOptions, message: RegExp): Promise<void> {
    await expect(makeModule(api).run(options)).rejects.toThrow(message);
    expect(api.calls).toEqual([]);
  }

  it('rejects a blank key', async () => {
    await rejects(base({ key: '  ' }), /key must not be blank/);
  });

  describe('dataset', () => {
    it('rejects a blank key', async () => {
      await rejects(base({ dataset: ' ' }), /dataset must not be blank/);
    });

    it.each([
      ['null', null],
      ['a single row without a list', { input: 'hi' }],
      ['a number', 7],
      [
        'a generator',
        (function* () {
          yield { input: 'hi' };
        })(),
      ],
      ['a Set', new Set([{ input: 'hi' }])],
    ])('rejects %s', async (_name, dataset) => {
      await rejects(base({ dataset }), /dataset key or an array of inline rows/);
    });

    it('rejects an omitted dataset', async () => {
      const { dataset: _omit, ...options } = base();
      await rejects(options as RunOptions, /dataset key or an array of inline rows/);
    });
  });

  describe('inline rows', () => {
    it('rejects an empty dataset', async () => {
      await rejects(base({ dataset: [] }), /Inline dataset is empty/);
    });

    it('rejects a row that is not a mapping, naming its position', async () => {
      await rejects(base({ dataset: [{ input: 'a' }, 'b'] }), /row 1 must be a mapping/);
    });

    it('rejects the public dataset-row shape, whose rowIndex key is unknown', async () => {
      await rejects(base({ dataset: [{ rowIndex: 0, input: 'a', variables: {} }] }), /unknown fields: 'rowIndex'/);
    });

    it('rejects expected_output, the snake_case near miss, listing the allowed keys', async () => {
      await rejects(base({ dataset: [{ input: 'a', expected_output: 'b' }] }), /'expected_output'.*'expectedOutput'/);
    });

    it.each([
      [1, /row 0 has rowIdx 1/],
      [true, /row 0 has rowIdx true/],
    ])('rejects a rowIdx of %j at position 0', async (rowIdx, message) => {
      await rejects(base({ dataset: [{ rowIdx, input: 'a' }] }), message);
    });

    it.each([
      ['absent', {}],
      ['empty', { input: '' }],
      ['not a string', { input: 3 }],
    ])('rejects an input that is %s', async (_name, row) => {
      await rejects(base({ dataset: [row] }), /row 0 input must be a non-empty string/);
    });

    it('rejects a non-string expectedOutput', async () => {
      await rejects(base({ dataset: [{ input: 'a', expectedOutput: 1 }] }), /row 0 expectedOutput must be a string/);
    });

    it('rejects variables that are not a mapping', async () => {
      await rejects(base({ dataset: [{ input: 'a', variables: [1] }] }), /row 0 variables must be a mapping/);
    });

    it.each([
      [
        'NaN in variables on a later row',
        [{ input: 'a' }, { input: 'b', variables: { x: Number.NaN } }],
        /row 1 variables/,
      ],
      ['Infinity in metadata', [{ input: 'a', metadata: { x: Number.POSITIVE_INFINITY } }], /row 0 metadata/],
      [
        '-Infinity nested in a list',
        [{ input: 'a', variables: { x: [1, Number.NEGATIVE_INFINITY] } }],
        /row 0 variables/,
      ],
      ['a Set', [{ input: 'a', variables: { x: new Set([1]) } }], /row 0 variables.*Set/],
      ['a Date', [{ input: 'a', metadata: { at: new Date() } }], /row 0 metadata.*Date/],
      ['a Map', [{ input: 'a', variables: { m: new Map() } }], /row 0 variables.*Map/],
    ])('rejects %s', async (_name, dataset, message) => {
      await rejects(base({ dataset }), message);
    });
  });

  describe('handler pool', () => {
    it('rejects both handler and handlers, naming both', async () => {
      await rejects(base({ handlers: [stubHandler()] }), /handler and handlers/);
    });

    it('rejects neither, naming both', async () => {
      await rejects(base({ handler: undefined }), /handler and handlers/);
    });

    it.each([
      ['null', null],
      ['an empty list', []],
      ['a single handler without a list', stubHandler()],
    ])('rejects handlers that is %s', async (_name, handlers) => {
      await rejects(base({ handler: undefined, handlers }), /handlers must be a non-empty array/);
    });

    it('rejects a non-callable entry, naming its index', async () => {
      await rejects(
        base({ handler: undefined, handlers: [stubHandler(), {}] }),
        /handlers\[1\] must be callable.*createHandler/,
      );
    });

    it('rejects a plain function with no providesFor, also as handler', async () => {
      await rejects(base({ handler: async () => ({}) }), /handler does not declare providesFor.*createHandler/);
    });

    it('rejects two entries whose providesFor collide after normalizing the mode', async () => {
      const a = stubHandler('OpenAI', 'messages');
      const b = stubHandler('OpenAI', 'messages');
      (b.providesFor as unknown as string[])[1] = 'completion';
      await rejects(base({ handler: undefined, handlers: [a, b] }), /provider 'OpenAI' in mode 'messages'/);
    });
  });

  describe('generation', () => {
    it('requires a generation source', async () => {
      await rejects(base({ generation: undefined }), /Pass generation, or aiConfig/);
    });

    it('requires provider and model', async () => {
      await rejects(base({ generation: completion({ provider: '' }) }), /generation.provider is required/);
      await rejects(base({ generation: completion({ model: undefined }) }), /generation.model is required/);
    });

    it('requires a mode, with no default', async () => {
      await rejects(
        base({ generation: completion({ mode: undefined }) }),
        /^generation.mode is required. Set it to 'completion' or 'agent'.$/,
      );
    });

    it.each([
      'messages',
      'judge',
      'Agent',
      'agnet',
    ])('rejects mode %j, naming it and the permitted values', async (mode) => {
      await rejects(
        base({ generation: completion({ mode }) }),
        new RegExp(`generation.mode must be 'completion' or 'agent', got "${mode}"`),
      );
    });

    it('rejects instructions and messages together', async () => {
      await rejects(
        base({ generation: completion({ instructions: 'be nice' }) }),
        /instructions and generation.messages/,
      );
    });

    it('requires a handler for the generation provider and mode, listing the pool', async () => {
      const pool = { handler: stubHandler('OpenAI', 'agent') };
      const err = await makeModule(api)
        .run(base({ ...pool }))
        .catch((e: Error) => e);
      expect(err.message).toMatch(/provider 'OpenAI' in mode 'messages'/);
      expect(err.message).toContain('[OpenAI, agent]');
      expect(err.message).toMatch(/'completion'.*'messages'.*'agent'/);
      expect(api.calls).toEqual([]);
    });

    it('rejects instructions for a messages handler', async () => {
      await rejects(
        base({ generation: completion({ messages: undefined, instructions: 'hi' }) }),
        /needs messages, not instructions.*\[OpenAI, messages\].*messages handler/,
      );
    });

    it('rejects messages for an agent handler', async () => {
      await rejects(
        base({ handler: stubHandler('OpenAI', 'agent'), generation: completion({ mode: 'agent' }) }),
        /needs instructions, not messages.*\[OpenAI, agent\].*agent handler/,
      );
    });

    it('accepts a prompt with neither field in both modes', async () => {
      const messages = routeHostedRun(new FakeApi());
      await makeModule(messages).run(base({ generation: completion({ messages: undefined }), pollIntervalSeconds: 0 }));
      expect(messages.sequence).toContain('POST projects/proj/evaluations');
      const agent = routeHostedRun(new FakeApi());
      await makeModule(agent).run(
        base({
          handler: stubHandler('OpenAI', 'agent'),
          generation: completion({ mode: 'agent', messages: undefined }),
          pollIntervalSeconds: 0,
        }),
      );
      expect(agent.sequence).toContain('POST projects/proj/evaluations');
    });
  });

  it.each([0, -1, 1.5])('rejects concurrency %j', async (concurrency) => {
    await rejects(base({ concurrency }), /concurrency/);
  });

  describe.each(['pollIntervalSeconds', 'pollTimeoutSeconds'])('%s', (name) => {
    it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])('rejects %j', async (value) => {
      await rejects(base({ [name]: value }), new RegExp(name));
    });
  });

  describe('tools', () => {
    const fn = () => 'x';

    it('rejects an entry that is not an EvalTool', async () => {
      await rejects(base({ tools: [fn] }), /must be an EvalTool/);
    });

    it('rejects a blank key', async () => {
      await rejects(base({ tools: [new EvalTool(' ', fn, {})] }), /tool keys must not be blank/);
    });

    it('rejects an uppercase key, naming its lowercase form', async () => {
      await rejects(base({ tools: [new EvalTool('Lookup', fn, {})] }), /'Lookup'.*'lookup'/);
    });

    it('rejects an implementation that is not callable', async () => {
      await rejects(
        base({ tools: [new EvalTool('lookup', 'nope' as never, {})] }),
        /'lookup' implementation must be callable/,
      );
    });

    it('rejects a NativeTool as an inline implementation', async () => {
      const native = new NativeTool(Symbol('s'), 'WebSearch');
      await rejects(base({ tools: [new EvalTool('search', native, {})] }), /'search'.*NativeTool.*no schema to define/);
    });

    it.each([
      ['a string', 'schema'],
      ['a list', []],
      ['a number', 3],
      ['null', null],
    ])('rejects a schema that is %s, naming the key and type', async (_name, schema) => {
      await rejects(
        base({ tools: [new EvalTool('lookup', fn, schema as never)] }),
        /'lookup' schema must be a JSON object/,
      );
    });

    it('rejects a non-string description', async () => {
      await rejects(
        base({ tools: [new EvalTool('lookup', fn, {}, 4 as never)] }),
        /'lookup' description must be a string/,
      );
    });

    it.each([
      ['NaN', { type: 'number', default: Number.NaN }],
      ['Infinity', { maximum: Number.POSITIVE_INFINITY }],
      ['a nested Date', { properties: { at: { default: new Date() } } }],
    ])('rejects a schema holding %s, naming the tool', async (_name, schema) => {
      await rejects(base({ tools: [new EvalTool('lookup', fn, schema)] }), /'lookup' schema must be JSON-serializable/);
    });

    it('rejects a key listed twice', async () => {
      await rejects(
        base({ tools: [new EvalTool('lookup', fn, {}), new EvalTool('lookup', fn, {})] }),
        /'lookup'.*appear once/,
      );
    });

    it('rejects keys equal under case folding, naming both keys and sources', async () => {
      await rejects(
        base({ tools: [new EvalTool('straße', fn, {}), new EvalTool('strasse', fn, {})] }),
        /'strasse' \(inline\) collides with 'straße' \(inline\)/,
      );
    });

    it('rejects a library and an inline entry with one key, naming both sources', async () => {
      const tools = new FakeApi().on('GET', `projects/${PROJECT}/ai-tools/lookup`, { body: { version: 2 } });
      const library = await makeModule(tools).tools.get('lookup', { implementation: fn });
      await rejects(base({ tools: [library, new EvalTool('lookup', fn, {})] }), /\(inline\).*\(library\)/);
    });

    it('rejects a library tool read for another project', async () => {
      const other = new FakeApi().on('GET', 'projects/other/ai-tools/lookup', { body: { version: 2 } });
      const tool = await makeModule(other, { projectKey: 'other' }).tools.get('lookup', { implementation: fn });
      await rejects(base({ tools: [tool] }), /'lookup'.*'other'.*'proj'/);
    });

    it('cannot construct a library tool', () => {
      const tool = new EvalTool('lookup', fn, {});
      expect(tool.source).toBe('inline');
      expect(tool.version).toBeUndefined();
      expect(Object.isFrozen(tool)).toBe(true);
    });

    it('holds its own copy of the schema', () => {
      const schema = { type: 'object', properties: { id: { type: 'string' } } };
      const tool = new EvalTool('lookup', fn, schema);
      schema.properties.id.type = 'number';
      expect(tool.schema).toEqual({ type: 'object', properties: { id: { type: 'string' } } });
    });
  });

  describe('criteria', () => {
    it('rejects a judge key and a scorer name that collide, naming the duplicate', async () => {
      await rejects(base({ criteria: [new Judge('accuracy'), new Scorer('accuracy', () => 1)] }), /'accuracy'/);
    });

    it('rejects identities that collide only by case', async () => {
      await rejects(
        base({ criteria: [new Judge('Accuracy'), new Scorer('accuracy', () => 1)] }),
        /Duplicate.*'accuracy'/,
      );
    });

    it('rejects an entry that is not a Judge or a Scorer', async () => {
      await rejects(base({ criteria: [{ key: 'accuracy' }] }), /must be a Judge or a Scorer/);
    });

    it('rejects criteria that is not an array', async () => {
      await rejects(base({ criteria: new Judge('accuracy') }), /criteria must be an array/);
    });
  });

  describe('aiConfig', () => {
    const aiBase = (aiConfig: unknown, generation?: unknown) =>
      ({ key: 'eval-key', dataset: 'ds', handler: stubHandler(), aiConfig, generation }) as RunOptions;

    it.each([
      [{ key: ' ', variation: 'v' }, /aiConfig.key must not be blank/],
      [{ key: 'c', variation: '' }, /aiConfig.variation must not be blank/],
    ])('rejects %j', async (aiConfig, message) => {
      await rejects(aiBase(aiConfig), message);
    });

    it('rejects a mode in the overrides', async () => {
      await rejects(aiBase({ key: 'c', variation: 'v' }, { mode: 'agent' }), /the AI Config supplies the mode/);
    });
  });
});

// ---------------------------------------------------------------------------
// tools.get()
// ---------------------------------------------------------------------------

describe('tools.get()', () => {
  const path = `projects/${PROJECT}/ai-tools/lookup`;

  it('pins the version and reads the description and schema', async () => {
    const api = new FakeApi().on('GET', path, {
      body: { version: 4, description: 'Find', schema: { type: 'object' } },
    });
    const tool = await makeModule(api).tools.get('lookup', { implementation: () => 1 });
    expect(tool).toMatchObject({
      key: 'lookup',
      source: 'library',
      version: 4,
      description: 'Find',
      projectKey: PROJECT,
    });
    expect(tool.schema).toEqual({ type: 'object' });
  });

  it('defaults a missing description and schema', async () => {
    const api = new FakeApi().on('GET', path, { body: { version: 1, schema: 'nope' } });
    const tool = await makeModule(api).tools.get('lookup', { implementation: () => 1 });
    expect(tool.description).toBe('');
    expect(tool.schema).toEqual({});
  });

  it('requires an integer version', async () => {
    const api = new FakeApi().on('GET', path, { body: { description: 'x' } });
    await expect(makeModule(api).tools.get('lookup', { implementation: () => 1 })).rejects.toThrow(/integer version/);
  });

  it('names the key and project on a 404, after one request', async () => {
    const api = new FakeApi().on('GET', path, { status: 404, body: 'not found' });
    await expect(makeModule(api).tools.get('lookup', { implementation: () => 1 })).rejects.toThrow(
      /'lookup' was not found in project 'proj'/,
    );
    expect(api.calls).toHaveLength(1);
  });

  it('checks the key and implementation before its request', async () => {
    const api = new FakeApi();
    const evals = makeModule(api);
    await expect(evals.tools.get('Lookup', { implementation: () => 1 })).rejects.toThrow(/'lookup'/);
    await expect(evals.tools.get(' ', { implementation: () => 1 })).rejects.toThrow(/must not be blank/);
    await expect(evals.tools.get('lookup', { implementation: 3 as never })).rejects.toThrow(/must be callable/);
    expect(api.calls).toEqual([]);
  });

  it('accepts a NativeTool implementation', async () => {
    const api = new FakeApi().on('GET', path, { body: { version: 1 } });
    const native = new NativeTool(Symbol('s'), 'WebSearch');
    const tool = await makeModule(api).tools.get('lookup', { implementation: native });
    expect(tool.implementation).toBe(native);
  });
});

it('EvaluationsError is the error the harness throws', () => {
  expect(new EvaluationsError('x')).toBeInstanceOf(Error);
});
