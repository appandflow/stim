import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import { mergeState } from '../workspace/merge-state.ts';

let projects: string;

beforeEach(() => {
  projects = mkdtempSync(join(tmpdir(), 'stim-merge-state-'));
});

afterEach(() => {
  resetExecutor();
  rmSync(projects, { recursive: true, force: true });
});

function git(repo: string, args: string, env: NodeJS.ProcessEnv = {}): string {
  return execSync(`git ${args}`, {
    cwd: repo,
    encoding: 'utf-8',
    stdio: 'pipe',
    env: { ...process.env, ...env },
  }).trim();
}

function initRepo(name: string): string {
  const repo = join(projects, name);
  mkdirSync(repo);
  git(repo, 'init -q -b main');
  git(repo, 'config user.email test@example.com');
  git(repo, 'config user.name test');
  git(repo, 'config commit.gpgsign false');
  git(repo, 'commit -q --allow-empty -m init');
  return repo;
}

function commit(repo: string, file: string, content: string, message = content, env: NodeJS.ProcessEnv = {}): void {
  writeFileSync(join(repo, file), content);
  git(repo, `add ${file}`);
  git(repo, `commit -q -m "${message}"`, env);
}

test('keeps a branch far past the merge base as unknown, naming the commit count', () => {
  const repo = initRepo('far-ahead');
  git(repo, 'checkout -q -b feature');
  for (let i = 0; i < 6; i++) commit(repo, `f${i}.txt`, `feature ${i}`);

  const result = mergeState(repo, { ref: 'refs/heads/main', name: 'main' }, { maxCommits: 5 });
  expect(result).toMatchObject({ merged: false, unknown: true });
  expect((result as { detail: string }).detail).toBe(
    'merge state unknown: 6 commits of its own ahead of the merge base with main exceeds the 5-commit limit',
  );
});

test('resolves a rebase merge of several commits landed under different SHAs, dated by the last one', () => {
  const repo = initRepo('rebase-merge');
  git(repo, 'checkout -q -b feature');
  commit(repo, 'a.txt', 'a');
  commit(repo, 'b.txt', 'b');
  const featureHead = git(repo, 'rev-parse HEAD');
  // Same file contents as the feature commits give them the same patch-ids, so this stands in for
  // a rebase merge landing both commits on main under different SHAs, messages, and dates.
  git(repo, 'checkout -q main');
  commit(repo, 'a.txt', 'a', 'landed a', { GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' });
  commit(repo, 'b.txt', 'b', 'landed b', { GIT_COMMITTER_DATE: '2026-01-02T00:00:00Z' });
  git(repo, `checkout -q -B feature ${featureHead}`);

  const result = mergeState(repo, { ref: 'refs/heads/main', name: 'main' }, { maxCommits: 5 });
  expect(result).toMatchObject({ merged: true, into: 'main', mergedAt: Date.parse('2026-01-02T00:00:00Z') });
});

test('passes the changed-file pathspec through stdin, not argv, so a long list cannot overflow argv (stim#1815)', () => {
  const repo = initRepo('many-files');
  const files = Array.from({ length: 20 }, (_, i) => `file-${i}.txt`);
  git(repo, 'checkout -q -b feature');
  for (const file of files) writeFileSync(join(repo, file), 'x');
  git(repo, `add ${files.join(' ')}`);
  git(repo, 'commit -q -m "add many files"');
  const featureHead = git(repo, 'rev-parse HEAD');
  git(repo, 'checkout -q main');
  for (const file of files) writeFileSync(join(repo, file), 'x');
  git(repo, `add ${files.join(' ')}`);
  git(repo, 'commit -q -m "landed many files"');
  git(repo, `checkout -q -B feature ${featureHead}`);

  const real = getExecutor();
  const logCalls: { args: string[]; input?: string }[] = [];
  setExecutor({
    ...real,
    runFile: (file, args = [], opts) => {
      if (file === 'git' && args.includes('log')) logCalls.push({ args: [...args], input: opts?.input });
      return real.runFile(file, args, opts);
    },
  });

  const result = mergeState(repo, { ref: 'refs/heads/main', name: 'main' }, { maxCommits: 5 });
  expect(result).toMatchObject({ merged: true, into: 'main' });
  expect(logCalls.length).toBeGreaterThan(0);
  for (const call of logCalls) expect(call.args.join(' ')).not.toContain('file-0.txt');
  expect(logCalls.some((call) => call.input?.includes('file-0.txt'))).toBe(true);
});
