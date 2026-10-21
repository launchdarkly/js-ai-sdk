/**
 * Google ADK agents handler tests.
 * Reference: TESTING.md §1 and §2.x Google ADK, Appendix A.15.
 * The ADK runtime is mocked. These tests must not open a network connection.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const created = vi.hoisted(() => ({
  agents: [] as Array<{ config: Record<string, unknown> }>,
  gems: [] as Array<{ config: Record<string, unknown> }>,
  tools: [] as Array<{ config: Record<string, unknown>; name?: string }>,
  runners: [] as Array<{
    config: Record<string, unknown>;
    plugins: unknown[];
    sessionService: {
      createSession: ReturnType<typeof vi.fn>;
      appendEvent: ReturnType<typeof vi.fn>;
    };
    runCalls: Array<Record<string, unknown>>;
  }>,
  events: [] as Array<Record<string, unknown>>,
  explode: null as Error | null,
  touchTool: false,
}));

vi.mock('@google/adk', () => {
  class LlmAgent {
    config: Record<string, unknown>;
    constructor(config: Record<string, unknown>) {
      this.config = config;
      created.agents.push(this);
    }
  }
  class Gemini {
    config: Record<string, unknown>;
    constructor(config: Record<string, unknown>) {
      this.config = config;
      created.gems.push(this);
    }
  }
  class FunctionTool {
    config: Record<string, unknown>;
    name: string;
    constructor(config: Record<string, unknown>) {
      this.config = config;
      this.name = String(config.name ?? '');
      created.tools.push(this);
    }
  }
  class InMemoryRunner {
    config: Record<string, unknown>;
    plugins: unknown[];
    sessionService: {
      createSession: ReturnType<typeof vi.fn>;
      appendEvent: ReturnType<typeof vi.fn>;
    };
    runCalls: Array<Record<string, unknown>> = [];
    constructor(config: Record<string, unknown>) {
      this.config = config;
      this.plugins = (config.plugins as unknown[]) ?? [];
      this.sessionService = {
        createSession: vi.fn(async () => ({ id: 'sess-1' })),
        appendEvent: vi.fn(async () => ({})),
      };
      created.runners.push(this);
    }
    async *runAsync(params: Record<string, unknown>) {
      this.runCalls.push(params);
      if (created.touchTool) {
        const pluginWithTools = this.plugins[0] as {
          beforeToolCallback?: (args: unknown) => unknown;
        };
        await pluginWithTools?.beforeToolCallback?.({
          tool: { name: 'lookup' },
          toolArgs: { q: 'x' },
          toolContext: { functionCallId: 'call-1' },
        });
      }
      if (created.explode) throw created.explode;
      const plugin = this.plugins[0] as {
        afterModelCallback?: (args: unknown) => unknown;
      };
      await plugin?.afterModelCallback?.({
        llmResponse: {
          partial: false,
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
        },
      });
      for (const event of created.events) yield event;
    }
  }
  class BasePlugin {}
  return {
    BasePlugin,
    FunctionTool,
    Gemini,
    InMemoryRunner,
    LlmAgent,
    isFinalResponse: (event: { final?: boolean; partial?: boolean }) => Boolean(event.final) && !event.partial,
    google_search: { kind: 'builtin' },
  };
});

function recordingSpan() {
  const attributes: Record<string, unknown> = {};
  return {
    name: 'span',
    attributes,
    setAttribute(key: string, value: unknown) {
      attributes[key] = value;
    },
    setStatus() {},
    addEvent() {},
    end() {},
    recordException() {},
  };
}

const spans = vi.hoisted(() => ({
  startRootSpan: vi.fn(() => ({ name: 'root' })),
  startModelSpan: vi.fn(),
  startToolSpan: vi.fn(),
  finishModelSpan: vi.fn(),
  finishRootSpan: vi.fn(),
  failSpan: vi.fn(),
  succeedSpan: vi.fn(),
  abandonOpenSpans: vi.fn(),
}));

vi.mock('../spans.js', () => spans);

import { createGoogleAdkAgentsHandler, historyContents } from '../handler.js';

const baseConfig = {
  model: { name: 'gemini-2.5-flash' },
  provider: { name: 'Google' },
  instructions: 'Be helpful.',
};

function finalEvent(text = 'answer', usage = { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 }) {
  return {
    final: true,
    partial: false,
    content: { parts: [{ text }] },
    usageMetadata: usage,
  };
}

beforeEach(() => {
  created.agents.length = 0;
  created.gems.length = 0;
  created.tools.length = 0;
  created.runners.length = 0;
  created.events = [finalEvent()];
  created.explode = null;
  created.touchTool = false;
  vi.clearAllMocks();
  spans.startModelSpan.mockImplementation(() => recordingSpan());
  spans.startToolSpan.mockImplementation(() => recordingSpan());
});

describe('factory and auth', () => {
  it('advertises a wildcard agent handler', () => {
    const handler = createGoogleAdkAgentsHandler();
    expect(handler.providesFor).toEqual(['*', 'agent']);
    expect(handler.captureContent).toBe(false);
  });

  it('uses Gemini without Vertex by default', async () => {
    await createGoogleAdkAgentsHandler()(baseConfig, 'hello');
    expect(created.gems[0]?.config).toMatchObject({ model: 'gemini-2.5-flash' });
    expect(created.gems[0]?.config.vertexai).not.toBe(true);
  });

  it('forwards an API key only in Gemini mode', async () => {
    await createGoogleAdkAgentsHandler({ apiKey: 'gemini-key' })(baseConfig, 'hello');
    expect(created.gems[0]?.config.apiKey).toBe('gemini-key');
    expect(created.gems[0]?.config.vertexai).not.toBe(true);
  });

  it('opts into Vertex without sending the API key', async () => {
    await createGoogleAdkAgentsHandler({
      useVertexai: true,
      project: 'ld-proj',
      location: 'us-central1',
      apiKey: 'should-not-be-used',
    })(baseConfig, 'hello');
    expect(created.gems.at(-1)?.config).toMatchObject({
      vertexai: true,
      project: 'ld-proj',
      location: 'us-central1',
    });
    expect(created.gems.at(-1)?.config.apiKey).toBeUndefined();
  });

  it('raises when Vertex has no project or location', () => {
    delete process.env.GOOGLE_CLOUD_PROJECT;
    delete process.env.GOOGLE_CLOUD_LOCATION;
    expect(() => createGoogleAdkAgentsHandler({ useVertexai: true })).toThrow(/project/i);
  });

  it('uses an injected model and does not construct Gemini', async () => {
    const model = { model: 'injected' };
    await createGoogleAdkAgentsHandler({ model })(baseConfig, 'hello');
    expect(created.agents[0]?.config.model).toBe(model);
    expect(created.gems).toHaveLength(0);
  });

  it('refuses a non-Gemini provider when no model is injected', async () => {
    await expect(
      createGoogleAdkAgentsHandler()(
        { ...baseConfig, provider: { name: 'OpenAI' }, model: { name: 'gpt-4o' } },
        'hello',
      ),
    ).rejects.toThrow(/LiteLLM|model/i);
    expect(created.gems).toHaveLength(0);
  });
});

describe('run, tools, and telemetry', () => {
  it('templates instructions and sends user text as newMessage', async () => {
    await createGoogleAdkAgentsHandler()(
      { ...baseConfig, instructions: 'Hello {{name}}' },
      'question',
      {},
      { name: 'Ada' },
    );
    expect(created.agents[0]?.config.instruction).toBe('Hello Ada');
    const message = created.runners[0]?.runCalls[0]?.newMessage as { parts: Array<{ text: string }> };
    expect(message.parts[0]?.text).toBe('question');
    expect(created.runners[0]?.plugins).toHaveLength(1);
  });

  it('reads usageMetadata from the final event', async () => {
    created.events = [finalEvent('the answer', { promptTokenCount: 11, candidatesTokenCount: 7, totalTokenCount: 18 })];
    const result = await createGoogleAdkAgentsHandler()(baseConfig, 'hello');
    expect(result).toMatchObject({ output: 'the answer', usage: { input: 11, output: 7, total: 18 } });
  });

  it('forwards only tools that have handlers', async () => {
    const lookup = vi.fn(({ q }: { q: string }) => `found ${q}`);
    await createGoogleAdkAgentsHandler()(
      {
        ...baseConfig,
        tools: {
          lookup: { name: 'lookup', description: 'find', parameters: { type: 'object' } },
          other: { name: 'other', description: 'nope', parameters: { type: 'object' } },
        },
      },
      'hello',
      { lookup },
    );
    expect(created.tools.map((tool) => tool.name)).toEqual(['lookup']);
    expect(created.tools[0]?.config.execute).toBeTypeOf('function');
    await expect(
      (created.tools[0]?.config.execute as (args: { q: string }) => Promise<string>)({ q: 'ada' }),
    ).resolves.toBe('found ada');
  });

  it('calls span helpers from the telemetry plugin', async () => {
    await createGoogleAdkAgentsHandler()(baseConfig, 'hello');
    expect(spans.startRootSpan).toHaveBeenCalled();
    expect(spans.startModelSpan).toHaveBeenCalled();
    const plugin = created.runners[0]?.plugins[0] as {
      beforeToolCallback: (args: unknown) => unknown;
    };
    await plugin.beforeToolCallback({ tool: { name: 'lookup' }, toolArgs: { q: 'x' } });
    expect(spans.startToolSpan).toHaveBeenCalledWith('lookup', expect.anything(), expect.anything());
  });

  it('passes the argument object through to the tool handler', async () => {
    const lookup = vi.fn(({ q }: { q: string }) => `found ${q}`);
    await createGoogleAdkAgentsHandler()(
      { ...baseConfig, tools: { lookup: { name: 'lookup', description: 'find', parameters: { type: 'object' } } } },
      'hello',
      { lookup },
    );
    await expect(
      (created.tools[0]?.config.execute as (args: { q: string }) => Promise<string>)({ q: 'ada' }),
    ).resolves.toBe('found ada');
  });

  it('does not wrap a NativeTool as a function', async () => {
    const { NATIVE_TOOL_KEY, NativeTool } = await import('@launchdarkly/ai-server');
    const tracked: string[] = [];
    const stub = () => {
      tracked.push('google_search');
    };
    (stub as unknown as Record<symbol, unknown>)[NATIVE_TOOL_KEY] = new NativeTool(Symbol('search'), 'google_search');
    await createGoogleAdkAgentsHandler()(
      {
        ...baseConfig,
        tools: { search: { name: 'google_search', description: 'web', parameters: { type: 'object' } } },
      },
      'hello',
      { google_search: stub },
    );
    expect(created.tools).toHaveLength(0);
    expect(created.agents[0]?.config.tools).toEqual([{ kind: 'builtin' }]);
    const plugin = created.runners[0]?.plugins[0] as { beforeToolCallback: (args: unknown) => Promise<unknown> };
    await plugin.beforeToolCallback({ tool: { name: 'google_search' }, toolContext: { functionCallId: 'call-1' } });
    expect(tracked).toEqual(['google_search']);
  });

  it('converts outputFormat into a Gemini schema', async () => {
    const schema = { type: 'object', properties: { ok: { type: 'boolean' } } };
    await createGoogleAdkAgentsHandler()({ ...baseConfig, outputFormat: schema }, 'hello');
    const outputSchema = created.agents[0]?.config.outputSchema as { type?: string; required?: string[] };
    expect(outputSchema.type).toBe('OBJECT');
    expect(outputSchema.required).toEqual(['ok']);
    expect(outputSchema).not.toBe(schema);
  });

  it('keeps a distinct call id for overlapping tool calls', async () => {
    await createGoogleAdkAgentsHandler()(baseConfig, 'hello');
    const plugin = created.runners[0]?.plugins[0] as { beforeToolCallback: (args: unknown) => Promise<unknown> };
    await plugin.beforeToolCallback({ tool: { name: 'lookup' }, toolContext: { functionCallId: 'call-1' } });
    await plugin.beforeToolCallback({ tool: { name: 'lookup' }, toolContext: { functionCallId: 'call-2' } });
    expect(spans.startToolSpan).toHaveBeenNthCalledWith(1, 'lookup', 'call-1', expect.anything());
    expect(spans.startToolSpan).toHaveBeenNthCalledWith(2, 'lookup', 'call-2', expect.anything());
  });

  it('writes content attributes when captureContent is true', async () => {
    await createGoogleAdkAgentsHandler({ captureContent: true })(baseConfig, 'hello');
    const modelSpan = spans.startModelSpan.mock.results.at(-1)?.value as { attributes: Record<string, unknown> };
    expect(modelSpan.attributes['gen_ai.input.messages']).toBeTruthy();
    const plugin = created.runners[0]?.plugins[0] as {
      beforeToolCallback: (args: unknown) => Promise<unknown>;
      afterToolCallback: (args: unknown) => Promise<unknown>;
    };
    await plugin.beforeToolCallback({
      tool: { name: 'lookup' },
      toolArgs: { q: 'ada' },
      toolContext: { functionCallId: 'call-1' },
    });
    await plugin.afterToolCallback({
      tool: { name: 'lookup' },
      toolArgs: { q: 'ada' },
      toolContext: { functionCallId: 'call-1' },
      result: 'found',
    });
    const toolSpan = spans.startToolSpan.mock.results.at(-1)?.value as { attributes: Record<string, unknown> };
    expect(toolSpan.attributes['gen_ai.tool.call.arguments']).toContain('ada');
  });

  it('fails an open tool span when the runner throws', async () => {
    const toolSpan = recordingSpan();
    spans.startToolSpan.mockReturnValue(toolSpan);
    created.touchTool = true;
    created.explode = new Error('runner broke');
    await expect(createGoogleAdkAgentsHandler()(baseConfig, 'hello')).rejects.toThrow('runner broke');
    expect(spans.failSpan).toHaveBeenCalledWith(toolSpan, expect.any(Error));
  });

  it('maps image history to inlineData', () => {
    const contents = historyContents([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'see' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } },
        ],
      },
    ]);
    const image = contents[0]?.parts[1]?.inlineData as { mimeType?: string; data?: string };
    expect(image.mimeType).toBe('image/png');
    expect(image.data).toBe('aGVsbG8=');
    expect(String(image.data)).not.toContain('data:');
  });
});
