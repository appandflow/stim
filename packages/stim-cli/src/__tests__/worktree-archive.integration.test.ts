import { execFileSync, execSync } from 'node:child_process';
import {
  chmodSync,
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
import { dirname, join } from 'node:path';
import { clearFreeClaimSet, releaseClaim, tryAcquireClaim } from '@stim-cli/core/ownership-claim';
import { gcMarkFile, readGcMark, GC_MARK_VERSION, worktreeArchiveRoot } from '@stim-cli/core/state';
import { upsertProject } from '../workspace/config.ts';
import * as worktreeGit from '../workspace/worktree.ts';
import { markWriter } from '../daemon/marks.ts';
import { enforceArchiveRetention } from '../archive.ts';
import { removeWorktreeTarget } from '../commands/worktree.ts';
import {
  archiveWorktreeChanges,
  releaseWorktreeArchive,
  uncommittedActivityOf,
  worktreeArchiveMismatch,
  type WorktreeArchive,
} from '../workspace/worktree-archive.ts';

const trashHook = vi.hoisted((): { beforeMove?: () => void } => ({}));
vi.mock('../workspace/worktree-trash.ts', async (importOriginal) => {
  const trash = await importOriginal<typeof import('../workspace/worktree-trash.ts')>();
  return {
    ...trash,
    moveIgnoredTreesToTrash: async (...args: Parameters<typeof trash.moveIgnoredTreesToTrash>) => {
      trashHook.beforeMove?.();
      return trash.moveIgnoredTreesToTrash(...args);
    },
  };
});

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
  trashHook.beforeMove = undefined;
  rmSync(home, { recursive: true, force: true });
  for (const key of Object.keys(process.env))
    if (key === 'STIM_HOME' || key.startsWith('STIM_ARCHIVE_')) delete process.env[key];
});

function saveMark(root: string): string {
  const file = gcMarkFile(root);
  mkdirSync(dirname(file), { recursive: true });
  const text = JSON.stringify({
    v: GC_MARK_VERSION,
    root,
    device: 1,
    markedAt: new Date().toISOString(),
    lastActivityAt: null,
    candidates: [],
  });
  writeFileSync(file, text);
  return text;
}

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

test.skipIf(process.platform === 'win32')(
  'the archive of a dirty worktree restores its tracked, staged, deleted, binary and untracked changes, and no ignored file',
  async () => {
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
  },
  60_000,
);

test.skipIf(process.platform === 'win32')(
  'the archive restores a HEAD that no branch keeps once git has collected it',
  async () => {
    const remote = join(home, 'origin.git');
    git(home, `init -q --bare -b main "${remote}"`);
    git(repo, `remote add origin "${remote}"`);
    git(repo, 'push -q origin main');
    git(repo, 'remote set-head origin main');
    writeFileSync(join(worktree, 'feature.txt'), 'feature\n');
    git(worktree, 'add feature.txt');
    git(worktree, 'commit -q -m feature');
    const head = git(worktree, 'rev-parse HEAD');
    writeFileSync(join(worktree, 'scratch.txt'), 'scratch\n');
    const saved = await archive();
    expect(existsSync(join(saved.dir, 'head.bundle'))).toBe(true);

    git(repo, `worktree remove --force "${worktree}"`);
    git(repo, 'branch -D topic');
    git(repo, 'reflog expire --expire=now --all');
    git(repo, 'gc -q --prune=now');
    expect(() => git(repo, `cat-file -e ${head}`)).toThrow(/Command failed/);
    for (const command of saved.restore) execFileSync('sh', ['-c', command], { timeout: 30_000, stdio: 'pipe' });

    expect(git(worktree, 'rev-parse HEAD')).toBe(head);
    expect(readFileSync(join(worktree, 'feature.txt'), 'utf8')).toBe('feature\n');
    expect(readFileSync(join(worktree, 'scratch.txt'), 'utf8')).toBe('scratch\n');
  },
  120_000,
);

test('a recent deletion counts as uncommitted activity through its parent directory', async () => {
  const sub = join(worktree, 'docs');
  mkdirSync(sub);
  writeFileSync(join(sub, 'old.txt'), 'old\n');
  git(worktree, 'add docs/old.txt');
  git(worktree, 'commit -q -m docs');
  const before = Date.now();
  unlinkSync(join(sub, 'old.txt'));

  const activity = await uncommittedActivityOf(worktree);

  expect(activity).toMatchObject({ basis: 'an uncommitted file change' });
  expect(activity !== null && activity !== 'unreadable' && activity.at >= before - 1000).toBe(true);
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

test('a staged version the working tree no longer holds keeps the worktree instead of being archived', async () => {
  writeFileSync(join(worktree, 'a.txt'), 'staged only\n');
  git(worktree, 'add a.txt');
  writeFileSync(join(worktree, 'a.txt'), 'original\n');

  await expect(archive()).rejects.toThrow(/staged content of a\.txt differs/);
  expect(existsSync(worktreeArchiveRoot())).toBe(false);
}, 60_000);

test('worktree removal with archiveDirty archives and removes a dirty worktree, and keeps one it cannot archive', async () => {
  const mark = saveMark(worktree);
  const sourceMark = saveMark(repo);
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  onTestFinished(() => error.mockRestore());
  const saved: WorktreeArchive[] = [];
  const options = {
    linkedOnly: true,
    archiveDirty: { pullRequest: null, onArchived: (archived: WorktreeArchive) => saved.push(archived) },
  };
  writeFileSync(join(worktree, 'scratch.txt'), 'scratch\n');
  process.env.STIM_ARCHIVE_ENABLED = 'false';

  expect(await removeWorktreeTarget(worktree, options)).toBe(false);
  expect(readFileSync(gcMarkFile(worktree), 'utf8')).toBe(mark);
  expect(existsSync(join(worktree, 'scratch.txt'))).toBe(true);
  expect(error.mock.calls.flat().join('\n')).toContain('could not archive its uncommitted changes');

  process.env.STIM_ARCHIVE_ENABLED = 'true';
  expect(await removeWorktreeTarget(worktree, options)).toBe(true);
  expect(existsSync(worktree)).toBe(false);
  expect(existsSync(gcMarkFile(worktree))).toBe(false);
  expect(readFileSync(gcMarkFile(repo), 'utf8')).toBe(sourceMark);
  expect(saved).toHaveLength(1);
  expect(readFileSync(join(saved[0]?.dir ?? '', 'manifest.json'), 'utf8')).toContain('scratch.txt');
}, 120_000);

test.skipIf(process.platform === 'win32')(
  'a failing git removal keeps both the worktree and its archive',
  async () => {
    const mark = saveMark(worktree);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    onTestFinished(() => error.mockRestore());
    const locked = join(worktree, 'locked');
    mkdirSync(locked);
    writeFileSync(join(locked, 'held.txt'), 'held\n');
    chmodSync(locked, 0o555);
    let removed: boolean;
    try {
      removed = await removeWorktreeTarget(worktree, {
        linkedOnly: true,
        archiveDirty: { pullRequest: null, onArchived: () => {} },
      });
    } finally {
      chmodSync(locked, 0o755);
    }

    expect(removed).toBe(false);
    expect(readFileSync(gcMarkFile(worktree), 'utf8')).toBe(mark);
    expect(existsSync(join(locked, 'held.txt'))).toBe(true);
    const [entry] = readdirSync(join(worktreeArchiveRoot(), 'repo'));
    const manifest = JSON.parse(
      readFileSync(join(worktreeArchiveRoot(), 'repo', entry ?? '', 'manifest.json'), 'utf8'),
    );
    expect(manifest.untracked).toEqual(['locked/held.txt']);
    expect(error.mock.calls.flat().join('\n')).toContain('Its uncommitted changes stay archived in');
  },
  120_000,
);

test('nothing is archived when writing it would cross disk.hardFloorGb', async () => {
  process.env.STIM_DISK_HARD_FLOOR_GB = String(1024 ** 3);
  onTestFinished(() => {
    delete process.env.STIM_DISK_HARD_FLOOR_GB;
  });
  dirtyTheWorktree();

  await expect(archive()).rejects.toThrow(/disk\.hardFloorGb/);
  expect(existsSync(worktreeArchiveRoot())).toBe(false);
}, 60_000);

test('an archive holds its claim until the removal that needs it releases it', async () => {
  dirtyTheWorktree();
  const saved = await archive();
  const root = `${saved.dir}.claims`;

  expect(clearFreeClaimSet({ root, label: 'worktree archive' }).status).toBe('held');
  releaseWorktreeArchive(saved);
  expect(clearFreeClaimSet({ root, label: 'worktree archive' }).status).toBe('cleared');
}, 60_000);

test('a new archive that does not fit beside the others keeps its worktree', async () => {
  const other = join(worktreeArchiveRoot(), 'repo', 'earlier');
  mkdirSync(other, { recursive: true });
  writeFileSync(join(other, 'untracked.tar'), Buffer.alloc(900));
  process.env.STIM_ARCHIVE_MAX_TOTAL_GB = String(1000 / 1024 ** 3);
  writeFileSync(join(worktree, 'scratch.txt'), 'x'.repeat(200));

  await expect(archive()).rejects.toThrow(/do not fit in archive\.maxTotalGb/);
  expect(readdirSync(join(worktreeArchiveRoot(), 'repo'))).toEqual(['earlier']);
}, 60_000);

test('a file written while the removal runs keeps the worktree and discards its archive', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  onTestFinished(() => error.mockRestore());
  writeFileSync(join(worktree, 'scratch.txt'), 'scratch\n');
  trashHook.beforeMove = () => writeFileSync(join(worktree, 'late.txt'), 'written during removal\n');

  const removed = await removeWorktreeTarget(worktree, {
    linkedOnly: true,
    archiveDirty: { pullRequest: null, onArchived: () => {} },
  });

  expect(removed).toBe(false);
  expect(readFileSync(join(worktree, 'late.txt'), 'utf8')).toBe('written during removal\n');
  expect(readFileSync(join(worktree, 'scratch.txt'), 'utf8')).toBe('scratch\n');
  expect(readdirSync(join(worktreeArchiveRoot(), 'repo'))).toEqual([]);
  expect(error.mock.calls.flat().join('\n')).toContain('changed while they were archived');
}, 120_000);

test('retention deletes worktree archives past archive.maxAgeDays, then the oldest while over archive.maxTotalGb, never counting or deleting one whose removal holds its claim', async () => {
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
  const recent = plant('recent', 1, 600);
  const inFlight = plant('in-flight', 2, 1200);
  const claim = tryAcquireClaim({ root: `${inFlight}.claims`, mode: 'exclusive', label: 'worktree archive' }).acquired;
  onTestFinished(() => {
    releaseClaim(claim);
  });
  process.env.STIM_ARCHIVE_MAX_AGE_DAYS = '30';
  process.env.STIM_ARCHIVE_MAX_TOTAL_GB = String(1000 / 1024 ** 3);

  await enforceArchiveRetention(now);

  expect(existsSync(expired)).toBe(false);
  expect(existsSync(oldest)).toBe(false);
  expect(existsSync(recent)).toBe(true);
  expect(existsSync(inFlight)).toBe(true);
  expect(
    readdirSync(join(worktreeArchiveRoot(), 'repo'))
      .filter((name) => !name.endsWith('.claims'))
      .toSorted(),
  ).toEqual(['in-flight', 'recent']);
});

test('source-only reclamation preserves the existing root mark and checkout', async () => {
  const mark = saveMark(repo);
  upsertProject(repo, {});
  expect(await removeWorktreeTarget(repo, { output: { error: () => {}, fail: () => {} } })).toBe(false);
  expect(existsSync(repo)).toBe(true);
  expect(readFileSync(gcMarkFile(repo), 'utf8')).toBe(mark);
});

test('a branch cleanup failure after actual linked removal still retires only the removed root mark', async () => {
  saveMark(worktree);
  const sourceMark = saveMark(repo);
  upsertProject(worktree, {
    worktreeRoot: true,
    worktreeBranch: 'topic',
    worktreeBranchOwned: true,
    worktreeMainRoot: repo,
  });
  const refusal = vi.spyOn(worktreeGit, 'deleteBranchAsync').mockRejectedValue(new Error('controlled branch refusal'));
  onTestFinished(() => refusal.mockRestore());
  expect(await removeWorktreeTarget(worktree, { linkedOnly: true, output: { error: () => {}, fail: () => {} } })).toBe(
    true,
  );
  expect(refusal).toHaveBeenCalledTimes(1);
  expect(existsSync(worktree)).toBe(false);
  expect(existsSync(gcMarkFile(worktree))).toBe(false);
  expect(readFileSync(gcMarkFile(repo), 'utf8')).toBe(sourceMark);
});

test('a missing linked root retains its mark rather than treating absence as owned removal', async () => {
  const mark = saveMark(worktree);
  git(repo, `worktree remove --force "${worktree}"`);
  expect(await removeWorktreeTarget(worktree, { linkedOnly: true, output: { error: () => {}, fail: () => {} } })).toBe(
    false,
  );
  expect(readFileSync(gcMarkFile(worktree), 'utf8')).toBe(mark);
});

test('a foreign-root saved record is not retired after linked removal', async () => {
  const foreign = saveMark(repo);
  mkdirSync(dirname(gcMarkFile(worktree)), { recursive: true });
  writeFileSync(gcMarkFile(worktree), foreign);
  expect(await removeWorktreeTarget(worktree, { linkedOnly: true, output: { error: () => {}, fail: () => {} } })).toBe(
    true,
  );
  expect(existsSync(worktree)).toBe(false);
  expect(readFileSync(gcMarkFile(worktree), 'utf8')).toBe(foreign);
  expect(readFileSync(gcMarkFile(repo), 'utf8')).toBe(foreign);
});

test.skipIf(process.platform === 'win32')('failed mark unlink does not undo successful owned removal', async () => {
  const mark = saveMark(worktree);
  const directory = dirname(gcMarkFile(worktree));
  const error = vi.fn<(message: string) => void>();
  const fail = vi.fn<() => void>();
  chmodSync(directory, 0o555);
  try {
    expect(await removeWorktreeTarget(worktree, { linkedOnly: true, output: { error, fail } })).toBe(true);
    expect(existsSync(worktree)).toBe(false);
    expect(readFileSync(gcMarkFile(worktree), 'utf8')).toBe(mark);
    expect(error.mock.calls.flat().join('\n')).toContain('Could not retire the cleanup mark');
    expect(fail).not.toHaveBeenCalled();
  } finally {
    chmodSync(directory, 0o755);
  }
});

test.skipIf(process.platform !== 'win32')(
  'owned removal retires actual short-spelling and native mark keys for the same worktree',
  async (context) => {
    const alias = realpathSync(worktree);
    const native = realpathSync.native(worktree);
    if (alias === native) context.skip();
    upsertProject(alias, {});
    await markWriter({ projects: { [alias]: {} }, repos: {} })({
      path: alias,
      at: Date.now(),
      lastActivityAt: null,
      kept: null,
    });
    expect(readGcMark(alias)?.root).toBe(alias);
    saveMark(native);
    const sourceMark = saveMark(repo);
    expect(await removeWorktreeTarget(native, { linkedOnly: true, output: { error: () => {}, fail: () => {} } })).toBe(
      true,
    );
    expect(existsSync(native)).toBe(false);
    expect(existsSync(gcMarkFile(alias))).toBe(false);
    expect(existsSync(gcMarkFile(native))).toBe(false);
    expect(readFileSync(gcMarkFile(repo), 'utf8')).toBe(sourceMark);
  },
);
