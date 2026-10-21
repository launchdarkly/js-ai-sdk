import { beforeEach, describe, expect, it, vi } from 'vitest';

const { Agent, BedrockModel, agentInvoke, modelInstances } = vi.hoisted(() => {
  const agentInvoke = vi.fn();
  const modelInstances: Array<Record<string, unknown>> = [];
  const Agent = vi.fn(
    class {
      invoke = agentInvoke;
    },
  );
  const BedrockModel = vi.fn(
    class {
      client: unknown = { source: 'internal' };
      constructor(readonly options: Record<string, unknown>) {
        modelInstances.push(this as unknown as Record<string, unknown>);
      }
    },
  );
  return { Agent, BedrockModel, agentInvoke, modelInstances };
});

vi.mock('@strands-agents/sdk', () => ({
  Agent,
  BedrockModel,
  tool: vi.fn((definition) => definition),
}));

import { createBedrockAgentsHandler } from '../handler.js';

const baseConfig = {
  model: {
    name: 'anthropic.claude-sonnet-4-5',
    region: 'us',
    parameters: { maxTokens: 512, temperature: 0.1 },
    custom: { mustNeverLeak: 'sentinel' },
  },
  provider: { name: 'Bedrock' },
  instructions: 'Help {{name}}.',
};

function result(text = 'done') {
  return {
    lastMessage: { role: 'assistant', content: [{ text }] },
    metrics: {
      accumulatedUsage: { inputTokens: 11, outputTokens: 4, totalTokens: 15 },
    },
  };
}

describe('createBedrockAgentsHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    modelInstances.length = 0;
    agentInvoke.mockResolvedValue(result());
  });

  it('routes as a Bedrock agent', () => {
    expect(createBedrockAgentsHandler().providesFor).toEqual(['Bedrock', 'agent']);
  });

  it('constructs a Strands BedrockModel with prefixed model id', async () => {
    const handler = createBedrockAgentsHandler();

    const output = await handler(baseConfig as any, 'hello', {}, { name: 'Ada' });

    const modelOptions = BedrockModel.mock.calls[0][0];
    expect(modelOptions.modelId).toBe('us.anthropic.claude-sonnet-4-5');
    expect(modelOptions.maxTokens).toBe(512);
    expect(modelOptions.temperature).toBe(0.1);
    expect(JSON.stringify(modelOptions)).not.toContain('mustNeverLeak');
    expect(Agent.mock.calls[0][0]).toMatchObject({
      model: modelInstances[0],
      systemPrompt: 'Help Ada.',
    });
    expect(agentInvoke).toHaveBeenCalledWith('hello');
    expect(output).toEqual({
      output: 'done',
      usage: { input_tokens: 11, output_tokens: 4, total_tokens: 15 },
    });
  });

  it('does not double-prepend when model.name already starts with the matching region', async () => {
    const config = {
      ...baseConfig,
      model: { ...baseConfig.model, region: 'us', name: 'us.anthropic.claude-sonnet-4-5' },
    };

    await createBedrockAgentsHandler()(config as any, 'hello');

    const modelId = BedrockModel.mock.calls[0][0].modelId;
    expect(modelId).toBe('us.anthropic.claude-sonnet-4-5');
    expect(modelId).not.toBe('us.us.anthropic.claude-sonnet-4-5');
  });

  it('merges modelOptions but keeps modelId authoritative', async () => {
    const modelOptions = vi.fn().mockReturnValue({
      modelId: 'wrong',
      guardrailId: 'guardrail',
      guardrailVersion: '1',
      additionalArgs: { requestMetadata: { tenant: 'acme' } },
    });

    await createBedrockAgentsHandler({ modelOptions })(baseConfig as any, 'hello');

    expect(modelOptions).toHaveBeenCalledWith(baseConfig);
    expect(BedrockModel.mock.calls[0][0]).toMatchObject({
      modelId: 'us.anthropic.claude-sonnet-4-5',
      guardrailId: 'guardrail',
      guardrailVersion: '1',
    });
  });

  it('installs a preconstructed runtime client and does not apply apiKey or region', async () => {
    const client = { send: vi.fn() };

    await createBedrockAgentsHandler({
      client: client as any,
      apiKey: 'must-not-reconfigure-client',
      region: 'us-east-1',
    })(baseConfig as any, 'hello');

    expect(modelInstances[0].client).toBe(client);
    expect(BedrockModel.mock.calls[0][0]).not.toHaveProperty('apiKey');
    expect(BedrockModel.mock.calls[0][0]).not.toHaveProperty('region');
  });

  it('passes endpoint region separately from the model prefix', async () => {
    await createBedrockAgentsHandler({ region: 'us-east-1' })(baseConfig as any, 'hello');

    expect(BedrockModel.mock.calls[0][0]).toMatchObject({
      region: 'us-east-1',
      modelId: 'us.anthropic.claude-sonnet-4-5',
    });
  });
});
