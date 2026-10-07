import { FORMATTING_INSTRUCTIONS } from '@launchdarkly/ai-server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSystemOne } = vi.hoisted(() => ({ mockSystemOne: vi.fn() }));

vi.mock('@typesafe-ai/sdk', () => ({
  TypeSafeClient: class {
    systemOne = mockSystemOne;
  },
  noul: (instructions: string, criteria?: unknown) => ({
    type: 'noul',
    instructions,
    ...(criteria ? { criteria } : {}),
  }),
  choice: (instructions: string, criteria: unknown) => ({ type: 'choice', instructions, criteria }),
  score: (instructions: string, criteria: unknown) => ({ type: 'score', instructions, criteria }),
}));

import { createTypesafeHandler } from '../handler.js';

const classifiers = [
  {
    key: 'tone',
    eventKey: '$ld:ai:judge:jev:tone',
    instructions: 'Is the tone appropriate?',
    type: 'noul',
    criteria: { true: 'Polite', false: 'Harmful' },
  },
  {
    key: 'accuracy',
    eventKey: '$ld:ai:judge:jev:accuracy',
    instructions: 'How accurate is the response?',
    type: 'score',
    criteria: ['Great', 'Ok', 'Bad'],
  },
];

describe('createTypesafeHandler', () => {
  beforeEach(() => {
    mockSystemOne.mockReset();
    mockSystemOne.mockResolvedValue({
      answers: {
        tone: { type: 'noul', noul: 0.25 },
        accuracy: { type: 'score', score: 1 },
      },
      usage: { input_tokens: 100, output_tokens: 20 },
    });
  });

  it('registers as the TypeSafe messages handler', () => {
    const handler = createTypesafeHandler();
    expect(handler.providesFor).toEqual(['TypeSafe', 'messages']);
    expect(handler.captureContent).toBe(false);
  });

  it('sends the classifier labels as Jev questions and returns one score per label', async () => {
    const handler = createTypesafeHandler();
    const result = await handler(
      {
        model: { name: 'jev-latest' },
        provider: { name: 'TypeSafe' },
        messages: [],
        classifiers,
      },
      'assistant output',
      undefined,
      {
        input: 'user question',
        response_to_evaluate: 'assistant output',
        message_history: `user question\n\nassistant output\n\n${FORMATTING_INSTRUCTIONS}`,
      },
    );

    const request = mockSystemOne.mock.calls[0][0];
    expect(request.model).toBe('jev-latest');
    expect(request.questions.tone).toMatchObject({
      type: 'noul',
      instructions: 'Is the tone appropriate?',
      criteria: { true: 'Polite', false: 'Harmful' },
    });
    expect(request.questions.accuracy).toMatchObject({ type: 'score', criteria: ['Great', 'Ok', 'Bad'] });
    expect(JSON.stringify(request.state)).not.toContain('{ "score"');
    expect(request.state).toMatchObject({ input: 'user question', output: 'assistant output' });
    expect(JSON.parse(String(result.output))).toEqual({
      kind: 'typesafe',
      results: [
        { key: 'tone', eventKey: '$ld:ai:judge:jev:tone', score: 0.25, reason: 'Harmful' },
        { key: 'accuracy', eventKey: '$ld:ai:judge:jev:accuracy', score: 0.5, reason: 'Ok' },
      ],
    });
    expect(result.usage).toEqual({ input_tokens: 100, output_tokens: 20 });
  });

  it('propagates a Jev client failure', async () => {
    mockSystemOne.mockRejectedValue(new Error('typesafe down'));
    const handler = createTypesafeHandler();
    await expect(
      handler({ model: { name: 'jev' }, provider: { name: 'TypeSafe' }, messages: [], classifiers }, 'output'),
    ).rejects.toThrow('typesafe down');
  });
});
