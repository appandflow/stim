import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearWorkspaceOutputs, collectWorkspaceOutputs } from '../commands/gc/workspaces.ts';
import { upsertProject } from '../workspace/config.ts';
import { ensureWorkspaceStorage, workspaceDir } from '../workspace/paths.ts';
import { recordWorkspaceUse } from '../workspace/workspace-state.ts';
import type { GcOutput } from '../commands/gc/results.ts';

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

test.skipIf(process.platform === 'win32')(
  'lightening a workspace whose Cargo target the delete keeps records nothing freed (Cargo targets are kept on win32)',
  async () => {
    const git = (cwd: string, ...args: string[]) =>
      execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { cwd, timeout: 15_000 });
    const repo = join(apps, 'repo');
    mkdirSync(repo);
    writeFileSync(join(repo, '.gitignore'), 'target/\n');
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'init');
    const worktree = join(apps, 'program');
    git(repo, 'worktree', 'add', '-q', '--detach', worktree);
    const root = realpathSync(worktree);
    upsertProject(root, { isExpo: false });
    ensureWorkspaceStorage(root);
    const target = join(root, 'target');
    mkdirSync(join(target, 'deploy'), { recursive: true });
    writeFileSync(join(target, 'CACHEDIR.TAG'), 'Signature: 8a477f597d28d172789f06886806bc55\n');
    writeFileSync(join(target, 'deploy', 'app-keypair.json'), '[1]');
    writeFileSync(join(target, 'deploy', 'app.so'), Buffer.alloc(100_000, 1));
    const old = new Date(Date.now() - 3 * 24 * 3_600_000);
    for (const path of [join(target, 'deploy', 'app.so'), join(target, 'deploy'), target]) utimesSync(path, old, old);
    recordWorkspaceUse(root, new Date(Date.now() - 3 * 24 * 3_600_000));
    const report = await collectWorkspaceOutputs({ olderThan: null, now: Date.now(), lighten: true });
    expect(report.workspaces.find((entry) => entry.projectRoot === root)?.willClear).toBe(true);
    const records: Parameters<GcOutput['record']>[] = [];

    await clearWorkspaceOutputs(
      report,
      { olderThan: null, lighten: true },
      { log: () => {}, error: () => {}, record: (...args) => records.push(args), fail: () => {} },
    );

    expect(records).toEqual([['workspaceOutputs', 'kept', root, expect.objectContaining({ bytes: 0 })]]);
    expect(existsSync(join(target, 'deploy', 'app.so'))).toBe(true);
  },
);
