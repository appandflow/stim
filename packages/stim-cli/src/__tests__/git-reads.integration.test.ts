import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGc } from '../commands/gc.ts';
import { executeAction } from '../stimd/passes/act.ts';
import { resolveMaintenanceSettings } from '../stimd/passes/settings.ts';
import { ensureWorkspaceStorage } from '../workspace/paths.ts';
import { runHomePasses } from '../daemon/passes.ts';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import { upsertProject } from '../workspace/config.ts';
import { forgetGitReads, openGitReads } from '../workspace/git-reads.ts';
import { recordWorkspaceUse } from '../workspace/workspace-state.ts';
import {
  branchStatusAsync,
  gitCommonDirAsync,
  gitDirAsync,
  repoRootAsync,
  resolveFullRefAsync,
  resolveSourceCheckoutAsync,
  unpushedCommitsAsync,
} from '../workspace/worktree.ts';
import { testContext } from './_context.ts';

let home: string;
const TOTAL_LADDER = 36;
const TOTAL_GC = 48;

function git(args: string[]): string {
  return getExecutor().runFile('git', args, { timeoutMs: 5000 });
}

function commit(dir: string, message: string): void {
  git([
    '-C',
    dir,
    '-c',
    'user.name=t',
    '-c',
    'user.email=t@e',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    message,
  ]);
}

function repo(name: string): string {
  const root = join(home, 'projects', name);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'package.json'), '{"name":"p"}');
  writeFileSync(join(root, '.gitignore'), 'node_modules\n');
  mkdirSync(join(root, 'node_modules', 'x'), { recursive: true });
  writeFileSync(join(root, 'node_modules', 'x', 'a.js'), 'x');
  git(['init', '-q', '-b', 'main', root]);
  git(['-C', root, 'add', '.']);
  commit(root, 'initial');
  return root;
}

function linkedWorktree(root: string, branch: string): string {
  const path = join(home, 'projects', `${branch}-worktree`);
  git(['-C', root, 'worktree', 'add', '-q', '-b', branch, path]);
  return path;
}

/** Counts the git commands run while the executor stays the real one: worktree lists, checkout paths, branch statuses. */
function countGit(): Record<'total' | 'lists' | 'paths' | 'statuses', number> {
  const executor = getExecutor();
  const counts = { total: 0, lists: 0, paths: 0, statuses: 0 };
  const note = (file: string, args: string[]) => {
    if (file !== 'git') return;
    counts.total++;
    if (args.includes('worktree') && args.includes('list')) counts.lists++;
    if (args.includes('--show-toplevel') || args.includes('--git-common-dir')) counts.paths++;
    if (args.includes('--porcelain=v2')) counts.statuses++;
  };
  setExecutor({
    ...executor,
    runFile: (file, args, options) => (note(file, args), executor.runFile(file, args, options)),
    runFileQuiet: (file, args, options) => (note(file, args), executor.runFileQuiet(file, args, options)),
    runFileAsync: (file, args, options) => (note(file, args), executor.runFileAsync(file, args, options)),
    runFileQuietAsync: (file, args, options) => (note(file, args), executor.runFileQuietAsync(file, args, options)),
  });
  return counts;
}

/**
 * Two registered repositories at critical disk pressure, all idle for 40 days. The first has a linked worktree with
 * uncommitted work and one on a detached HEAD with a commit of its own.
 */
function fleet(): void {
  vi.stubEnv('STIM_DISK_MIN_FREE_GB', '100000');
  vi.stubEnv('STIM_DISK_CRITICAL_FREE_GB', '90000');
  const first = repo('first');
  const dirty = linkedWorktree(first, 'dirty');
  writeFileSync(join(dirty, 'package.json'), '{}');
  const detached = linkedWorktree(first, 'detached');
  git(['-C', detached, 'checkout', '-q', '--detach']);
  commit(detached, 'own');
  for (const path of [first, dirty, detached, repo('second')]) {
    upsertProject(path, { metroPort: null });
    recordWorkspaceUse(path, new Date(Date.now() - 40 * 86_400_000));
  }
}

async function gcDryRun(operation?: ReturnType<typeof testContext>): Promise<{ actions: unknown[] }> {
  const stdout: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((...args) => void stdout.push(args.join(' ')));
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await runGc({ dryRun: true, json: true }, operation ? { operation } : {});
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
  return JSON.parse(stdout[0] ?? 'null');
}

beforeEach(() => {
  home = realpathSync.native(mkdtempSync(join(tmpdir(), 'stim-git-reads-')));
  vi.stubEnv('STIM_HOME', home);
  resetExecutor();
});

afterEach(() => {
  resetExecutor();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

test('one report-mode ladder pass at critical lists each repository and reads each checkout once', async () => {
  fleet();
  const counts = countGit();
  const passes = await runHomePasses({ act: false, log: () => {} });
  expect(passes.pressure.level).toBe('critical');
  expect({ ...counts, total: counts.total <= TOTAL_LADDER }).toEqual({
    total: true,
    lists: 2,
    paths: 4,
    statuses: 2,
  });
}, 30_000);

test('a gc dry run lists each repository and reads each checkout once, with the plan it makes alone', async () => {
  fleet();
  const alone = await gcDryRun();
  const counts = countGit();
  const shared = await gcDryRun(testContext({ home }));
  expect({ ...counts, total: counts.total <= TOTAL_GC }).toEqual({ total: true, lists: 2, paths: 4, statuses: 2 });
  const plan = (payload: { actions: unknown[] }) => JSON.stringify(payload.actions).replaceAll(/\d+/g, 'N');
  expect(plan(shared)).toBe(plan(alone));
}, 30_000);

describe('answers match the separate reads', () => {
  test.each([
    ['a branch with no upstream and a commit of its own', (path: string) => commit(path, 'own')],
    [
      'a detached HEAD with uncommitted work',
      (path: string) => {
        git(['-C', path, 'checkout', '-q', '--detach']);
        writeFileSync(join(path, 'package.json'), '{}');
      },
    ],
    ['a branch before its first commit', (path: string) => git(['-C', path, 'checkout', '-q', '--orphan', 'fresh'])],
    [
      'a branch pushed to its upstream',
      (path: string) => {
        const remote = join(home, 'remote.git');
        git(['init', '-q', '--bare', remote]);
        git(['-C', path, 'remote', 'add', 'origin', remote]);
        commit(path, 'own');
        git(['-C', path, 'push', '-q', '-u', 'origin', 'feature']);
      },
    ],
  ])('the branch status of %s', async (_, arrange) => {
    const path = linkedWorktree(repo('main'), 'feature');
    arrange(path);
    const status = await branchStatusAsync(path);
    expect(status).not.toBeNull();
    expect({
      dirty: status?.dirty,
      head: status?.head,
      unpushed: await unpushedCommitsAsync(path, {}, status ?? undefined),
    }).toEqual({
      dirty: git(['-C', path, 'status', '--porcelain']).trim() !== '',
      head: await resolveFullRefAsync(path, 'HEAD'),
      unpushed: await unpushedCommitsAsync(path),
    });
  });

  test('a bare repository and a missing folder have no branch status', async () => {
    const bare = join(home, 'bare.git');
    git(['init', '-q', '--bare', bare]);
    expect(await branchStatusAsync(bare)).toBeNull();
    expect(await branchStatusAsync(join(home, 'missing'))).toBeNull();
  });

  test('a shared scope gives each checkout the answers it gets alone', async () => {
    const main = repo('main');
    const linked = linkedWorktree(main, 'feature');
    const removed = linkedWorktree(main, 'removed');
    rmSync(removed, { recursive: true, force: true });
    const replaced = linkedWorktree(main, 'replaced');
    rmSync(replaced, { recursive: true, force: true });
    git(['init', '-q', '-b', 'other', replaced]);
    const bare = join(home, 'bare.git');
    git(['clone', '-q', '--bare', main, bare]);
    const bareLinked = join(home, 'bare-linked');
    git(['-C', bare, 'worktree', 'add', '-q', bareLinked, 'main']);
    const paths = [main, linked, removed, replaced, bare, bareLinked, join(home, 'missing')];
    const read = async (operation?: ReturnType<typeof testContext>) => {
      const options = { declareFor: operation };
      const answers = [];
      for (const path of paths)
        answers.push({
          source: await resolveSourceCheckoutAsync(path, options),
          gitDir: await gitDirAsync(path, options),
          common: await gitCommonDirAsync(path, options),
          root: await repoRootAsync(path, options),
        });
      return answers;
    };
    const alone = await read();
    const operation = testContext({ home });
    const close = openGitReads(operation);
    const counts = countGit();
    try {
      expect(await read(operation)).toEqual(alone);
      expect(counts.lists).toBe(5);
    } finally {
      close();
    }
  });

  test('a forgotten scope asks git again', async () => {
    const main = repo('main');
    const linked = linkedWorktree(main, 'feature');
    const operation = testContext({ home });
    const close = openGitReads(operation);
    try {
      expect((await resolveSourceCheckoutAsync(main, { declareFor: operation })).entries).toHaveLength(2);
      git(['-C', main, 'worktree', 'remove', linked]);
      expect((await resolveSourceCheckoutAsync(main, { declareFor: operation })).entries).toHaveLength(2);
      forgetGitReads(operation);
      expect((await resolveSourceCheckoutAsync(main, { declareFor: operation })).entries).toHaveLength(1);
    } finally {
      close();
    }
  });
});

describe('an acting run asks git again under the claim', () => {
  test.each([
    ['kept when the worktree is locked between the plan and the claim', true, 'kept'],
    ['cleared when nothing changed', false, 'done'],
  ])('build outputs are %s', async (_, lockInBetween, status) => {
    const linked = linkedWorktree(repo('main'), 'feature');
    const old = new Date(Date.now() - 40 * 86_400_000);
    const outputs = join(ensureWorkspaceStorage(linked), 'derived-data');
    mkdirSync(outputs, { recursive: true });
    writeFileSync(join(outputs, 'blob'), 'x');
    utimesSync(join(outputs, 'blob'), old, old);
    recordWorkspaceUse(linked, old);
    upsertProject(linked, { metroPort: null });
    const executor = getExecutor();
    let lists = 0;
    setExecutor({
      ...executor,
      async runFileAsync(file, args, options) {
        const output = await executor.runFileAsync(file, args, options);
        if (lockInBetween && file === 'git' && args.includes('list') && args.includes(linked) && ++lists === 1)
          git(['-C', linked, 'worktree', 'lock', linked]);
        return output;
      },
    });
    const operation = testContext({ home });
    const close = openGitReads(operation);
    try {
      const outcome = await executeAction(
        { kind: 'would-clear-outputs', target: linked, workspace: linked, bytes: 0, reason: 'test' },
        { settings: resolveMaintenanceSettings(), protectedRoot: '/nowhere', operation },
      );
      expect(outcome.status).toBe(status);
      expect(existsSync(outputs)).toBe(status === 'kept');
    } finally {
      close();
    }
  });
});
