/**
 * The contract every LaunchDarkly AI Judge invocation shares.
 *
 * Three paths run judges: the online inline path (`runJudges`), the online
 * deferred path (`runJudge`, from a `JudgeTask`), and the offline evaluations
 * path. All three prompt a judge for the same `{ "score": <0-1>, "reasoning":
 * <string> }` JSON and must show it the same conversation, so this module owns
 * both halves and the paths cannot drift.
 */

import { toolResultString } from './content.js';
import { pythonStr, pythonTruthy } from './python-format.js';
import type { AiConfigRep } from './types.js';
import { parseJSONWithPossibleFences } from './utils.js';

export const FORMATTING_INSTRUCTIONS = [
  'Your response MUST be in valid JSON format with the following structure:',
  '{ "score": <number, 0-1>, "reasoning": <string> }',
  'The output must be valid, parseable JSON. Do not include additional tags, comments, formatting, or newlines.',
  'It should be returned in a format that is immediately parseable by a JSON parsing function. Do not include ```json tags.',
].join('\n');

/**
 * The conversation a judge is shown, as its `message_history` variable: what
 * was asked, what the agent did, what it answered, then how to format the
 * verdict. Empty parts are skipped, so a unit with no tools gets the history it
 * got before trajectories existed.
 *
 * The formatting block is appended here, not by callers: judges built from the
 * AI Library's default templates read the JSON shape from
 * `{{message_history}}`, and a judge that stopped being told it would answer in
 * prose and fail every result as invalid output.
 */
export function buildMessageHistory(parts: { userInput?: unknown; trajectory?: string; output?: unknown }): string {
  // Python's truthiness, so the same parts are skipped as in the Python SDK. A structured output is
  // shown as JSON, by the rule tool results follow, so a rubric reads the same text in every SDK.
  const output = pythonTruthy(parts.output) ? toolResultString(parts.output) : undefined;
  return [parts.userInput, parts.trajectory, output, FORMATTING_INSTRUCTIONS]
    .filter(pythonTruthy)
    .map(pythonStr)
    .join('\n\n');
}

/**
 * `score` when it already is a finite number, else `undefined`. Never throws.
 *
 * A judge is prompted for a number but can return anything. A judge that
 * returns `"0.9 (high)"` or `null` must not take down the evaluation that
 * follows, and must not put a string where semconv defines
 * `gen_ai.evaluation.score.value` as a double: OTel drops a null attribute but
 * exports a string, which breaks numeric aggregation downstream. Each path
 * applies its own policy to the rest, such as the offline 0–1 range.
 */
export function numericScore(score: unknown): number | undefined {
  return typeof score === 'number' && Number.isFinite(score) ? score : undefined;
}

/**
 * Parse a judge response into its score and reasoning. Accepts a JSON string,
 * optionally in markdown fences, or an already-decoded object. `reason` is
 * accepted as an alias for `reasoning`. The score is returned untouched, for
 * the caller to apply its own policy to, through {@link numericScore}.
 *
 * Returns `null` when the response is not a non-empty JSON object.
 */
export function parseJudgeResponse(raw: unknown): { score: unknown; reasoning: string } | null {
  const parsed: unknown = typeof raw === 'string' ? parseJSONWithPossibleFences(raw) : raw;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed) || !Object.keys(parsed).length) {
    return null;
  }
  const { score, reasoning, reason } = parsed as Record<string, unknown>;
  // `reasoning or reason or ""`, then str(), as the Python SDK reads it.
  const text = pythonTruthy(reasoning) ? reasoning : pythonTruthy(reason) ? reason : '';
  return { score, reasoning: pythonStr(text) };
}

/**
 * A judge config with its `outputFormat` removed, warning once when it was present.
 *
 * A judge is an ordinary AI Config and can carry its own `outputFormat` JSON Schema, but the verdict
 * shape belongs to this module: `{ score, reasoning }`, enforced by `FORMATTING_INSTRUCTIONS` and
 * `parseJudgeResponse`. A provider handler that honors `config.outputFormat` would constrain the judge
 * model to the author's schema instead, so the verdict could never parse. Every judge path (inline,
 * deferred `JudgeTask`, offline evaluations) passes its config through here before it reaches a
 * handler or a serialized task.
 *
 * Returns `config` itself when the field is absent. Never mutates it: it may be the cached result of
 * `extractVariation`.
 */
export function withoutOutputFormat(config: AiConfigRep, judgeKey: string): AiConfigRep {
  if (config.outputFormat === undefined) return config;
  // biome-ignore lint/suspicious/noConsole: this package has no logger abstraction; an ignored judge setting must be visible
  console.warn(`[LaunchDarkly] Judge '${judgeKey}': ignoring outputFormat; a judge must return { score, reasoning }.`);
  const { outputFormat: _outputFormat, ...rest } = config;
  return rest;
}
