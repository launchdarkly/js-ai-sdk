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
