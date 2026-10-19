/**
 * Tool-call trajectory capture: what a unit of work (one evaluation row)
 * called on its way to its output.
 *
 * Handlers return only `{ output, usage }`, so once a handler finishes the
 * calls it made are gone. Wrapping the tool map the SDK hands a handler records
 * them without changing any handler package. A judge is the consumer: it can
 * only grade tool use it is shown.
 *
 * Only capture lives here. Rendering a trajectory for a judge's
 * `message_history` is added with the evaluation phase.
 */

import { NativeTool, type ToolHandlerFn } from './types.js';

/** Calls recorded per unit. Calls past the cap still run, and are counted. */
export const TRAJECTORY_MAX_CALLS = 50;

/** Router-injected handoff tools. Passed through, never recorded or described. */
const HANDOFF_TOOL_PREFIX = '__handoff_';

/** One recorded tool call. `args` is the single argument, or the argument list when there are several. */
export type TrajectoryCall = {
  key: string;
  args?: unknown;
  result?: unknown;
  error?: string;
  /** False while the call is still running. */
  done: boolean;
};

type ToolMap = Record<string, ToolHandlerFn | NativeTool>;

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

/**
 * Records the tool calls of one unit. Never share one across rows: rows run
 * concurrently against one tool map, so a shared recorder would splice their
 * calls together.
 */
export class TrajectoryRecorder {
  /** Calls in call-start order. */
  readonly calls: TrajectoryCall[] = [];
  /** Keys of the tools the unit was offered, excluding native and handoff tools. */
  readonly available: string[] = [];
  /** Calls that ran after the cap was reached. */
  droppedCalls = 0;

  /**
   * Return a copy of `tools` whose callables record into this recorder, under
   * the same keys. A wrapped tool returns and throws exactly what the original
   * does, and keeps its calling convention: a sync tool stays sync, and a
   * returned promise is handed back as a promise that records on settlement.
   */
  wrap(tools: ToolMap): ToolMap {
    const wrapped: ToolMap = {};
    for (const [key, implementation] of Object.entries(tools)) {
      if (
        implementation instanceof NativeTool ||
        typeof implementation !== 'function' ||
        key.startsWith(HANDOFF_TOOL_PREFIX)
      ) {
        // A native tool runs inside the provider, where no wrapper sees it.
        wrapped[key] = implementation;
        continue;
      }
      this.available.push(key);
      wrapped[key] = this.wrapOne(key, implementation as (...args: unknown[]) => unknown) as ToolHandlerFn;
    }
    return wrapped;
  }

  private wrapOne(key: string, implementation: (...args: unknown[]) => unknown) {
    const recorder = this;
    return function recorded(this: unknown, ...args: unknown[]): unknown {
      // Reserved before the call runs, so order is call-start order even when
      // a slow call started first finishes last.
      const call = recorder.reserve(key, args);
      let result: unknown;
      try {
        result = implementation.apply(this, args);
      } catch (err) {
        if (call) settle(call, { error: err });
        throw err;
      }
      if (!call) return result;
      if (isThenable(result)) {
        return Promise.resolve(result).then(
          (value) => {
            settle(call, { result: value });
            return value;
          },
          (err: unknown) => {
            settle(call, { error: err });
            throw err;
          },
        );
      }
      settle(call, { result });
      return result;
    };
  }

  private reserve(key: string, args: unknown[]): TrajectoryCall | undefined {
    if (this.calls.length >= TRAJECTORY_MAX_CALLS) {
      this.droppedCalls++;
      return undefined;
    }
    const call: TrajectoryCall = { key, done: false };
    if (args.length === 1) call.args = args[0];
    else if (args.length > 1) call.args = args;
    this.calls.push(call);
    return call;
  }
}

function settle(call: TrajectoryCall, outcome: { result?: unknown; error?: unknown }): void {
  call.done = true;
  if ('error' in outcome) {
    const { error } = outcome;
    call.error = error instanceof Error ? error.message : String(error);
  } else if (outcome.result !== undefined && outcome.result !== null) {
    call.result = outcome.result;
  }
}
