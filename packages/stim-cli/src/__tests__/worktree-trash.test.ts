import { execSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readClaimSet } from '@stim-cli/core/ownership-claim';
import { resetExecutor } from '../exec.ts';
import { moveIgnoredTreesToTrash, restoreTrashedTrees } from '../workspace/worktree-trash.ts';

const POSIX = process.platform !== 'win32';

const renameIo: { beforeRename?: (from: string, to: string) => void } = vi.hoisted(() => ({}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...fs,
    rename: async (...args: Parameters<typeof fs.rename>) => {
      renameIo.beforeRename?.(String(args[0]), String(args[1]));
      return fs.rename(...args);
    },
  };
});

let base: string;

function repoWithIgnoredTrees(): string {
  const repo = join(base, 'repo');
  for (const tree of ['node_modules', 'build']) {
    mkdirSync(join(repo, tree, 'pkg'), { recursive: true });
    writeFileSync(join(repo, tree, 'pkg', 'f'), tree);
  }
  const git = (cmd: string) => execSync(cmd, { cwd: repo, encoding: 'utf-8', timeout: 15_000 });
  git('git init -q');
  writeFileSync(join(repo, '.gitignore'), 'node_modules/\nbuild/\n');
  git('git add .gitignore');
  git('git -c user.email=t@e.com -c user.name=t commit -q -m init');
  return repo;
}

beforeEach(() => {
  resetExecutor();
  base = realpathSync(mkdtempSync(join(tmpdir(), 'stim-test-worktree-trash-')));
  process.env.STIM_HOME = join(base, 'stim');
});

afterEach(() => {
  renameIo.beforeRename = undefined;
  delete process.env.STIM_HOME;
  rmSync(base, { recursive: true, force: true });
});

test.skipIf(!POSIX)(
  'the manifest and the ownership claim exist before the first directory is renamed',
  async () => {
    const repo = repoWithIgnoredTrees();
    const seen: { manifest: unknown; claims: number }[] = [];
    renameIo.beforeRename = (_from, to) => {
      const entry = join(base, 'stim', 'trash', readdirSync(join(base, 'stim', 'trash'))[0] ?? '');
      if (!to.startsWith(entry)) return;
      const manifest = join(entry, 'trash.json');
      seen.push({
        manifest: existsSync(manifest) ? JSON.parse(readFileSync(manifest, 'utf8')) : null,
        claims: readClaimSet(join(entry, 'claims')).live.length,
      });
    };

    const trash = await moveIgnoredTreesToTrash(repo);

    expect(trash?.moved).toHaveLength(2);
    expect(seen).toEqual([
      {
        manifest: { worktree: repo, createdAt: expect.any(String) },
        claims: 1,
      },
      {
        manifest: { worktree: repo, createdAt: expect.any(String) },
        claims: 1,
      },
    ]);
  },
  30_000,
);

test.skipIf(!POSIX)(
  'restoring reports the tree whose place was taken and keeps it in the trash with the claim released',
  async () => {
    const repo = repoWithIgnoredTrees();
    const trash = await moveIgnoredTreesToTrash(repo);
    if (!trash) throw new Error('nothing was moved to the trash');
    mkdirSync(join(repo, 'node_modules'));

    const kept = await restoreTrashedTrees(trash);

    expect(kept).toEqual(['node_modules']);
    expect(readFileSync(join(repo, 'build', 'pkg', 'f'), 'utf8')).toBe('build');
    expect(
      readFileSync(
        join(trash.dir, 'entries', String(trash.moved.findIndex((m) => m.from === 'node_modules')), 'pkg', 'f'),
        'utf8',
      ),
    ).toBe('node_modules');
    expect(readClaimSet(join(trash.dir, 'claims')).live).toEqual([]);
  },
  30_000,
);
