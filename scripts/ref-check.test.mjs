import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, test } from 'vitest';

const script = fileURLToPath(new URL('./ref-check.mjs', import.meta.url));
const ref = (target) => ['@ref', target].join(' ');
const doc = [
  '# LLP 0001',
  '**Type:** Decision',
  '**Status:** Active',
  '**Systems:** Test',
  '**Author:** Stim',
  '**Date:** 2026-11-12',
  '',
  '## 2. Workspace \u2013 Caf\u00e9',
  '```md',
  '## In a fence',
  '```',
].join('\n');
let root;

function write(path, contents) {
  const destination = join(root, path);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, contents);
}

function git(...args) {
  execFileSync('git', args, { cwd: root, stdio: 'pipe' });
}

function check(options = [], cwd = root, executable = script) {
  const result = spawnSync(process.execPath, [executable, ...options], { cwd, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stim-ref-check-'));
  git('init', '-q');
  write('llp/0001-workspace.decision.md', doc);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

test('checks staged and new Git files while skipping ignored files, JSON and nested corpora', () => {
  write('.gitignore', 'ignored.ts\n');
  write('ignored.ts', ref('LLP 9999'));
  write('transcript.json', JSON.stringify(ref('LLP 9999')));
  write('fixtures/subproject/llp/0001-nested.decision.md', doc);
  write('fixtures/subproject/source.ts', ref('LLP 9999'));
  write(
    'source.ts',
    [
      `// ${ref('LLP 1#2 -- why')}`,
      `// ${ref('LLP 0001#2-workspace--caf\u00e9')}`,
      `// ${ref('https://example.com/path')}`,
    ].join('\n'),
  );
  write('README.md', [ref('LLP 9999'), `<!-- ${ref('llp/0001-workspace.decision.md#2 [implements]')} -->`].join('\n'));
  git('add', 'source.ts', 'llp/0001-workspace.decision.md');
  expect(check(['--root', root], tmpdir())).toMatchObject({
    status: 0,
    stdout: expect.stringContaining('1 LLP docs, 4 refs'),
  });

  write('source.ts', `// ${ref('LLP 9999')}`);
  expect(check()).toMatchObject({
    status: 1,
    stdout: expect.stringContaining('source.ts:1: broken ref: LLP 9999 not found'),
  });
});

test('reports unresolved paths and anchors, malformed targets, and optional unchecked details', () => {
  write(
    'source.ts',
    [
      `// ${ref('LLP 0001#in-a-fence')}`,
      `// ${ref('LLP 10000')}`,
      `// ${ref('missing.ts')}`,
      `// ${ref('https://localhost')}`,
      `// ${ref('NAME#heading')}`,
    ].join('\n'),
  );
  write('README.md', `# Read me\n\n<!-- ${ref('LLP 0001#typo')} -->`);
  const result = check(['--verbose']);
  expect(result.status).toBe(1);
  for (const diagnostic of [
    'source.ts:1: broken ref: no anchor #in-a-fence',
    'source.ts:2: malformed LLP target',
    'source.ts:3: broken ref: path not found: missing.ts',
    'source.ts:4: malformed URL target: https://localhost',
    'README.md:3: broken ref: no anchor #typo',
    'source.ts:5: unchecked shorthand: NAME#heading',
  ])
    expect(result.stdout).toContain(diagnostic);
  expect(check().stdout).not.toContain('unchecked shorthand');
});

test.skipIf(process.platform === 'win32')('runs when invoked through a symlink', () => {
  const alias = join(root, 'checker.mjs');
  symlinkSync(script, alias);
  expect(check([], root, alias)).toMatchObject({ status: 0, stdout: expect.stringContaining('1 LLP docs') });
});

test('checks the literal filesystem path without normalizing away traversal', () => {
  write('existing.md', '# Heading');
  write('source.ts', [`// ${ref('absent/../existing.md')}`, `// ${ref('existing.md/')}`].join('\n'));
  const result = check();
  expect(result.status).toBe(1);
  expect(result.stdout).toContain('broken ref: path not found: absent/../existing.md');
  expect(result.stdout).toContain('broken ref: path not found: existing.md/');
});

test.skipIf(process.platform === 'win32')('resolves parent traversal from the symlink target directory', () => {
  write('actual/parent.md', '# Heading');
  mkdirSync(join(root, 'actual', 'nested'));
  symlinkSync(join(root, 'actual', 'nested'), join(root, 'alias'));
  write('source.ts', `// ${ref('alias/../parent.md#heading')}`);
  expect(check()).toMatchObject({ status: 0, stdout: expect.stringContaining('1 LLP docs, 1 refs') });
});

test('reports duplicate document numbers and invalid metadata', () => {
  write('llp/0001-duplicate.explainer.md', '# Another doc\n**Type:** Decision\n**Status:** Active');
  const result = check();
  expect(result.status).toBe(1);
  expect(result.stdout).toContain('duplicate LLP number 0001');
  expect(result.stdout).toContain('missing required metadata field **Systems:**');
  expect(result.stdout).toContain("filename type '.explainer.md' != **Type:** Decision");
});
