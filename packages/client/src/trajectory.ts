/**
 * Tool-call trajectory capture: what a unit of work (one evaluation row)
 * called on its way to its output.
 *
 * Handlers return only `{ output, usage }`, so once a handler finishes the
 * calls it made are gone. Wrapping the tool map the SDK hands a handler records
 * them without changing any handler package. A judge is the consumer: it can
 * only grade tool use it is shown.
 *
 * A rendered trajectory reaches a judge only inside `message_history`
 * (`buildMessageHistory`). It is never an event field. Two places capture: the
 * online tracked path (`executeAndTrack` / `executeAndStream`), one recorder
 * per invocation, and the evaluations runner, one recorder per row.
 */

import { NativeTool, type ToolHandlerFn } from './types.js';

/** Calls recorded per unit. Calls past the cap still run, and are counted. */
export const TRAJECTORY_MAX_CALLS = 50;

/** Router-injected handoff tools. Passed through, never recorded or described. */
export const HANDOFF_TOOL_PREFIX = '__handoff_';

/**
 * The tool keys a config offered the model, in declaration order: the
 * available list of an online trajectory. Leaves out a routed graph node's
 * synthetic handoff tools and native tools, which the provider runs where no
 * wrapper can observe them, so listing them would read as unused.
 */
export function exposedToolKeys(
  config: { tools?: Record<string, unknown> } | undefined,
  tools: ToolMap | undefined,
): string[] {
  return Object.keys(config?.tools ?? {}).filter(
    (key) => !key.startsWith(HANDOFF_TOOL_PREFIX) && !(tools?.[key] instanceof NativeTool),
  );
}

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
   *
   * `exposed` is the tool keys the config actually offered the model. Pass it
   * when the map can be wider than the config, as online, where a registry's
   * tools are merged in: describing those would let a judge penalise an agent
   * for ignoring a tool it was never offered. They become the available list,
   * and only they are recorded. Without it, every callable is in scope, which
   * is the offline case.
   */
  wrap(tools: ToolMap, exposed?: readonly string[]): ToolMap {
    const wrapped: ToolMap = {};
    // Rebuilt, so wrapping again cannot list a tool twice.
    this.available.length = 0;
    for (const [key, implementation] of Object.entries(tools)) {
      if (
        implementation instanceof NativeTool ||
        typeof implementation !== 'function' ||
        key.startsWith(HANDOFF_TOOL_PREFIX) ||
        (exposed !== undefined && !exposed.includes(key))
      ) {
        // Provider-executed, not callable, synthetic routing, or never offered
        // to the model: passed through untouched.
        wrapped[key] = implementation;
        continue;
      }
      if (exposed === undefined) this.available.push(key);
      wrapped[key] = this.wrapOne(key, implementation as (...args: unknown[]) => unknown) as ToolHandlerFn;
    }
    // A tool the config offers but no implementation backs could still be
    // called by the model, so it is available even though it cannot be observed.
    if (exposed !== undefined) this.available.push(...exposed);
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

/** The longest rendered argument bag or result. Longer values are cut and marked. */
export const TRAJECTORY_MAX_VALUE_CHARS = 2000;

const TRUNCATION_SUFFIX = '… (truncated)';

function truncate(text: string): string {
  if (text.length <= TRAJECTORY_MAX_VALUE_CHARS) return text;
  return text.slice(0, Math.max(TRAJECTORY_MAX_VALUE_CHARS - TRUNCATION_SUFFIX.length, 0)) + TRUNCATION_SUFFIX;
}

/** JSON with object keys sorted, so a rendering is deterministic. Non-ASCII is left as is: a model reads it. */
function sortedJson(value: unknown): string | undefined {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return item;
    return Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  });
}

/** An absent value renders as nothing, not as `null`: a tool that returned nothing did not return a null. */
function renderValue(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return truncate(value);
  let rendered: string | undefined;
  try {
    rendered = sortedJson(value);
  } catch {
    // Recording only observes: a value that cannot be serialized must not fail a call that succeeded.
    rendered = undefined;
  }
  if (rendered === undefined) {
    try {
      rendered = String(value);
    } catch {
      rendered = '<unrenderable value>';
    }
  }
  return truncate(rendered);
}

/**
 * Render a recorder's trajectory as the text a judge reads: the tools that
 * were available, then each call in call-start order with its arguments and
 * its result or error. `''` when the unit had no observable tools, so the
 * judge history gains no block at all. A unit that had tools and called none
 * says so, because that is what a tool-selection judge most needs to know.
 */
export function renderTrajectory(recorder: TrajectoryRecorder): string {
  const { available, calls, droppedCalls } = recorder;
  if (!available.length && !calls.length) return '';
  const lines: string[] = [];
  if (available.length) lines.push(`Tools available: ${available.join(', ')}`);
  if (!calls.length) {
    lines.push('No tool calls were made while producing the response.');
    return lines.join('\n');
  }
  lines.push('Tool calls made while producing the response, in order:');
  calls.forEach((call, index) => {
    lines.push(`${index + 1}. ${call.key}`);
    lines.push(`   arguments: ${renderValue(call.args)}`);
    if (call.error !== undefined) lines.push(`   error: ${renderValue(call.error)}`);
    else lines.push(`   result: ${renderValue(call.result)}`);
  });
  if (droppedCalls > 0) lines.push(`(${droppedCalls} further tool call(s) were made but not recorded.)`);
  return lines.join('\n');
}
