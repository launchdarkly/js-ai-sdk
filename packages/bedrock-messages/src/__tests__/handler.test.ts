import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockClientConstructor, mockSend } = vi.hoisted(() => ({
  mockClientConstructor: vi.fn(),
  mockSend: vi.fn(),
}));

vi.mock('@aws-sdk/client-bedrock-runtime', () => {
  class BedrockRuntimeClient {
    send = mockSend;
    constructor(options: unknown) {
      mockClientConstructor(options);
    }
  }
  class ConverseCommand {
    constructor(readonly input: unknown) {}
  }
  class ConverseStreamCommand {
    constructor(readonly input: unknown) {}
  }
  return { BedrockRuntimeClient, ConverseCommand, ConverseStreamCommand };
});

import { createBedrockMessagesHandler } from '../handler.js';

const baseConfig = {
  model: {
    name: 'anthropic.claude-sonnet-4-5',
    region: 'us',
    parameters: { maxTokens: 256, temperature: 0.2 },
    custom: { mustNeverLeak: 'sentinel' },
  },
  provider: { name: 'Bedrock' },
  instructions: 'Be concise.',
};

function response(text = 'hello') {
  return {
    output: { message: { role: 'assistant', content: [{ text }] } },
    stopReason: 'end_turn',
    usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
  };
}

describe('createBedrockMessagesHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('routes as Bedrock messages and normalizes usage', async () => {
    const client = { send: vi.fn().mockResolvedValue(response()) };
    const handler = createBedrockMessagesHandler({ client: client as any });

    const result = await handler(baseConfig as any, 'hello');

    expect(handler.providesFor).toEqual(['Bedrock', 'messages']);
    expect(result).toEqual({
      output: 'hello',
      usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 },
    });
  });

  it.each([
    ['us', 'anthropic.claude-sonnet-4-5', 'us.anthropic.claude-sonnet-4-5'],
    ['us', 'us.anthropic.claude-sonnet-4-5', 'us.anthropic.claude-sonnet-4-5'],
    [undefined, 'anthropic.claude-sonnet-4-5', 'anthropic.claude-sonnet-4-5'],
  ])('prepends short region %s to model name once', async (region, name, expected) => {
    const client = { send: vi.fn().mockResolvedValue(response()) };
    const config = { ...baseConfig, model: { ...baseConfig.model, region, name } };

    await createBedrockMessagesHandler({ client: client as any })(config as any, 'hello');

    expect(client.send.mock.calls[0][0].input.modelId).toBe(expected);
  });

  it('does not double-prepend when model.name already starts with the matching region', async () => {
    const client = { send: vi.fn().mockResolvedValue(response()) };
    const config = {
      ...baseConfig,
      model: { ...baseConfig.model, region: 'us', name: 'us.anthropic.claude-sonnet-4-5' },
    };

    await createBedrockMessagesHandler({ client: client as any })(config as any, 'hello');

    const modelId = client.send.mock.calls[0][0].input.modelId;
    expect(modelId).toBe('us.anthropic.claude-sonnet-4-5');
    expect(modelId).not.toBe('us.us.anthropic.claude-sonnet-4-5');
  });

  it('merges converseOptions without automatically mapping model.custom', async () => {
    const client = { send: vi.fn().mockResolvedValue(response()) };
    const converseOptions = vi.fn().mockReturnValue({
      guardrailConfig: { guardrailIdentifier: 'guardrail-id', guardrailVersion: '1' },
      requestMetadata: { tenant: 'acme' },
    });

    await createBedrockMessagesHandler({ client: client as any, converseOptions })(baseConfig as any, 'hello');

    expect(converseOptions).toHaveBeenCalledOnce();
    expect(converseOptions).toHaveBeenCalledWith(baseConfig);
    const request = client.send.mock.calls[0][0].input;
    expect(request.guardrailConfig.guardrailIdentifier).toBe('guardrail-id');
    expect(request.requestMetadata).toEqual({ tenant: 'acme' });
    expect(JSON.stringify(request)).not.toContain('mustNeverLeak');
  });

  it('keeps handler-critical request fields authoritative', async () => {
    const client = { send: vi.fn().mockResolvedValue(response()) };

    await createBedrockMessagesHandler({
      client: client as any,
      converseOptions: () => ({ modelId: 'wrong', messages: [], system: [] }) as any,
    })(baseConfig as any, 'hello');

    const request = client.send.mock.calls[0][0].input;
    expect(request.modelId).toBe('us.anthropic.claude-sonnet-4-5');
    expect(request.messages).not.toHaveLength(0);
    expect(request.system).toEqual([{ text: 'Be concise.' }]);
  });

  it('uses an injected client without constructing or closing it', async () => {
    const client = {
      send: vi.fn().mockResolvedValue(response()),
      destroy: vi.fn(),
    };
    const handler = createBedrockMessagesHandler({
      client: client as any,
      apiKey: 'must-not-reconfigure-client',
      region: 'us-east-1',
    });

    await handler(baseConfig as any, 'hello');

    expect(client.send).toHaveBeenCalledOnce();
    expect(client.destroy).not.toHaveBeenCalled();
    expect(mockClientConstructor).not.toHaveBeenCalled();
  });

  it('executes Converse tool use and submits a tool result', async () => {
    const client = {
      send: vi
        .fn()
        .mockResolvedValueOnce({
          output: {
            message: {
              role: 'assistant',
              content: [{ toolUse: { toolUseId: 'tool-1', name: 'lookup', input: { id: 42 } } }],
            },
          },
          stopReason: 'tool_use',
          usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 },
        })
        .mockResolvedValueOnce(response('done')),
    };
    const lookup = vi.fn().mockResolvedValue({ value: 'found' });
    const config = {
      ...baseConfig,
      tools: {
        lookup: {
          name: 'lookup',
          description: 'Look up an item',
          parameters: { type: 'object', properties: { id: { type: 'integer' } } },
        },
      },
    };

    const result = await createBedrockMessagesHandler({ client: client as any })(config as any, 'hello', { lookup });

    expect(lookup).toHaveBeenCalledWith({ id: 42 });
    const followup = client.send.mock.calls[1][0].input;
    expect(followup.messages.at(-1).content[0].toolResult.toolUseId).toBe('tool-1');
    expect(result.output).toBe('done');
  });

  it('streams text deltas and terminal usage', async () => {
    async function* stream() {
      yield { contentBlockDelta: { delta: { text: 'hel' } } };
      yield { contentBlockDelta: { delta: { text: 'lo' } } };
      yield { metadata: { usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } } };
    }
    const client = { send: vi.fn().mockResolvedValue({ stream: stream() }) };
    const handler = createBedrockMessagesHandler({ client: client as any });

    const events = [];
    for await (const event of handler.stream!(baseConfig as any, 'hello')) events.push(event);

    expect(events).toEqual([
      { type: 'chunk', text: 'hel' },
      { type: 'chunk', text: 'lo' },
      {
        type: 'done',
        output: 'hello',
        usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
      },
    ]);
  });
});
