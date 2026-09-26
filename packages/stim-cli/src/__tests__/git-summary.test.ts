import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import { inPrivacyProtectedFolder, parseGitStatus, readWorktreeGit } from '../workspace/git-summary.ts';

const oid = 'a'.repeat(40);

test('parseGitStatus counts changed and untracked entries and reads ahead and behind', () => {
  const text = [
    `# branch.oid ${oid}`,
    '# branch.head feature',
    '# branch.upstream origin/feature',
    '# branch.ab +3 -1',
    `1 .M N... 100644 100644 100644 ${oid} ${oid} src/a.ts`,
    `1 A. N... 000000 100644 100644 ${'0'.repeat(40)} ${oid} src/b.ts`,
    `2 R. N... 100644 100644 100644 ${oid} ${oid} R100 src/c.ts\tsrc/old c.ts`,
    `u UU N... 100644 100644 100644 100644 ${oid} ${oid} ${oid} src/d.ts`,
    '? scratch/',
    '? notes.txt',
  ].join('\n');
  expect(parseGitStatus(text)).toEqual({
    head: oid,
    changed: 4,
    untracked: 2,
    upstream: 'origin/feature',
    ahead: 3,
    behind: 1,
  });
});

test('parseGitStatus leaves ahead and behind null when the upstream is gone or missing, and head null when unborn', () => {
  expect(parseGitStatus(`# branch.oid ${oid}\n# branch.head feature\n# branch.upstream origin/feature`)).toEqual({
    head: oid,
    changed: 0,
    untracked: 0,
    upstream: 'origin/feature',
    ahead: null,
    behind: null,
  });
  expect(parseGitStatus('# branch.oid (initial)\n# branch.head main\n? a.txt')).toMatchObject({
    head: null,
    untracked: 1,
    upstream: null,
    ahead: null,
  });
});

test('inPrivacyProtectedFolder matches the folders macOS guards and nothing that only shares a prefix', () => {
  const home = '/Users/me';
  expect(inPrivacyProtectedFolder('/Users/me/Documents/Codex/stim', home)).toBe(true);
  expect(inPrivacyProtectedFolder('/Users/me/Library/Mobile Documents/repo', home)).toBe(true);
  expect(inPrivacyProtectedFolder('/Users/me/Library/CloudStorage/Dropbox/repo', home)).toBe(true);
  expect(inPrivacyProtectedFolder('/Volumes/External/repo', home)).toBe(true);
  expect(inPrivacyProtectedFolder('/Users/me/Documentsx/repo', home)).toBe(false);
  expect(inPrivacyProtectedFolder('/Users/me/Developer/Documents', home)).toBe(false);
});

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
      runFileAsync: (file: string, args: string[], opts: object) => {
        if (args.includes('status')) statusReads++;
        return realExecutor.runFileAsync(file, args, opts);
      },
      runFile: (file: string, args: string[], opts: object) => {
        mergeCalls++;
        if (mergeTimesOut) throw Object.assign(new Error('git timed out'), { code: 'ETIMEDOUT' });
        return realExecutor.runFile(file, args, opts);
      },
      runFileQuiet: (file: string, args: string[], opts: object) => realExecutor.runFileQuiet(file, args, opts),
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

  test('reuses a summary while its git files are unchanged, and rereads after a commit, a push or the age ceiling', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const worktree = linkedWorktree();
    const read = async () =>
      (await readWorktreeGit([worktree], { skip: () => false, maxAgeMs: 60_000 })).get(worktree.path);

    await read();
    await read();
    const reads = statusReads;
    expect(await read()).toMatchObject({ changed: 0, ahead: 0, behind: 0 });
    expect(statusReads).toBe(reads);

    writeFileSync(join(worktree.path, 'a.txt'), 'edited\n');
    expect(await read()).toMatchObject({ changed: 0 });
    expect(statusReads).toBe(reads);

    commit(worktree.path, 'b.txt', 'local');
    expect(await read()).toMatchObject({ changed: 1, ahead: 1 });
    expect(statusReads).toBe(reads + 1);

    git(worktree.path, 'push', '-q');
    expect(await read()).toMatchObject({ ahead: 0, mergedInto: null });
    expect(statusReads).toBe(reads + 2);

    git(worktree.repository, 'merge', '-q', '--no-ff', '-m', 'merge feature', 'feature');
    git(worktree.repository, 'push', '-q', 'origin', 'main');
    expect(await read()).toMatchObject({ mergedInto: 'origin/main' });
    expect(statusReads).toBe(reads + 3);

    writeFileSync(join(worktree.path, 'b.txt'), 'edited\n');
    expect(await read()).toMatchObject({ changed: 1 });
    expect(statusReads).toBe(reads + 3);
    vi.setSystemTime(Date.now() + 60_000);
    expect(await read()).toMatchObject({ changed: 2 });
    expect(statusReads).toBe(reads + 4);
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
