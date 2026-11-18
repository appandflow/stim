import {
  currentSourceDependencies,
  diskUsageCacheFile,
  readJsonObject,
  readWorkspaceState,
  workspaceLightenedFile,
} from '@stim-cli/core/state';
import { execSync, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  chmodSync,
  linkSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { writeCacheFile } from '../cache-file.ts';
import { privateSizeKnowable, treeSignature } from '../private-size.ts';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import { readGcReport, runGc } from '../commands/gc.ts';
import { createStim } from '../api.ts';
import * as gcDevices from '../commands/gc/devices.ts';
import { loadConfig, saveConfig, upsertProject } from '../workspace/config.ts';
import { ensureWorkspaceStorage, workspaceStateFile } from '../workspace/paths.ts';
import { recordWorkspaceUse } from '../workspace/workspace-state.ts';
import { recordLightened, restoreLightenedDependencies } from '../workspace/lightened.ts';
import { recordWarmedFrom, takeWarmClaim } from '../workspace/source-dependencies.ts';
import { warmClaimPath } from '../engine/warm-claim.ts';
import { releaseClaim, tryAcquireClaim } from '../ownership-claim.ts';
import assert from 'node:assert';
import { liveClaimOwner, plantClaim } from './_factories.ts';
import { podLockHash } from '../workspace/lightened-pod-locks.ts';
import { testContext } from './_context.ts';

function recordedDirs(root: string): unknown {
  return readJsonObject(workspaceLightenedFile(root))?.dirs ?? [];
}

const warm = vi.hoisted((): { exitCode: 0 | 1; calls: string[]; restores: string[] } => ({
  exitCode: 0,
  calls: [],
  restores: [],
}));
vi.mock('../commands/worktree.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../commands/worktree.ts')>()),
  warmWorktreeTarget: async ({ cwd }: { cwd: string }) => {
    warm.calls.push(cwd);
    for (const dir of warm.restores) mkdirSync(dir, { recursive: true });
    return { exitCode: warm.exitCode };
  },
}));
vi.mock('../devices/machine-cache-usage.ts', () => ({ getMachineCacheReport: async () => null }));
const walks = vi.hoisted(
  () =>
    new Map<
      string,
      () => { bytes: number; privateBytes: number | null; privateUnknown?: 'volume' | 'walk'; partial?: true } | null
    >(),
);
vi.mock('../private-size.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../private-size.ts')>();
  return {
    ...real,
    measureTree: async (path: string, options: Parameters<typeof real.measureTree>[1]) => {
      const walk = walks.get(path);
      return walk ? walk() : real.measureTree(path, options);
    },
  };
});

let home: string;
let projects: string;

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'stim-test-')));
  projects = realpathSync(mkdtempSync(join(tmpdir(), 'stim-projects-')));
  process.env.STIM_HOME = home;
  process.env.STIM_GC_WORKTREE_GRACE_MINUTES = '0';
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  const real = getExecutor();
  setExecutor({
    ...real,
    run: () => '',
    runQuiet: () => null,
    runFile: (file, args, opts) => (file === 'du' || file === 'git' ? real.runFile(file, args, opts) : ''),
    runFileQuiet: (file, args, opts) =>
      ['git', 'ps', 'lsof'].includes(file) ? real.runFileQuiet(file, args, opts) : null,
    findExecutable: (name) => (name === 'gh' || name === 'stim' ? null : real.findExecutable(name)),
    spawn: () => {
      throw new Error('unexpected spawn');
    },
  });
  saveConfig({ version: 2, projects: {}, repos: {} });
  warm.exitCode = 0;
  warm.calls = [];
  warm.restores = [];
  walks.clear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetExecutor();
  rmSync(home, { recursive: true, force: true });
  rmSync(projects, { recursive: true, force: true });
  delete process.env.STIM_HOME;
  delete process.env.STIM_GC_WORKTREE_GRACE_MINUTES;
  process.exitCode = 0;
});

function ageTree(path: string, at: Date) {
  let entries: string[] = [];
  try {
    entries = readdirSync(path);
  } catch {}
  for (const name of entries) ageTree(join(path, name), at);
  utimesSync(path, at, at);
}

function write(path: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, 'x');
}

function measureTrees(root: string) {
  for (const path of [join(root, 'node_modules'), join(root, 'ios', 'Pods')]) {
    const bytes = 512 * 1024 ** 2;
    writeCacheFile(diskUsageCacheFile(path), {
      path,
      measuredAt: new Date().toISOString(),
      bytes,
      privateBytes: bytes,
      signature: treeSignature(path),
    });
  }
}

function idleRepo(worktrees: { name: string; workspace: boolean }[]): Record<string, string> {
  const repo = join(projects, 'repo');
  mkdirSync(repo, { recursive: true });
  const long = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const git = (args: string, cwd = repo) =>
    execSync(`git ${args}`, {
      cwd,
      encoding: 'utf-8',
      timeout: 15_000,
      env: { ...process.env, GIT_AUTHOR_DATE: long, GIT_COMMITTER_DATE: long },
    }).trim();
  git('init -q -b main');
  git('config user.email test@example.com');
  git('config user.name test');
  writeFileSync(join(repo, '.gitignore'), 'node_modules/\nios/\n');
  writeFileSync(join(repo, 'package.json'), '{}');
  writeFileSync(join(repo, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
  git('add -A');
  git('commit -q -m init');
  const roots: Record<string, string> = { repo: realpathSync.native(repo) };
  for (const { name } of worktrees) {
    git(`worktree add -q "${join(projects, name)}" -b ${name}`);
    roots[name] = realpathSync.native(join(projects, name));
  }
  const hourAgo = new Date(Date.now() - 60 * 60_000);
  for (const [name, root] of Object.entries(roots)) {
    write(join(root, 'node_modules', 'pkg', 'index.js'));
    write(join(root, 'ios', 'Pods', 'Manifest.lock'));
    ageTree(root, hourAgo);
    measureTrees(root);
    if (name === 'repo' || worktrees.find((entry) => entry.name === name)?.workspace) {
      upsertProject(root, { metroPort: null });
      recordWorkspaceUse(root, hourAgo);
      ensureWorkspaceStorage(root);
      utimesSync(workspaceStateFile(root), hourAgo, hourAgo);
    }
    const gitDir = git('rev-parse --path-format=absolute --git-dir', root);
    for (const file of ['index', 'HEAD', join('logs', 'HEAD')])
      if (existsSync(join(gitDir, file))) utimesSync(join(gitDir, file), hourAgo, hourAgo);
  }
  return roots;
}

async function gcJson(pressure: 'normal' | 'high' | 'critical' = 'critical') {
  const stdout: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((...args) => void stdout.push(args.join(' ')));
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await runGc({ dryRun: true, pressure, json: true });
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
  return { payload: JSON.parse(stdout[0] ?? '') };
}

async function quietly(fn: () => Promise<unknown>): Promise<string> {
  const lines: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((...args) => void lines.push(args.join(' ')));
  try {
    await fn();
  } finally {
    log.mockRestore();
  }
  return lines.join('\n');
}

type LevelPayload = {
  actions: { rung: number | null; kind: string; target: string; outcome: string; detail?: string }[];
};

function criticalDependencies(payload: LevelPayload): string[] {
  return payload.actions.flatMap((action) =>
    action.kind === 'delete-dependencies' && action.outcome !== 'kept' ? [action.target] : [],
  );
}

test.skipIf(process.platform === 'win32')(
  'gc at critical never deletes the dependencies of a git-locked worktree',
  async () => {
    const roots = idleRepo([
      { name: 'feature', workspace: true },
      { name: 'rollback', workspace: true },
    ]);
    execSync(`git worktree lock --reason rollback "${roots.rollback}"`, { cwd: roots.repo, timeout: 15_000 });

    const { payload } = await gcJson();
    await quietly(() => runGc({ pressure: 'critical' }));

    expect(criticalDependencies(payload)).toContain(join(roots.feature!, 'node_modules'));
    expect(criticalDependencies(payload).filter((path) => path.startsWith(`${roots.rollback}/`))).toEqual([]);
    expect(existsSync(join(roots.feature!, 'node_modules'))).toBe(false);
    expect(existsSync(join(roots.rollback!, 'node_modules', 'pkg', 'index.js'))).toBe(true);
    expect(existsSync(join(roots.rollback!, 'ios', 'Pods', 'Manifest.lock'))).toBe(true);
  },
  60_000,
);

test.skipIf(process.platform === 'win32')(
  'gc at normal keeps dependencies idle less than idle.dormantDays, and at critical deletes those of an idle linked worktree that warm can restore and nothing runs in, then the source checkout',
  async () => {
    const scope = vi.spyOn(gcDevices, 'deviceSweepIsScoped').mockReturnValue(false);
    const roots = idleRepo([
      { name: 'feature', workspace: true },
      { name: 'busy', workspace: true },
      { name: 'keyless', workspace: false },
      { name: 'drifted', workspace: true },
    ]);
    const at = (name: string): string => {
      const root = roots[name];
      if (!root) throw new Error(`no worktree ${name}`);
      return root;
    };
    writeFileSync(join(at('drifted'), 'pnpm-lock.yaml'), 'lockfileVersion: 9\npackages: {}\n');
    const child = spawn('sleep', ['60'], { cwd: roots.busy, stdio: 'ignore' });
    try {
      const { payload }: { payload: LevelPayload } = await gcJson();
      const critical = payload.actions.filter((action) => action.kind === 'delete-dependencies');
      expect(critical.find((action) => action.target === join(at('feature'), 'node_modules'))?.outcome).toBe('would');
      const planned = criticalDependencies(payload);
      expect(planned.indexOf(join(at('repo'), 'node_modules'))).toBeGreaterThan(
        planned.indexOf(join(at('feature'), 'node_modules')),
      );
      expect(critical.find((action) => action.target === join(at('drifted'), 'node_modules'))?.outcome).toBe('kept');
      await quietly(() => runGc({ pressure: 'normal' }));
      expect(existsSync(join(at('feature'), 'node_modules', 'pkg', 'index.js'))).toBe(true);
      await quietly(() => runGc({ pressure: 'critical' }));
    } finally {
      child.kill('SIGKILL');
      scope.mockRestore();
    }

    expect(existsSync(join(at('feature'), 'node_modules'))).toBe(false);
    expect(recordedDirs(at('feature'))).toEqual([join(at('feature'), 'node_modules')]);
    for (const name of ['busy', 'keyless', 'drifted'])
      expect(existsSync(join(at(name), 'node_modules', 'pkg', 'index.js'))).toBe(true);
    expect(existsSync(join(at('feature'), 'ios', 'Pods', 'Manifest.lock'))).toBe(true);
  },
  60_000,
);

test.skipIf(process.platform === 'win32')(
  'gc at normal reduces a linked worktree idle idle.dormantDays even when warm cannot restore it, and keeps the source checkout, a pinned one and one a process runs in',
  async () => {
    const roots = idleRepo([
      { name: 'feature', workspace: true },
      { name: 'drifted', workspace: true },
      { name: 'busy', workspace: true },
      { name: 'pinned', workspace: true },
    ]);
    const at = (name: string): string => roots[name] ?? '';
    saveConfig({ ...loadConfig()!, idle: { dormantDays: 0.01 } });
    writeFileSync(join(at('drifted'), 'pnpm-lock.yaml'), 'lockfileVersion: 9\npackages: {}\n');
    writeFileSync(join(at('pinned'), '.stim.json'), JSON.stringify({ maintenance: { keep: true } }));
    const child = spawn('sleep', ['60'], { cwd: at('busy'), stdio: 'ignore' });
    try {
      await quietly(() => runGc({ dryRun: true, pressure: 'normal' }));
      expect(existsSync(join(at('feature'), 'node_modules', 'pkg', 'index.js'))).toBe(true);
      await quietly(() => runGc({ pressure: 'normal' }));
    } finally {
      child.kill('SIGKILL');
    }
    for (const name of ['feature', 'drifted']) {
      expect(existsSync(join(at(name), 'node_modules'))).toBe(false);
      expect(recordedDirs(at(name))).toContain(join(at(name), 'node_modules'));
    }
    for (const name of ['repo', 'busy', 'pinned'])
      expect(existsSync(join(at(name), 'node_modules', 'pkg', 'index.js'))).toBe(true);
  },
  60_000,
);

test.skipIf(process.platform === 'win32')(
  'gc keeps the dependencies of an idle worktree whose files were edited after the install, at critical too',
  async () => {
    const feature = idleRepo([{ name: 'feature', workspace: true }]).feature ?? '';
    const modules = join(feature, 'node_modules');
    const config = loadConfig();
    if (!config) throw new Error('no config');
    saveConfig({ ...config, idle: { dormantDays: 0.01 } });
    writeFileSync(join(modules, 'pkg', 'index.js'), 'patched by hand');
    utimesSync(join(modules, 'pkg', 'index.js'), new Date(), new Date());

    const { payload }: { payload: LevelPayload } = await gcJson('normal');
    await quietly(() => runGc({ pressure: 'normal' }));

    const kept = payload.actions.find((action) => action.kind === 'delete-dependencies' && action.target === modules);
    expect(kept?.outcome).toBe('kept');
    expect(kept?.detail).toContain('pkg/index.js');
    expect(existsSync(join(modules, 'pkg', 'index.js'))).toBe(true);

    await quietly(() => runGc({ pressure: 'critical' }));

    expect(readFileSync(join(modules, 'pkg', 'index.js'), 'utf-8')).toBe('patched by hand');
  },
  60_000,
);

test.skipIf(process.platform === 'win32')(
  'a scoped STIM_HOME does not consider the dependencies of a linked worktree it does not list',
  async () => {
    const roots = idleRepo([
      { name: 'feature', workspace: true },
      { name: 'keyless', workspace: false },
    ]);

    const { payload } = await gcJson();

    const paths = criticalDependencies(payload);
    expect(paths.some((path) => path.startsWith(`${roots.feature}/`))).toBe(true);
    expect(paths.some((path) => path.startsWith(`${roots.keyless}/`))).toBe(false);
  },
  60_000,
);

test.skipIf(process.platform === 'win32')(
  'lightening ios/Pods records the hash of the Podfile.lock its Manifest.lock matches',
  () => {
    const root = idleRepo([{ name: 'feature', workspace: true }]).feature ?? '';
    writeFileSync(join(root, 'ios', 'Podfile.lock'), 'PODS: []\n');
    writeFileSync(join(root, 'ios', 'Pods', 'Manifest.lock'), 'PODS: []\n');
    recordLightened([root], join(root, 'ios', 'Pods'));
    expect(readJsonObject(workspaceLightenedFile(root))?.locks).toEqual({
      [join(root, 'ios', 'Podfile.lock')]: podLockHash('PODS: []\n'),
    });
    writeFileSync(join(root, 'ios', 'Pods', 'Manifest.lock'), 'PODS:\n  - other\n');
    recordLightened([root], join(root, 'ios', 'Pods'));
    expect(Object.keys(readJsonObject(workspaceLightenedFile(root))?.locks ?? {})).toHaveLength(1);
  },
);

test.skipIf(process.platform === 'win32')(
  'a lightened workspace restores through worktree warm and forgets the record only once the directories are back',
  async () => {
    const root = idleRepo([{ name: 'feature', workspace: true }]).feature ?? '';
    const dir = join(root, 'node_modules');
    rmSync(dir, { recursive: true, force: true });
    const context = testContext({ cwd: root, projectRoot: root });

    expect(await restoreLightenedDependencies(root, context)).toBeNull();
    expect(warm.calls).toEqual([]);

    recordLightened([root], dir);
    warm.exitCode = 1;
    expect(await restoreLightenedDependencies(root, context)).toMatchObject({ code: 'STIM_DEPS_FAILED' });
    warm.exitCode = 0;
    expect(await restoreLightenedDependencies(root, context)).toMatchObject({ code: 'STIM_DEPS_FAILED' });
    expect(recordedDirs(root)).toEqual([dir]);

    writeFileSync(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\npackages: {}\n');
    expect(await restoreLightenedDependencies(root, context)).toMatchObject({
      message: expect.stringContaining('pnpm-lock.yaml differs'),
    });
    expect(warm.calls).toEqual([root, root]);
    execSync('git checkout -- pnpm-lock.yaml', { cwd: root });
    const sourceInstall = join(projects, 'repo', 'node_modules', '.pnpm', 'lock.yaml');
    write(sourceInstall);
    expect(await restoreLightenedDependencies(root, context)).toMatchObject({
      message: expect.stringContaining('was not installed from its own lockfile'),
    });
    rmSync(sourceInstall);

    warm.restores = [dir];
    expect(await restoreLightenedDependencies(root, context)).toBeNull();
    expect(warm.calls).toEqual([root, root, root]);
    expect(recordedDirs(root)).toEqual([]);

    write(join(dir, 'partial'));
    recordLightened([root], dir);
    expect(await restoreLightenedDependencies(root, context)).toBeNull();
    expect(existsSync(join(dir, 'partial'))).toBe(false);
    expect(warm.calls).toHaveLength(4);
  },
  60_000,
);

function ageCheckout(root: string, at: Date) {
  recordWorkspaceUse(root, at);
  utimesSync(workspaceStateFile(root), at, at);
  ageTree(root, at);
  measureTrees(root);
  const gitDir = execSync('git rev-parse --path-format=absolute --git-dir', { cwd: root, encoding: 'utf-8' }).trim();
  for (const file of ['index', 'HEAD', join('logs', 'HEAD')])
    if (existsSync(join(gitDir, file))) utimesSync(join(gitDir, file), at, at);
}

const currentConfig = () => loadConfig() ?? { version: 2 as const, projects: {}, repos: {} };
const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000);

test.skipIf(process.platform === 'win32')(
  'gc at critical takes the source checkout dependencies after the linked worktrees, records it, and the record ends once they are installed',
  async () => {
    const roots = idleRepo([{ name: 'feature', workspace: true }]);
    const source = roots.repo ?? '';

    const { payload } = await gcJson();
    const order = criticalDependencies(payload);
    expect(order.indexOf(join(source, 'node_modules'))).toBeGreaterThan(
      order.indexOf(join(roots.feature ?? '', 'node_modules')),
    );
    expect(order).toContain(join(source, 'ios', 'Pods'));
    await quietly(() => runGc({ pressure: 'critical' }));

    expect(existsSync(join(source, 'node_modules'))).toBe(false);
    expect(existsSync(join(source, 'ios', 'Pods'))).toBe(false);
    const cleared = currentSourceDependencies(readWorkspaceState(source));
    expect(cleared?.dirs.toSorted()).toEqual([join(source, 'ios', 'Pods'), join(source, 'node_modules')]);
    expect(readWorkspaceState(roots.feature ?? '')?.sourceDependenciesCleared).toBeUndefined();

    write(join(source, 'node_modules', 'pkg', 'index.js'));
    expect(currentSourceDependencies(readWorkspaceState(source))?.dirs).toEqual([join(source, 'ios', 'Pods')]);
    write(join(source, 'ios', 'Pods', 'Manifest.lock'));
    expect(currentSourceDependencies(readWorkspaceState(source))).toBeNull();
  },
  60_000,
);

test.skipIf(process.platform === 'win32')(
  'the source checkout dependencies are not a candidate at high, and critical keeps one a process runs in or maintenance.keep pins',
  async () => {
    const roots = idleRepo([{ name: 'feature', workspace: true }]);
    const source = roots.repo ?? '';

    const high = await gcJson('high');
    expect(criticalDependencies(high.payload).some((path) => path.startsWith(`${source}/`))).toBe(false);

    const child = spawn('sleep', ['60'], { cwd: source, stdio: 'ignore' });
    try {
      await quietly(() => runGc({ pressure: 'critical' }));
      expect(existsSync(join(source, 'node_modules', 'pkg', 'index.js'))).toBe(true);
    } finally {
      child.kill('SIGKILL');
    }
    writeFileSync(join(source, '.stim.json'), JSON.stringify({ maintenance: { keep: true } }));
    ageTree(source, new Date(Date.now() - 60 * 60_000));
    await quietly(() => runGc({ pressure: 'critical' }));
    expect(existsSync(join(source, 'node_modules', 'pkg', 'index.js'))).toBe(true);
    expect(existsSync(join(roots.feature ?? '', 'node_modules'))).toBe(false);
  },
  60_000,
);

test.skipIf(process.platform === 'win32')(
  'at normal a source checkout idle idle.sourceDormantDays loses its dependencies; fewer days, a recent warm from it, or the setting 0 keep them',
  async () => {
    const roots = idleRepo([{ name: 'feature', workspace: true }]);
    const source = roots.repo ?? '';
    const kept = () => existsSync(join(source, 'node_modules', 'pkg', 'index.js'));

    ageCheckout(source, daysAgo(6));
    await quietly(() => runGc({ pressure: 'normal' }));
    expect(kept()).toBe(true);

    ageCheckout(source, daysAgo(8));
    recordWarmedFrom(source, daysAgo(2));
    await quietly(() => runGc({ pressure: 'normal' }));
    expect(kept()).toBe(true);

    saveConfig({ ...currentConfig(), idle: { sourceDormantDays: 0 } });
    ageCheckout(source, daysAgo(8));
    await quietly(() => runGc({ pressure: 'normal' }));
    expect(kept()).toBe(true);

    saveConfig({ ...currentConfig(), idle: {} });
    recordWarmedFrom(source, daysAgo(9));
    await quietly(() => runGc({ pressure: 'normal' }));
    expect(kept()).toBe(false);
    expect(currentSourceDependencies(readWorkspaceState(source))).not.toBeNull();
    expect(existsSync(join(roots.feature ?? '', 'node_modules'))).toBe(true);
  },
  60_000,
);

const sourceModules = (source: string) => join(source, 'node_modules', 'pkg', 'index.js');

test.skipIf(process.platform === 'win32')(
  'a source checkout edited or committed in with other tools inside the window keeps its dependencies at critical and at 7 days, and a dry run says why',
  async () => {
    const roots = idleRepo([{ name: 'feature', workspace: true }]);
    const source = roots.repo ?? '';
    const git = (args: string) => execSync(`git ${args}`, { cwd: source, timeout: 15_000 });

    writeFileSync(join(source, 'edited.ts'), 'x');
    const { payload }: { payload: LevelPayload } = await gcJson();
    const kept = payload.actions.find(
      (action) =>
        action.rung === 8 && action.kind === 'delete-dependencies' && action.target === join(source, 'node_modules'),
    );
    expect(kept).toMatchObject({ outcome: 'kept' });
    expect(kept?.detail).toMatch(/file edit/);
    await quietly(() => runGc({ pressure: 'critical' }));
    expect(existsSync(sourceModules(source))).toBe(true);

    ageCheckout(source, daysAgo(8));
    git('-c user.name=t -c user.email=t@example.com commit -q --allow-empty -m recent');
    await quietly(() => runGc({ pressure: 'normal' }));
    expect(existsSync(sourceModules(source))).toBe(true);
  },
  60_000,
);

const rung8 = (payload: LevelPayload, path: string) =>
  payload.actions.find(
    (action) => action.rung === 8 && action.kind === 'delete-dependencies' && action.target === path,
  );

test.skipIf(process.platform === 'win32')(
  'a source checkout keeps its dependencies, with the reason in a dry run, while a worktree warm holds its claim, an app in it is active, or a worktree links to them',
  async () => {
    const roots = idleRepo([
      { name: 'feature', workspace: true },
      { name: 'linker', workspace: true },
    ]);
    const source = roots.repo ?? '';
    const linker = roots.linker ?? '';
    const modules = join(source, 'node_modules');
    const claim = plantClaim(warmClaimPath(source), 'shared', liveClaimOwner());
    const warming: { payload: LevelPayload } = await gcJson();
    expect(rung8(warming.payload, modules)?.detail).toMatch(/warm is copying/);
    await quietly(() => runGc({ pressure: 'critical' }));
    expect(existsSync(sourceModules(source))).toBe(true);
    rmSync(claim, { force: true });

    const app = join(source, 'apps', 'mobile');
    write(join(app, 'package.json'));
    ageTree(source, new Date(Date.now() - 60 * 60_000));
    upsertProject(app, { metroPort: null });
    recordWorkspaceUse(app, new Date());
    ensureWorkspaceStorage(app);
    const active: { payload: LevelPayload } = await gcJson();
    expect(rung8(active.payload, modules)?.detail).toMatch(/is not idle/);
    await quietly(() => runGc({ pressure: 'critical' }));
    expect(existsSync(sourceModules(source))).toBe(true);
    recordWorkspaceUse(app, new Date(Date.now() - 60 * 60_000));
    utimesSync(workspaceStateFile(app), new Date(Date.now() - 60 * 60_000), new Date(Date.now() - 60 * 60_000));

    mkdirSync(join(linker, 'apps', 'x'), { recursive: true });
    symlinkSync(modules, join(linker, 'apps', 'x', 'node_modules'));
    writeFileSync(join(linker, '.stim.json'), JSON.stringify({ maintenance: { keep: true } }));
    const linked: { payload: LevelPayload } = await gcJson();
    expect(rung8(linked.payload, modules)).toMatchObject({ outcome: 'kept' });
    expect(rung8(linked.payload, modules)?.detail).toMatch(/links apps\/x\/node_modules to it/);
    await quietly(() => runGc({ pressure: 'critical' }));
    expect(existsSync(sourceModules(source))).toBe(true);
  },
  60_000,
);

test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
  'a source checkout keeps its dependencies when a linked worktree is too large to scan for links or has an unreadable directory',
  async () => {
    const roots = idleRepo([{ name: 'linker', workspace: true }]);
    const source = roots.repo ?? '';
    const linker = roots.linker ?? '';
    const modules = join(source, 'node_modules');
    writeFileSync(join(linker, '.stim.json'), JSON.stringify({ maintenance: { keep: true } }));
    for (let i = 0; i < 2100; i++) writeFileSync(join(linker, `filler-${i}.txt`), '');
    mkdirSync(join(linker, 'apps', 'x'), { recursive: true });
    symlinkSync(modules, join(linker, 'apps', 'x', 'node_modules'));
    ageTree(linker, new Date(Date.now() - 60 * 60_000));
    const large: { payload: LevelPayload } = await gcJson();
    expect(rung8(large.payload, modules)).toMatchObject({ outcome: 'kept' });
    expect(rung8(large.payload, modules)?.detail).toMatch(/links apps\/x\/node_modules|could not be fully checked/);
    await quietly(() => runGc({ pressure: 'critical' }));
    expect(existsSync(sourceModules(source))).toBe(true);

    rmSync(join(linker, 'apps'), { recursive: true });
    for (let i = 0; i < 2100; i++) rmSync(join(linker, `filler-${i}.txt`));
    mkdirSync(join(linker, 'sealed'));
    chmodSync(join(linker, 'sealed'), 0o000);
    try {
      const sealed: { payload: LevelPayload } = await gcJson();
      expect(rung8(sealed.payload, modules)?.detail).toMatch(/could not be fully checked/);
      await quietly(() => runGc({ pressure: 'critical' }));
      expect(existsSync(sourceModules(source))).toBe(true);
    } finally {
      chmodSync(join(linker, 'sealed'), 0o755);
    }
  },
  120_000,
);

test.skipIf(process.platform === 'win32')(
  'a source checkout tree not measured yet is not taken at 7 days idle, and is at critical',
  async () => {
    const roots = idleRepo([{ name: 'feature', workspace: true }]);
    const source = roots.repo ?? '';
    const modules = join(source, 'node_modules');
    ageCheckout(source, daysAgo(8));
    rmSync(diskUsageCacheFile(modules), { force: true });
    rmSync(diskUsageCacheFile(join(source, 'ios', 'Pods')), { force: true });
    walks.set(modules, () => null);
    walks.set(join(source, 'ios', 'Pods'), () => null);
    ageTree(source, daysAgo(8));
    const normal = await quietly(() => runGc({ pressure: 'normal' }));
    expect(normal).toBeDefined();
    expect(existsSync(sourceModules(source))).toBe(true);
    await quietly(() => runGc({ pressure: 'critical' }));
    expect(existsSync(sourceModules(source))).toBe(false);
  },
  60_000,
);

test.skipIf(process.platform === 'win32')(
  'gc measures a source checkout tree not measured since its install, and keeps one hard-linked from a package store as worth almost nothing',
  async ({ skip }) => {
    const roots = idleRepo([{ name: 'feature', workspace: true }]);
    const source = roots.repo ?? '';
    const modules = join(source, 'node_modules');
    const store = join(projects, 'store');
    mkdirSync(join(store, 'pkg'), { recursive: true });
    writeFileSync(join(store, 'pkg', 'large.js'), Buffer.alloc(8 * 1024 * 1024, 1));
    linkSync(join(store, 'pkg', 'large.js'), join(modules, 'pkg', 'large.js'));
    ageCheckout(source, daysAgo(8));
    rmSync(diskUsageCacheFile(modules), { force: true });
    ageTree(source, daysAgo(8));
    if ((await privateSizeKnowable(modules)) !== 'yes') skip('the test volume cannot report shared blocks');

    const { payload } = await gcJson('normal');

    const typed: LevelPayload = payload;
    const kept = typed.actions.find((action) => action.kind === 'delete-dependencies' && action.target === modules);
    expect(kept).toMatchObject({ outcome: 'kept' });
    expect(kept?.detail).toMatch(
      /^\d+K of its \d+(\.\d)?M is its own and the rest is shared with copy-on-write clones or hard links/,
    );
  },
  60_000,
);

test.skipIf(process.platform === 'win32')(
  'a source checkout tree gc could not measure says why it stays, and is not walked again until its install changes, so the next tree gets the budget',
  async () => {
    const roots = idleRepo([{ name: 'feature', workspace: true }]);
    const source = roots.repo ?? '';
    const modules = join(source, 'node_modules');
    const pods = join(source, 'ios', 'Pods');
    ageCheckout(source, daysAgo(8));
    const unmeasured = () => {
      for (const { path, bytes } of [
        { path: modules, bytes: 2 * 1024 ** 3 },
        { path: pods, bytes: 1024 ** 3 },
      ])
        writeCacheFile(diskUsageCacheFile(path), {
          path,
          measuredAt: new Date().toISOString(),
          bytes,
          signature: treeSignature(path),
        });
    };
    const detail = (payload: LevelPayload, target: string) =>
      payload.actions.find((action) => action.kind === 'delete-dependencies' && action.target === target)?.detail;
    const slow = vi.fn<() => null>(() => {
      vi.setSystemTime(Date.now() + 115_000);
      return null;
    });
    const unknownWalk = (bytes: number, privateUnknown: 'volume' | 'walk') =>
      vi.fn<() => { bytes: number; privateBytes: null; privateUnknown: 'volume' | 'walk' }>(() => ({
        bytes,
        privateBytes: null,
        privateUnknown,
      }));
    const cannotTell = unknownWalk(2 * 1024 ** 3, 'volume');
    const countFailed = unknownWalk(1024 ** 3, 'walk');
    const volume =
      'its volume cannot report which of its blocks other files share, so its real size is unknown and it stays';
    const failed =
      'its private-size walk could not count which of its blocks other files share, so its real size is unknown and it stays';

    unmeasured();
    walks.set(modules, cannotTell);
    walks.set(pods, countFailed);
    const first: LevelPayload = (await gcJson('normal')).payload;
    expect(detail(first, modules)).toBe(volume);
    expect(detail(first, pods)).toBe(failed);

    const again: LevelPayload = (await gcJson('normal')).payload;
    expect(detail(again, modules)).toBe(volume);
    expect(detail(again, pods)).toBe(failed);
    expect(cannotTell).toHaveBeenCalledTimes(1);
    expect(countFailed).toHaveBeenCalledTimes(1);

    unmeasured();
    walks.set(modules, slow);
    const late: LevelPayload = (await gcJson('normal')).payload;
    expect(detail(late, modules)).toBe(
      'its size walk failed or did not finish within the 120 seconds stim gc had left, so its real size is unknown and it stays',
    );
    expect(detail(late, pods)).toBe(
      'stim gc spent its 2 minutes of measuring on other trees first, so its real size is unknown and it stays',
    );
    expect(countFailed).toHaveBeenCalledTimes(1);

    const order: string[] = [];
    walks.set(pods, () => {
      order.push(pods);
      return { bytes: 1024 ** 3, privateBytes: 10 * 1024 ** 2 };
    });
    walks.set(modules, () => {
      order.push(modules);
      return slow();
    });
    vi.setSystemTime(Date.now() + 24 * 60 * 60_000);
    const dayLater: LevelPayload = (await gcJson('normal')).payload;
    expect(order).toEqual([pods, modules]);
    expect(detail(dayLater, pods)).toMatch(/^10M of its 1\.0G is its own/);

    order.length = 0;
    const next: LevelPayload = (await gcJson('normal')).payload;
    expect(order).toEqual([]);
    expect(detail(next, modules)).toBe(
      'its last size walk did not finish in time and its install has not changed since, so its real size is unknown and it stays',
    );
  },
  60_000,
);

test.skipIf(process.platform === 'win32')(
  "neither the API's read-only gc report nor its acting gc walks a tree, and a partial count under the threshold stays unknown",
  async () => {
    const roots = idleRepo([{ name: 'feature', workspace: true }]);
    const source = roots.repo ?? '';
    const modules = join(source, 'node_modules');
    const pods = join(source, 'ios', 'Pods');
    ageCheckout(source, daysAgo(8));
    for (const path of [modules, pods]) rmSync(diskUsageCacheFile(path), { force: true });
    const partial = vi.fn<() => { bytes: number; privateBytes: number; partial: true }>(() => ({
      bytes: 2 * 1024 ** 3,
      privateBytes: 10 * 1024 ** 2,
      partial: true,
    }));
    walks.set(modules, partial);
    walks.set(pods, () => null);

    await readGcReport({ pressure: 'normal', measureBuildState: false });
    await quietly(() =>
      createStim({ projectRoot: source, home, env: process.env }).collectGarbage({ pressure: 'normal' }),
    );
    expect(partial).not.toHaveBeenCalled();
    expect(existsSync(modules)).toBe(true);

    for (let run = 0; run < 2; run++) {
      const { payload } = await gcJson('normal');
      const typed: LevelPayload = payload;
      expect(
        typed.actions.find((action) => action.kind === 'delete-dependencies' && action.target === modules)?.detail,
      ).toBe(
        'its private-size walk could not count which of its blocks other files share, so its real size is unknown and it stays',
      );
    }
    expect(partial).toHaveBeenCalledTimes(1);
  },
  60_000,
);

test('the source warm claim keeps a warm out while a delete holds it, and is refused while a warm holds it', () => {
  const root = join(projects, 'claimed');
  mkdirSync(root);
  const sharedWarm = () =>
    tryAcquireClaim({ root: warmClaimPath(root), mode: 'shared', label: 'worktree warm', details: { phase: 'copy' } });

  const held = takeWarmClaim(root);
  assert('release' in held);
  expect(sharedWarm().acquired).toBeUndefined();
  held.release();

  const running = sharedWarm().acquired;
  assert(running);
  expect(takeWarmClaim(root)).toEqual({ kept: 'a worktree warm is copying from it' });
  const second = sharedWarm().acquired;
  assert(second);
  releaseClaim(second);
  releaseClaim(running);

  const again = takeWarmClaim(root);
  expect('release' in again).toBe(true);
  if ('release' in again) again.release();
});

test.skipIf(process.platform === 'win32')(
  'a linked worktree of another repository too large to scan does not keep this source checkout',
  async () => {
    const roots = idleRepo([{ name: 'feature', workspace: true }]);
    const source = roots.repo ?? '';
    const other = join(projects, 'other');
    mkdirSync(other);
    execSync('git init -q -b main', { cwd: other });
    execSync('git -c user.name=t -c user.email=t@example.com commit -q --allow-empty -m init', { cwd: other });
    const stranger = join(projects, 'stranger');
    execSync(`git worktree add -q "${stranger}" -b stranger`, { cwd: other });
    for (let i = 0; i < 2100; i++) writeFileSync(join(stranger, `filler-${i}.txt`), '');
    upsertProject(realpathSync.native(stranger), { metroPort: null });
    await quietly(() => runGc({ pressure: 'critical' }));
    expect(existsSync(sourceModules(source))).toBe(false);
  },
  60_000,
);
