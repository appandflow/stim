import { execSync } from 'node:child_process';
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
import { readWorkspaceState, recordWorkspaceUse, writeWorkspaceState } from '../workspace/workspace-state.ts';
import { LIGHTENED_KEY, restoreLightenedDependencies } from '../workspace/lightened.ts';
import { testContext } from './_context.ts';

const warm = vi.hoisted((): { exitCode: 0 | 1; calls: string[] } => ({ exitCode: 0, calls: [] }));
vi.mock('../commands/worktree.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../commands/worktree.ts')>()),
  warmWorktreeTarget: async ({ cwd }: { cwd: string }) => {
    warm.calls.push(cwd);
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

function idleRepoWithFeature(): { repo: string; feature: string } {
  const repo = join(projects, 'repo');
  mkdirSync(repo, { recursive: true });
  const git = (args: string, cwd = repo) => execSync(`git ${args}`, { cwd, encoding: 'utf-8', timeout: 15_000 }).trim();
  git('init -q -b main');
  git('config user.email test@example.com');
  git('config user.name test');
  writeFileSync(join(repo, '.gitignore'), 'node_modules/\n');
  writeFileSync(join(repo, 'package.json'), '{}');
  git('add -A');
  git('commit -q -m init');
  const feature = join(projects, 'feature');
  git(`worktree add -q "${feature}" -b feature`);
  for (const base of [repo, feature]) write(join(base, 'node_modules', 'pkg', 'index.js'));
  const roots = { repo: realpathSync.native(repo), feature: realpathSync.native(feature) };
  const hourAgo = new Date(Date.now() - 60 * 60_000);
  for (const root of Object.values(roots)) {
    upsertProject(root, { metroPort: null });
    recordWorkspaceUse(root, hourAgo);
    ensureWorkspaceStorage(root);
    ageTree(join(root, 'node_modules'), hourAgo);
    utimesSync(workspaceStateFile(root), hourAgo, hourAgo);
    const gitDir = git('rev-parse --path-format=absolute --git-dir', root);
    for (const file of ['index', 'HEAD', join('logs', 'HEAD')])
      if (existsSync(join(gitDir, file))) utimesSync(join(gitDir, file), hourAgo, hourAgo);
  }
  return roots;
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
  'gc --delete lightens an idle linked worktree and records its dependencies for restore; the source checkout keeps its own',
  async () => {
    const { repo, feature } = idleRepoWithFeature();

    const report = await quietly(() => runGc({ delete: true }));

    expect(existsSync(join(feature, 'node_modules'))).toBe(false);
    expect(existsSync(join(repo, 'node_modules', 'pkg', 'index.js'))).toBe(true);
    expect(report).toMatch(/Lightened .*feature: deleted .*node_modules/);
    expect(readWorkspaceState(feature)?.[LIGHTENED_KEY]).toMatchObject({ dirs: [join(feature, 'node_modules')] });
  },
  60_000,
);

test('a lightened workspace restores through worktree warm and forgets the record; a failed warm keeps it and refuses', async () => {
  const root = join(projects, 'app');
  mkdirSync(root, { recursive: true });
  const record = { [LIGHTENED_KEY]: { at: new Date().toISOString(), dirs: [join(root, 'node_modules')] } };
  const context = testContext({ cwd: root, projectRoot: root });

  expect(await restoreLightenedDependencies(root, context)).toBeNull();
  expect(warm.calls).toEqual([]);

  writeWorkspaceState(root, record);
  warm.exitCode = 1;
  expect(await restoreLightenedDependencies(root, context)).toMatchObject({ code: 'STIM_DEPS_FAILED' });
  expect(readWorkspaceState(root)?.[LIGHTENED_KEY]).toBeDefined();

  warm.exitCode = 0;
  expect(await restoreLightenedDependencies(root, context)).toBeNull();
  expect(warm.calls).toEqual([root, root]);
  expect(readWorkspaceState(root)?.[LIGHTENED_KEY]).toBeUndefined();
});
