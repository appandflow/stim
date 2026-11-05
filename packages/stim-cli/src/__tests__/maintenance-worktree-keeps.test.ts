import { planWorktrees } from '../maintenance/sweep.ts';
import { collectWorktreeSweep, type WorktreeSkipCode, type WorktreeSweep } from '../commands/gc/worktrees.ts';

vi.mock('../commands/gc/worktrees.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../commands/gc/worktrees.ts')>()),
  collectWorktreeSweep: vi.fn<typeof collectWorktreeSweep>(),
}));

type Candidate = WorktreeSweep['worktrees'][number];

const live: Candidate['merge'] = { merged: false, unknown: false, detail: 'not merged into origin/main' };

const candidate = (path: string, skipCode: WorktreeSkipCode | null, skipped: string | null): Candidate => ({
  path,
  keys: [path],
  idleDays: 9,
  merge: { merged: true, into: 'origin/main', head: 'abc', mergedAt: 0, coversUnpushed: true },
  head: null,
  pullRequest: null,
  skipCode,
  skipped,
  eligibleAt: null,
  activity: null,
});

const plan = async (worktrees: Candidate[], idleDays: number | null = null) => {
  vi.mocked(collectWorktreeSweep).mockResolvedValue({
    idle: null,
    graceMs: 0,
    now: 0,
    noOwnCommitsIdleMs: null,
    worktrees,
  });
  return planWorktrees({ protectedRoot: '/elsewhere', pinned: () => false, now: 0, idleDays });
};

test('the worktree check reports a code and the path for every reason it keeps a worktree', async () => {
  const kept: [WorktreeSkipCode, string][] = [
    ['locked', 'locked by git worktree lock'],
    ['pinned', 'pinned by maintenance.keep'],
    ['not-registered', 'not registered in this Stim home: no project or workspace record names it'],
    ['dirty', 'dirty: 2 uncommitted or untracked files (a.ts, b.ts)'],
    ['unpushed', 'unpushed: 1 commit on no remote or other branch'],
    ['in-use', 'in use: its dev server supervisor (pid 1) is running'],
    ['submodules', 'initialized submodules'],
    ['last-use-unknown', 'recently used: its last use is unknown'],
    ['recent-activity', 'recent activity: merged into origin/main 10m ago; removable after 2026-01-01T00:00:00.000Z'],
  ];

  const result = await plan(kept.map(([code, text], index) => candidate(`/w/${index}`, code, text)));

  expect(result.skips).toEqual(
    kept.map(([code, text], index) => ({ target: `/w/${index}`, reason: text, code, workspace: `/w/${index}` })),
  );
  expect(result.actions).toEqual([]);
});

test('the worktree check stays silent about the main checkout and a directory that is no worktree', async () => {
  const result = await plan([
    candidate('/w/main', 'source-checkout', 'source checkout'),
    candidate('/w/not-git', 'not-a-worktree', 'not inside a git worktree'),
  ]);

  expect(result.skips).toEqual([]);
});

test('an unmerged worktree is reported only when the idle sweep is on', async () => {
  const dirty = { ...candidate('/w/live', 'dirty', 'dirty: 1 uncommitted or untracked file (a.ts)'), merge: live };

  expect((await plan([dirty])).skips).toEqual([]);
  expect((await plan([dirty], 7)).skips).toMatchObject([{ target: '/w/live', code: 'dirty' }]);
});

test('a removable worktree is planned for removal and not reported as kept', async () => {
  const result = await plan([candidate('/w/done', null, null)]);

  expect(result.skips).toEqual([]);
  expect(result.actions).toMatchObject([{ kind: 'would-remove-worktree', target: '/w/done' }]);
});
