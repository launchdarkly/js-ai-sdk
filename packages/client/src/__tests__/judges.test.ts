import { beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Hoisted mocks ────────────────────────────────────────────────────────────

const { mockExecuteAndTrack, mockExtractVariation, mockGetClient } = vi.hoisted(() => ({
  mockExecuteAndTrack: vi.fn(),
  mockExtractVariation: vi.fn(),
  mockGetClient: vi.fn().mockReturnValue({ track: vi.fn() }),
}));

vi.mock('../tracking.js', () => ({
  executeAndTrack: mockExecuteAndTrack,
}));

vi.mock('../lifecycle.js', () => ({
  extractVariation: mockExtractVariation,
  getClient: mockGetClient,
  initClient: vi.fn().mockResolvedValue(undefined),
  shutdown: vi.fn(),
  waitForTelemetry: vi.fn(),
  shutdownTelemetry: vi.fn(),
}));

import { numericScore } from '../judge-scoring.js';
import { buildJudgeTasks, runJudge, runJudges } from '../judges.js';
import type { JudgeTask, ProviderHandler } from '../types.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const mockContext = { kind: 'user' as const, key: 'user-1' };

const mockJudgeConfig = {
  model: { name: 'gpt-4o' },
  provider: { name: 'OpenAI' },
  instructions: 'You are a judge.',
  evaluationMetricKey: 'judge-metric',
};

const mockJudgeMeta = {
  enabled: true,
  variationKey: 'v1',
  version: 1,
  mode: 'messages' as const,
};

function makeHandler(): ProviderHandler {
  const h: ProviderHandler = vi.fn().mockResolvedValue({ output: '{"score":0.9,"reasoning":"ok"}', usage: {} });
  h.providesFor = ['OpenAI', 'messages'];
  return h;
}

const baseTrackData = { variationKey: 'v1', configKey: 'main-flag', version: 1 };

// ─── runJudges ─────────────────────────────────────────────────────────────────

describe('runJudges', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExtractVariation.mockResolvedValue({ config: mockJudgeConfig, meta: mockJudgeMeta });
    mockExecuteAndTrack.mockResolvedValue({
      usage: { input: 1, output: 1, total: 2 },
      response: '{"score":0.9,"reasoning":"good"}',
      trackData: baseTrackData,
    });
  });

  it('returns an empty object when judgeConfiguration is absent', async () => {
    const config = {
      model: { name: 'gpt-4o' },
      provider: { name: 'OpenAI' },
      instructions: 'You are helpful.',
    };
    const result = await runJudges({
      config,
      userContext: mockContext,
      handler: makeHandler(),
      userInput: 'hello',
      llmResponse: 'world',
      baseTrackData,
    });
    expect(result).toEqual({});
    expect(mockExecuteAndTrack).not.toHaveBeenCalled();
  });

  it('returns an empty object when all judges have samplingRate 0', async () => {
    const config = {
      model: { name: 'gpt-4o' },
      provider: { name: 'OpenAI' },
      instructions: 'You are helpful.',
      judgeConfiguration: { judges: [{ key: 'judge-flag', samplingRate: 0 }] },
    };
    const result = await runJudges({
      config,
      userContext: mockContext,
      handler: makeHandler(),
      userInput: 'hello',
      llmResponse: 'world',
      baseTrackData,
    });
    expect(result).toEqual({});
    expect(mockExecuteAndTrack).not.toHaveBeenCalled();
  });

  it('uses a wildcard agent handler when no exact messages handler is registered, and collapses messages to instructions', async () => {
    const judgeConfigWithMessages = {
      model: { name: 'claude-3-5-sonnet' },
      provider: { name: 'Anthropic' },
      messages: [
        { role: 'system', content: 'You are a judge.' },
        { role: 'user', content: 'Evaluate this.' },
      ],
    };
    mockExtractVariation.mockResolvedValue({
      config: judgeConfigWithMessages,
      meta: { ...mockJudgeMeta, mode: 'judge' },
    });

    const wildcardAgentHandler: ProviderHandler = vi
      .fn()
      .mockResolvedValue({ output: '{"score":0.8,"reasoning":"ok"}', usage: {} });
    wildcardAgentHandler.providesFor = ['*', 'agent'];

    const parentHandler = makeHandler();

    const config = {
      model: { name: 'gpt-4o' },
      provider: { name: 'OpenAI' },
      instructions: 'Be helpful.',
      judgeConfiguration: { judges: [{ key: 'judge-flag', samplingRate: 1 }] },
    };

    await runJudges({
      config,
      userContext: mockContext,
      handler: parentHandler,
      handlers: [wildcardAgentHandler],
      userInput: 'hello',
      llmResponse: 'world',
      baseTrackData,
    });

    expect(mockExecuteAndTrack).toHaveBeenCalled();
    const callArgs = mockExecuteAndTrack.mock.calls[0][0];
    // Agent handler should be selected, and messages collapsed to instructions
    expect(callArgs.handler).toBe(wildcardAgentHandler);
    expect(callArgs.config.instructions).toBeTruthy();
    expect(callArgs.config.messages).toHaveLength(0);
  });

  it('prefers an exact provider handler over an earlier wildcard', async () => {
    mockExtractVariation.mockResolvedValue({
      config: { ...mockJudgeConfig, provider: { name: 'TypeSafe' }, model: { name: 'jev' } },
      meta: mockJudgeMeta,
    });
    const wildcard: ProviderHandler = vi
      .fn()
      .mockResolvedValue({ output: '{"score":0.1,"reasoning":"no"}', usage: {} });
    wildcard.providesFor = ['*', 'messages'];
    const typesafe: ProviderHandler = vi
      .fn()
      .mockResolvedValue({ output: '{"score":0.5,"reasoning":"ok"}', usage: {} });
    typesafe.providesFor = ['TypeSafe', 'messages'];

    await runJudges({
      config: {
        model: { name: 'gpt-4o' },
        provider: { name: 'OpenAI' },
        instructions: 'Be helpful.',
        judgeConfiguration: { judges: [{ key: 'jev', samplingRate: 1 }] },
      },
      userContext: mockContext,
      handler: wildcard,
      handlers: [wildcard, typesafe],
      userInput: 'question',
      llmResponse: 'answer',
      baseTrackData,
    });

    expect(mockExecuteAndTrack).toHaveBeenCalledWith(expect.objectContaining({ handler: typesafe }));
    expect(wildcard).not.toHaveBeenCalled();
  });

  it('uses an exact agent handler for the same provider when no messages handler is registered, and collapses messages', async () => {
    const judgeConfigWithMessages = {
      model: { name: 'claude-3-5-sonnet' },
      provider: { name: 'Anthropic' },
      messages: [{ role: 'user', content: 'Judge this response.' }],
    };
    mockExtractVariation.mockResolvedValue({
      config: judgeConfigWithMessages,
      meta: { ...mockJudgeMeta, mode: 'judge' },
    });

    const claudeAgentHandler: ProviderHandler = vi
      .fn()
      .mockResolvedValue({ output: '{"score":0.7,"reasoning":"ok"}', usage: {} });
    claudeAgentHandler.providesFor = ['Anthropic', 'agent'];

    const config = {
      model: { name: 'claude-3-5-sonnet' },
      provider: { name: 'Anthropic' },
      instructions: 'Be helpful.',
      judgeConfiguration: { judges: [{ key: 'judge-flag', samplingRate: 1 }] },
    };

    await runJudges({
      config,
      userContext: mockContext,
      handler: claudeAgentHandler,
      handlers: [claudeAgentHandler],
      userInput: 'hello',
      llmResponse: 'world',
      baseTrackData,
    });

    expect(mockExecuteAndTrack).toHaveBeenCalled();
    const callArgs = mockExecuteAndTrack.mock.calls[0][0];
    expect(callArgs.handler).toBe(claudeAgentHandler);
    expect(callArgs.config.instructions).toBe('Judge this response.');
    expect(callArgs.config.messages).toHaveLength(0);
  });

  it('prefers an exact messages handler over an agent handler fallback', async () => {
    const agentHandler: ProviderHandler = vi.fn().mockResolvedValue({ output: '{"score":0.5}', usage: {} });
    agentHandler.providesFor = ['OpenAI', 'agent'];

    const messagesHandler = makeHandler(); // ['OpenAI', 'messages']

    const config = {
      model: { name: 'gpt-4o' },
      provider: { name: 'OpenAI' },
      instructions: 'Be helpful.',
      judgeConfiguration: { judges: [{ key: 'judge-flag', samplingRate: 1 }] },
    };

    await runJudges({
      config,
      userContext: mockContext,
      handler: messagesHandler,
      handlers: [agentHandler, messagesHandler],
      userInput: 'hello',
      llmResponse: 'world',
      baseTrackData,
    });

    expect(mockExecuteAndTrack).toHaveBeenCalled();
    const callArgs = mockExecuteAndTrack.mock.calls[0][0];
    expect(callArgs.handler).toBe(messagesHandler);
    // No collapse when exact messages handler is used
    expect(callArgs.config).toBe(mockJudgeConfig);
  });

  it('skips a judge when no compatible handler is found (mismatched provider, no wildcard)', async () => {
    const openaiHandler = makeHandler(); // ['OpenAI', 'messages']
    mockExtractVariation.mockResolvedValue({
      config: { ...mockJudgeConfig, provider: { name: 'Anthropic' } },
      meta: mockJudgeMeta,
    });

    const config = {
      model: { name: 'gpt-4o' },
      provider: { name: 'OpenAI' },
      instructions: 'Be helpful.',
      judgeConfiguration: { judges: [{ key: 'judge-flag', samplingRate: 1 }] },
    };

    await runJudges({
      config,
      userContext: mockContext,
      handler: openaiHandler,
      handlers: [openaiHandler],
      userInput: 'hello',
      llmResponse: 'world',
      baseTrackData,
    });

    // Judge should be skipped — OpenAI handler cannot service Anthropic judge
    expect(mockExecuteAndTrack).not.toHaveBeenCalled();
  });

  it('does not forward toolHandlers to judge executeAndTrack calls', async () => {
    const config = {
      model: { name: 'gpt-4o' },
      provider: { name: 'OpenAI' },
      instructions: 'You are helpful.',
      judgeConfiguration: { judges: [{ key: 'judge-flag', samplingRate: 1 }] },
    };
    const userToolHandlers = { myTool: vi.fn(), anotherTool: vi.fn() };

    await runJudges({
      config,
      userContext: mockContext,
      handler: makeHandler(),
      userInput: 'hello',
      llmResponse: 'world',
      baseTrackData,
      toolHandlers: userToolHandlers,
    });

    expect(mockExecuteAndTrack).toHaveBeenCalled();
    const callArgs = mockExecuteAndTrack.mock.calls[0][0];
    // toolHandlers must NOT be forwarded to the judge — judges are evaluators only.
    expect(callArgs.toolHandlers).toBeUndefined();
  });

  // ─── A judge's own config failing must not fail the run ────────────────────
  //
  // By the time judges run, the provider call is finished and billed. A judge
  // whose AI Config cannot be resolved — most often because it was toggled off
  // in LaunchDarkly — must be skipped, not allowed to discard that response.

  it('skips a judge whose AI Config is disabled instead of throwing', async () => {
    mockExtractVariation.mockRejectedValue(new Error('Variation judge-flag is not enabled'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const config = {
      model: { name: 'gpt-4o' },
      provider: { name: 'OpenAI' },
      instructions: 'Be helpful.',
      judgeConfiguration: { judges: [{ key: 'judge-flag', samplingRate: 1 }] },
    };

    const results = await runJudges({
      config,
      userContext: mockContext,
      handler: makeHandler(),
      userInput: 'hello',
      llmResponse: 'world',
      baseTrackData,
    });

    expect(results).toEqual({});
    expect(mockExecuteAndTrack).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith("Judge 'judge-flag' skipped:", 'Variation judge-flag is not enabled');

    consoleError.mockRestore();
  });

  it('still runs the judges it can resolve when another one is disabled', async () => {
    mockExtractVariation.mockImplementation((key: string) => {
      if (key === 'disabled-judge') {
        return Promise.reject(new Error('Variation disabled-judge is not enabled'));
      }
      return Promise.resolve({ config: mockJudgeConfig, meta: mockJudgeMeta });
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const config = {
      model: { name: 'gpt-4o' },
      provider: { name: 'OpenAI' },
      instructions: 'Be helpful.',
      judgeConfiguration: {
        judges: [
          { key: 'disabled-judge', samplingRate: 1 },
          { key: 'working-judge', samplingRate: 1 },
        ],
      },
    };

    const results = await runJudges({
      config,
      userContext: mockContext,
      handler: makeHandler(),
      userInput: 'hello',
      llmResponse: 'world',
      baseTrackData,
    });

    // The disabled judge is absent; the healthy one still produced a score.
    expect(Object.keys(results)).toEqual(['working-judge']);
    expect(results['working-judge']?.score).toBe(0.9);
    expect(mockExecuteAndTrack).toHaveBeenCalledTimes(1);

    consoleError.mockRestore();
  });
});

describe('runJudges strips outputFormat before it reaches a handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExtractVariation.mockResolvedValue({ config: mockJudgeConfig, meta: mockJudgeMeta });
    mockExecuteAndTrack.mockResolvedValue({
      usage: { input: 1, output: 1, total: 2 },
      response: '{"score":0.9,"reasoning":"good"}',
      trackData: baseTrackData,
    });
  });

  const config = {
    model: { name: 'gpt-4o' },
    provider: { name: 'OpenAI' },
    instructions: 'You are helpful.',
    judgeConfiguration: { judges: [{ key: 'judge-flag', samplingRate: 1 }] },
  };

  it('never forwards outputFormat to the handler, and the rest of the config is intact', async () => {
    const judgeConfigWithSchema = {
      ...mockJudgeConfig,
      outputFormat: { type: 'json_schema', properties: { message: { type: 'string' } } },
    };
    mockExtractVariation.mockResolvedValue({ config: judgeConfigWithSchema, meta: mockJudgeMeta });

    await runJudges({
      config,
      userContext: mockContext,
      handler: makeHandler(),
      userInput: 'hello',
      llmResponse: 'world',
      baseTrackData,
    });

    expect(mockExecuteAndTrack).toHaveBeenCalled();
    const sentConfig = mockExecuteAndTrack.mock.calls[0][0].config;
    expect(sentConfig.outputFormat).toBeUndefined();
    expect(sentConfig.model).toEqual(judgeConfigWithSchema.model);
    expect(sentConfig.provider).toEqual(judgeConfigWithSchema.provider);
    expect(sentConfig.instructions).toBe(judgeConfigWithSchema.instructions);
  });

  it('a judge whose config has an outputFormat still produces a score (this is what was broken)', async () => {
    const judgeConfigWithSchema = {
      ...mockJudgeConfig,
      outputFormat: { type: 'json_schema', properties: { message: { type: 'string' } } },
    };
    mockExtractVariation.mockResolvedValue({ config: judgeConfigWithSchema, meta: mockJudgeMeta });

    const result = await runJudges({
      config,
      userContext: mockContext,
      handler: makeHandler(),
      userInput: 'hello',
      llmResponse: 'world',
      baseTrackData,
    });

    expect(result['judge-flag'].score).toBe(0.9);
  });

  it('logs the reason exactly once per judge, naming the judge key, only when outputFormat was present', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const judgeConfigWithSchema = {
      ...mockJudgeConfig,
      outputFormat: { type: 'json_schema', properties: { message: { type: 'string' } } },
    };
    mockExtractVariation.mockResolvedValue({ config: judgeConfigWithSchema, meta: mockJudgeMeta });

    await runJudges({
      config,
      userContext: mockContext,
      handler: makeHandler(),
      userInput: 'hello',
      llmResponse: 'world',
      baseTrackData,
    });

    const warnings = warnSpy.mock.calls.filter((call) => String(call[0]).includes('ignoring outputFormat'));
    expect(warnings).toHaveLength(1);
    expect(String(warnings[0][0])).toContain('judge-flag');
    warnSpy.mockRestore();
  });

  it('does not log, and does not change behaviour, when outputFormat is absent', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await runJudges({
      config,
      userContext: mockContext,
      handler: makeHandler(),
      userInput: 'hello',
      llmResponse: 'world',
      baseTrackData,
    });

    const sentConfig = mockExecuteAndTrack.mock.calls[0][0].config;
    expect(sentConfig).toBe(mockJudgeConfig);
    const warnings = warnSpy.mock.calls.filter((call) => String(call[0]).includes('ignoring outputFormat'));
    expect(warnings).toHaveLength(0);
    warnSpy.mockRestore();
  });

  it('strips outputFormat AND collapses messages when falling back to an agent handler', async () => {
    const judgeConfigWithMessagesAndSchema = {
      model: { name: 'claude-3-5-sonnet' },
      provider: { name: 'Anthropic' },
      messages: [
        { role: 'system', content: 'You are a judge.' },
        { role: 'user', content: 'Evaluate this.' },
      ],
      outputFormat: { type: 'json_schema', properties: { message: { type: 'string' } } },
    };
    mockExtractVariation.mockResolvedValue({
      config: judgeConfigWithMessagesAndSchema,
      meta: { ...mockJudgeMeta, mode: 'judge' },
    });

    const wildcardAgentHandler: ProviderHandler = vi
      .fn()
      .mockResolvedValue({ output: '{"score":0.8,"reasoning":"ok"}', usage: {} });
    wildcardAgentHandler.providesFor = ['*', 'agent'];

    await runJudges({
      config,
      userContext: mockContext,
      handler: makeHandler(),
      handlers: [wildcardAgentHandler],
      userInput: 'hello',
      llmResponse: 'world',
      baseTrackData,
    });

    expect(mockExecuteAndTrack).toHaveBeenCalled();
    const sentConfig = mockExecuteAndTrack.mock.calls[0][0].config;
    expect(sentConfig.instructions).toBeTruthy();
    expect(sentConfig.messages).toHaveLength(0);
    expect(sentConfig.outputFormat).toBeUndefined();
  });
});

describe('buildJudgeTasks strips outputFormat from the stored JudgeTask', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExtractVariation.mockResolvedValue({ config: mockJudgeConfig, meta: mockJudgeMeta });
  });

  const config = {
    model: { name: 'gpt-4o' },
    provider: { name: 'OpenAI' },
    instructions: 'You are helpful.',
    judgeConfiguration: { judges: [{ key: 'judge-flag', samplingRate: 1 }] },
  };

  it('the stored judgeConfig has no outputFormat, and the drop is warned once', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const judgeConfigWithSchema = {
      ...mockJudgeConfig,
      outputFormat: { type: 'json_schema', properties: { message: { type: 'string' } } },
    };
    mockExtractVariation.mockResolvedValue({ config: judgeConfigWithSchema, meta: mockJudgeMeta });

    const tasks = await buildJudgeTasks({
      config,
      userContext: mockContext,
      handler: makeHandler(),
      llmResponse: 'world',
      baseTrackData,
    });

    expect(tasks).toHaveLength(1);
    expect(tasks[0].judgeConfig.outputFormat).toBeUndefined();
    expect(tasks[0].judgeConfig.model).toEqual(judgeConfigWithSchema.model);
    const warnings = warnSpy.mock.calls.filter((call) => String(call[0]).includes('ignoring outputFormat'));
    expect(warnings).toHaveLength(1);
    expect(String(warnings[0][0])).toContain('judge-flag');
    warnSpy.mockRestore();
  });
});

describe('runJudge strips outputFormat defensively from a possibly-legacy task', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecuteAndTrack.mockResolvedValue({
      usage: { input: 1, output: 1, total: 2 },
      response: '{"score":0.6,"reasoning":"fine"}',
      trackData: baseTrackData,
    });
  });

  it('strips outputFormat even though the task still carries it (as an older serialized task would)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const judgeConfigWithSchema = {
      ...mockJudgeConfig,
      outputFormat: { type: 'json_schema', properties: { message: { type: 'string' } } },
    };
    const handler = makeHandler();
    const task: JudgeTask = {
      configKey: 'judge-flag',
      judgeConfig: judgeConfigWithSchema,
      judgeMeta: mockJudgeMeta,
      actualOutput: 'world',
      userContext: mockContext,
      judgeProvider: 'OpenAI',
      judgeMode: 'messages',
      collapseMessages: false,
      parentTrackData: baseTrackData,
    };

    const result = await runJudge(task, [handler]);

    expect(mockExecuteAndTrack).toHaveBeenCalled();
    const sentConfig = mockExecuteAndTrack.mock.calls[0][0].config;
    expect(sentConfig.outputFormat).toBeUndefined();
    expect(sentConfig.model).toEqual(judgeConfigWithSchema.model);
    expect(result?.score).toBe(0.6);
    const warnings = warnSpy.mock.calls.filter((call) => String(call[0]).includes('ignoring outputFormat'));
    expect(warnings).toHaveLength(1);
    expect(String(warnings[0][0])).toContain('judge-flag');
    warnSpy.mockRestore();
  });
});

describe('judge score validation', () => {
  it('only treats a finite number as a recordable score', () => {
    // A judge is prompted for a number but can return anything; OTel drops a null attribute and
    // exports a string, which breaks numeric aggregation on gen_ai.evaluation.score.value.
    for (const junk of [null, undefined, '0.9', '85%', {}, [], Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(numericScore(junk)).toBeUndefined();
    }
    expect(numericScore(true)).toBeUndefined();
    for (const ok of [0, 0.9, 1, -1]) {
      expect(numericScore(ok)).toBe(ok);
    }
  });
});

// ─── runJudge result trackData ────────────────────────────────────────────────

describe('runJudge result trackData', () => {
  const makeTask = (parentTrackData: Record<string, unknown>): JudgeTask =>
    ({
      configKey: 'judge-key',
      judgeConfig: mockJudgeConfig,
      judgeMeta: mockJudgeMeta,
      actualOutput: 'response',
      userContext: mockContext,
      judgeProvider: 'OpenAI',
      judgeMode: 'messages',
      collapseMessages: false,
      parentTrackData,
    }) as JudgeTask;

  const parentTrackData = {
    runId: 'parent-run',
    configKey: 'main-flag',
    variationKey: 'v1',
    version: 1,
    modelName: 'gpt-4o',
    providerName: 'OpenAI',
    modelKey: 'parent-model',
    modelVersion: 7,
    graphKey: 'g1',
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the evaluated (parent) config identity, identical to the inline track payload', async () => {
    // The judge's own trackData differs on every identity key; none of it may leak into the result.
    mockExecuteAndTrack.mockResolvedValue({
      usage: { input: 1, output: 1, total: 2 },
      response: '{"score":0.9,"reasoning":"good"}',
      trackData: {
        runId: 'judge-run',
        configKey: 'judge-key',
        variationKey: 'j1',
        version: 3,
        modelName: 'claude',
        providerName: 'Anthropic',
        modelKey: 'judge-model',
        modelVersion: 2,
      },
    });
    mockExtractVariation.mockResolvedValue({ config: mockJudgeConfig, meta: mockJudgeMeta });
    const track = vi.fn();
    mockGetClient.mockReturnValue({ track });

    await runJudges({
      config: {
        model: { name: 'gpt-4o' },
        provider: { name: 'OpenAI' },
        instructions: 'Be helpful.',
        judgeConfiguration: { judges: [{ key: 'judge-key', samplingRate: 1 }] },
      },
      userContext: mockContext,
      handler: makeHandler(),
      llmResponse: 'response',
      baseTrackData: parentTrackData,
    });
    const inlineTrackData = track.mock.calls[0][2];

    const result = await runJudge(makeTask(parentTrackData), [makeHandler()]);
    expect(result!.trackData).toEqual({ ...parentTrackData, judgeConfigKey: 'judge-key' });
    expect(result!.trackData).toEqual(inlineTrackData);
  });
});

describe('typesafe judge results', () => {
  const payload = JSON.stringify({
    kind: 'typesafe',
    results: [
      {
        key: 'migration_intent',
        eventKey: '$ld:ai:judge:jev:migration_intent',
        score: 0.25,
        reason: 'Unclear',
      },
      { key: 'migration', eventKey: '$ld:ai:judge:jev:migration', score: 0.9, reason: 'Yes' },
    ],
  });
  const usage = { input: 100, output: 20, total: 120 };

  beforeEach(() => {
    vi.clearAllMocks();
    mockExtractVariation.mockResolvedValue({
      config: { ...mockJudgeConfig, provider: { name: 'TypeSafe' } },
      meta: mockJudgeMeta,
    });
    mockExecuteAndTrack.mockResolvedValue({
      usage,
      response: payload,
      trackData: baseTrackData,
    });
  });

  it('returns one result per label with full usage and tracks each eventKey', async () => {
    const track = vi.fn();
    mockGetClient.mockReturnValue({ track });
    const result = await runJudges({
      config: {
        model: { name: 'gpt-4o' },
        provider: { name: 'OpenAI' },
        instructions: 'Be helpful.',
        judgeConfiguration: { judges: [{ key: 'jev-judge', samplingRate: 1 }] },
      },
      userContext: mockContext,
      handler: makeHandler(),
      userInput: 'question',
      llmResponse: 'answer',
      baseTrackData,
    });

    expect(mockExecuteAndTrack).toHaveBeenCalledTimes(1);
    expect(mockExecuteAndTrack).toHaveBeenCalledWith(
      expect.objectContaining({
        variables: expect.objectContaining({ input: 'question', response_to_evaluate: 'answer' }),
      }),
    );
    expect(result['jev-judge.migration_intent']).toEqual({
      usage,
      response: 'Unclear',
      score: 0.25,
      eventKey: '$ld:ai:judge:jev:migration_intent',
    });
    expect(result['jev-judge.migration']).toEqual({
      usage,
      response: 'Yes',
      score: 0.9,
      eventKey: '$ld:ai:judge:jev:migration',
    });
    expect(track).toHaveBeenCalledTimes(2);
    expect(track).toHaveBeenCalledWith(
      '$ld:ai:judge:jev:migration_intent',
      mockContext,
      expect.objectContaining({ judgeConfigKey: 'jev-judge.migration_intent' }),
      0.25,
    );
    expect(track).toHaveBeenCalledWith(
      '$ld:ai:judge:jev:migration',
      mockContext,
      expect.objectContaining({ judgeConfigKey: 'jev-judge.migration' }),
      0.9,
    );
  });

  it('returns every label from runJudge and a metric for each eventKey', async () => {
    mockExecuteAndTrack.mockResolvedValue({
      usage,
      response: payload,
      trackData: { runId: 'judge-run', modelKey: 'judge-model', configKey: 'jev-judge' },
    });
    const handler: ProviderHandler = vi.fn();
    handler.providesFor = ['TypeSafe', 'messages'];
    const result = await runJudge(
      {
        configKey: 'jev-judge',
        judgeConfig: { ...mockJudgeConfig, provider: { name: 'TypeSafe' } },
        judgeMeta: mockJudgeMeta,
        actualOutput: 'answer',
        userInput: 'question',
        userContext: mockContext,
        judgeProvider: 'TypeSafe',
        judgeMode: 'messages',
        collapseMessages: false,
        parentTrackData: baseTrackData,
      },
      [handler],
    );
    expect(mockExecuteAndTrack).toHaveBeenCalledWith(
      expect.objectContaining({
        variables: expect.objectContaining({ input: 'question', response_to_evaluate: 'answer' }),
      }),
    );
    expect(result?.score).toBe(0.25);
    expect(result?.response).toBe('Unclear');
    expect(result?.eventKey).toBe('$ld:ai:judge:jev:migration_intent');
    expect(result?.usage).toEqual(usage);
    expect(result?.results?.['jev-judge.migration']).toEqual({
      usage,
      response: 'Yes',
      score: 0.9,
      eventKey: '$ld:ai:judge:jev:migration',
    });
    expect(result?.metrics).toEqual([
      {
        eventKey: '$ld:ai:judge:jev:migration_intent',
        score: 0.25,
        judgeConfigKey: 'jev-judge.migration_intent',
      },
      { eventKey: '$ld:ai:judge:jev:migration', score: 0.9, judgeConfigKey: 'jev-judge.migration' },
    ]);
    // The judge run's own identity must not replace the evaluated config.
    expect(result?.trackData).toEqual({
      ...baseTrackData,
      judgeConfigKey: 'jev-judge.migration_intent',
    });
  });
});
