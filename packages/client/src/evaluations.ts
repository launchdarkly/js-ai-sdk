/**
 * Evaluations from Code — run a dataset through local code and report the
 * results to LaunchDarkly.
 *
 * Create a harness with {@link initEvaluations}, then call
 * {@link EvaluationsModule.run} on it. A run has two phases: a generation
 * phase that invokes the caller's handler once per dataset row, and an
 * evaluation phase that scores each output against LaunchDarkly judges or
 * local scorers.
 *
 * Stub: the public surface is in place, but every entry point throws
 * {@link EvaluationsError} until the harness is implemented.
 */

import type { Criterion } from './evaluations-criteria.js';
import type { EvalTool, EvalToolImplementation } from './evaluations-tools.js';
import type { ConfigMessage, ProviderHandler } from './types.js';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Base error for the evaluations harness. */
export class EvaluationsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvaluationsError';
  }
}

function notImplemented(name: string): never {
  throw new EvaluationsError(`${name} is not implemented yet`);
}

// ---------------------------------------------------------------------------
// Management API transport
// ---------------------------------------------------------------------------

/** One request the management API client sends through its {@link Transport}. */
export type TransportRequest = {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
};

/** The response a {@link Transport} returns. */
export type TransportResponse = {
  status: number;
  body: string;
  headers: Record<string, string>;
};

/** The seam every management API request goes through. Replaced in tests. */
export type Transport = (request: TransportRequest) => Promise<TransportResponse>;

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

/** Options for {@link initEvaluations}. Each falls back to its environment variable. */
export type InitEvaluationsOptions = {
  /** Project that holds the evaluations, tools and datasets. Default `LD_PROJECT_KEY`. */
  projectKey?: string;
  /** Management API access token. Default `LD_API_TOKEN`. */
  apiKey?: string;
  /**
   * SDK key for the client that emits result events. Default `LD_SDK_KEY`.
   * May be omitted only when a client is already initialized with `initClient`.
   */
  sdkKey?: string;
  /** Management API transport. Defaults to one built on `fetch`. */
  transport?: Transport;
};

/**
 * Resolve the project key and credentials and return the evaluations module.
 * Performs no network I/O.
 */
export function initEvaluations(_options: InitEvaluationsOptions = {}): EvaluationsModule {
  return notImplemented('initEvaluations');
}

// ---------------------------------------------------------------------------
// run() arguments
// ---------------------------------------------------------------------------

/** The two generation modes the LaunchDarkly UI shows. */
export type GenerationMode = 'completion' | 'agent';

/** Generation settings written in code, used when `run()` is given no `aiConfig`. */
export type GenerationConfig = {
  provider: string;
  model: string;
  /**
   * Choose `'completion'` when the prompt is a list of messages and the handler
   * sends one request to a chat or messages API. Choose `'agent'` when the
   * prompt is one instructions block and an agent framework runs the model, for
   * example OpenAI Agents, Claude Agents or LangChain agents. Must match the
   * mode of a handler in the pool. When unsure, use the AI Config's mode in
   * LaunchDarkly.
   */
  mode: GenerationMode;
  parameters?: Record<string, unknown>;
  instructions?: string;
  messages?: ConfigMessage[];
  promptSnippets?: Record<string, string>;
  outputFormat?: Record<string, unknown>;
};

/** Overrides layered over an AI Config variation. The AI Config supplies the mode. */
export type GenerationOverrides = Partial<Omit<GenerationConfig, 'mode'>>;

/** Identifies an existing AI Config variation to seed a run from. */
export type AIConfig = {
  /** The AI Config key. */
  key: string;
  /** The variation key. */
  variation: string;
};

/**
 * One row of an inline dataset, in the dataset-rows wire shape. A row's index
 * is its position in the list.
 */
export type InlineDatasetRow = {
  rowIdx?: number;
  input: string;
  expectedOutput?: string;
  variables?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
};

/**
 * Arguments to {@link EvaluationsModule.run}.
 *
 * Pass exactly one of `handler` and `handlers`, and either `generation` alone
 * or `aiConfig` with optional `generation` overrides.
 */
export type RunOptions = {
  /** Key for the evaluation this run creates. Must be unique per run. */
  key: string;
  /** A hosted dataset key, or the rows of an inline dataset. */
  dataset: string | readonly InlineDatasetRow[];
  tools?: readonly EvalTool[];
  criteria?: readonly Criterion[];
  concurrency?: number;
  pollIntervalSeconds?: number;
  pollTimeoutSeconds?: number;
} & ({ handler: ProviderHandler; handlers?: never } | { handlers: ProviderHandler[]; handler?: never }) &
  ({ generation: GenerationConfig; aiConfig?: never } | { aiConfig: AIConfig; generation?: GenerationOverrides });

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/** A dataset row as a scorer receives it. */
export type DatasetRow = {
  rowIndex: number;
  input?: string;
  expectedOutput?: string;
  variables: Record<string, unknown>;
  metadata?: Record<string, unknown>;
};

/** Row counts for an evaluation run. */
export type RunSummary = {
  totalRows: number;
  passedRows: number;
  failedRows: number;
  errorRows: number;
  pendingRows: number;
};

/** The result of an evaluation run, derived from its row summary. */
export type EvalRunResult = {
  passed: boolean;
  url: string;
  runId: string;
  summary: RunSummary;
};

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

/** Reads tools from the LaunchDarkly tool library. */
export interface ToolsClient {
  /** Read library tool `key` now, pin its version, and pair it with `implementation`. */
  get(key: string, options: { implementation: EvalToolImplementation }): Promise<EvalTool>;
}

/** Entry point for running LaunchDarkly evaluations from application code. */
export class EvaluationsModule {
  /** Project that holds this module's evaluations, tools and datasets. */
  readonly projectKey: string;
  /** Reader for tools in the LaunchDarkly tool library. */
  readonly tools: ToolsClient = {
    get: async () => notImplemented('tools.get'),
  };

  /** @internal Construct with {@link initEvaluations}. */
  constructor(projectKey: string) {
    this.projectKey = projectKey;
  }

  /**
   * Create an evaluation, generate an output for every dataset row, score each
   * output against `criteria`, and wait for LaunchDarkly's verdict.
   */
  async run(_options: RunOptions): Promise<EvalRunResult> {
    return notImplemented('run');
  }
}
