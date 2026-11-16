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
import { checkoutRootOf } from '../workspace/checkout-role.ts';
import { saveConfig } from '../workspace/config.ts';
import * as fsUtil from '../fs-util.ts';
import * as gitModule from '../workspace/git.ts';
import { collectArtifactsAsync } from '../stimd/passes/artifacts.ts';
import { answered } from '../workspace/bounded-read.ts';
import { freshLaunchers, launcherReason, launchingOf } from '../workspace/launchers.ts';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import { testContext } from './_context.ts';

vi.mock('../workspace/protected-locations.ts', () => ({ isProtectedLocation: () => false }));

const launcherDirs = vi.hoisted(() => {
  const state = { list: new Array<string>(), reads: 0 };
  const directories = () =>
    Object.assign([...state.list], {
      [Symbol.iterator]() {
        state.reads++;
        return Array.prototype[Symbol.iterator].call(this);
      },
    });
  return { state, directories };
});
vi.mock('../workspace/launcher-directories.ts', () => ({ launcherDirectories: launcherDirs.directories }));

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
      const path = join(dir, entry.name);
      if (entry.isDirectory() && entry.name !== '.git') age(path);
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
    writeFileSync(join(path, '.gitignore'), 'build/\nnode_modules/\ntarget/\n');
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
    launcherDirs.state.list = [bin];
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

    symlinkSync(tool, join(base, 'hop'));
    link(join(base, 'hop'));
    const kept = await idleOutputs(path, config, launchingOf(path, freshLaunchers(operation), operation));
    expect(kept.paths).not.toContain(outputs);
    expect(kept.kept).toEqual([expect.stringContaining('on PATH')]);

    unlinkSync(join(bin, 'tool'));
    const free = await idleOutputs(path, config, launchingOf(path, freshLaunchers(operation), operation));
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

  it('keeps the build output of a linked worktree found beside a registered project, and clears it when no executable links in', async () => {
    const main = join(base, 'dev', 'main');
    mkdirSync(main, { recursive: true });
    app(main);
    const beside = join(base, 'dev', 'beside');
    git(main, 'worktree', 'add', '-q', '-b', 'feature', beside);
    mkdirSync(join(beside, 'android', 'app', 'build', 'bin'), { recursive: true });
    writeFileSync(join(beside, 'android', 'app', 'build', 'bin', 'tool'), '#!/bin/sh\n');
    age(beside);
    ageGit(join(main, '.git', 'worktrees', 'beside'));
    vi.stubEnv('STIM_HOME', '');
    const config: Config = { version: 2, projects: { [main]: {} }, repos: {} };
    saveConfig(config);

    const idle = await stoppedOutputCandidates(config, reading, day);
    const candidate = idle.find((entry) => entry.path === beside) ?? fail();
    link(join(beside, 'android', 'app', 'build', 'bin', 'tool'));
    expect((await stoppedOutputCandidates(config, reading, day)).map((entry) => entry.path)).not.toContain(beside);
    expect(await clearStoppedOutputs(candidate, config, day)).toMatchObject({ outcome: 'kept' });
    expect(existsSync(join(beside, 'android', 'app', 'build'))).toBe(true);

    unlinkSync(join(bin, 'tool'));
    expect(await clearStoppedOutputs(candidate, config, day)).toMatchObject({ outcome: 'done' });
  });

  test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'leaves the owner of a checkout unknown, which keeps it, when a level cannot be read',
    async () => {
      const mono = join(base, 'dev', 'mono');
      mkdirSync(join(mono, 'apps', 'native'), { recursive: true });
      mkdirSync(join(mono, '.git'));
      chmodSync(mono, 0o000);
      try {
        const owner = await checkoutRootOf(join(mono, 'apps', 'native'));
        expect(owner).toMatchObject({ unknown: expect.stringContaining('EACCES') });
        expect(launcherReason(owner, { targets: [], incomplete: [] })).toContain('cannot be ruled out');
      } finally {
        chmodSync(mono, 0o755);
      }
    },
  );

  it('leaves the owner unknown at once while an earlier read is still pending, and finds it once that settles', async () => {
    const mono = join(base, 'dev', 'mono');
    mkdirSync(join(mono, 'apps'), { recursive: true });
    mkdirSync(join(mono, '.git'));
    let release: (value: string) => void = () => {};
    const stuck = answered('/stalled-mount', () => new Promise<string>((resolve) => (release = resolve)), 10).catch(
      () => 'timed out',
    );
    await vi.advanceTimersByTimeAsync(10);
    expect(await stuck).toBe('timed out');

    const owner = await checkoutRootOf(join(mono, 'apps'));
    expect(owner).toMatchObject({ unknown: expect.stringContaining('/stalled-mount') });
    expect(launcherReason(owner, { targets: [], incomplete: [] })).not.toBeNull();

    release('late');
    await vi.advanceTimersByTimeAsync(0);
    expect(await checkoutRootOf(join(mono, 'apps'))).toBe(mono);
  });

  it('keeps a source checkout dependency tree out of the selection when a link appears during its ignored-files read', async () => {
    const roots = join(base, 'roots');
    const path = join(roots, 'app');
    saveConfig({ version: 2, projects: {}, repos: {}, maintenance: { discoverRoots: [roots] } });
    app(path);
    mkdirSync(join(path, 'node_modules', 'dep'), { recursive: true });
    writeFileSync(join(path, 'node_modules', 'dep', 'cli'), 'x');
    age(path);
    const modules = join(path, 'node_modules');
    const options = { now: Date.now(), windowMs: 0, protectedRoot: '', pinned: () => false, source: true };
    const select = () => collectArtifactsAsync('dependencies', options, new AbortController().signal, testContext());

    expect((await select()).candidates.map((entry) => entry.path)).toContain(modules);

    const real = gitModule.gitQuietAsync;
    vi.spyOn(gitModule, 'gitQuietAsync').mockImplementation(async (...args) => {
      const out = await real(...args);
      if (args[1].includes('--others') && !existsSync(join(bin, 'tool'))) link(join(modules, 'dep', 'cli'));
      return out;
    });
    const kept = await select();
    expect(kept.candidates.map((entry) => entry.path)).not.toContain(modules);
    expect(kept.skips).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ target: modules, reason: expect.stringContaining('on PATH') }),
      ]),
    );
  });

  it('owns a registered app inside a monorepo by the worktree root, and a folder in no checkout by itself', async () => {
    const mono = join(base, 'dev', 'mono');
    mkdirSync(join(mono, 'apps', 'native'), { recursive: true });
    mkdirSync(join(mono, '.git'));
    mkdirSync(join(base, 'loose'));
    expect(await checkoutRootOf(join(mono, 'apps', 'native'))).toBe(mono);
    expect(await checkoutRootOf(mono)).toBe(mono);
    expect(await checkoutRootOf(join(base, 'loose'))).toBe(join(base, 'loose'));
  });

  describe('a discovered checkout cleared through clearStoppedOutputs, read through the production launcher reader', () => {
    const cargoApp = (path: string) => {
      app(path);
      mkdirSync(join(path, 'target', 'debug'), { recursive: true });
      writeFileSync(join(path, 'target', 'CACHEDIR.TAG'), 'Signature: 8a477f597d28d172789f06886806bc55\n');
      writeFileSync(join(path, 'target', 'debug', 'tool'), '#!/bin/sh\n');
      age(path);
    };
    const roots = () => join(base, 'roots');
    const configOf = (): Config => ({
      version: 2,
      projects: {},
      repos: {},
      maintenance: { discoverRoots: [roots()] },
    });

    it('keeps the Cargo target when a launcher appears during the Cargo process read of idleOutputs', async () => {
      const path = join(roots(), 'app');
      const config = configOf();
      saveConfig(config);
      cargoApp(path);
      const idle = await stoppedOutputCandidates(config, reading, day);
      const candidate = idle.find((entry) => entry.path === path) ?? fail();

      const real = getExecutor();
      let processReads = 0;
      setExecutor({
        ...real,
        runFileQuietAsync: (file, args, options) => {
          if (file === 'ps' && !args.includes('pid=,ppid=') && ++processReads === 2)
            link(join(path, 'target', 'debug', 'tool'));
          return real.runFileQuietAsync(file, args, options);
        },
      });
      try {
        await clearStoppedOutputs(candidate, config, day);
      } finally {
        resetExecutor();
      }
      expect(processReads).toBeGreaterThanOrEqual(2);
      expect(existsSync(join(path, 'target'))).toBe(true);
    });

    it('reads the launchers before each removal, so a link created after the first removal keeps the second output', async () => {
      const config = configOf();
      saveConfig(config);
      const twoOutputs = (name: string) => {
        const path = join(roots(), name);
        const tool = app(path);
        mkdirSync(join(path, 'android', 'build'), { recursive: true });
        writeFileSync(join(path, 'android', 'build', 'out'), 'x');
        age(path);
        return { path, tool, first: join(path, 'android', 'app', 'build'), second: join(path, 'android', 'build') };
      };
      const linked = twoOutputs('linked');
      const free = twoOutputs('free');
      const idle = await stoppedOutputCandidates(config, reading, day);
      const candidateOf = (path: string) => idle.find((entry) => entry.path === path) ?? fail();

      vi.spyOn(fsUtil, 'measuredDirectorySizeAsync').mockImplementation(async (dir) => {
        if (dir === linked.second && !existsSync(linked.first)) link(join(linked.second, 'out'));
        return 1;
      });
      const result = await clearStoppedOutputs(candidateOf(linked.path), config, day);
      expect(existsSync(linked.first)).toBe(false);
      expect(existsSync(linked.second)).toBe(true);
      expect(result).toMatchObject({ detail: expect.stringContaining(`kept ${linked.second}: an executable on PATH`) });

      unlinkSync(join(bin, 'tool'));
      expect(await clearStoppedOutputs(candidateOf(free.path), config, day)).toMatchObject({ outcome: 'done' });
      expect(existsSync(free.first)).toBe(false);
      expect(existsSync(free.second)).toBe(false);
    });

    it('keeps the build output when a launcher appears during the size walk, and clears it when none does', async () => {
      const path = join(roots(), 'app');
      const config = configOf();
      saveConfig(config);
      const tool = app(path);
      const idle = await stoppedOutputCandidates(config, reading, day);
      const candidate = idle.find((entry) => entry.path === path) ?? fail();

      vi.spyOn(fsUtil, 'measuredDirectorySizeAsync').mockImplementation(async () => {
        if (!existsSync(join(bin, 'tool'))) link(tool);
        return 1;
      });
      expect(await clearStoppedOutputs(candidate, config, day)).toMatchObject({
        detail: expect.stringContaining('on PATH'),
      });
      expect(existsSync(join(path, 'android', 'app', 'build'))).toBe(true);

      unlinkSync(join(bin, 'tool'));
      vi.spyOn(fsUtil, 'measuredDirectorySizeAsync').mockImplementation(async () => 1);
      expect(await clearStoppedOutputs(candidate, config, day)).toMatchObject({ outcome: 'done' });
      expect(existsSync(join(path, 'android', 'app', 'build'))).toBe(false);
    });
  });

  it('reads the launcher directories where it reads the running processes, once per process read, and once for planning', async () => {
    const roots = join(base, 'roots');
    const config: Config = { version: 2, projects: {}, repos: {}, maintenance: { discoverRoots: [roots] } };
    saveConfig(config);
    for (const name of ['a', 'b', 'c']) app(join(roots, name));
    const main = join(roots, 'main');
    mkdirSync(main, { recursive: true });
    app(main);
    const linked = join(roots, 'linked');
    git(main, 'worktree', 'add', '-q', '-b', 'feature', linked);
    mkdirSync(join(linked, 'node_modules', 'dep'), { recursive: true });
    writeFileSync(join(linked, 'node_modules', 'dep', 'cli'), 'x');
    age(main);
    age(linked);
    ageGit(join(main, '.git', 'worktrees', 'linked'));

    const real = getExecutor();
    let processReads = 0;
    let snapshotReads = 0;
    setExecutor({
      ...real,
      runFileQuietAsync: (file, args, options) => {
        if (file === 'ps' && args.includes('pid=,ppid=')) snapshotReads++;
        else if (file === 'ps') processReads++;
        return real.runFileQuietAsync(file, args, options);
      },
    });
    try {
      launcherDirs.state.reads = 0;
      processReads = 0;
      snapshotReads = 0;
      const idle = await stoppedOutputCandidates(config, reading, day);
      expect(idle).toHaveLength(4);
      expect([launcherDirs.state.reads, processReads, snapshotReads]).toEqual([1, 1, 1]);

      launcherDirs.state.reads = 0;
      processReads = 0;
      snapshotReads = 0;
      const pass = testContext();
      for (const candidate of idle) await clearStoppedOutputs(candidate, config, day, pass);
      expect(snapshotReads).toBe(idle.length);
      expect(launcherDirs.state.reads).toBe(snapshotReads + 2 * idle.length);

      launcherDirs.state.reads = 0;
      processReads = 0;
      snapshotReads = 0;
      const dependencies = (act: boolean) =>
        runDormantDependencies({
          config,
          act,
          log: () => {},
          ...reading,
          operation: testContext(),
          force: true,
        });
      await dependencies(false);
      const planned = snapshotReads;
      expect(launcherDirs.state.reads).toBe(1);

      launcherDirs.state.reads = 0;
      snapshotReads = 0;
      await dependencies(true);
      expect(snapshotReads).toBeGreaterThan(planned);
      expect(launcherDirs.state.reads).toBe(1 + (snapshotReads - planned) + 1);
      expect(existsSync(join(linked, 'node_modules'))).toBe(false);
    } finally {
      resetExecutor();
    }
  }, 60_000);
});
