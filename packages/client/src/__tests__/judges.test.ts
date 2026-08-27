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

import { isFiniteScore, runJudges } from '../judges.js';
import type { ProviderHandler } from '../types.js';

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
});

describe('judge score validation', () => {
  it('only treats a finite number as a recordable score', () => {
    // A judge is prompted for a number but can return anything; OTel drops a null attribute and
    // exports a string, which breaks numeric aggregation on gen_ai.evaluation.score.value.
    for (const junk of [null, undefined, '0.9', '85%', {}, [], Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(isFiniteScore(junk)).toBe(false);
    }
    for (const ok of [0, 0.9, 1, -1]) {
      expect(isFiniteScore(ok)).toBe(true);
    }
  });
});
