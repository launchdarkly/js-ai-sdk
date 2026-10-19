/**
 * Evaluations from Code — the criteria each generated output is scored against.
 *
 * Stub: the types are in place, but nothing is validated yet.
 */

import type { DatasetRow } from './evaluations.js';

/** Which way a scorer's score points. */
export type SuccessDirection = 'higher_is_better' | 'lower_is_better';

/**
 * A local scorer function. Receives the row an output was generated from and
 * the output, and returns a boolean or a score from 0 to 1, or a promise of one.
 */
export type ScorerFn = (row: DatasetRow, output: unknown) => number | boolean | Promise<number | boolean>;

/**
 * Reference to a LaunchDarkly AI Judge config to run for each eval row.
 *
 * The SDK does not create or provide built-in judges. Pass the key of a judge
 * that exists in LaunchDarkly. Resolution uses LaunchDarkly flag delivery for
 * the currently served variation.
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
  readonly threshold?: number;
  /** Fraction of rows, from 0 to 1, that must pass for the criterion to pass. */
  readonly passRateThreshold?: number;
  /** Reference material the judge scores the output against. */
  readonly groundTruthContext?: string;

  /**
   * Reference a judge.
   *
   * @param key - Key of a judge AI Config that exists in LaunchDarkly.
   * @param options - Thresholds and ground truth for this judge.
   */
  constructor(
    key: string,
    options: { threshold?: number; passRateThreshold?: number; groundTruthContext?: string } = {},
  ) {
    this.key = key;
    this.threshold = options.threshold;
    this.passRateThreshold = options.passRateThreshold;
    this.groundTruthContext = options.groundTruthContext;
  }
}

/**
 * Local deterministic scorer run for each generated evaluation row.
 *
 * `fn` may be sync or async and receives `(row, output)`, where `row` is the
 * {@link DatasetRow} the output was generated from and `output` is the
 * generated output. It must return a boolean or a numeric score from 0 to 1.
 * Boolean results are converted to 1.0 or 0.0 before being emitted as
 * evaluation events.
 *
 * `threshold` defaults to 1.0: a row passes only on a perfect score, which
 * matches the common case of boolean scorers. Pass a lower threshold for
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
  readonly threshold?: number;
  /** Fraction of rows, from 0 to 1, that must pass for the criterion to pass. */
  readonly passRateThreshold?: number;
  /** Which way the score points. Defaults to `'higher_is_better'`. */
  readonly successDirection?: SuccessDirection;

  /**
   * Define a local scorer.
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
    this.name = name;
    this.fn = fn;
    this.threshold = options.threshold;
    this.passRateThreshold = options.passRateThreshold;
    this.successDirection = options.successDirection;
  }
}

/** One entry in a run's `criteria`: a LaunchDarkly judge or a local scorer. */
export type Criterion = Judge | Scorer;
