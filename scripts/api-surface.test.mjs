/**
 * Tests of the API-surface check itself, against fixture lists and reports
 * rather than the real ones. Run with `node --test scripts/api-surface.test.mjs`.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { compare, main, parseList, reportNames, usageRows } from './api-surface.mjs';

const REPORT = `## API Report File for "x"

\`\`\`ts
// @public
export function exported(): void;

// @public
export type TypeOnly = string;

// @public
export interface Shape {
    field: string;
}

// @public
export class Thing {
}
\`\`\`
`;

const check = (listText, options) => compare('fixture.txt', parseList(listText, 'fixture.txt'), reportNames(REPORT), options);

describe('reportNames', () => {
  it('reads values and type-only names, not members', () => {
    assert.deepEqual([...reportNames(REPORT)].sort(), ['Shape', 'Thing', 'TypeOnly', 'exported']);
  });
});

describe('compare', () => {
  const all = 'exported\nShape\nThing\nTypeOnly\n';

  it('passes when the list and the exports agree', () => {
    assert.deepEqual(check(all).failures, []);
  });

  it('fails on an exported name missing from the list, naming the list and the name', () => {
    const { failures } = check('exported\nShape\nThing\n');
    assert.equal(failures.length, 1);
    assert.match(failures[0], /TypeOnly is exported but is not in fixture\.txt/);
    assert.match(failures[0], /"\+ TypeOnly"/);
  });

  it('fails on a type-only export missing from the list', () => {
    assert.match(check('exported\nThing\nTypeOnly\n').failures[0], /^Shape is exported/);
  });

  it('fails on an unmarked name that is not exported', () => {
    const { failures } = check(`${all}gone\n`);
    assert.equal(failures.length, 1);
    assert.match(failures[0], /gone is public in fixture\.txt but is not exported/);
  });

  it('passes a - name and a + name, exported or not', () => {
    const result = check('- exported\n+ Shape\nThing\n+ TypeOnly\n- old\n+ upcoming\n');
    assert.deepEqual(result.failures, []);
    assert.deepEqual(result.leaving, ['exported']);
    assert.deepEqual(result.joining, ['upcoming']);
  });

  it('fails on every marker in strict mode, and only reports them otherwise', () => {
    const list = `${all}+ upcoming\n`;
    assert.deepEqual(check(list).failures, []);
    assert.deepEqual(check(list).joining, ['upcoming']);
    const strict = check(list, { strict: true }).failures;
    assert.equal(strict.length, 1);
    assert.match(strict[0], /marks \+ upcoming/);
  });

  it('ignores comments, usage fields and notes', () => {
    assert.deepEqual(check(`# header\n\nexported  usage=client.x  # note\nShape\nThing\nTypeOnly\n`).failures, []);
  });
});

describe('unreadable lists', () => {
  it('throws on an empty list', () => {
    assert.throws(() => parseList('# only a header\n\n', 'empty.txt'), /empty\.txt: the list has no names/);
  });

  it('throws on a line it cannot read', () => {
    assert.throws(() => parseList('* bad\n', 'bad.txt'), /bad\.txt:1/);
  });

  it('fails the run on a missing list instead of skipping it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'api-surface-'));
    const errors = [];
    const code = main({ listDir: dir, log: { error: (m) => errors.push(m), log: () => {} } });
    assert.equal(code, 1);
    assert.match(errors[0], /the list is missing/);
  });

  it('fails the run on an empty list', () => {
    const dir = mkdtempSync(join(tmpdir(), 'api-surface-'));
    writeFileSync(join(dir, 'ai-server.txt'), '# nothing\n');
    writeFileSync(join(dir, 'ai-server.experimental.txt'), '# nothing\n');
    const errors = [];
    const code = main({ listDir: dir, log: { error: (m) => errors.push(m), log: () => {} } });
    assert.equal(code, 1);
    assert.match(errors.join('\n'), /has no names/);
  });
});

describe('usageRows', () => {
  const dir = mkdtempSync(join(tmpdir(), 'api-surface-'));
  writeFileSync(
    join(dir, 'pkg.txt'),
    'config  usage=client.config.invoke,client.config.stream\nplain\n+ upcoming  usage=client.upcoming\n- leaving  usage=client.leaving\n',
  );
  const config = () => {};
  const leaving = () => {};

  it('gives one row per usage ID, with the export the name refers to', () => {
    const rows = usageRows('pkg.txt', { config, leaving }, { listDir: dir });
    assert.deepEqual(
      rows.map(({ id, name }) => [id, name]),
      [
        ['client.config.invoke', 'config'],
        ['client.config.stream', 'config'],
        ['client.leaving', 'leaving'],
      ],
    );
    assert.equal(rows[0].fn, config);
  });

  it('skips a marked name that is not exported, and keeps an unmarked one so its test fails', () => {
    const rows = usageRows('pkg.txt', {}, { listDir: dir });
    assert.deepEqual(
      rows.map(({ id, fn }) => [id, fn]),
      [
        ['client.config.invoke', undefined],
        ['client.config.stream', undefined],
      ],
    );
  });

  it('throws on a missing list', () => {
    assert.throws(() => usageRows('absent.txt', {}, { listDir: dir }), /the list is missing/);
  });
});
