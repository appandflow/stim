import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeState } from '../workspace/merge-state.ts';

let projects: string;

beforeEach(() => {
  projects = mkdtempSync(join(tmpdir(), 'stim-merge-state-'));
});

afterEach(() => {
  rmSync(projects, { recursive: true, force: true });
});

function git(repo: string, args: string): string {
  return execSync(`git ${args}`, { cwd: repo, encoding: 'utf-8', stdio: 'pipe' }).trim();
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

function commit(repo: string, file: string, content: string, message = content): void {
  writeFileSync(join(repo, file), content);
  git(repo, `add ${file}`);
  git(repo, `commit -q -m "${message}"`);
}

test('keeps a branch far past the merge base as unknown, naming the commit count', () => {
  const repo = initRepo('far-ahead');
  git(repo, 'checkout -q -b feature');
  for (let i = 0; i < 6; i++) commit(repo, `f${i}.txt`, `feature ${i}`);

  const result = mergeState(repo, { ref: 'refs/heads/main', name: 'main' }, { maxCommits: 5 });
  expect(result).toMatchObject({ merged: false, unknown: true });
  expect((result as { detail: string }).detail).toBe(
    'merge state unknown: 6 commits since the merge base with main exceeds the 5-commit limit',
  );
});

test('resolves normally when the branch stays within the commit limit', () => {
  const repo = initRepo('rebase-merge');
  git(repo, 'checkout -q -b feature');
  commit(repo, 'a.txt', 'a');
  const featureHead = git(repo, 'rev-parse HEAD');
  // Same file content as the feature commit gives it the same patch-id, so this stands in for a
  // rebase-merge landing that commit on main under a different SHA and message.
  git(repo, 'checkout -q main');
  commit(repo, 'a.txt', 'a', 'landed a');
  git(repo, `checkout -q -B feature ${featureHead}`);

  const result = mergeState(repo, { ref: 'refs/heads/main', name: 'main' }, { maxCommits: 5 });
  expect(result).toMatchObject({ merged: true, into: 'main' });
});
