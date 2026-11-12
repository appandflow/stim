import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
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

vi.mock('../workspace/protected-locations.ts', () => ({ isProtectedLocation: () => false }));

const DAY = 24 * 3_600_000;
const candidate = (dir: string, discovered: boolean, mtimeMs: number): CargoTargetCandidate => ({
  root: dir.replace(/\/target$/, ''),
  dir,
  discovered,
  mtimeMs,
});

describe('selectCargoTargets', () => {
  it('walks a directory once, prefers the registered owner, and bounds the discovered ones by recency', () => {
    const picked = selectCargoTargets(
      [
        candidate('/a/target', true, 1),
        candidate('/a/target', false, 1),
        candidate('/b/target', true, 5),
        candidate('/c/target', true, 9),
        candidate('/d/target', true, 7),
      ],
      2,
    );
    expect(picked.measured.map(({ dir }) => dir)).toEqual(['/a/target', '/c/target', '/d/target']);
    expect(picked.unlisted.map(({ dir }) => dir)).toEqual(['/b/target']);
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

    expect(outcome.status).toBe('done');
    expect(existsSync(join(target, 'debug'))).toBe(false);
    expect(existsSync(join(target, 'exact-filesystem-tool'))).toBe(false);
    const stayed = ['release', 'bake/out.bin', 'clients', 'dev-generations', 'web-js-modules/target/debug/deps'];
    expect(stayed.filter((path) => !existsSync(join(target, path)))).toEqual([]);
    expect(existsSync(join(target, '.stim-trimmed'))).toBe(false);
  });

  it('measures the root target of a registered checkout, and not a discovered worktree outside the managed folders', async () => {
    upsertProject(main, { metroPort: null });
    monorepoTarget(main);
    monorepoTarget(linked('elsewhere', join(base, 'other')));

    const sizes = await measureCargoTargets(Date.now());

    expect(sizes.map(({ dir }) => dir)).toEqual([join(main, 'target')]);
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
