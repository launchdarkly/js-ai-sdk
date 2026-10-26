/**
 * Evaluations from Code — the evaluation phase: scoring each generated row
 * against the run's criteria.
 *
 * A criterion is a LaunchDarkly AI Judge, resolved through flag delivery and
 * invoked as a model call, or a local scorer function. Every failure here is a
 * per-criterion `ERROR` result rather than a thrown error, because the row's
 * generation has already been paid for. The SDK never computes a verdict.
 *
 * Internal: nothing here is exported from an entry point.
 */

import { toolResultString } from './content.js';
import type { DatasetRow } from './evaluations.js';
import { EvaluationsError, errorMessage, isPlainObject } from './evaluations-api.js';
import { type Criterion, criterionType, Judge, type Scorer } from './evaluations-criteria.js';
import { eventIdFor, mapBounded, type RowResult, type RunIdentity, rowIdentity } from './evaluations-runner.js';
import {
  buildMessageHistory,
  FORMATTING_INSTRUCTIONS,
  numericScore,
  parseJudgeResponse,
  withoutOutputFormat,
} from './judge-scoring.js';
import { extractVariation } from './lifecycle.js';
import { findHandler } from './registry.js';
import { renderTrajectory } from './trajectory.js';
import type { AiConfigRep, LDContext, ProviderHandler } from './types.js';
import { normalizeMode, parseTemplate, parseUsage } from './utils.js';

export const CRITERION_EVENT_NAME = '$ld:ai:offline-evals:criterion';

/** A judge resolved once for the run, with the handler that runs it. */
export type ResolvedJudge = {
  judge: Judge;
  /** The served config, without tools: a judge cannot use them. */
  config: AiConfigRep;
  handler: ProviderHandler;
  variationKey: string;
  version: number | undefined;
};

/** The failure taxonomy of a criterion result. Not a wire value: ingest reads only `errorMessage`. */
export type CriterionErrorCause = 'invalid_judge_output' | 'invalid_score' | 'handler_raised' | 'scorer_raised';

export type CriterionResult = {
  rowIndex: number;
  criterion: Criterion;
  status: 'COMPLETE' | 'ERROR';
  score?: number;
  reason?: string;
  error?: { cause: CriterionErrorCause; message: string };
  usage?: Record<string, unknown>;
  startedAt: string;
  evaluatedAt: string;
  latencyMs: number;
  /** Set for a judge. */
  judge?: ResolvedJudge;
};

const formatProvidesFor = (handlers: readonly ProviderHandler[]): string =>
  handlers.map((h) => `[${h.providesFor?.[0]}, ${h.providesFor?.[1]}]`).join(', ');

/**
 * Resolve every judge once, through flag delivery, and pair it with the
 * handler that runs it. Resolution is per run, not per row: an edit in the UI
 * mid-run must not score rows of one run against different rubrics.
 *
 * A judge that cannot be resolved fails the run. So do judges that no handler
 * covers or whose prompt does not match their handler's mode, all reported in
 * one error. Nothing has been created and no model call paid for yet, so
 * failing beats a run that silently lacks a criterion.
 */
export async function resolveJudges(
  projectKey: string,
  judges: readonly Judge[],
  pool: readonly ProviderHandler[],
): Promise<Map<string, ResolvedJudge>> {
  // The real SDK rejects a context without a kind and a key.
  const context = { kind: 'evaluation', key: projectKey } as LDContext;
  const resolved = new Map<string, ResolvedJudge>();
  const problems: string[] = [];
  for (const judge of judges) {
    let served: { config: unknown; meta: unknown };
    try {
      served = await extractVariation(judge.key, context);
    } catch (err) {
      throw new EvaluationsError(
        `Failed to resolve LaunchDarkly judge '${judge.key}': ${errorMessage(err)}. If the judge does not exist ` +
          `in project '${projectKey}', create it in LaunchDarkly and try again.`,
        { cause: err },
      );
    }
    if (!isPlainObject(served?.config)) {
      throw new EvaluationsError(`LaunchDarkly judge '${judge.key}' returned an invalid AI config variation`);
    }
    // Neither the judge's tools nor its outputFormat reach the handler. Resolution is per run, so the
    // outputFormat warning fires once per judge per run, not once per row.
    const { tools: _tools, ...withoutTools } = served.config as AiConfigRep;
    const config = withoutOutputFormat(withoutTools, judge.key);
    const meta = isPlainObject(served.meta) ? served.meta : {};
    const provider = isPlainObject(config.provider) ? config.provider.name : undefined;
    const mode = normalizeMode(typeof meta.mode === 'string' ? meta.mode : undefined);
    const handler = typeof provider === 'string' ? findHandler(pool, provider, mode) : undefined;
    if (!handler) {
      problems.push(`judge '${judge.key}' (provider '${String(provider)}', mode '${mode}') has no handler`);
      continue;
    }
    // The harness never converts one prompt field into the other.
    if (mode === 'messages' && config.instructions) {
      problems.push(`judge '${judge.key}' needs messages, not instructions, because its handler is a messages handler`);
      continue;
    }
    if (mode === 'agent' && config.messages?.length) {
      problems.push(`judge '${judge.key}' needs instructions, not messages, because its handler is an agent handler`);
      continue;
    }
    resolved.set(judge.key, {
      judge,
      config: config as AiConfigRep,
      handler,
      variationKey: typeof meta.variationKey === 'string' ? meta.variationKey : '',
      version: Number.isInteger(meta.version) ? (meta.version as number) : undefined,
    });
  }
  if (problems.length) {
    throw new EvaluationsError(
      `These judges cannot run: ${problems.join('; ')}. The pool provides for: ${formatProvidesFor(pool)}.`,
    );
  }
  return resolved;
}

/** A criterion score: a finite number, by the shared rule, and in 0–1, which ingest enforces. */
function unitScore(value: unknown): number | undefined {
  const score = numericScore(value);
  return score !== undefined && score >= 0 && score <= 1 ? score : undefined;
}

/**
 * The variables a judge's rubric renders against: the row's variables plus a
 * closed set of keys. Absent values are empty strings, never null, because
 * `parseTemplate` leaves a placeholder whose value is null in the prompt.
 */
export function judgeVariables(result: RowResult, judge: Judge): Record<string, unknown> {
  const { row } = result;
  const groundTruth =
    judge.groundTruthContext !== undefined
      ? parseTemplate(judge.groundTruthContext, row.variables)
      : (row.expectedOutput ?? '');
  return {
    ...row.variables,
    input: row.input ?? '',
    response_to_evaluate: toolResultString(result.output),
    expected_output: row.expectedOutput ?? '',
    ground_truth_context: groundTruth,
    message_history: buildMessageHistory({
      userInput: row.input ?? undefined,
      trajectory: renderTrajectory(result.trajectory),
      output: result.output,
    }),
    formatting_instructions: FORMATTING_INSTRUCTIONS,
  };
}

/**
 * A value in an error message, as JSON rather than a language repr, so it reads
 * the same in every SDK. Absent is `null`, a non-finite number is `NaN` /
 * `Infinity`, and a value JSON cannot hold is its `String()`.
 */
function describeValue(value: unknown): string {
  if (typeof value === 'number' && !Number.isFinite(value)) return String(value);
  try {
    return JSON.stringify(value ?? null) ?? String(value);
  } catch {
    return String(value);
  }
}

/** A clock for one criterion result. `evaluatedAt` never precedes `startedAt`, which ingest would reject. */
function startClock() {
  const startedMs = Date.now();
  const started = performance.now();
  return {
    startedAt: new Date(startedMs).toISOString(),
    stop: () => ({
      evaluatedAt: new Date(Math.max(Date.now(), startedMs)).toISOString(),
      latencyMs: Math.round(performance.now() - started),
    }),
  };
}

async function runJudge(result: RowResult, resolved: ResolvedJudge): Promise<CriterionResult> {
  const clock = startClock();
  const base = {
    rowIndex: result.row.rowIndex,
    criterion: resolved.judge,
    judge: resolved,
    startedAt: clock.startedAt,
  };
  const fail = (cause: CriterionErrorCause, message: string): CriterionResult => ({
    ...base,
    status: 'ERROR',
    error: { cause, message },
    ...clock.stop(),
  });
  let response: unknown;
  try {
    // The config is passed unrendered: the handler makes the one template
    // pass, so `{{…}}` in generated output or dataset values is never expanded.
    // Judges get no tools.
    response = await resolved.handler(
      resolved.config,
      toolResultString(result.output),
      {},
      judgeVariables(result, resolved.judge),
    );
  } catch (err) {
    return fail('handler_raised', `judge handler raised: ${errorMessage(err)}`);
  }
  // The messages are the Python SDK's, so an errorMessage reads the same from either.
  if (!isPlainObject(response)) return fail('invalid_judge_output', 'judge handler result must be a mapping');
  const parsed = parseJudgeResponse(response.output);
  if (!parsed) return fail('invalid_judge_output', 'Invalid JSON from judge');
  // Ingest drops a judge result with no reason, which would stall the row.
  if (!parsed.reasoning) return fail('invalid_judge_output', 'judge output has no reasoning');
  const score = unitScore(parsed.score);
  if (score === undefined) {
    return fail('invalid_score', `judge score must be a number between 0 and 1, got ${describeValue(parsed.score)}`);
  }
  const done: CriterionResult = {
    ...base,
    status: 'COMPLETE',
    score,
    reason: parsed.reasoning,
    ...clock.stop(),
  };
  if (isPlainObject(response.usage)) done.usage = { ...response.usage };
  return done;
}

/**
 * A scorer's own copy of the generated output. An output `structuredClone`
 * cannot copy, such as one holding a function, is passed as is: failing a
 * valid scorer over the output's shape would be worse than the exposure. Handler
 * outputs are strings or parsed JSON in practice, which always copy.
 */
function copyOutput(output: unknown): unknown {
  if (typeof output !== 'object' || output === null) return output;
  try {
    return structuredClone(output);
  } catch {
    return output;
  }
}

async function runScorer(result: RowResult, scorer: Scorer): Promise<CriterionResult> {
  const clock = startClock();
  const base = { rowIndex: result.row.rowIndex, criterion: scorer, startedAt: clock.startedAt };
  let score: unknown;
  try {
    // Copies of the row and the output: criteria on one row run concurrently,
    // so a scorer that changed either would change what the others score.
    const row: DatasetRow = structuredClone(result.row);
    score = await scorer.fn(row, copyOutput(result.output));
  } catch (err) {
    return {
      ...base,
      status: 'ERROR',
      error: { cause: 'scorer_raised', message: `scorer fn raised: ${errorMessage(err)}` },
      ...clock.stop(),
    };
  }
  const valid = unitScore(score);
  if (valid === undefined) {
    // The Python SDK's two messages, without its boolean shortcut: a boolean is not a score.
    const message =
      numericScore(score) === undefined
        ? `scorer fn must return a finite number, got ${describeValue(score)}`
        : `scorer fn score must be between 0 and 1, got ${describeValue(score)}`;
    return { ...base, status: 'ERROR', error: { cause: 'invalid_score', message }, ...clock.stop() };
  }
  return { ...base, status: 'COMPLETE', score: valid, ...clock.stop() };
}

/**
 * Score every generated row against every criterion, with at most
 * `concurrency` pairs in flight across the whole phase. A row that did not
 * generate is skipped entirely: it yields no criterion result, because
 * LaunchDarkly has already counted it as failed.
 */
export function scoreRows(
  results: readonly RowResult[],
  criteria: readonly Criterion[],
  judges: ReadonlyMap<string, ResolvedJudge>,
  concurrency: number,
): Promise<CriterionResult[]> {
  const pairs = results
    .filter((result) => result.status === 'COMPLETE')
    .flatMap((result) => criteria.map((criterion) => ({ result, criterion })));
  return mapBounded(pairs, concurrency, ({ result, criterion }) => {
    if (criterion instanceof Judge) {
      const resolved = judges.get(criterion.key);
      if (!resolved) throw new EvaluationsError(`judge '${criterion.key}' was not resolved`);
      return runJudge(result, resolved);
    }
    return runScorer(result, criterion);
  });
}

/**
 * The criterion event for one result. Null fields are omitted. No verdict,
 * no output, and nothing the dataset owns. `errorCode` is omitted until its
 * integers are assigned.
 */
export function criterionPayload(ids: RunIdentity, result: CriterionResult): Record<string, unknown> {
  const identity = { ...rowIdentity(ids, result.rowIndex), criterionType: criterionType(result.criterion) };
  const kind = result.criterion instanceof Judge ? 'judge' : 'scorer';
  const payload: Record<string, unknown> = {
    ...identity,
    kind,
    eventId: eventIdFor(identity),
    emittedAt: new Date().toISOString(),
    evaluationKey: ids.evaluation.key,
    evaluationVersion: ids.evaluation.version,
    status: result.status,
    startedAt: result.startedAt,
    evaluatedAt: result.evaluatedAt,
    latencyMs: result.latencyMs,
  };
  if (ids.dataset.key !== undefined) payload.datasetKey = ids.dataset.key;
  if (result.status === 'COMPLETE') {
    payload.score = result.score;
    if (result.reason) payload.reason = result.reason;
  } else {
    payload.errorMessage = result.error?.message || 'Unknown error';
  }
  if (result.judge) {
    payload.judgeKey = result.judge.judge.key;
    payload.variationKey = result.judge.variationKey;
    if (result.judge.version !== undefined) payload.version = result.judge.version;
    if (result.usage) {
      const usage = parseUsage(result.usage);
      payload.usage = { inputTokens: usage.input, outputTokens: usage.output };
    }
  }
  return payload;
}
