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
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Config } from '@stim-cli/core/state';
import { scanSourceWrites } from '../workspace/discovered-activity.ts';
import { discoverCheckouts, selectDiscovered, type DiscoveryChild } from '../workspace/discovery.ts';

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

  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it('ignores writes in dependency folders and sees one in source', async () => {
    const quiet = Date.now() - 86_400_000;
    writeFileSync(join(base, 'node_modules', 'new.js'), '');
    const idle = await scanSourceWrites(base, quiet);
    expect('newest' in idle && Math.abs(idle.newest - old.getTime()) < 5).toBe(true);
    writeFileSync(join(base, 'src', 'edit.ts'), '');
    const scan = await scanSourceWrites(base, quiet);
    expect('newest' in scan && scan.newest > quiet).toBe(true);
  });

  it('reports unknown, never idle, when the bound stops it', async () => {
    expect(await scanSourceWrites(base, Date.now() - 86_400_000, undefined, 1)).toMatchObject({
      unknown: expect.stringContaining('more than 1'),
    });
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
    const config: Config = { maintenance: { discoverRoots: [roots, 'relative/dir'] }, projects: {}, repos: {} };
    const found = await discoverCheckouts(config, []);
    expect(found.map(({ path, origin }) => [path, origin])).toEqual([[join(roots, 'app'), 'root']]);
    expect(existsSync(join(base, 'home'))).toBe(false);
  });

  it('finds the linked worktrees and recognised neighbours of a known repository through git worktree list', async () => {
    vi.stubEnv('STIM_HOME', '');
    const repo = join(base, 'dev', 'repo');
    app(repo);
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
    const linked = join(base, 'wt', 'feature');
    mkdirSync(join(base, 'wt'));
    git(repo, 'worktree', 'add', '-q', '-b', 'feature', linked);
    app(join(base, 'dev', 'neighbour'));
    mkdirSync(join(base, 'dev', 'notes'));
    const config: Config = { projects: { [repo]: {} }, repos: {} };
    const found = await discoverCheckouts(config, [repo]);
    expect(found.map(({ path, origin }) => [path, origin])).toEqual([
      [join(base, 'dev', 'neighbour'), 'sibling'],
      [linked, 'worktree'],
    ]);
  });
});
