import { describe, expect, it } from 'vitest';
import {
  renderTrajectory,
  TRAJECTORY_MAX_CALLS,
  TRAJECTORY_MAX_VALUE_CHARS,
  TrajectoryRecorder,
} from '../trajectory.js';
import { NativeTool } from '../types.js';

type Fn = (...args: unknown[]) => unknown;

describe('TrajectoryRecorder', () => {
  it('records the key, arguments and result of each call, and returns what the tool returned', () => {
    const recorder = new TrajectoryRecorder();
    const tools = recorder.wrap({ lookup: (args: unknown) => ({ found: args }) });
    expect((tools.lookup as Fn)({ id: 1 })).toEqual({ found: { id: 1 } });
    expect(recorder.calls).toEqual([
      {
        key: 'lookup',
        args: { id: 1 },
        result: { found: { id: 1 } },
        done: true,
        startedAt: expect.any(Number),
        endedAt: expect.any(Number),
      },
    ]);
    expect(recorder.calls[0].endedAt).toBeGreaterThanOrEqual(recorder.calls[0].startedAt ?? Number.POSITIVE_INFINITY);
    expect(recorder.available).toEqual(['lookup']);
  });

  it('keeps a sync tool sync', () => {
    const recorder = new TrajectoryRecorder();
    const tools = recorder.wrap({ add: (a: unknown, b: unknown) => (a as number) + (b as number) });
    const result = (tools.add as Fn)(2, 3);
    expect(result).toBe(5);
    expect(recorder.calls[0].args).toEqual([2, 3]);
  });

  it('records an async tool when its promise settles', async () => {
    const recorder = new TrajectoryRecorder();
    const tools = recorder.wrap({ fetch: async () => 'body' });
    const pending = (tools.fetch as Fn)();
    expect(recorder.calls[0].done).toBe(false);
    await expect(pending).resolves.toBe('body');
    expect(recorder.calls[0]).toMatchObject({ result: 'body', done: true });
  });

  it('rethrows what the tool threw, and records the failure', async () => {
    const recorder = new TrajectoryRecorder();
    const failure = new Error('boom');
    const tools = recorder.wrap({
      sync: () => {
        throw failure;
      },
      async: async () => {
        throw failure;
      },
    });
    expect(() => (tools.sync as Fn)()).toThrow(failure);
    await expect((tools.async as Fn)()).rejects.toBe(failure);
    expect(recorder.calls.map((call) => call.error)).toEqual(['boom', 'boom']);
  });

  it('records in call-start order, not completion order', async () => {
    const recorder = new TrajectoryRecorder();
    let release!: () => void;
    const tools = recorder.wrap({
      slow: () => new Promise<string>((resolve) => (release = () => resolve('slow'))),
      fast: async () => 'fast',
    });
    const slow = (tools.slow as Fn)();
    await (tools.fast as Fn)();
    release();
    await slow;
    expect(recorder.calls.map((call) => call.key)).toEqual(['slow', 'fast']);
  });

  it('caps the recorded calls and counts the rest, which still run', () => {
    const recorder = new TrajectoryRecorder();
    let ran = 0;
    const tools = recorder.wrap({ tick: () => ++ran });
    for (let i = 0; i < TRAJECTORY_MAX_CALLS + 5; i++) (tools.tick as Fn)();
    expect(ran).toBe(TRAJECTORY_MAX_CALLS + 5);
    expect(recorder.calls).toHaveLength(TRAJECTORY_MAX_CALLS);
    expect(recorder.droppedCalls).toBe(5);
  });

  it('passes native and handoff tools through without recording or describing them', () => {
    const recorder = new TrajectoryRecorder();
    const native = new NativeTool(Symbol('search'), 'WebSearch');
    const handoff = () => 'routed';
    const tools = recorder.wrap({ search: native, __handoff_billing: handoff });
    expect(tools.search).toBe(native);
    expect((tools.__handoff_billing as Fn)()).toBe('routed');
    expect(recorder.calls).toEqual([]);
    expect(recorder.available).toEqual([]);
  });

  it('keeps two recorders over one tool map apart', async () => {
    const shared = { echo: async (value: unknown) => value };
    const a = new TrajectoryRecorder();
    const b = new TrajectoryRecorder();
    const toolsA = a.wrap(shared);
    const toolsB = b.wrap(shared);
    await Promise.all([(toolsA.echo as Fn)('a1'), (toolsB.echo as Fn)('b1'), (toolsA.echo as Fn)('a2')]);
    expect(a.calls.map((call) => call.result)).toEqual(['a1', 'a2']);
    expect(b.calls.map((call) => call.result)).toEqual(['b1']);
  });
});

describe('renderTrajectory', () => {
  it('renders nothing for a unit with no observable tools', () => {
    const recorder = new TrajectoryRecorder();
    recorder.wrap({ search: new NativeTool(Symbol('s'), 'WebSearch') });
    expect(renderTrajectory(recorder)).toBe('');
  });

  it('says so when tools were available and none was called', () => {
    const recorder = new TrajectoryRecorder();
    recorder.wrap({ lookup: () => 1, refund: () => 2 });
    expect(renderTrajectory(recorder)).toBe(
      'Tools available: lookup, refund\nNo tool calls were made while producing the response.',
    );
  });

  it('numbers each call with its arguments and its result or error', () => {
    const recorder = new TrajectoryRecorder();
    const tools = recorder.wrap({
      lookup: (args: unknown) => ({ status: 'shipped', id: (args as { id: string }).id }),
      refund: () => {
        throw new Error('not allowed');
      },
    });
    (tools.lookup as Fn)({ id: 'A-17' });
    expect(() => (tools.refund as Fn)({ amount: 5 })).toThrow();
    expect(renderTrajectory(recorder)).toBe(
      [
        'Tools available: lookup, refund',
        'Tool calls made while producing the response, in order:',
        '1. lookup',
        '   arguments: {"id":"A-17"}',
        '   result: {"id":"A-17","status":"shipped"}',
        '2. refund',
        '   arguments: {"amount":5}',
        '   error: not allowed',
      ].join('\n'),
    );
  });

  it('renders an absent value as nothing, not null', () => {
    const recorder = new TrajectoryRecorder();
    const tools = recorder.wrap({ ping: () => undefined });
    (tools.ping as Fn)();
    const text = renderTrajectory(recorder);
    expect(text).toContain('   arguments: \n');
    expect(text.endsWith('   result: ')).toBe(true);
    expect(text).not.toContain('null');
  });

  it('keeps non-ASCII characters unescaped', () => {
    const recorder = new TrajectoryRecorder();
    const tools = recorder.wrap({ city: () => ({ name: 'café 東京' }) });
    (tools.city as Fn)();
    const text = renderTrajectory(recorder);
    expect(text).toContain('café 東京');
    expect(text).not.toContain('\\u');
  });

  it('marks a value cut at the length bound', () => {
    const recorder = new TrajectoryRecorder();
    const tools = recorder.wrap({ dump: () => 'x'.repeat(5000) });
    (tools.dump as Fn)();
    const result = renderTrajectory(recorder).split('   result: ')[1];
    expect(result).toHaveLength(TRAJECTORY_MAX_VALUE_CHARS);
    expect(result.endsWith('(truncated)')).toBe(true);
  });

  it('counts calls past the cap', () => {
    const recorder = new TrajectoryRecorder();
    const tools = recorder.wrap({ tick: () => 1 });
    for (let i = 0; i < TRAJECTORY_MAX_CALLS + 2; i++) (tools.tick as Fn)();
    expect(renderTrajectory(recorder).endsWith('(2 further tool call(s) were made but not recorded.)')).toBe(true);
  });
});
