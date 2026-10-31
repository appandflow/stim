import { processContext } from '../cli-operation.ts';
import assert from 'node:assert';
import { execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetExecutor } from '../exec.ts';
import {
  unpushedCommitsAsync,
  hasUncommittedWorkAsync,
  listWorktrees,
  cloneIgnoredEntries,
  depsOutOfSync,
  listGitignoredEntries,
  listTrackedPaths,
  repoRoot,
  gitCommonDir,
  selectSourceCheckout,
  branchExistsAsync,
  hasRemoteAsync,
  dirtyPathsAsync,
  restoreFileAsync,
} from '../workspace/worktree.ts';

afterEach(() => resetExecutor());

test('unpushedCommits against a real repo: empty right after push, reports a commit made only locally', async () => {
  resetExecutor();
  const base = mkdtempSync(join(tmpdir(), 'stim-test-unpushed-'));
  const bareRemote = join(base, 'remote.git');
  const repo = join(base, 'repo');
  try {
    mkdirSync(bareRemote, { recursive: true });
    execSync(`git init -q --bare "${bareRemote}"`);
    mkdirSync(repo, { recursive: true });
    const git = (cmd: string) => execSync(cmd, { cwd: repo, encoding: 'utf-8' });
    git('git init -q');
    git('git config user.email test@example.com');
    git('git config user.name test');
    git(`git remote add origin "${bareRemote}"`);
    writeFileSync(join(repo, 'README.md'), 'hello');
    git('git add README.md');
    git('git commit -q -m init');
    git('git push -q -u origin HEAD');

    expect(await unpushedCommitsAsync(repo)).toEqual([]);

    writeFileSync(join(repo, 'local.txt'), 'local only');
    git('git add local.txt');
    git('git commit -q -m "local-only commit"');

    const unpushed = await unpushedCommitsAsync(repo);
    assert(unpushed, 'unpushedCommits returned null');
    expect(unpushed.length).toBe(1);
    expect(unpushed[0]).toMatch(/local-only commit/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('unpushedCommits against a real repo: commits inherited from a local-only base ref do not count; a commit the worktree adds does', async () => {
  resetExecutor();
  const base = mkdtempSync(join(tmpdir(), 'stim-test-inherited-'));
  const repo = join(base, 'repo');
  try {
    const bareRemote = join(base, 'remote.git');
    mkdirSync(bareRemote, { recursive: true });
    execSync(`git init -q --bare "${bareRemote}"`);
    mkdirSync(repo, { recursive: true });
    const git = (cmd: string) => execSync(cmd, { cwd: repo, encoding: 'utf-8' });
    git('git init -q -b main');
    git('git config user.email test@example.com');
    git('git config user.name test');
    git(`git remote add origin "${bareRemote}"`);
    writeFileSync(join(repo, 'README.md'), 'hello');
    git('git add README.md');
    git('git commit -q -m base-commit-X');
    const wt = join(base, 'wt');
    git(`git worktree add -q "${wt}" -b worktree-ws main`);

    expect(await unpushedCommitsAsync(wt)).toEqual([]);

    writeFileSync(join(wt, 'work.txt'), 'work');
    execSync('git add work.txt', { cwd: wt });
    execSync('git commit -q -m "worktree-only commit"', { cwd: wt });
    const unpushed = await unpushedCommitsAsync(wt);
    assert(unpushed, 'unpushedCommits returned null');
    expect(unpushed.length).toBe(1);
    expect(unpushed[0]).toMatch(/worktree-only commit/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

describe.each([
  { pm: 'npm', lockfile: 'package-lock.json', state: 'node_modules/.package-lock.json' },
  { pm: 'pnpm', lockfile: 'pnpm-lock.yaml', state: 'node_modules/.pnpm/lock.yaml' },
  { pm: 'yarn-classic', lockfile: 'yarn.lock', state: 'node_modules/.yarn-integrity' },
  { pm: 'yarn-berry', lockfile: 'yarn.lock', state: 'node_modules/.yarn-state.yml' },
])('depsOutOfSync with $pm install state', ({ pm, lockfile, state }) => {
  const fixture = (name: string) =>
    readFileSync(join(import.meta.dirname, 'fixtures', 'installed-deps', pm, name), 'utf-8');
  let base: string;
  let root: string;
  let target: string;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'stim-test-deps-'));
    root = join(base, 'src');
    target = join(base, 'wt');
    mkdirSync(join(target, state, '..'), { recursive: true });
    mkdirSync(root, { recursive: true });
    writeFileSync(join(target, state), fixture('installed.txt'));
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  test('accepts node_modules installed from this lockfile, checked out with CRLF, even when the source lockfile has moved on', () => {
    writeFileSync(join(root, lockfile), fixture('lockfile.next.txt'));
    writeFileSync(join(target, lockfile), fixture('lockfile.txt').replaceAll('\r\n', '\n').replaceAll('\n', '\r\n'));
    expect(depsOutOfSync(root, target, ['node_modules'])).toEqual([]);
  });
});

test('cloneIgnoredEntries against a real git repo never overwrites a path the destination tracks', async () => {
  const base = mkdtempSync(join(tmpdir(), 'stim-test-tracked-clone-'));
  const root = join(base, 'repo');
  const target = join(base, 'wt');
  try {
    mkdirSync(root, { recursive: true });
    const git = (cmd: string) => execSync(cmd, { cwd: root, encoding: 'utf-8' });
    git('git init -q -b main');
    git('git config user.email test@example.com');
    git('git config user.name test');
    mkdirSync(join(root, 'android/app'), { recursive: true });
    writeFileSync(join(root, '.gitignore'), '*.keystore\nbuild/\n');
    writeFileSync(join(root, 'android/app/App.java'), 'class App {}');
    git('git add -A');
    git('git commit -q -m "main: every keystore ignored"');

    git('git checkout -q -b feature');
    writeFileSync(join(root, '.gitignore'), '*.keystore\n!android/app/debug.keystore\nbuild/\n');
    writeFileSync(join(root, 'android/app/debug.keystore'), 'BRANCH-VERSION');
    git('git add -A');
    git('git commit -q -m "feature: track debug.keystore through a negation"');
    git('git checkout -q main');

    writeFileSync(join(root, 'android/app/debug.keystore'), 'SOURCE-MACHINE-LOCAL');
    mkdirSync(join(root, 'build'), { recursive: true });
    writeFileSync(join(root, 'build/artifact.txt'), 'output');

    git(`git worktree add -q "${target}" feature`);
    expect(readFileSync(join(target, 'android/app/debug.keystore'), 'utf-8')).toBe('BRANCH-VERSION');

    const { copied, skipped, failed } = await cloneIgnoredEntries({
      root,
      target,
      patterns: [],
      operation: copyContext(target),
    });

    expect(failed).toEqual([]);
    expect(readFileSync(join(target, 'android/app/debug.keystore'), 'utf-8')).toBe('BRANCH-VERSION');
    expect(!copied.includes('android/app/debug.keystore')).toBeTruthy();
    expect(skipped).toEqual([{ file: 'android/app/debug.keystore', reason: 'tracked' }]);
    expect(copied).toEqual(['build']);
    expect(readFileSync(join(target, 'build/artifact.txt'), 'utf-8')).toBe('output');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('carry against a real git repo leaves a tracked file under an ignored directory alone', async () => {
  const base = mkdtempSync(join(tmpdir(), 'stim-test-negation-'));
  const root = join(base, 'repo');
  const target = join(base, 'wt');
  try {
    mkdirSync(root, { recursive: true });
    const git = (cmd: string) => execSync(cmd, { cwd: root, encoding: 'utf-8' });
    git('git init -q -b main');
    git('git config user.email test@example.com');
    git('git config user.name test');
    mkdirSync(join(root, 'dir/sub'), { recursive: true });
    writeFileSync(join(root, '.gitignore'), 'dir/\n!dir/keep.txt\n');
    writeFileSync(join(root, 'dir/keep.txt'), 'BRANCH-VERSION');
    writeFileSync(join(root, 'dir/junk.txt'), 'junk');
    writeFileSync(join(root, 'dir/sub/deep.txt'), 'deep');
    git('git add .gitignore');
    git('git add -f dir/keep.txt');
    git('git commit -q -m init');

    git(`git worktree add -q "${target}" -b other main`);

    writeFileSync(join(root, 'dir/keep.txt'), 'SOURCE-MACHINE-LOCAL');

    const { copied, skipped, failed } = await cloneIgnoredEntries({
      root,
      target,
      patterns: [],
      operation: copyContext(target),
    });

    expect(failed).toEqual([]);
    expect(skipped).toEqual([]);
    expect(readFileSync(join(target, 'dir/keep.txt'), 'utf-8')).toBe('BRANCH-VERSION');
    expect(copied.toSorted()).toEqual(['dir/junk.txt', 'dir/sub']);
    expect(readFileSync(join(target, 'dir/junk.txt'), 'utf-8')).toBe('junk');
    expect(readFileSync(join(target, 'dir/sub/deep.txt'), 'utf-8')).toBe('deep');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('git runs against a real repo whose path holds a space, a dollar sign, and shell metacharacters (NTFS-legal set on win32)', async () => {
  resetExecutor();
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'stim-test-hostile-')));
  const root = join(base, process.platform === 'win32' ? "we 'ird $HOME & (id); repo" : 'we "ird $HOME `id` repo');
  try {
    mkdirSync(root, { recursive: true });
    const git = (cmd: string) => execSync(cmd, { cwd: root, encoding: 'utf-8' });
    git('git init -q -b main');
    git('git config user.email test@example.com');
    git('git config user.name test');
    git('git config core.autocrlf false');
    writeFileSync(join(root, '.gitignore'), 'secrets.env\n');
    writeFileSync(join(root, 'tracked.txt'), 'original\n');
    writeFileSync(join(root, 'secrets.env'), 'SECRET=1\n');
    git('git add .gitignore tracked.txt');
    git('git commit -q -m init');

    expect(repoRoot(root)).toBe(realpathSync(root));
    expect(gitCommonDir(root)).toBe(join(realpathSync(root), '.git'));
    expect(await hasUncommittedWorkAsync(root)).toBe(false);
    expect(await branchExistsAsync(root, 'main')).toBe(true);
    expect(await branchExistsAsync(root, 'missing')).toBe(false);
    expect(await hasRemoteAsync(root)).toBe(false);
    expect(await listTrackedPaths(root)).toEqual(['.gitignore', 'tracked.txt']);
    expect(await listGitignoredEntries(root)).toEqual(['secrets.env']);
    expect(listWorktrees(root)).toEqual([{ path: realpathSync(root), branch: 'main' }]);
    expect((await unpushedCommitsAsync(root))?.length).toBe(1);

    writeFileSync(join(root, 'tracked.txt'), 'dirty\n');
    expect(await hasUncommittedWorkAsync(root)).toBe(true);
    expect(await dirtyPathsAsync(root)).toEqual([' M tracked.txt']);
    expect(await restoreFileAsync(root, 'tracked.txt')).toBe(true);
    expect(readFileSync(join(root, 'tracked.txt'), 'utf-8')).toBe('original\n');
    expect(existsSync(join(root, 'PWNED'))).toBe(false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('selectSourceCheckout refuses when the bare HEAD branch is checked out more than once', () => {
  const entries = [
    { path: '/repo', bare: true },
    { path: '/repo/a', branch: 'main' },
    { path: '/repo/b', branch: 'main' },
  ];
  expect(selectSourceCheckout(entries, 'main')).toMatchObject({
    refusal: expect.stringMatching(/\/repo\/a.*\/repo\/b/),
  });
});

function copyContext(target: string) {
  const context = processContext(target);
  return { ...context, home: target, env: { ...context.env, STIM_HOME: target } };
}
