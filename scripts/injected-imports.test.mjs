import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { injectedImportProblems } from './injected-imports.mjs';

let root;
let directory;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stim-injected-imports-'));
  directory = join(root, 'injected');
  mkdirSync(directory);
  writeFileSync(join(directory, 'sibling.cjs'), '');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test('accepts built-ins and real sibling files, ignoring comments and string contents', () => {
  writeFileSync(
    join(directory, 'entry.cjs'),
    `require('node:fs'); import('node:path'); require('./sibling.cjs');
// require('external');
/* import 'external'; */
const text = "require('external')";`,
  );
  expect(injectedImportProblems(directory)).toEqual([]);
});

test.each([
  "require('external')",
  "import value from 'external'",
  "import 'external'",
  "import('external')",
  'import(`external`)',
  "require('../outside.cjs')",
  "require('./missing.cjs')",
  "require('./nested/child.cjs')",
  "require('./escape.cjs')",
])('rejects non-sibling dependency: %s', (source) => {
  writeFileSync(join(root, 'outside.cjs'), '');
  mkdirSync(join(directory, 'nested'));
  writeFileSync(join(directory, 'nested/child.cjs'), '');
  symlinkSync(join(root, 'outside.cjs'), join(directory, 'escape.cjs'));
  writeFileSync(join(directory, 'entry.cjs'), `\n${source}`);
  expect(injectedImportProblems(directory)).toEqual([expect.stringContaining('entry.cjs:2:')]);
});
