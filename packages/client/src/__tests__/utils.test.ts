import { describe, expect, it, vi } from 'vitest';
import {
  createHandler,
  normalizeMode,
  numberOrZero,
  parseJSONWithPossibleFences,
  parseTemplate,
  parseUsage,
  setLdSpanAttributes,
  setUsageSpanAttributes,
} from '../utils.js';

// ─── parseTemplate ────────────────────────────────────────────────────────────

describe('parseTemplate', () => {
  it('replaces a single placeholder', () => {
    expect(parseTemplate('Hello {{name}}', { name: 'world' })).toBe('Hello world');
  });

  it('replaces multiple placeholders', () => {
    expect(parseTemplate('{{greeting}}, {{name}}!', { greeting: 'Hi', name: 'Alice' })).toBe('Hi, Alice!');
  });

  it('leaves unknown placeholders unchanged', () => {
    expect(parseTemplate('Hello {{missing}}', {})).toBe('Hello {{missing}}');
  });

  it('resolves dot-notation access', () => {
    expect(parseTemplate('Hi {{user.name}}', { user: { name: 'Alice' } })).toBe('Hi Alice');
  });

  it('leaves placeholder unchanged when dot-notation path is partially missing', () => {
    expect(parseTemplate('{{user.missing}}', { user: {} })).toBe('{{user.missing}}');
  });

  it('resolves deeply nested values', () => {
    expect(parseTemplate('{{a.b.c}}', { a: { b: { c: 42 } } })).toBe('42');
  });

  it('coerces non-string values to string', () => {
    expect(parseTemplate('{{count}}', { count: 7 })).toBe('7');
    expect(parseTemplate('{{flag}}', { flag: true })).toBe('true');
  });

  it('returns template unchanged when variables map is empty', () => {
    expect(parseTemplate('No subs here', {})).toBe('No subs here');
  });

  it('returns template unchanged when there are no placeholders', () => {
    expect(parseTemplate('plain string', { name: 'ignored' })).toBe('plain string');
  });

  it('replaces the same placeholder appearing multiple times', () => {
    expect(parseTemplate('{{x}} and {{x}}', { x: 'foo' })).toBe('foo and foo');
  });
});

// ─── parseJSONWithPossibleFences ──────────────────────────────────────────────

describe('parseJSONWithPossibleFences', () => {
  it('parses plain JSON', () => {
    expect(parseJSONWithPossibleFences('{"a":1}')).toEqual({ a: 1 });
  });

  it('parses JSON fenced with ```json', () => {
    expect(parseJSONWithPossibleFences('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('parses JSON fenced with bare ```', () => {
    expect(parseJSONWithPossibleFences('```\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('handles leading/trailing whitespace inside fences', () => {
    expect(parseJSONWithPossibleFences('```json\n  {"a":1}  \n```')).toEqual({ a: 1 });
  });

  it('parses JSON fenced with ```json\\r\\n (Windows line endings)', () => {
    expect(parseJSONWithPossibleFences('```json\r\n{"a":1}\r\n```')).toEqual({ a: 1 });
  });

  it('parses JSON fenced with bare ```\\r\\n (Windows line endings)', () => {
    expect(parseJSONWithPossibleFences('```\r\n{"a":1}\r\n```')).toEqual({ a: 1 });
  });

  it('returns null for non-JSON input', () => {
    expect(parseJSONWithPossibleFences('not json at all')).toBeNull();
  });

  it('does not call console.error on invalid input', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    parseJSONWithPossibleFences('not valid json at all');
    expect(consoleSpy).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('returns null for JSON fenced but with invalid content', () => {
    expect(parseJSONWithPossibleFences('```json\nnot valid\n```')).toBeNull();
  });

  it('parses complex nested JSON correctly', () => {
    const obj = { arr: [1, 2, { deep: true }], str: 'hello' };
    expect(parseJSONWithPossibleFences(JSON.stringify(obj))).toEqual(obj);
  });

  it('strips fence and parses when the input has leading whitespace before the opening backticks', () => {
    expect(parseJSONWithPossibleFences('  ```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('strips bare fence with leading whitespace', () => {
    expect(parseJSONWithPossibleFences('  ```\n{"a":1}\n```')).toEqual({ a: 1 });
  });
});

// ─── parseUsage ───────────────────────────────────────────────────────────────

describe('parseUsage', () => {
  it('handles input_tokens / output_tokens keys', () => {
    expect(parseUsage({ input_tokens: 10, output_tokens: 5 })).toEqual({ input: 10, output: 5, total: 15 });
  });

  it('includes snake-case cache reads and creation in input tokens', () => {
    expect(
      parseUsage({
        input_tokens: 4,
        output_tokens: 5,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 20,
      }),
    ).toEqual({
      input: 124,
      output: 5,
      total: 129,
      inputDetails: { uncached: 4, cacheRead: 100, cacheCreation: 20 },
    });
  });

  it('handles inputTokens / outputTokens keys', () => {
    expect(parseUsage({ inputTokens: 8, outputTokens: 4 })).toEqual({ input: 8, output: 4, total: 12 });
  });

  it('includes camel-case cache reads and creation in input tokens', () => {
    expect(
      parseUsage({
        inputTokens: 8,
        outputTokens: 4,
        cacheReadInputTokens: 30,
        cacheCreationInputTokens: 2,
      }),
    ).toEqual({
      input: 40,
      output: 4,
      total: 44,
      inputDetails: { uncached: 8, cacheRead: 30, cacheCreation: 2 },
    });
  });

  it('handles input / output keys', () => {
    expect(parseUsage({ input: 3, output: 7 })).toEqual({ input: 3, output: 7, total: 10 });
  });

  it('computes total as input + output (ignores any raw total field)', () => {
    expect(parseUsage({ input_tokens: 10, output_tokens: 5, total: 999 }).total).toBe(15);
  });

  it('returns zeros when no recognized keys are present', () => {
    expect(parseUsage({ unknown: 99 })).toEqual({ input: 0, output: 0, total: 0 });
  });

  it('uses the first matching key pair when multiple are present', () => {
    // input_tokens is checked first; inputTokens should be ignored
    const result = parseUsage({ input_tokens: 10, output_tokens: 2, inputTokens: 99, outputTokens: 99 });
    expect(result).toEqual({ input: 10, output: 2, total: 12 });
  });

  it('folds an Anthropic-shaped bag once and reports the breakdown', () => {
    // This is the shape claude-messages and claude-agents return: cache reported
    // *alongside* input, never folded into it by the handler.
    expect(
      parseUsage({
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 7,
        cache_creation_input_tokens: 3,
      }),
    ).toEqual({
      input: 20,
      output: 5,
      total: 25,
      inputDetails: { uncached: 10, cacheRead: 7, cacheCreation: 3 },
    });
  });

  it('leaves a cache-inclusive input untouched when no cache keys are returned', () => {
    // This is the shape the OpenAI and LangChain handlers return: cache is already
    // counted inside input, so the fold must find nothing to add.
    expect(parseUsage({ input_tokens: 20, output_tokens: 5 })).toEqual({ input: 20, output: 5, total: 25 });
  });

  it('accepts cacheWriteInputTokens as a cache-creation alias', () => {
    // Bedrock Converse spells cache-creation this way; an unlisted spelling would be
    // silently dropped from input and reported as 0 in the breakdown.
    expect(parseUsage({ inputTokens: 10, outputTokens: 5, cacheWriteInputTokens: 4 })).toEqual({
      input: 14,
      output: 5,
      total: 19,
      inputDetails: { uncached: 10, cacheRead: 0, cacheCreation: 4 },
    });
  });

  it('coerces non-numeric counts so total never becomes NaN', () => {
    // trackTokens guards on `total > 0`, and `NaN > 0` is false — an uncoerced NaN
    // drops all three LD token metrics silently instead of reporting them low.
    expect(parseUsage({ input_tokens: undefined, output_tokens: 4 })).toEqual({
      input: 0,
      output: 4,
      total: 4,
    });
    expect(parseUsage({ input_tokens: 'lots', output_tokens: 4 }).total).toBe(4);
  });
});

// ─── createHandler ────────────────────────────────────────────────────────────

describe('createHandler', () => {
  const makeRawHandler = () =>
    vi.fn().mockResolvedValue({ output: 'hello', usage: { input_tokens: 1, output_tokens: 2 } });

  it('attaches providesFor to the handler', () => {
    const fn = makeRawHandler();
    const handler = createHandler(['MyProvider', 'agent'], fn as any);
    expect(handler.providesFor).toEqual(['MyProvider', 'agent']);
  });

  it('returns the same function reference', () => {
    const fn = makeRawHandler();
    const handler = createHandler(['MyProvider', 'agent'], fn as any);
    expect(handler).toBe(fn);
  });

  it('handler is still callable and returns expected output', async () => {
    const fn = makeRawHandler();
    const handler = createHandler(['MyProvider', 'agent'], fn as any);
    const config = { model: { name: 'gpt-4' }, provider: { name: 'MyProvider' }, instructions: 'hi' };
    const result = await handler(config as any, 'hello');
    expect(result).toEqual({ output: 'hello', usage: { input_tokens: 1, output_tokens: 2 } });
  });

  it("works with 'agent' mode", () => {
    const fn = makeRawHandler();
    const handler = createHandler(['ProviderX', 'agent'], fn as any);
    expect(handler.providesFor?.[1]).toBe('agent');
  });

  it("works with 'messages' mode", () => {
    const fn = makeRawHandler();
    const handler = createHandler(['ProviderX', 'messages'], fn as any);
    expect(handler.providesFor?.[1]).toBe('messages');
  });
});

// ─── normalizeMode ────────────────────────────────────────────────────────────

describe('normalizeMode', () => {
  it("maps 'agent' to 'agent'", () => {
    expect(normalizeMode('agent')).toBe('agent');
  });

  it("maps 'completion' to 'messages'", () => {
    expect(normalizeMode('completion')).toBe('messages');
  });

  it("maps 'judge' to 'messages'", () => {
    expect(normalizeMode('judge')).toBe('messages');
  });

  it('maps undefined to messages', () => {
    expect(normalizeMode(undefined)).toBe('messages');
  });

  it('maps any unrecognized string to messages', () => {
    expect(normalizeMode('something-else')).toBe('messages');
  });
});

// ─── setLdSpanAttributes ──────────────────────────────────────────────────────

function makeMockSpan() {
  return {
    setAttribute: vi.fn(),
    addEvent: vi.fn(),
  };
}

const ldFixture = {
  configKey: 'test-config',
  variationKey: 'variation-a',
  runId: 'run-123',
  version: 1,
  modelName: 'test-model',
  providerName: 'TestProvider',
};

describe('setLdSpanAttributes', () => {
  it('always sets launchdarkly.operation.type to gen_ai', () => {
    const span = makeMockSpan();
    setLdSpanAttributes(span as any, undefined);
    expect(span.setAttribute).toHaveBeenCalledWith('launchdarkly.operation.type', 'gen_ai');
  });

  it('sets nothing else when variables is undefined', () => {
    const span = makeMockSpan();
    setLdSpanAttributes(span as any, undefined);
    expect(span.setAttribute).toHaveBeenCalledTimes(1);
  });

  it('sets nothing else when __ld is absent from variables', () => {
    const span = makeMockSpan();
    setLdSpanAttributes(span as any, { someOtherKey: 'value' });
    expect(span.setAttribute).toHaveBeenCalledTimes(1);
  });

  it('sets launchdarkly.config.key from __ld.configKey', () => {
    const span = makeMockSpan();
    setLdSpanAttributes(span as any, { __ld: ldFixture });
    expect(span.setAttribute).toHaveBeenCalledWith('launchdarkly.config.key', 'test-config');
  });

  it('sets launchdarkly.variation.key from __ld.variationKey', () => {
    const span = makeMockSpan();
    setLdSpanAttributes(span as any, { __ld: ldFixture });
    expect(span.setAttribute).toHaveBeenCalledWith('launchdarkly.variation.key', 'variation-a');
  });

  it('sets launchdarkly.run.id from __ld.runId', () => {
    const span = makeMockSpan();
    setLdSpanAttributes(span as any, { __ld: ldFixture });
    expect(span.setAttribute).toHaveBeenCalledWith('launchdarkly.run.id', 'run-123');
  });

  it('does not set launchdarkly.graph.key when graphKey is absent', () => {
    const span = makeMockSpan();
    setLdSpanAttributes(span as any, { __ld: ldFixture });
    const graphKeyCalls = span.setAttribute.mock.calls.filter((c: any[]) => c[0] === 'launchdarkly.graph.key');
    expect(graphKeyCalls).toHaveLength(0);
  });

  it('sets launchdarkly.graph.key when graphKey is present', () => {
    const span = makeMockSpan();
    setLdSpanAttributes(span as any, { __ld: { ...ldFixture, graphKey: 'my-graph' } });
    expect(span.setAttribute).toHaveBeenCalledWith('launchdarkly.graph.key', 'my-graph');
  });

  it('emits a feature_flag span event with feature_flag.key and feature_flag.provider.name', () => {
    const span = makeMockSpan();
    setLdSpanAttributes(span as any, { __ld: ldFixture });
    expect(span.addEvent).toHaveBeenCalledWith(
      'feature_flag',
      expect.objectContaining({
        'feature_flag.key': 'test-config',
        'feature_flag.provider.name': 'LaunchDarkly',
      }),
    );
  });

  it('includes feature_flag.set.id in the event when environmentId is present', () => {
    const span = makeMockSpan();
    setLdSpanAttributes(span as any, { __ld: { ...ldFixture, environmentId: 'env-abc' } });
    expect(span.addEvent).toHaveBeenCalledWith(
      'feature_flag',
      expect.objectContaining({ 'feature_flag.set.id': 'env-abc' }),
    );
  });

  it('omits feature_flag.set.id from the event when environmentId is absent', () => {
    const span = makeMockSpan();
    setLdSpanAttributes(span as any, { __ld: ldFixture });
    const eventCall = span.addEvent.mock.calls.find((c: any[]) => c[0] === 'feature_flag');
    expect(eventCall?.[1]).not.toHaveProperty('feature_flag.set.id');
  });
});

// ─── numberOrZero ─────────────────────────────────────────────────────────────

describe('numberOrZero', () => {
  it('passes finite numbers through', () => {
    expect(numberOrZero(42)).toBe(42);
    expect(numberOrZero(0)).toBe(0);
  });

  it('coerces numeric strings', () => {
    expect(numberOrZero('17')).toBe(17);
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a non-numeric string', 'lots'],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['an object', {}],
  ])('maps %s to 0', (_label, value) => {
    expect(numberOrZero(value)).toBe(0);
  });
});

// ─── setUsageSpanAttributes ───────────────────────────────────────────────────

const USAGE_ATTRS = [
  'gen_ai.usage.input_tokens',
  'gen_ai.usage.output_tokens',
  'gen_ai.usage.total_tokens',
  'gen_ai.usage.cache_read.input_tokens',
  'gen_ai.usage.cache_creation.input_tokens',
  // OpenLLMetry aliases for input/output. Written by the same function on purpose: computed at a
  // call site instead, they disagreed with the canonical pair on Anthropic, whose `input_tokens`
  // excludes cached tokens — and Gonfalon prefers the alias.
  'gen_ai.usage.prompt_tokens',
  'gen_ai.usage.completion_tokens',
] as const;

/** Reads the attributes a mock span received back as a plain object. */
function attrsOf(span: ReturnType<typeof makeMockSpan>): Record<string, unknown> {
  return Object.fromEntries(span.setAttribute.mock.calls.map((c: unknown[]) => [c[0], c[1]]));
}

describe('setUsageSpanAttributes', () => {
  it('always writes every usage attribute, aliases included', () => {
    const span = makeMockSpan();
    setUsageSpanAttributes(span as any, { input: 10, output: 5, cacheRead: 3, cacheCreation: 2 });
    expect(Object.keys(attrsOf(span)).sort()).toEqual([...USAGE_ATTRS].sort());
  });

  it('writes explicit zeros rather than omitting attributes', () => {
    // An absent attribute drops the span from any query grouping on the full set,
    // which is not the same as reporting no cached tokens.
    const span = makeMockSpan();
    setUsageSpanAttributes(span as any, { input: 8, output: 4, cacheRead: 0, cacheCreation: 0 });
    expect(attrsOf(span)).toEqual({
      'gen_ai.usage.input_tokens': 8,
      'gen_ai.usage.output_tokens': 4,
      'gen_ai.usage.total_tokens': 12,
      'gen_ai.usage.cache_read.input_tokens': 0,
      'gen_ai.usage.cache_creation.input_tokens': 0,
      'gen_ai.usage.prompt_tokens': 8,
      'gen_ai.usage.completion_tokens': 4,
    });
  });

  it('derives total from input + output', () => {
    const span = makeMockSpan();
    setUsageSpanAttributes(span as any, { input: 100, output: 25, cacheRead: 60, cacheCreation: 10 });
    expect(attrsOf(span)['gen_ai.usage.total_tokens']).toBe(125);
  });

  it('treats input as inclusive of cache tokens and does not re-add them', () => {
    // Callers apply their own provider's cache accounting before calling in; the
    // emitter must not fold cache tokens a second time.
    const span = makeMockSpan();
    setUsageSpanAttributes(span as any, { input: 20, output: 5, cacheRead: 7, cacheCreation: 3 });
    const attrs = attrsOf(span);
    expect(attrs['gen_ai.usage.input_tokens']).toBe(20);
    expect(attrs['gen_ai.usage.total_tokens']).toBe(25);
  });

  it('coerces non-finite counts to 0 so total never becomes NaN', () => {
    // A NaN total is worse than a zero one: trackTokens guards on `total > 0`,
    // so the metric is dropped silently instead of reported.
    const span = makeMockSpan();
    setUsageSpanAttributes(span as any, {
      input: undefined as unknown as number,
      output: Number.NaN,
      cacheRead: 'x' as unknown as number,
      cacheCreation: null as unknown as number,
    });
    expect(attrsOf(span)).toEqual({
      'gen_ai.usage.input_tokens': 0,
      'gen_ai.usage.output_tokens': 0,
      'gen_ai.usage.total_tokens': 0,
      'gen_ai.usage.cache_read.input_tokens': 0,
      'gen_ai.usage.cache_creation.input_tokens': 0,
      'gen_ai.usage.prompt_tokens': 0,
      'gen_ai.usage.completion_tokens': 0,
    });
  });
});
