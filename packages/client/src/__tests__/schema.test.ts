import { describe, expect, it } from 'vitest';
import { GraphTopologySchema, parseAiConfig } from '../types.js';

const base = {
  model: { name: 'gpt-4o' },
  provider: { name: 'OpenAI' },
};

describe('parseAiConfig', () => {
  it('accepts a valid config with instructions', () => {
    const result = parseAiConfig({ ...base, instructions: 'You are helpful.' });
    expect(result.success).toBe(true);
  });

  it('accepts a valid config with a non-empty messages array', () => {
    const result = parseAiConfig({
      ...base,
      messages: [{ role: 'user', content: 'Hello' }],
    });
    expect(result.success).toBe(true);
  });

  it('rejects a config with neither instructions nor messages', () => {
    const result = parseAiConfig({ ...base });
    expect(result.success).toBe(false);
  });

  it('rejects a config with an empty messages array and no instructions', () => {
    const result = parseAiConfig({ ...base, messages: [] });
    expect(result.success).toBe(false);
  });

  it('rejects a message with an invalid role', () => {
    const result = parseAiConfig({
      ...base,
      messages: [{ role: 'admin', content: 'Hey' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects when model.name is missing', () => {
    const result = parseAiConfig({
      model: {},
      provider: { name: 'OpenAI' },
      instructions: 'hi',
    });
    expect(result.success).toBe(false);
  });

  it('rejects when provider is missing entirely', () => {
    const result = parseAiConfig({
      model: { name: 'gpt-4o' },
      instructions: 'hi',
    });
    expect(result.success).toBe(false);
  });

  it('accepts optional fields when populated with valid values', () => {
    const result = parseAiConfig({
      ...base,
      instructions: 'You are helpful.',
      evaluationMetricKey: 'my-metric',
      judgeConfiguration: { judges: [{ key: 'judge-flag', samplingRate: 0.5 }] },
      tools: {
        search: {
          name: 'search',
          type: 'function',
          parameters: { type: 'object', properties: {} },
          description: 'Search the web',
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects a tool entry with wrong type value', () => {
    const result = parseAiConfig({
      ...base,
      instructions: 'hi',
      tools: {
        bad: {
          name: 'bad',
          type: 'class',
          parameters: {},
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it('accepts an outputFormat field when present', () => {
    const result = parseAiConfig({
      ...base,
      instructions: 'Be helpful.',
      outputFormat: { type: 'object', properties: { name: { type: 'string' } } },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as any).outputFormat).toEqual({ type: 'object', properties: { name: { type: 'string' } } });
    }
  });

  it('accepts model with optional region and parameters', () => {
    const result = parseAiConfig({
      ...base,
      instructions: 'hi',
      model: { name: 'claude-3', region: 'us-east-1', parameters: { max_tokens: 512 } },
    });
    expect(result.success).toBe(true);
  });

  it('accepts all three valid message roles', () => {
    const result = parseAiConfig({
      ...base,
      messages: [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi!' },
      ],
    });
    expect(result.success).toBe(true);
  });

  // ── `skills` array validation ──────────────────────────────────────────────
  //
  // Fail closed: a malformed reference makes the whole config malformed, because
  // an SDK that silently dropped a bad reference would materialize a partial
  // skill set without telling anyone.

  describe('skills', () => {
    const valid = { ...base, instructions: 'You are helpful.' };

    it('accepts a config with no skills field (backward compatibility)', () => {
      expect(parseAiConfig(valid).success).toBe(true);
    });

    it('accepts an empty skills array', () => {
      expect(parseAiConfig({ ...valid, skills: [] }).success).toBe(true);
    });

    it('accepts valid entries and round-trips them unmodified', () => {
      const skills = [
        { key: 'pdf-extraction', version: 2 },
        { key: 'a1', version: 1 },
      ];
      const result = parseAiConfig({ ...valid, skills });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.skills).toEqual(skills);
    });

    it.each([
      ['a string', 'pdf-extraction'],
      ['an object', { key: 'pdf-extraction', version: 1 }],
      ['a number', 3],
      ['null', null],
    ])('rejects a non-array skills value: %s', (_label, skills) => {
      expect(parseAiConfig({ ...valid, skills }).success).toBe(false);
    });

    it.each([
      ['a bare string entry', ['pdf-extraction']],
      ['a null entry', [null]],
      ['a nested array entry', [['pdf-extraction', 1]]],
    ])('rejects a non-object entry: %s', (_label, skills) => {
      expect(parseAiConfig({ ...valid, skills }).success).toBe(false);
    });

    it.each([
      ['key absent', { version: 1 }],
      ['key is a number', { key: 7, version: 1 }],
      ['key is null', { key: null, version: 1 }],
    ])('rejects a missing or non-string key: %s', (_label, entry) => {
      expect(parseAiConfig({ ...valid, skills: [entry] }).success).toBe(false);
    });

    it.each([
      ['uppercase', 'Evil'],
      ['leading dash', '-skill'],
      ['leading dot', '.hidden'],
      ['path separator', 'a/b'],
      ['backslash', 'a\\b'],
      ['traversal', '../evil'],
      ['empty string', ''],
      ['embedded space', 'has space'],
      ['underscore', 'has_underscore'],
      ['trailing newline', 'pdf-extraction\n'],
    ])('rejects a key violating the pattern: %s', (_label, key) => {
      expect(parseAiConfig({ ...valid, skills: [{ key, version: 1 }] }).success).toBe(false);
    });

    it('accepts a key of exactly 256 characters', () => {
      // The accepting side of the <= 256 bound. It
      // is only observable at the pure layers: a key becomes one directory name
      // and NAME_MAX is 255, so `writeSkills` can never reach it.
      const key = 'a'.repeat(256);
      expect(parseAiConfig({ ...valid, skills: [{ key, version: 1 }] }).success).toBe(true);
    });

    it('rejects a key of 257 characters', () => {
      const key = 'a'.repeat(257);
      expect(parseAiConfig({ ...valid, skills: [{ key, version: 1 }] }).success).toBe(false);
    });

    it.each([
      ['version absent', {}],
      ['version 0', { version: 0 }],
      ['version negative', { version: -1 }],
      ['version non-integer', { version: 2.5 }],
      ['version as string', { version: '2' }],
      // A boolean is not an acceptable integer even in languages where it is
      // integer-like — the rule is identical across both implementations.
      ['version as boolean', { version: true }],
      ['version null', { version: null }],
      ['version NaN', { version: Number.NaN }],
      ['version Infinity', { version: Number.POSITIVE_INFINITY }],
    ])('rejects a missing or invalid version: %s', (_label, overrides) => {
      const entry = { key: 'pdf-extraction', ...overrides };
      expect(parseAiConfig({ ...valid, skills: [entry] }).success).toBe(false);
    });

    it('accepts version 1 as the lower bound', () => {
      expect(parseAiConfig({ ...valid, skills: [{ key: 'a', version: 1 }] }).success).toBe(true);
    });

    it('names the skills field in the failure message', () => {
      const result = parseAiConfig({ ...valid, skills: [{ key: 'Evil', version: 1 }] });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.message).toContain('skills');
    });

    it('fails the whole config when a single entry among several is invalid', () => {
      const result = parseAiConfig({
        ...valid,
        skills: [
          { key: 'good-one', version: 1 },
          { key: 'BAD', version: 1 },
          { key: 'good-two', version: 2 },
        ],
      });
      expect(result.success).toBe(false);
    });
  });
});

describe('GraphTopologySchema', () => {
  // ── safeParse ──────────────────────────────────────────────────────────────

  it('accepts a valid topology with root only', () => {
    const result = GraphTopologySchema.safeParse({ root: 'agent-a' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.root).toBe('agent-a');
  });

  it('accepts a valid topology with root and edges', () => {
    const result = GraphTopologySchema.safeParse({
      root: 'agent-a',
      edges: { 'agent-a': [{ key: 'agent-b' }] },
    });
    expect(result.success).toBe(true);
  });

  it('accepts edges entries with optional handoff data', () => {
    const result = GraphTopologySchema.safeParse({
      root: 'root',
      edges: { root: [{ key: 'next', handoff: { reason: 'done' } }] },
    });
    expect(result.success).toBe(true);
  });

  it('rejects when root is missing', () => {
    const result = GraphTopologySchema.safeParse({ edges: {} });
    expect(result.success).toBe(false);
  });

  it('rejects when root is not a string', () => {
    const result = GraphTopologySchema.safeParse({ root: 42, edges: {} });
    expect(result.success).toBe(false);
  });

  it('rejects a non-object input (array)', () => {
    const result = GraphTopologySchema.safeParse(['agent-a']);
    expect(result.success).toBe(false);
  });

  it('rejects null', () => {
    const result = GraphTopologySchema.safeParse(null);
    expect(result.success).toBe(false);
  });

  it('rejects a plain string', () => {
    const result = GraphTopologySchema.safeParse('agent-a');
    expect(result.success).toBe(false);
  });

  // ── parse (throws on invalid) ──────────────────────────────────────────────

  it('parse returns data for a valid topology', () => {
    const data = GraphTopologySchema.parse({ root: 'r' });
    expect(data.root).toBe('r');
  });

  it('parse throws for a topology missing root', () => {
    expect(() => GraphTopologySchema.parse({})).toThrow();
  });
});
