/**
 * Skill tools: the optional `tools` array on a skill envelope, `Skill.tools`, and
 * how a variation's skills add their tools to the `config.tools` a handler is
 * offered. Envelopes are hand-built until the server ships them.
 */

import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@opentelemetry/sdk-trace-node', () => ({
  NodeTracerProvider: class {
    shutdown = vi.fn().mockResolvedValue(undefined);
  },
}));
vi.mock('@opentelemetry/sdk-trace-base', () => ({ BatchSpanProcessor: class {} }));
vi.mock('@opentelemetry/exporter-trace-otlp-http', () => ({ OTLPTraceExporter: class {} }));
vi.mock('@opentelemetry/otlp-exporter-base', () => ({ CompressionAlgorithm: { GZIP: 'gzip' } }));
vi.mock('@opentelemetry/resources', () => ({ resourceFromAttributes: () => ({}) }));
vi.mock('dotenv/config', () => ({}));

import { config } from '../client.js';
import { resolveGraph } from '../graph.js';
import { runJudges } from '../judges.js';
import { extractVariation, initClient, inspectConfig, parseVariation, shutdown } from '../lifecycle.js';
import {
  _clearState,
  _setEmitterForTesting,
  _setStore,
  allSkills,
  getSkill,
  getSkillResult,
  getSkills,
  InMemorySkillStore,
} from '../skills.js';
import { verifyRawSkill } from '../skills-core.js';
import { writeSkills } from '../skills-fs.js';
import { withSkillTools } from '../skills-tools.js';
import type { AiConfigRep, LDClientInterface, RawSkillObject, Tool } from '../types.js';
import { createSkill, NATIVE_TOOL_KEY, NativeTool } from '../types.js';
import { createHandler } from '../utils.js';

const BODY = '---\nname: PDF\n---\nExtract the text.\n';
const hash = (s: string) => createHash('sha256').update(Buffer.from(s, 'utf-8')).digest('hex');

function tool(name: string, description = `${name} tool`): Tool {
  return {
    type: 'function',
    name,
    description,
    parameters: { type: 'object', properties: { q: { type: 'string' } } },
    customParameters: { owner: 'skills' },
  };
}

/** A hand-built FDv2 skill envelope, as AIC-3790 serves it. */
function envelope(key: string, version: number, tools?: unknown): RawSkillObject {
  const raw: RawSkillObject = { key, version, content: BODY, contentHash: hash(BODY), name: key, description: 'd' };
  if (tools !== undefined) raw.tools = tools;
  return raw;
}

function baseConfig(overrides: Partial<AiConfigRep> = {}): AiConfigRep {
  return {
    model: { name: 'gpt-4o' },
    provider: { name: 'OpenAI' },
    instructions: 'Be helpful.',
    ...overrides,
  };
}

let errors: ReturnType<typeof vi.spyOn>;
let warnings: ReturnType<typeof vi.spyOn>;
let signals: string[];

beforeEach(() => {
  _clearState();
  signals = [];
  _setEmitterForTesting({ record: (signal) => signals.push(signal) });
  errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  warnings = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  _clearState();
  vi.restoreAllMocks();
});

const warned = () => warnings.mock.calls.map((args: unknown[]) => String(args[0]));

describe('verifyRawSkill reads tools', () => {
  it('returns the tools in envelope order', () => {
    const skill = verifyRawSkill(envelope('pdf', 3, [tool('b'), tool('a'), tool('c')]));
    expect(skill?.tools.map((t) => t.name)).toEqual(['b', 'a', 'c']);
    expect(skill?.tools[0]).toEqual(tool('b'));
  });

  it('returns an empty list when the envelope has no tools', () => {
    const skill = verifyRawSkill(envelope('pdf', 3));
    expect(skill?.tools).toEqual([]);
    expect(warnings).not.toHaveBeenCalled();
  });

  it('makes the list and each definition immutable, and does not share the envelope objects', () => {
    const delivered = tool('a');
    const skill = verifyRawSkill(envelope('pdf', 3, [delivered]));
    const tools = skill?.tools as Tool[];
    expect(Object.isFrozen(tools)).toBe(true);
    expect(Object.isFrozen(tools[0])).toBe(true);
    expect(Object.isFrozen(tools[0].parameters)).toBe(true);
    expect(() => tools.push(tool('b'))).toThrow(TypeError);
    delivered.name = 'changed';
    expect(tools[0].name).toBe('a');
  });

  it.each([
    ['an object', { a: tool('a') }],
    ['a string', 'get-weather'],
    ['a number', 7],
    ['null', null],
  ])('drops a tools field that is %s with a warning, and still returns the skill', (_label, tools) => {
    const skill = verifyRawSkill(envelope('pdf', 3, tools));
    expect(skill?.key).toBe('pdf');
    expect(skill?.tools).toEqual([]);
    expect(warned()).toEqual([expect.stringMatching(/tools field of skill 'pdf' version 3 is not an array/)]);
    expect(errors).not.toHaveBeenCalled();
    expect(signals).toEqual([]);
  });

  it.each([
    ['has no name', { type: 'function', parameters: {} }, /tools\[1\]/],
    ['has a non-string name', { type: 'function', name: 7, parameters: {} }, /tools\[1\]/],
    ['has no parameters', { type: 'function', name: 'bad' }, /"bad"/],
    ['has array parameters', { type: 'function', name: 'bad', parameters: [] }, /"bad"/],
    ['is not an object', 'bad', /tools\[1\]/],
    ['is not a function tool', { type: 'web_search', name: 'bad', parameters: {} }, /"bad".*type must be "function"/],
  ])('drops only an entry that %s, with a warning naming the skill and the tool', (_label, bad, names) => {
    const skill = verifyRawSkill(envelope('pdf', 3, [tool('a'), bad, tool('c')]));
    expect(skill?.tools.map((t) => t.name)).toEqual(['a', 'c']);
    const messages = warned();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/skill 'pdf' version 3/);
    expect(messages[0]).toMatch(names);
    expect(errors).not.toHaveBeenCalled();
    expect(signals).toEqual([]);
  });

  it('drops a second entry with the same name, keeping the first', () => {
    const skill = verifyRawSkill(envelope('pdf', 3, [tool('a', 'first'), tool('b'), tool('a', 'second')]));
    expect(skill?.tools.map((t) => [t.name, t.description])).toEqual([
      ['a', 'first'],
      ['b', 'b tool'],
    ]);
    expect(warned()).toEqual([
      expect.stringMatching(/Tool tools\[2\] "a" of skill 'pdf' version 3 was dropped: an earlier entry/),
    ]);
  });

  it.each([
    ['a newline', 'bad\nname'],
    ['257 characters', 'x'.repeat(257)],
  ])('names a tool whose name has %s by position only', (_label, name) => {
    verifyRawSkill(envelope('pdf', 3, [tool('a'), { type: 'function', name }]));
    expect(warned()).toEqual([
      expect.stringMatching(/^\[LaunchDarkly\] Tool tools\[1\] of skill 'pdf' version 3 was dropped/),
    ]);
  });

  it('does not quote an unsafe name in a conflict warning', () => {
    const name = 'we\nather';
    _setStore(new InMemorySkillStore({ a: envelope('a', 1, [tool(name, 'skill')]) }));
    withSkillTools(baseConfig({ tools: { [name]: tool(name, 'variation') }, skills: [{ key: 'a', version: 1 }] }), 'c');
    expect(warned()).toEqual([expect.stringMatching(/tool with a name that cannot be shown/)]);
    expect(warned()[0]).not.toContain('\n');
  });

  it('never puts parameters or description in a drop warning', () => {
    verifyRawSkill(
      envelope('pdf', 3, [{ type: 'function', name: 'bad', description: 'SECRET-D', parameters: 'SECRET-P' }]),
    );
    expect(warned().join('\n')).not.toMatch(/SECRET/);
  });

  it('every accessor carries the same tools, and each call returns fresh copies', async () => {
    _setStore(new InMemorySkillStore({ pdf: envelope('pdf', 3, [tool('a')]) }));
    const one = await getSkill('pdf');
    const two = await getSkill('pdf');
    expect(two?.tools).toEqual([tool('a')]);
    expect(two?.tools[0]).not.toBe(one?.tools[0]);
    expect((await getSkillResult('pdf')).skill?.tools).toEqual([tool('a')]);
    expect((await getSkills([{ key: 'pdf', version: 3 }]))[0].tools).toEqual([tool('a')]);
    expect((await allSkills())[0].tools).toEqual([tool('a')]);
  });

  it('drops a tool whose parameters are cyclic, with a warning, and still returns the skill', async () => {
    const cyclic = tool('loop');
    (cyclic.parameters as Record<string, unknown>).self = cyclic.parameters;
    _setStore(new InMemorySkillStore({ pdf: envelope('pdf', 3, [tool('a'), cyclic]) }));
    const skill = await getSkill('pdf');
    expect(skill?.tools.map((t) => t.name)).toEqual(['a']);
    expect(warned()).toEqual([expect.stringMatching(/Tool tools\[1\] "loop" of skill 'pdf' version 3 was dropped/)]);
  });

  it('keeps a definition that reaches one object twice without a cycle', () => {
    const shared = { type: 'string' };
    const entry = { ...tool('dag'), parameters: { type: 'object', properties: { a: shared, b: shared } } };
    const skill = verifyRawSkill(envelope('pdf', 3, [entry]));
    expect(skill?.tools.map((t) => t.name)).toEqual(['dag']);
    expect(warnings).not.toHaveBeenCalled();
  });

  it('warns through a state slot an older copy of the package created without the warned set', () => {
    const key = Symbol.for('@launchdarkly/ai-server:skills');
    const g = globalThis as Record<symbol, unknown>;
    const original = g[key];
    g[key] = { store: null, emitter: null };
    try {
      expect(() => verifyRawSkill(envelope('pdf', 3, 'not-a-list'))).not.toThrow();
      expect(warned()).toEqual([expect.stringMatching(/tools field of skill 'pdf' version 3 is not an array/)]);
    } finally {
      g[key] = original;
    }
  });

  it('a changed tool still verifies, because contentHash covers the markdown only (known limit)', async () => {
    const raw = envelope('pdf', 3, [tool('a', 'original')]);
    _setStore(new InMemorySkillStore({ pdf: raw }));
    (raw.tools as Tool[])[0].description = 'changed';
    const outcome = await getSkillResult('pdf');
    expect(outcome.reason).toBe('ok');
    expect(outcome.skill?.tools[0].description).toBe('changed');
  });

  it('two objects with the same content and different tools have the same contentHash', () => {
    const one = verifyRawSkill(envelope('pdf', 3, [tool('a')]));
    const two = verifyRawSkill(envelope('pdf', 3, [tool('b')]));
    expect(one?.contentHash).toBe(two?.contentHash);
  });

  it('warns once for the same malformed tool however often the skill is read', () => {
    const raw = envelope('pdf', 3, [{ type: 'function', name: 'bad' }]);
    verifyRawSkill(raw);
    verifyRawSkill(raw);
    expect(warnings).toHaveBeenCalledTimes(1);
  });

  it('keeps contentHash over the markdown only', () => {
    const skill = verifyRawSkill(envelope('pdf', 3, [tool('a')]));
    expect(skill?.contentHash).toBe(hash(BODY));
  });

  it('getSkill returns the tools', async () => {
    _setStore(new InMemorySkillStore({ pdf: envelope('pdf', 3, [tool('a')]) }));
    expect((await getSkill('pdf'))?.tools).toEqual([tool('a')]);
  });

  it('createSkill defaults tools to an empty frozen list', () => {
    const skill = createSkill({ key: 'a', version: 1, content: new Uint8Array(), contentHash: hash('') });
    expect(skill.tools).toEqual([]);
    expect(Object.isFrozen(skill.tools)).toBe(true);
  });
});

describe('withSkillTools', () => {
  it('offers skill tools after the variation tools, in the variation skills order', () => {
    _setStore(
      new InMemorySkillStore({
        first: envelope('first', 1, [tool('f1'), tool('f2')]),
        second: envelope('second', 2, [tool('s1')]),
      }),
    );
    const merged = withSkillTools(
      baseConfig({
        tools: { own: tool('own') },
        skills: [
          { key: 'second', version: 2 },
          { key: 'first', version: 1 },
        ],
      }),
      'support-agent',
    );
    expect(Object.keys(merged.tools ?? {})).toEqual(['own', 's1', 'f1', 'f2']);
    expect(merged.tools?.s1).toEqual(tool('s1'));
    expect(warnings).not.toHaveBeenCalled();
  });

  it('reads each skill at the version the variation pins', () => {
    const store = new InMemorySkillStore();
    store.put(envelope('pdf', 1, [tool('old')]));
    store.put(envelope('pdf', 2, [tool('new')]));
    _setStore(store);
    const merged = withSkillTools(baseConfig({ skills: [{ key: 'pdf', version: 1 }] }), 'c');
    expect(Object.keys(merged.tools ?? {})).toEqual(['old']);
  });

  it('skips an exact duplicate two skills share, without a warning', () => {
    _setStore(
      new InMemorySkillStore({
        a: envelope('a', 1, [tool('shared')]),
        b: envelope('b', 1, [tool('shared'), tool('b')]),
      }),
    );
    const merged = withSkillTools(
      baseConfig({
        skills: [
          { key: 'a', version: 1 },
          { key: 'b', version: 1 },
        ],
      }),
      'c',
    );
    expect(Object.keys(merged.tools ?? {})).toEqual(['shared', 'b']);
    expect(warnings).not.toHaveBeenCalled();
  });

  it.each([
    ['key order differs', { b: 1, a: [1, { c: 2 }] }, { a: [1, { c: 2 }], b: 1 }, true],
    ['a nested value differs', { a: [1, { c: 2 }] }, { a: [1, { c: 3 }] }, false],
    ['an array is not an object with the same keys', { a: ['x'] }, { a: { 0: 'x' } }, false],
    ['an extra key', { a: 1 }, { a: 1, b: undefined }, false],
  ])('treats two skills tools as duplicates by deep equality when %s', (_label, one, two, same) => {
    const withParams = (parameters: Record<string, unknown>): Tool => ({ ...tool('shared'), parameters });
    _setStore(
      new InMemorySkillStore({
        a: envelope('a', 1, [withParams(one)]),
        b: envelope('b', 1, [withParams(two)]),
      }),
    );
    withSkillTools(
      baseConfig({
        skills: [
          { key: 'a', version: 1 },
          { key: 'b', version: 1 },
        ],
      }),
      'c',
    );
    expect(warnings).toHaveBeenCalledTimes(same ? 0 : 1);
  });

  it('imports no Node builtin, so the package root needs none for skill tools', async () => {
    const source = await readFile(new URL('../skills-tools.ts', import.meta.url), 'utf-8');
    expect(source).not.toMatch(/from 'node:/);
  });

  it('offers a skill tool identical to a variation tool once, with a warning', () => {
    _setStore(new InMemorySkillStore({ a: envelope('a', 1, [tool('same')]) }));
    const merged = withSkillTools(
      baseConfig({ tools: { same: tool('same', 'the variation copy') }, skills: [{ key: 'a', version: 1 }] }),
      'c',
    );
    expect(Object.keys(merged.tools ?? {})).toEqual(['same']);
    expect(merged.tools?.same.description).toBe('the variation copy');
    // The server forbids any key a variation shares with its skills, so even an identical one warns.
    _setStore(new InMemorySkillStore({ a: envelope('a', 2, [tool('same', 'the variation copy')]) }));
    withSkillTools(
      baseConfig({ tools: { same: tool('same', 'the variation copy') }, skills: [{ key: 'a', version: 2 }] }),
      'c',
    );
    expect(warned()).toEqual([
      expect.stringMatching(/AI Config 'c' and skill 'a' version 1 both define tool "same"; /),
      expect.stringMatching(/AI Config 'c' and skill 'a' version 2 both define tool "same"; /),
    ]);
  });

  it('returns a config it has already merged unchanged, reading no skill and warning nothing', () => {
    const store = new InMemorySkillStore({ a: envelope('a', 1, [tool('t')]) });
    _setStore(store);
    const read = vi.spyOn(store, 'getObject');
    const once = withSkillTools(baseConfig({ tools: { own: tool('own') }, skills: [{ key: 'a', version: 1 }] }), 'c');
    expect(read).toHaveBeenCalledTimes(1);
    const twice = withSkillTools(once, 'c');
    expect(twice).toBe(once);
    expect(Object.keys(twice.tools ?? {})).toEqual(['own', 't']);
    expect(read).toHaveBeenCalledTimes(1);
    expect(warnings).not.toHaveBeenCalled();
    // The mark is not public: it is not a key, not serialized and not compared.
    expect(Object.keys(once)).not.toContain('launchdarkly.skillToolsMerged');
    expect(JSON.parse(JSON.stringify(once))).toEqual(once);
  });

  it('returns a marked copy when it adds nothing, and never marks the config it is given', () => {
    const store = new InMemorySkillStore({ plain: envelope('plain', 1) });
    _setStore(store);
    const read = vi.spyOn(store, 'getObject');
    const cfg = baseConfig({ skills: [{ key: 'plain', version: 1 }] });
    const once = withSkillTools(cfg, 'c');
    expect(once).not.toBe(cfg);
    expect(once).toEqual(cfg);
    expect(withSkillTools(once, 'c')).toBe(once);
    expect(read).toHaveBeenCalledTimes(1);
    // The input is unmarked, so it is merged again.
    withSkillTools(cfg, 'c');
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('merges a variation object the SDK reuses, after a run that found the skill missing', () => {
    // parseVariation passes the SDK's variation object through by identity, and an SDK may return the same one each run.
    const variation = {
      _ldMeta: { enabled: true, variationKey: 'v1', version: 1, mode: 'agent' },
      model: { name: 'gpt-4o' },
      provider: { name: 'OpenAI' },
      instructions: 'x',
      skills: [{ key: 'pdf', version: 1 }],
    };
    const store = new InMemorySkillStore();
    _setStore(store);
    expect(parseVariation('c', variation).config.tools).toBeUndefined();
    _setStore(new InMemorySkillStore({ pdf: envelope('pdf', 1, [tool('extract')]) }));
    expect(Object.keys(parseVariation('c', variation).config.tools ?? {})).toEqual(['extract']);
  });

  it("keeps the variation's definition when a skill defines the same tool differently, with a warning", () => {
    _setStore(new InMemorySkillStore({ a: envelope('a', 4, [tool('weather', 'from the skill')]) }));
    const merged = withSkillTools(
      baseConfig({ tools: { weather: tool('weather', 'from the variation') }, skills: [{ key: 'a', version: 4 }] }),
      'support-agent',
    );
    expect(merged.tools?.weather.description).toBe('from the variation');
    expect(Object.keys(merged.tools ?? {})).toEqual(['weather']);
    expect(warned()).toEqual([expect.stringMatching(/AI Config 'support-agent' and skill 'a' version 4.*"weather"/)]);
  });

  it("keeps the first skill's definition when two skills define a tool differently, with a warning", () => {
    _setStore(
      new InMemorySkillStore({
        a: envelope('a', 1, [tool('t', 'from a')]),
        b: envelope('b', 1, [tool('t', 'from b')]),
      }),
    );
    const merged = withSkillTools(
      baseConfig({
        skills: [
          { key: 'a', version: 1 },
          { key: 'b', version: 1 },
        ],
      }),
      'c',
    );
    expect(merged.tools?.t.description).toBe('from a');
    expect(warned()).toEqual([
      expect.stringMatching(
        /^\[LaunchDarkly\] Skill 'a' version 1 and skill 'b' version 1, both attached to AI Config 'c', both define tool "t"/,
      ),
    ]);
  });

  it('gives the handler copies it may change without changing the skill', async () => {
    _setStore(new InMemorySkillStore({ a: envelope('a', 1, [tool('t')]) }));
    const merged = withSkillTools(baseConfig({ skills: [{ key: 'a', version: 1 }] }), 'c');
    (merged.tools?.t.parameters as Record<string, unknown>).additionalProperties = false;
    expect((await getSkill('a'))?.tools[0].parameters).not.toHaveProperty('additionalProperties');
  });

  it('files a tool named __proto__ as an own tool', () => {
    _setStore(new InMemorySkillStore({ a: envelope('a', 1, [tool('__proto__')]) }));
    const merged = withSkillTools(baseConfig({ skills: [{ key: 'a', version: 1 }] }), 'c');
    expect(Object.keys(merged.tools ?? {})).toEqual(['__proto__']);
    expect(Object.getPrototypeOf(merged.tools)).toBe(Object.prototype);
  });

  it('does not change the config it is given', () => {
    _setStore(new InMemorySkillStore({ a: envelope('a', 1, [tool('t')]) }));
    const original = baseConfig({ tools: { own: tool('own') }, skills: [{ key: 'a', version: 1 }] });
    withSkillTools(original, 'c');
    expect(Object.keys(original.tools ?? {})).toEqual(['own']);
  });

  it.each([
    ['no skills field', baseConfig({ tools: { own: tool('own') } })],
    ['a malformed skills field', baseConfig({ tools: { own: tool('own') }, skills: 'pdf' })],
    [
      'a skill the store does not hold',
      baseConfig({ tools: { own: tool('own') }, skills: [{ key: 'gone', version: 1 }] }),
    ],
    ['a skill with no tools', baseConfig({ tools: { own: tool('own') }, skills: [{ key: 'plain', version: 1 }] })],
  ])('returns the config unchanged for %s', (_label, cfg) => {
    _setStore(new InMemorySkillStore({ plain: envelope('plain', 1) }));
    expect(withSkillTools(cfg, 'c')).toEqual(cfg);
  });

  it('returns the config unchanged when no skill store is configured', () => {
    const cfg = baseConfig({ skills: [{ key: 'a', version: 1 }] });
    expect(withSkillTools(cfg, 'c')).toBe(cfg);
    expect(warnings).not.toHaveBeenCalled();
  });

  it.each([
    ['absent', () => new InMemorySkillStore({ ok: envelope('ok', 1, [tool('ok')]) }), /is not available/],
    [
      'integrity_failure',
      () =>
        new InMemorySkillStore({
          ok: envelope('ok', 1, [tool('ok')]),
          bad: { ...envelope('bad', 1, [tool('t')]), contentHash: hash('other') },
        }),
      /failed integrity verification/,
    ],
    [
      'wrong_version',
      () => {
        const store = new InMemorySkillStore({ ok: envelope('ok', 1, [tool('ok')]) });
        // Answers every pin with version 2, as a broken adapter would.
        const getObject = store.getObject.bind(store);
        store.getObject = (kind, key, version) =>
          key === 'bad' ? envelope('bad', 2, [tool('t')]) : getObject(kind, key, version);
        return store;
      },
      /version 1 is not available/,
    ],
    [
      'store_unavailable',
      () => {
        const store = new InMemorySkillStore({ ok: envelope('ok', 1, [tool('ok')]) });
        const getObject = store.getObject.bind(store);
        store.getObject = (kind, key, version) => {
          if (key === 'bad') throw new Error('store down');
          return getObject(kind, key, version);
        };
        return store;
      },
      /store down/,
    ],
  ])('a skill that is %s adds no tools, warns once, and the others still add theirs', (_reason, makeStore, why) => {
    _setStore(makeStore());
    const cfg = () =>
      baseConfig({
        tools: { own: tool('own') },
        skills: [
          { key: 'bad', version: 1 },
          { key: 'ok', version: 1 },
        ],
      });
    expect(Object.keys(withSkillTools(cfg(), 'c').tools ?? {})).toEqual(['own', 'ok']);
    withSkillTools(cfg(), 'c');
    const messages = warned().filter((m) => /skill 'bad' version 1 adds no tools/i.test(m));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(why);
  });

  it('an integrity failure records the one signal it already records, not a second', () => {
    _setStore(new InMemorySkillStore({ bad: { ...envelope('bad', 1, [tool('t')]), contentHash: hash('other') } }));
    withSkillTools(baseConfig({ skills: [{ key: 'bad', version: 1 }] }), 'c');
    expect(signals).toEqual(['AgentControl Skill Integrity Failure']);
  });

  it('reads no store for a variation with no skills', () => {
    const store = new InMemorySkillStore({ a: envelope('a', 1, [tool('t')]) });
    const getObject = vi.spyOn(store, 'getObject');
    _setStore(store);
    const cfg = baseConfig({ tools: { own: tool('own') } });
    expect(withSkillTools(cfg, 'c')).toBe(cfg);
    expect(getObject).not.toHaveBeenCalled();
  });

  it('does not offer a tool pinned by a skill the store holds but the variation does not attach', () => {
    _setStore(new InMemorySkillStore({ a: envelope('a', 1, [tool('a')]), other: envelope('other', 1, [tool('x')]) }));
    const merged = withSkillTools(baseConfig({ skills: [{ key: 'a', version: 1 }] }), 'c');
    expect(Object.keys(merged.tools ?? {})).toEqual(['a']);
  });

  it('treats a definition that differs only in customParameters, or in a missing field, as a conflict', () => {
    const { customParameters: _omit, ...withoutCustom } = tool('t');
    _setStore(
      new InMemorySkillStore({
        a: envelope('a', 1, [tool('t')]),
        b: envelope('b', 1, [{ ...tool('t'), customParameters: { owner: 'other' } }]),
        c: envelope('c', 1, [withoutCustom]),
      }),
    );
    const refs = ['a', 'b', 'c'].map((key) => ({ key, version: 1 }));
    const merged = withSkillTools(baseConfig({ skills: refs }), 'c');
    expect(merged.tools?.t).toEqual(tool('t'));
    expect(warnings).toHaveBeenCalledTimes(2);
  });

  it('a miss before the store initializes warns without using up the warning for a real absence', () => {
    const store = new InMemorySkillStore();
    let ready = false;
    Object.assign(store, { isInitialized: () => ready });
    _setStore(store);
    // Each run parses its own config, which withSkillTools has not marked yet.
    const run = () => withSkillTools(baseConfig({ skills: [{ key: 'gone', version: 1 }] }), 'c');
    run();
    ready = true;
    run();
    run();
    expect(warned()).toEqual([
      expect.stringMatching(/Skill 'gone' version 1 adds no tools.*has not finished initializing/),
      expect.stringMatching(
        /Skill 'gone' version 1 adds no tools.*is not available from the configured skill store\.$/,
      ),
    ]);
  });

  it('warns once per process for a skill that cannot be read, across runs and configs', () => {
    _setStore(new InMemorySkillStore());
    const cfg = () => baseConfig({ skills: [{ key: 'gone', version: 1 }] });
    withSkillTools(cfg(), 'one');
    withSkillTools(cfg(), 'two');
    expect(warnings).toHaveBeenCalledTimes(1);
  });

  it('warns once per process for the same conflict', () => {
    _setStore(new InMemorySkillStore({ a: envelope('a', 4, [tool('weather', 'skill')]) }));
    const cfg = () =>
      baseConfig({ tools: { weather: tool('weather', 'variation') }, skills: [{ key: 'a', version: 4 }] });
    withSkillTools(cfg(), 'c');
    withSkillTools(cfg(), 'c');
    expect(warnings).toHaveBeenCalledTimes(1);
  });
});

describe('config().invoke with skill tools', () => {
  const ctx = { kind: 'user' as const, key: 'user-1' };

  function client(variation: Record<string, unknown>): LDClientInterface {
    return {
      variation: vi.fn().mockResolvedValue(variation),
      track: vi.fn(),
      flush: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };
  }

  afterEach(async () => {
    await shutdown();
  });

  const variation = {
    _ldMeta: { enabled: true, variationKey: 'v1', version: 1, mode: 'agent' },
    model: { name: 'gpt-4o' },
    provider: { name: 'OpenAI' },
    instructions: 'Be helpful.',
    tools: { own: tool('own') },
    skills: [{ key: 'pdf', version: 3 }],
  };

  it('hands the handler the variation tools plus the skill tools, and only their tool handlers', async () => {
    await initClient(client(variation));
    _setStore(new InMemorySkillStore({ pdf: envelope('pdf', 3, [tool('extract')]) }));

    let offered: string[] = [];
    let callable: string[] = [];
    const handler = createHandler(['OpenAI', 'agent'], async (cfg, _input, toolHandlers = {}) => {
      offered = Object.keys(cfg.tools ?? {});
      callable = Object.keys(toolHandlers);
      return { output: 'ok', usage: {} };
    });

    await config({
      key: 'support-agent',
      handler,
      toolHandlers: { own: () => 'own', extract: () => 'text', unnamed: () => 'never' },
    }).invoke('hi', ctx);

    expect(offered).toEqual(['own', 'extract']);
    expect(callable.sort()).toEqual(['extract', 'own']);
  });

  it('does the same on the streaming path', async () => {
    await initClient(client(variation));
    _setStore(new InMemorySkillStore({ pdf: envelope('pdf', 3, [tool('extract')]) }));
    let offered: string[] = [];
    let callable: string[] = [];
    const handler = createHandler(['OpenAI', 'agent'], async () => ({ output: 'unused', usage: {} }), {
      stream: async function* (cfg, _input, toolHandlers = {}) {
        offered = Object.keys(cfg.tools ?? {});
        callable = Object.keys(toolHandlers);
        yield { type: 'done', output: 'ok', usage: {} };
      },
    });
    const run = config({ key: 'support-agent', handler, toolHandlers: { extract: () => 'text', unnamed: () => 'x' } });
    for await (const _event of run.stream('hi', ctx)) {
      // drain
    }
    expect(offered).toEqual(['own', 'extract']);
    expect(callable).toEqual(['extract']);
  });

  it('dispatches and tracks a skill tool call like any tool, and reports no skills usage', async () => {
    const ld = client(variation);
    await initClient(ld);
    _setStore(new InMemorySkillStore({ pdf: envelope('pdf', 3, [tool('extract')]) }));
    const extract = vi.fn(() => 'text');
    const handler = createHandler(['OpenAI', 'agent'], async (_cfg, _input, toolHandlers = {}) => {
      await (toolHandlers.extract as (args: unknown) => unknown)({ q: 'x' });
      return { output: 'ok', usage: {} };
    });
    await config({ key: 'support-agent', handler, toolHandlers: { extract } }).invoke('hi', ctx);
    expect(extract).toHaveBeenCalledWith({ q: 'x' });
    const events = (ld.track as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0]);
    expect(events).toContain('$ld:ai:tool_call');
    expect(JSON.stringify((ld.track as ReturnType<typeof vi.fn>).mock.calls)).not.toMatch(/client\.getSkill/);
  });

  it('passes a NativeTool registered under a skill tool key as a native tool, not a function', async () => {
    await initClient(client(variation));
    _setStore(new InMemorySkillStore({ pdf: envelope('pdf', 3, [tool('search')]) }));
    const webSearch = new NativeTool(Symbol('web-search'), 'WebSearch');
    let received: unknown;
    const handler = createHandler(['OpenAI', 'agent'], async (_cfg, _input, toolHandlers = {}) => {
      received = toolHandlers.search;
      return { output: 'ok', usage: {} };
    });
    await config({ key: 'support-agent', handler, toolHandlers: { search: webSearch } }).invoke('hi', ctx);
    expect((received as Record<symbol, unknown>)[NATIVE_TOOL_KEY]).toBe(webSearch);
  });

  it('inspectConfig still returns only the variation tools', async () => {
    await initClient(client(variation));
    _setStore(new InMemorySkillStore({ pdf: envelope('pdf', 3, [tool('extract')]) }));
    const { config: cfg } = await inspectConfig('support-agent', ctx);
    expect(Object.keys(cfg?.tools ?? {})).toEqual(['own']);
  });

  it('leaves the raw variation value without the skill tools', async () => {
    await initClient(client(variation));
    _setStore(new InMemorySkillStore({ pdf: envelope('pdf', 3, [tool('extract')]) }));
    const { config: cfg, value } = await extractVariation('support-agent', ctx);
    expect(Object.keys(cfg.tools ?? {})).toEqual(['own', 'extract']);
    expect(Object.keys((value as { tools: object }).tools)).toEqual(['own']);
  });
});

describe('judge configs with skills', () => {
  const ctx = { kind: 'user' as const, key: 'user-1' };
  const judgeVariation = {
    _ldMeta: { enabled: true, variationKey: 'j1', version: 1, mode: 'judge' },
    model: { name: 'gpt-4o' },
    provider: { name: 'OpenAI' },
    instructions: 'Score it.',
    skills: [{ key: 'judge-skill', version: 1 }],
  };

  afterEach(async () => {
    await shutdown();
  });

  async function setUp() {
    await initClient({
      variation: vi.fn().mockResolvedValue(judgeVariation),
      track: vi.fn(),
      flush: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    });
    const store = new InMemorySkillStore({ 'judge-skill': envelope('judge-skill', 1, [tool('t')]) });
    const getObject = vi.spyOn(store, 'getObject');
    _setStore(store);
    return getObject;
  }

  it('a judge run reads no skill for tools', async () => {
    const getObject = await setUp();
    const handler = createHandler(['OpenAI', 'messages'], async (cfg) => {
      expect(cfg.tools).toBeUndefined();
      return { output: '{"score": 1, "reasoning": "ok"}', usage: {} };
    });
    await runJudges({
      config: baseConfig({ judgeConfiguration: { judges: [{ key: 'judge-cfg', samplingRate: 1 }] } }),
      userContext: ctx,
      handler,
      llmResponse: 'answer',
      baseTrackData: {
        runId: 'r',
        configKey: 'c',
        variationKey: 'v',
        version: 1,
        modelName: 'gpt-4o',
        providerName: 'OpenAI',
      },
    });
    expect(getObject).not.toHaveBeenCalled();
  });

  it('extractVariation with skillTools: false reads no store and keeps only the variation tools', async () => {
    const getObject = await setUp();
    const { config: cfg } = await extractVariation('judge-cfg', ctx, { skillTools: false });
    expect(cfg.tools).toBeUndefined();
    expect(getObject).not.toHaveBeenCalled();
  });
});

describe('resolveGraph with skill tools', () => {
  afterEach(async () => {
    await shutdown();
  });

  it('gives each node the skill tools, for the native graph adapters', async () => {
    const node = {
      _ldMeta: { enabled: true, variationKey: 'v1', version: 1, mode: 'agent' },
      model: { name: 'gpt-4o' },
      provider: { name: 'OpenAI' },
      instructions: 'Route.',
      skills: [{ key: 'pdf', version: 3 }],
    };
    const variations: Record<string, unknown> = { 'my-graph': { root: 'triage', edges: {} }, triage: node };
    await initClient({
      variation: vi.fn(async (key: string) => variations[key]),
      track: vi.fn(),
      flush: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    });
    _setStore(new InMemorySkillStore({ pdf: envelope('pdf', 3, [tool('extract')]) }));

    const def = await resolveGraph('my-graph', { context: { kind: 'user', key: 'u' } });
    expect(Object.keys(def.getNode('triage')?.config.tools ?? {})).toEqual(['extract']);
  });

  it('gives each node a merged config, so merging it again reads no skill and warns nothing', async () => {
    const node = {
      _ldMeta: { enabled: true, variationKey: 'v1', version: 1, mode: 'agent' },
      model: { name: 'gpt-4o' },
      provider: { name: 'OpenAI' },
      instructions: 'Route.',
      tools: { own: tool('own') },
      skills: [{ key: 'pdf', version: 3 }],
    };
    const variations: Record<string, unknown> = { 'my-graph': { root: 'triage', edges: {} }, triage: node };
    await initClient({
      variation: vi.fn(async (key: string) => variations[key]),
      track: vi.fn(),
      flush: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    });
    const store = new InMemorySkillStore({ pdf: envelope('pdf', 3, [tool('extract')]) });
    _setStore(store);
    const read = vi.spyOn(store, 'getObject');

    const def = await resolveGraph('my-graph', { context: { kind: 'user', key: 'u' } });
    const merged = def.getNode('triage')?.config as AiConfigRep;
    expect(read).toHaveBeenCalledTimes(1);
    // A second pass would otherwise read 'extract' as a key the variation shares with the skill, and warn.
    expect(withSkillTools(merged, 'triage')).toBe(merged);
    expect(Object.keys(merged.tools ?? {})).toEqual(['own', 'extract']);
    expect(read).toHaveBeenCalledTimes(1);
    expect(warnings).not.toHaveBeenCalled();
  });
});

describe('writeSkills with skill tools', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'ld-skill-tools-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('writes the same manifest as for the skill without tools, and reports skipped_current either way', async () => {
    const other = await mkdtemp(path.join(tmpdir(), 'ld-skill-tools-'));
    // A fixed clock, so `writtenAt` matches and the manifests compare byte for byte.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-18T00:00:00Z'));
    try {
      _setStore(new InMemorySkillStore({ pdf: envelope('pdf', 3) }));
      await writeSkills([{ key: 'pdf', version: 3 }], other);
      _setStore(new InMemorySkillStore({ pdf: envelope('pdf', 3, [tool('extract')]) }));
      await writeSkills([{ key: 'pdf', version: 3 }], root);
      expect(await readFile(path.join(root, '.launchdarkly-skills.json'))).toEqual(
        await readFile(path.join(other, '.launchdarkly-skills.json')),
      );
      const again = await writeSkills([{ key: 'pdf', version: 3 }], other);
      expect(again.actions.map((a) => a.action)).toEqual(['skipped_current']);
    } finally {
      vi.useRealTimers();
      await rm(other, { recursive: true, force: true });
    }
  });

  it('writes no tools to disk or to the manifest', async () => {
    _setStore(new InMemorySkillStore({ pdf: envelope('pdf', 3, [tool('extract')]) }));
    const report = await writeSkills([{ key: 'pdf', version: 3 }], root);
    expect(report.ok).toBe(true);
    expect(await readdir(path.join(root, 'pdf'))).toEqual(['SKILL.md']);
    expect(await readFile(path.join(root, 'pdf', 'SKILL.md'), 'utf-8')).toBe(BODY);
    const manifest = await readFile(path.join(root, '.launchdarkly-skills.json'), 'utf-8');
    expect(manifest).not.toMatch(/tools|extract/);
  });
});
