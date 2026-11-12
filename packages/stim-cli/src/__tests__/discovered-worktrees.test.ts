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
import { saveConfig, upsertProject } from '../workspace/config.ts';
import { collectWorktreeSweep, removeWorktrees } from '../commands/gc/worktrees.ts';
import * as reads from '../workspace/discovered-reads.ts';
import { worktreeInScope } from '../workspace/discovery.ts';

vi.mock('../workspace/protected-locations.ts', () => ({ isProtectedLocation: () => false }));

const day = 86_400_000;

describe('worktreeInScope', () => {
  const where = { main: '/dev/repo', folders: ['/dev'], roots: ['/roots'] };

  it('accepts the main checkout folder, a holding folder and a discover root, and refuses the rest and protected places', () => {
    expect(worktreeInScope('/dev/repo/.worktrees/a', where, () => false)).toBe(true);
    expect(worktreeInScope('/dev/other-wt', where, () => false)).toBe(true);
    expect(worktreeInScope('/roots/x/y', where, () => false)).toBe(true);
    expect(worktreeInScope('/other/pin', where, () => false)).toBe(false);
    expect(worktreeInScope('/dev/wt', where, () => true)).toBe(false);
  });
});

describe('a discovered worktree on the removal path', () => {
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

  const worktree = (name: string, detached = false, parent = join(base, 'roots')) => {
    const path = join(parent, name);
    mkdirSync(parent, { recursive: true });
    git(main, 'worktree', 'add', '-q', ...(detached ? ['--detach', path] : ['-b', name, path]));
    const gitdir = git(path, 'rev-parse', '--absolute-git-dir').trim();
    age(path);
    for (const file of ['index', 'HEAD', join('logs', 'HEAD')]) utimesSync(join(gitdir, file), old, old);
    return path;
  };

  const sweep = async () => {
    const found = await collectWorktreeSweep({ idle: false, olderThan: null, now: Date.now(), refresh: false });
    return Object.fromEntries(found.worktrees.map((entry) => [entry.path.split('/').at(-1), entry]));
  };

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'stim-discovered-wt-')));
    vi.stubEnv('STIM_HOME', join(base, 'home'));
    saveConfig({ version: 2, projects: {}, repos: {}, maintenance: { discoverRoots: [join(base, 'roots')] } });
    main = join(base, 'roots', 'main');
    mkdirSync(join(main, 'ios', 'App.xcodeproj'), { recursive: true });
    writeFileSync(join(main, 'package.json'), JSON.stringify({ dependencies: { expo: '*' } }));
    writeFileSync(join(main, '.gitignore'), '.env\nlocal.db\nnotes/\nnode_modules/\ndist/\nAGENTS.override.md\n');
    writeFileSync(join(main, 'ios', 'App.xcodeproj', 'project.pbxproj'), 'original\n');
    git(main, 'init', '-q', '-b', 'main');
    git(base, 'init', '-q', '--bare', '-b', 'main', join(base, 'remote.git'));
    git(main, 'remote', 'add', 'origin', join(base, 'remote.git'));
    git(main, 'add', '-A');
    git(main, 'commit', '-q', '-m', 'init');
    git(main, 'push', '-q', '-u', 'origin', 'main');
    git(main, 'remote', 'set-head', 'origin', 'main');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(base, { recursive: true, force: true });
  });

  it('is removable only when every file, ignored ones included, has been idle, and keeps a recent edit to an ignored file', async () => {
    const quiet = worktree('quiet');
    const busy = worktree('busy');
    writeFileSync(join(busy, 'local.db'), 'written now');
    const found = await sweep();
    expect(found.quiet?.skipped).toBeNull();
    expect(found.busy).toMatchObject({ skipCode: 'recent-activity', skipped: expect.stringContaining('file edit') });
    expect(quiet).toBeTruthy();
  });

  it('keeps a git-ignored file the main checkout lacks, and removes the worktree once the main checkout holds the same bytes', async () => {
    const wt = worktree('env-wt');
    writeFileSync(join(wt, '.env'), 'SECRET=1');
    utimesSync(join(wt, '.env'), old, old);
    expect((await sweep())['env-wt']?.skipped).toContain('.env');
    writeFileSync(join(main, '.env'), 'SECRET=1');
    expect((await sweep())['env-wt']?.skipped).toBeNull();
  });

  it('skips ignored directories named like build output at any depth but names any other ignored file that differs', async () => {
    const wt = worktree('nested');
    mkdirSync(join(wt, 'packages', 'x', 'dist'), { recursive: true });
    writeFileSync(join(wt, 'packages', 'x', 'dist', 'index.d.mts'), 'built');
    age(wt);
    expect((await sweep()).nested?.skipped).toBeNull();
    writeFileSync(join(wt, 'AGENTS.override.md'), 'local notes');
    age(wt);
    expect((await sweep()).nested?.skipped).toContain('AGENTS.override.md');
  });

  it('keeps a worktree at removal when a file is edited between the plan and the act', async () => {
    const wt = worktree('late');
    const planned = await collectWorktreeSweep({ idle: false, olderThan: null, now: Date.now(), refresh: false });
    expect(planned.worktrees.find((entry) => entry.path === wt)?.skipped).toBeNull();
    writeFileSync(join(wt, 'local.db'), 'edited after the plan');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await removeWorktrees(planned, { now: Date.now() });
    expect(existsSync(wt)).toBe(true);
  });

  it('keeps a hand edit to a tracked project.pbxproj as dirty work', async () => {
    const wt = worktree('pbx');
    writeFileSync(join(wt, 'ios', 'App.xcodeproj', 'project.pbxproj'), 'edited by hand\n');
    expect((await sweep()).pbx).toMatchObject({ skipCode: 'dirty' });
  });

  it('keeps a dirty worktree instead of archiving it', async () => {
    const wt = worktree('dirty');
    writeFileSync(join(wt, 'notes.txt'), 'untracked');
    expect((await sweep()).dirty).toMatchObject({ skipCode: 'dirty' });
  });

  it('keeps a worktree a process runs from or an agent session works in', async () => {
    worktree('held');
    vi.spyOn(reads, 'discoveredReads').mockImplementation(() => ({
      processes: async () => ({
        commands: [{ pid: 1, line: `node ${join(base, 'roots', 'held')}/server.js` }],
        cwds: [],
      }),
      sessions: async () => ['an agent session (claude:x) is working in it'],
    }));
    const held = (await sweep()).held;
    expect(held?.skipped).toContain('agent session');
    expect(held?.skipped).toContain('process 1 runs from it');
  });

  it('leaves a clean detached worktree outside the folders it manages alone', async () => {
    upsertProject(main, { metroPort: null });
    const pin = worktree('pin', true, join(base, 'elsewhere'));
    expect(pin).toBeTruthy();
    expect((await sweep()).pin).toMatchObject({ skipCode: 'not-registered' });
  });
});
