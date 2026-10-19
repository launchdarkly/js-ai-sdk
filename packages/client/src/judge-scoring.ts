/**
 * The contract every LaunchDarkly AI Judge invocation shares.
 *
 * Three paths run judges: the online inline path (`runJudges`), the online
 * deferred path (`runJudge`, from a `JudgeTask`), and the offline evaluations
 * path. All three prompt a judge for the same `{ "score": <0-1>, "reasoning":
 * <string> }` JSON and must show it the same conversation, so this module owns
 * both halves and the paths cannot drift.
 */

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
  return [parts.userInput, parts.trajectory, parts.output, FORMATTING_INSTRUCTIONS]
    .filter(Boolean)
    .map(String)
    .join('\n\n');
}

/**
 * Parse a judge response into its score and reasoning. Accepts a JSON string,
 * optionally in markdown fences, or an already-decoded object. `reason` is
 * accepted as an alias for `reasoning`. The score is returned untouched, for
 * the caller to apply its own policy to.
 *
 * Returns `null` when the response is not a non-empty JSON object.
 */
export function parseJudgeResponse(raw: unknown): { score: unknown; reasoning: string } | null {
  const parsed: unknown = typeof raw === 'string' ? parseJSONWithPossibleFences(raw) : raw;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed) || !Object.keys(parsed).length) {
    return null;
  }
  const { score, reasoning, reason } = parsed as Record<string, unknown>;
  const text = reasoning || reason;
  return { score, reasoning: text === undefined || text === null || text === false ? '' : String(text) };
}
