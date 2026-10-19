import { describe, expect, it } from 'vitest';
import { EvalTool, EvaluationsError, EvaluationsModule, initEvaluations, Judge, Scorer } from '../experimental.js';

// Evaluations from Code is stubbed: the surface exists, and every entry point
// that would do work throws until the harness is implemented.

describe('evaluations stubs', () => {
  it('initEvaluations throws EvaluationsError', () => {
    expect(() => initEvaluations({ projectKey: 'p', apiKey: 'a', sdkKey: 's' })).toThrow(EvaluationsError);
  });

  it('run() rejects with EvaluationsError', async () => {
    const evals = new EvaluationsModule('p');
    await expect(
      evals.run({
        key: 'k',
        dataset: 'd',
        handlers: [],
        generation: { provider: 'OpenAI', model: 'gpt-4o', mode: 'completion' },
      }),
    ).rejects.toThrow(EvaluationsError);
  });

  it('tools.get() rejects with EvaluationsError', async () => {
    const evals = new EvaluationsModule('p');
    await expect(evals.tools.get('lookup', { implementation: () => 'x' })).rejects.toThrow(EvaluationsError);
  });

  it('a constructed EvalTool is inline with no version', () => {
    const tool = new EvalTool('lookup', () => 'x', {});
    expect(tool.source).toBe('inline');
    expect(tool.version).toBeUndefined();
    expect(tool.description).toBe('');
  });

  it('a Judge defaults its thresholds', () => {
    expect(new Judge('accuracy')).toMatchObject({ threshold: 0.5, passRateThreshold: 0.95 });
  });

  it('a Scorer defaults its thresholds and success direction', () => {
    expect(new Scorer('exact', () => true)).toMatchObject({
      threshold: 1.0,
      passRateThreshold: 0.95,
      successDirection: 'higher_is_better',
    });
  });

  it('supplied values override the defaults, including 0', () => {
    expect(new Judge('accuracy', { threshold: 0, passRateThreshold: 0.8 })).toMatchObject({
      threshold: 0,
      passRateThreshold: 0.8,
    });
    expect(new Scorer('hits', () => 0, { threshold: 0.2, successDirection: 'lower_is_better' })).toMatchObject({
      threshold: 0.2,
      successDirection: 'lower_is_better',
    });
  });

  it('Judge and Scorer keep their fields', () => {
    expect(new Judge('accuracy', { threshold: 0.7 })).toMatchObject({ key: 'accuracy', threshold: 0.7 });
    expect(new Scorer('exact', () => true).name).toBe('exact');
  });
});
