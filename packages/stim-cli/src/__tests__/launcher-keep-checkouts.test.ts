import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '@stim-cli/core/state';
import { runDormantDependencies } from '../daemon/dependencies.ts';
import { idleOutputs } from '../daemon/idle.ts';
import { clearStoppedOutputs, stoppedOutputCandidates } from '../daemon/stages.ts';
import { collectWorktreeSweep, removeWorktrees } from '../commands/gc/worktrees.ts';
import { saveConfig } from '../workspace/config.ts';
import { launchingOf } from '../workspace/launchers.ts';
import { testContext } from './_context.ts';

vi.mock('../workspace/protected-locations.ts', () => ({ isProtectedLocation: () => false }));

const launcherDirs = vi.hoisted(() => ({ list: new Array<string>() }));
vi.mock('../workspace/launcher-directories.ts', () => ({ launcherDirectories: () => launcherDirs.list }));

const day = 86_400_000;
const old = new Date(Date.now() - 3 * day);
const reading = { devices: [], simsFailed: false };
const fail = (): never => {
  throw new Error('no candidate');
};

describe('an executable on PATH that links into a checkout keeps it, whichever way the checkout is known', () => {
  let base: string;
  let bin: string;

  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
      encoding: 'utf8',
      env: { ...process.env, GIT_AUTHOR_DATE: old.toISOString(), GIT_COMMITTER_DATE: old.toISOString() },
    });

  const age = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) age(path);
      utimesSync(path, old, old);
    }
    utimesSync(dir, old, old);
  };

  const ageGit = (gitdir: string) => {
    for (const name of ['index', 'HEAD', join('logs', 'HEAD')])
      if (existsSync(join(gitdir, name))) utimesSync(join(gitdir, name), old, old);
  };

  const app = (path: string) => {
    mkdirSync(join(path, 'android', 'app', 'build', 'bin'), { recursive: true });
    writeFileSync(join(path, 'package.json'), JSON.stringify({ dependencies: { expo: '*' } }));
    writeFileSync(join(path, '.gitignore'), 'build/\nnode_modules/\n');
    writeFileSync(join(path, 'android', 'app', 'build', 'bin', 'tool'), '#!/bin/sh\n');
    git(path, 'init', '-q', '-b', 'main');
    git(path, 'add', '-A');
    git(path, 'commit', '-q', '-m', 'init');
    age(path);
    ageGit(join(path, '.git'));
    return join(path, 'android', 'app', 'build', 'bin', 'tool');
  };

  const link = (to: string) => symlinkSync(to, join(bin, 'tool'));

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'stim-launcher-keep-')));
    bin = join(base, 'bin');
    mkdirSync(bin);
    launcherDirs.list = [bin];
    vi.stubEnv('STIM_HOME', join(base, 'home'));
    vi.stubEnv('HOME', join(base, 'home'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(base, { recursive: true, force: true });
  });

  it('keeps the build output of a child of maintenance.discoverRoots, at planning and at deletion, and clears it when none links in', async () => {
    const path = join(base, 'roots', 'app');
    const config: Config = {
      version: 2,
      projects: {},
      repos: {},
      maintenance: { discoverRoots: [join(base, 'roots')] },
    };
    saveConfig(config);
    const tool = app(path);

    const idle = await stoppedOutputCandidates(config, reading, day);
    expect(idle.map((entry) => entry.path)).toEqual([path]);
    const candidate = idle[0] ?? fail();

    link(tool);
    expect(await stoppedOutputCandidates(config, reading, day)).toEqual([]);
    expect(await clearStoppedOutputs(candidate, config, day)).toMatchObject({ outcome: 'kept' });
    expect(existsSync(join(path, 'android', 'app', 'build'))).toBe(true);

    unlinkSync(join(bin, 'tool'));
    expect(await clearStoppedOutputs(candidate, config, day)).toMatchObject({ outcome: 'done' });
    expect(existsSync(join(path, 'android', 'app', 'build'))).toBe(false);
  });

  it('keeps the build output of a registered workspace, and clears it when no executable links in', async () => {
    const path = join(base, 'dev', 'registered');
    const config: Config = { version: 2, projects: { [path]: {} }, repos: {} };
    saveConfig(config);
    const tool = app(path);
    const outputs = join(path, 'android', 'app', 'build');
    const operation = testContext({ env: {} });

    link(tool);
    const kept = await idleOutputs(path, config, launchingOf(path, operation));
    expect(kept.paths).not.toContain(outputs);
    expect(kept.kept).toEqual([expect.stringContaining('on PATH')]);

    unlinkSync(join(bin, 'tool'));
    const free = await idleOutputs(path, config, launchingOf(path, operation));
    expect(free.paths).toContain(outputs);
    expect(free.kept).toEqual([]);
  });

  test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'keeps a checkout while a launcher directory cannot be read',
    async () => {
      const roots = join(base, 'roots');
      const config: Config = { version: 2, projects: {}, repos: {}, maintenance: { discoverRoots: [roots] } };
      saveConfig(config);
      app(join(roots, 'app'));
      expect((await stoppedOutputCandidates(config, reading, day)).map((entry) => entry.path)).toEqual([
        join(roots, 'app'),
      ]);

      chmodSync(bin, 0o000);
      try {
        expect(await stoppedOutputCandidates(config, reading, day)).toEqual([]);
      } finally {
        chmodSync(bin, 0o755);
      }
    },
  );

  it('keeps the node_modules of a discovered linked worktree that an executable links into, and deletes them otherwise', async () => {
    const roots = join(base, 'roots');
    const main = join(roots, 'main');
    mkdirSync(main, { recursive: true });
    app(main);
    const linked = join(roots, 'linked');
    git(main, 'worktree', 'add', '-q', '-b', 'feature', linked);
    mkdirSync(join(linked, 'node_modules', 'dep', 'bin'), { recursive: true });
    writeFileSync(join(linked, 'node_modules', 'dep', 'bin', 'cli'), '#!/bin/sh\n');
    age(main);
    age(linked);
    ageGit(join(main, '.git', 'worktrees', 'linked'));
    const config: Config = { version: 2, projects: {}, repos: {}, maintenance: { discoverRoots: [roots] } };
    saveConfig(config);
    const run = () =>
      runDormantDependencies({ config, act: true, log: () => {}, ...reading, operation: testContext(), force: true });

    link(join(linked, 'node_modules', 'dep', 'bin', 'cli'));
    expect(await run()).not.toContainEqual(expect.objectContaining({ kind: 'delete-dependencies', outcome: 'done' }));
    expect(existsSync(join(linked, 'node_modules'))).toBe(true);

    unlinkSync(join(bin, 'tool'));
    expect(await run()).toContainEqual(expect.objectContaining({ kind: 'delete-dependencies', outcome: 'done' }));
    expect(existsSync(join(linked, 'node_modules'))).toBe(false);
  });

  it('keeps a registered linked worktree that an executable links into from removal, at planning and at deletion', async () => {
    const main = join(base, 'dev', 'main');
    mkdirSync(main, { recursive: true });
    app(main);
    git(base, 'init', '-q', '--bare', '-b', 'main', join(base, 'remote.git'));
    git(main, 'remote', 'add', 'origin', join(base, 'remote.git'));
    git(main, 'push', '-q', '-u', 'origin', 'main');
    git(main, 'remote', 'set-head', 'origin', 'main');
    const linked = join(base, 'dev', 'linked');
    git(main, 'worktree', 'add', '-q', '-b', 'feature', linked);
    mkdirSync(join(linked, 'android', 'app', 'build', 'bin'), { recursive: true });
    writeFileSync(join(linked, 'android', 'app', 'build', 'bin', 'tool'), '#!/bin/sh\n');
    age(linked);
    ageGit(join(main, '.git', 'worktrees', 'linked'));
    saveConfig({ version: 2, projects: { [main]: {}, [linked]: {} }, repos: {} });
    const sweep = () => collectWorktreeSweep({ idle: false, olderThan: null, now: Date.now(), refresh: false });
    const mine = async () => (await sweep()).worktrees.find((entry) => entry.path === linked) ?? fail();

    const planned = await mine();
    expect(planned.skipped).toBeNull();

    symlinkSync(join(linked, 'android', 'app', 'build', 'bin', 'tool'), join(bin, 'tool'));
    expect(await mine()).toMatchObject({ skipCode: 'in-use', skipped: expect.stringContaining('on PATH') });

    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await removeWorktrees({ idle: null, graceMs: 0, now: Date.now(), noOwnCommitsIdleMs: null, worktrees: [planned] });
    expect(existsSync(linked)).toBe(true);
  });
});
