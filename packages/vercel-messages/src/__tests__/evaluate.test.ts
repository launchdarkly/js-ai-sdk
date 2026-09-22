import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const aiMocks = vi.hoisted(() => ({
  experimental_evaluate: vi.fn(),
}));

vi.mock('ai', () => ({
  experimental_evaluate: aiMocks.experimental_evaluate,
}));

const serverMocks = vi.hoisted(() => ({
  inspectConfig: vi.fn(),
  getClient: vi.fn(),
  track: vi.fn(),
}));

vi.mock('@launchdarkly/ai-server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@launchdarkly/ai-server')>();
  return {
    ...actual,
    inspectConfig: serverMocks.inspectConfig,
    getClient: serverMocks.getClient,
  };
});

const spanMocks = vi.hoisted(() => {
  const makeSpan = () => ({
    addEvent: vi.fn(),
    end: vi.fn(),
    recordException: vi.fn(),
    setAttribute: vi.fn(),
    setStatus: vi.fn(),
  });
  return {
    makeSpan,
    root: makeSpan(),
    startActiveSpan: vi.fn(),
  };
});

vi.mock('@opentelemetry/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@opentelemetry/api')>();
  return {
    ...actual,
    trace: {
      ...actual.trace,
      getTracer: vi.fn(() => ({
        startActiveSpan: spanMocks.startActiveSpan.mockImplementation((_name: string, fn: Function) =>
          fn(spanMocks.root),
        ),
      })),
    },
  };
});

import { vercelEvaluate } from '../evaluate.js';

const questions = {
  refunded: { type: 'boolean' as const, instructions: 'Was a refund issued?' },
};

const config = {
  model: { name: 'typesafe-ai/jev' },
  provider: { name: 'TypeSafe' },
};

const meta = { enabled: true, variationKey: 'var-1', version: 3, modelKey: 'mk', modelVersion: 2 };

const context = { kind: 'user' as const, key: 'user-1' };

function evaluationResult() {
  return {
    answers: { refunded: { type: 'boolean', probability: 0.99 } },
    usage: { inputTokens: 8, outputTokens: 3, totalTokens: 11 },
    warnings: [],
    response: { id: 'resp-1' },
  };
}

describe('vercelEvaluate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    spanMocks.root = spanMocks.makeSpan();
    serverMocks.getClient.mockReturnValue({ track: serverMocks.track });
    serverMocks.inspectConfig.mockResolvedValue({ enabled: true, config, meta });
    aiMocks.experimental_evaluate.mockResolvedValue(evaluationResult());
  });

  it('throws before calling the SDK when questions are missing or empty', async () => {
    await expect(vercelEvaluate('flag', 'state', context, {} as any)).rejects.toThrow(/questions/i);
    await expect(vercelEvaluate('flag', 'state', context, { questions: {} })).rejects.toThrow(/questions/i);
    expect(aiMocks.experimental_evaluate).not.toHaveBeenCalled();
    expect(serverMocks.inspectConfig).not.toHaveBeenCalled();
  });

  it('passes the gateway model id unchanged', async () => {
    const result = await vercelEvaluate('refund-classifier', 'issued a refund', context, { questions });
    expect(serverMocks.inspectConfig).toHaveBeenCalledWith('refund-classifier', context);
    expect(aiMocks.experimental_evaluate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'typesafe-ai/jev',
        state: 'issued a refund',
        questions,
      }),
    );
    expect(result.answers).toEqual(evaluationResult().answers);
    expect(result.usage).toEqual({ input: 8, output: 3, total: 11 });
    expect(result.warnings).toEqual([]);
    expect(result.response).toEqual({ id: 'resp-1' });
    expect(result.trackData).toEqual(
      expect.objectContaining({
        configKey: 'refund-classifier',
        variationKey: 'var-1',
        version: 3,
        modelName: 'typesafe-ai/jev',
        providerName: 'TypeSafe',
        modelKey: 'mk',
        modelVersion: 2,
      }),
    );
  });

  it('builds a Gateway creator/model id for an unqualified evaluation model', async () => {
    serverMocks.inspectConfig.mockResolvedValue({
      enabled: true,
      config: { model: { name: 'jev' }, provider: { name: 'TypeSafe' } },
      meta,
    });
    await vercelEvaluate('flag', 'state', context, { questions });
    expect(aiMocks.experimental_evaluate).toHaveBeenCalledWith(expect.objectContaining({ model: 'typesafe-ai/jev' }));
  });

  it('uses an injected model instead of the gateway string', async () => {
    const model = { specificationVersion: 'v4', provider: 'openai', modelId: 'gpt-5.6-luna' };
    await vercelEvaluate('flag', { message: 'hi' }, context, { questions, model } as any);
    expect(aiMocks.experimental_evaluate).toHaveBeenCalledWith(expect.objectContaining({ model }));
  });

  it('calls a model factory once with the evaluated config', async () => {
    const model = { modelId: 'factory-eval' };
    const modelFactory = vi.fn().mockResolvedValue(model);
    await vercelEvaluate('flag', 'state', context, { questions, modelFactory } as any);
    expect(modelFactory).toHaveBeenCalledOnce();
    expect(modelFactory).toHaveBeenCalledWith(config);
    expect(aiMocks.experimental_evaluate).toHaveBeenCalledWith(expect.objectContaining({ model }));
  });

  it('forwards optional evaluate request fields', async () => {
    const abortSignal = new AbortController().signal;
    await vercelEvaluate('flag', 'state', context, {
      questions,
      maxRetries: 1,
      abortSignal,
      headers: { 'x-test': '1' },
      providerOptions: { openai: { reasoningEffort: 'high' } },
    });
    expect(aiMocks.experimental_evaluate).toHaveBeenCalledWith(
      expect.objectContaining({
        maxRetries: 1,
        abortSignal,
        headers: { 'x-test': '1' },
        providerOptions: { openai: { reasoningEffort: 'high' } },
      }),
    );
  });

  it('uses evaluated provider telemetry, preserves the model id, and disables runtime telemetry', async () => {
    await vercelEvaluate('flag', 'state', context, { questions });
    expect(spanMocks.startActiveSpan).toHaveBeenCalledWith('evaluate', expect.any(Function));
    expect(spanMocks.root.setAttribute).toHaveBeenCalledWith('gen_ai.operation.name', 'evaluate');
    expect(spanMocks.root.setAttribute).toHaveBeenCalledWith('gen_ai.system', 'typesafe');
    expect(spanMocks.root.setAttribute).toHaveBeenCalledWith('gen_ai.provider.name', 'typesafe');
    expect(spanMocks.root.setAttribute).toHaveBeenCalledWith('gen_ai.request.model', 'typesafe-ai/jev');
    expect(aiMocks.experimental_evaluate.mock.calls[0][0]).not.toHaveProperty('telemetry');
    expect(aiMocks.experimental_evaluate.mock.calls[0][0]).not.toHaveProperty('experimental_telemetry');
  });

  it('records state, questions, and answers when captureContent is on', async () => {
    await vercelEvaluate('flag', 'issued a refund', context, { questions, captureContent: true });
    expect(spanMocks.root.setAttribute).toHaveBeenCalledWith(
      'gen_ai.input.messages',
      expect.stringContaining('issued a refund'),
    );
    expect(spanMocks.root.setAttribute).toHaveBeenCalledWith(
      'gen_ai.output.messages',
      expect.stringContaining('refunded'),
    );
  });

  it('tracks success, duration, and token events', async () => {
    await vercelEvaluate('flag', 'state', context, { questions });
    const names = serverMocks.track.mock.calls.map((call) => call[0]);
    expect(names).toContain('$ld:ai:generation:success');
    expect(names).toContain('$ld:ai:duration:total');
    expect(names).toContain('$ld:ai:tokens:total');
    expect(names).toContain('$ld:ai:tokens:input');
    expect(names).toContain('$ld:ai:tokens:output');
    expect(names).not.toContain('$ld:ai:generation:error');
  });

  it('tracks an error and rethrows when evaluate fails', async () => {
    aiMocks.experimental_evaluate.mockRejectedValue(new Error('gateway down'));
    await expect(vercelEvaluate('flag', 'state', context, { questions })).rejects.toThrow('gateway down');
    const names = serverMocks.track.mock.calls.map((call) => call[0]);
    expect(names).toContain('$ld:ai:generation:error');
    expect(names).not.toContain('$ld:ai:generation:success');
  });

  it('throws when the AI Config is disabled', async () => {
    serverMocks.inspectConfig.mockResolvedValue({ enabled: false, config: null, meta: null });
    await expect(vercelEvaluate('missing', 'state', context, { questions })).rejects.toThrow(/not enabled/i);
    expect(aiMocks.experimental_evaluate).not.toHaveBeenCalled();
  });

  it('does not import provider-native AI SDK packages', () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'evaluate.ts'), 'utf8');
    expect(source).not.toMatch(/@ai-sdk\/(openai|anthropic|amazon-bedrock|google)/);
    expect(source).not.toMatch(/from ['"]openai['"]/);
    expect(source).not.toMatch(/from ['"]@anthropic-ai/);
  });
});
