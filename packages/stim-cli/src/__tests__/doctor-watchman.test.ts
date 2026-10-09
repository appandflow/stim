import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import {
  inspectNestedWorktrees,
  mergeIgnoreDirs,
  nestedWorktreeFinding,
  nestedWorktreeIgnores,
  writeIgnoreDirs,
} from '../diagnostics/doctor-watchman.ts';

const checkout = '/repo';
const noSource = (): boolean => false;
const source = (dir: string): boolean => dir === 'packages';

test('worktrees sharing one parent inside the checkout are ignored through that parent', () => {
  expect(nestedWorktreeIgnores(checkout, ['/repo', '/repo/.worktrees/b', '/repo/.worktrees/a'], [], noSource)).toEqual({
    nested: ['.worktrees/a', '.worktrees/b'],
    add: ['.worktrees'],
  });
  expect(nestedWorktreeIgnores(checkout, ['/repo', '/repo/.worktrees/a'], [], noSource)).toEqual({
    nested: ['.worktrees/a'],
    add: ['.worktrees'],
  });
});

test('worktrees outside the checkout, including a sibling with a shared name prefix, are not nested', () => {
  expect(nestedWorktreeIgnores(checkout, ['/repo', '/repo-wt/a', '/other/b'], [], noSource)).toEqual({
    nested: [],
    add: [],
  });
  expect(nestedWorktreeIgnores(checkout, ['/repo', '/repo/..worktrees/a'], [], noSource).nested).toEqual([
    '..worktrees/a',
  ]);
});

test('scattered worktrees, or ones directly under the checkout root, are listed one by one', () => {
  expect(nestedWorktreeIgnores(checkout, ['/repo', '/repo/wt-a', '/repo/tmp/wt-b'], [], noSource)).toEqual({
    nested: ['tmp/wt-b', 'wt-a'],
    add: ['tmp/wt-b', 'wt-a'],
  });
  expect(nestedWorktreeIgnores(checkout, ['/repo', '/repo/wt-a', '/repo/wt-b'], [], noSource).add).toEqual([
    'wt-a',
    'wt-b',
  ]);
});

test('a shared parent that holds tracked source is never ignored; each worktree is listed instead', () => {
  expect(nestedWorktreeIgnores(checkout, ['/repo', '/repo/packages/wt-a', '/repo/packages/wt-b'], [], source)).toEqual({
    nested: ['packages/wt-a', 'packages/wt-b'],
    add: ['packages/wt-a', 'packages/wt-b'],
  });
});

test('only an ignore_dirs entry spelled as the worktree path or an ancestor covers it, as Watchman matches', () => {
  const worktrees = ['/repo', '/repo/.worktrees/a', '/repo/wt-b'];
  expect(nestedWorktreeIgnores(checkout, worktrees, ['.worktrees', 'wt-b'], noSource).nested).toEqual([]);
  expect(nestedWorktreeIgnores(checkout, worktrees, ['.worktrees/a'], noSource).nested).toEqual(['wt-b']);
  expect(nestedWorktreeIgnores(checkout, worktrees, ['.worktrees/', './wt-b', '.work'], noSource).nested).toEqual([
    '.worktrees/a',
    'wt-b',
  ]);
});

test('the merge creates ignore_dirs, appends without duplicates, and keeps every other key', () => {
  expect(mergeIgnoreDirs({ kind: 'absent' }, ['.worktrees'])).toEqual({ value: { ignore_dirs: ['.worktrees'] } });
  expect(
    mergeIgnoreDirs({ kind: 'object', value: { fsevents_latency: 0.5, ignore_vcs: ['.git'] } }, ['.worktrees']),
  ).toEqual({ value: { fsevents_latency: 0.5, ignore_vcs: ['.git'], ignore_dirs: ['.worktrees'] } });
  expect(
    mergeIgnoreDirs({ kind: 'object', value: { ignore_dirs: ['build', '.worktrees'] } }, ['.worktrees', 'wt-a']),
  ).toEqual({ value: { ignore_dirs: ['build', '.worktrees', 'wt-a'] } });
});

test('the merge refuses a file that is not a JSON object or whose ignore_dirs is not an array', () => {
  expect(mergeIgnoreDirs({ kind: 'invalid', reason: 'is not a JSON object' }, ['.worktrees'])).toHaveProperty(
    'refusal',
  );
  expect(mergeIgnoreDirs({ kind: 'object', value: { ignore_dirs: 'build' } }, ['.worktrees'])).toHaveProperty(
    'refusal',
  );
});

test('an unparseable .watchmanconfig is reported with a manual remedy and left untouched', () => {
  const finding = nestedWorktreeFinding(
    {
      checkout,
      configPath: '/repo/.watchmanconfig',
      config: { kind: 'invalid', reason: 'is not a JSON object' },
      nested: ['.worktrees/a'],
      add: ['.worktrees'],
    },
    false,
  );
  expect(finding.fix).not.toContain('stim doctor --fix');
});

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore' });
}

test('a real repository: canonical containment through a symlinked temp dir, then the written file is clean', () => {
  const dir = mkdtempSync(join(tmpdir(), 'stim-watchman-'));
  try {
    git(dir, 'init', '-q', '-b', 'main');
    git(
      dir,
      '-c',
      'user.email=t@t',
      '-c',
      'user.name=t',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'init',
    );
    git(dir, 'worktree', 'add', '-q', '-b', 'a', join(dir, '.worktrees', 'a'));
    git(dir, 'worktree', 'add', '-q', '-b', 'b', join(dir, '.worktrees', 'b'));
    writeFileSync(join(dir, '.watchmanconfig'), '{"ignore_vcs": [".git"]}');

    const [entry, ...rest] = inspectNestedWorktrees(join(dir, '.worktrees', 'a'));
    expect(rest).toEqual([]);
    expect(entry?.add).toEqual(['.worktrees']);
    expect(entry && writeIgnoreDirs(entry)).toEqual({ status: 'updated' });
    expect(JSON.parse(readFileSync(join(dir, '.watchmanconfig'), 'utf-8'))).toEqual({
      ignore_vcs: ['.git'],
      ignore_dirs: ['.worktrees'],
    });
    expect(inspectNestedWorktrees(dir)).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
