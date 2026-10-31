import { mkdirSync, mkdtempSync, realpathSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { copyDiagnosticLogs, diagnosticArtifactFiles } from '../artifacts.ts';

let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-ci-artifacts-')));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

it('does not traverse a symlink in place of the diagnostics or copied logs directory', async () => {
  const outside = join(root, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'private.log'), 'private');
  symlinkSync(outside, join(root, 'logs'), 'junction');
  expect(await copyDiagnosticLogs(join(root, 'logs'), join(root, 'artifacts'))).toEqual([]);
  expect(await diagnosticArtifactFiles(root)).toEqual([]);
});

it('selects reports and logs consistently through an explicit symlink root while excluding linked entries', async () => {
  const target = join(root, 'actual-results');
  const artifacts = join(root, 'linked-results');
  mkdirSync(join(target, 'logs'), { recursive: true });
  writeFileSync(join(target, 'result.json'), '{}');
  writeFileSync(join(target, 'test.stdout.log'), 'test output');
  writeFileSync(join(target, 'logs', 'native.log'), 'native output');
  writeFileSync(join(root, 'private.log'), 'private');
  symlinkSync(join(root, 'private.log'), join(target, 'test.stderr.log'));
  symlinkSync(join(root, 'private.log'), join(target, 'logs', 'linked.log'));
  symlinkSync(target, artifacts, 'junction');
  expect((await diagnosticArtifactFiles(artifacts)).map((file) => relative(artifacts, file))).toEqual([
    'result.json',
    'test.stdout.log',
    join('logs', 'native.log'),
  ]);
});

it('refuses destination links and existing files without overwriting their contents', async () => {
  const source = join(root, 'source');
  const artifacts = join(root, 'artifacts');
  const outside = join(root, 'outside');
  mkdirSync(source);
  mkdirSync(artifacts);
  mkdirSync(outside);
  writeFileSync(join(source, 'compiler.log'), 'new compiler evidence');
  writeFileSync(join(outside, 'compiler.log'), 'outside evidence');
  symlinkSync(outside, join(artifacts, 'logs'), 'junction');
  await expect(copyDiagnosticLogs(source, artifacts)).rejects.toThrow('regular directory');
  expect(readFileSync(join(outside, 'compiler.log'), 'utf8')).toBe('outside evidence');
  rmSync(join(artifacts, 'logs'));
  mkdirSync(join(artifacts, 'logs'));
  symlinkSync(join(outside, 'compiler.log'), join(artifacts, 'logs', 'compiler.log'));
  await expect(copyDiagnosticLogs(source, artifacts)).rejects.toThrow(/EEXIST/);
  expect(readFileSync(join(outside, 'compiler.log'), 'utf8')).toBe('outside evidence');
  rmSync(join(artifacts, 'logs', 'compiler.log'));
  writeFileSync(join(artifacts, 'logs', 'compiler.log'), 'earlier test evidence');
  await expect(copyDiagnosticLogs(source, artifacts)).rejects.toThrow(/EEXIST/);
  expect(readFileSync(join(artifacts, 'logs', 'compiler.log'), 'utf8')).toBe('earlier test evidence');
});
