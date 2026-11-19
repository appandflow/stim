import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Config } from '@stim-cli/core/state';
import { testContext } from './_context.ts';
import { collectWorktreeSweep } from '../commands/gc/worktrees.ts';
import { saveConfig } from '../workspace/config.ts';
import * as gitCommands from '../workspace/git.ts';
import { answered, hungRead } from '../workspace/bounded-read.ts';
import { discoveredEvidence, scanSourceWrites } from '../workspace/discovered-activity.ts';
import { discoveredReads } from '../workspace/discovered-reads.ts';
import {
  discoverCheckouts,
  discoveredOutside,
  isBroadFolder,
  selectDiscovered,
  type DiscoveryChild,
} from '../workspace/discovery.ts';

vi.mock('../workspace/protected-locations.ts', () => ({
  isProtectedLocation: () => false,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readdir: vi.fn<typeof actual.readdir>(actual.readdir),
    lstat: vi.fn<typeof actual.lstat>(actual.lstat),
  };
});

describe('isBroadFolder', () => {
  it('refuses the home folder, a folder holding it and the filesystem root, and accepts a folder below it', () => {
    expect(isBroadFolder('/Users/me', '/Users/me')).toBe(true);
    expect(isBroadFolder('/Users', '/Users/me')).toBe(true);
    expect(isBroadFolder('/', '/Users/me')).toBe(true);
    expect(isBroadFolder('/Users/me/Developer', '/Users/me')).toBe(false);
    expect(isBroadFolder('/Users/mentor', '/Users/me')).toBe(false);
  });
});

describe('selectDiscovered', () => {
  const child = (path: string, recognised = true) =>
    ({ path, origin: 'sibling', from: '/dev', recognised }) satisfies DiscoveryChild;

  it('keeps a linked worktree as is, a child only when recognised, and leaves covered paths to their workspace', () => {
    const found = selectDiscovered({
      known: ['/dev/app', '/dev/mono/apps/web'],
      worktrees: [
        { path: '/dev/wt-a', from: '/dev/main' },
        { path: '/dev/app', from: '/dev/main' },
      ],
      children: [
        child('/dev/wt-a'),
        child('/dev/lib', false),
        child('/dev/app-two'),
        child('/dev/mono'),
        child('/dev/app/inner'),
      ],
    });
    expect(found.map(({ path, origin }) => [path, origin])).toEqual([
      ['/dev/app-two', 'sibling'],
      ['/dev/wt-a', 'worktree'],
    ]);
  });
});

describe('scanSourceWrites', () => {
  let base: string;
  const old = new Date(Date.now() - 10 * 86_400_000);
  const age = (path: string) => utimesSync(path, old, old);

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'stim-discovery-scan-')));
    mkdirSync(join(base, 'src'));
    mkdirSync(join(base, 'node_modules'));
    writeFileSync(join(base, 'src', 'a.ts'), '');
    writeFileSync(join(base, 'node_modules', 'dep.js'), '');
    for (const path of [join(base, 'src', 'a.ts'), join(base, 'src'), join(base, 'node_modules', 'dep.js')]) age(path);
    age(join(base, 'node_modules'));
    age(base);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(base, { recursive: true, force: true });
  });

  it('ignores writes in dependency folders and sees one in source', async () => {
    const quiet = Date.now() - 86_400_000;
    writeFileSync(join(base, 'node_modules', 'new.js'), '');
    const idle = await scanSourceWrites(base, quiet);
    expect('newest' in idle && Math.abs(idle.newest - old.getTime()) < 5).toBe(true);
    writeFileSync(join(base, 'src', 'edit.ts'), '');
    const scan = await scanSourceWrites(base, quiet);
    expect('newest' in scan && scan.newest > quiet).toBe(true);
  });

  it('stops at once when the pass is aborted instead of reporting an idle checkout', async () => {
    await expect(scanSourceWrites(base, Date.now(), AbortSignal.abort())).rejects.toThrow(/abort/i);
  });

  const OUT_OF_TIME = { unknown: 'it could not check every source entry within 15 s' };
  const tree = (...names: string[]) => {
    const root = join(base, `tree-${names.join('-')}`);
    mkdirSync(root);
    for (const name of names) mkdirSync(join(root, name));
    for (const name of names) age(join(root, name));
    age(root);
    return root;
  };
  const slowIgnoreProbe = () =>
    vi.spyOn(gitCommands, 'gitQuietAsync').mockImplementation(async () => {
      vi.advanceTimersByTime(20_000);
      return '';
    });

  it('reports unknown, never idle, when its time runs out on entries git ignores, and probes none after', async () => {
    const quiet = Date.now() - 86_400_000;
    const probe = slowIgnoreProbe();
    expect(await scanSourceWrites(tree('build'), quiet)).toEqual(OUT_OF_TIME);
    probe.mockClear();
    expect(await scanSourceWrites(tree('build', 'dist'), quiet)).toEqual(OUT_OF_TIME);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('still reports a recent write that it reaches after its time ran out', async () => {
    writeFileSync(join(base, 'src', 'edit.ts'), '');
    const { readdir: real } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(readdir).mockImplementationOnce(async (path, options) => {
      vi.advanceTimersByTime(20_000);
      return real(path, options);
    });
    const quiet = Date.now() - 86_400_000;
    const scan = await scanSourceWrites(base, quiet);
    expect('newest' in scan && scan.newest > quiet).toBe(true);
  });

  it('gives up on a read that never answers when its time runs out, and on abort', async () => {
    const stall = () => {
      let release = () => {};
      vi.mocked(readdir).mockImplementationOnce(
        () =>
          new Promise((_, fail) => {
            release = () => fail(new Error('released'));
          }),
      );
      return async () => {
        release();
        await Promise.resolve();
      };
    };
    let release = stall();
    const scan = scanSourceWrites(base, Date.now() - 86_400_000);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await scan).toEqual(OUT_OF_TIME);
    await release();

    release = stall();
    const controller = new AbortController();
    const aborted = scanSourceWrites(join(base, 'src'), Date.now() - 86_400_000, controller.signal);
    controller.abort();
    await expect(aborted).rejects.toThrow(/abort/i);
    await release();
  });

  it('keeps a checkout whose scan ran out of time without reading its .git', async () => {
    let release = () => {};
    vi.mocked(readdir).mockImplementationOnce(
      () =>
        new Promise((_, fail) => {
          release = () => fail(new Error('released'));
        }),
    );
    const evidence = discoveredEvidence(base, {
      now: Date.now(),
      idleMs: 86_400_000,
      reads: discoveredReads(),
      reduceOnly: false,
    });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await evidence).toEqual({ activity: [], keep: [OUT_OF_TIME.unknown] });
    expect(vi.mocked(lstat)).not.toHaveBeenCalledWith(join(base, '.git'));
    release();
    await vi.advanceTimersByTimeAsync(0);
  });

  const holdSlot = async () => {
    let release = () => {};
    const stuck = answered('/stalled-mount', () => new Promise<void>((resolve) => (release = resolve)), 10).catch(
      () => 'timed out',
    );
    await vi.advanceTimersByTimeAsync(10);
    expect(await stuck).toBe('timed out');
    return release;
  };

  it('waits within its budget for another read to free the slot, then walks', async () => {
    const release = await holdSlot();
    const quiet = Date.now() - 86_400_000;
    const scan = scanSourceWrites(base, quiet);
    await vi.advanceTimersByTimeAsync(5000);
    release();
    expect('newest' in (await scan)).toBe(true);
  });

  it('walks a checkout again on the next pass when another read held the slot past its budget, with no cooldown', async () => {
    const release = await holdSlot();
    const quiet = Date.now() - 86_400_000;

    const scan = scanSourceWrites(base, quiet);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await scan).toEqual({
      unknown: 'its source cannot be read while a read of /stalled-mount has not answered',
    });

    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(hungRead()).toBeNull();
    expect('newest' in (await scanSourceWrites(base, quiet))).toBe(true);
  });
});

describe('discoverCheckouts', () => {
  let base: string;
  const app = (path: string) => {
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'package.json'), JSON.stringify({ dependencies: { expo: '*' } }));
  };
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' });

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'stim-discovery-')));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(base, { recursive: true, force: true });
  });

  it('lists only recognised children of maintenance.discoverRoots in a scoped home, writing nothing', async () => {
    vi.stubEnv('STIM_HOME', join(base, 'home'));
    const roots = join(base, 'roots');
    app(join(roots, 'app'));
    mkdirSync(join(roots, 'docs'));
    mkdirSync(join(roots, 'linked-out'));
    symlinkSync(join(roots, 'app'), join(roots, 'link'));
    const config: Config = { maintenance: { discoverRoots: [roots] }, projects: {}, repos: {} };
    const found = await discoverCheckouts(config, []);
    expect(found.map(({ path, origin }) => [path, origin])).toEqual([[join(roots, 'app'), 'root']]);
    expect(existsSync(join(base, 'home'))).toBe(false);
  });

  it('starts no folder read while an earlier read is still pending, and finds the child once it settles', async () => {
    vi.stubEnv('STIM_HOME', join(base, 'home'));
    const roots = join(base, 'roots');
    app(join(roots, 'app'));
    const config: Config = { maintenance: { discoverRoots: [roots] }, projects: {}, repos: {} };
    let release: (value: string) => void = () => {};
    const stuck = answered('/stalled-mount', () => new Promise<string>((resolve) => (release = resolve)), 10).catch(
      () => 'timed out',
    );
    await vi.advanceTimersByTimeAsync(10);
    expect(await stuck).toBe('timed out');

    expect(await discoverCheckouts(config, [])).toEqual([]);

    release('late');
    await vi.advanceTimersByTimeAsync(0);
    expect((await discoverCheckouts(config, [])).map(({ path }) => path)).toEqual([join(roots, 'app')]);
  });

  it('finds the linked worktrees and recognised neighbours of a known repository through git worktree list', async () => {
    vi.stubEnv('STIM_HOME', '');
    const repo = join(base, 'dev', 'repo');
    app(repo);
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
    const linked = join(base, 'dev', 'feature');
    const elsewhere = join(base, 'wt', 'pin');
    mkdirSync(join(base, 'wt'));
    git(repo, 'worktree', 'add', '-q', '-b', 'feature', linked);
    git(repo, 'worktree', 'add', '-q', '--detach', elsewhere);
    app(join(base, 'dev', 'neighbour'));
    mkdirSync(join(base, 'dev', 'notes'));
    const config: Config = { projects: { [repo]: {} }, repos: {} };
    const found = await discoverCheckouts(config, [repo]);
    expect(found.map(({ path, origin }) => [path, origin])).toEqual([
      [linked, 'worktree'],
      [join(base, 'dev', 'neighbour'), 'sibling'],
    ]);
    expect((await discoveredOutside(config, [repo])).map(({ path }) => path)).toEqual([elsewhere]);
  });

  it('lists the worktree of a plain Node checkout only when asked, and no folder without git or package in a monorepo', async () => {
    vi.stubEnv('STIM_HOME', join(base, 'home'));
    const roots = join(base, 'roots');
    const cli = join(roots, 'cli');
    mkdirSync(join(cli, 'packages', 'core'), { recursive: true });
    writeFileSync(join(cli, 'package.json'), JSON.stringify({ name: 'cli' }));
    writeFileSync(join(cli, 'packages', 'core', 'package.json'), JSON.stringify({ name: 'core' }));
    git(cli, 'init', '-q', '-b', 'main');
    git(cli, 'add', '-A');
    git(cli, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
    git(cli, 'worktree', 'add', '-q', '-b', 'feature', join(roots, 'cli-feature'));
    mkdirSync(join(roots, 'lib'));
    writeFileSync(join(roots, 'lib', 'package.json'), '{}');
    const config: Config = {
      maintenance: { discoverRoots: [roots, join(cli, 'packages')] },
      projects: {},
      repos: {},
    };

    expect(await discoverCheckouts(config, [])).toEqual([]);
    expect(
      (await discoverCheckouts(config, [], undefined, { nodeWorktrees: true })).map(({ path, node }) => [path, node]),
    ).toEqual([[join(roots, 'cli-feature'), 'linked']]);
  });

  it('marks the worktrees of a Node repository through git, and never those of a repository an app leads to', async () => {
    vi.stubEnv('STIM_HOME', '');
    const commit = (cwd: string) => {
      git(cwd, 'init', '-q', '-b', 'main');
      git(cwd, 'add', '-A');
      git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
    };
    const repo = join(base, 'dev', 'repo');
    app(repo);
    commit(repo);
    const cli = join(base, 'dev', 'cli');
    mkdirSync(cli, { recursive: true });
    writeFileSync(join(cli, 'package.json'), JSON.stringify({ name: 'cli' }));
    commit(cli);
    const nested = join(cli, '.worktrees', 'fix');
    git(cli, 'worktree', 'add', '-q', '-b', 'fix', nested);
    mkdirSync(join(base, 'wt'));
    git(cli, 'worktree', 'add', '-q', '--detach', join(base, 'wt', 'pin'));
    const zapp = join(base, 'dev', 'zapp');
    app(zapp);
    commit(zapp);
    const old = join(base, 'dev', 'a-old');
    git(zapp, 'worktree', 'add', '-q', '-b', 'old', old);
    writeFileSync(join(old, 'package.json'), '{}');
    const config: Config = { projects: { [repo]: {} }, repos: {} };

    const found = await discoverCheckouts(config, [repo], undefined, { nodeWorktrees: true });
    expect(found.map(({ path, origin, node }) => [path, origin, node])).toEqual([
      [old, 'worktree', undefined],
      [nested, 'worktree', 'linked'],
      [zapp, 'sibling', undefined],
    ]);
    expect(await discoveredOutside(config, [repo])).toEqual([]);
  });

  it('keeps a Node worktree that is or holds a full-scan find, checked or pending, reduce-only in discovery and in the removal check', async () => {
    vi.stubEnv('STIM_HOME', '');
    vi.stubEnv('HOME', join(base, 'home'));
    vi.stubEnv('USERPROFILE', join(base, 'home'));
    const dev = join(base, 'home', 'dev');
    const cli = join(dev, 'cli');
    mkdirSync(cli, { recursive: true });
    writeFileSync(join(cli, 'package.json'), JSON.stringify({ name: 'cli' }));
    git(cli, 'init', '-q', '-b', 'main');
    git(cli, 'add', '-A');
    git(cli, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
    mkdirSync(join(dev, 'wts'));
    const mobile = join(dev, 'wts', 'mobile');
    git(cli, 'worktree', 'add', '-q', '-b', 'mobile', mobile);
    app(mobile);
    const tool = join(dev, 'wts', 'tool');
    git(cli, 'worktree', 'add', '-q', '-b', 'tool', tool);
    app(join(tool, 'mobile'));
    const broken = join(dev, 'wts', 'broken');
    git(cli, 'worktree', 'add', '-q', '-b', 'broken', broken);
    writeFileSync(join(broken, 'package.json'), '{ not json');
    const holder = join(dev, 'wts', 'holder');
    git(cli, 'worktree', 'add', '-q', '-b', 'holder', holder);
    mkdirSync(join(holder, 'mobile'));
    writeFileSync(join(holder, 'mobile', 'package.json'), '{ not json');
    mkdirSync(join(base, 'home', '.stim', 'maintenance'), { recursive: true });
    writeFileSync(
      join(base, 'home', '.stim', 'maintenance', 'discovery-scan.json'),
      JSON.stringify({
        version: 2,
        completedAt: 1,
        lowScanAt: 0,
        ranAt: 1,
        durationMs: 1,
        trigger: 'weekly',
        visited: 1,
        found: [mobile, join(tool, 'mobile'), broken, join(holder, 'mobile')],
        dotFolderFound: [],
        unreadable: [],
        truncated: false,
        truncation: 'none',
      }),
    );
    const config: Config = { maintenance: { discoverRoots: [dev] }, projects: {}, repos: {} };

    for (const select of [{}, { nodeWorktrees: true }])
      expect((await discoverCheckouts(config, [], undefined, select)).filter(({ path }) => path === mobile)).toEqual([
        expect.objectContaining({ origin: 'scan', reduceOnly: true }),
      ]);
    saveConfig({ version: 2, ...config });
    const sweep = await collectWorktreeSweep({ idle: false, olderThan: null, now: Date.now(), refresh: false });
    expect(
      (await discoverCheckouts(config, [], undefined, { nodeWorktrees: true }))
        .filter(({ path }) => path === broken || path === holder)
        .map(({ path, reduceOnly }) => [path, reduceOnly]),
    ).toEqual([
      [broken, true],
      [holder, true],
    ]);
    for (const path of [mobile, tool, broken, holder])
      expect(sweep.worktrees.find((entry) => entry.path === path)).toMatchObject({
        discovered: true,
        reduceOnly: true,
      });
  });

  it('takes the checkouts of the last full scan as reduce-only in an unscoped home, and none in a scoped one', async () => {
    vi.stubEnv('STIM_HOME', '');
    vi.stubEnv('HOME', join(base, 'home'));
    vi.stubEnv('USERPROFILE', join(base, 'home'));
    const docs = join(base, 'home', 'projects', 'old-app');
    app(docs);
    mkdirSync(join(base, 'home', '.stim', 'maintenance'), { recursive: true });
    const scan = {
      version: 2,
      completedAt: 1,
      lowScanAt: 0,
      ranAt: 1,
      durationMs: 1,
      trigger: 'weekly',
      visited: 1,
      found: [docs, join(base, 'gone')],
      dotFolderFound: [],
      unreadable: [],
      truncated: false,
      truncation: 'none',
    };
    writeFileSync(join(base, 'home', '.stim', 'maintenance', 'discovery-scan.json'), JSON.stringify(scan));
    expect(
      (await discoverCheckouts({ projects: {}, repos: {} }, [])).map(({ path, origin, reduceOnly }) => [
        path,
        origin,
        reduceOnly,
      ]),
    ).toEqual([[docs, 'scan', true]]);
    vi.stubEnv('STIM_HOME', join(base, 'scoped'));
    expect(
      await discoverCheckouts(
        { projects: {}, repos: {} },
        [],
        testContext({ env: { STIM_HOME: join(base, 'scoped') } }),
      ),
    ).toEqual([]);
  });

  it('drops a find an earlier scan recorded under ~/Documents, but keeps a root named there', async () => {
    vi.stubEnv('STIM_HOME', '');
    vi.stubEnv('HOME', join(base, 'home'));
    vi.stubEnv('USERPROFILE', join(base, 'home'));
    const recorded = join(base, 'home', 'Documents', 'old-app');
    const root = join(base, 'home', 'Documents', 'work');
    app(recorded);
    app(join(root, 'app'));
    mkdirSync(join(base, 'home', '.stim', 'maintenance'), { recursive: true });
    writeFileSync(
      join(base, 'home', '.stim', 'maintenance', 'discovery-scan.json'),
      JSON.stringify({
        version: 2,
        completedAt: 1,
        lowScanAt: 0,
        ranAt: 1,
        durationMs: 1,
        trigger: 'weekly',
        visited: 1,
        found: [recorded, join(root, 'app')],
        dotFolderFound: [],
        unreadable: [],
        truncated: false,
        truncation: 'none',
      }),
    );
    const config: Config = { maintenance: { discoverRoots: [root] }, projects: {}, repos: {} };
    expect((await discoverCheckouts(config, [])).map(({ path, origin }) => [path, origin])).toEqual([
      [join(root, 'app'), 'root'],
    ]);
  });

  it('never takes the home directory as a folder that holds known projects', async () => {
    vi.stubEnv('STIM_HOME', '');
    vi.stubEnv('HOME', join(base, 'home'));
    const repo = join(base, 'home', 'repo');
    app(repo);
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
    app(join(base, 'home', 'neighbour'));
    const config: Config = { projects: { [repo]: {} }, repos: {} };
    expect(await discoverCheckouts(config, [repo])).toEqual([]);
  });
});
