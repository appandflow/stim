import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
