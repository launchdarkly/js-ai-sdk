/**
 * Evaluations from Code — the criteria each generated output is scored against.
 *
 * A criterion validates its own fields where it is constructed, so an invalid
 * one cannot reach `run()`. The SDK never computes a verdict: it reports a
 * score, and LaunchDarkly rules on it against the threshold pinned here.
 */

import type { DatasetRow } from './evaluations.js';
import { EvaluationsError } from './evaluations-api.js';

/** A judge's row threshold when its reference sets none. */
const DEFAULT_JUDGE_THRESHOLD = 0.5;

/** A scorer's row threshold when its reference sets none: a row passes only on a perfect score. */
const DEFAULT_SCORER_THRESHOLD = 1.0;

/** Which way a scorer's score points. */
export type SuccessDirection = 'higher_is_better' | 'lower_is_better';

const SUCCESS_DIRECTIONS: readonly SuccessDirection[] = ['higher_is_better', 'lower_is_better'];

/**
 * A local scorer function. Receives the row an output was generated from and
 * the output, and returns a score from 0 to 1, or a promise of one.
 */
export type ScorerFn = (row: DatasetRow, output: unknown) => number | Promise<number>;

/**
 * A threshold must be a finite number from 0 to 1. A range check alone lets
 * `NaN` through, since it compares false both ways, and `Infinity` is not a
 * score any row can be ruled against.
 */
function validateThreshold(name: string, value: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new EvaluationsError(`${name} must be a finite number from 0 to 1, got ${String(value)}`);
  }
  return value;
}

/**
 * Reference to a LaunchDarkly AI Judge config to run for each eval row.
 *
 * The SDK does not create or provide built-in judges. Pass the key of a judge
 * that exists in LaunchDarkly. Resolution uses LaunchDarkly flag delivery for
 * the currently served variation, once per run.
 *
 * A judge's success direction is not set here. It lives on the judge's AI
 * Config as `isInverted` and is injected onto the criterion by LaunchDarkly
 * when the evaluation is created, so the one input a verdict is ruled on stays
 * server-attested even though the score beside it is client-reported.
 */
export class Judge {
  /** Key of the judge's AI Config in LaunchDarkly. */
  readonly key: string;
  /** Score from 0 to 1 a row must reach to pass. Defaults to `0.5`. */
  readonly threshold: number;
  /** Fraction of rows, from 0 to 1, that must pass for the criterion to pass. Unset by default. */
  readonly passRateThreshold?: number;
  /**
   * Reference material the judge scores the output against, available to the
   * rubric as `{{ground_truth_context}}`. Rendered against each row's
   * variables. When unset, the row's expected output is used.
   */
  readonly groundTruthContext?: string;

  /**
   * Reference a judge. Throws {@link EvaluationsError} on a blank key or a
   * threshold that is not a finite number from 0 to 1.
   *
   * @param key - Key of a judge AI Config that exists in LaunchDarkly.
   * @param options - Thresholds and ground truth for this judge.
   */
  constructor(
    key: string,
    options: { threshold?: number; passRateThreshold?: number; groundTruthContext?: string } = {},
  ) {
    if (typeof key !== 'string' || !key.trim()) throw new EvaluationsError('judge key must not be blank');
    if (options.groundTruthContext !== undefined && typeof options.groundTruthContext !== 'string') {
      throw new EvaluationsError(`judge '${key}' groundTruthContext must be a string`);
    }
    this.key = key;
    this.threshold = validateThreshold('threshold', options.threshold ?? DEFAULT_JUDGE_THRESHOLD);
    if (options.passRateThreshold !== undefined) {
      this.passRateThreshold = validateThreshold('passRateThreshold', options.passRateThreshold);
    }
    this.groundTruthContext = options.groundTruthContext;
    Object.freeze(this);
  }
}

/**
 * Local deterministic scorer run for each generated evaluation row.
 *
 * `fn` may be sync or async and receives `(row, output)`, where `row` is the
 * {@link DatasetRow} the output was generated from and `output` is the
 * generated output. It must return a finite number from 0 to 1. Nothing is
 * coerced: a yes/no scorer returns `1` or `0` itself, and a boolean, a
 * non-finite number or an out-of-range number is recorded as an invalid score.
 *
 * `threshold` defaults to 1.0: a row passes only on a perfect score, which
 * matches the common case of yes/no scorers. Pass a lower threshold for
 * graded numeric scorers.
 *
 * `successDirection` says which way the score points, and defaults to
 * higher-is-better. Unlike a judge, a scorer has no LaunchDarkly-side config
 * to read a direction from, so the declaration here is the only source —
 * LaunchDarkly derives each row's verdict by comparing score to threshold in
 * this direction. Set `'lower_is_better'` for a scorer that counts something
 * unwanted, e.g. a regex hit count or an edit distance.
 */
export class Scorer {
  /** Scorer name. Identifies the criterion on the run. */
  readonly name: string;
  /** The scoring function, called with `(row, output)`. */
  readonly fn: ScorerFn;
  /** Score from 0 to 1 a row must reach to pass. Defaults to `1.0`. */
  readonly threshold: number;
  /** Fraction of rows, from 0 to 1, that must pass for the criterion to pass. Unset by default. */
  readonly passRateThreshold?: number;
  /** Which way the score points. Defaults to `'higher_is_better'`. */
  readonly successDirection: SuccessDirection;

  /**
   * Define a local scorer. Throws {@link EvaluationsError} on a blank name, a
   * `fn` that is not callable, a threshold that is not a finite number from 0
   * to 1, or an unknown success direction.
   *
   * @param name - Scorer name. Identifies the criterion on the run.
   * @param fn - The scoring function, called with `(row, output)`.
   * @param options - Thresholds and success direction for this scorer.
   */
  constructor(
    name: string,
    fn: ScorerFn,
    options: { threshold?: number; passRateThreshold?: number; successDirection?: SuccessDirection } = {},
  ) {
    if (typeof name !== 'string' || !name.trim()) throw new EvaluationsError('scorer name must not be blank');
    if (typeof fn !== 'function') throw new EvaluationsError(`scorer '${name}' fn must be callable`);
    const successDirection = options.successDirection ?? 'higher_is_better';
    if (!SUCCESS_DIRECTIONS.includes(successDirection)) {
      throw new EvaluationsError(
        `scorer '${name}' successDirection must be 'higher_is_better' or 'lower_is_better', got ${JSON.stringify(successDirection)}`,
      );
    }
    this.name = name;
    this.fn = fn;
    this.threshold = validateThreshold('threshold', options.threshold ?? DEFAULT_SCORER_THRESHOLD);
    if (options.passRateThreshold !== undefined) {
      this.passRateThreshold = validateThreshold('passRateThreshold', options.passRateThreshold);
    }
    this.successDirection = successDirection;
    Object.freeze(this);
  }
}

/** One entry in a run's `criteria`: a LaunchDarkly judge or a local scorer. */
export type Criterion = Judge | Scorer;

/** A criterion's identity: the judge key or the scorer name. Part of every criterion event's identity. */
export const criterionType = (criterion: Criterion): string =>
  criterion instanceof Judge ? criterion.key : criterion.name;

/**
 * The entry a criterion pins on the evaluation create body. The row threshold
 * is always sent; the pass-rate threshold only when set. A judge carries no
 * success direction: LaunchDarkly hydrates it from the judge's own config.
 */
export function criterionWire(criterion: Criterion): Record<string, unknown> {
  const options: Record<string, unknown> = { threshold: criterion.threshold };
  if (criterion.passRateThreshold !== undefined) options.passRateThreshold = criterion.passRateThreshold;
  if (criterion instanceof Judge) {
    if (criterion.groundTruthContext !== undefined) options.groundTruthContext = criterion.groundTruthContext;
    return { criterionType: criterion.key, kind: 'judge', judgeKey: criterion.key, options };
  }
  return { criterionType: criterion.name, kind: 'scorer', successDirection: criterion.successDirection, options };
}

/**
 * Validate a run's criteria. Identities are compared without case, matching
 * the API, which lowercases `criterionType` when it deduplicates.
 */
export function validateCriteria(criteria: unknown): asserts criteria is readonly Criterion[] {
  if (!Array.isArray(criteria)) throw new EvaluationsError('criteria must be an array of Judge and Scorer');
  const seen = new Map<string, string>();
  const duplicates: string[] = [];
  for (const criterion of criteria) {
    if (!(criterion instanceof Judge) && !(criterion instanceof Scorer)) {
      throw new EvaluationsError('each entry in criteria must be a Judge or a Scorer');
    }
    const identity = criterionType(criterion);
    const folded = identity.toLowerCase();
    if (seen.has(folded) && !duplicates.includes(identity)) duplicates.push(identity);
    seen.set(folded, identity);
  }
  if (duplicates.length) {
    throw new EvaluationsError(
      `Duplicate evaluation criteria: ${duplicates.map((d) => `'${d}'`).join(', ')}. Judge keys and scorer names ` +
        'must be unique within a run, compared without case.',
    );
  }
}
