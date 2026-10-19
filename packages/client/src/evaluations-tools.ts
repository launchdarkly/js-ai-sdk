/**
 * Evaluations from Code — the tools a run gives to its handler.
 *
 * Stub: the type is in place, but nothing is validated or copied yet.
 */

import type { NativeTool } from './types.js';

/** The executable behind an {@link EvalTool}: a function, or a provider-native tool. */
// biome-ignore lint/complexity/noBannedTypes: tool implementations are arbitrary caller functions, matching `ConfigArgs.toolHandlers`
export type EvalToolImplementation = Function | NativeTool;

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
 * tool, because the provider supplies its schema.
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
  readonly source: 'library' | 'inline' = 'inline';
  /** The library version `tools.get()` pinned. `undefined` for an inline tool. */
  readonly version: number | undefined = undefined;

  /**
   * Define an inline tool.
   *
   * @param key - The tool key. Must be lowercase.
   * @param implementation - The function the handler calls.
   * @param schema - JSON Schema for the tool's parameters. Required; `{}` is valid.
   * @param description - Description passed to the model. Defaults to `''`.
   */
  constructor(key: string, implementation: EvalToolImplementation, schema: Record<string, unknown>, description = '') {
    this.key = key;
    this.implementation = implementation;
    this.schema = schema;
    this.description = description;
  }
}
