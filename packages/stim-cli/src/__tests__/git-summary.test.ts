import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ExecOptions, getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import { readWorktreeGit } from '../workspace/git-summary.ts';

'a'.repeat(40);

describe('readWorktreeGit', () => {
  const realExecutor = getExecutor();
  let base: string;
  let statusReads: number;
  let mergeCalls: number;
  let mergeTimesOut: boolean;
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf-8' });
  const commit = (cwd: string, file: string, message: string) => {
    writeFileSync(join(cwd, file), `${message}\n`);
    git(cwd, 'add', file);
    git(cwd, 'commit', '-qm', message);
  };

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'stim-git-summary-')));
    process.env.STIM_HOME = join(base, 'home');
    statusReads = 0;
    mergeCalls = 0;
    mergeTimesOut = false;
    setExecutor({
      runFileAsync: (file: string, args: string[], opts: ExecOptions) => {
        if (args.includes('status')) statusReads++;
        return realExecutor.runFileAsync(file, args, opts);
      },
      runFile: (file: string, args: string[], opts: ExecOptions) => {
        mergeCalls++;
        if (mergeTimesOut) throw Object.assign(new Error('git timed out'), { code: 'ETIMEDOUT' });
        return realExecutor.runFile(file, args, opts);
      },
      runFileQuiet: (file: string, args: string[], opts: ExecOptions) => realExecutor.runFileQuiet(file, args, opts),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    resetExecutor();
    delete process.env.STIM_HOME;
    rmSync(base, { recursive: true, force: true });
  });

  function linkedWorktree() {
    const root = join(base, 'repo');
    execFileSync('git', ['init', '-q', '-b', 'main', root]);
    git(root, 'config', 'user.name', 'test');
    git(root, 'config', 'user.email', 'test@example.com');
    git(root, 'config', 'commit.gpgsign', 'false');
    commit(root, 'a.txt', 'init');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', join(base, 'origin.git')]);
    git(root, 'remote', 'add', 'origin', join(base, 'origin.git'));
    git(root, 'push', '-q', '-u', 'origin', 'main');
    git(root, 'remote', 'set-head', 'origin', 'main');
    const path = join(base, 'feature-wt');
    git(root, 'worktree', 'add', '-q', '-b', 'feature', path);
    git(path, 'push', '-q', '-u', 'origin', 'feature');
    return { path, branch: 'feature', repository: root };
  }

  test('resolves deferred merge verdicts without rescanning unchanged worktree files', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const first = linkedWorktree();
    const worktrees = [first];
    for (let i = 0; i < 4; i++) {
      const worktree =
        i === 0 ? first : { path: join(base, `feature-${i}`), branch: `feature-${i}`, repository: first.repository };
      if (i > 0) {
        git(first.repository, 'worktree', 'add', '-q', '-b', worktree.branch, worktree.path);
        worktrees.push(worktree);
      }
      commit(worktree.path, `change-${i}.txt`, `feature ${i}`);
      git(first.repository, 'merge', '-q', '--no-ff', '-m', `merge ${i}`, worktree.branch);
    }
    git(first.repository, 'push', '-q', 'origin', 'main');
    setExecutor({
      ...getExecutor(),
      runFile: (file: string, args: string[], opts: ExecOptions) => {
        vi.setSystemTime(Date.now() + 300);
        return realExecutor.runFile(file, args, opts);
      },
    });
    const read = () => readWorktreeGit(worktrees, { skip: () => false, maxAgeMs: 60_000 });

    expect([...(await read()).values()].filter((summary) => summary?.mergedInto === 'origin/main')).toHaveLength(1);
    await read();
    const reads = statusReads;
    const expiresAt = Date.now() + 60_000;
    const pendingPath = join(base, 'feature-3');
    writeFileSync(join(pendingPath, 'change-3.txt'), 'edited\n');
    writeFileSync(join(pendingPath, 'untracked.txt'), 'new\n');
    await read();
    const result = await read();

    expect([...result.values()].every((summary) => summary?.mergedInto === 'origin/main')).toBe(true);
    expect(result.get(pendingPath)).toMatchObject({ changed: 0, untracked: 0 });
    expect(statusReads).toBe(reads);

    vi.setSystemTime(expiresAt);
    expect((await read()).get(pendingPath)).toMatchObject({ changed: 1, untracked: 1 });
    expect(statusReads).toBe(reads + worktrees.length);
  });

  test('a worktree git still lists after its directory was deleted is not reread until it comes back', async () => {
    const worktree = linkedWorktree();
    const read = async () =>
      (await readWorktreeGit([worktree], { skip: () => false, maxAgeMs: 60_000 })).get(worktree.path);
    await read();
    const reads = statusReads;
    rmSync(worktree.path, { recursive: true, force: true });
    expect(await read()).toBe(null);
    expect(await read()).toBe(null);
    expect(statusReads).toBe(reads + 1);

    git(worktree.repository, 'worktree', 'prune');
    git(worktree.repository, 'worktree', 'add', '-q', worktree.path, 'feature');
    expect(await read()).toMatchObject({ changed: 0 });
    expect(statusReads).toBe(reads + 2);
  });

  test('a merge judgement that timed out is not retried for the same HEAD for five minutes, but is for a new HEAD', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const worktree = linkedWorktree();
    commit(worktree.path, 'b.txt', 'local');
    mergeTimesOut = true;
    const read = () => readWorktreeGit([worktree], { skip: () => false });

    expect((await read()).get(worktree.path)?.mergedInto).toBe(null);
    const judged = mergeCalls;
    expect(judged).toBeGreaterThan(0);
    await read();
    expect(mergeCalls).toBe(judged);

    commit(worktree.path, 'c.txt', 'next');
    await read();
    const rejudged = mergeCalls;
    expect(rejudged).toBeGreaterThan(judged);
    await read();
    expect(mergeCalls).toBe(rejudged);

    vi.setSystemTime(Date.now() + 5 * 60_000);
    await read();
    expect(mergeCalls).toBeGreaterThan(rejudged);
  });
});
