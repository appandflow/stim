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
  readdirSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { writeCacheFile } from '../cache-file.ts';
import { treeSignature } from '../private-size.ts';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import { runGc } from '../commands/gc.ts';
import * as gcDevices from '../commands/gc/devices.ts';
import { loadConfig, saveConfig, upsertProject } from '../workspace/config.ts';
import { ensureWorkspaceStorage, workspaceStateFile } from '../workspace/paths.ts';
import { recordWorkspaceUse } from '../workspace/workspace-state.ts';
import { recordLightened, restoreLightenedDependencies } from '../workspace/lightened.ts';
import { recordWarmedFrom } from '../workspace/source-dependencies.ts';
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

function idleRepo(worktrees: { name: string; workspace: boolean }[]): Record<string, string> {
  const repo = join(projects, 'repo');
  mkdirSync(repo, { recursive: true });
  const git = (args: string, cwd = repo) => execSync(`git ${args}`, { cwd, encoding: 'utf-8', timeout: 15_000 }).trim();
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
    ageTree(join(root, 'node_modules'), hourAgo);
    ageTree(join(root, 'ios'), hourAgo);
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

async function gcJson(pressure: 'high' | 'critical' = 'critical') {
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
  actions: { rung: number | null; kind: string; target: string; outcome: string }[];
};

function criticalDependencies(payload: LevelPayload): string[] {
  return payload.actions.flatMap((action) => (action.kind === 'delete-dependencies' ? [action.target] : []));
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
      expect(critical.map((action) => action.target).indexOf(join(at('repo'), 'node_modules'))).toBeGreaterThan(
        critical.map((action) => action.target).indexOf(join(at('feature'), 'node_modules')),
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
  ageTree(join(root, 'node_modules'), at);
  ageTree(join(root, 'ios'), at);
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
    await quietly(() => runGc({ pressure: 'normal' }));
    expect(kept()).toBe(false);
    expect(currentSourceDependencies(readWorkspaceState(source))).not.toBeNull();
    expect(existsSync(join(roots.feature ?? '', 'node_modules'))).toBe(true);
  },
  60_000,
);
