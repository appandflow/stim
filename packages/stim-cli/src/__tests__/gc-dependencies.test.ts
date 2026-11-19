import {
  currentSourceDependencies,
  diskUsageCacheFile,
  diskUsageLinksFile,
  diskUsageNativeFile,
  diskUsageWalkClaims,
  readJsonObject,
  readWorkspaceState,
  workspaceLightenedFile,
} from '@stim-cli/core/state';
import { execSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
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
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { writeCacheFile } from '../cache-file.ts';
import { privateSizeKnowable, treeSignature } from '../private-size.ts';
import { hardLinkSample, type LinkSampleIo } from '../link-sample.ts';
import { hungRead } from '../workspace/bounded-read.ts';
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

test.skipIf(process.platform === 'win32')(
  'gc starts no size walk while another holds the walk claim, and takes up what that walk recorded on the next run',
  async () => {
    const roots = idleRepo([{ name: 'feature', workspace: true }]);
    const source = roots.repo ?? '';
    const modules = join(source, 'node_modules');
    const pods = join(source, 'ios', 'Pods');
    ageCheckout(source, daysAgo(8));
    for (const path of [modules, pods]) rmSync(diskUsageCacheFile(path), { force: true });
    const walk = vi.fn<() => null>(() => null);
    walks.set(modules, walk);
    walks.set(pods, walk);
    const detail = (payload: LevelPayload, target: string) =>
      payload.actions.find((action) => action.kind === 'delete-dependencies' && action.target === target)?.detail;
    const held = tryAcquireClaim({ root: diskUsageWalkClaims(), mode: 'exclusive', label: 'disk usage walk' }).acquired;
    assert(held);
    try {
      const { payload } = await gcJson('normal');
      for (const target of [modules, pods])
        expect(detail(payload, target)).toBe(
          'another size walk on this machine was running, so stim gc did not measure it this run and its real size is unknown and it stays',
        );
      expect(walk).not.toHaveBeenCalled();
      writeCacheFile(diskUsageCacheFile(modules), {
        path: modules,
        measuredAt: new Date().toISOString(),
        bytes: 1024 ** 3,
        privateBytes: 10 * 1024 ** 2,
        signature: treeSignature(modules),
      });
    } finally {
      releaseClaim(held);
    }

    const { payload } = await gcJson('normal');
    expect(detail(payload, modules)).toMatch(/^10M of its 1\.0G is its own/);
    expect(walk).toHaveBeenCalledTimes(1);
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

const linkedDetail =
  /^its real size is unknown, but (\d+) of the \1 files sampled from it are hard links another folder such as a package store also holds, so deleting it would free little and it stays$/;

function pnpmTree(modules: string, how: 'linked' | 'copied', at: Date, count = 8): string {
  const built = how === 'linked' ? modules : join(projects, `built-${randomUUID()}`);
  const store = join(projects, `store-${randomUUID()}`);
  for (let index = 0; index < count; index++) {
    const name = index % 2 ? `pkg${index}` : `@scope/pkg${index}`;
    const entry = `${name.replace('/', '+')}@1.0.${index}`;
    const dir = join(built, '.pnpm', entry, 'node_modules', name);
    mkdirSync(join(dir, 'lib'), { recursive: true });
    for (const file of ['package.json', 'index.js', join('lib', 'main.js')]) {
      const stored = join(store, entry, file);
      mkdirSync(dirname(stored), { recursive: true });
      writeFileSync(stored, `${entry} ${file}`);
      linkSync(stored, join(dir, file));
    }
    mkdirSync(dirname(join(built, name)), { recursive: true });
    symlinkSync(relative(dirname(join(built, name)), dir), join(built, name));
  }
  writeFileSync(join(built, '.modules.yaml'), JSON.stringify({ storeDir: store, virtualStoreDir: '.pnpm' }));
  if (how === 'copied') {
    rmSync(modules, { recursive: true, force: true });
    execSync(`cp -R "${built}" "${modules}"`);
    rmSync(built, { recursive: true, force: true });
    rmSync(store, { recursive: true, force: true });
  }
  ageTree(modules, at);
  rmSync(diskUsageCacheFile(modules), { force: true });
  return store;
}

function dependencyAction(payload: LevelPayload, target: string, rung: number | null) {
  return payload.actions.find(
    (action) => action.kind === 'delete-dependencies' && action.target === target && action.rung === rung,
  );
}

test.skipIf(process.platform === 'win32')(
  'at high, rung 5 keeps a tree of unknown size whose sample is hard links, deletes a copied one and never samples a measured one; at critical rungs 5 and 8 take it last',
  async () => {
    const roots = idleRepo([
      { name: 'linked', workspace: true },
      { name: 'copied', workspace: true },
      { name: 'measured', workspace: true },
    ]);
    const hourAgo = new Date(Date.now() - 60 * 60_000);
    const modules = (name: string) => join(roots[name] ?? '', 'node_modules');
    for (const name of ['repo', 'linked', 'measured']) pnpmTree(modules(name), 'linked', hourAgo);
    pnpmTree(modules('copied'), 'copied', hourAgo);
    measureTrees(roots.measured ?? '');
    for (const name of ['repo', 'linked', 'copied']) walks.set(modules(name), () => null);

    const { payload }: { payload: LevelPayload } = await gcJson('high');
    expect(dependencyAction(payload, modules('linked'), 5)?.outcome).toBe('kept');
    expect(dependencyAction(payload, modules('linked'), 5)?.detail).toMatch(linkedDetail);
    expect(dependencyAction(payload, modules('copied'), 5)?.outcome).toBe('would');
    expect(dependencyAction(payload, modules('measured'), 5)?.outcome).toBe('would');
    expect(existsSync(diskUsageLinksFile(modules('measured')))).toBe(false);

    const critical: LevelPayload = (await gcJson('critical')).payload;
    const planned = criticalDependencies(critical);
    expect(planned.indexOf(modules('linked'))).toBeGreaterThan(planned.indexOf(modules('copied')));
    expect(dependencyAction(critical, modules('repo'), 8)?.outcome).toBe('would');

    await quietly(() => runGc({ pressure: 'high' }));
    expect(existsSync(join(modules('linked'), '.pnpm'))).toBe(true);
    expect(existsSync(modules('copied'))).toBe(false);
  },
  60_000,
);

test.skipIf(process.platform === 'win32')(
  'at normal, the dormant step and the 7-day source rule keep a tree of unknown size whose sample is hard links, and the verdict holds until its install changes',
  async () => {
    const roots = idleRepo([
      { name: 'linked', workspace: true },
      { name: 'copied', workspace: true },
    ]);
    const source = roots.repo ?? '';
    const config = loadConfig();
    if (!config) throw new Error('no config');
    saveConfig({ ...config, idle: { dormantDays: 0.01 } });
    ageCheckout(source, daysAgo(8));
    const modules = (name: string) => join(roots[name] ?? '', 'node_modules');
    const hourAgo = new Date(Date.now() - 60 * 60_000);
    pnpmTree(modules('repo'), 'linked', daysAgo(8));
    pnpmTree(modules('linked'), 'linked', hourAgo);
    pnpmTree(modules('copied'), 'copied', hourAgo);
    for (const name of ['repo', 'linked', 'copied']) walks.set(modules(name), () => null);

    const first: LevelPayload = (await gcJson('normal')).payload;
    for (const name of ['repo', 'linked']) {
      expect(dependencyAction(first, modules(name), null)?.outcome).toBe('kept');
      expect(dependencyAction(first, modules(name), null)?.detail).toMatch(linkedDetail);
    }
    expect(dependencyAction(first, modules('copied'), null)?.outcome).toBe('would');

    const linked = modules('linked');
    writeCacheFile(diskUsageLinksFile(linked), {
      ...readJsonObject(diskUsageLinksFile(linked)),
      linked: 99,
      sampled: 99,
    });
    const again: LevelPayload = (await gcJson('normal')).payload;
    expect(dependencyAction(again, linked, null)?.detail).toContain('99 of the 99 files');

    pnpmTree(linked, 'copied', new Date(hourAgo.getTime() - 60_000));
    const reinstalled: LevelPayload = (await gcJson('normal')).payload;
    expect(dependencyAction(reinstalled, linked, null)?.outcome).toBe('would');
  },
  60_000,
);

test.skipIf(process.platform === 'win32')(
  'a link sample that finds too few files or does not answer in time leaves the tree unknown, and one that timed out is retried after 6 hours',
  async () => {
    const few = join(projects, 'few', 'node_modules');
    pnpmTree(few, 'linked', new Date());
    for (const entry of readdirSync(join(few, '.pnpm')).slice(4))
      rmSync(join(few, '.pnpm', entry), { recursive: true });
    expect(await hardLinkSample(few)).toBeNull();
    expect(readJsonObject(diskUsageLinksFile(few))?.verdict).toBe('other');

    const modules = join(projects, 'slow', 'node_modules');
    mkdirSync(modules, { recursive: true });
    let answer: () => void = () => {};
    const entries = vi.fn<LinkSampleIo['entries']>(
      () =>
        new Promise((done) => {
          answer = () => done([]);
        }),
    );
    const io: LinkSampleIo = {
      entries,
      lstat: async () => ({ kind: 'file', nlink: 2, dev: 1, ino: 1 }),
      ends: async () => '',
    };
    const sampled = hardLinkSample(modules, undefined, io);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await sampled).toBeNull();
    answer();
    await vi.advanceTimersByTimeAsync(0);
    expect(readJsonObject(diskUsageLinksFile(modules))?.verdict).toBe('timeout');
    expect(await hardLinkSample(modules, undefined, io)).toBeNull();
    expect(entries).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 6 * 60 * 60_000);
    entries.mockResolvedValue([]);
    expect(await hardLinkSample(modules, undefined, io)).toBeNull();
    expect(entries).toHaveBeenCalledTimes(2);
    expect(readJsonObject(diskUsageLinksFile(modules))?.verdict).toBe('other');
  },
);

test.skipIf(process.platform === 'win32')(
  'on a disk that takes 1 ms per read, a link sample of a 3,000-package tree lists its native packages over two runs and then checks only their build folders',
  async () => {
    const modules = join(projects, 'slow', 'node_modules');
    mkdirSync(modules, { recursive: true });
    const store = join(projects, 'slow-store');
    const pnpm = join(modules, '.pnpm');
    const packageDir = (index: number) => join(pnpm, `pkg${index}@1.0.0`, 'node_modules', `pkg${index}`);
    const native = new Set(Array.from({ length: 100 }, (_, index) => packageDir(index * 30)));
    const inodes = new Map<string, number>();
    const slow = <T>(value: () => T) =>
      new Promise<T>((done, fail) =>
        setTimeout(() => {
          try {
            done(value());
          } catch (error) {
            fail(error);
          }
        }, 1),
      );
    const missing = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    const reads = { entries: 0, lstat: 0 };
    const built = new Set<string>();
    const io: LinkSampleIo = {
      entries: (path) => {
        reads.entries++;
        return slow(() => {
          if (/\/(android|ios)$/.test(path))
            return built.has(path) ? [{ name: 'build', kind: 'directory' as const }] : [];
          if (path === modules) return [{ name: '.pnpm', kind: 'directory' }];
          if (path === pnpm)
            return Array.from({ length: 3000 }, (_, index) => ({ name: `pkg${index}@1.0.0`, kind: 'directory' }));
          const files = ['package.json', 'index.js', 'main.js'].map((name) => ({ name, kind: 'file' as const }));
          const folders = native.has(path)
            ? ['android', 'ios'].map((name) => ({ name, kind: 'directory' as const }))
            : [];
          return [...files, ...folders];
        });
      },
      lstat: (path) => {
        reads.lstat++;
        return slow(() => {
          if (path === store || path.endsWith('@1.0.0/node_modules/' + path.split('/').at(-1)))
            return { kind: 'directory', nlink: 1, dev: 1, ino: 0 };
          if (/\.(json|js)$/.test(path)) {
            if (!inodes.has(path)) inodes.set(path, inodes.size + 1);
            return { kind: 'file', nlink: 2, dev: 1, ino: inodes.get(path) ?? 0 };
          }
          throw missing();
        });
      },
      ends: () => slow(() => JSON.stringify({ storeDir: store })),
    };
    const run = async () => {
      const result = hardLinkSample(modules, undefined, io);
      await vi.advanceTimersByTimeAsync(10_000);
      return result;
    };

    expect(await run()).toBeNull();
    expect(existsSync(diskUsageLinksFile(modules))).toBe(false);
    const first = readJsonObject(diskUsageNativeFile(modules));
    expect(first?.complete).toBe(false);
    expect(first?.last).toEqual(expect.any(String));

    expect(await run()).toEqual({ linked: 36, sampled: 36 });
    expect(readJsonObject(diskUsageNativeFile(modules))).toMatchObject({ complete: true });
    expect(readJsonObject(diskUsageNativeFile(modules))?.roots).toHaveLength(200);

    reads.entries = 0;
    reads.lstat = 0;
    expect(await run()).toEqual({ linked: 36, sampled: 36 });
    expect(reads).toEqual({ entries: 100 * 2, lstat: 1 });

    built.add(join(packageDir(30), 'android'));
    expect(await run()).toBeNull();
    expect(readJsonObject(diskUsageLinksFile(modules))?.verdict).toBe('other');
  },
);

function memoryTree(modules: string, delayMs = 0) {
  const store = join(modules, '..', 'memory-store');
  const pnpm = join(modules, '.pnpm');
  const packageDir = (index: number) =>
    join(pnpm, `pkg${String(index).padStart(2, '0')}@1.0.0`, 'node_modules', `pkg${String(index).padStart(2, '0')}`);
  const failing = new Set<string>();
  const inodes = new Map<string, number>();
  const built = new Set<string>();
  const missing = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  const answer = <T>(value: () => T) =>
    new Promise<T>((done, fail) =>
      setTimeout(() => {
        try {
          done(value());
        } catch (error) {
          fail(error);
        }
      }, delayMs),
    );
  const io: LinkSampleIo = {
    entries: (path) =>
      answer(() => {
        if (failing.delete(path)) throw Object.assign(new Error('EIO'), { code: 'EIO' });
        if (path.endsWith('/android'))
          return built.has(join(path, 'build')) ? [{ name: 'build', kind: 'directory' as const }] : [];
        if (path === modules) return [{ name: '.pnpm', kind: 'directory' }];
        if (path === pnpm)
          return Array.from({ length: 20 }, (_, index) => ({
            name: `pkg${String(index).padStart(2, '0')}@1.0.0`,
            kind: 'directory',
          }));
        return [
          ...['package.json', 'index.js', 'main.js'].map((name) => ({ name, kind: 'file' as const })),
          ...(path === packageDir(3) ? [{ name: 'android', kind: 'directory' as const }] : []),
        ];
      }),
    lstat: (path) =>
      answer(() => {
        if (path === store || built.has(path) || /@1\.0\.0\/node_modules\/pkg\d+$/.test(path))
          return { kind: 'directory', nlink: 1, dev: 1, ino: 0 };
        if (/\.(json|js)$/.test(path)) {
          if (!inodes.has(path)) inodes.set(path, inodes.size + 1);
          return { kind: 'file', nlink: 2, dev: 1, ino: inodes.get(path) ?? 0 };
        }
        throw missing();
      }),
    ends: () => answer(() => JSON.stringify({ storeDir: store })),
  };
  return { io, packageDir, failing, built };
}

test.skipIf(process.platform === 'win32')(
  'a package whose listing fails leaves the native listing incomplete with no verdict, and the next run lists it and finds its build output',
  async () => {
    const modules = join(projects, 'flaky', 'node_modules');
    mkdirSync(modules, { recursive: true });
    const { io, packageDir, failing, built } = memoryTree(modules);
    const run = async () => {
      const result = hardLinkSample(modules, undefined, io);
      await vi.advanceTimersByTimeAsync(100);
      return result;
    };
    failing.add(packageDir(3));
    expect(await run()).toBeNull();
    expect(readJsonObject(diskUsageNativeFile(modules))).toMatchObject({ last: packageDir(2), complete: false });
    expect(existsSync(diskUsageLinksFile(modules))).toBe(false);
    built.add(join(packageDir(3), 'android', 'build'));
    expect(await run()).toBeNull();
    expect(readJsonObject(diskUsageNativeFile(modules))).toMatchObject({
      roots: [join(packageDir(3), 'android')],
      complete: true,
    });
    expect(readJsonObject(diskUsageLinksFile(modules))?.verdict).toBe('other');
    built.clear();
    rmSync(diskUsageLinksFile(modules));
    expect(await run()).not.toBeNull();
  },
);

test.skipIf(process.platform === 'win32')(
  "a link sample whose reads take 1.9 s ends within its 2 s budget or the caller's deadline, records no verdict when the deadline cut it, and leaves no pending read",
  async () => {
    const modules = join(projects, 'budget', 'node_modules');
    mkdirSync(modules, { recursive: true });
    const { io } = memoryTree(modules, 1900);
    const timed = async (until?: number) => {
      const started = Date.now();
      let ended = 0;
      const result = hardLinkSample(modules, undefined, io, until).finally(() => {
        ended = Date.now();
      });
      await vi.advanceTimersByTimeAsync(1000);
      const pending = hungRead();
      await vi.advanceTimersByTimeAsync(9000);
      return { result: await result, elapsed: ended - started, pending, after: hungRead() };
    };
    expect(await timed(Date.now() + 1000)).toEqual({ result: null, elapsed: 1000, pending: null, after: null });
    expect(existsSync(diskUsageLinksFile(modules))).toBe(false);
    expect(await timed()).toEqual({ result: null, elapsed: 2000, pending: null, after: null });
    expect(readJsonObject(diskUsageLinksFile(modules))?.verdict).toBe('timeout');
  },
);

test.skipIf(process.platform === 'win32')(
  'a link sample counts only hard links that a pnpm store outside the tree still holds',
  async () => {
    const peers = (modules: string, storeDir?: string) => {
      for (let index = 0; index < 8; index++)
        for (const file of ['package.json', 'index.js', 'main.js']) {
          const [first, second] = ['18', '19'].map((react) =>
            join(modules, '.pnpm', `pkg${index}@1.0.0_react@${react}`, 'node_modules', `pkg${index}`),
          );
          mkdirSync(first ?? '', { recursive: true });
          mkdirSync(second ?? '', { recursive: true });
          writeFileSync(join(first ?? '', file), `pkg${index} ${file}`);
          linkSync(join(first ?? '', file), join(second ?? '', file));
        }
      if (storeDir) writeFileSync(join(modules, '.modules.yaml'), JSON.stringify({ storeDir }));
    };
    const inTree = join(projects, 'peers', 'node_modules');
    peers(inTree);
    expect(await hardLinkSample(inTree)).toBeNull();
    const absent = join(projects, 'absent', 'node_modules');
    peers(absent, join(projects, 'no-store'));
    expect(await hardLinkSample(absent)).toBeNull();

    const linked = join(projects, 'linked', 'node_modules');
    const store = pnpmTree(linked, 'linked', new Date());
    expect(await hardLinkSample(linked)).toEqual({ linked: 24, sampled: 24 });
    const signature = treeSignature(linked);
    rmSync(store, { recursive: true });
    expect(treeSignature(linked)).toBe(signature);
    expect(await hardLinkSample(linked)).toBeNull();
    expect(readJsonObject(diskUsageLinksFile(linked))?.verdict).toBe('other');
  },
);

test.skipIf(process.platform === 'win32')(
  'a link sample is not links once any package with a native folder holds build output, even after a links verdict, or when the tree holds a cache, and reads a hoisted tree from its top-level and scoped folders and its store from the end of a large .modules.yaml',
  async () => {
    const built = join(projects, 'built', 'node_modules');
    pnpmTree(built, 'linked', new Date(), 60);
    const packages = readdirSync(join(built, '.pnpm'))
      .filter((entry) => entry.includes('@1.0.'))
      .toSorted();
    const unsampled = packages[30] ?? '';
    const name = unsampled.slice(0, unsampled.indexOf('@1.0.')).replace('+', '/');
    const android = join(built, '.pnpm', unsampled, 'node_modules', name, 'android');
    mkdirSync(android);
    expect(await hardLinkSample(built)).toEqual({ linked: 36, sampled: 36 });
    expect(readJsonObject(diskUsageNativeFile(built))).toMatchObject({ roots: [android], complete: true });
    const signature = treeSignature(built);
    mkdirSync(join(android, 'build'));
    expect(treeSignature(built)).toBe(signature);
    expect(await hardLinkSample(built)).toBeNull();
    expect(readJsonObject(diskUsageLinksFile(built))?.verdict).toBe('other');

    const cached = join(projects, 'cached', 'node_modules');
    pnpmTree(cached, 'linked', new Date());
    mkdirSync(join(cached, '.cache', 'babel'), { recursive: true });
    expect(await hardLinkSample(cached)).toBeNull();

    const hoisted = join(projects, 'hoisted', 'node_modules');
    const store = join(projects, 'hoisted-store');
    for (let index = 0; index < 8; index++)
      for (const file of ['package.json', 'index.js', 'main.js']) {
        mkdirSync(join(store, `pkg${index}`), { recursive: true });
        mkdirSync(join(hoisted, `pkg${index}`), { recursive: true });
        writeFileSync(join(store, `pkg${index}`, file), `pkg${index} ${file}`);
        linkSync(join(store, `pkg${index}`, file), join(hoisted, `pkg${index}`, file));
      }
    const hoistedDependencies = Object.fromEntries(
      Array.from({ length: 50 }, (_, index) => [`dep${index}@1.0.0`, { [`dep${index}`]: 'private' }]),
    );
    const hoistedLocations = Object.fromEntries(
      Array.from({ length: 30_000 }, (_, index) => [`dep${index}@1.0.0`, [`node_modules/dep${index}`]]),
    );
    writeFileSync(
      join(hoisted, '.modules.yaml'),
      JSON.stringify({ hoistedDependencies, hoistedLocations, nodeLinker: 'hoisted', storeDir: store }, null, 2),
    );
    expect(statSync(join(hoisted, '.modules.yaml')).size).toBeGreaterThan(1024 * 1024);
    mkdirSync(join(hoisted, '@scope', 'native', 'ios'), { recursive: true });
    expect(await hardLinkSample(hoisted)).toEqual({ linked: 24, sampled: 24 });
    mkdirSync(join(hoisted, '@scope', 'native', 'ios', 'build'));
    expect(await hardLinkSample(hoisted)).toBeNull();
  },
);
