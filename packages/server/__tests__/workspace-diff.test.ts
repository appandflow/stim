import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkspaceDiff, WorkspaceFiles } from '../src/protocol.ts';
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
afterEach(() => {
  delete process.env.STIM_HOME;
  rmSync(root, { recursive: true, force: true });
});

test('reads staged and unstaged independently with literal unusual paths', async () => {
  writeFileSync(join(repo, 'source.txt'), 'staged\n');
  git('add', '--', 'source.txt');
  writeFileSync(join(repo, 'source.txt'), 'unstaged\n');
  writeFileSync(join(repo, 'new [file].txt'), 'new text\n');
  const files = (await read()) as WorkspaceFiles;
  expect(files.files).toEqual([{ path: 'source.txt', status: 'MM', staged: true, unstaged: true, untracked: false }]);
  const patch = (await read('source.txt')) as WorkspaceDiff;
  expect(patch.patches).toHaveLength(2);
  expect(patch.patches[0]).toMatchObject({ section: 'staged', kind: 'text' });
  expect(patch.patches[0]!.text).toContain('-original\n+staged');
  expect(patch.patches[1]!.text).toContain('-staged\n+unstaged');
  expect(((await read(undefined, 'untracked')) as WorkspaceFiles).files[0]!.path).toBe('new [file].txt');
  expect(((await read('new [file].txt')) as WorkspaceDiff).patches).toEqual([
    { section: 'untracked', kind: 'text', text: 'new text\n' },
  ]);
});

test('does not invoke diff or merge drivers, text conversion, fsmonitor or index hooks', async () => {
  const marker = join(root, 'driver-ran');
  const driver = join(root, 'driver.js');
  writeFileSync(driver, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`);
  const command = `"${process.execPath}" "${driver}"`;
  git('config', 'diff.external', command);
  git('config', 'diff.unsafe.command', command);
  git('config', 'diff.unsafe.textconv', command);
  git('config', 'merge.unsafe.driver', command);
  git('config', 'core.fsmonitor', command);
  const hooks = join(root, 'hooks');
  mkdirSync(hooks);
  writeFileSync(join(hooks, 'post-index-change'), `#!/bin/sh\n${command}\n`, { mode: 0o755 });
  git('config', 'core.hooksPath', hooks);
  writeFileSync(join(repo, '.gitattributes'), 'source.txt diff=unsafe merge=unsafe\n');
  writeFileSync(join(repo, 'source.txt'), 'updated\n');
  expect(((await read('source.txt')) as WorkspaceDiff).patches[0]!.text).toContain('+updated');
  expect(existsSync(marker)).toBe(false);
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
  git(
    '-C',
    'nested',
    '-c',
    'filter.evil.clean=',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '--allow-empty',
    '-qm',
    'moved',
  );
  git('config', 'diff.ignoreSubmodules', 'all');
  git('config', 'submodule.nested.ignore', 'all');
  const moved = (await read()) as WorkspaceFiles;
  expect(moved.files).toEqual([{ path: 'nested', status: ' M', staged: false, unstaged: true, untracked: false }]);
  expect(((await read('nested')) as WorkspaceDiff).patches[0]!.kind).toBe('unavailable');
  expect(existsSync(marker)).toBe(false);
  git('rm', '--cached', '--', 'nested');
  git('config', 'diff.submodule', 'diff');
  const removed = (await read('nested')) as WorkspaceDiff;
  expect(removed.patches[0]!.kind).toBe('text');
  expect(existsSync(marker)).toBe(false);
});

test('returns plain staged and unstaged patches when Git color is forced', async () => {
  git('config', 'color.ui', 'always');
  git('config', 'color.diff', 'always');
  git('config', 'color.status', 'always');
  writeFileSync(join(repo, 'source.txt'), 'staged\n');
  git('add', '--', 'source.txt');
  writeFileSync(join(repo, 'source.txt'), 'unstaged\n');
  expect(((await read()) as WorkspaceFiles).files[0]!.path).toBe('source.txt');
  const patch = (await read('source.txt')) as WorkspaceDiff;
  expect(patch.patches).toHaveLength(2);
  for (const section of patch.patches) expect(section.text).not.toContain('\u001b');
  expect(patch.patches[0]!.text).toContain('-original\n+staged');
  expect(patch.patches[1]!.text).toContain('-staged\n+unstaged');
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
  await expect(read('source.txt')).rejects.toThrow('Workspace diff exited');
  expect(existsSync(marker)).toBe(false);
});

test('ignores inherited Git routing and resolves a nested canonical workspace', async () => {
  mkdirSync(join(repo, 'app'));
  writeFileSync(join(repo, 'source.txt'), 'updated\n');
  const result = (await readWorkspaceDiff(
    join(repo, 'app'),
    undefined,
    { ...process.env, GIT_DIR: join(root, 'not-the-repo'), GIT_WORK_TREE: root },
    new AbortController().signal,
    'changed',
  )) as WorkspaceFiles;
  expect(result.files[0]!.path).toBe('source.txt');
  await expect(read('../outside.txt')).rejects.toThrow('no longer a changed file');
  await expect(read(join(repo, 'source.txt'))).rejects.toThrow('no longer a changed file');
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

test('bounds the selected file group and refuses unchanged or removed files', async () => {
  for (let i = 0; i < 205; i++) writeFileSync(join(repo, `new-${i}.txt`), 'new');
  const files = (await read(undefined, 'untracked')) as WorkspaceFiles;
  expect(files.files).toHaveLength(200);
  expect(files.truncated).toBe(true);
  expect(((await read()) as WorkspaceFiles).files).toEqual([]);
  await expect(read('source.txt')).rejects.toThrow('no longer a changed file');
  await expect(read('missing.txt')).rejects.toThrow('no longer a changed file');
});

test('does no Git work once the request is aborted', async () => {
  const controller = new AbortController();
  controller.abort(new Error('left screen'));
  await expect(readWorkspaceDiff(repo, undefined, process.env, controller.signal)).rejects.toThrow('left screen');
});

test('allows unused clean/process drivers but refuses an attributed tracked driver without executing it', async () => {
  const marker = join(root, 'filter-ran');
  const driver = join(root, 'filter.js');
  writeFileSync(driver, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`);
  for (const [name, kind] of [
    ['private', 'clean'],
    ['private', 'process'],
    ['unspecified', 'clean'],
  ]) {
    git('config', `filter.${name}.${kind}`, `"${process.execPath}" "${driver}"`);
    writeFileSync(join(repo, 'source.txt'), 'updated\n');
    expect(((await read('source.txt')) as WorkspaceDiff).patches[0]!.text).toContain('+updated');
    writeFileSync(join(repo, '.gitattributes'), `source.txt filter=${name}\n`);
    await expect(read()).rejects.toThrow('Git clean/process filter');
    await expect(read('source.txt')).rejects.toThrow('Git clean/process filter');
    expect(existsSync(marker)).toBe(false);
    rmSync(join(repo, '.gitattributes'));
    git('config', '--unset', `filter.${name}.${kind}`);
  }
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
