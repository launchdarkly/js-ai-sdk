import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HandlerStreamEvent } from '../types.js';

// ─── Mocks ────────────────────────────────────────────────────────────────────

// vi.hoisted ensures these are available inside the vi.mock factories (which are hoisted)
const { mockTrack } = vi.hoisted(() => ({ mockTrack: vi.fn() }));

vi.mock('../lifecycle.js', () => ({
  extractVariation: vi.fn(),
  initClient: vi.fn().mockResolvedValue(undefined),
  getClient: vi.fn().mockReturnValue({ track: mockTrack }),
  shutdown: vi.fn(),
  waitForTelemetry: vi.fn(),
  shutdownTelemetry: vi.fn(),
}));

vi.mock('../judges.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../judges.js')>();
  return {
    ...actual,
    runJudges: vi.fn().mockResolvedValue({}),
  };
});

import { config } from '../client.js';
import { runJudges } from '../judges.js';
import { extractVariation, getClient } from '../lifecycle.js';
import type { ProviderHandler } from '../types.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const mockContext = { kind: 'user' as const, key: 'user-1' };

const mockConfig = {
  model: { name: 'gpt-4o' },
  provider: { name: 'OpenAI' },
  instructions: 'You are helpful.',
};

const mockMeta = {
  enabled: true,
  variationKey: 'v1',
  version: 1,
  mode: 'messages' as const,
};

function makeHandler(output = 'hello', usage = { input_tokens: 10, output_tokens: 5 }): ProviderHandler {
  const h: ProviderHandler = vi.fn().mockResolvedValue({ output, usage });
  h.providesFor = ['OpenAI', 'messages'];
  return h;
}

async function* makeStreamGenerator(chunks: string[], usage: Record<string, any>): AsyncGenerator<HandlerStreamEvent> {
  for (const text of chunks) {
    yield { type: 'chunk', text };
  }
  yield { type: 'done', usage };
}

function makeStreamingHandler(
  chunks: string[] = ['hello', ' world'],
  usage: Record<string, any> = { input_tokens: 10, output_tokens: 5 },
): ProviderHandler {
  const h: ProviderHandler = vi.fn().mockResolvedValue({ output: chunks.join(''), usage });
  h.providesFor = ['OpenAI', 'messages'];
  h.stream = vi.fn().mockImplementation(() => makeStreamGenerator(chunks, usage));
  return h;
}

// ─── config() — single handler ────────────────────────────────────────────────

describe('config() — single handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTrack.mockReset();
    (extractVariation as ReturnType<typeof vi.fn>).mockResolvedValue({ config: mockConfig, meta: mockMeta });
    (runJudges as ReturnType<typeof vi.fn>).mockResolvedValue({});
    (getClient as ReturnType<typeof vi.fn>).mockReturnValue({ track: mockTrack });
  });

  it('calls extractVariation with the correct key and context', async () => {
    const handler = makeHandler();
    await config({ key: 'my-flag', handler }).invoke('hi', mockContext);
    expect(extractVariation).toHaveBeenCalledWith('my-flag', mockContext);
  });

  it('calls the handler with config, userInput, and variables', async () => {
    const handler = makeHandler();
    await config({ key: 'my-flag', handler }).invoke('hello', mockContext, { x: 1 });
    expect(handler).toHaveBeenCalledWith(
      mockConfig,
      'hello',
      expect.any(Object), // wrapped toolHandlers
      expect.objectContaining({ x: 1, ldContext: expect.objectContaining(mockContext) }),
      undefined, // history
    );
  });

  it('returns a ProviderResponse with response, usage, and judgeResults', async () => {
    const handler = makeHandler('world', { input_tokens: 3, output_tokens: 7 });
    const result = await config({ key: 'flag', handler }).invoke('q', mockContext);
    expect(result.response).toBe('world');
    expect(result.usage).toEqual({ input: 3, output: 7, total: 10 });
    expect(result.judgeResults).toBeDefined();
  });

  it('returns provider cache-token details in public usage', async () => {
    const handler = makeHandler('world', {
      input_tokens: 4,
      output_tokens: 5,
      cache_read_input_tokens: 100,
      cache_creation_input_tokens: 20,
    });

    const result = await config({ key: 'flag', handler }).invoke('q', mockContext);

    expect(result.usage).toEqual({
      input: 124,
      output: 5,
      total: 129,
      inputDetails: { uncached: 4, cacheRead: 100, cacheCreation: 20 },
    });
  });

  it('tracks $ld:ai:generation:success on a successful call', async () => {
    const handler = makeHandler();
    await config({ key: 'flag', handler }).invoke('q', mockContext);
    expect(mockTrack).toHaveBeenCalledWith('$ld:ai:generation:success', mockContext, expect.anything(), 1);
  });

  it('tracks $ld:ai:duration:total on success', async () => {
    const handler = makeHandler();
    await config({ key: 'flag', handler }).invoke('q', mockContext);
    expect(mockTrack).toHaveBeenCalledWith('$ld:ai:duration:total', mockContext, expect.anything(), expect.any(Number));
  });

  it('tracks token events when usage > 0', async () => {
    const handler = makeHandler('ok', { input_tokens: 4, output_tokens: 6 });
    await config({ key: 'flag', handler }).invoke('q', mockContext);
    const eventNames = mockTrack.mock.calls.map((c: any[]) => c[0]);
    expect(eventNames).toContain('$ld:ai:tokens:total');
    expect(eventNames).toContain('$ld:ai:tokens:input');
    expect(eventNames).toContain('$ld:ai:tokens:output');
  });

  it('does not track token events when usage is 0', async () => {
    const handler = makeHandler('ok', { input_tokens: 0, output_tokens: 0 });
    await config({ key: 'flag', handler }).invoke('q', mockContext);
    const eventNames = mockTrack.mock.calls.map((c: any[]) => c[0]);
    expect(eventNames).not.toContain('$ld:ai:tokens:total');
  });

  it('tracks $ld:ai:generation:error and re-throws when handler throws', async () => {
    const err = new Error('provider failure');
    const handler: ProviderHandler = vi.fn().mockRejectedValue(err);
    handler.providesFor = ['OpenAI', 'messages'];
    await expect(config({ key: 'flag', handler }).invoke('q', mockContext)).rejects.toThrow('provider failure');
    const eventNames = mockTrack.mock.calls.map((c: any[]) => c[0]);
    expect(eventNames).toContain('$ld:ai:generation:error');
    expect(eventNames).toContain('$ld:ai:duration:total');
  });

  it('propagates extractVariation errors', async () => {
    (extractVariation as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('disabled'));
    const handler = makeHandler();
    await expect(config({ key: 'flag', handler }).invoke('q', mockContext)).rejects.toThrow('disabled');
  });

  it('includes judgeResults from runJudges in the response', async () => {
    const judgeData = { 'judge-flag': { usage: { input: 1, output: 1, total: 2 }, response: 'good', score: 0.9 } };
    (runJudges as ReturnType<typeof vi.fn>).mockResolvedValue(judgeData);
    const handler = makeHandler();
    const result = await config({ key: 'flag', handler }).invoke('q', mockContext);
    expect(result.judgeResults).toEqual(judgeData);
  });

  it('throws when the single handler providesFor does not match the variation provider', async () => {
    const anthropicHandler: ProviderHandler = vi.fn().mockResolvedValue({ output: 'hi', usage: {} });
    anthropicHandler.providesFor = ['Anthropic', 'messages'];
    // mockConfig.provider.name is 'OpenAI', so this should throw
    await expect(config({ key: 'flag', handler: anthropicHandler }).invoke('q', mockContext)).rejects.toThrow(
      /OpenAI/i,
    );
  });

  it('throws when the single handler mode does not match the variation mode', async () => {
    const messagesHandler = makeHandler(); // providesFor = ['OpenAI', 'messages']
    (extractVariation as ReturnType<typeof vi.fn>).mockResolvedValue({
      config: mockConfig,
      meta: { ...mockMeta, mode: 'agent' as const },
    });
    await expect(config({ key: 'flag', handler: messagesHandler }).invoke('q', mockContext)).rejects.toThrow(
      /with mode agent/i,
    );
  });

  // ─── LD Context interpolation ──────────────────────────────────────

  it('injects ldContext into variables passed to the handler', async () => {
    const context = { kind: 'user' as const, key: 'user-123', email: 'user@example.com' };
    const handler = makeHandler();
    await config({ key: 'flag', handler }).invoke('q', context);
    const receivedVariables = (handler as ReturnType<typeof vi.fn>).mock.calls[0][3];
    expect(receivedVariables.ldContext).toMatchObject({ key: 'user-123', email: 'user@example.com' });
  });

  it('includes the kind field in ldContext', async () => {
    const context = { kind: 'user' as const, key: 'abc' };
    const handler = makeHandler();
    await config({ key: 'flag', handler }).invoke('q', context);
    const receivedVariables = (handler as ReturnType<typeof vi.fn>).mock.calls[0][3];
    expect(receivedVariables.ldContext.kind).toBe('user');
  });

  it('preserves user-supplied variables alongside ldContext', async () => {
    const context = { kind: 'user' as const, key: 'user-123', email: 'user@example.com' };
    const handler = makeHandler();
    await config({ key: 'flag', handler }).invoke('q', context, { someVariable: 5 });
    const receivedVariables = (handler as ReturnType<typeof vi.fn>).mock.calls[0][3];
    expect(receivedVariables.someVariable).toBe(5);
    expect(receivedVariables.ldContext).toMatchObject({ key: 'user-123', email: 'user@example.com' });
  });

  it('discards a user-supplied ldContext variable and replaces it with the LD context', async () => {
    const context = { kind: 'user' as const, key: 'real-key' };
    const handler = makeHandler();
    await config({ key: 'flag', handler }).invoke('q', context, { ldContext: 'custom' });
    const receivedVariables = (handler as ReturnType<typeof vi.fn>).mock.calls[0][3];
    expect(receivedVariables.ldContext).toMatchObject({ key: 'real-key' });
    expect(receivedVariables.ldContext).not.toBe('custom');
  });

  // ─── structured output (outputFormat) ────────────────────────────────────────

  it('JSON-parses string output when config.outputFormat is set', async () => {
    const outputFormat = { type: 'object', properties: { name: { type: 'string' } } };
    (extractVariation as ReturnType<typeof vi.fn>).mockResolvedValue({
      config: { ...mockConfig, outputFormat },
      meta: mockMeta,
    });
    const handler = makeHandler('{"name":"Alice"}');
    const result = await config({ key: 'flag', handler }).invoke('q', mockContext);
    expect(result.response).toEqual({ name: 'Alice' });
  });

  it('strips markdown code fences before parsing when config.outputFormat is set', async () => {
    const outputFormat = { type: 'object', properties: { name: { type: 'string' } } };
    (extractVariation as ReturnType<typeof vi.fn>).mockResolvedValue({
      config: { ...mockConfig, outputFormat },
      meta: mockMeta,
    });
    const handler = makeHandler('```json\n{"name":"Alice"}\n```');
    const result = await config({ key: 'flag', handler }).invoke('q', mockContext);
    expect(result.response).toEqual({ name: 'Alice' });
  });

  it('returns object output as-is when config.outputFormat is set and handler returns an object', async () => {
    const outputFormat = { type: 'object', properties: { name: { type: 'string' } } };
    (extractVariation as ReturnType<typeof vi.fn>).mockResolvedValue({
      config: { ...mockConfig, outputFormat },
      meta: mockMeta,
    });
    const parsedObj = { name: 'Bob' };
    const handler: ProviderHandler = vi
      .fn()
      .mockResolvedValue({ output: parsedObj, usage: { input_tokens: 1, output_tokens: 1 } });
    handler.providesFor = ['OpenAI', 'messages'];
    const result = await config({ key: 'flag', handler }).invoke('q', mockContext);
    expect(result.response).toEqual(parsedObj);
  });

  it('returns raw string as response when outputFormat is absent even if output looks like JSON', async () => {
    const handler = makeHandler('{"name":"Alice"}');
    const result = await config({ key: 'flag', handler }).invoke('q', mockContext);
    expect(result.response).toBe('{"name":"Alice"}');
  });

  it('returns raw string when outputFormat is set but output cannot be parsed as JSON (§3.10 best-effort)', async () => {
    const outputFormat = { type: 'object', properties: { name: { type: 'string' } } };
    (extractVariation as ReturnType<typeof vi.fn>).mockResolvedValue({
      config: { ...mockConfig, outputFormat },
      meta: mockMeta,
    });
    const handler = makeHandler('this is not valid JSON at all');
    // Must NOT throw — best-effort approach returns the raw string instead
    const result = await config({ key: 'flag', handler }).invoke('q', mockContext);
    expect(result.response).toBe('this is not valid JSON at all');
  });
});

// ─── config() — multi-handler routing ────────────────────────────────────────

describe('config() — multi-handler routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTrack.mockReset();
    (extractVariation as ReturnType<typeof vi.fn>).mockResolvedValue({ config: mockConfig, meta: mockMeta });
    (runJudges as ReturnType<typeof vi.fn>).mockResolvedValue({});
    (getClient as ReturnType<typeof vi.fn>).mockReturnValue({ track: mockTrack });
  });

  it('selects the handler matching provider + mode', async () => {
    const openaiHandler = makeHandler('openai-response');
    const claudeHandler: ProviderHandler = vi.fn().mockResolvedValue({ output: 'claude', usage: {} });
    claudeHandler.providesFor = ['Anthropic', 'messages'];

    const result = await config({
      key: 'flag',
      handler: [claudeHandler, openaiHandler],
    }).invoke('q', mockContext);

    expect(result.response).toBe('openai-response');
    expect(claudeHandler).not.toHaveBeenCalled();
  });

  it('normalizes completion mode to messages when selecting a handler', async () => {
    (extractVariation as ReturnType<typeof vi.fn>).mockResolvedValue({
      config: mockConfig,
      meta: { ...mockMeta, mode: 'completion' as any },
    });
    const handler = makeHandler('ok');
    const result = await config({ key: 'flag', handler: [handler] }).invoke('q', mockContext);
    expect(result.response).toBe('ok');
  });

  it('throws when the variation has no provider name', async () => {
    (extractVariation as ReturnType<typeof vi.fn>).mockResolvedValue({
      config: { ...mockConfig, provider: undefined },
      meta: mockMeta,
    });
    await expect(config({ key: 'flag', handler: [makeHandler()] }).invoke('q', mockContext)).rejects.toThrow(
      /provider/i,
    );
  });

  it('throws when no handler matches the variation provider', async () => {
    const claudeHandler: ProviderHandler = vi.fn().mockResolvedValue({ output: '', usage: {} });
    claudeHandler.providesFor = ['Anthropic', 'messages'];
    await expect(config({ key: 'flag', handler: [claudeHandler] }).invoke('q', mockContext)).rejects.toThrow(/OpenAI/i);
  });

  it('selects a wildcard handler when no exact provider match exists', async () => {
    (extractVariation as ReturnType<typeof vi.fn>).mockResolvedValue({
      config: { ...mockConfig, provider: { name: 'Anthropic' } },
      meta: mockMeta,
    });
    const wildcardHandler: ProviderHandler = vi.fn().mockResolvedValue({ output: 'from wildcard', usage: {} });
    wildcardHandler.providesFor = ['*', 'messages'];
    const result = await config({ key: 'flag', handler: [wildcardHandler] }).invoke('q', mockContext);
    expect(result.response).toBe('from wildcard');
    expect(wildcardHandler).toHaveBeenCalled();
  });

  it('prefers explicit provider match over wildcard', async () => {
    const wildcardHandler: ProviderHandler = vi.fn().mockResolvedValue({ output: 'from wildcard', usage: {} });
    wildcardHandler.providesFor = ['*', 'messages'];
    const explicitHandler = makeHandler('from explicit');
    const result = await config({ key: 'flag', handler: [wildcardHandler, explicitHandler] }).invoke('q', mockContext);
    expect(result.response).toBe('from explicit');
    expect(wildcardHandler).not.toHaveBeenCalled();
  });

  it('wildcard handler does not match a different mode', async () => {
    (extractVariation as ReturnType<typeof vi.fn>).mockResolvedValue({
      config: mockConfig,
      meta: { ...mockMeta, mode: 'agent' as const },
    });
    const wildcardHandler: ProviderHandler = vi.fn().mockResolvedValue({ output: '', usage: {} });
    wildcardHandler.providesFor = ['*', 'messages'];
    await expect(config({ key: 'flag', handler: [wildcardHandler] }).invoke('q', mockContext)).rejects.toThrow();
  });

  it('throws a mode-specific error when provider matches but mode does not', async () => {
    const messagesHandler = makeHandler();
    (extractVariation as ReturnType<typeof vi.fn>).mockResolvedValue({
      config: mockConfig,
      meta: { ...mockMeta, mode: 'agent' as const },
    });
    await expect(config({ key: 'flag', handler: [messagesHandler] }).invoke('q', mockContext)).rejects.toThrow(
      /with mode agent/i,
    );
  });

  it('includes judgeResults from runJudges in the response', async () => {
    const judgeData = { 'judge-flag': { usage: { input: 1, output: 1, total: 2 }, response: 'good', score: 0.9 } };
    (runJudges as ReturnType<typeof vi.fn>).mockResolvedValue(judgeData);
    const handler = makeHandler();
    const result = await config({ key: 'flag', handler: [handler] }).invoke('q', mockContext);
    expect(runJudges).toHaveBeenCalled();
    expect(result.judgeResults).toEqual(judgeData);
  });

  it('returns response and usage', async () => {
    const handler = makeHandler('result', { input_tokens: 2, output_tokens: 3 });
    const result = await config({ key: 'flag', handler: [handler] }).invoke('q', mockContext);
    expect(result.response).toBe('result');
    expect(result.usage).toEqual({ input: 2, output: 3, total: 5 });
  });

  it('response is a non-undefined string', async () => {
    const handler = makeHandler('hello');
    const result = await config({ key: 'flag', handler: [handler] }).invoke('q', mockContext);
    expect(typeof result.response).toBe('string');
  });

  it('exposes trackData in the public return value for use with prepareJudge()', async () => {
    const handler = makeHandler('hello');
    const result = await config({ key: 'flag', handler: [handler] }).invoke('q', mockContext);
    expect(result.trackData).toBeDefined();
    expect(result.trackData).toMatchObject({ configKey: 'flag', variationKey: 'v1' });
  });

  it('uses a handler from the registry when no local handler is provided', async () => {
    const { Registry } = await import('../registry.js');
    const handler = makeHandler('from-registry');
    const registry = new Registry({ handlers: [handler] });
    const result = await config({ key: 'flag', registry }).invoke('q', mockContext);
    expect(result.response).toBe('from-registry');
  });

  it('local handler takes precedence over registry handlers', async () => {
    const { Registry } = await import('../registry.js');
    const registryHandler = makeHandler('from-registry');
    const localHandler = makeHandler('from-local');
    const registry = new Registry({ handlers: [registryHandler] });
    const result = await config({
      key: 'flag',
      handler: [localHandler],
      registry,
    }).invoke('q', mockContext);
    expect(result.response).toBe('from-local');
    expect(registryHandler).not.toHaveBeenCalled();
  });

  // ─── LD Context interpolation ──────────────────────────────────────────────

  it('injects ldContext into variables passed to the handler', async () => {
    const context = { kind: 'user' as const, key: 'user-123', email: 'user@example.com' };
    const handler = makeHandler();
    await config({ key: 'flag', handler: [handler] }).invoke('q', context);
    const receivedVariables = (handler as ReturnType<typeof vi.fn>).mock.calls[0][3];
    expect(receivedVariables.ldContext).toMatchObject({ key: 'user-123', email: 'user@example.com' });
  });

  it('preserves user-supplied variables alongside ldContext', async () => {
    const context = { kind: 'user' as const, key: 'user-123' };
    const handler = makeHandler();
    await config({ key: 'flag', handler: [handler] }).invoke('q', context, { myVar: 'hello' });
    const receivedVariables = (handler as ReturnType<typeof vi.fn>).mock.calls[0][3];
    expect(receivedVariables.myVar).toBe('hello');
    expect(receivedVariables.ldContext).toMatchObject({ key: 'user-123' });
  });
});

// ─── config().stream() ────────────────────────────────────────────────────────

async function collectStream<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const events: T[] = [];
  for await (const event of gen) events.push(event);
  return events;
}

describe('config().stream() — single handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTrack.mockReset();
    (extractVariation as ReturnType<typeof vi.fn>).mockResolvedValue({ config: mockConfig, meta: mockMeta });
    (runJudges as ReturnType<typeof vi.fn>).mockResolvedValue({});
    (getClient as ReturnType<typeof vi.fn>).mockReturnValue({ track: mockTrack });
  });

  it('returns an async generator', () => {
    const handler = makeStreamingHandler();
    const gen = config({ key: 'flag', handler }).stream('q', mockContext);
    expect(typeof gen[Symbol.asyncIterator]).toBe('function');
  });

  it('yields chunk events with the correct text', async () => {
    const handler = makeStreamingHandler(['Hello', ' world']);
    const events = await collectStream(config({ key: 'flag', handler }).stream('q', mockContext));
    const chunks = events.filter((e) => e.type === 'chunk');
    expect(chunks).toEqual([
      { type: 'chunk', text: 'Hello' },
      { type: 'chunk', text: ' world' },
    ]);
  });

  it('yields a done event as the last event', async () => {
    const handler = makeStreamingHandler(['Hello', ' world']);
    const events = await collectStream(config({ key: 'flag', handler }).stream('q', mockContext));
    expect(events.at(-1)?.type).toBe('done');
  });

  it('done.response is the concatenated text', async () => {
    const handler = makeStreamingHandler(['Hello', ' world']);
    const events = await collectStream(config({ key: 'flag', handler }).stream('q', mockContext));
    const done = events.find((e) => e.type === 'done') as any;
    expect(done.response).toBe('Hello world');
  });

  it('done event carries normalized usage', async () => {
    const handler = makeStreamingHandler(['hi'], { input_tokens: 4, output_tokens: 6 });
    const events = await collectStream(config({ key: 'flag', handler }).stream('q', mockContext));
    const done = events.find((e) => e.type === 'done') as any;
    expect(done.usage).toEqual({ input: 4, output: 6, total: 10 });
  });

  it('all chunks appear before the done event', async () => {
    const handler = makeStreamingHandler(['a', 'b', 'c']);
    const events = await collectStream(config({ key: 'flag', handler }).stream('q', mockContext));
    const doneIndex = events.findIndex((e) => e.type === 'done');
    const chunksAfterDone = events.slice(doneIndex + 1).filter((e) => e.type === 'chunk');
    expect(chunksAfterDone).toHaveLength(0);
  });

  it('emits $ld:ai:generation:success after the stream completes', async () => {
    const handler = makeStreamingHandler();
    await collectStream(config({ key: 'flag', handler }).stream('q', mockContext));
    expect(mockTrack).toHaveBeenCalledWith('$ld:ai:generation:success', mockContext, expect.anything(), 1);
  });

  it('emits $ld:ai:duration:total after the stream completes', async () => {
    const handler = makeStreamingHandler();
    await collectStream(config({ key: 'flag', handler }).stream('q', mockContext));
    expect(mockTrack).toHaveBeenCalledWith('$ld:ai:duration:total', mockContext, expect.anything(), expect.any(Number));
  });

  it('emits token events when usage > 0', async () => {
    const handler = makeStreamingHandler(['hi'], { input_tokens: 4, output_tokens: 6 });
    await collectStream(config({ key: 'flag', handler }).stream('q', mockContext));
    const eventNames = mockTrack.mock.calls.map((c: any[]) => c[0]);
    expect(eventNames).toContain('$ld:ai:tokens:total');
    expect(eventNames).toContain('$ld:ai:tokens:input');
    expect(eventNames).toContain('$ld:ai:tokens:output');
  });

  it('does not emit token events when usage is 0', async () => {
    const handler = makeStreamingHandler(['hi'], { input_tokens: 0, output_tokens: 0 });
    await collectStream(config({ key: 'flag', handler }).stream('q', mockContext));
    const eventNames = mockTrack.mock.calls.map((c: any[]) => c[0]);
    expect(eventNames).not.toContain('$ld:ai:tokens:total');
  });

  it('emits $ld:ai:generation:error and re-throws when handler stream throws', async () => {
    const handler = makeHandler();
    const err = new Error('stream failure');
    handler.stream = async function* () {
      throw err;
    };
    const gen = config({ key: 'flag', handler }).stream('q', mockContext);
    await expect(collectStream(gen)).rejects.toThrow('stream failure');
    const eventNames = mockTrack.mock.calls.map((c: any[]) => c[0]);
    expect(eventNames).toContain('$ld:ai:generation:error');
    expect(eventNames).toContain('$ld:ai:duration:total');
  });

  it('includes judgeResults from runJudges in the done event', async () => {
    const judgeData = { 'judge-flag': { usage: { input: 1, output: 1, total: 2 }, response: 'good', score: 0.9 } };
    (runJudges as ReturnType<typeof vi.fn>).mockResolvedValue(judgeData);
    const handler = makeStreamingHandler();
    const events = await collectStream(config({ key: 'flag', handler }).stream('q', mockContext));
    const done = events.find((e) => e.type === 'done') as any;
    expect(done.judgeResults).toEqual(judgeData);
  });

  it('done.judgeResults is undefined when judges return empty', async () => {
    (runJudges as ReturnType<typeof vi.fn>).mockResolvedValue({});
    const handler = makeStreamingHandler();
    const events = await collectStream(config({ key: 'flag', handler }).stream('q', mockContext));
    const done = events.find((e) => e.type === 'done') as any;
    expect(done.judgeResults).toBeUndefined();
  });

  it('falls back to blocking handler when .stream is absent', async () => {
    const handler = makeHandler('full output', { input_tokens: 2, output_tokens: 3 });
    const events = await collectStream(config({ key: 'flag', handler }).stream('q', mockContext));
    const chunks = events.filter((e) => e.type === 'chunk');
    const done = events.find((e) => e.type === 'done') as any;
    expect(chunks.length).toBeGreaterThan(0);
    expect(done.response).toBe('full output');
  });

  it('injects ldContext into variables passed to handler.stream', async () => {
    const context = { kind: 'user' as const, key: 'user-456', email: 'test@example.com' };
    const handler = makeStreamingHandler();
    await collectStream(config({ key: 'flag', handler }).stream('q', context));
    const streamFn = handler.stream as ReturnType<typeof vi.fn>;
    const receivedVariables = streamFn.mock.calls[0][3];
    expect(receivedVariables.ldContext).toMatchObject({ key: 'user-456', email: 'test@example.com' });
  });
});

// ─── config({ skipJudges }) ───────────────────────────────────────────────────

describe('config({ skipJudges: true })', () => {
  const mainConfigWithJudge = {
    ...mockConfig,
    judgeConfiguration: { judges: [{ key: 'judge-flag', samplingRate: 1 }] },
  };
  const judgeConfig = {
    model: { name: 'gpt-4o' },
    provider: { name: 'OpenAI' },
    instructions: 'You are a judge.',
    evaluationMetricKey: 'judge-score',
  };
  const judgeMeta = { enabled: true, variationKey: 'jv1', version: 1, mode: 'judge' as const };

  beforeEach(() => {
    vi.clearAllMocks();
    mockTrack.mockReset();
    (extractVariation as ReturnType<typeof vi.fn>).mockResolvedValue({ config: mockConfig, meta: mockMeta });
    (runJudges as ReturnType<typeof vi.fn>).mockResolvedValue({ 'judge-key': { score: 0.9 } });
    (getClient as ReturnType<typeof vi.fn>).mockReturnValue({ track: mockTrack });
  });

  it('skips runJudges during invoke() when skipJudges is true', async () => {
    const handler = makeHandler();
    await config({ key: 'flag', handler, skipJudges: true }).invoke('q', mockContext);
    expect(runJudges).not.toHaveBeenCalled();
  });

  it('returns undefined judgeResults and empty judgeTasks from invoke() when no judges configured', async () => {
    const handler = makeHandler();
    const result = await config({ key: 'flag', handler, skipJudges: true }).invoke('q', mockContext);
    expect(result.judgeResults).toBeUndefined();
    expect(result.judgeTasks).toEqual([]);
  });

  it('returns populated judgeTasks when judgeConfiguration is present', async () => {
    (extractVariation as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ config: mainConfigWithJudge, meta: mockMeta })
      .mockResolvedValueOnce({ config: judgeConfig, meta: judgeMeta });

    const handler = makeHandler();
    const result = await config({ key: 'flag', handler, skipJudges: true }).invoke('q', mockContext);
    expect(result.judgeResults).toBeUndefined();
    expect(result.judgeTasks).toHaveLength(1);
    const task = result.judgeTasks![0];
    expect(task.configKey).toBe('judge-flag');
    expect(task.evaluationMetricKey).toBe('judge-score');
    expect(task.actualOutput).toBe('hello');
    expect(task.parentTrackData).toMatchObject({ configKey: 'flag', variationKey: 'v1' });
  });

  it('skips runJudges during stream() when skipJudges is true', async () => {
    const handler = makeStreamingHandler();
    const events: unknown[] = [];
    for await (const e of config({ key: 'flag', handler, skipJudges: true }).stream('q', mockContext)) {
      events.push(e);
    }
    expect(runJudges).not.toHaveBeenCalled();
    const done = events.find((e: any) => e.type === 'done') as any;
    expect(done?.judgeResults).toBeUndefined();
  });

  it('still runs judges when skipJudges is false (default)', async () => {
    const handler = makeHandler();
    await config({ key: 'flag', handler }).invoke('q', mockContext);
    expect(runJudges).toHaveBeenCalled();
  });
});

// ─── invoke() judgeTasks (skipJudges: true) ────────────────────────────────────

describe('invoke() judgeTasks via buildJudgeTasks', () => {
  const judgeConfig = {
    model: { name: 'gpt-4o' },
    provider: { name: 'OpenAI' },
    instructions: 'You are a judge. Score this.',
    evaluationMetricKey: 'judge-score',
  };
  const judgeMeta = { enabled: true, variationKey: 'jv1', version: 1, mode: 'judge' as const };
  const mainConfigWithJudge = {
    ...mockConfig,
    judgeConfiguration: { judges: [{ key: 'judge-flag', samplingRate: 1 }] },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockTrack.mockReset();
    (getClient as ReturnType<typeof vi.fn>).mockReturnValue({ track: mockTrack });
  });

  // Use mockImplementation so there is no queue — avoids stale state between tests.
  function mockExtractByKey(mainCfg = mainConfigWithJudge) {
    (extractVariation as ReturnType<typeof vi.fn>).mockImplementation(async (k: string) => {
      if (k === 'judge-flag') return { config: judgeConfig, meta: judgeMeta };
      return { config: mainCfg, meta: mockMeta };
    });
  }

  it('returns a JudgeTask with correct shape', async () => {
    mockExtractByKey();
    const handler = makeHandler();
    const { judgeTasks } = await config({ key: 'flag', handler, skipJudges: true }).invoke('q', mockContext);
    expect(judgeTasks).toHaveLength(1);
    const task = judgeTasks![0];
    expect(task.configKey).toBe('judge-flag');
    expect(task.actualOutput).toBe('hello');
    expect(task.evaluationMetricKey).toBe('judge-score');
    expect(task.judgeProvider).toBe('OpenAI');
    expect(task.judgeMode).toBe('messages');
    expect(task.collapseMessages).toBe(false);
    expect(task.parentTrackData).toMatchObject({ configKey: 'flag' });
  });

  it('sets collapseMessages=true when judge is messages-mode but only an agent handler is registered', async () => {
    // Main config is agent mode so the agentHandler can serve it.
    const agentMainMeta = { enabled: true, variationKey: 'v1', version: 1, mode: 'agent' as const };
    const agentMainConfig = {
      model: { name: 'gpt-4o' },
      provider: { name: 'OpenAI' },
      instructions: 'hi',
      judgeConfiguration: { judges: [{ key: 'judge-flag', samplingRate: 1 }] },
    };
    const judgeConfigWithMessages = {
      ...judgeConfig,
      instructions: undefined,
      messages: [{ role: 'system', content: 'You are a judge.' }],
    };
    (extractVariation as ReturnType<typeof vi.fn>).mockImplementation(async (k: string) => {
      if (k === 'judge-flag')
        return { config: judgeConfigWithMessages, meta: { ...judgeMeta, mode: 'messages' as const } };
      return { config: agentMainConfig, meta: agentMainMeta };
    });

    const agentHandler: ProviderHandler = vi.fn().mockResolvedValue({ output: 'ok', usage: {} });
    agentHandler.providesFor = ['OpenAI', 'agent'];

    const { judgeTasks } = await config({ key: 'flag', handler: agentHandler, skipJudges: true }).invoke(
      'q',
      mockContext,
    );
    expect(judgeTasks).toHaveLength(1);
    expect(judgeTasks![0].collapseMessages).toBe(true);
  });

  it('excludes judge tasks when no handler matches the judge provider', async () => {
    // Main config served by OpenAI+messages handler; judge config is also OpenAI+messages,
    // but a second Anthropic+messages handler is added to the list — judge should still match.
    // To test *exclusion*: make the judge config use a provider with NO matching handler.
    const anthropicJudgeConfig = { ...judgeConfig, provider: { name: 'Anthropic' } };
    (extractVariation as ReturnType<typeof vi.fn>).mockImplementation(async (k: string) => {
      if (k === 'judge-flag') return { config: anthropicJudgeConfig, meta: judgeMeta };
      return { config: mainConfigWithJudge, meta: mockMeta };
    });

    const handler = makeHandler(); // OpenAI+messages only
    const { judgeTasks } = await config({ key: 'flag', handler, skipJudges: true }).invoke('q', mockContext);
    expect(judgeTasks).toHaveLength(0);
  });

  it('returns empty judgeTasks when no judgeConfiguration present', async () => {
    (extractVariation as ReturnType<typeof vi.fn>).mockImplementation(async () => ({
      config: mockConfig,
      meta: mockMeta,
    }));
    const handler = makeHandler();
    const { judgeTasks } = await config({ key: 'flag', handler, skipJudges: true }).invoke('q', mockContext);
    expect(judgeTasks).toEqual([]);
  });
});

// ─── config().stream() — multi-handler routing ───────────────────────────────

describe('config().stream() — multi-handler routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTrack.mockReset();
    (extractVariation as ReturnType<typeof vi.fn>).mockResolvedValue({ config: mockConfig, meta: mockMeta });
    (runJudges as ReturnType<typeof vi.fn>).mockResolvedValue({});
    (getClient as ReturnType<typeof vi.fn>).mockReturnValue({ track: mockTrack });
  });

  it('selects the matching handler and streams', async () => {
    const openaiHandler = makeStreamingHandler(['streamed']);
    const claudeHandler: ProviderHandler = vi.fn().mockResolvedValue({ output: 'claude', usage: {} });
    claudeHandler.providesFor = ['Anthropic', 'messages'];
    claudeHandler.stream = vi.fn().mockImplementation(() => makeStreamGenerator(['claude'], {}));

    const events = await collectStream(
      config({ key: 'flag', handler: [claudeHandler, openaiHandler] }).stream('q', mockContext),
    );
    const chunks = events.filter((e) => e.type === 'chunk');
    expect(chunks).toEqual([{ type: 'chunk', text: 'streamed' }]);
    expect(claudeHandler.stream).not.toHaveBeenCalled();
  });

  it('yields a done event with correct response', async () => {
    const handler = makeStreamingHandler(['hello', ' there']);
    const events = await collectStream(config({ key: 'flag', handler: [handler] }).stream('q', mockContext));
    const done = events.find((e) => e.type === 'done') as any;
    expect(done.response).toBe('hello there');
  });

  it('throws when no matching handler is found', async () => {
    const claudeHandler: ProviderHandler = vi.fn().mockResolvedValue({ output: '', usage: {} });
    claudeHandler.providesFor = ['Anthropic', 'messages'];
    const gen = config({ key: 'flag', handler: [claudeHandler] }).stream('q', mockContext);
    await expect(collectStream(gen)).rejects.toThrow(/OpenAI/i);
  });
});
