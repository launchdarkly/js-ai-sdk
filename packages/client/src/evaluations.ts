/**
 * Evaluations from Code — run a dataset through local code and report the
 * results to LaunchDarkly.
 *
 * Create a harness with {@link initEvaluations}, then call
 * {@link EvaluationsModule.run} on it. A run has two phases: a generation
 * phase that invokes the caller's handler once per dataset row, and an
 * evaluation phase that scores each output against LaunchDarkly judges or
 * local scorers. Results reach LaunchDarkly only as SDK events; LaunchDarkly
 * rules on each row and the run summary reports the outcome.
 *
 * Every argument, judge and handler is checked before any record is created.
 * After records exist, a failing row or criterion is reported as an `ERROR`
 * result rather than thrown.
 */

import {
  assertStrictJson,
  DEFAULT_BASE_URI,
  DEFAULT_UI_BASE_URI,
  EvaluationsError,
  errorMessage,
  isPlainObject,
  LDApiClient,
  type LDApiClientOptions,
  segment,
  sleepSeconds,
  type Transport,
} from './evaluations-api.js';
import { type Criterion, Judge, validateCriteria } from './evaluations-criteria.js';
import {
  buildHandlerConfig,
  cancelEvaluationRun,
  createEvaluation,
  createEvaluationRun,
  type DatasetRef,
  DEFAULT_CONCURRENCY,
  DEFAULT_FLUSH_BOUND,
  EventSink,
  eventContext,
  fetchAiConfigMode,
  fetchDataset,
  fetchDatasetRows,
  fetchLatestVariation,
  fetchLinkedModelConfig,
  fetchSummary,
  GENERATION_EVENT_NAME,
  generateRows,
  generationPayload,
  type InlineRow,
  isTerminalSummary,
  type ResolvedGeneration,
  renderRow,
  SUMMARY_POLL_DEFAULTS,
  summaryTimeoutError,
  uploadDatasetRows,
  type VariationGeneration,
  variationGeneration,
  variationJudgeKeys,
  variationToolVersions,
} from './evaluations-runner.js';
import { CRITERION_EVENT_NAME, criterionPayload, resolveJudges, scoreRows } from './evaluations-scoring.js';
import {
  type EvalTool,
  LibraryToolsClient,
  type ToolsClient,
  toolHandlerMap,
  validateTools,
} from './evaluations-tools.js';
import { getClient, initClient } from './lifecycle.js';
import { findHandler } from './registry.js';
import type { ConfigMessage, LDClientInterface, ProviderHandler } from './types.js';
import { normalizeMode } from './utils.js';

export type { Transport, TransportRequest, TransportResponse } from './evaluations-api.js';
export { EvaluationsError } from './evaluations-api.js';

// ---------------------------------------------------------------------------
// Public types
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
  /**
   * Management API host. Default `LD_API_BASE_URI`, then
   * `https://app.launchdarkly.com`. Separate from the SDK's own `LD_BASE_URI`,
   * which points at event delivery, not the management API.
   */
  baseUri?: string;
  /** LaunchDarkly UI host used for run links. Default `LD_UI_BASE_URI`, then `https://app.launchdarkly.com`. */
  uiBaseUri?: string;
  /** Management API transport. Defaults to one built on `fetch`. */
  transport?: Transport;
};

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
  /** The most handler invocations in flight at once. Default 10. */
  concurrency?: number;
  /** Seconds between summary polls. Default 2. */
  pollIntervalSeconds?: number;
  /** Seconds to wait for every row to be accounted for. Default 180. */
  pollTimeoutSeconds?: number;
} & ({ handler: ProviderHandler; handlers?: never } | { handlers: ProviderHandler[]; handler?: never }) &
  ({ generation: GenerationConfig; aiConfig?: never } | { aiConfig: AIConfig; generation?: GenerationOverrides });

/** A dataset row as a scorer receives it. */
export type DatasetRow = {
  rowIndex: number;
  input: string | null;
  expectedOutput: string | null;
  variables: Record<string, unknown>;
  metadata: Record<string, unknown> | null;
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
  /** True when no row errored or failed. */
  passed: boolean;
  /** The run in the LaunchDarkly UI. */
  url: string;
  runId: string;
  summary: RunSummary;
};

export type { ToolsClient } from './evaluations-tools.js';

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

/** Read an environment variable, treating a blank value as unset. */
function env(name: string): string | undefined {
  return process.env[name]?.trim() || undefined;
}

function explicit(value: string | undefined): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function initializedClient(): LDClientInterface | undefined {
  try {
    return getClient();
  } catch {
    return undefined;
  }
}

const canEmitEvents = (client: LDClientInterface | undefined): boolean =>
  typeof client?.track === 'function' && typeof client?.flush === 'function';

/**
 * Resolve the project key and credentials and return the evaluations module.
 * Performs no network I/O, and throws before returning when any is missing.
 *
 * The SDK key may be omitted only when a client that can track and flush
 * events is already initialized with `initClient`: results reach LaunchDarkly
 * only as SDK events, so a run without one could never complete.
 */
export function initEvaluations(options: InitEvaluationsOptions = {}): EvaluationsModule {
  const projectKey = explicit(options.projectKey) ?? env('LD_PROJECT_KEY');
  if (!projectKey) {
    throw new EvaluationsError(
      'No LaunchDarkly project key provided. Set the LD_PROJECT_KEY environment variable or pass projectKey ' +
        'to initEvaluations().',
    );
  }
  const apiKey = explicit(options.apiKey) ?? env('LD_API_TOKEN');
  if (!apiKey) {
    throw new EvaluationsError(
      'No LaunchDarkly API access token provided. Set the LD_API_TOKEN environment variable or pass apiKey ' +
        'to initEvaluations().',
    );
  }
  const sdkKey = explicit(options.sdkKey) ?? env('LD_SDK_KEY');
  if (!sdkKey && !canEmitEvents(initializedClient())) {
    throw new EvaluationsError(
      'No LaunchDarkly SDK key provided and no initialized LaunchDarkly client to emit events with. Results ' +
        'reach LaunchDarkly through SDK events, so a run cannot complete without one: set the LD_SDK_KEY ' +
        'environment variable, pass sdkKey to initEvaluations(), or initialize a client first with initClient(client).',
    );
  }
  return new EvaluationsModule({
    projectKey,
    sdkKey,
    uiBaseUri: explicit(options.uiBaseUri) ?? env('LD_UI_BASE_URI') ?? DEFAULT_UI_BASE_URI,
    api: {
      apiKey,
      baseUri: explicit(options.baseUri) ?? env('LD_API_BASE_URI') ?? DEFAULT_BASE_URI,
      transport: options.transport,
    },
  });
}

// ---------------------------------------------------------------------------
// run() validation
// ---------------------------------------------------------------------------

const INLINE_ROW_FIELDS = ['rowIdx', 'input', 'expectedOutput', 'variables', 'metadata'];

const formatProvidesFor = (handlers: readonly ProviderHandler[]): string =>
  handlers.map((h) => `[${h.providesFor?.[0]}, ${h.providesFor?.[1]}]`).join(', ');

/** Validate the handler pool. Exactly one of `handler` and `handlers`. */
function validateHandlerPool(options: { handler?: unknown; handlers?: unknown }): ProviderHandler[] {
  const hasHandler = options.handler !== undefined;
  const hasHandlers = options.handlers !== undefined;
  if (hasHandler === hasHandlers) {
    throw new EvaluationsError('Pass exactly one of handler and handlers.');
  }
  let pool: unknown[];
  let name: (index: number) => string;
  if (hasHandler) {
    pool = [options.handler];
    name = () => 'handler';
  } else {
    if (!Array.isArray(options.handlers) || options.handlers.length === 0) {
      throw new EvaluationsError('handlers must be a non-empty array of handlers.');
    }
    pool = options.handlers;
    name = (index) => `handlers[${index}]`;
  }
  const seen = new Set<string>();
  pool.forEach((candidate, index) => {
    const advice = "Build it with createHandler() or a provider package's factory, so it declares providesFor.";
    if (typeof candidate !== 'function') throw new EvaluationsError(`${name(index)} must be callable. ${advice}`);
    const providesFor = (candidate as ProviderHandler).providesFor;
    if (!Array.isArray(providesFor) || typeof providesFor[0] !== 'string' || typeof providesFor[1] !== 'string') {
      throw new EvaluationsError(`${name(index)} does not declare providesFor. ${advice}`);
    }
    const identity = `${providesFor[0]}\u0000${normalizeMode(providesFor[1])}`;
    if (seen.has(identity)) {
      throw new EvaluationsError(
        `Two handlers provide for provider '${providesFor[0]}' in mode '${normalizeMode(providesFor[1])}'; ` +
          'the run cannot tell which one to use.',
      );
    }
    seen.add(identity);
  });
  return pool as ProviderHandler[];
}

function validatePollSetting(name: string, value: unknown): void {
  // NaN compares false against every deadline, and an infinite value never
  // elapses, so each would poll forever.
  if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) {
    throw new EvaluationsError(`${name} must be a finite, non-negative number`);
  }
}

/** Validate the dataset argument, returning an inline dataset's rows in the upload shape. */
function validateDataset(dataset: unknown): InlineRow[] | undefined {
  if (typeof dataset === 'string') {
    if (!dataset.trim()) throw new EvaluationsError('dataset must not be blank');
    return undefined;
  }
  // Arrays only: rows are read three times, and a one-shot iterable would be
  // empty after the first.
  if (!Array.isArray(dataset)) {
    throw new EvaluationsError('dataset must be a LaunchDarkly dataset key or an array of inline rows');
  }
  if (dataset.length === 0) throw new EvaluationsError('Inline dataset is empty');
  return dataset.map((row: unknown, position) => {
    if (!isPlainObject(row)) throw new EvaluationsError(`Inline dataset row ${position} must be a mapping`);
    const unknownKeys = Object.keys(row).filter((key) => !INLINE_ROW_FIELDS.includes(key));
    if (unknownKeys.length) {
      throw new EvaluationsError(
        `Inline dataset row ${position} has unknown fields: ${unknownKeys.map((k) => `'${k}'`).join(', ')}. ` +
          `Expected any of: ${INLINE_ROW_FIELDS.map((k) => `'${k}'`).join(', ')}`,
      );
    }
    if (row.rowIdx !== undefined && row.rowIdx !== position) {
      throw new EvaluationsError(
        `Inline dataset row ${position} has rowIdx ${JSON.stringify(row.rowIdx)}; an inline row's index is its ` +
          'position in the list',
      );
    }
    if (typeof row.input !== 'string' || !row.input) {
      throw new EvaluationsError(`Inline dataset row ${position} input must be a non-empty string`);
    }
    if (row.expectedOutput !== undefined && typeof row.expectedOutput !== 'string') {
      throw new EvaluationsError(`Inline dataset row ${position} expectedOutput must be a string`);
    }
    for (const field of ['variables', 'metadata'] as const) {
      const value = row[field];
      if (value === undefined) continue;
      if (!isPlainObject(value))
        throw new EvaluationsError(`Inline dataset row ${position} ${field} must be a mapping`);
      try {
        assertStrictJson(value, field);
      } catch (err) {
        throw new EvaluationsError(
          `Inline dataset row ${position} ${field} must be JSON without NaN or Infinity: ${errorMessage(err)}`,
        );
      }
    }
    return {
      rowIdx: position,
      input: row.input,
      expectedOutput: (row.expectedOutput as string | undefined) ?? null,
      variables: (row.variables as Record<string, unknown> | undefined) ?? {},
      metadata: (row.metadata as Record<string, unknown> | undefined) ?? null,
    };
  });
}

/** Validate `generation.mode` before normalizing it: `normalizeMode` reads any typo as `'messages'`. */
function validateMode(mode: unknown): 'agent' | 'messages' {
  if (mode === undefined) throw new EvaluationsError("generation.mode is required. Set it to 'completion' or 'agent'.");
  if (mode !== 'completion' && mode !== 'agent') {
    throw new EvaluationsError(`generation.mode must be 'completion' or 'agent', got ${JSON.stringify(mode)}.`);
  }
  return normalizeMode(mode);
}

function requireProviderAndModel(generation: VariationGeneration): { provider: string; model: string } {
  const { provider, model } = generation;
  if (typeof provider !== 'string' || !provider.trim()) throw new EvaluationsError('generation.provider is required');
  if (typeof model !== 'string' || !model.trim()) throw new EvaluationsError('generation.model is required');
  return { provider, model };
}

/** The handler for `provider` and `mode`, or a throw naming what the pool provides for. */
function requireCoverage(
  pool: readonly ProviderHandler[],
  provider: string,
  mode: 'agent' | 'messages',
): ProviderHandler {
  const handler = findHandler(pool, provider, mode);
  if (handler) return handler;
  throw new EvaluationsError(
    `No handler in the pool provides for provider '${provider}' in mode '${mode}'. The pool provides for: ` +
      `${formatProvidesFor(pool)}. A 'completion' generation needs a 'messages' handler, and an 'agent' ` +
      "generation needs an 'agent' handler.",
  );
}

/** The prompt must be the field the handler's mode reads. The harness never converts one into the other. */
function checkPrompt(generation: VariationGeneration, mode: 'agent' | 'messages', subject: string): void {
  if (mode === 'messages' && generation.instructions !== undefined) {
    throw new EvaluationsError(
      `The generation prompt needs messages, not instructions, because ${subject} is a messages handler.`,
    );
  }
  if (mode === 'agent' && generation.messages !== undefined) {
    throw new EvaluationsError(
      `The generation prompt needs instructions, not messages, because ${subject} is an agent handler.`,
    );
  }
}

function checkPromptExclusive(generation: VariationGeneration): void {
  if (generation.instructions !== undefined && generation.messages !== undefined) {
    throw new EvaluationsError('generation.instructions and generation.messages are mutually exclusive');
  }
}

/**
 * Layer a caller's overrides over a variation's settings. `parameters` merges
 * key by key. `instructions` and `messages` are one prompt slot: overriding
 * either removes both fetched fields.
 */
function mergeGeneration(base: VariationGeneration, overrides: Record<string, unknown>): VariationGeneration {
  const merged: Record<string, unknown> = { ...base };
  if ('instructions' in overrides || 'messages' in overrides) {
    delete merged.instructions;
    delete merged.messages;
  }
  for (const [field, value] of Object.entries(overrides)) {
    if (value === undefined) continue;
    if (field === 'parameters' && isPlainObject(value)) {
      merged.parameters = { ...(isPlainObject(merged.parameters) ? merged.parameters : {}), ...value };
    } else {
      merged[field] = value;
    }
  }
  return merged as VariationGeneration;
}

// biome-ignore lint/suspicious/noConsole: this package has no logger abstraction; a misconfigured run must be visible
const warn = (message: string) => console.warn(`[LaunchDarkly] ${message}`);

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

/** @internal What {@link initEvaluations} passes to {@link EvaluationsModule}. Tests inject the rest. */
export type EvaluationsModuleInternals = {
  projectKey: string;
  sdkKey: string | undefined;
  api: LDApiClientOptions;
  /** UI host for run links. Default {@link DEFAULT_UI_BASE_URI}. */
  uiBaseUri?: string;
  /** Events tracked between flushes. Default 500. */
  flushBound?: number;
  /** Waits between summary polls. */
  sleep?: (seconds: number) => Promise<void>;
};

/** Entry point for running LaunchDarkly evaluations from application code. */
export class EvaluationsModule {
  /** Project that holds this module's evaluations, tools and datasets. */
  readonly projectKey: string;
  /** Reader for tools in the LaunchDarkly tool library. */
  readonly tools: ToolsClient;
  /** SDK key whose client carries results to LaunchDarkly. `undefined` when an initialized client is reused. */
  readonly sdkKey: string | undefined;
  /** LaunchDarkly UI host used for run links. */
  readonly uiBaseUri: string;

  private readonly api: LDApiClient;
  private readonly flushBound: number;
  private readonly sleep: (seconds: number) => Promise<void>;

  /**
   * @internal Construct with {@link initEvaluations}. The argument is
   * {@link EvaluationsModuleInternals}, typed `unknown` so that internal types
   * stay off the public surface.
   */
  constructor(internalsArg: unknown) {
    const internals = internalsArg as EvaluationsModuleInternals;
    this.projectKey = internals.projectKey;
    this.sdkKey = internals.sdkKey;
    this.uiBaseUri = (internals.uiBaseUri ?? DEFAULT_UI_BASE_URI).replace(/\/+$/, '');
    this.api = new LDApiClient(internals.api);
    this.tools = new LibraryToolsClient(this.api, this.projectKey);
    this.flushBound = internals.flushBound ?? DEFAULT_FLUSH_BOUND;
    this.sleep = internals.sleep ?? sleepSeconds;
  }

  /**
   * Create an evaluation, generate an output for every dataset row, and wait
   * for LaunchDarkly to account for every row.
   *
   * Each row is generated once by the handler in the pool that provides for
   * the generation's provider and mode, and reported as one SDK event. A
   * handler error marks its row `ERROR` instead of failing the run. Every
   * argument is checked before any network I/O, and every check before any
   * record is created.
   *
   * Pass `aiConfig` to start from an existing AI Config variation. Its model,
   * provider, parameters, prompt and output format become the defaults, and
   * `generation` overrides them field by field. When `tools` is omitted the
   * variation's tools are used, so each needs an implementation.
   *
   * A CI script can exit with `result.passed ? 0 : 1`.
   */
  async run(options: RunOptions): Promise<EvalRunResult> {
    const { key, dataset, tools, criteria } = options;
    const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
    const pollIntervalSeconds = options.pollIntervalSeconds ?? SUMMARY_POLL_DEFAULTS.intervalSeconds;
    const pollTimeoutSeconds = options.pollTimeoutSeconds ?? SUMMARY_POLL_DEFAULTS.timeoutSeconds;

    // ---- Local validation: no network I/O. ----
    if (typeof key !== 'string' || !key.trim()) throw new EvaluationsError('key must not be blank');
    const inlineRows = validateDataset(dataset);
    const pool = validateHandlerPool(options);
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new EvaluationsError('concurrency must be an integer of at least 1');
    }
    validatePollSetting('pollIntervalSeconds', options.pollIntervalSeconds);
    validatePollSetting('pollTimeoutSeconds', options.pollTimeoutSeconds);
    const runTools = [...(tools ?? [])];
    validateTools(runTools, this.projectKey);

    const { aiConfig } = options;
    const generationArg = options.generation as Record<string, unknown> | undefined;
    if (aiConfig === undefined && generationArg === undefined) {
      throw new EvaluationsError('Pass generation, or aiConfig to evaluate an existing AI Config variation.');
    }
    if (generationArg !== undefined && !isPlainObject(generationArg)) {
      throw new EvaluationsError('generation must be an object');
    }
    let generation: ResolvedGeneration | undefined;
    let handler: ProviderHandler | undefined;
    if (aiConfig === undefined) {
      const settings = generationArg as GenerationConfig;
      const mode = validateMode(settings.mode);
      const { provider, model } = requireProviderAndModel(settings);
      checkPromptExclusive(settings);
      handler = requireCoverage(pool, provider, mode);
      checkPrompt(settings, mode, `the selected handler ${formatProvidesFor([handler])}`);
      generation = { ...withoutMode(settings), provider, model, mode };
    } else {
      for (const field of ['key', 'variation'] as const) {
        if (typeof aiConfig?.[field] !== 'string' || !aiConfig[field].trim()) {
          throw new EvaluationsError(`aiConfig.${field} must not be blank`);
        }
      }
      if (generationArg && 'mode' in generationArg) {
        throw new EvaluationsError(
          'generation.mode cannot be set with aiConfig: the AI Config supplies the mode, and its prompt shape depends on it.',
        );
      }
    }

    if (criteria !== undefined) validateCriteria(criteria);

    // ---- The event client, before any management API request. ----
    const client = await this.resolveClient();
    let variationJudges: string[] = [];

    // ---- AI Config reads, each check as soon as its input arrives. ----
    if (aiConfig !== undefined) {
      const resolved = await this.resolveAiConfig(aiConfig, generationArg ?? {}, pool, tools, runTools);
      generation = resolved.generation;
      handler = resolved.handler;
      variationJudges = resolved.judgeKeys;
    }
    if (!generation || !handler) throw new EvaluationsError('generation could not be resolved');

    // ---- Criteria: the caller's, or else the variation's judges with default thresholds. ----
    const runCriteria: readonly Criterion[] = criteria ?? variationJudges.map((judgeKey) => new Judge(judgeKey));
    validateCriteria(runCriteria);
    // Flag delivery, not the management API: no request, and before any record exists.
    const judges = await resolveJudges(
      this.projectKey,
      runCriteria.filter((criterion): criterion is Judge => criterion instanceof Judge),
      pool,
    );

    // ---- Dataset, then the records. ----
    let datasetRef: DatasetRef;
    let rows: DatasetRow[];
    if (inlineRows === undefined) {
      datasetRef = await fetchDataset(this.api, this.projectKey, dataset as string);
      rows = await fetchDatasetRows(this.api, this.projectKey, dataset as string);
    } else {
      datasetRef = {};
      rows = inlineRows.map((row) => renderRow(row.rowIdx, row));
    }
    const evaluation = await createEvaluation(this.api, this.projectKey, key, generation, runTools, runCriteria);
    const run = await createEvaluationRun(this.api, this.projectKey, evaluation.id, datasetRef.id);
    if (inlineRows !== undefined) {
      // Every batch must land before the first event: the run starts with a
      // placeholder row count, so an early result would complete the run.
      try {
        await uploadDatasetRows(this.api, this.projectKey, evaluation.id, run.id, inlineRows);
      } catch (err) {
        // The API cannot mark a run failed; cancel is the only terminal state
        // a client can set, and it keeps the run from sitting PENDING.
        try {
          await cancelEvaluationRun(this.api, this.projectKey, evaluation.id, run.id);
        } catch (cancelErr) {
          warn(
            `Failed to cancel evaluation run ${run.id} after its inline dataset upload failed: ${errorMessage(cancelErr)}`,
          );
        }
        throw err;
      }
    }

    // ---- Generation phase. ----
    const config = buildHandlerConfig(generation, runTools);
    const results = await generateRows(rows, handler, config, toolHandlerMap(runTools), concurrency);
    const ids = { projectKey: this.projectKey, evaluation, run, dataset: datasetRef };
    const sink = new EventSink(client, this.flushBound);
    const context = eventContext(ids);
    try {
      for (const result of results) await sink.track(GENERATION_EVENT_NAME, context, generationPayload(ids, result));

      // ---- Evaluation phase: after every row has generated, so phases never overlap. ----
      if (runCriteria.length) {
        await sink.flush();
        const scored = await scoreRows(results, runCriteria, judges, concurrency);
        for (const result of scored) {
          // One event that fails to build or track must not cost the others.
          // It does cost its row, which LaunchDarkly cannot account for.
          try {
            await sink.track(CRITERION_EVENT_NAME, context, criterionPayload(ids, result));
          } catch (err) {
            warn(
              `Failed to emit the criterion event for row ${result.rowIndex}, criterion ` +
                `'${result.criterion instanceof Judge ? result.criterion.key : result.criterion.name}': ${errorMessage(err)}`,
            );
          }
        }
      }
    } finally {
      // Events already queued must reach LaunchDarkly even when a later step fails.
      await sink.flush();
    }

    // ---- Summary. ----
    const summary = await this.pollSummary(
      evaluation.id,
      run.id,
      pollIntervalSeconds,
      pollTimeoutSeconds,
      runCriteria.length,
    );
    return {
      passed: summary.errorRows === 0 && summary.failedRows === 0 && summary.pendingRows === 0,
      url:
        `${this.uiBaseUri}/projects/${segment(this.projectKey)}/ai/evaluations/${segment(evaluation.id)}` +
        `/runs/${segment(run.id)}`,
      runId: run.id,
      summary,
    };
  }

  /**
   * Read an AI Config variation as the run's generation settings, running each
   * check as soon as the read that supplies its input returns.
   */
  private async resolveAiConfig(
    aiConfig: AIConfig,
    overrides: Record<string, unknown>,
    pool: readonly ProviderHandler[],
    toolsArg: readonly EvalTool[] | undefined,
    runTools: readonly EvalTool[],
  ): Promise<{ generation: ResolvedGeneration; handler: ProviderHandler; judgeKeys: string[] }> {
    const label = `'${aiConfig.key}'/'${aiConfig.variation}'`;

    const configMode = await fetchAiConfigMode(this.api, this.projectKey, aiConfig.key);
    const mode = normalizeMode(configMode);
    if (!pool.some((h) => h.providesFor?.[1] === mode)) {
      throw new EvaluationsError(
        `AI Config '${aiConfig.key}' has mode '${configMode}', and no handler in the pool provides for mode ` +
          `'${mode}'. The pool provides for: ${formatProvidesFor(pool)}.`,
      );
    }

    const variation = await fetchLatestVariation(this.api, this.projectKey, aiConfig.key, aiConfig.variation);
    // The prompt does not depend on the model config, so it is checked before that read.
    const prompt = mergeGeneration(variationGeneration(variation, undefined, mode), overrides);
    checkPromptExclusive(prompt);
    const needed = mode === 'agent' ? 'instructions' : 'messages';
    const wrong = mode === 'agent' ? 'messages' : 'instructions';
    if (prompt[wrong] !== undefined) {
      throw new EvaluationsError(
        `AI Config variation ${label} has mode '${configMode}', which needs a ${needed} prompt, but it has ` +
          `${wrong}. Override generation.${needed} to run it.`,
      );
    }

    const modelConfig = await fetchLinkedModelConfig(
      this.api,
      this.projectKey,
      aiConfig.key,
      aiConfig.variation,
      variation,
    );
    const merged = mergeGeneration(variationGeneration(variation, modelConfig, mode), overrides);
    const { provider, model } = requireProviderAndModel(merged);
    const handler = requireCoverage(pool, provider, mode);

    // The variation's tools are the default; the caller's tools replace them.
    const pinned = variationToolVersions(variation);
    if (toolsArg === undefined && pinned.size) {
      throw new EvaluationsError(
        `AI Config variation ${label} uses tools with no implementation: ` +
          `${[...pinned.keys()].map((k) => `'${k}'`).join(', ')}. Pass tools with an EvalTool for each.`,
      );
    }
    const byKey = new Map(runTools.map((tool) => [tool.key, tool]));
    for (const [toolKey, version] of pinned) {
      const tool = byKey.get(toolKey);
      if (!tool) warn(`AI Config variation ${label} attaches tool '${toolKey}', which this run does not use.`);
      else if (tool.version !== undefined && tool.version !== version) {
        warn(
          `AI Config variation ${label} pins tool '${toolKey}' at version ${version}; the run uses version ${tool.version}.`,
        );
      }
    }

    return {
      generation: { ...(merged as Omit<ResolvedGeneration, 'mode'>), provider, model, mode },
      handler,
      // The variation's judges are the default criteria.
      judgeKeys: variationJudgeKeys(variation),
    };
  }

  /** The SDK client that carries results. Resolved before any record is created. */
  private async resolveClient(): Promise<LDClientInterface> {
    const existing = initializedClient();
    if (existing) {
      if (this.sdkKey) {
        warn(
          'A LaunchDarkly client is already initialized; evaluation events are sent with it and the evaluations ' +
            'SDK key is ignored. Both must point at the project under evaluation.',
        );
      }
      return existing;
    }
    if (!this.sdkKey) {
      throw new EvaluationsError(
        'No LaunchDarkly SDK key provided and no initialized LaunchDarkly client is available to deliver events.',
      );
    }
    return initClient({ sdkKey: this.sdkKey });
  }

  private async pollSummary(
    evaluationId: string,
    runId: string,
    intervalSeconds: number,
    timeoutSeconds: number,
    criteriaCount: number,
  ): Promise<RunSummary> {
    const deadline = performance.now() + timeoutSeconds * 1000;
    for (;;) {
      const summary = await fetchSummary(this.api, this.projectKey, evaluationId, runId);
      if (isTerminalSummary(summary)) return summary;
      const remainingSeconds = (deadline - performance.now()) / 1000;
      if (remainingSeconds <= 0) throw summaryTimeoutError(runId, timeoutSeconds, summary, criteriaCount);
      await this.sleep(Math.min(intervalSeconds, remainingSeconds));
    }
  }
}

function withoutMode(settings: GenerationConfig): Omit<GenerationConfig, 'mode'> {
  const { mode: _mode, ...rest } = settings;
  return rest;
}
