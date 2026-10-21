import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectTrash, deleteTrash } from '../commands/gc/trash.ts';
import { takeGcResults } from '../commands/gc/results.ts';
import { resetExecutor } from '../exec.ts';
import { deleteTrashInBackground, moveIgnoredTreesToTrash } from '../workspace/worktree-trash.ts';
import { goneClaimOwner, plantClaim } from './_factories.ts';

const POSIX = process.platform !== 'win32';

let base: string;
let trash: string;

function repoWithNodeModules(name: string): string {
  const repo = join(base, name);
  mkdirSync(join(repo, 'node_modules', 'pkg'), { recursive: true });
  const git = (cmd: string) => execSync(cmd, { cwd: repo, encoding: 'utf-8', timeout: 15_000 });
  git('git init -q');
  writeFileSync(join(repo, '.gitignore'), 'node_modules/\n');
  writeFileSync(join(repo, 'node_modules', 'pkg', 'index.js'), 'x'.repeat(64 * 1024));
  git('git add .gitignore');
  git('git -c user.email=t@e.com -c user.name=t commit -q -m init');
  return repo;
}

beforeEach(() => {
  resetExecutor();
  base = realpathSync(mkdtempSync(join(tmpdir(), 'stim-test-trash-')));
  process.env.STIM_HOME = join(base, 'stim');
  trash = join(base, 'stim', 'trash');
});

afterEach(() => {
  takeGcResults();
  delete process.env.STIM_HOME;
  rmSync(base, { recursive: true, force: true });
});

test.skipIf(!POSIX)(
  'gc deletes a trash entry whose remover is gone and keeps one a live removal holds',
  async () => {
    const live = await moveIgnoredTreesToTrash(repoWithNodeModules('live'));
    if (!live) throw new Error('nothing was moved to the trash');
    const crashed = join(trash, 'remove-crashed');
    mkdirSync(join(crashed, 'entries', '0'), { recursive: true });
    writeFileSync(join(crashed, 'entries', '0', 'file'), 'y'.repeat(64 * 1024));
    writeFileSync(join(crashed, 'trash.json'), JSON.stringify({ worktree: '/w/gone', createdAt: 'T' }));
    plantClaim(join(crashed, 'claims'), 'exclusive', goneClaimOwner());

    const report = await collectTrash();
    expect(report?.entries.map(({ path, worktree, willDelete }) => ({ path, worktree, willDelete }))).toEqual(
      [
        { path: crashed, worktree: '/w/gone', willDelete: true },
        { path: live.dir, worktree: join(base, 'live'), willDelete: false },
      ].toSorted((a, b) => a.path.localeCompare(b.path)),
    );
    for (const entry of report?.entries ?? []) expect(entry.bytes).toBeGreaterThanOrEqual(64 * 1024);

    const done = await deleteTrash(undefined);

    expect(done).toMatchObject({ count: 1, failures: 0 });
    expect(existsSync(crashed)).toBe(false);
    expect(existsSync(join(live.dir, 'entries', '0', 'pkg', 'index.js'))).toBe(true);
    expect(takeGcResults().map(({ kind, status }) => `${kind}:${status}`)).toEqual(['trash:done']);
  },
  30_000,
);

test.skipIf(!POSIX)(
  'the background rm a removal starts deletes its trash entry',
  async () => {
    const repo = repoWithNodeModules('wt');
    const moved = await moveIgnoredTreesToTrash(repo);
    if (!moved) throw new Error('nothing was moved to the trash');
    expect(existsSync(join(repo, 'node_modules'))).toBe(false);

    expect(deleteTrashInBackground(moved)).toBe(true);

    const deadline = Date.now() + 20_000;
    while (readdirSync(trash).length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    expect(readdirSync(trash)).toEqual([]);
  },
  30_000,
);
