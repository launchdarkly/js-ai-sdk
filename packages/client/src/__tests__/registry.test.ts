import { describe, expect, it, vi } from 'vitest';
import { compose, Registry, resolveHandlers, resolveTools } from '../registry.js';
import type { ProviderHandler } from '../types.js';

// ─── helpers ──────────────────────────────────────────────────────────────────

const makeHandler = (provider: string, mode: 'agent' | 'messages'): ProviderHandler => {
  const h: ProviderHandler = async () => ({ output: 'ok' });
  h.providesFor = [provider, mode];
  return h;
};

const noopFn = () => 'result';

// ─── Registry constructor and register ────────────────────────────────────────

describe('Registry', () => {
  it('starts empty', () => {
    const r = new Registry();
    expect(r.handlers).toHaveLength(0);
    expect(Object.keys(r.tools)).toHaveLength(0);
  });

  it('accepts initial config in constructor', () => {
    const h = makeHandler('OpenAI', 'messages');
    const r = new Registry({ handlers: [h], tools: { search: noopFn } });
    expect(r.handlers).toHaveLength(1);
    expect(r.tools.search).toBe(noopFn);
  });

  it('appends a handler with a new providesFor key', () => {
    const r = new Registry();
    r.register({ handlers: [makeHandler('OpenAI', 'messages')] });
    expect(r.handlers).toHaveLength(1);
  });

  it('warns and replaces on duplicate providesFor key', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = new Registry();
    const h1 = makeHandler('OpenAI', 'messages');
    const h2 = makeHandler('OpenAI', 'messages');
    r.register({ handlers: [h1] });
    r.register({ handlers: [h2] });
    expect(warn).toHaveBeenCalledOnce();
    expect(r.handlers).toHaveLength(1);
    expect(r.handlers[0]).toBe(h2);
    warn.mockRestore();
  });

  it('always appends handlers without providesFor (no dedup)', () => {
    const r = new Registry();
    const h: ProviderHandler = async () => ({ output: '' });
    r.register({ handlers: [h] });
    r.register({ handlers: [h] });
    expect(r.handlers).toHaveLength(2);
  });

  it('appends a new tool key', () => {
    const r = new Registry();
    r.register({ tools: { myTool: noopFn } });
    expect(r.tools.myTool).toBe(noopFn);
  });

  it('warns and replaces on duplicate tool key', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = new Registry();
    const fn2 = () => 'v2';
    r.register({ tools: { t: noopFn } });
    r.register({ tools: { t: fn2 } });
    expect(warn).toHaveBeenCalledOnce();
    expect(r.tools.t).toBe(fn2);
    warn.mockRestore();
  });

  it('is additive across multiple register calls', () => {
    const r = new Registry();
    r.register({ handlers: [makeHandler('OpenAI', 'messages')] });
    r.register({ handlers: [makeHandler('Anthropic', 'agent')] });
    expect(r.handlers).toHaveLength(2);
  });
});

// ─── compose ──────────────────────────────────────────────────────────────────

describe('compose', () => {
  it('returns a new registry (does not mutate inputs)', () => {
    const a = new Registry({ handlers: [makeHandler('OpenAI', 'messages')] });
    const b = new Registry({ handlers: [makeHandler('Anthropic', 'agent')] });
    const c = compose(a, b);
    expect(c).not.toBe(a);
    expect(c).not.toBe(b);
    expect(a.handlers).toHaveLength(1);
    expect(b.handlers).toHaveLength(1);
  });

  it('b handler wins over a on the same providesFor key', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const hA = makeHandler('OpenAI', 'messages');
    const hB = makeHandler('OpenAI', 'messages');
    const a = new Registry({ handlers: [hA] });
    const b = new Registry({ handlers: [hB] });
    const c = compose(a, b);
    expect(c.handlers).toHaveLength(1);
    expect(c.handlers[0]).toBe(hB);
    warn.mockRestore();
  });

  it('b tool wins over a on the same tool key', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fnA = () => 'a';
    const fnB = () => 'b';
    const a = new Registry({ tools: { t: fnA } });
    const b = new Registry({ tools: { t: fnB } });
    const c = compose(a, b);
    expect(c.tools.t).toBe(fnB);
    warn.mockRestore();
  });

  it('merges non-conflicting entries from both registries', () => {
    const hA = makeHandler('OpenAI', 'messages');
    const hB = makeHandler('Anthropic', 'agent');
    const a = new Registry({ handlers: [hA], tools: { toolA: noopFn } });
    const b = new Registry({ handlers: [hB], tools: { toolB: noopFn } });
    const c = compose(a, b);
    expect(c.handlers).toHaveLength(2);
    expect(c.tools.toolA).toBe(noopFn);
    expect(c.tools.toolB).toBe(noopFn);
  });
});

// ─── resolveHandlers ──────────────────────────────────────────────────────────

describe('resolveHandlers', () => {
  it('returns localHandlers when no registry', () => {
    const local = [makeHandler('OpenAI', 'messages')];
    expect(resolveHandlers(undefined, local)).toBe(local);
  });

  it('returns registry handlers when no local handlers', () => {
    const h = makeHandler('OpenAI', 'messages');
    const r = new Registry({ handlers: [h] });
    expect(resolveHandlers(r, undefined)).toEqual([h]);
  });

  it('prepends local handlers before registry handlers when both present', () => {
    const local = [makeHandler('Anthropic', 'agent')];
    const regHandler = makeHandler('OpenAI', 'messages');
    const r = new Registry({ handlers: [regHandler] });
    const result = resolveHandlers(r, local)!;
    expect(result[0]).toBe(local[0]);
    expect(result[1]).toBe(regHandler);
  });

  it('returns undefined when registry is empty and no local handlers', () => {
    expect(resolveHandlers(new Registry(), undefined)).toBeUndefined();
  });
});

// ─── resolveTools ─────────────────────────────────────────────────────────────

describe('resolveTools', () => {
  it('returns localTools when no registry', () => {
    const local = { t: noopFn };
    expect(resolveTools(undefined, local)).toBe(local);
  });

  it('returns registry tools when no local tools', () => {
    const r = new Registry({ tools: { t: noopFn } });
    expect(resolveTools(r, undefined)).toEqual({ t: noopFn });
  });

  it('local tools override registry tools on conflict', () => {
    const localFn = () => 'local';
    const registryFn = () => 'registry';
    const r = new Registry({ tools: { t: registryFn } });
    const result = resolveTools(r, { t: localFn })!;
    expect(result.t).toBe(localFn);
  });

  it('merges non-conflicting tools from both', () => {
    const r = new Registry({ tools: { fromRegistry: noopFn } });
    const result = resolveTools(r, { fromLocal: noopFn })!;
    expect(result.fromRegistry).toBe(noopFn);
    expect(result.fromLocal).toBe(noopFn);
  });

  it('returns undefined when registry is empty and no local tools', () => {
    expect(resolveTools(new Registry(), undefined)).toBeUndefined();
  });
});
