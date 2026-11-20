import {
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
import { lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '@stim-cli/core/state';
import { runDormantDependencies } from '../daemon/dependencies.ts';
import { clearStoppedOutputs, idleStageCandidates, stoppedOutputCandidates } from '../daemon/stages.ts';
import { execFileSync } from 'node:child_process';
import { testContext } from './_context.ts';
import { loadConfig, saveConfig } from '../workspace/config.ts';
import * as activity from '../workspace/discovered-activity.ts';
import * as gitCommands from '../workspace/git.ts';
import { forgetGitReads, openGitReads } from '../workspace/git-reads.ts';
import { hungRead } from '../workspace/bounded-read.ts';
import * as metroStore from '../stimd/metro/metro-store.ts';

const fail = (): never => {
  throw new Error('no candidate');
};

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    lstat: vi.fn<typeof actual.lstat>(actual.lstat),
  };
});

vi.mock('../workspace/protected-locations.ts', () => ({
  isProtectedLocation: () => false,
}));

describe('a discovered checkout in the idle stages', () => {
  let base: string;
  const day = 86_400_000;
  const reading = { devices: [], simsFailed: false };

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'stim-discovered-stage-')));
    vi.stubEnv('STIM_HOME', join(base, 'home'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(base, { recursive: true, force: true });
  });

  it('walks a discovered checkout once per pass until the pass acts, however many stages read it', async () => {
    const roots = join(base, 'roots');
    const app = join(roots, 'app');
    mkdirSync(join(app, 'android', 'app', 'build'), { recursive: true });
    writeFileSync(join(app, 'package.json'), JSON.stringify({ dependencies: { expo: '*' } }));
    const old = new Date(Date.now() - 3 * day);
    for (const path of [app, join(app, 'package.json'), join(app, 'android'), join(app, 'android', 'app')])
      utimesSync(path, old, old);
    utimesSync(join(app, 'android', 'app', 'build'), old, old);
    const config: Config = { maintenance: { discoverRoots: [roots] }, projects: {}, repos: {} };
    const probe = vi.spyOn(gitCommands, 'gitQuietAsync');
    const walks = () => probe.mock.calls.filter(([cwd, args]) => cwd === app && args[0] === 'check-ignore').length;
    const operation = testContext();
    const close = openGitReads(operation);
    try {
      const stages = { ...reading, operation };
      expect((await stoppedOutputCandidates(config, stages, day)).map((entry) => entry.path)).toEqual([app]);
      expect((await idleStageCandidates(config, stages, day)).map((entry) => entry.path)).toEqual([app]);
      expect((await idleStageCandidates(config, stages, 2 * day)).map((entry) => entry.path)).toEqual([app]);
      expect(walks()).toBe(1);

      forgetGitReads(operation);
      await idleStageCandidates(config, stages, day);
      expect(walks()).toBe(2);
    } finally {
      close();
    }
  });

  const discoveredApp = (idle: Config['idle'], ...dirs: string[]) => {
    const roots = join(base, 'roots');
    const app = join(roots, 'app');
    for (const dir of ['android', ...dirs]) mkdirSync(join(app, dir), { recursive: true });
    writeFileSync(join(app, 'package.json'), JSON.stringify({ dependencies: { expo: '*' } }));
    const config: Config = { maintenance: { discoverRoots: [roots] }, projects: {}, repos: {}, idle };
    saveConfig(config);
    return { app, config };
  };
  const sourcePassOnly = { dormantDays: 0 };
  const committedAt = '2026-01-01T00:00:00Z';
  const gitIn = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
      env: { ...process.env, GIT_AUTHOR_DATE: committedAt, GIT_COMMITTER_DATE: committedAt },
    });
  const repo = (path: string) => {
    mkdirSync(join(path, 'android'), { recursive: true });
    writeFileSync(join(path, 'android', 'build.gradle'), '');
    writeFileSync(join(path, 'package.json'), JSON.stringify({ dependencies: { expo: '*' } }));
    writeFileSync(join(path, '.gitignore'), 'node_modules\n');
    gitIn(path, 'init', '-q', '-b', 'main');
    gitIn(path, 'add', '-A');
    gitIn(path, 'commit', '-q', '-m', 'init');
  };
  const treeProbes = (app: string) =>
    vi
      .mocked(lstat)
      .mock.calls.filter(([path]) => [join(app, 'node_modules'), join(app, 'ios', 'Pods')].includes(String(path)));

  it('starts no dependency read for a discovered folder git does not list, in the source-checkout pass', async () => {
    const { app, config } = discoveredApp(sourcePassOnly, 'node_modules');
    const evidence = vi.spyOn(activity, 'discoveredEvidence');
    const store = vi.spyOn(metroStore, 'metroStoreRoot');

    await runDormantDependencies({ config, act: false, log: () => {}, ...reading, operation: testContext() });

    expect(treeProbes(app)).toEqual([]);
    expect(evidence).not.toHaveBeenCalled();
    expect(store).not.toHaveBeenCalled();
  });

  it('skips a discovered checkout for the source-checkout pass when its dependency tree probe never answers', async () => {
    const roots = join(base, 'roots');
    const app = join(roots, 'app');
    repo(app);
    const config: Config = { maintenance: { discoverRoots: [roots] }, projects: {}, repos: {}, idle: sourcePassOnly };
    saveConfig(config);
    const target = join(app, 'node_modules');
    const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const stalled: (() => void)[] = [];
    let reached = () => {};
    const atProbe = new Promise<void>((resolve) => (reached = resolve));
    vi.mocked(lstat).mockImplementation((path, options) => {
      if (path !== target) return real.lstat(path, options);
      reached();
      return new Promise<never>((_, reject) => {
        stalled.push(() => reject(new Error('released')));
      });
    });
    const evidence = vi.spyOn(activity, 'discoveredEvidence');

    const run = runDormantDependencies({ config, act: false, log: () => {}, ...reading, operation: testContext() });
    await atProbe;
    await vi.advanceTimersByTimeAsync(3000);
    await run;

    expect(vi.mocked(lstat)).toHaveBeenCalledWith(target);
    expect(evidence).not.toHaveBeenCalled();
    vi.mocked(lstat).mockReset();
    for (const release of stalled) release();
    await vi.waitUntil(() => hungRead() === null);
  });

  it('lets a source checkout through the gate while another checkout holds the read slot, and ranks it once the slot frees mid-walk', async () => {
    const roots = join(base, 'roots');
    const stalledApp = join(roots, 'a-stalled');
    const app = join(roots, 'b-app');
    const aged = new Date(Date.now() - 30 * day);
    for (const path of [stalledApp, app]) {
      repo(path);
      mkdirSync(join(path, 'node_modules', 'dep'), { recursive: true });
      for (const entry of [
        join(path, 'node_modules', 'dep'),
        join(path, 'node_modules'),
        join(path, 'android', 'build.gradle'),
        join(path, 'android'),
        join(path, 'package.json'),
        join(path, '.gitignore'),
        path,
        join(path, '.git', 'index'),
        join(path, '.git', 'HEAD'),
        join(path, '.git', 'logs', 'HEAD'),
      ])
        utimesSync(entry, aged, aged);
    }
    const config: Config = { maintenance: { discoverRoots: [roots] }, projects: {}, repos: {}, idle: sourcePassOnly };
    saveConfig(config);
    const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const target = join(stalledApp, 'node_modules');
    let release = () => {};
    let released = false;
    let reached = () => {};
    const atProbe = new Promise<void>((resolve) => (reached = resolve));
    vi.mocked(lstat).mockImplementation((path, options) => {
      if (path !== target || released) return real.lstat(path, options);
      reached();
      return new Promise<never>((_, reject) => {
        release = () => reject(new Error('released'));
      });
    });
    const readEvidence = activity.discoveredEvidence;
    let slotBusyAtApp = false;
    const evidence = vi.spyOn(activity, 'discoveredEvidence').mockImplementation(async (path, options) => {
      if (path === app && hungRead() !== null) {
        slotBusyAtApp = true;
        released = true;
        setImmediate(release);
      }
      return readEvidence(path, options);
    });

    const run = runDormantDependencies({ config, act: false, log: () => {}, ...reading, operation: testContext() });
    await atProbe;
    await vi.advanceTimersByTimeAsync(3000);
    const actions = await run;

    expect(slotBusyAtApp).toBe(true);
    expect(evidence).toHaveBeenCalledWith(app, expect.anything());
    expect(actions.find((action) => action.target === join(app, 'node_modules'))?.detail).not.toMatch(/is not idle/);
    expect(actions.find((action) => action.target === target)?.detail).toMatch(/did not answer/);
    vi.mocked(lstat).mockReset();
  });

  it('probes no dependency tree of a linked worktree in the source-checkout pass, and still selects a source checkout', async () => {
    const roots = join(base, 'roots');
    const main = join(roots, 'main');
    repo(main);
    const linked = join(roots, 'main-wt');
    gitIn(main, 'worktree', 'add', '-q', '-b', 'feature', linked);
    const elsewhere = join(base, 'elsewhere', 'node_modules');
    mkdirSync(elsewhere, { recursive: true });
    symlinkSync(elsewhere, join(linked, 'node_modules'));
    const app = join(roots, 'app');
    repo(app);
    mkdirSync(join(app, 'node_modules', 'dep'), { recursive: true });
    const aged = new Date(Date.now() - 30 * day);
    const age = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory() && !entry.isSymbolicLink()) age(path);
        if (!entry.isSymbolicLink()) utimesSync(path, aged, aged);
      }
      utimesSync(dir, aged, aged);
    };
    for (const dir of [main, linked, app]) age(dir);
    const config: Config = { maintenance: { discoverRoots: [roots] }, projects: {}, repos: {}, idle: sourcePassOnly };
    saveConfig(config);
    const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const linkedTree = join(linked, 'node_modules');
    vi.mocked(lstat).mockImplementation((path, options) =>
      String(path).startsWith(linkedTree) || String(path).startsWith(elsewhere)
        ? new Promise<never>(() => {})
        : real.lstat(path, options),
    );
    const evidence = vi.spyOn(activity, 'discoveredEvidence');

    await runDormantDependencies({ config, act: false, log: () => {}, ...reading, operation: testContext() });

    expect(vi.mocked(lstat).mock.calls.filter(([path]) => String(path).startsWith(linkedTree))).toEqual([]);
    expect(evidence).toHaveBeenCalledWith(app, expect.anything());
    expect(evidence).not.toHaveBeenCalledWith(linked, expect.anything());
    vi.mocked(lstat).mockReset();
  });

  it('walks a discovered checkout with only in-tree build output in the linked-worktree pass, as before', async () => {
    const { app, config } = discoveredApp({ sourceDormantDays: 0 }, join('android', 'app', 'build'));
    const evidence = vi.spyOn(activity, 'discoveredEvidence');

    await runDormantDependencies({ config, act: false, log: () => {}, ...reading, operation: testContext() });

    expect(evidence).toHaveBeenCalledWith(app, expect.anything());
  });

  it('is a candidate once its source is idle, is kept after an edit, and gets no workspace directory', async () => {
    const roots = join(base, 'roots');
    const app = join(roots, 'app');
    mkdirSync(join(app, 'android', 'app', 'build'), { recursive: true });
    writeFileSync(join(app, 'package.json'), JSON.stringify({ dependencies: { expo: '*' } }));
    const old = new Date(Date.now() - 3 * day);
    for (const path of [
      app,
      join(app, 'package.json'),
      join(app, 'android'),
      join(app, 'android', 'app'),
      join(app, 'android', 'app', 'build'),
    ])
      utimesSync(path, old, old);
    const config: Config = { maintenance: { discoverRoots: [roots] }, projects: {}, repos: {} };

    const idle = await stoppedOutputCandidates(config, reading, day);
    expect(idle.map((entry) => entry.path)).toEqual([app]);

    writeFileSync(join(app, 'App.tsx'), '');
    expect(await stoppedOutputCandidates(config, reading, day)).toEqual([]);
    expect(existsSync(join(base, 'home', 'workspaces')) ? readdirSync(join(base, 'home', 'workspaces')) : []).toEqual(
      [],
    );
  });

  it('clears the ignored build output of an idle discovered checkout and nothing else, leaving no workspace record', async () => {
    const roots = join(base, 'roots');
    const app = join(roots, 'app');
    mkdirSync(join(app, 'android', 'app', 'build'), { recursive: true });
    writeFileSync(join(app, 'package.json'), JSON.stringify({ dependencies: { expo: '*' } }));
    writeFileSync(join(app, '.gitignore'), 'build/\n');
    writeFileSync(join(app, 'App.tsx'), 'source');
    writeFileSync(join(app, 'android', 'app', 'build', 'out.apk'), 'artifact');
    execFileSync('git', ['-C', app, 'init', '-q']);
    execFileSync('git', ['-C', app, 'add', '-A']);
    const when = new Date(Date.now() - 3 * day).toISOString();
    execFileSync('git', ['-C', app, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init'], {
      env: { ...process.env, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when },
    });
    const old = new Date(Date.now() - 3 * day);
    for (const path of [app, join(app, 'android', 'app', 'build', 'out.apk'), join(app, 'android', 'app', 'build')])
      utimesSync(path, old, old);
    for (const path of [join(app, 'android', 'app'), join(app, 'android'), join(app, 'App.tsx')])
      utimesSync(path, old, old);
    for (const name of ['package.json', '.gitignore']) utimesSync(join(app, name), old, old);
    for (const name of ['index', 'HEAD', join('logs', 'HEAD')]) utimesSync(join(app, '.git', name), old, old);
    const config: Config = { maintenance: { discoverRoots: [roots] }, projects: {}, repos: {} };
    const projectsBefore = JSON.stringify(loadConfig()?.projects ?? {});

    const candidates = await stoppedOutputCandidates(config, reading, day);
    expect(candidates.map((entry) => entry.path)).toEqual([app]);
    expect(await clearStoppedOutputs(candidates[0] ?? fail(), config, day)).toMatchObject({ outcome: 'done' });

    expect(existsSync(join(app, 'android', 'app', 'build'))).toBe(false);
    expect(existsSync(join(app, 'App.tsx'))).toBe(true);
    expect(JSON.stringify(loadConfig()?.projects ?? {})).toBe(projectsBefore);
    expect(existsSync(join(base, 'home', 'workspaces')) ? readdirSync(join(base, 'home', 'workspaces')) : []).toEqual(
      [],
    );
  });

  function cargoWorkspace(): string {
    const root = join(base, 'roots', 'framework');
    mkdirSync(join(root, 'apps', 'demo'), { recursive: true });
    for (const name of ['exact.mjs', 'app.json']) writeFileSync(join(root, 'apps', 'demo', name), '{}');
    writeFileSync(join(root, 'Cargo.toml'), '[workspace]\n');
    writeFileSync(join(root, '.gitignore'), 'target/\n');
    mkdirSync(join(root, 'target', 'debug', '.fingerprint'), { recursive: true });
    writeFileSync(join(root, 'target', 'debug', 'app'), 'binary');
    const when = '2026-01-01T00:00:00Z';
    for (const args of [
      ['init', '-q', '-b', 'main'],
      ['add', '-A'],
      ['commit', '-q', '-m', 'init'],
    ])
      execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
        env: { ...process.env, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when },
      });
    writeFileSync(join(root, 'notes.md'), 'uncommitted');
    const old = new Date(Date.now() - 3 * day);
    const age = (path: string) => {
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        if (entry.name === '.git') continue;
        if (entry.isDirectory()) age(join(path, entry.name));
        utimesSync(join(path, entry.name), old, old);
      }
      utimesSync(path, old, old);
    };
    age(root);
    for (const name of ['index', 'HEAD', join('logs', 'HEAD')]) utimesSync(join(root, '.git', name), old, old);
    return root;
  }

  it('never deletes the untagged target/ of an idle Cargo workspace root whole', async () => {
    const root = cargoWorkspace();
    const config: Config = { maintenance: { discoverRoots: [join(base, 'roots')] }, projects: {}, repos: {} };
    saveConfig(config);

    expect(await stoppedOutputCandidates(config, reading, day)).toEqual([]);
    expect(existsSync(join(root, 'target', 'debug', 'app'))).toBe(true);
  });

  it.each([
    ['a Cargo trim recovery copy', '.stim-not-restored-1-debug/.fingerprint/unit'],
    ['a stranded .stim-trimmed', '.stim-trimmed/NOT-RESTORED'],
  ])('dormant gc keeps a tagged target/ holding %s whole', async (_, extra) => {
    const root = cargoWorkspace();
    writeFileSync(join(root, 'target', 'CACHEDIR.TAG'), 'Signature: 8a477f597d28d172789f06886806bc55\n');
    mkdirSync(join(root, 'target', extra, '..'), { recursive: true });
    writeFileSync(join(root, 'target', extra), 'x');
    const config: Config = { maintenance: { discoverRoots: [join(base, 'roots')] }, projects: {}, repos: {} };
    saveConfig(config);

    expect(await stoppedOutputCandidates(config, reading, day)).toEqual([]);
    expect(existsSync(join(root, 'target', extra))).toBe(true);
    expect(existsSync(join(root, 'target', 'debug', 'app'))).toBe(true);
  });

  it('leaves a monorepo root whose only output is a Cargo target with CACHEDIR.TAG out of rung 1, clears the node_modules of a linked worktree, recording nothing', async () => {
    const roots = join(base, 'roots');
    const mono = join(roots, 'mono');
    mkdirSync(join(mono, 'apps', 'web'), { recursive: true });
    writeFileSync(join(mono, 'apps', 'web', 'package.json'), JSON.stringify({ dependencies: { expo: '*' } }));
    writeFileSync(join(mono, 'package.json'), JSON.stringify({ private: true }));
    mkdirSync(join(mono, 'target', 'debug'), { recursive: true });
    writeFileSync(join(mono, 'target', 'CACHEDIR.TAG'), 'Signature: 8a477f597d28d172789f06886806bc55\n');
    writeFileSync(join(mono, '.gitignore'), 'target/\nnode_modules/\n');
    const git = (cwd: string, ...args: string[]) =>
      execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
        env: { ...process.env, GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' },
      });
    git(mono, 'init', '-q', '-b', 'main');
    git(mono, 'add', '-A');
    git(mono, 'commit', '-q', '-m', 'init');
    const linked = join(roots, 'mono-wt');
    git(mono, 'worktree', 'add', '-q', '-b', 'feature', linked);
    mkdirSync(join(linked, 'node_modules', 'dep'), { recursive: true });
    writeFileSync(join(linked, 'node_modules', 'dep', 'index.js'), 'x');
    const old = new Date(Date.now() - 3 * day);
    const age = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === '.git' && entry.isDirectory()) continue;
        const path = join(dir, entry.name);
        if (entry.isDirectory()) age(path);
        utimesSync(path, old, old);
      }
      utimesSync(dir, old, old);
    };
    age(mono);
    age(linked);
    for (const dir of [join(mono, '.git'), join(mono, '.git', 'worktrees', 'mono-wt')])
      for (const name of ['index', 'HEAD', join('logs', 'HEAD')])
        if (existsSync(join(dir, name))) utimesSync(join(dir, name), old, old);
    const config: Config = { maintenance: { discoverRoots: [roots] }, projects: {}, repos: {} };

    saveConfig(config);
    expect(await stoppedOutputCandidates(config, reading, day)).toEqual([]);
    expect(existsSync(join(mono, 'target'))).toBe(true);

    const actions = await runDormantDependencies({
      config,
      act: true,
      log: () => {},
      ...reading,
      operation: testContext(),
      force: true,
    });
    expect(actions).toContainEqual(expect.objectContaining({ kind: 'delete-dependencies', outcome: 'done' }));
    expect(existsSync(join(linked, 'node_modules'))).toBe(false);
    expect(existsSync(join(base, 'home', 'workspaces')) ? readdirSync(join(base, 'home', 'workspaces')) : []).toEqual(
      [],
    );
  }, 20_000);
});
