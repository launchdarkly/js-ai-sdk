/**
 * Tests the import scan in check-packaging.mjs. The install-and-load half needs a
 * build and the npm registry, so CI runs it as `yarn check:packaging`.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { importedPackages, undeclaredImports } from './check-packaging.mjs';

describe('importedPackages', () => {
  it('reads static imports, requires, side-effect imports and dynamic imports', () => {
    const source = [
      'import { a } from "pkg-a";',
      'const b = require("pkg-b");',
      'import "pkg-c";',
      'const d = await import("pkg-d");',
    ].join('\n');
    assert.deepEqual(importedPackages(source), ['pkg-a', 'pkg-b', 'pkg-c', 'pkg-d']);
  });

  it('reduces a subpath to its package, scoped or not', () => {
    const source = 'import x from "@scope/pkg/deep/path"; import y from "plain/sub";';
    assert.deepEqual(importedPackages(source), ['@scope/pkg', 'plain']);
  });

  it('ignores Node builtins, with or without the node: prefix', () => {
    assert.deepEqual(importedPackages('import fs from "node:fs"; const p = require("path");'), []);
  });

  it('ignores relative imports', () => {
    assert.deepEqual(importedPackages('import x from "./x.js"; import y from "../y.js";'), []);
  });

  it('does not read an interpolated string as an import', () => {
    assert.deepEqual(importedPackages('throw new Error(`no dataset from "${projectKey}"`);'), []);
  });
});

describe('undeclaredImports', () => {
  const files = ['const { ChatAnthropic } = await import("@langchain/anthropic");'];

  it('reports a dynamically imported package the manifest does not declare', () => {
    assert.deepEqual(undeclaredImports({ name: 'pkg' }, files), ['@langchain/anthropic']);
  });

  it('accepts a package declared as an optional peer', () => {
    const manifest = {
      name: 'pkg',
      peerDependencies: { '@langchain/anthropic': '>=1.0' },
      peerDependenciesMeta: { '@langchain/anthropic': { optional: true } },
    };
    assert.deepEqual(undeclaredImports(manifest, files), []);
  });

  it('accepts a package declared as a dependency, and the package importing itself', () => {
    const manifest = { name: 'pkg', dependencies: { '@langchain/anthropic': '^1.0.0' } };
    assert.deepEqual(undeclaredImports(manifest, [...files, 'import x from "pkg/experimental";']), []);
  });
});
