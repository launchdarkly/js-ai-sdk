/**
 * Python's text forms. Each expected string is what CPython prints for the
 * same value, so judge prompts and messages read the same as the Python SDK's.
 */

import { describe, expect, it } from 'vitest';
import { buildMessageHistory, FORMATTING_INSTRUCTIONS, parseJudgeResponse } from '../judge-scoring.js';
import { pythonJsonNumber, pythonRepr, pythonStr, pythonTruthy } from '../python-format.js';

describe('pythonRepr', () => {
  it.each([
    ['plain', "'plain'"],
    ["it's", `"it's"`],
    ['say "hi"', `'say "hi"'`],
    [`both ' and "`, `'both \\' and "'`],
    ['tab\there', "'tab\\there'"],
    ['nl\nx', "'nl\\nx'"],
    ['back\\slash', "'back\\\\slash'"],
    ['ctl\x01', "'ctl\\x01'"],
    ['café 東京', "'café 東京'"],
    ['del\x7f', "'del\\x7f'"],
    [' ', "'\\u2028'"],
    ['\x85', "'\\x85'"],
    ['​', "'\\u200b'"],
  ])('quotes and escapes %j as Python does', (text, expected) => {
    expect(pythonRepr(text)).toBe(expected);
  });

  it('writes containers, booleans, None and numbers as Python does', () => {
    expect(pythonRepr({ a: 1, b: [true, null, 2.5, 3, 'x'], c: {} })).toBe(
      "{'a': 1, 'b': [True, None, 2.5, 3, 'x'], 'c': {}}",
    );
    expect([pythonRepr([]), pythonRepr({}), pythonRepr(undefined)]).toEqual(['[]', '{}', 'None']);
  });

  it.each([
    [Number.NaN, 'nan'],
    [Number.POSITIVE_INFINITY, 'inf'],
    [Number.NEGATIVE_INFINITY, '-inf'],
    [1e16, '1e+16'],
    [3, '3'],
    [2.5, '2.5'],
    [1e-5, '1e-05'],
  ])('writes the number %d as %s', (value, expected) => {
    expect(pythonRepr(value)).toBe(expected);
  });
});

describe('pythonJsonNumber and pythonRepr read numbers the same way', () => {
  it.each([
    [3, '3', '3'],
    [-2, '-2', '-2'],
    [-0, '0', '0'],
    [2.5, '2.5', '2.5'],
    [1e16, '1e+16', '1e+16'],
    [2 ** 53, '9007199254740992.0', '9007199254740992.0'],
    [Number.NaN, 'NaN', 'nan'],
    [Number.POSITIVE_INFINITY, 'Infinity', 'inf'],
  ])('%d is %s in json.dumps and %s in repr', (value, json, repr) => {
    expect(pythonJsonNumber(value)).toBe(json);
    expect(pythonRepr(value)).toBe(repr);
  });
});

describe('pythonStr and pythonTruthy', () => {
  it('leaves a string as it is and reprs the rest', () => {
    expect(pythonStr('text')).toBe('text');
    expect(pythonStr({ a: 'b' })).toBe("{'a': 'b'}");
  });

  it('treats None, False, 0, empty strings and empty containers as false', () => {
    for (const value of [null, undefined, false, 0, -0, '', [], {}])
      expect(pythonTruthy(value), String(value)).toBe(false);
    for (const value of [true, 1, Number.NaN, ' ', [0], { a: 0 }])
      expect(pythonTruthy(value), String(value)).toBe(true);
  });
});

describe('the shared judge contract', () => {
  it('renders a structured output in message_history as Python str(), skipping empty parts', () => {
    expect(buildMessageHistory({ userInput: 'q', output: { answer: 'yes', confidence: 0.9 } })).toBe(
      ['q', "{'answer': 'yes', 'confidence': 0.9}", FORMATTING_INSTRUCTIONS].join('\n\n'),
    );
    expect(buildMessageHistory({ userInput: 'q', output: {} })).toBe(['q', FORMATTING_INSTRUCTIONS].join('\n\n'));
  });

  it('reads reasoning, then reason, by Python truthiness, and str()s it', () => {
    expect(parseJudgeResponse({ score: 1, reasoning: { points: ['a'] } })?.reasoning).toBe("{'points': ['a']}");
    expect(parseJudgeResponse({ score: 1, reasoning: [], reason: 'fallback' })?.reasoning).toBe('fallback');
    expect(parseJudgeResponse({ score: 1, reasoning: 0 })?.reasoning).toBe('');
  });
});
