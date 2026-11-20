/** A throwing tool in an evaluation answers the model with an error result. */

import { describe, expect, it } from 'vitest';
import { returnToolErrors, toolErrorResult } from '../evaluations-tools.js';
import { TrajectoryRecorder } from '../trajectory.js';
import { NativeTool } from '../types.js';

type Fn = (...args: unknown[]) => unknown;

class RangeErrorish extends Error {}

const noStation = (args: { city: string }) => {
  throw new TypeError(`No weather station for '${args.city}'`);
};

describe('returnToolErrors', () => {
  it('returns a sync throw as the result, stays sync, and the recorder still records the error', () => {
    const recorder = new TrajectoryRecorder();
    const tools = returnToolErrors(recorder.wrap({ get_weather: noStation }));

    const result = (tools.get_weather as Fn)({ city: 'Reykjavik' });

    expect(result).toBe("Error: TypeError: No weather station for 'Reykjavik'");
    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0]).toMatchObject({ error: "No weather station for 'Reykjavik'" });
    expect(recorder.calls[0].result).toBeUndefined();
  });

  it('returns an async rejection as the result', async () => {
    const recorder = new TrajectoryRecorder();
    const tools = returnToolErrors(
      recorder.wrap({
        get_weather: async (args: { city: string }) => {
          throw new RangeErrorish(`No weather station for '${args.city}'`);
        },
      }),
    );

    const result = (tools.get_weather as Fn)({ city: 'Reykjavik' });

    expect(result).toBeInstanceOf(Promise);
    expect(await result).toBe("Error: RangeErrorish: No weather station for 'Reykjavik'");
    expect(recorder.calls[0]).toMatchObject({ error: "No weather station for 'Reykjavik'", done: true });
  });

  it('leaves a working tool and a native tool unchanged', async () => {
    const native = new NativeTool(Symbol('search'), 'WebSearch');
    const tools = returnToolErrors({
      get_weather: (args: { city: string }) => ({ city: args.city, temp_c: 14 }),
      later: async () => 'done',
      search: native,
    });

    expect((tools.get_weather as Fn)({ city: 'Tokyo' })).toEqual({ city: 'Tokyo', temp_c: 14 });
    expect(await (tools.later as Fn)()).toBe('done');
    expect(tools.search).toBe(native);
  });

  it('keeps a tool keyed __proto__, answers its error and lists it as available', () => {
    const recorder = new TrajectoryRecorder();
    const tools = returnToolErrors(recorder.wrap(Object.fromEntries([['__proto__', noStation]])));

    expect(Object.hasOwn(tools, '__proto__')).toBe(true);
    const result = (tools.__proto__ as unknown as Fn)({ city: 'Reykjavik' });

    expect(result).toBe("Error: TypeError: No weather station for 'Reykjavik'");
    expect(recorder.available).toContain('__proto__');
    expect(recorder.calls.map((call) => call.key)).toEqual(['__proto__']);
  });
});

describe('toolErrorResult', () => {
  it('names a non-Error throw by its type', () => {
    expect(toolErrorResult('quota exceeded')).toBe('Error: string: quota exceeded');
  });
});
