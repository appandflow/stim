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
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import { runGc } from '../commands/gc.ts';
import { saveConfig, upsertProject } from '../workspace/config.ts';
import { ensureWorkspaceStorage, workspaceStateFile } from '../workspace/paths.ts';
import { recordWorkspaceUse } from '../workspace/workspace-state.ts';
import { lightenedDirs, recordLightened, restoreLightenedDependencies } from '../workspace/lightened.ts';
import { testContext } from './_context.ts';

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

async function gcJson() {
  const stdout: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((...args) => void stdout.push(args.join(' ')));
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await runGc({ json: true });
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

test.skipIf(process.platform === 'win32')(
  'gc --delete lightens only an idle linked worktree that warm can restore and nothing runs in',
  async () => {
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
    let report: string;
    let payload: { sections: { worktreeDependencies: { path: string; detail: string | null }[] } };
    try {
      ({ payload } = await gcJson());
      report = await quietly(() => runGc({ delete: true }));
    } finally {
      child.kill('SIGKILL');
    }

    expect(existsSync(join(at('feature'), 'node_modules'))).toBe(false);
    expect(lightenedDirs(at('feature'))).toEqual([join(at('feature'), 'node_modules')]);
    expect(report).toMatch(/Lightened .*feature: deleted .*node_modules/);
    for (const name of ['repo', 'busy', 'keyless', 'drifted'])
      expect(existsSync(join(at(name), 'node_modules', 'pkg', 'index.js'))).toBe(true);
    const detail = (name: string) =>
      payload.sections.worktreeDependencies.find((entry: { path: string }) => entry.path.startsWith(`${at(name)}/`))
        ?.detail;
    expect(detail('busy')).toBe(`process ${child.pid} works in it`);
    expect(detail('keyless')).toMatch(/no workspace/);
    expect(detail('drifted')).toMatch(/pnpm-lock.yaml differs/);
    expect(existsSync(join(at('feature'), 'ios', 'Pods', 'Manifest.lock'))).toBe(true);
    expect(
      payload.sections.worktreeDependencies.find(
        (entry: { path: string }) => entry.path === join(at('feature'), 'ios', 'Pods'),
      )?.detail,
    ).toMatch(/would not copy ios\/Pods back/);
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
    expect(lightenedDirs(root)).toEqual([dir]);

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
    expect(lightenedDirs(root)).toEqual([]);

    write(join(dir, 'partial'));
    recordLightened([root], dir);
    expect(await restoreLightenedDependencies(root, context)).toBeNull();
    expect(existsSync(join(dir, 'partial'))).toBe(false);
    expect(warm.calls).toHaveLength(4);
  },
  60_000,
);
