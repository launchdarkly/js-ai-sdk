/**
 * Evaluations from Code — the tools a run gives to its handler.
 *
 * A tool is defined in code (inline) or read from the LaunchDarkly tool library
 * with `tools.get()`. The source decides when the tool's request happens, what
 * the evaluation create body carries for it, and how strictly it is validated.
 * It changes nothing a handler sees.
 */

import {
  assertStrictJson,
  EvaluationsError,
  errorMessage,
  isPlainObject,
  type LDApiClient,
  LDApiError,
  requireObject,
  segment,
} from './evaluations-api.js';
import { NativeTool, type ToolHandlerFn } from './types.js';

/** The executable behind an {@link EvalTool}: a function, or a provider-native tool. */
// biome-ignore lint/complexity/noBannedTypes: tool implementations are arbitrary caller functions, matching `ConfigArgs.toolHandlers`
export type EvalToolImplementation = Function | NativeTool;

/** Set only while {@link libraryTool} constructs a tool, so a caller cannot build a library tool. */
let pendingLibrary: { version: number; projectKey: string } | undefined;

/**
 * Copy plain objects and arrays recursively, leaving every other value as it
 * is. A tool holds its own copy of the caller's schema, so a later change to
 * the caller's object cannot change what is validated or sent. Values that are
 * not JSON are kept, so that `run()` rejects them with a message naming the tool.
 */
function copyJson(value: unknown, seen: Map<object, unknown> = new Map()): unknown {
  if (!Array.isArray(value) && !isPlainObject(value)) return value;
  const existing = seen.get(value);
  if (existing) return existing;
  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    seen.set(value, copy);
    for (const item of value) copy.push(copyJson(item, seen));
    return copy;
  }
  const copy: Record<string, unknown> = {};
  seen.set(value, copy);
  for (const [key, item] of Object.entries(value)) copy[key] = copyJson(item, seen);
  return copy;
}

/**
 * A tool a run gives to its handler. Pass a list of these to
 * {@link EvaluationsModule.run}.
 *
 * Construct one to define a tool in code. `schema` is required, and `{}` is
 * valid. `source` is then `'inline'` and `version` is `undefined`. Neither is a
 * constructor argument, so a constructed tool is always inline.
 *
 * Call `await evals.tools.get(key, { implementation })` instead to use a tool
 * from the LaunchDarkly tool library. That returns a tool with `source`
 * `'library'` and the version it pinned.
 *
 * A key must be lowercase. A {@link NativeTool} is valid only for a library
 * tool, because the provider supplies its schema. A tool is frozen and holds
 * its own copy of `schema`.
 */
export class EvalTool {
  /** The tool key. Must be lowercase. */
  readonly key: string;
  /** The function the handler calls. */
  readonly implementation: EvalToolImplementation;
  /** JSON Schema for the tool's parameters. `{}` is valid for a tool that takes no arguments. */
  readonly schema: Readonly<Record<string, unknown>>;
  /** Description passed to the model. Defaults to `''`. */
  readonly description: string;
  /** `'inline'` for a tool defined in code, `'library'` for one read with `tools.get()`. */
  readonly source: 'library' | 'inline';
  /** The library version `tools.get()` pinned. `undefined` for an inline tool. */
  readonly version: number | undefined;
  /** The project `tools.get()` read a library tool from. `undefined` for an inline tool. */
  readonly projectKey: string | undefined;

  /**
   * Define an inline tool.
   *
   * @param key - The tool key. Must be lowercase.
   * @param implementation - The function the handler calls.
   * @param schema - JSON Schema for the tool's parameters. Required; `{}` is valid.
   * @param description - Description passed to the model. Defaults to `''`.
   */
  constructor(key: string, implementation: EvalToolImplementation, schema: Record<string, unknown>, description = '') {
    const library = pendingLibrary;
    pendingLibrary = undefined;
    this.key = key;
    this.implementation = implementation;
    this.schema = copyJson(schema) as Record<string, unknown>;
    this.description = description;
    this.source = library ? 'library' : 'inline';
    this.version = library?.version;
    this.projectKey = library?.projectKey;
    Object.freeze(this);
  }
}

/** Build a library tool. Used by {@link ToolsClient.get} only. */
function libraryTool(
  key: string,
  implementation: EvalToolImplementation,
  library: { version: number; projectKey: string; schema: Record<string, unknown>; description: string },
): EvalTool {
  pendingLibrary = { version: library.version, projectKey: library.projectKey };
  try {
    return new EvalTool(key, implementation, library.schema, library.description);
  } finally {
    pendingLibrary = undefined;
  }
}

/** Fold case for key comparison. `toLowerCase` alone leaves `ß` distinct from `ss`. */
const foldCase = (key: string): string => key.normalize('NFKC').toUpperCase().toLowerCase();

function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'object') return value.constructor?.name ?? 'object';
  return typeof value;
}

/** Validate a tool key. Throws {@link EvaluationsError}. */
export function validateToolKey(key: unknown): asserts key is string {
  if (typeof key !== 'string' || !key.trim()) throw new EvaluationsError('tool keys must not be blank');
  if (key !== key.toLowerCase()) {
    throw new EvaluationsError(`Tool key '${key}' must not use uppercase letters. Use '${key.toLowerCase()}' instead.`);
  }
}

/** Validate a tool implementation. Throws {@link EvaluationsError}. */
export function validateToolImplementation(key: string, implementation: unknown): void {
  if (typeof implementation !== 'function' && !(implementation instanceof NativeTool)) {
    throw new EvaluationsError(
      `Tool '${key}' implementation must be callable or a NativeTool, got ${describeType(implementation)}`,
    );
  }
}

function validateInlineTool(tool: EvalTool): void {
  const { key } = tool;
  if (tool.implementation instanceof NativeTool) {
    throw new EvaluationsError(
      `Inline tool '${key}' must not use a NativeTool: a native tool has no schema to define, because the ` +
        'provider supplies it. Call evals.tools.get() for a library tool, or give this tool a function.',
    );
  }
  if (!isPlainObject(tool.schema)) {
    throw new EvaluationsError(`Inline tool '${key}' schema must be a JSON object, got ${describeType(tool.schema)}`);
  }
  try {
    assertStrictJson(tool.schema, 'schema');
  } catch (err) {
    throw new EvaluationsError(`Inline tool '${key}' schema must be JSON-serializable: ${errorMessage(err)}`);
  }
}

/**
 * Validate a run's tools. Issues no requests. Throws {@link EvaluationsError}.
 *
 * Inline definitions are held to a stricter standard than library tools: a
 * library tool's description and schema are server data, while an inline
 * definition is caller input, and a bad one is cheapest to reject before any
 * record exists.
 */
export function validateTools(tools: readonly unknown[], projectKey: string): asserts tools is readonly EvalTool[] {
  const byIdentity = new Map<string, EvalTool>();
  for (const tool of tools) {
    if (!(tool instanceof EvalTool)) {
      throw new EvaluationsError(
        'each entry in tools must be an EvalTool. Construct one for an inline tool, or call evals.tools.get() ' +
          `for a library tool, got ${describeType(tool)}`,
      );
    }
    const { key } = tool;
    validateToolKey(key);
    validateToolImplementation(key, tool.implementation);
    if (typeof tool.description !== 'string') {
      throw new EvaluationsError(`Tool '${key}' description must be a string, got ${describeType(tool.description)}`);
    }
    if (tool.source === 'inline') {
      validateInlineTool(tool);
    } else if (tool.projectKey === undefined) {
      throw new EvaluationsError(`Library tool '${key}' has no project. Read it with evals.tools.get().`);
    } else if (tool.projectKey !== projectKey) {
      throw new EvaluationsError(
        `Tool '${key}' was read from project '${tool.projectKey}' and cannot run in project '${projectKey}'. ` +
          `Read it from '${projectKey}' instead.`,
      );
    }
    // One key names one tool. Never pick one entry silently: the run record
    // would then misdescribe where the model's tool came from.
    const identity = foldCase(key);
    const collision = byIdentity.get(identity);
    if (collision) {
      throw new EvaluationsError(
        `Tool '${key}' (${tool.source}) collides with '${collision.key}' (${collision.source}). ` +
          'A key may appear once in tools, compared without case.',
      );
    }
    byIdentity.set(identity, tool);
  }
}

/** The tools as the `{ key: executable }` map a handler receives. */
export function toolHandlerMap(tools: readonly EvalTool[]): Record<string, ToolHandlerFn | NativeTool> {
  return Object.fromEntries(tools.map((tool) => [tool.key, tool.implementation as ToolHandlerFn | NativeTool]));
}

/** The `tools` entry of a handler config. One shape for both sources. */
export function handlerConfigTools(
  tools: readonly EvalTool[],
): Record<string, { description: string; parameters: Record<string, unknown> }> {
  return Object.fromEntries(
    tools.map((tool) => [
      tool.key,
      { description: tool.description, parameters: copyJson(tool.schema) as Record<string, unknown> },
    ]),
  );
}

/** The `tools` array of an evaluation create body. */
export function createBodyTools(tools: readonly EvalTool[]): Record<string, unknown>[] {
  return tools.map((tool) =>
    tool.source === 'inline'
      ? { key: tool.key, schema: copyJson(tool.schema), description: tool.description, source: 'inline' }
      : { key: tool.key, version: tool.version, source: 'library' },
  );
}

/** Reads tools from the LaunchDarkly tool library. */
export interface ToolsClient {
  /**
   * Read library tool `key` now, pin its version, and pair it with
   * `implementation`. Throws {@link EvaluationsError} when the tool does not
   * exist in the project.
   */
  get(key: string, options: { implementation: EvalToolImplementation }): Promise<EvalTool>;
}

/** The {@link ToolsClient} behind {@link EvaluationsModule.tools}. */
export class LibraryToolsClient implements ToolsClient {
  constructor(
    private readonly api: LDApiClient,
    private readonly projectKey: string,
  ) {}

  async get(key: string, options: { implementation: EvalToolImplementation }): Promise<EvalTool> {
    validateToolKey(key);
    const implementation = options?.implementation;
    validateToolImplementation(key, implementation);
    const path = `projects/${segment(this.projectKey)}/ai-tools/${segment(key)}`;
    let raw: Record<string, unknown>;
    try {
      raw = requireObject(await this.api.get(path), `tool '${key}'`);
    } catch (err) {
      if (err instanceof LDApiError && err.status === 404) {
        throw new EvaluationsError(`LaunchDarkly AI tool '${key}' was not found in project '${this.projectKey}'`, {
          cause: err,
        });
      }
      throw err;
    }
    const { version } = raw;
    if (typeof version !== 'number' || !Number.isInteger(version)) {
      throw new EvaluationsError(`LaunchDarkly AI tool '${key}' has no integer version`);
    }
    return libraryTool(key, implementation, {
      version,
      projectKey: this.projectKey,
      schema: isPlainObject(raw.schema) ? raw.schema : {},
      description: typeof raw.description === 'string' ? raw.description : '',
    });
  }
}
