import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveConfig } from '../workspace/config.ts';
import { collectWorktreeSweep, removeWorktrees } from '../commands/gc/worktrees.ts';
import {
  boundReduceOnly,
  discoverCheckouts,
  discoveredOutside,
  type DiscoveredCheckout,
} from '../workspace/discovery.ts';

vi.mock('../workspace/protected-locations.ts', async (original) => {
  const real = await original<typeof import('../workspace/protected-locations.ts')>();
  return { ...real, isProtectedLocation: () => false };
});

const day = 86_400_000;

describe('checkouts found through a tool folder or the full scan', () => {
  let base: string;
  let main: string;
  const old = new Date(Date.now() - 3 * day);
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
      encoding: 'utf8',
      env: { ...process.env, GIT_AUTHOR_DATE: old.toISOString(), GIT_COMMITTER_DATE: old.toISOString() },
    });
  const age = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory() && entry.name !== '.git') age(path);
      utimesSync(path, old, old);
    }
    utimesSync(dir, old, old);
  };
  const worktree = (path: string, name: string) => {
    mkdirSync(join(path, '..'), { recursive: true });
    git(main, 'worktree', 'add', '-q', '-b', name, path);
    const gitdir = git(path, 'rev-parse', '--absolute-git-dir').trim();
    age(path);
    for (const file of ['index', 'HEAD', join('logs', 'HEAD')]) utimesSync(join(gitdir, file), old, old);
    return realpathSync(path);
  };

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'stim-reduce-only-')));
    vi.stubEnv('HOME', join(base, 'home'));
    vi.stubEnv('USERPROFILE', join(base, 'home'));
    vi.stubEnv('STIM_HOME', '');
    main = join(base, 'dev', 'main');
    mkdirSync(main, { recursive: true });
    mkdirSync(join(base, 'home'));
    writeFileSync(join(main, 'package.json'), JSON.stringify({ dependencies: { expo: '*' } }));
    git(main, 'init', '-q', '-b', 'main');
    git(base, 'init', '-q', '--bare', '-b', 'main', join(base, 'remote.git'));
    git(main, 'remote', 'add', 'origin', join(base, 'remote.git'));
    git(main, 'add', '-A');
    git(main, 'commit', '-q', '-m', 'init');
    git(main, 'push', '-q', '-u', 'origin', 'main');
    git(main, 'remote', 'set-head', 'origin', 'main');
    saveConfig({ version: 2, projects: { [main]: {} }, repos: {} });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(base, { recursive: true, force: true });
  });

  it('discovers a ~/.codex/worktrees worktree of a known repository as reduce-only, and no other home dot-folder worktree', async () => {
    const codex = worktree(join(base, 'home', '.codex', 'worktrees', 'ab12', 'main'), 'codex');
    const other = worktree(join(base, 'home', '.other', 'wt'), 'other');
    const sibling = worktree(join(base, 'dev', 'sibling-wt'), 'sibling');
    const found = await discoverCheckouts({ projects: { [main]: {} }, repos: {} }, [main]);
    expect(found.map(({ path, reduceOnly }) => [path, reduceOnly])).toEqual([
      [sibling, undefined],
      [codex, true],
    ]);
    expect((await discoveredOutside({ projects: { [main]: {} }, repos: {} }, [main])).map(({ path }) => path)).toEqual([
      other,
    ]);
  });

  it('plans a reduce-only worktree as kept, and keeps it at removal even when the plan said it was removable', async () => {
    const codex = worktree(join(base, 'home', '.codex', 'worktrees', 'ab12', 'main'), 'codex');
    const sibling = worktree(join(base, 'dev', 'sibling-wt'), 'sibling');
    const planned = await collectWorktreeSweep({ idle: false, olderThan: null, now: Date.now(), refresh: false });
    const byPath = Object.fromEntries(planned.worktrees.map((entry) => [entry.path, entry]));
    expect(byPath[sibling]?.skipped).toBeNull();
    expect(byPath[codex]).toMatchObject({
      discovered: true,
      reduceOnly: true,
      skipped: expect.stringContaining('never removes'),
    });
    const worktrees = planned.worktrees.filter((entry) => entry.path === codex);
    for (const entry of worktrees) Object.assign(entry, { skipped: null, skipCode: null });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await removeWorktrees({ ...planned, worktrees }, { now: Date.now() });
    expect(existsSync(codex)).toBe(true);
  });
});

describe('boundReduceOnly', () => {
  const entry = (n: number, reduceOnly = true): DiscoveredCheckout => ({
    path: `/p/${String(n).padStart(3, '0')}`,
    origin: 'scan',
    from: 'full scan',
    ...(reduceOnly ? { reduceOnly: true } : {}),
  });
  const window = 15 * 60_000;

  it('keeps every full-rule checkout, and a moving window of at most the limit of the reduce-only ones', () => {
    const all = [entry(1, false), ...Array.from({ length: 10 }, (_, i) => entry(i + 10))];
    const now = 100 * window;
    const first = boundReduceOnly(all, now, 4);
    expect(first.filter((e) => e.reduceOnly)).toHaveLength(4);
    expect(first[0]).toBe(all[0]);
    const seen = new Set<string>();
    for (let i = 0; i < 10; i++) for (const e of boundReduceOnly(all, now + i * window, 4)) seen.add(e.path);
    expect(seen.size).toBe(all.length);
  });

  it('returns everything when the reduce-only ones fit the limit', () => {
    const all = [entry(1), entry(2)];
    expect(boundReduceOnly(all, 0, 4)).toEqual(all);
  });
});
