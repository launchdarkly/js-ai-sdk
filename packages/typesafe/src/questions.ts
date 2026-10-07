import type { AiConfigRep, Message } from '@launchdarkly/ai-server';
import { FORMATTING_INSTRUCTIONS } from '@launchdarkly/ai-server';

export type TypesafeQuestionType = 'noul' | 'choice' | 'score';

export type ExtractedQuestion = {
  key: string;
  eventKey: string;
  type: TypesafeQuestionType;
  instructions: string;
  criteria?: Record<string, string | null> | Array<string | null>;
};

export class TypesafeQuestionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TypesafeQuestionError';
  }
}

const QUESTION_TYPES = new Set<TypesafeQuestionType>(['noul', 'choice', 'score']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Reads the Jev questions from the judge variation's `classifiers` list.
 * This is the only place that knows that shape.
 */
export function extractTypesafeQuestions(config: AiConfigRep): ExtractedQuestion[] {
  const labels = config.classifiers;
  if (!Array.isArray(labels) || labels.length === 0) {
    throw new TypesafeQuestionError('classifiers must be a non-empty list');
  }

  const seen = new Set<string>();
  const seenEvents = new Set<string>();
  return labels.map((label, index) => {
    if (!isRecord(label)) {
      throw new TypesafeQuestionError(`classifiers[${index}] must be an object`);
    }
    const key = label.key;
    if (typeof key !== 'string' || key.trim() === '') {
      throw new TypesafeQuestionError(`classifiers[${index}] is missing a key`);
    }
    if (seen.has(key)) {
      throw new TypesafeQuestionError(`classifiers has a duplicate key '${key}'`);
    }
    seen.add(key);
    const eventKey = label.eventKey;
    if (typeof eventKey !== 'string' || eventKey.trim() === '') {
      throw new TypesafeQuestionError(`classifiers label '${key}' is missing an eventKey`);
    }
    if (seenEvents.has(eventKey)) {
      throw new TypesafeQuestionError(`classifiers has a duplicate eventKey '${eventKey}'`);
    }
    seenEvents.add(eventKey);
    const type = label.type;
    if (typeof type !== 'string' || !QUESTION_TYPES.has(type as TypesafeQuestionType)) {
      throw new TypesafeQuestionError(`classifiers label '${key}' has an unsupported type`);
    }
    const instructions = label.instructions;
    if (typeof instructions !== 'string' || instructions.trim() === '') {
      throw new TypesafeQuestionError(`classifiers label '${key}' is missing instructions`);
    }
    const criteria = criteriaFor(key, type as TypesafeQuestionType, label.criteria);
    return {
      key,
      eventKey,
      type: type as TypesafeQuestionType,
      instructions,
      ...(criteria !== undefined ? { criteria } : {}),
    };
  });
}

function criteriaFor(key: string, type: TypesafeQuestionType, raw: unknown): ExtractedQuestion['criteria'] | undefined {
  if (type === 'noul') {
    if (raw === undefined) return undefined;
    if (!isRecord(raw)) {
      throw new TypesafeQuestionError(`classifiers label '${key}' has invalid noul criteria`);
    }
    const criteria: Record<string, string | null> = {};
    for (const name of ['true', 'false']) {
      if (!(name in raw)) continue;
      const description = raw[name];
      if (description !== null && typeof description !== 'string') {
        throw new TypesafeQuestionError(`classifiers label '${key}' has a non-string noul description`);
      }
      criteria[name] = description;
    }
    return Object.keys(criteria).length > 0 ? criteria : undefined;
  }
  if (type === 'choice') {
    if (!isRecord(raw) || Object.keys(raw).length === 0) {
      throw new TypesafeQuestionError(`classifiers label '${key}' requires choice criteria`);
    }
    const criteria: Record<string, string | null> = {};
    for (const [name, description] of Object.entries(raw)) {
      if (name.trim() === '') {
        throw new TypesafeQuestionError(`classifiers label '${key}' has an empty choice`);
      }
      if (description !== null && typeof description !== 'string') {
        throw new TypesafeQuestionError(`classifiers label '${key}' has a non-string choice description`);
      }
      criteria[name] = description;
    }
    return criteria;
  }
  if (!Array.isArray(raw) || raw.length < 2) {
    throw new TypesafeQuestionError(`classifiers label '${key}' requires at least two score levels`);
  }
  return raw.map((level) => {
    if (level !== null && typeof level !== 'string') {
      throw new TypesafeQuestionError(`classifiers label '${key}' has a non-string score level`);
    }
    return level;
  });
}

export function withoutFormattingInstructions(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const index = value.indexOf(FORMATTING_INSTRUCTIONS);
  const text = (index === -1 ? value : value.slice(0, index)).trim();
  return text === '' ? undefined : text;
}

/**
 * Everything the judge was given, except the SDK's own `{score, reasoning}`
 * instructions. Jev questions come from the judge config, not from that block.
 */
export function buildTypesafeState(args: {
  userInput?: string;
  variables?: Record<string, unknown>;
  history?: Message[];
}): Record<string, unknown> {
  const variables = args.variables ?? {};
  const state: Record<string, unknown> = {};
  const assign = (key: string, value: unknown) => {
    if (value === undefined || value === null || value === '') return;
    state[key] = value;
  };

  assign('input', variables.input);
  const output = variables.response_to_evaluate ?? args.userInput;
  assign('output', output);
  assign('message_history', withoutFormattingInstructions(variables.message_history));
  assign('trajectory', variables.trajectory);
  assign('expected_output', variables.expected_output);
  assign('ground_truth_context', variables.ground_truth_context);
  if (args.userInput && args.userInput !== output) assign('user_input', args.userInput);
  if (args.history && args.history.length > 0) state.history = args.history;
  return state;
}

type AnswerLike = {
  noul?: unknown;
  choice?: unknown;
  confidence?: unknown;
  probabilities?: unknown;
  score?: unknown;
  legend?: unknown;
};

function read(answer: unknown, field: keyof AnswerLike): unknown {
  if (!isRecord(answer)) return undefined;
  return answer[field];
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** Maps one Jev answer onto the 0–1 score stored in `judgeResults`. */
export function scoreFromAnswer(question: ExtractedQuestion, answer: unknown): number {
  if (question.type === 'noul') {
    const noul = finite(read(answer, 'noul'));
    if (noul === undefined) {
      throw new TypesafeQuestionError(`TypeSafe answer '${question.key}' is missing a noul probability`);
    }
    return clamp(noul);
  }
  if (question.type === 'choice') {
    const selected = read(answer, 'choice');
    const probabilities = read(answer, 'probabilities');
    if (typeof selected === 'string' && isRecord(probabilities)) {
      const selectedProbability = finite(probabilities[selected]);
      if (selectedProbability !== undefined) return clamp(selectedProbability);
    }
    const confidence = finite(read(answer, 'confidence'));
    if (confidence !== undefined) return clamp(confidence);
    if (typeof selected === 'string' && selected !== '') return 1;
    throw new TypesafeQuestionError(`TypeSafe answer '${question.key}' is missing a choice`);
  }

  const score = finite(read(answer, 'score'));
  if (score === undefined) {
    throw new TypesafeQuestionError(`TypeSafe answer '${question.key}' is missing a score`);
  }
  const legend = read(answer, 'legend');
  const levels = isRecord(legend)
    ? Object.keys(legend).length
    : Array.isArray(question.criteria)
      ? question.criteria.length
      : 0;
  // Jev's score is an expected rubric index. A value in 0–1 is the low end of
  // a longer rubric, not a probability. Two levels divide by 1.
  if (levels > 1) return clamp(score / (levels - 1));
  return clamp(score);
}

function criterionText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/** Integer closest to `score` among `keys`. Ties resolve to the lower key. */
function nearestKey(score: number, keys: number[]): number {
  return keys.reduce((best, key) => {
    const bestDistance = Math.abs(best - score);
    const distance = Math.abs(key - score);
    if (distance < bestDistance || (distance === bestDistance && key < best)) return key;
    return best;
  });
}

/**
 * The selected label's value, stored as the judge result reason.
 * A noul at or above 0.5 selects `true`. A score uses the legend entry nearest the raw score.
 */
export function reasonFromAnswer(question: ExtractedQuestion, answer: unknown): string {
  if (question.type === 'noul') {
    const noul = finite(read(answer, 'noul')) ?? 0;
    const side = noul >= 0.5 ? 'true' : 'false';
    if (isRecord(question.criteria)) {
      const described = criterionText(question.criteria[side]);
      if (described) return described;
    }
    return side;
  }
  if (question.type === 'choice') {
    const selected = read(answer, 'choice');
    const name = typeof selected === 'string' ? selected : '';
    if (name && isRecord(question.criteria)) {
      const described = criterionText(question.criteria[name]);
      if (described) return described;
    }
    return name;
  }

  const score = finite(read(answer, 'score'));
  if (score === undefined) return '';
  const legend = read(answer, 'legend');
  if (isRecord(legend)) {
    const keys = Object.keys(legend)
      .map((key) => Number(key))
      .filter((key) => Number.isFinite(key));
    if (keys.length > 0) {
      const level = nearestKey(score, keys);
      const described = criterionText(legend[String(level)]);
      if (described) return described;
    }
  }
  if (Array.isArray(question.criteria) && question.criteria.length > 0) {
    const level = nearestKey(
      score,
      question.criteria.map((_, index) => index),
    );
    const described = criterionText(question.criteria[level]);
    if (described) return described;
  }
  return '';
}

export function typesafeOutput(
  results: Array<{ key: string; eventKey: string; score: number; reason: string }>,
): string {
  return JSON.stringify({ kind: 'typesafe', results });
}
