/**
 * Experimental features of the LaunchDarkly AI SDK core client.
 *
 * Import from `@launchdarkly/ai-server/experimental`. Every name here is
 * published, but may change in a minor release. None of these names is
 * exported from the package root.
 *
 * Current experimental features:
 *
 * - **Evaluations from Code** — run a dataset through local code and score
 *   the outputs with LaunchDarkly judges or local scorers.
 */

// ---------------------------------------------------------------------------
// Evaluations from Code
// ---------------------------------------------------------------------------

export type {
  AIConfig,
  DatasetRow,
  EvalRunResult,
  GenerationConfig,
  GenerationMode,
  GenerationOverrides,
  InitEvaluationsOptions,
  InlineDatasetRow,
  RunOptions,
  RunSummary,
} from './evaluations.js';
export { EvaluationsError, EvaluationsModule, initEvaluations } from './evaluations.js';
export type { Criterion } from './evaluations-criteria.js';
export { Judge, Scorer } from './evaluations-criteria.js';
export { EvalTool } from './evaluations-tools.js';
