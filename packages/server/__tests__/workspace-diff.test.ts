import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkspaceDiff, WorkspaceFiles } from '../src/protocol.ts';
import * as commands from '../src/stim-command.ts';
import { readWorkspaceDiff } from '../src/workspace-diff.ts';

let root: string;
let repo: string;
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
const read = (path?: string, group: 'changed' | 'untracked' = 'changed') =>
  readWorkspaceDiff(repo, path, process.env, new AbortController().signal, group);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stim-diff-'));
  process.env.STIM_HOME = join(root, 'home');
  repo = join(root, 'repo');
  mkdirSync(repo);
  git('init', '-q');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, 'source.txt'), 'original\n');
  git('add', '--', 'source.txt');
  git('commit', '-qm', 'base');
});
afterEach(async () => {
  vi.restoreAllMocks();
  delete process.env.STIM_HOME;
  await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

test('refuses partial clones on old or unparseable Git without probing ordinary repositories', async () => {
  const original = commands.runFileCommand;
  let version = 'git version 2.39.5 (Apple Git-154)';
  const run = vi
    .spyOn(commands, 'runFileCommand')
    .mockImplementation((...args) =>
      args[2].includes('--version')
        ? { outcome: Promise.resolve({ ok: true, stdout: version }), cancel: async () => {} }
        : original(...args),
    );
  expect(((await read()) as WorkspaceFiles).files).toEqual([]);
  expect(run.mock.calls.some((call) => call[2].includes('--version'))).toBe(false);
  git('config', 'remote.origin.promisor', 'false');
  expect(((await read()) as WorkspaceFiles).files).toEqual([]);
  expect(run.mock.calls.some((call) => call[2].includes('--version'))).toBe(false);
  git('config', 'remote.origin.promisor', 'yes');
  await expect(read()).rejects.toThrow('Git 2.45 or later for partial clones');
  version = 'unparseable';
  await expect(read()).rejects.toThrow('Git 2.45 or later for partial clones');
  version = 'git version 2.45.0';
  expect(((await read()) as WorkspaceFiles).files).toEqual([]);
  git('config', '--unset', 'remote.origin.promisor');
  git('config', 'extensions.partialclone', 'origin');
  version = 'git version 2.44.0';
  await expect(read()).rejects.toThrow('Git 2.45 or later for partial clones');
});

test('omits dirty-only submodules without running their clean filters and still lists moved gitlinks', async () => {
  const source = join(root, 'submodule-source');
  git('clone', '-q', '--', repo, source);
  git('-c', 'protocol.file.allow=always', 'submodule', 'add', source, 'nested');
  git('commit', '-qm', 'submodule');
  const marker = join(root, 'submodule-filter-ran');
  const driver = join(root, 'submodule-filter.js');
  writeFileSync(driver, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`);
  git('-C', 'nested', 'config', 'filter.evil.clean', `"${process.execPath}" "${driver}"`);
  writeFileSync(join(repo, '.git', 'modules', 'nested', 'info', 'attributes'), 'source.txt filter=evil\n');
  writeFileSync(join(repo, 'nested', 'source.txt'), 'modified\n');
  const dirty = (await read()) as WorkspaceFiles;
  expect(existsSync(marker)).toBe(false);
  expect(dirty.files).toEqual([]);
  git('-C', 'nested', 'config', 'user.email', 'test@example.invalid');
  git('-C', 'nested', 'config', 'user.name', 'Test');
  git('-C', 'nested', '-c', 'filter.evil.clean=', '-c', 'commit.gpgsign=false', 'commit', '-a', '-qm', 'moved');
  git('config', 'diff.ignoreSubmodules', 'all');
  git('config', 'submodule.nested.ignore', 'all');
  const moved = (await read()) as WorkspaceFiles;
  expect(moved.files).toEqual([{ path: 'nested', status: ' M', staged: false, unstaged: true, untracked: false }]);
  expect(((await read('nested')) as WorkspaceDiff).patches[0]!.kind).toBe('unavailable');
  expect(existsSync(marker)).toBe(false);
  const nestedDriver = join(root, 'nested-driver.js');
  const nestedMarker = join(root, 'nested-driver-ran');
  writeFileSync(nestedDriver, `require('node:fs').writeFileSync(${JSON.stringify(nestedMarker)}, 'ran')`);
  git('-C', 'nested', 'config', 'diff.external', `"${process.execPath}" "${nestedDriver}"`);
  git('config', '--unset', 'diff.ignoreSubmodules');
  git('config', '--unset', 'submodule.nested.ignore');
  git('rm', '--cached', '--', 'nested');
  git('config', 'diff.submodule', 'diff');
  const removed = (await read('nested')) as WorkspaceDiff;
  expect(removed.patches[0]!.kind).toBe('text');
  expect(existsSync(marker)).toBe(false);
  expect(existsSync(nestedMarker)).toBe(false);
});

test('refuses missing tracked blobs without invoking a configured lazy-fetch transport', async () => {
  const remote = join(root, 'remote');
  git('clone', '-q', '--', repo, remote);
  const marker = join(root, 'transport-ran');
  const driver = join(root, 'transport.js');
  writeFileSync(driver, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran'); process.exit(1)`);
  git('config', 'remote.origin.url', remote);
  git('config', 'remote.origin.promisor', 'true');
  git('config', 'remote.origin.uploadpack', `"${process.execPath}" "${driver}"`);
  const blob = git('rev-parse', 'HEAD:source.txt').trim();
  rmSync(join(repo, '.git', 'objects', blob.slice(0, 2), blob.slice(2)));
  writeFileSync(join(repo, 'source.txt'), 'updated\n');
  await expect(read('source.txt')).rejects.toThrow(/Workspace diff exited|Git 2.45 or later/);
  expect(existsSync(marker)).toBe(false);
});

test('reports binary, oversized and external symlink new files without their contents', async () => {
  writeFileSync(join(repo, 'binary.dat'), Buffer.from([0, 1, 2]));
  writeFileSync(join(repo, 'large.txt'), 'x'.repeat(256 * 1024 + 1));
  writeFileSync(join(root, 'private.txt'), 'outside content');
  if (process.platform !== 'win32') symlinkSync(join(root, 'private.txt'), join(repo, 'external.txt'));
  expect(((await read('binary.dat')) as WorkspaceDiff).patches[0]).toMatchObject({ kind: 'binary', text: '' });
  expect(((await read('large.txt')) as WorkspaceDiff).patches[0]).toMatchObject({ kind: 'too-large', text: '' });
  const external = process.platform !== 'win32' ? ((await read('external.txt')) as WorkspaceDiff) : null;
  expect(external?.patches[0]?.kind).toBe(process.platform !== 'win32' ? 'unavailable' : undefined);
});

test('reports tracked binary and over-budget patches without returning contents', async () => {
  writeFileSync(join(repo, 'source.txt'), Buffer.from([0, 1, 2]));
  expect(((await read('source.txt')) as WorkspaceDiff).patches[0]).toMatchObject({ kind: 'binary', text: '' });
  writeFileSync(join(repo, 'source.txt'), 'x'.repeat(300 * 1024));
  expect(((await read('source.txt')) as WorkspaceDiff).patches[0]).toMatchObject({ kind: 'too-large', text: '' });
});

test('does no Git work once the request is aborted', async () => {
  const controller = new AbortController();
  controller.abort(new Error('left screen'));
  await expect(readWorkspaceDiff(repo, undefined, process.env, controller.signal)).rejects.toThrow('left screen');
});

test.each(['core.attributesFile', 'info/attributes', 'nested .gitattributes'])(
  'refuses tracked clean filters from %s before status or diff can execute them',
  async (source) => {
    mkdirSync(join(repo, 'app'));
    writeFileSync(join(repo, 'app', 'source.txt'), 'original\n');
    git('add', '--', 'app/source.txt');
    git('commit', '-qm', 'nested file');
    const marker = join(root, 'filter-ran');
    const driver = join(root, 'filter.js');
    writeFileSync(driver, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`);
    git('config', 'filter.evil.clean', `"${process.execPath}" "${driver}"`);
    const attributes =
      source === 'core.attributesFile'
        ? join(root, 'attributes')
        : source === 'info/attributes'
          ? join(repo, '.git', 'info', 'attributes')
          : join(repo, 'app', '.gitattributes');
    if (source === 'core.attributesFile') git('config', 'core.attributesFile', attributes);
    writeFileSync(attributes, 'source.txt filter=evil\n');
    writeFileSync(join(repo, 'app', 'source.txt'), 'modified\n');
    await expect(read()).rejects.toThrow('Git clean/process filter');
    await expect(read('app/source.txt')).rejects.toThrow('Git clean/process filter');
    expect(existsSync(marker)).toBe(false);
  },
);
