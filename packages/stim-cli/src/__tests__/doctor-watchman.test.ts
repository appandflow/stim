import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import {
  inspectNestedWorktrees,
  mergeIgnoreDirs,
  nestedWorktreeFinding,
  writeIgnoreDirs,
} from '../diagnostics/doctor-watchman.ts';

const checkout = '/repo';

test('the merge creates ignore_dirs, appends without duplicates, and keeps every other key', () => {
  expect(mergeIgnoreDirs({ kind: 'absent' }, ['.worktrees'])).toEqual({ value: { ignore_dirs: ['.worktrees'] } });
  expect(
    mergeIgnoreDirs({ kind: 'object', value: { fsevents_latency: 0.5, ignore_vcs: ['.git'] } }, ['.worktrees']),
  ).toEqual({ value: { fsevents_latency: 0.5, ignore_vcs: ['.git'], ignore_dirs: ['.worktrees'] } });
  expect(
    mergeIgnoreDirs({ kind: 'object', value: { ignore_dirs: ['build', '.worktrees'] } }, ['.worktrees', 'wt-a']),
  ).toEqual({ value: { ignore_dirs: ['build', '.worktrees', 'wt-a'] } });
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

test('a real repository: canonical containment through a symlinked temp dir, then the written file is clean', async () => {
  resetExecutor();
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

    const executor = getExecutor();
    const delayed = (file: string, args: string[]) =>
      file === 'git' && args.includes('ls-files')
        ? {
            file: process.execPath,
            args: [
              '-e',
              "setTimeout(() => { const { spawnSync } = require('node:child_process'); const result = spawnSync('git', process.argv.slice(1), { stdio: 'inherit' }); process.exit(result.status ?? 1); }, 200)",
              '--',
              ...args,
            ],
          }
        : { file, args };
    setExecutor({
      ...executor,
      runFileQuiet(file, args, options) {
        const call = delayed(file, args);
        return executor.runFileQuiet(call.file, call.args, options);
      },
      runFileAsync(file, args, options) {
        const call = delayed(file, args);
        return executor.runFileAsync(call.file, call.args, options);
      },
    });
    const started = Date.now();
    let finished = false;
    const pending = Promise.resolve(inspectNestedWorktrees(join(dir, '.worktrees', 'a'))).then((entries) => {
      finished = true;
      return entries;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(Date.now() - started).toBeLessThan(150);
    expect(finished).toBe(false);
    const [entry, ...rest] = await pending;
    resetExecutor();
    expect(rest).toEqual([]);
    expect(entry?.add).toEqual(['.worktrees']);
    expect(entry && writeIgnoreDirs(entry)).toEqual({ status: 'updated' });
    expect(JSON.parse(readFileSync(join(dir, '.watchmanconfig'), 'utf-8'))).toEqual({
      ignore_vcs: ['.git'],
      ignore_dirs: ['.worktrees'],
    });
    expect(await inspectNestedWorktrees(dir)).toEqual([]);

    writeFileSync(join(dir, '.watchmanconfig'), '{"ignore_vcs": [".git"]}');
    writeFileSync(join(dir, '.worktrees', 'source.ts'), 'export const source = true;');
    git(dir, 'add', '.worktrees/source.ts');
    expect((await inspectNestedWorktrees(dir))[0]?.add).toEqual(['.worktrees/a', '.worktrees/b']);
  } finally {
    resetExecutor();
    rmSync(dir, { recursive: true, force: true });
  }
});
