import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearWorkspaceOutputs, collectWorkspaceOutputs } from '../commands/gc/workspaces.ts';
import { upsertProject } from '../workspace/config.ts';
import { ensureWorkspaceStorage, workspaceDir } from '../workspace/paths.ts';
import { recordWorkspaceUse } from '../workspace/workspace-state.ts';

let home: string;
let apps: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-outputs-lock-'));
  apps = realpathSync(mkdtempSync(join(tmpdir(), 'stim-outputs-lock-apps-')));
  process.env.STIM_HOME = home;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(apps, { recursive: true, force: true });
  delete process.env.STIM_HOME;
});

test('clearing re-reads the lock a worktree gained after the report was made', async () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { cwd, timeout: 15_000 });
  const repo = join(apps, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'init');
  const worktree = join(apps, 'later-locked');
  git(repo, 'worktree', 'add', '-q', '--detach', worktree);
  const root = realpathSync(worktree);
  upsertProject(root, { isExpo: false });
  mkdirSync(join(ensureWorkspaceStorage(root), 'derived-data', 'Build'), { recursive: true });
  recordWorkspaceUse(root, new Date(Date.now() - 60 * 60_000));
  const report = await collectWorkspaceOutputs({
    olderThan: null,
    now: Date.now(),
    measure: false,
    signal: new AbortController().signal,
  });
  expect(report.workspaces.find((entry) => entry.projectRoot === root)?.willClear).toBe(true);
  git(repo, 'worktree', 'lock', worktree);
  await clearWorkspaceOutputs(
    report,
    { olderThan: null },
    { log: () => {}, error: () => {}, record: () => {}, fail: () => {} },
  );
  expect(existsSync(join(workspaceDir(root), 'derived-data'))).toBe(true);
});
