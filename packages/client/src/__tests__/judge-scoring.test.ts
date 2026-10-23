/**
 * The judge contract every judge path shares. Non-string values are rendered
 * as JSON, never as a language repr, so a rubric reads the same in every SDK.
 */

import { describe, expect, it } from 'vitest';
import { buildMessageHistory, FORMATTING_INSTRUCTIONS, parseJudgeResponse } from '../judge-scoring.js';

describe('buildMessageHistory', () => {
  it('renders a structured output as JSON, keeping non-ASCII', () => {
    expect(buildMessageHistory({ userInput: 'q', output: { answer: 'oui', ok: true, note: null } })).toBe(
      ['q', '{"answer":"oui","ok":true,"note":null}', FORMATTING_INSTRUCTIONS].join('\n\n'),
    );
    expect(buildMessageHistory({ output: { city: 'Zürich' } })).toContain('{"city":"Zürich"}');
  });

  it.each([null, undefined, ''])('skips an output of %j', (output) => {
    expect(buildMessageHistory({ userInput: 'q', output })).toBe(['q', FORMATTING_INSTRUCTIONS].join('\n\n'));
  });

  it.each([
    [0, '0'],
    [false, 'false'],
    [{}, '{}'],
    [[], '[]'],
  ])('shows an output of %j, which is an answer the judge has to grade', (output, text) => {
    expect(buildMessageHistory({ userInput: 'q', output })).toBe(['q', text, FORMATTING_INSTRUCTIONS].join('\n\n'));
  });
});

describe('parseJudgeResponse', () => {
  it('renders non-string reasoning as JSON, not a repr', () => {
    expect(parseJudgeResponse({ score: 1, reasoning: { points: ['a'] } })?.reasoning).toBe('{"points":["a"]}');
    expect(parseJudgeResponse({ score: 1, reasoning: 0 })?.reasoning).toBe('0');
  });

  it('falls back to reason only when reasoning has no text', () => {
    expect(parseJudgeResponse({ score: 1, reasoning: '', reason: 'fallback' })?.reasoning).toBe('fallback');
    expect(parseJudgeResponse({ score: 1, reasoning: null, reason: 'fallback' })?.reasoning).toBe('fallback');
    expect(parseJudgeResponse({ score: 1, reasoning: [], reason: 'fallback' })?.reasoning).toBe('[]');
    expect(parseJudgeResponse({ score: 1 })?.reasoning).toBe('');
  });
});
