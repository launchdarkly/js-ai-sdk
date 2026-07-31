import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NATIVE_TOOL_KEY, NativeTool } from '../types.js';

// Mock lifecycle so getClient() returns our stub without touching LD
vi.mock('../lifecycle.js', () => ({
  getClient: vi.fn(),
  initClient: vi.fn(),
  extractVariation: vi.fn(),
  shutdown: vi.fn(),
  waitForTelemetry: vi.fn(),
  shutdownTelemetry: vi.fn(),
}));

import { getClient } from '../lifecycle.js';
import { executeAndStream, executeAndTrack, wrapToolHandlers } from '../tracking.js';

const mockContext = { kind: 'user', key: 'test-user' } as const;
const mockTrackData = {
  runId: 'run-1',
  configKey: 'my-flag',
  variationKey: 'v1',
  version: 1,
  modelName: 'gpt-4o',
  providerName: 'OpenAI',
};

describe('wrapToolHandlers', () => {
  let mockTrack: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockTrack = vi.fn();
    (getClient as ReturnType<typeof vi.fn>).mockReturnValue({ track: mockTrack });
  });

  it('returns an empty object when toolHandlers is undefined', () => {
    expect(wrapToolHandlers(undefined, mockContext, mockTrackData)).toEqual({});
  });

  it('wraps a regular function and calls the original with args', () => {
    const original = vi.fn().mockReturnValue('tool-result');
    const wrapped = wrapToolHandlers({ myTool: original }, mockContext, mockTrackData);
    const result = wrapped.myTool('arg1', 'arg2');
    expect(original).toHaveBeenCalledWith('arg1', 'arg2');
    expect(result).toBe('tool-result');
  });

  it('emits $ld:ai:tool_call when a regular tool is called', () => {
    const wrapped = wrapToolHandlers({ myTool: vi.fn() }, mockContext, mockTrackData);
    wrapped.myTool();
    expect(mockTrack).toHaveBeenCalledWith(
      '$ld:ai:tool_call',
      mockContext,
      expect.objectContaining({ toolName: 'myTool' }),
      1,
    );
  });

  it('includes trackData fields in the tool_call event', () => {
    const wrapped = wrapToolHandlers({ search: vi.fn() }, mockContext, mockTrackData);
    wrapped.search();
    expect(mockTrack).toHaveBeenCalledWith(
      '$ld:ai:tool_call',
      mockContext,
      expect.objectContaining({ configKey: 'my-flag', runId: 'run-1', toolName: 'search' }),
      1,
    );
  });

  it('converts a NativeTool to a zero-arg tracking stub', () => {
    const native = new NativeTool(Symbol('native'), 'WebSearch');
    const wrapped = wrapToolHandlers({ webSearch: native }, mockContext, mockTrackData);
    expect(typeof wrapped.webSearch).toBe('function');
    wrapped.webSearch();
    expect(mockTrack).toHaveBeenCalledWith(
      '$ld:ai:tool_call',
      mockContext,
      expect.objectContaining({ toolName: 'webSearch' }),
      1,
    );
  });

  it('preserves the original NativeTool instance on NATIVE_TOOL_KEY', () => {
    const native = new NativeTool(Symbol('native'), 'WebSearch');
    const wrapped = wrapToolHandlers({ webSearch: native }, mockContext, mockTrackData);
    expect((wrapped.webSearch as any)[NATIVE_TOOL_KEY]).toBe(native);
  });

  it('skips $ld:ai:tool_call for __handoff_ prefixed tools', () => {
    const fn = vi.fn();
    const wrapped = wrapToolHandlers({ __handoff_nodeA: fn }, mockContext, mockTrackData);
    wrapped.__handoff_nodeA();
    expect(mockTrack).not.toHaveBeenCalled();
    expect(fn).toHaveBeenCalled();
  });

  it('handles multiple tools independently', () => {
    const toolA = vi.fn().mockReturnValue('a');
    const toolB = vi.fn().mockReturnValue('b');
    const wrapped = wrapToolHandlers({ toolA, toolB }, mockContext, mockTrackData);
    expect(wrapped.toolA()).toBe('a');
    expect(wrapped.toolB()).toBe('b');
    expect(mockTrack).toHaveBeenCalledTimes(2);
  });
});

// ─── Shared fixtures for executeAndTrack / executeAndStream ──────────────────

const execContext = { kind: 'user' as const, key: 'exec-user' };
const execMeta = { variationKey: 'v1', version: 2 };
const execConfig = {
  model: { name: 'gpt-4o' },
  provider: { name: 'OpenAI' },
  instructions: 'You are helpful.',
};

function makeHandler(output: string, usage: Record<string, any> = { input_tokens: 3, output_tokens: 7 }) {
  const fn = vi.fn().mockResolvedValue({ output, usage });
  (fn as any).providesFor = ['OpenAI', 'messages'];
  return fn as any;
}

// ─── executeAndTrack ─────────────────────────────────────────────────────────

describe('executeAndTrack', () => {
  let mockTrack: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockTrack = vi.fn();
    (getClient as ReturnType<typeof vi.fn>).mockReturnValue({ track: mockTrack });
  });

  it('returns response text from handler output', async () => {
    const handler = makeHandler('Hello!');
    const result = await executeAndTrack({
      configKey: 'my-flag',
      config: execConfig as any,
      meta: execMeta,
      userContext: execContext,
      handler,
    });
    expect(result.response).toBe('Hello!');
  });

  it('returns parsed usage with correct totals', async () => {
    const handler = makeHandler('hi', { input_tokens: 5, output_tokens: 10 });
    const result = await executeAndTrack({
      configKey: 'my-flag',
      config: execConfig as any,
      meta: execMeta,
      userContext: execContext,
      handler,
    });
    expect(result.usage).toEqual({ input: 5, output: 10, total: 15 });
  });

  it('includes configKey and variationKey in returned trackData', async () => {
    const handler = makeHandler('ok');
    const result = await executeAndTrack({
      configKey: 'flag-x',
      config: execConfig as any,
      meta: { variationKey: 'vA', version: 3 },
      userContext: execContext,
      handler,
    });
    expect(result.trackData.configKey).toBe('flag-x');
    expect(result.trackData.variationKey).toBe('vA');
    expect(result.trackData.version).toBe(3);
  });

  it('injects ldContext into variables passed to handler', async () => {
    const handler = makeHandler('ok');
    await executeAndTrack({
      configKey: 'f',
      config: execConfig as any,
      meta: execMeta,
      userContext: execContext,
      handler,
    });
    const vars = handler.mock.calls[0][3];
    expect(vars).toMatchObject({ ldContext: execContext });
  });

  it('emits $ld:ai:generation:success on success', async () => {
    await executeAndTrack({
      configKey: 'f',
      config: execConfig as any,
      meta: execMeta,
      userContext: execContext,
      handler: makeHandler('ok'),
    });
    expect(mockTrack).toHaveBeenCalledWith('$ld:ai:generation:success', execContext, expect.any(Object), 1);
  });

  it('emits $ld:ai:duration:total on success', async () => {
    await executeAndTrack({
      configKey: 'f',
      config: execConfig as any,
      meta: execMeta,
      userContext: execContext,
      handler: makeHandler('ok'),
    });
    const call = mockTrack.mock.calls.find((c: any[]) => c[0] === '$ld:ai:duration:total');
    expect(call).toBeDefined();
  });

  it('emits token events when usage > 0', async () => {
    const handler = makeHandler('ok', { input_tokens: 4, output_tokens: 6 });
    await executeAndTrack({
      configKey: 'f',
      config: execConfig as any,
      meta: execMeta,
      userContext: execContext,
      handler,
    });
    expect(mockTrack).toHaveBeenCalledWith('$ld:ai:tokens:total', execContext, expect.any(Object), 10);
    expect(mockTrack).toHaveBeenCalledWith('$ld:ai:tokens:input', execContext, expect.any(Object), 4);
    expect(mockTrack).toHaveBeenCalledWith('$ld:ai:tokens:output', execContext, expect.any(Object), 6);
  });

  it('emits $ld:ai:generation:error and duration, then re-throws on handler failure', async () => {
    const err = new Error('handler crashed');
    const handler: any = vi.fn().mockRejectedValue(err);
    handler.providesFor = ['OpenAI', 'messages'];
    await expect(
      executeAndTrack({ configKey: 'f', config: execConfig as any, meta: execMeta, userContext: execContext, handler }),
    ).rejects.toThrow('handler crashed');
    expect(mockTrack).toHaveBeenCalledWith('$ld:ai:generation:error', execContext, expect.any(Object), 1);
    expect(mockTrack).toHaveBeenCalledWith(
      '$ld:ai:duration:total',
      execContext,
      expect.any(Object),
      expect.any(Number),
    );
  });

  it('includes graphKey in trackData when provided', async () => {
    const handler = makeHandler('ok');
    const result = await executeAndTrack({
      configKey: 'f',
      config: execConfig as any,
      meta: execMeta,
      userContext: execContext,
      handler,
      graphKey: 'my-graph',
    });
    expect(result.trackData.graphKey).toBe('my-graph');
  });
});

// ─── executeAndStream ────────────────────────────────────────────────────────

describe('executeAndStream', () => {
  let mockTrack: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockTrack = vi.fn();
    (getClient as ReturnType<typeof vi.fn>).mockReturnValue({ track: mockTrack });
  });

  async function collectExecStream(gen: AsyncGenerator<any>) {
    const out: any[] = [];
    for await (const e of gen) out.push(e);
    return out;
  }

  function makeStreamingHandler(chunks: string[], usage: Record<string, any> = { input_tokens: 2, output_tokens: 3 }) {
    async function* streamFn() {
      for (const text of chunks) yield { type: 'chunk', text };
      yield { type: 'done', output: chunks.join(''), usage };
    }
    const fn = vi.fn() as any;
    fn.providesFor = ['OpenAI', 'messages'];
    fn.stream = streamFn;
    return fn;
  }

  it('yields chunk events from handler.stream', async () => {
    const handler = makeStreamingHandler(['Hello', ' world']);
    const events = await collectExecStream(
      executeAndStream({
        configKey: 'f',
        config: execConfig as any,
        meta: execMeta,
        userContext: execContext,
        handler,
      }),
    );
    const chunks = events.filter((e) => e.type === 'chunk').map((e) => e.text);
    expect(chunks).toEqual(['Hello', ' world']);
  });

  it('yields a done event as the last event with response and usage', async () => {
    const handler = makeStreamingHandler(['Hi'], { input_tokens: 1, output_tokens: 2 });
    const events = await collectExecStream(
      executeAndStream({
        configKey: 'f',
        config: execConfig as any,
        meta: execMeta,
        userContext: execContext,
        handler,
      }),
    );
    const done = events.at(-1);
    expect(done.type).toBe('done');
    expect(done.response).toBe('Hi');
    expect(done.usage).toEqual({ input: 1, output: 2, total: 3 });
  });

  it('falls back to the blocking handler when stream is not defined', async () => {
    const handler = makeHandler('fallback text', { input_tokens: 1, output_tokens: 1 });
    const events = await collectExecStream(
      executeAndStream({
        configKey: 'f',
        config: execConfig as any,
        meta: execMeta,
        userContext: execContext,
        handler,
      }),
    );
    const chunks = events.filter((e) => e.type === 'chunk').map((e) => e.text);
    expect(chunks).toEqual(['fallback text']);
    const done = events.at(-1);
    expect(done.type).toBe('done');
    expect(done.response).toBe('fallback text');
  });

  it('emits $ld:ai:generation:success and token events after stream completes', async () => {
    const handler = makeStreamingHandler(['ok'], { input_tokens: 2, output_tokens: 3 });
    await collectExecStream(
      executeAndStream({
        configKey: 'f',
        config: execConfig as any,
        meta: execMeta,
        userContext: execContext,
        handler,
      }),
    );
    expect(mockTrack).toHaveBeenCalledWith('$ld:ai:generation:success', execContext, expect.any(Object), 1);
    expect(mockTrack).toHaveBeenCalledWith('$ld:ai:tokens:total', execContext, expect.any(Object), 5);
  });

  it('emits $ld:ai:generation:error and re-throws on stream error', async () => {
    const err = new Error('stream failed');
    async function* failingStream() {
      throw err;
    }
    const handler: any = vi.fn();
    handler.providesFor = ['OpenAI', 'messages'];
    handler.stream = failingStream;
    await expect(
      collectExecStream(
        executeAndStream({
          configKey: 'f',
          config: execConfig as any,
          meta: execMeta,
          userContext: execContext,
          handler,
        }),
      ),
    ).rejects.toThrow('stream failed');
    expect(mockTrack).toHaveBeenCalledWith('$ld:ai:generation:error', execContext, expect.any(Object), 1);
  });

  it('injects ldContext into variables passed to blocking fallback handler', async () => {
    const handler = makeHandler('ok');
    await collectExecStream(
      executeAndStream({
        configKey: 'f',
        config: execConfig as any,
        meta: execMeta,
        userContext: execContext,
        handler,
        variables: { extra: 'val' },
      }),
    );
    const vars = handler.mock.calls[0][3];
    expect(vars).toMatchObject({ ldContext: execContext, extra: 'val' });
  });
});
