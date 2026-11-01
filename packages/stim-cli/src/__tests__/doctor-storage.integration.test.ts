import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkWorktreeStorageLayout } from '../diagnostics/doctor-storage.ts';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';

let base: string;
let project: string;
let cache: string;
beforeEach(() => {
  base = realpathSync.native(mkdtempSync(join(tmpdir(), 'stim-storage-test-')));
  project = join(base, 'project');
  cache = join(base, 'cache');
  mkdirSync(project);
  vi.stubEnv('STIM_HOME', join(base, 'home'));
  vi.stubEnv('STIM_BUILD_CACHE', cache);
  vi.stubEnv('STIM_TMPDIR', undefined);
});
afterEach(() => {
  resetExecutor();
  vi.unstubAllEnvs();
  rmSync(base, { recursive: true, force: true });
});

test('shared storage inspection yields during real Git reads and compares the selected source with the known repository', async () => {
  resetExecutor();
  const git = (...args: string[]) => execFileSync('git', ['-C', project, ...args], { stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git(
    '-c',
    'user.email=t@t',
    '-c',
    'user.name=t',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'init',
  );
  const worktree = join(base, 'worktree');
  git('worktree', 'add', '-q', '-b', 'agent', worktree);
  const app = join(worktree, 'app');
  mkdirSync(app);
  const executor = getExecutor();
  const delayed = (file: string, args: string[]) =>
    file === 'git'
      ? {
          file: process.execPath,
          args: [
            '-e',
            "setTimeout(() => { const { spawnSync } = require('node:child_process'); const result = spawnSync('git', process.argv.slice(1), { stdio: 'inherit' }); process.exit(result.status ?? 1); }, 200)",
            '--',
            ...args,
          ],
        }
      : { file, args };
  setExecutor({
    ...executor,
    runFileQuiet(file, args, options) {
      const call = delayed(file, args);
      return executor.runFileQuiet(call.file, call.args, options);
    },
    runFileAsync(file, args, options) {
      const call = delayed(file, args);
      return executor.runFileAsync(call.file, call.args, options);
    },
  });
  const context = { root: app, repoRoot: worktree, options: {} };
  const device = (path: string) => (path === project ? 1 : 2);
  const started = Date.now();
  let finished = false;
  const pending = checkWorktreeStorageLayout(context, { device }).then((findings) => {
    finished = true;
    return findings;
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(Date.now() - started).toBeLessThan(150);
  expect(finished).toBe(false);
  const findings = await pending;
  expect(findings.map((finding) => finding.title)).toEqual(['Worktree copy crosses filesystems']);
  expect(findings[0]?.detail).toContain(`${project} -> ${worktree}`);
  expect(findings[0]?.fix).toContain('source checkout and linked worktree on the same volume');
  resetExecutor();
  expect(await checkWorktreeStorageLayout(context, { device: () => 1 })).toEqual([]);
  expect(
    await checkWorktreeStorageLayout(
      {
        ...context,
        options: {
          machineSettings: {
            settings: {},
            layers: [],
            corrupt: { level: 'cost', title: 'Invalid settings', detail: 'Unreadable', fix: null },
          },
        },
      },
      {
        device: () => {
          throw new Error('Must not inspect storage for corrupt settings');
        },
      },
    ),
  ).toEqual([]);
});

import { execFileSync } from 'node:child_process';
