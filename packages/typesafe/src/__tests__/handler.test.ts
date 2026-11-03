import { configure, shutdown } from '@launchdarkly/ai-server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FORMATTING_INSTRUCTIONS } from '../questions.js';

const { clientArgs, mockSystemOne, setInput } = vi.hoisted(() => ({
  clientArgs: [] as unknown[][],
  mockSystemOne: vi.fn(),
  setInput: vi.fn(),
}));

vi.mock('@launchdarkly/ai-server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@launchdarkly/ai-server')>();
  return {
    ...actual,
    setInputContentAttributes: (...args: Parameters<typeof actual.setInputContentAttributes>) => {
      setInput(...args);
      return actual.setInputContentAttributes(...args);
    },
  };
});

vi.mock('@typesafe-ai/sdk', () => ({
  TypeSafeClient: class {
    systemOne = mockSystemOne;
    constructor(...args: unknown[]) {
      clientArgs.push(args);
    }
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
import { expectNoNeverForwardedValue, NEVER_FORWARDED_PARAMETERS } from './never-forwarded.js';

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
    clientArgs.length = 0;
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
    // Unset follows the process default, which is on.
    expect(handler.captureContent).toBe(true);
    expect(createTypesafeHandler({ captureContent: false }).captureContent).toBe(false);
  });

  describe('content capture resolves at run time', () => {
    afterEach(() => shutdown());

    const config = { model: { name: 'jev' }, provider: { name: 'TypeSafe' }, messages: [], classifiers };
    const captured = async (handler = createTypesafeHandler()) => {
      setInput.mockClear();
      await handler(config, 'assistant output');
      return setInput.mock.calls.length > 0;
    };

    it('writes the judged state when nothing sets it', async () => {
      expect(await captured()).toBe(true);
    });

    it('writes nothing with an explicit false', async () => {
      expect(await captured(createTypesafeHandler({ captureContent: false }))).toBe(false);
    });

    it('reads configure when the handler runs, not when it is built', async () => {
      const handler = createTypesafeHandler();
      configure({ options: { captureContent: false } });
      expect(handler.captureContent).toBe(false);
      expect(await captured(handler)).toBe(false);
    });

    it('writes the judged state with an explicit true when configure turns the default off', async () => {
      configure({ options: { captureContent: false } });
      expect(await captured(createTypesafeHandler({ captureContent: true }))).toBe(true);
    });
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

  // The cross-SDK TypeSafe forwarding table is empty. A Jev call takes the judge state, the
  // questions, and the model name, and has no field for sampling or output settings.
  it('forwards no model.parameters key to the client or the Jev request', async () => {
    const handler = createTypesafeHandler();
    await handler(
      {
        model: {
          name: 'jev-latest',
          parameters: {
            ...NEVER_FORWARDED_PARAMETERS,
            temperature: 0.2,
            max_tokens: 100,
            top_p: 0.9,
            model: 'smuggled-model',
            questions: { smuggled: true },
            state: { smuggled: true },
          },
        },
        provider: { name: 'TypeSafe' },
        messages: [],
        classifiers,
      },
      'assistant output',
    );
    expect(clientArgs).toEqual([[]]);
    const request = mockSystemOne.mock.calls[0][0];
    expect(Object.keys(request).sort()).toEqual(['model', 'questions', 'state']);
    expect(request.model).toBe('jev-latest');
    expect(JSON.stringify(request)).not.toContain('smuggled');
    expectNoNeverForwardedValue(request);
  });

  it('has no stream path, so there is no second call to keep in agreement', () => {
    expect(createTypesafeHandler().stream).toBeUndefined();
  });
});
