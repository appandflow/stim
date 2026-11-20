import { execFileSync } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { planCargoTargetsAtPressure } from '../stimd/passes/cargo-target.ts';
import { resolveMaintenanceSettings } from '../stimd/passes/settings.ts';
import { clearDependency } from '../daemon/dependencies.ts';
import { answered } from '../workspace/bounded-read.ts';
import { testContext } from './_context.ts';
import {
  artifactCheckoutsAsync,
  artifactWorktreesAsync,
  clearArtifact,
  collectArtifactsAsync,
} from '../stimd/passes/artifacts.ts';
import { stoppedOutputCandidates } from '../daemon/stages.ts';
import { saveConfig } from '../workspace/config.ts';
import { collectWorktreeSweep, removeWorktrees } from '../commands/gc/worktrees.ts';
import { discoverCheckouts, discoveredOutside } from '../workspace/discovery.ts';

vi.mock('../workspace/protected-locations.ts', async (original) => {
  const real = await original<typeof import('../workspace/protected-locations.ts')>();
  return {
    ...real,
    isProtectedLocation: (path: string) => real.isProtectedLocation(path, { home: homedir(), temps: [] }),
  };
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

  const writeScan = (found: string[], dotFolderFound: string[] = []) => {
    mkdirSync(join(base, 'home', '.stim', 'maintenance'), { recursive: true });
    const scan = {
      version: 2,
      ranAt: 1,
      completedAt: 1,
      lowScanAt: 0,
      durationMs: 1,
      trigger: 'weekly',
      visited: 1,
      found,
      dotFolderFound,
      unreadable: [],
      truncated: false,
      truncation: 'none',
    };
    writeFileSync(join(base, 'home', '.stim', 'maintenance', 'discovery-scan.json'), JSON.stringify(scan));
  };

  it('never selects a checkout under a home dot-folder from the scan result, only through maintenance.discoverRoots', async () => {
    const exact = join(base, 'home', '.exact', 'exact2');
    mkdirSync(exact, { recursive: true });
    writeFileSync(join(exact, 'package.json'), JSON.stringify({ dependencies: { expo: '*' } }));
    const config = { projects: { [main]: {} }, repos: {} };
    writeScan([], [exact]);
    expect(await discoverCheckouts(config, [main])).toEqual([]);
    writeScan([exact], [exact]);
    expect(await discoverCheckouts(config, [main])).toEqual([]);
    const rooted = { ...config, maintenance: { discoverRoots: [join(base, 'home', '.exact')] } };
    expect(
      (await discoverCheckouts(rooted, [main])).map(({ path, origin, reduceOnly }) => [path, origin, reduceOnly]),
    ).toEqual([[exact, 'root', undefined]]);
  });

  it('selects the output of a scan-found checkout even when an executable on PATH links into it', async () => {
    const tool = join(base, 'home', 'tools', 'mytool');
    mkdirSync(join(tool, 'android', 'app', 'build', 'bin'), { recursive: true });
    writeFileSync(join(tool, 'package.json'), JSON.stringify({ dependencies: { expo: '*' } }));
    writeFileSync(join(tool, 'android', 'app', 'build', 'bin', 'mytool'), '#!/bin/sh\n');
    execFileSync('git', ['-C', tool, 'init', '-q']);
    writeFileSync(join(tool, '.gitignore'), 'build/\n');
    execFileSync('git', ['-C', tool, 'add', '-A']);
    execFileSync('git', ['-C', tool, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'x'], {
      env: { ...process.env, GIT_AUTHOR_DATE: old.toISOString(), GIT_COMMITTER_DATE: old.toISOString() },
    });
    age(tool);
    const gitdir = join(tool, '.git');
    for (const file of ['index', 'HEAD', join('logs', 'HEAD')]) utimesSync(join(gitdir, file), old, old);
    writeScan([tool]);
    const config = { projects: { [main]: {} }, repos: {} };
    const reading = { devices: [], simsFailed: false };
    expect((await stoppedOutputCandidates(config, reading, day)).map((entry) => entry.path)).toEqual([tool]);
    const bin = join(base, 'home', 'bin');
    mkdirSync(bin);
    symlinkSync(join(tool, 'android', 'app', 'build', 'bin', 'mytool'), join(bin, 'mytool'));
    expect((await stoppedOutputCandidates(config, reading, day)).map((entry) => entry.path)).toEqual([tool]);
  });

  describe('the artifact and dependency route for a scan-found linked worktree', () => {
    const operation = () => testContext({ env: {} });
    const scanFoundWorktree = () => {
      const found = worktree(join(base, 'home', 'projects', 'feature-wt'), 'feature');
      mkdirSync(join(found, 'node_modules', '.bin'), { recursive: true });
      writeFileSync(join(found, 'node_modules', '.bin', 'tool'), '#!/bin/sh\n');
      age(found);
      writeScan([found]);
      return { found, modules: join(found, 'node_modules') };
    };
    const { signal } = new AbortController();
    const collectOptions = { now: Date.now(), windowMs: 0, protectedRoot: '', pinned: () => false };
    const candidates = async () => collectArtifactsAsync('dependencies', collectOptions, signal, operation());
    const clear = async (modules: string, shared?: ReturnType<typeof operation>) => {
      return clearArtifact(
        { kind: 'would-delete-dependencies', target: modules, bytes: 0, reason: 'test' },
        'dependencies',
        {
          windowMs: 0,
          protectedRoot: '',
          pinned: () => false,
          worktrees: await artifactWorktreesAsync(signal, shared),
          ...(shared ? { operation: shared } : {}),
        },
      );
    };

    it('collects and clears node_modules', async () => {
      const { modules } = scanFoundWorktree();
      const found = await candidates();
      expect(found.candidates.map((entry) => entry.path)).toEqual([modules]);
      expect(await clear(modules)).toMatchObject({ status: 'done' });
      expect(existsSync(modules)).toBe(false);
    });

    describe('through clearDependency, whose final recheck is the idleness evidence', () => {
      const clearThroughRecheck = async () => {
        const { modules } = scanFoundWorktree();
        const shared = operation();
        const planned = await collectArtifactsAsync('dependencies', collectOptions, signal, shared);
        const [candidate] = planned.candidates;
        if (!candidate) throw new Error('no dependency candidate');
        const outcome = await clearDependency(
          {
            candidate,
            source: false,
            workspace: candidate.keys[0] ?? candidate.worktree,
            bytes: null,
            privateBytes: null,
          },
          day,
          '',
          await artifactWorktreesAsync(signal, shared),
          'test',
          shared,
          false,
        );
        return { outcome, modules };
      };

      it('clears it after the final recheck', async () => {
        const { outcome, modules } = await clearThroughRecheck();
        expect(outcome).toMatchObject({ status: 'done' });
        expect(existsSync(modules)).toBe(false);
      });
    });
  });

  it('leaves a cached scan find unselected while a read is pending, keeps it in the scan file, and selects it once the read settles', async () => {
    const tool = join(base, 'home', 'tools', 'mytool');
    mkdirSync(tool, { recursive: true });
    writeFileSync(join(tool, 'package.json'), JSON.stringify({ dependencies: { expo: '*' } }));
    writeScan([tool]);
    const file = join(base, 'home', '.stim', 'maintenance', 'discovery-scan.json');
    const before = readFileSync(file, 'utf8');
    let release: (value: string) => void = () => {};
    const hung = answered(
      'a stalled mount',
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
      10,
    ).catch(() => null);
    await vi.advanceTimersByTimeAsync(10);
    await hung;
    const config = { projects: { [main]: {} }, repos: {} };
    expect(await discoverCheckouts(config, [main])).toEqual([]);
    expect(readFileSync(file, 'utf8')).toBe(before);

    release('done');
    await vi.advanceTimersByTimeAsync(0);
    expect((await discoverCheckouts(config, [main])).map((entry) => entry.path)).toEqual([tool]);
  });

  it('drops a cached checkout that was replaced by a symlink to a folder the scan never enters, and plans nothing under it', async () => {
    const moved = join(base, 'elsewhere', 'app');
    mkdirSync(moved, { recursive: true });
    writeFileSync(join(moved, 'package.json'), JSON.stringify({ dependencies: { expo: '*' } }));
    mkdirSync(join(base, 'home', 'projects'), { recursive: true });
    const stale = join(base, 'home', 'projects', 'app');
    symlinkSync(moved, stale);
    writeScan([stale, moved]);
    const config = { projects: { [main]: {} }, repos: {} };
    expect(await discoverCheckouts(config, [main])).toEqual([]);
    const planned = await artifactCheckoutsAsync(new AbortController().signal);
    expect(planned.filter((entry) => entry.path.includes('elsewhere') || entry.path.includes('projects'))).toEqual([]);
  });

  it('holds a scan-found linked worktree at the removal plan', async () => {
    const found = worktree(join(base, 'home', 'projects', 'feature-wt'), 'feature');
    writeScan([found]);
    const planned = await collectWorktreeSweep({ idle: false, olderThan: null, now: Date.now(), refresh: false });
    expect(planned.worktrees.find((entry) => entry.path === found)).toMatchObject({
      discovered: true,
      reduceOnly: true,
      skipped: expect.stringContaining('never removes'),
    });
  });

  it('clears the build output of an idle reduce-only worktree in the dormant stage and leaves the worktree', async () => {
    const codex = worktree(join(base, 'home', '.codex', 'worktrees', 'ab12', 'main'), 'codex');
    mkdirSync(join(codex, 'android', 'app', 'build'), { recursive: true });
    age(codex);
    const config = { projects: { [main]: {} }, repos: {} };
    const stage = await stoppedOutputCandidates(config, { devices: [], simsFailed: false }, day);
    expect(stage.map((entry) => entry.path)).toEqual([codex]);
    expect(existsSync(codex)).toBe(true);
  });

  it('holds a tool-folder worktree from removal even when a discover root inside it adds a non-reduce-only child root', async () => {
    mkdirSync(join(main, 'packages', 'app'), { recursive: true });
    writeFileSync(join(main, 'packages', 'app', 'package.json'), JSON.stringify({ dependencies: { expo: '*' } }));
    git(main, 'add', '-A');
    git(main, 'commit', '-q', '-m', 'app');
    git(main, 'push', '-q', 'origin', 'main');
    const codex = worktree(join(base, 'home', '.codex', 'worktrees', 'aa11', 'main'), 'codex');
    const config = {
      version: 2 as const,
      projects: { [main]: {} },
      repos: {},
      maintenance: { discoverRoots: [join(codex, 'packages')] },
    };
    saveConfig(config);
    const found = await discoverCheckouts(config, [main]);
    expect(found.map(({ path, reduceOnly }) => [path, reduceOnly])).toEqual(
      expect.arrayContaining([
        [codex, true],
        [join(codex, 'packages', 'app'), undefined],
      ]),
    );
    const planned = await collectWorktreeSweep({ idle: false, olderThan: null, now: Date.now(), refresh: false });
    expect(planned.worktrees.find((entry) => entry.path === codex)).toMatchObject({
      reduceOnly: true,
      skipped: expect.stringContaining('never removes'),
    });
  });

  it('treats a tool-folder worktree as reduce-only for the artifact and Cargo passes too when a discover root inside it adds a child root', async () => {
    mkdirSync(join(main, 'packages', 'app'), { recursive: true });
    mkdirSync(join(main, 'ios', 'App.xcodeproj'), { recursive: true });
    writeFileSync(join(main, 'packages', 'app', 'package.json'), JSON.stringify({ dependencies: { expo: '*' } }));
    writeFileSync(join(main, 'ios', 'App.xcodeproj', 'project.pbxproj'), 'x');
    writeFileSync(join(main, '.gitignore'), 'target/\nnode_modules/\n');
    git(main, 'add', '-A');
    git(main, 'commit', '-q', '-m', 'app');
    git(main, 'push', '-q', 'origin', 'main');
    const codex = worktree(join(base, 'home', '.codex', 'worktrees', 'aa11', 'main'), 'codex');
    mkdirSync(join(codex, 'node_modules', '.bin'), { recursive: true });
    writeFileSync(join(codex, 'node_modules', '.bin', 'tool'), '#!/bin/sh\n');
    mkdirSync(join(codex, 'target', 'debug', '.fingerprint'), { recursive: true });
    mkdirSync(join(codex, 'target', 'debug', 'incremental'), { recursive: true });
    mkdirSync(join(codex, 'target', 'release'), { recursive: true });
    writeFileSync(join(codex, 'target', 'CACHEDIR.TAG'), 'Signature: 8a477f597d28d172789f06886806bc55\n');
    writeFileSync(join(codex, 'target', 'debug', 'incremental', 'data'), 'x'.repeat(10_000));
    writeFileSync(join(codex, 'target', 'release', 'tool'), '#!/bin/sh\n');
    age(codex);
    saveConfig({
      version: 2,
      projects: { [main]: {} },
      repos: {},
      maintenance: { discoverRoots: [join(codex, 'packages')] },
    });
    vi.stubEnv('STIM_MAINTENANCE_CARGO_TARGET_MAX_GB', '0.000001');
    const { signal } = new AbortController();
    const checkouts = await artifactCheckoutsAsync(signal, testContext({ env: {} }));
    expect(checkouts.map((entry) => entry.path)).toContain(codex);

    const options = { now: Date.now(), windowMs: 0, protectedRoot: '', pinned: () => false };
    const dependencies = (await collectArtifactsAsync('dependencies', options, signal, testContext({ env: {} })))
      .candidates;
    expect(dependencies.map((entry) => entry.path)).toContain(join(codex, 'node_modules'));
    const plan = () =>
      planCargoTargetsAtPressure({
        settings: resolveMaintenanceSettings(),
        pinned: () => false,
        now: Date.now(),
        level: 'high',
        operation: testContext({ env: {} }),
      });
    expect((await plan()).actions.map((action) => action.target)).toContain(join(codex, 'target'));
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
