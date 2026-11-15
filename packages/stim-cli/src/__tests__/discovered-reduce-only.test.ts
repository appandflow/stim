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
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { planCargoTargetsAtPressure, trimCargoTargetAction } from '../stimd/passes/cargo-target.ts';
import { resolveMaintenanceSettings } from '../stimd/passes/settings.ts';
import * as runningFrom from '../workspace/running-from.ts';
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
import {
  windowReduceOnly,
  discoverCheckouts,
  discoveredOutside,
  type DiscoveredCheckout,
} from '../workspace/discovery.ts';

vi.mock('../workspace/protected-locations.ts', async (original) => {
  const real = await original<typeof import('../workspace/protected-locations.ts')>();
  return {
    ...real,
    isProtectedLocation: (path: string) => real.isProtectedLocation(path, { home: homedir(), temps: [] }),
  };
});

const launcherDirs = vi.hoisted(() => ({ list: new Array<string>() }));
vi.mock('../workspace/launcher-directories.ts', () => ({ launcherDirectories: () => launcherDirs.list }));

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
    launcherDirs.list = [join(base, 'home', 'bin')];
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

  it('keeps the output of a scan-found checkout that an executable on PATH runs from', async () => {
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
    expect(await stoppedOutputCandidates(config, reading, day)).toEqual([]);
  });

  it('keeps the Cargo target of a scan-found checkout at high disk, in the plan and at the trim, while a PATH executable links into it', async () => {
    const tool = join(base, 'home', 'tools', 'mytool');
    mkdirSync(join(tool, 'ios', 'App.xcodeproj'), { recursive: true });
    mkdirSync(join(tool, 'target', 'debug', '.fingerprint'), { recursive: true });
    mkdirSync(join(tool, 'target', 'debug', 'incremental'), { recursive: true });
    mkdirSync(join(tool, 'target', 'release'), { recursive: true });
    writeFileSync(join(tool, 'package.json'), JSON.stringify({ dependencies: { expo: '*' } }));
    writeFileSync(join(tool, '.gitignore'), 'target/\n');
    writeFileSync(join(tool, 'target', 'CACHEDIR.TAG'), 'Signature: 8a477f597d28d172789f06886806bc55\n');
    writeFileSync(join(tool, 'target', 'debug', 'incremental', 'data'), 'x'.repeat(10_000));
    writeFileSync(join(tool, 'target', 'release', 'mytool'), '#!/bin/sh\n');
    execFileSync('git', ['-C', tool, 'init', '-q']);
    execFileSync('git', ['-C', tool, 'add', '-A']);
    execFileSync('git', ['-C', tool, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'x']);
    writeScan([tool]);
    vi.stubEnv('STIM_MAINTENANCE_CARGO_TARGET_MAX_GB', '0.000001');
    const operation = testContext({ env: {} });
    const plan = () =>
      planCargoTargetsAtPressure({
        settings: resolveMaintenanceSettings(),
        pinned: () => false,
        now: Date.now(),
        level: 'high',
        operation,
      });
    const planned = await plan();
    expect(planned.actions).toMatchObject([{ kind: 'would-clear-build-dirs', target: join(tool, 'target') }]);

    mkdirSync(join(base, 'home', 'bin'));
    symlinkSync(join(tool, 'target', 'release', 'mytool'), join(base, 'home', 'bin', 'mytool'));
    const kept = await planCargoTargetsAtPressure({
      settings: resolveMaintenanceSettings(),
      pinned: () => false,
      now: Date.now(),
      level: 'high',
      operation: testContext({ env: {} }),
    });
    expect(kept.actions).toEqual([]);
    expect(kept.skips).toMatchObject([{ target: join(tool, 'target'), reason: expect.stringContaining('on PATH') }]);
    const [action] = planned.actions;
    if (!action) throw new Error('no trim was planned');
    const trim = await trimCargoTargetAction(action, testContext({ env: {} }));
    expect(trim).toMatchObject({ status: 'kept', detail: expect.stringContaining('on PATH') });
  });

  it('keeps a nested app Cargo target when a PATH launcher resolves into the checkout outside that app, in the plan and at the trim', async () => {
    const mono = join(base, 'home', 'tools', 'mono');
    const app = join(mono, 'apps', 'native');
    mkdirSync(join(app, 'ios', 'App.xcodeproj'), { recursive: true });
    mkdirSync(join(app, 'target', 'debug', '.fingerprint'), { recursive: true });
    mkdirSync(join(app, 'target', 'debug', 'incremental'), { recursive: true });
    mkdirSync(join(mono, 'bin'), { recursive: true });
    writeFileSync(join(app, 'package.json'), JSON.stringify({ dependencies: { expo: '*' } }));
    writeFileSync(join(app, '.gitignore'), 'target/\n');
    writeFileSync(join(app, 'target', 'CACHEDIR.TAG'), 'Signature: 8a477f597d28d172789f06886806bc55\n');
    writeFileSync(join(app, 'target', 'debug', 'incremental', 'data'), 'x'.repeat(10_000));
    writeFileSync(join(mono, 'bin', 'tool'), '#!/bin/sh\n');
    execFileSync('git', ['-C', mono, 'init', '-q']);
    execFileSync('git', ['-C', mono, 'add', '-A']);
    execFileSync('git', ['-C', mono, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'x']);
    writeScan([mono]);
    vi.stubEnv('STIM_MAINTENANCE_CARGO_TARGET_MAX_GB', '0.000001');
    const plan = () =>
      planCargoTargetsAtPressure({
        settings: resolveMaintenanceSettings(),
        pinned: () => false,
        now: Date.now(),
        level: 'high',
        operation: testContext({ env: {} }),
      });
    const planned = await plan();
    expect(planned.actions).toMatchObject([{ kind: 'would-clear-build-dirs', target: join(app, 'target') }]);

    mkdirSync(join(base, 'home', 'bin'));
    symlinkSync(join(mono, 'bin', 'tool'), join(base, 'home', 'bin', 'tool'));
    const kept = await plan();
    expect(kept.actions).toEqual([]);
    expect(kept.skips).toMatchObject([{ target: join(app, 'target'), reason: expect.stringContaining('on PATH') }]);
    const [action] = planned.actions;
    if (!action) throw new Error('no trim was planned');
    expect(await trimCargoTargetAction(action, testContext({ env: {} }))).toMatchObject({
      status: 'kept',
      detail: expect.stringContaining('on PATH'),
    });
  });

  describe('the artifact and dependency route for a scan-found linked worktree', () => {
    const operation = () => testContext({ env: {} });
    const scanFoundWorktree = () => {
      const found = worktree(join(base, 'home', 'Documents', 'feature-wt'), 'feature');
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

    it('collects and clears node_modules without a PATH launcher', async () => {
      const { modules } = scanFoundWorktree();
      const found = await candidates();
      expect(found.candidates.map((entry) => entry.path)).toEqual([modules]);
      expect(await clear(modules)).toMatchObject({ status: 'done' });
      expect(existsSync(modules)).toBe(false);
    });

    it('keeps it, naming the launcher, when one appears after the plan, with the same operation at both', async () => {
      const { modules } = scanFoundWorktree();
      const bin = join(base, 'home', 'bin');
      mkdirSync(bin);
      const link = join(bin, 'tool');
      symlinkSync(join(modules, '.bin', 'tool'), link);
      const withLauncher = await candidates();
      expect(withLauncher.candidates).toEqual([]);
      expect(withLauncher.skips).toMatchObject([{ target: modules, reason: expect.stringContaining('on PATH') }]);
      rmSync(link);

      const shared = operation();
      const planned = await collectArtifactsAsync('dependencies', collectOptions, signal, shared);
      expect(planned.candidates.map((entry) => entry.path)).toEqual([modules]);
      symlinkSync(join(modules, '.bin', 'tool'), link);
      expect(await clear(modules, shared)).toMatchObject({
        status: 'kept',
        detail: expect.stringContaining('on PATH'),
      });
      expect(existsSync(modules)).toBe(true);
    });

    it('keeps it when a launcher appears after the process read that precedes the deletion', async () => {
      const { modules } = scanFoundWorktree();
      const link = join(base, 'home', 'bin', 'tool');
      mkdirSync(join(base, 'home', 'bin'));
      const shared = operation();
      const planned = await collectArtifactsAsync('dependencies', collectOptions, signal, shared);
      expect(planned.candidates.map((entry) => entry.path)).toEqual([modules]);
      const real = runningFrom.readRunningProcessesAsync;
      let reads = 0;
      vi.spyOn(runningFrom, 'readRunningProcessesAsync').mockImplementation(async (...args) => {
        if (++reads === 2) symlinkSync(join(modules, '.bin', 'tool'), link);
        return real(...args);
      });
      expect(await clear(modules, shared)).toMatchObject({
        status: 'kept',
        detail: expect.stringContaining('on PATH'),
      });
      expect(reads).toBeGreaterThanOrEqual(2);
      expect(existsSync(modules)).toBe(true);
    });

    test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
      'keeps it when a launcher directory becomes unreadable after the plan, naming the directory',
      async () => {
        const { modules } = scanFoundWorktree();
        const locked = join(base, 'home', 'locked-bin');
        mkdirSync(locked, { mode: 0o000 });
        try {
          const shared = operation();
          const planned = await collectArtifactsAsync('dependencies', collectOptions, signal, shared);
          expect(planned.candidates.map((entry) => entry.path)).toEqual([modules]);
          launcherDirs.list = [...launcherDirs.list, locked];
          const outcome = await clear(modules, shared);
          expect(outcome).toMatchObject({ status: 'kept', detail: expect.stringContaining(locked) });
          expect(existsSync(modules)).toBe(true);
        } finally {
          chmodSync(locked, 0o700);
        }
      },
    );
  });

  it('drops a cached checkout that was replaced by a symlink to a folder the scan never enters, and plans nothing under it', async () => {
    const moved = join(base, 'elsewhere', 'app');
    mkdirSync(moved, { recursive: true });
    writeFileSync(join(moved, 'package.json'), JSON.stringify({ dependencies: { expo: '*' } }));
    mkdirSync(join(base, 'home', 'Documents'), { recursive: true });
    const stale = join(base, 'home', 'Documents', 'app');
    symlinkSync(moved, stale);
    writeScan([stale, moved]);
    const config = { projects: { [main]: {} }, repos: {} };
    expect(await discoverCheckouts(config, [main])).toEqual([]);
    const planned = await artifactCheckoutsAsync(new AbortController().signal);
    expect(planned.filter((entry) => entry.path.includes('elsewhere') || entry.path.includes('Documents'))).toEqual([]);
  });

  it('holds a scan-found linked worktree at the removal plan', async () => {
    const found = worktree(join(base, 'home', 'Documents', 'feature-wt'), 'feature');
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

describe('windowReduceOnly', () => {
  const entry = (n: number, reduceOnly = true): DiscoveredCheckout => ({
    path: `/p/${String(n).padStart(3, '0')}`,
    origin: 'scan',
    from: 'full scan',
    ...(reduceOnly ? { reduceOnly: true } : {}),
  });
  const window = 15 * 60_000;
  const handled = (found: DiscoveredCheckout[]) => found.filter((e) => !e.deferred).map((e) => e.path);

  it('lists every checkout, defers all but a moving window of the reduce-only ones, and takes each in turn', () => {
    const all = [entry(1, false), ...Array.from({ length: 10 }, (_, i) => entry(i + 10))];
    const now = 100 * window;
    const first = windowReduceOnly(all, now, 4);
    expect(first.map((e) => e.path)).toEqual(all.map((e) => e.path));
    expect(first.filter((e) => e.reduceOnly && !e.deferred)).toHaveLength(4);
    expect(first[0]?.deferred).toBeUndefined();
    const seen = new Set<string>();
    for (let i = 0; i < 10; i++) for (const path of handled(windowReduceOnly(all, now + i * window, 4))) seen.add(path);
    expect(seen.size).toBe(all.length);
  });

  it('defers nothing when the reduce-only ones fit the limit', () => {
    const all = [entry(1), entry(2)];
    expect(windowReduceOnly(all, 0, 4)).toEqual(all);
  });
});
