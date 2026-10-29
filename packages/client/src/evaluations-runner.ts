/**
 * Evaluations from Code — the management API operations and the generation
 * phase behind {@link EvaluationsModule.run}.
 *
 * Internal: nothing here is exported from an entry point.
 */

import { createHash } from 'node:crypto';
import type { Span } from '@opentelemetry/api';
import type { DatasetRow, RunSummary } from './evaluations.js';
import {
  EvaluationsError,
  errorMessage,
  isPlainObject,
  type LDApiClient,
  LDApiError,
  requireObject,
  requireString,
  segment,
} from './evaluations-api.js';
import { type Criterion, criterionWire } from './evaluations-criteria.js';
import {
  captureFor,
  finishRowSpan,
  recordChat,
  recordToolCalls,
  startRowSpan,
  traceHandlerCall,
  withActiveSpan,
  withEvaluationRow,
} from './evaluations-spans.js';
import { createBodyTools, type EvalTool, handlerConfigTools } from './evaluations-tools.js';
import { TrajectoryRecorder } from './trajectory.js';
import type {
  AiConfigRep,
  ConfigMessage,
  LDClientInterface,
  NativeTool,
  ProviderHandler,
  ToolHandlerFn,
} from './types.js';
import { parseTemplate, parseUsage } from './utils.js';

export const DATASET_PAGE_SIZE = 200;
export const DATASET_UPLOAD_BATCH_SIZE = 500;
export const GENERATION_EVENT_NAME = '$ld:ai:offline-evals:generation';
/** The most events left queued between flushes. The SDK's event buffer drops overflow silently. */
export const DEFAULT_FLUSH_BOUND = 500;
export const DEFAULT_CONCURRENCY = 10;

/**
 * Summary polling defaults, in seconds. A mutable object so that tests of the
 * default path can shorten them.
 */
export const SUMMARY_POLL_DEFAULTS = { intervalSeconds: 2, timeoutSeconds: 180 };

const HANDLER_ERROR_CODE = 5001;

/** Generation settings after validation, with the mode already normalized for handler selection. */
export type ResolvedGeneration = {
  provider: string;
  model: string;
  mode: 'agent' | 'messages';
  parameters?: Record<string, unknown>;
  instructions?: string;
  messages?: ConfigMessage[];
  promptSnippets?: Record<string, string>;
  outputFormat?: Record<string, unknown>;
};

/** Generation settings read from an AI Config variation, before overrides. */
export type VariationGeneration = Partial<Omit<ResolvedGeneration, 'mode'>>;

/** Identifiers of the dataset a run reads. Both are `undefined` for an inline dataset. */
export type DatasetRef = { id?: string; key?: string };

export type EvaluationRef = { id: string; key: string; version: number };

export type EvaluationRunRef = { id: string; evaluationId: string; state: string };

/** One generated row. Carries the trajectory forward for the evaluation phase. */
export type RowResult = {
  row: DatasetRow;
  status: 'COMPLETE' | 'ERROR';
  output?: unknown;
  usage?: Record<string, unknown>;
  error?: { code: number; message: string };
  startedAt: string;
  generatedAt: string;
  latencyMs: number;
  trajectory: TrajectoryRecorder;
  /** The row's open `launchdarkly.dataset_row` root, when the run traces rows. The run ends it. */
  span?: Span;
};

// ---------------------------------------------------------------------------
// Dataset rows
// ---------------------------------------------------------------------------

/**
 * Render one dataset row for handler invocation. Shared by hosted and inline
 * datasets, so a row renders the same whichever source supplied it.
 */
export function renderRow(
  rowIndex: number,
  values: { input: unknown; expectedOutput: unknown; variables: unknown; metadata: unknown },
): DatasetRow {
  const variables: Record<string, unknown> = isPlainObject(values.variables) ? { ...values.variables } : {};
  const input = typeof values.input === 'string' ? parseTemplate(values.input, variables) : null;
  const expectedOutput =
    typeof values.expectedOutput === 'string' ? parseTemplate(values.expectedOutput, variables) : null;
  // Dataset templates reference these exact keys in every language.
  variables.input = input;
  variables.expected_output = expectedOutput;
  return {
    rowIndex,
    input,
    expectedOutput,
    variables,
    metadata: isPlainObject(values.metadata) ? { ...values.metadata } : null,
  };
}

// ---------------------------------------------------------------------------
// Management API operations
// ---------------------------------------------------------------------------

async function getOr404<T>(request: () => Promise<T>, notFound: () => string): Promise<T> {
  try {
    return await request();
  } catch (err) {
    if (err instanceof LDApiError && err.status === 404) throw new EvaluationsError(notFound(), { cause: err });
    throw err;
  }
}

/** Read an AI Config's mode. An absent mode is `completion`, the API default. */
export async function fetchAiConfigMode(
  api: LDApiClient,
  projectKey: string,
  configKey: string,
): Promise<'agent' | 'completion' | 'judge'> {
  const raw = await getOr404(
    async () =>
      requireObject(
        await api.get(`projects/${segment(projectKey)}/ai-configs/${segment(configKey)}`),
        `AI Config '${configKey}'`,
      ),
    () => `LaunchDarkly AI Config '${configKey}' was not found in project '${projectKey}'`,
  );
  const { mode } = raw;
  if (mode === undefined || mode === null) return 'completion';
  if (mode === 'agent' || mode === 'completion' || mode === 'judge') return mode;
  throw new EvaluationsError(
    `AI Config '${configKey}' has mode ${JSON.stringify(mode)}; expected 'agent', 'completion' or 'judge'`,
  );
}

/** The latest version of an AI Config variation, as the management API stores it. */
export async function fetchLatestVariation(
  api: LDApiClient,
  projectKey: string,
  configKey: string,
  variationKey: string,
): Promise<Record<string, unknown>> {
  const description = `AI Config variation '${configKey}'/'${variationKey}'`;
  const raw = await getOr404(
    async () =>
      requireObject(
        await api.get(
          `projects/${segment(projectKey)}/ai-configs/${segment(configKey)}/variations/${segment(variationKey)}`,
        ),
        description,
      ),
    () => `LaunchDarkly ${description} was not found in project '${projectKey}'`,
  );
  // The endpoint returns every version of the variation; evaluate the latest.
  const versions = (Array.isArray(raw.items) ? raw.items : []).filter(
    (item): item is Record<string, unknown> => isPlainObject(item) && Number.isInteger(item.version),
  );
  if (!versions.length) throw new EvaluationsError(`LaunchDarkly ${description} has no versions`);
  return versions.reduce((latest, item) => ((item.version as number) > (latest.version as number) ? item : latest));
}

/** The model config a variation links, or `undefined` when it links none. */
export async function fetchLinkedModelConfig(
  api: LDApiClient,
  projectKey: string,
  configKey: string,
  variationKey: string,
  variation: Record<string, unknown>,
): Promise<Record<string, unknown> | undefined> {
  const { modelConfigKey, modelConfigVersion } = variation;
  // Absent or empty means no model config is linked.
  if (modelConfigKey === undefined || modelConfigKey === null || modelConfigKey === '') return undefined;
  if (typeof modelConfigKey !== 'string') {
    throw new EvaluationsError(
      `LaunchDarkly AI Config variation '${configKey}'/'${variationKey}' has a non-string modelConfigKey: ` +
        JSON.stringify(modelConfigKey),
    );
  }
  // A pinned variation names the model config version it was built against.
  const params = Number.isInteger(modelConfigVersion) ? { version: modelConfigVersion as number } : undefined;
  return getOr404(
    async () =>
      requireObject(
        await api.get(`projects/${segment(projectKey)}/ai-configs/model-configs/${segment(modelConfigKey)}`, params),
        `model config '${modelConfigKey}'`,
      ),
    () => `LaunchDarkly model config '${modelConfigKey}' was not found in project '${projectKey}'`,
  );
}

const nonEmptyString = (value: unknown): value is string => typeof value === 'string' && value !== '';

/**
 * Convert a variation (and the model config it links) into generation
 * settings. The AI Config's mode decides which prompt field to read: the
 * mode's field wins when it is set, and the other field is kept only when the
 * mode's field is empty, so the prompt check can name the variation's mistake
 * instead of the run generating without its prompt.
 */
export function variationGeneration(
  variation: Record<string, unknown>,
  modelConfig: Record<string, unknown> | undefined,
  mode: 'agent' | 'messages',
): VariationGeneration {
  const model = isPlainObject(variation.model) ? variation.model : {};
  const generation: VariationGeneration = {};
  let parameters: Record<string, unknown> = isPlainObject(model.parameters) ? { ...model.parameters } : {};
  let modelName = model.modelName;
  if (modelConfig) {
    if (nonEmptyString(modelConfig.provider)) generation.provider = modelConfig.provider;
    if (isPlainObject(modelConfig.params)) parameters = { ...modelConfig.params, ...parameters };
    // A linked variation's modelName is the model config key ("OpenAI.gpt-4o"),
    // not a model ID the provider accepts; the model config's id is.
    if (nonEmptyString(modelConfig.id)) modelName = modelConfig.id;
  }
  if (nonEmptyString(modelName)) generation.model = modelName;
  if (Object.keys(parameters).length) generation.parameters = parameters;

  const instructions = nonEmptyString(variation.instructions) ? variation.instructions : undefined;
  const messages =
    Array.isArray(variation.messages) && variation.messages.length
      ? (variation.messages.filter(isPlainObject).map((message) => ({ ...message })) as ConfigMessage[])
      : undefined;
  if (mode === 'agent') {
    if (instructions) generation.instructions = instructions;
    else if (messages) generation.messages = messages;
  } else if (messages) {
    generation.messages = messages;
  } else if (instructions) {
    generation.instructions = instructions;
  }
  if (isPlainObject(variation.promptSnippets)) {
    const snippets = Object.fromEntries(
      Object.entries(variation.promptSnippets).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    );
    if (Object.keys(snippets).length) generation.promptSnippets = snippets;
  }
  if (isPlainObject(variation.outputFormat)) generation.outputFormat = { ...variation.outputFormat };
  return generation;
}

/** The `{ key: version }` tools a variation lists. */
export function variationToolVersions(variation: Record<string, unknown>): Map<string, number> {
  const versions = new Map<string, number>();
  for (const tool of Array.isArray(variation.tools) ? variation.tools : []) {
    if (isPlainObject(tool) && typeof tool.key === 'string' && Number.isInteger(tool.version)) {
      versions.set(tool.key, tool.version as number);
    }
  }
  return versions;
}

/** The judge keys a variation lists. */
export function variationJudgeKeys(variation: Record<string, unknown>): string[] {
  const judges = isPlainObject(variation.judgeConfiguration) ? variation.judgeConfiguration.judges : undefined;
  return (Array.isArray(judges) ? judges : [])
    .filter((judge) => isPlainObject(judge) && typeof judge.judgeConfigKey === 'string')
    .map((judge) => (judge as { judgeConfigKey: string }).judgeConfigKey);
}

export async function fetchDataset(api: LDApiClient, projectKey: string, datasetKey: string): Promise<DatasetRef> {
  const raw = await getOr404(
    async () =>
      requireObject(
        await api.get(`projects/${segment(projectKey)}/datasets/${segment(datasetKey)}`),
        `dataset '${datasetKey}'`,
      ),
    () => `LaunchDarkly dataset '${datasetKey}' was not found in project '${projectKey}'`,
  );
  const id = requireString(raw, 'id', 'dataset');
  const key = typeof raw.key === 'string' ? raw.key : typeof raw.name === 'string' ? raw.name : datasetKey;
  return { id, key };
}

export async function fetchDatasetRows(
  api: LDApiClient,
  projectKey: string,
  datasetKey: string,
): Promise<DatasetRow[]> {
  const path = `projects/${segment(projectKey)}/datasets/${segment(datasetKey)}/rows`;
  const rows: DatasetRow[] = [];
  let total: number | undefined;
  while (total === undefined || rows.length < total) {
    const page = requireObject(
      await api.get(path, { mode: 'all', limit: DATASET_PAGE_SIZE, offset: rows.length }),
      `rows for dataset '${datasetKey}'`,
    );
    const { items, totalCount } = page;
    if (!Array.isArray(items) || !Number.isInteger(totalCount)) {
      throw new EvaluationsError(`LaunchDarkly returned invalid rows for dataset '${datasetKey}'`);
    }
    total = totalCount as number;
    if (!items.length) break;
    for (const value of items) {
      const item = requireObject(value, 'dataset row');
      if (!Number.isInteger(item.rowIndex)) throw new EvaluationsError('A dataset row is missing its integer rowIndex');
      rows.push(
        renderRow(item.rowIndex as number, {
          input: item.input,
          expectedOutput: item.expectedOutput,
          variables: item.variables,
          metadata: item.metadata,
        }),
      );
    }
  }
  if (!rows.length) throw new EvaluationsError(`Dataset '${datasetKey}' is empty`);
  if (rows.length !== total)
    throw new EvaluationsError(`Dataset '${datasetKey}' returned ${rows.length} of ${total} rows`);
  return rows;
}

export async function createEvaluation(
  api: LDApiClient,
  projectKey: string,
  key: string,
  generation: ResolvedGeneration,
  tools: readonly EvalTool[],
  criteria: readonly Criterion[] = [],
): Promise<EvaluationRef> {
  // The mode selects the handler and validates the prompt only; it is not sent.
  const body: Record<string, unknown> = {
    name: key,
    generationProvider: generation.provider,
    generationModel: generation.model,
  };
  if (generation.parameters !== undefined) body.parameters = generation.parameters;
  if (generation.instructions !== undefined) {
    body.messages = [{ role: 'system', content: generation.instructions }];
  } else {
    body.messages = generation.messages ?? [];
  }
  if (generation.promptSnippets !== undefined) body.promptSnippets = generation.promptSnippets;
  if (tools.length) body.tools = createBodyTools(tools);
  // Pinned on the evaluation: ingest drops a result for a criterion not configured there.
  if (criteria.length) body.criteria = criteria.map(criterionWire);

  const raw = requireObject(await api.post(`projects/${segment(projectKey)}/evaluations`, body), 'evaluation');
  const id = requireString(raw, 'id', 'evaluation');
  // The only source for evaluationVersion on every event, so it is required.
  if (!Number.isInteger(raw.version)) {
    throw new EvaluationsError("LaunchDarkly evaluation response is missing integer field 'version'");
  }
  const responseKey = typeof raw.name === 'string' ? raw.name : typeof raw.label === 'string' ? raw.label : key;
  return { id, key: responseKey, version: raw.version as number };
}

export async function createEvaluationRun(
  api: LDApiClient,
  projectKey: string,
  evaluationId: string,
  datasetId: string | undefined,
): Promise<EvaluationRunRef> {
  // No row count: what completes a row is derived server-side.
  const body: Record<string, unknown> = { source: 'api' };
  if (datasetId !== undefined) body.datasetId = datasetId;
  const raw = requireObject(
    await api.post(`projects/${segment(projectKey)}/evaluations/${segment(evaluationId)}/runs`, body),
    'evaluation run',
  );
  return {
    id: requireString(raw, 'id', 'evaluation run'),
    evaluationId: requireString(raw, 'evaluationId', 'evaluation run'),
    state: requireString(raw, 'state', 'evaluation run'),
  };
}

const runPath = (projectKey: string, evaluationId: string, runId: string) =>
  `projects/${segment(projectKey)}/evaluations/${segment(evaluationId)}/runs/${segment(runId)}`;

/**
 * Upload an inline dataset's raw rows to its run, in batches, one at a time.
 * Uploads are idempotent per `rowIdx`, so each batch is retried like a GET.
 */
export async function uploadDatasetRows(
  api: LDApiClient,
  projectKey: string,
  evaluationId: string,
  runId: string,
  rows: readonly InlineRow[],
): Promise<void> {
  const path = `${runPath(projectKey, evaluationId, runId)}/dataset-rows`;
  for (let start = 0; start < rows.length; start += DATASET_UPLOAD_BATCH_SIZE) {
    const batch = rows.slice(start, start + DATASET_UPLOAD_BATCH_SIZE);
    try {
      await api.post(path, { rows: batch }, { idempotent: true });
    } catch (err) {
      throw new EvaluationsError(
        `Failed to upload inline dataset rows ${start}-${start + batch.length - 1} of ${rows.length} ` +
          `to evaluation run ${runId}: ${errorMessage(err)}`,
        { cause: err },
      );
    }
  }
}

/** Cancel a run. Retried like a GET: repeating a cancel cannot change its outcome. */
export async function cancelEvaluationRun(
  api: LDApiClient,
  projectKey: string,
  evaluationId: string,
  runId: string,
): Promise<void> {
  await api.post(`${runPath(projectKey, evaluationId, runId)}/cancel`, undefined, { idempotent: true });
}

/** One inline row in the upload wire shape, with every key present. */
export type InlineRow = {
  rowIdx: number;
  input: string;
  expectedOutput: string | null;
  variables: Record<string, unknown>;
  metadata: Record<string, unknown> | null;
};

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

function count(counts: Record<string, unknown>, ...keys: string[]): number {
  for (const key of keys) {
    const value = Number(counts[key]);
    if (counts[key] !== undefined && counts[key] !== null && Number.isFinite(value)) return Math.trunc(value);
  }
  return 0;
}

/** Parse row counts. The summary endpoint returns no run state, so terminality comes from the counts alone. */
export function parseSummary(data: unknown): RunSummary {
  const raw = isPlainObject(data) ? data : {};
  const counts = isPlainObject(raw.statusCounts) ? raw.statusCounts : raw;
  return {
    totalRows: count(counts, 'total', 'totalRows', 'total_rows'),
    passedRows: count(counts, 'passed', 'passedRows', 'passed_rows'),
    failedRows: count(counts, 'failed', 'failedRows', 'failed_rows'),
    errorRows: count(counts, 'error', 'errorRows', 'error_rows'),
    pendingRows: count(counts, 'pending', 'pendingRows', 'pending_rows'),
  };
}

export const accountedRows = (summary: RunSummary): number =>
  summary.passedRows + summary.failedRows + summary.errorRows;

export const isTerminalSummary = (summary: RunSummary): boolean =>
  summary.totalRows > 0 && summary.pendingRows === 0 && accountedRows(summary) === summary.totalRows;

export async function fetchSummary(
  api: LDApiClient,
  projectKey: string,
  evaluationId: string,
  runId: string,
): Promise<RunSummary> {
  return parseSummary(await api.get(`${runPath(projectKey, evaluationId, runId)}/summary`));
}

/** The error for a run whose rows were not all accounted for by the deadline. */
export function summaryTimeoutError(
  runId: string,
  timeoutSeconds: number,
  summary: RunSummary,
  criteriaCount: number,
): EvaluationsError {
  const accounted = accountedRows(summary);
  const counts = `total_rows=${summary.totalRows}, accounted_rows=${accounted}, pending_rows=${summary.pendingRows}`;
  // A timeout is almost never the backend being slow: it is rows LaunchDarkly
  // never heard a complete result for.
  const cause =
    accounted === 0
      ? 'No rows were accounted for, so LaunchDarkly received no results from this run. Check that events ' +
        'can reach LaunchDarkly, and that the SDK key and API token belong to the same project.'
      : 'Some rows were not accounted for. Their events were most likely not delivered to LaunchDarkly.';
  const criteria =
    criteriaCount > 0 ? ` The run has ${criteriaCount} criteria; a row counts once all of its results arrive.` : '';
  return new EvaluationsError(
    `Timed out after ${timeoutSeconds} seconds waiting for evaluation run ${runId} to account for every row ` +
      `(${counts}). ${cause}${criteria}`,
  );
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

/** The config every row's handler receives. Snippets are resolved now; row placeholders are left for the handler. */
export function buildHandlerConfig(generation: ResolvedGeneration, tools: readonly EvalTool[]): AiConfigRep {
  const config: Record<string, unknown> = {
    provider: { name: generation.provider },
    model: { name: generation.model, parameters: generation.parameters ?? null },
    tools: handlerConfigTools(tools),
  };
  const snippets = { snippet: generation.promptSnippets ?? {} };
  if (generation.instructions !== undefined) {
    config.instructions = parseTemplate(generation.instructions, snippets);
  } else if (generation.messages !== undefined) {
    config.messages = generation.messages.map((message) => ({
      ...message,
      content: typeof message.content === 'string' ? parseTemplate(message.content, snippets) : message.content,
    }));
  }
  if (generation.outputFormat !== undefined) config.outputFormat = generation.outputFormat;
  return config as AiConfigRep;
}

/** Run `fn` over `items` with at most `limit` in flight, keeping input order in the results. */
export async function mapBounded<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Generate every row once with `handler`. A handler error becomes an `ERROR`
 * row instead of failing the run, and a handler is never retried: a retry
 * could repeat tool side effects.
 *
 * With `evaluationRunId`, each row opens its trace root before the handler
 * runs, and the handler runs under it with the row bound. The caller ends each
 * row's `span` after the row's criteria.
 */
export function generateRows(
  rows: readonly DatasetRow[],
  handler: ProviderHandler,
  config: AiConfigRep,
  tools: Record<string, ToolHandlerFn | NativeTool>,
  concurrency: number,
  evaluationRunId?: string,
): Promise<RowResult[]> {
  return mapBounded(rows, concurrency, async (row) => {
    // One recorder per row: rows share the tool map, so a shared recorder
    // would splice their calls together.
    const trajectory = new TrajectoryRecorder();
    const rowTools = trajectory.wrap(tools);
    const span = evaluationRunId === undefined ? undefined : startRowSpan(evaluationRunId, row.rowIndex);
    const startedAt = new Date().toISOString();
    const started = performance.now();
    const finish = () => ({
      startedAt,
      generatedAt: new Date().toISOString(),
      latencyMs: Math.round(performance.now() - started),
    });
    const invoke = () => handler(config, row.input ?? undefined, rowTools, { ...row.variables });
    try {
      const result: unknown =
        evaluationRunId === undefined || span === undefined
          ? await invoke()
          : await withEvaluationRow(evaluationRunId, row.rowIndex, () =>
              withActiveSpan(span, () =>
                traceHandlerCall(invoke, (outcome) => {
                  const capture = captureFor(handler);
                  recordChat(span, {
                    ...outcome,
                    config,
                    userInput: row.input,
                    variables: row.variables,
                    toolCalls: trajectory.calls,
                    capture,
                  });
                  recordToolCalls(span, trajectory.calls, capture);
                }),
              ),
            );
      if (!isPlainObject(result)) throw new TypeError('handler result must be an object');
      const done: RowResult = { row, status: 'COMPLETE', output: result.output, ...finish(), trajectory };
      if (isPlainObject(result.usage)) done.usage = { ...result.usage };
      if (span) {
        finishRowSpan(span);
        done.span = span;
      }
      return done;
    } catch (err) {
      const failed: RowResult = {
        row,
        status: 'ERROR',
        error: { code: HANDLER_ERROR_CODE, message: `handler raised: ${errorMessage(err)}` },
        ...finish(),
        trajectory,
      };
      if (span) {
        finishRowSpan(span, err);
        failed.span = span;
      }
      return failed;
    }
  });
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/**
 * RFC 8785 canonical JSON (JCS): `JSON.stringify`'s spelling of strings and
 * numbers, no whitespace, and object keys sorted by UTF-16 code unit at every
 * level, which is what `sort()` compares. The form `eventId` and `contentHash`
 * hash, and the one every SDK can produce.
 */
export function canonicalJson(value: unknown): string {
  // A value JSON cannot hold is handled as JSON.stringify handles it, so the
  // hash covers the same JSON the tracked event carries: `null` in an array,
  // and no key in an object. Python, which has no undefined, writes None as null.
  if (Array.isArray(value)) {
    return `[${value.map((item) => (omittedByJson(item) ? 'null' : canonicalJson(item))).join(',')}]`;
  }
  if (isPlainObject(value)) {
    const entries = Object.keys(value)
      .sort()
      .filter((key) => !omittedByJson(value[key]))
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Values JSON.stringify writes as `null` in an array and drops from an object. */
const omittedByJson = (value: unknown): boolean =>
  value === undefined || typeof value === 'function' || typeof value === 'symbol';

export const eventIdFor = (identity: Record<string, unknown>): string =>
  createHash('sha256').update(canonicalJson(identity)).digest('hex');

/**
 * Tracks events and flushes whenever `bound` have been tracked since the last
 * flush, so the SDK's event buffer never overflows (overflow is silent).
 *
 * With `log`, each queued event is reported with its `emittedAt` and
 * `eventId`, so the time the SDK emitted an event can be compared with the
 * time LaunchDarkly received it.
 */
export class EventSink {
  private sinceFlush = 0;

  constructor(
    private readonly client: LDClientInterface,
    private readonly bound: number,
    private readonly log?: (line: string) => void,
  ) {}

  async track(name: string, context: Record<string, unknown>, payload: Record<string, unknown>): Promise<void> {
    this.client.track(name, context as never, payload, 1);
    this.log?.(`${name} emittedAt=${payload.emittedAt} eventId=${payload.eventId}`);
    this.sinceFlush++;
    if (this.sinceFlush >= this.bound) await this.flush();
  }

  async flush(): Promise<void> {
    this.sinceFlush = 0;
    await this.client.flush();
  }
}

export type RunIdentity = {
  projectKey: string;
  evaluation: EvaluationRef;
  run: EvaluationRunRef;
  dataset: DatasetRef;
};

/** The event context, identical for every event in a run. */
export const eventContext = ({ projectKey, evaluation, run }: RunIdentity): Record<string, unknown> => ({
  kind: 'evaluation',
  key: run.id,
  projectKey,
  evaluationId: evaluation.id,
});

/** The identity fields every event carries. An inline run has no dataset id, so it is omitted. */
export function rowIdentity({ projectKey, evaluation, run, dataset }: RunIdentity, rowIndex: number) {
  const identity: Record<string, unknown> = {
    projectKey,
    evaluationId: evaluation.id,
    evaluationRunId: run.id,
    runId: run.id,
    datasetId: dataset.id,
    rowIndex,
  };
  if (dataset.id === undefined) delete identity.datasetId;
  return identity;
}

/**
 * The generation event for one row. Dataset-owned fields (input, expected
 * output, variables, metadata) and the trajectory are never included.
 */
export function generationPayload(ids: RunIdentity, result: RowResult): Record<string, unknown> {
  const identity = rowIdentity(ids, result.row.rowIndex);
  const generated = generatedContent(result);
  const payload: Record<string, unknown> = {
    ...identity,
    eventId: eventIdFor(identity),
    contentHash: contentHashFor(generated),
    emittedAt: new Date().toISOString(),
    evaluationKey: ids.evaluation.key,
    evaluationVersion: ids.evaluation.version,
    status: result.status,
    startedAt: result.startedAt,
    generatedAt: result.generatedAt,
    latencyMs: result.latencyMs,
  };
  if (ids.dataset.key !== undefined) payload.datasetKey = ids.dataset.key;
  if (generated.output !== null) payload.output = generated.output;
  if (generated.error !== null) payload.error = generated.error;
  if (generated.errorMessage !== undefined) payload.errorMessage = generated.errorMessage;
  if (generated.usage !== undefined) payload.usage = generated.usage;
  return payload;
}

/** What a row generated: the fields `contentHash` covers, as the event carries them. */
type GeneratedContent = {
  status: RowResult['status'];
  output: unknown;
  error: RowResult['error'] | null;
  errorMessage?: string;
  usage?: { inputTokens: number; outputTokens: number };
};

function generatedContent(result: RowResult): GeneratedContent {
  // `output` and `error` are always present, as null when absent: the hash
  // covers them that way in every language.
  const generated: GeneratedContent = {
    status: result.status,
    output: result.output ?? null,
    error: result.error ?? null,
  };
  if (result.status === 'ERROR') generated.errorMessage = result.error?.message || 'Unknown error';
  if (result.usage) {
    const usage = parseUsage(result.usage);
    generated.usage = { inputTokens: usage.input, outputTokens: usage.output };
  }
  return generated;
}

/**
 * SHA-256 of the UTF-8 canonical JSON ({@link canonicalJson}) of what a row
 * generated. Every SDK hashes the same form, so the same content hashes the
 * same whichever language generated it.
 */
export function contentHashFor(generated: GeneratedContent): string {
  return createHash('sha256').update(canonicalJson(generated)).digest('hex');
}
