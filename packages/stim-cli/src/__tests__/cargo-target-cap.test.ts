import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import {
  measureCargoTargets,
  planCargoTargets,
  selectCargoTargets,
  trimCargoTargetAction,
  type CargoTargetCandidate,
} from '../stimd/passes/cargo-target.ts';
import { resolveMaintenanceSettings } from '../stimd/passes/settings.ts';
import { saveConfig, upsertProject } from '../workspace/config.ts';

const afterProblem = vi.hoisted((): { run?: () => void } => ({}));
vi.mock('../workspace/regenerable-dirs.ts', async (original) => {
  const real = await original<typeof import('../workspace/regenerable-dirs.ts')>();
  return {
    ...real,
    regenerableDirProblem: async (...args: Parameters<typeof real.regenerableDirProblem>) => {
      const problem = await real.regenerableDirProblem(...args);
      afterProblem.run?.();
      return problem;
    },
  };
});
const protectedRoots = vi.hoisted((): { home: string; temps: string[] } => ({ home: '/nonexistent-home', temps: [] }));
vi.mock('../workspace/protected-locations.ts', async (original) => {
  const real = await original<typeof import('../workspace/protected-locations.ts')>();
  return { isProtectedLocation: (path: string) => real.isProtectedLocation(path, protectedRoots) };
});

const DAY = 24 * 3_600_000;
const candidate = (
  dir: string,
  discovered: boolean,
  measuredAt: number | null,
  identity = dir,
): CargoTargetCandidate => ({
  root: dir.replace(/\/target$/, ''),
  dir,
  identity,
  discovered,
  measuredAt,
});

describe('selectCargoTargets', () => {
  it('walks a directory once, prefers the registered owner, and rotates the discovered ones by last measurement', () => {
    const targets = [
      candidate('/alias/target', true, 1, '/a/target'),
      candidate('/a/target', false, 1),
      candidate('/b/target', true, 5),
      candidate('/c/target', true, null),
      candidate('/d/target', true, 3),
    ];
    const first = selectCargoTargets(targets, 2);
    expect(first.measured.map(({ dir }) => dir)).toEqual(['/a/target', '/c/target', '/d/target']);
    expect(first.unlisted.map(({ dir }) => dir)).toEqual(['/b/target']);

    const measured = new Set(first.measured.map(({ dir }) => dir));
    const next = selectCargoTargets(
      targets.map((entry) =>
        candidate(entry.dir, entry.discovered, measured.has(entry.dir) ? 9 : entry.measuredAt, entry.identity),
      ),
      2,
    );
    expect(next.measured.map(({ dir }) => dir)).toContain('/b/target');
  });

  it('breaks ties among never-measured targets differently from hour to hour, so a restart does not repeat the same few', () => {
    const targets = Array.from({ length: 12 }, (_, i) => candidate(`/t${i}/target`, true, null));
    const picks = [0, 1, 2, 3, 4, 5].map((hour) =>
      selectCargoTargets(targets, 6, hour * 3_600_000)
        .measured.map(({ dir }) => dir)
        .join(),
    );
    expect(new Set(picks).size).toBeGreaterThan(1);
  });
});

describe('the Cargo target cap over a root target/', () => {
  let base: string;
  let main: string;
  const settings = { ...resolveMaintenanceSettings(), cargoTargetMaxGb: 0.000001 };

  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' });

  function profile(target: string, path: string, ageMs: number): void {
    const dir = join(target, path);
    for (const part of ['.fingerprint', 'deps', 'build', 'incremental'])
      mkdirSync(join(dir, part), { recursive: true });
    writeFileSync(join(dir, 'deps', 'libx.rlib'), 'x'.repeat(5000));
    writeFileSync(join(dir, '.cargo-lock'), '');
    const at = new Date(Date.now() - ageMs);
    for (const part of ['.fingerprint', 'deps', 'build', 'incremental', '']) utimesSync(join(dir, part), at, at);
  }

  /** A root target/ as Cargo writes it, with the non-Cargo directories and the nested target/ a monorepo adds. */
  function monorepoTarget(checkout: string): string {
    const target = join(checkout, 'target');
    mkdirSync(target, { recursive: true });
    writeFileSync(
      join(target, 'CACHEDIR.TAG'),
      'Signature: 8a477f597d28d172789f06886806bc55\n# This file is a cache directory tag created by cargo.\n',
    );
    profile(target, 'debug', 3 * DAY);
    profile(target, 'release', 0);
    profile(target, 'exact-filesystem-tool/debug', 3 * DAY);
    mkdirSync(join(target, 'exact-filesystem-tool', 'exact-filesystem-bad498'), { recursive: true });
    writeFileSync(join(target, 'exact-filesystem-tool', '.bootstrap.claims'), '');
    profile(target, 'web-js-modules/target/debug', 3 * DAY);
    for (const dir of ['bake', 'clients', 'dev-generations', 'web-js-modules/data'])
      mkdirSync(join(target, dir), { recursive: true });
    writeFileSync(join(target, 'bake', 'out.bin'), 'x'.repeat(5000));
    return target;
  }

  const linked = (name: string, parent: string) => {
    const path = join(parent, name);
    mkdirSync(parent, { recursive: true });
    git(main, 'worktree', 'add', '-q', '-b', name, path);
    return realpathSync(path);
  };

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'stim-cargo-cap-')));
    vi.stubEnv('STIM_HOME', join(base, 'home'));
    saveConfig({ version: 2, projects: {}, repos: {}, maintenance: { discoverRoots: [join(base, 'roots')] } });
    main = join(base, 'roots', 'main');
    mkdirSync(main, { recursive: true });
    writeFileSync(join(main, 'package.json'), JSON.stringify({ dependencies: { expo: '*' } }));
    mkdirSync(join(main, 'ios', 'App.xcodeproj'), { recursive: true });
    writeFileSync(join(main, '.gitignore'), 'target/\n');
    git(main, 'init', '-q', '-b', 'main');
    git(main, 'add', '-A');
    git(main, 'commit', '-q', '-m', 'init');
  });

  afterEach(() => {
    delete afterProblem.run;
    protectedRoots.home = '/nonexistent-home';
    protectedRoots.temps = [];
    resetExecutor();
    vi.unstubAllEnvs();
    rmSync(base, { recursive: true, force: true });
  });

  function noProcesses(): void {
    const real = getExecutor();
    setExecutor({
      ...real,
      runFileAsync: async (file, args, options) =>
        file === 'lsof' || file === 'ps' ? '' : real.runFileAsync(file, args, options),
    });
  }

  it('a maintenance Cargo trim keeps the partial flag when its size walk times out', async () => {
    const wt = linked('partial', join(base, 'roots'));
    monorepoTarget(wt);
    noProcesses();
    const sizes = await measureCargoTargets(Date.now());
    const planned = await planCargoTargets({ sizes, settings, pinned: () => false, now: Date.now() });
    const action = planned.actions[0];
    if (!action) throw new Error('no trim was planned');
    const real = getExecutor();
    setExecutor({
      ...real,
      runFileAsync: async (file, args, options) => {
        if (file === 'du') throw Object.assign(new Error('timed out'), { code: 'ETIMEDOUT', stdout: '' });
        return real.runFileAsync(file, args, options);
      },
    });
    expect(await trimCargoTargetAction(action)).toMatchObject({ status: 'done', bytes: 0, partial: true });
  });

  it('trims the stale profiles of a discovered checkout root target and never a non-profile directory or a nested target', async () => {
    const wt = linked('wt', join(base, 'roots'));
    const target = monorepoTarget(wt);
    noProcesses();

    const sizes = await measureCargoTargets(Date.now());
    expect(sizes).toMatchObject([{ name: 'Cargo target', dir: join(wt, 'target'), workspace: wt }]);
    const planned = await planCargoTargets({ sizes, settings, pinned: () => false, now: Date.now() });
    const [action, ...others] = planned.actions;
    expect(others).toEqual([]);
    if (!action) throw new Error('no trim was planned');

    const outcome = await trimCargoTargetAction(action);

    expect(outcome).toMatchObject({ status: 'done' });
    expect(readdirSync(join(target, 'debug'))).toEqual(['.cargo-lock']);
    expect(readdirSync(join(target, 'exact-filesystem-tool', 'debug'))).toEqual(['.cargo-lock']);
    const stayed = [
      'exact-filesystem-tool/exact-filesystem-bad498',
      'exact-filesystem-tool/.bootstrap.claims',
      'release',
      'bake/out.bin',
      'clients',
      'dev-generations',
      'web-js-modules/target/debug/deps',
    ];
    expect(stayed.filter((path) => !existsSync(join(target, path)))).toEqual([]);
    expect(existsSync(join(target, '.stim-trimmed'))).toBe(false);
  });

  it('trims the stale profiles of an untagged target beside Cargo.toml and keeps what Cargo did not write', async () => {
    const wt = linked('untagged', join(base, 'roots'));
    const target = monorepoTarget(wt);
    rmSync(join(target, 'CACHEDIR.TAG'));
    writeFileSync(join(wt, 'Cargo.toml'), '[workspace]\n');
    noProcesses();

    const sizes = await measureCargoTargets(Date.now());
    expect(sizes).toMatchObject([{ name: 'Cargo target', dir: target, workspace: wt }]);
    const [action] = (await planCargoTargets({ sizes, settings, pinned: () => false, now: Date.now() })).actions;
    if (!action) throw new Error('no trim was planned');

    expect(await trimCargoTargetAction(action)).toMatchObject({ status: 'done' });
    expect(readdirSync(join(target, 'debug'))).toEqual(['.cargo-lock']);
    expect(['release', 'bake/out.bin', 'clients'].filter((path) => !existsSync(join(target, path)))).toEqual([]);
  });

  it('measures the root target of a registered checkout, and not a discovered worktree outside the managed folders', async () => {
    upsertProject(main, { metroPort: null });
    monorepoTarget(main);
    monorepoTarget(linked('elsewhere', join(base, 'other')));

    const sizes = await measureCargoTargets(Date.now());

    expect(sizes.map(({ dir }) => dir)).toEqual([join(main, 'target')]);
  });

  it('does not follow a target swapped for a link to another checkout while the trim is admitted', async () => {
    const wt = linked('wt', join(base, 'roots'));
    const target = monorepoTarget(wt);
    const other = monorepoTarget(linked('other', join(base, 'roots')));
    noProcesses();
    const sizes = await measureCargoTargets(Date.now());
    const action = (await planCargoTargets({ sizes, settings, pinned: () => false, now: Date.now() })).actions.find(
      (planned) => planned.target === target,
    );
    if (!action) throw new Error('no trim was planned');
    afterProblem.run = () => {
      delete afterProblem.run;
      renameSync(target, `${target}-moved`);
      symlinkSync(other, target);
    };

    const outcome = await trimCargoTargetAction(action);

    expect(outcome.status).toBe('kept');
    expect(existsSync(join(other, 'debug', 'deps', 'libx.rlib'))).toBe(true);
  });

  it('does not trim a target whose checkout left discovery scope after the plan was made', async () => {
    const wt = linked('wt', join(base, 'roots'));
    monorepoTarget(wt);
    noProcesses();
    const sizes = await measureCargoTargets(Date.now());
    const [action] = (await planCargoTargets({ sizes, settings, pinned: () => false, now: Date.now() })).actions;
    if (!action) throw new Error('no trim was planned');

    saveConfig({ version: 2, projects: {}, repos: {}, maintenance: { discoverRoots: [] } });
    const outcome = await trimCargoTargetAction(action);

    expect(outcome.status).toBe('kept');
    expect(existsSync(join(wt, 'target', 'debug'))).toBe(true);
  });

  it('ends planning at once when the pass is aborted', async () => {
    const wt = linked('wt', join(base, 'roots'));
    monorepoTarget(wt);
    const sizes = await measureCargoTargets(Date.now());
    const controller = new AbortController();
    controller.abort();
    await expect(
      planCargoTargets({ sizes, settings, pinned: () => false, now: Date.now(), signal: controller.signal }),
    ).rejects.toThrow(/abort/i);
  });

  it('measures a checkout inside a named discover root even under a home dot-folder or the temp directory', async () => {
    const dotfolder = join(base, 'home', '.tools');
    const scratch = join(base, 'scratch');
    const ok = join(base, 'home', 'Developer');
    protectedRoots.home = join(base, 'home');
    protectedRoots.temps = [scratch];
    saveConfig({
      version: 2,
      projects: {},
      repos: {},
      maintenance: { discoverRoots: [dotfolder, scratch, ok] },
    });
    for (const folder of [dotfolder, scratch, ok]) {
      const app = join(folder, 'app');
      mkdirSync(join(app, 'ios', 'App.xcodeproj'), { recursive: true });
      writeFileSync(join(app, 'package.json'), JSON.stringify({ dependencies: { expo: '*' } }));
      writeFileSync(join(app, '.gitignore'), 'target/\n');
      git(app, 'init', '-q', '-b', 'main');
      git(app, 'add', '-A');
      git(app, 'commit', '-q', '-m', 'init');
      monorepoTarget(app);
    }

    const sizes = await measureCargoTargets(Date.now());

    expect(sizes.map(({ dir }) => dir).toSorted()).toEqual(
      [dotfolder, scratch, ok].map((folder) => join(folder, 'app', 'target')).toSorted(),
    );
  });

  it('skips a root target whose files git does not ignore, and one without the Cargo tag', async () => {
    const wt = linked('wt', join(base, 'roots'));
    const target = monorepoTarget(wt);
    writeFileSync(join(wt, '.gitignore'), '');
    const bare = linked('bare', join(base, 'roots'));
    mkdirSync(join(bare, 'target', 'debug', '.fingerprint'), { recursive: true });

    const sizes = await measureCargoTargets(Date.now());
    const planned = await planCargoTargets({ sizes, settings, pinned: () => false, now: Date.now() });

    expect(sizes).toEqual([]);
    expect(planned.skips).toEqual([{ target, reason: expect.stringContaining('git does not ignore'), workspace: wt }]);
  });
});
