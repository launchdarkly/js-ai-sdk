import type { AiConfigRep } from '@launchdarkly/ai-server';
import { FORMATTING_INSTRUCTIONS } from '@launchdarkly/ai-server';
import { describe, expect, it } from 'vitest';
import { buildTypesafeState, extractTypesafeQuestions, reasonFromAnswer, scoreFromAnswer } from '../questions.js';

const classifiers = [
  {
    key: 'accuracy',
    eventKey: '$ld:ai:judge:jev:accuracy',
    instructions: 'How accurate is the response?',
    type: 'score',
    criteria: ['Great', 'Ok', 'Bad'],
  },
  {
    key: 'tone',
    eventKey: '$ld:ai:judge:jev:tone',
    instructions: 'Is the tone appropriate?',
    type: 'noul',
    criteria: { true: 'Polite', false: 'Harmful' },
  },
  {
    key: 'route',
    eventKey: '$ld:ai:judge:jev:route',
    instructions: 'What is the tone?',
    type: 'choice',
    criteria: { calm: 'Calm', angry: 'Angry' },
  },
];

function config(labels: unknown = classifiers): AiConfigRep {
  return {
    model: { name: 'jev-latest' },
    provider: { name: 'TypeSafe' },
    messages: [],
    classifiers: labels as AiConfigRep['classifiers'],
  };
}

describe('extractTypesafeQuestions', () => {
  it('reads noul, choice, and score labels from classifiers', () => {
    expect(extractTypesafeQuestions(config())).toEqual([
      {
        key: 'accuracy',
        eventKey: '$ld:ai:judge:jev:accuracy',
        type: 'score',
        instructions: 'How accurate is the response?',
        criteria: ['Great', 'Ok', 'Bad'],
      },
      {
        key: 'tone',
        eventKey: '$ld:ai:judge:jev:tone',
        type: 'noul',
        instructions: 'Is the tone appropriate?',
        criteria: { true: 'Polite', false: 'Harmful' },
      },
      {
        key: 'route',
        eventKey: '$ld:ai:judge:jev:route',
        type: 'choice',
        instructions: 'What is the tone?',
        criteria: { calm: 'Calm', angry: 'Angry' },
      },
    ]);
  });

  it('rejects a config with no classifier labels', () => {
    expect(() => extractTypesafeQuestions(config([]))).toThrow(/classifiers/);
    expect(() =>
      extractTypesafeQuestions({
        model: { name: 'jev' },
        provider: { name: 'TypeSafe' },
        instructions: 'unused',
      }),
    ).toThrow(/classifiers/);
  });
});

describe('buildTypesafeState', () => {
  it('keeps the conversation and drops the score-format instructions', () => {
    const state = buildTypesafeState({
      userInput: 'the answer',
      variables: {
        input: 'the question',
        response_to_evaluate: 'the answer',
        message_history: `the question\n\n${FORMATTING_INSTRUCTIONS}`,
        trajectory: 'called search',
      },
      history: [{ role: 'user', content: 'earlier' }],
    });
    expect(state).toEqual({
      input: 'the question',
      output: 'the answer',
      message_history: 'the question',
      trajectory: 'called search',
      history: [{ role: 'user', content: 'earlier' }],
    });
    expect(JSON.stringify(state)).not.toContain('valid JSON format');
  });
});

describe('scoreFromAnswer', () => {
  const noul = { key: 'migration', eventKey: 'migration', type: 'noul' as const, instructions: 'migration?' };
  const choice = {
    key: 'tone',
    eventKey: 'tone',
    type: 'choice' as const,
    instructions: 'tone?',
    criteria: { calm: null, angry: null },
  };
  const scored = {
    key: 'urgency',
    eventKey: 'urgency',
    type: 'score' as const,
    instructions: 'urgency?',
    criteria: ['a', 'b', 'c'],
  };

  it('uses a noul probability', () => {
    expect(scoreFromAnswer(noul, { noul: 0.82 })).toBe(0.82);
  });

  it('uses the selected choice probability', () => {
    expect(
      scoreFromAnswer(choice, { choice: 'angry', probabilities: { calm: 0.2, angry: 0.8 }, confidence: 0.1 }),
    ).toBe(0.8);
  });

  it('divides a rubric index by one less than the number of levels', () => {
    const legend = { 0: 'a', 1: 'b', 2: 'c' };
    expect(scoreFromAnswer(scored, { score: 0.4, legend })).toBeCloseTo(0.2);
    expect(scoreFromAnswer(scored, { score: 1, legend })).toBe(0.5);
    expect(scoreFromAnswer(scored, { score: 1.7, legend })).toBeCloseTo(0.85);
    expect(scoreFromAnswer({ ...scored, criteria: ['a', 'b'] }, { score: 0.4, legend: { 0: 'a', 1: 'b' } })).toBe(0.4);
  });
});

describe('reasonFromAnswer', () => {
  const noul = {
    key: 'tone',
    eventKey: 'tone',
    type: 'noul' as const,
    instructions: 'tone?',
    criteria: { true: 'Polite', false: 'Harmful' },
  };
  const choice = {
    key: 'route',
    eventKey: 'route',
    type: 'choice' as const,
    instructions: 'route?',
    criteria: { calm: 'A neutral message', angry: null },
  };
  const scored = {
    key: 'urgency',
    eventKey: 'urgency',
    type: 'score' as const,
    instructions: 'urgency?',
    criteria: ['Great', 'Ok', 'Bad'],
  };

  it('uses the criteria text for the noul side at or above 0.5', () => {
    expect(reasonFromAnswer(noul, { noul: 0.5 })).toBe('Polite');
    expect(reasonFromAnswer(noul, { noul: 0.49 })).toBe('Harmful');
    expect(reasonFromAnswer({ ...noul, criteria: undefined }, { noul: 0.9 })).toBe('true');
  });

  it('uses the selected choice text, or the choice name when that text is absent', () => {
    expect(reasonFromAnswer(choice, { choice: 'calm' })).toBe('A neutral message');
    expect(reasonFromAnswer(choice, { choice: 'angry' })).toBe('angry');
  });

  it('uses the legend entry nearest the raw score', () => {
    const legend = { 0: 'Great', 1: 'Ok', 2: 'Bad' };
    expect(reasonFromAnswer(scored, { score: 0.4, legend })).toBe('Great');
    expect(reasonFromAnswer(scored, { score: 1.5, legend })).toBe('Ok');
    expect(reasonFromAnswer(scored, { score: 1.7, legend })).toBe('Bad');
    expect(reasonFromAnswer(scored, { score: 1 })).toBe('Ok');
  });
});
