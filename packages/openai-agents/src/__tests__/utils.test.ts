import { describe, expect, it } from 'vitest';
import { buildOutputType } from '../utils.js';

describe('buildOutputType', () => {
  it('returns undefined when outputFormat is undefined', () => {
    expect(buildOutputType(undefined)).toBeUndefined();
  });

  it('returns undefined when outputFormat is an empty object', () => {
    expect(buildOutputType({})).toBeUndefined();
  });

  it('wraps the schema in a JsonSchemaDefinition envelope', () => {
    const fmt = { properties: { score: { type: 'number' } }, additionalProperties: false };
    const result = buildOutputType(fmt);
    expect(result).toMatchObject({
      type: 'json_schema',
      name: 'output',
      strict: false,
      schema: expect.objectContaining({ properties: fmt.properties }),
    });
  });

  it('ensures type: "object" is present in the schema when absent from outputFormat', () => {
    const fmt = { properties: { name: { type: 'string' } } };
    const result = buildOutputType(fmt);
    expect(result?.schema.type).toBe('object');
  });

  it('preserves type: "object" when already present in outputFormat', () => {
    const fmt = {
      type: 'object' as const,
      properties: { name: { type: 'string' } },
      additionalProperties: false as const,
    };
    const result = buildOutputType(fmt);
    expect(result?.schema.type).toBe('object');
  });

  it('overrides an incorrect type from outputFormat with "object"', () => {
    // LD AI config variations may have "type": "json_schema" at the outputFormat root
    // (the wrapper type leaking into the content). type: 'object' must always win.
    const fmt = { type: 'json_schema', properties: { name: { type: 'string' } } };
    const result = buildOutputType(fmt as any);
    expect(result?.schema.type).toBe('object');
  });

  it('sets name to "output" and strict to false', () => {
    const result = buildOutputType({ properties: {} });
    expect(result?.name).toBe('output');
    expect(result?.strict).toBe(false);
  });

  it('sets type to "json_schema"', () => {
    const result = buildOutputType({ properties: {} });
    expect(result?.type).toBe('json_schema');
  });

  // ── required auto-population ────────────────────────────────────────────────

  it('auto-populates required with all property keys when required is absent', () => {
    const fmt = { properties: { score: { type: 'number' }, label: { type: 'string' } } };
    const result = buildOutputType(fmt);
    expect(result?.schema.required).toEqual(expect.arrayContaining(['score', 'label']));
    expect((result?.schema.required as string[]).length).toBe(2);
  });

  it('auto-populates required with all property keys when required is empty', () => {
    const fmt = {
      properties: { documentation_uris: { type: 'array', items: { type: 'string' } }, response: { type: 'string' } },
      additionalProperties: false,
      required: [] as string[],
    };
    const result = buildOutputType(fmt);
    expect(result?.schema.required).toEqual(expect.arrayContaining(['documentation_uris', 'response']));
    expect((result?.schema.required as string[]).length).toBe(2);
  });

  it('overwrites a partial required list to include all property keys', () => {
    const fmt = { properties: { a: { type: 'string' }, b: { type: 'string' } }, required: ['a'] };
    const result = buildOutputType(fmt);
    expect(result?.schema.required).toEqual(expect.arrayContaining(['a', 'b']));
  });

  it('leaves required undefined when properties is absent', () => {
    const fmt = { type: 'object' as const, additionalProperties: false as const };
    const result = buildOutputType(fmt);
    expect(result?.schema.required).toBeUndefined();
  });

  it('omits required when properties is an empty object', () => {
    const result = buildOutputType({ properties: {} });
    expect(result).toBeDefined();
    expect(result?.schema).not.toHaveProperty('required');
  });
});
