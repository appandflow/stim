import { execFileSync, execSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { worktreeArchiveRoot } from '@stim-cli/core/state';
import { enforceArchiveRetention } from '../archive.ts';
import { archiveWorktreeChanges, worktreeArchiveMismatch } from '../workspace/worktree-archive.ts';

let home: string;
let repo: string;
let worktree: string;

const git = (cwd: string, args: string) => execSync(`git ${args}`, { cwd, encoding: 'utf-8', timeout: 30_000 }).trim();

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'stim-worktree-archive-')));
  process.env.STIM_HOME = join(home, 'stim');
  process.env.STIM_ARCHIVE_ENABLED = 'true';
  repo = join(home, 'repo');
  mkdirSync(repo);
  git(repo, 'init -q -b main');
  git(repo, 'config user.email test@example.com');
  git(repo, 'config user.name test');
  writeFileSync(join(repo, '.gitignore'), 'build/\n');
  writeFileSync(join(repo, 'a.txt'), 'original\n');
  writeFileSync(join(repo, 'c.txt'), 'doomed\n');
  writeFileSync(join(repo, 'bin.dat'), Buffer.from([0, 1, 2, 3, 255]));
  git(repo, 'add -A');
  git(repo, 'commit -q -m init');
  worktree = join(home, 'wt');
  git(repo, `worktree add -q -b topic "${worktree}"`);
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  for (const key of Object.keys(process.env))
    if (key === 'STIM_HOME' || key.startsWith('STIM_ARCHIVE_')) delete process.env[key];
});

function dirtyTheWorktree(): void {
  writeFileSync(join(worktree, 'a.txt'), 'edited\n');
  writeFileSync(join(worktree, 'b.txt'), 'staged\n');
  git(worktree, 'add b.txt');
  unlinkSync(join(worktree, 'c.txt'));
  writeFileSync(join(worktree, 'bin.dat'), Buffer.from([9, 0, 8, 0, 7]));
  mkdirSync(join(worktree, 'notes'));
  writeFileSync(join(worktree, 'notes', 'scratch file.txt'), 'scratch\n');
  mkdirSync(join(worktree, 'build'));
  writeFileSync(join(worktree, 'build', 'output.o'), 'ignored');
}

async function archive() {
  return archiveWorktreeChanges({
    path: worktree,
    repository: repo,
    branch: 'topic',
    head: git(worktree, 'rev-parse HEAD'),
    pullRequest: { number: 12, url: 'https://github.com/o/r/pull/12', state: 'merged' },
  });
}

test('the archive of a dirty worktree restores its tracked, staged, deleted, binary and untracked changes, and no ignored file', async () => {
  dirtyTheWorktree();
  const saved = await archive();

  const manifest = JSON.parse(readFileSync(join(saved.dir, 'manifest.json'), 'utf8'));
  expect(manifest).toMatchObject({
    branch: 'topic',
    pullRequest: { number: 12 },
    tracked: ['a.txt', 'b.txt', 'bin.dat', 'c.txt'],
    untracked: ['notes/scratch file.txt'],
    restore: saved.restore,
  });
  git(repo, `worktree remove --force "${worktree}"`);
  for (const command of saved.restore) execFileSync('sh', ['-c', command], { timeout: 30_000, stdio: 'pipe' });

  expect(readFileSync(join(worktree, 'a.txt'), 'utf8')).toBe('edited\n');
  expect(readFileSync(join(worktree, 'b.txt'), 'utf8')).toBe('staged\n');
  expect(existsSync(join(worktree, 'c.txt'))).toBe(false);
  expect([...readFileSync(join(worktree, 'bin.dat'))]).toEqual([9, 0, 8, 0, 7]);
  expect(readFileSync(join(worktree, 'notes', 'scratch file.txt'), 'utf8')).toBe('scratch\n');
  expect(existsSync(join(worktree, 'build'))).toBe(false);
}, 60_000);

test('an archive no longer describes the worktree once an archived file changes or a new one appears', async () => {
  dirtyTheWorktree();
  const saved = await archive();
  expect(await worktreeArchiveMismatch(worktree, saved)).toBe(null);

  writeFileSync(join(worktree, 'notes', 'late.txt'), 'late');
  expect(await worktreeArchiveMismatch(worktree, saved)).toMatch(/changed while they were archived/);
  unlinkSync(join(worktree, 'notes', 'late.txt'));
  writeFileSync(join(worktree, 'a.txt'), 'edited again\n');
  expect(await worktreeArchiveMismatch(worktree, saved)).not.toBe(null);
}, 60_000);

test('nothing is archived when archives are off for the worktree', async () => {
  process.env.STIM_ARCHIVE_ENABLED = 'false';
  dirtyTheWorktree();

  await expect(archive()).rejects.toThrow(/archive\.enabled is false/);
  expect(existsSync(worktreeArchiveRoot())).toBe(false);
}, 60_000);

test('retention deletes worktree archives past archive.maxAgeDays, then the oldest while over archive.maxTotalGb', async () => {
  const day = 86_400_000;
  const now = Date.now();
  const plant = (name: string, ageDays: number, bytes: number) => {
    const dir = join(worktreeArchiveRoot(), 'repo', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'manifest.json'),
      JSON.stringify({ createdAt: new Date(now - ageDays * day).toISOString() }),
    );
    writeFileSync(join(dir, 'untracked.tar'), Buffer.alloc(bytes));
    return dir;
  };
  const expired = plant('expired', 40, 10);
  const oldest = plant('oldest', 3, 600);
  const newest = plant('newest', 1, 600);
  process.env.STIM_ARCHIVE_MAX_AGE_DAYS = '30';
  process.env.STIM_ARCHIVE_MAX_TOTAL_GB = String(1000 / 1024 ** 3);

  await enforceArchiveRetention(now);

  expect(existsSync(expired)).toBe(false);
  expect(existsSync(oldest)).toBe(false);
  expect(existsSync(newest)).toBe(true);
  expect(readdirSync(join(worktreeArchiveRoot(), 'repo'))).toEqual(['newest']);
});
