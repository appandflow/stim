import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkStorageLayout, checkWorktreeStorageLayout } from '../diagnostics/doctor-storage.ts';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';

import { workspaceDerivedData } from '../workspace/paths.ts';
import { apkOutputsDir } from '../integrations/react-native-build.ts';
import { defaultAndroidLayout } from '../workspace/settings.ts';

let base: string;
let project: string;
let cache: string;
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'stim-storage-test-')));
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

test('doctor distinguishes Android project output from iOS workspace output', () => {
  const output = apkOutputsDir(defaultAndroidLayout(project));
  const findings = checkStorageLayout(project, {
    platform: 'android',
    device: (path) => (path === output ? 2 : 1),
    stagingRoot: (path) => path,
  });
  expect(findings.map((finding) => finding.title)).toEqual(['Android build-cache storage crosses filesystems']);
  expect(findings[0]?.detail).toContain(output);
  expect(findings[0]?.detail).toContain(cache);
  expect(findings[0]?.fix).toContain('STIM_BUILD_CACHE');
  expect(
    checkStorageLayout(project, { platform: 'ios', host: 'darwin', device: () => 1, stagingRoot: (path) => path }),
  ).toEqual([]);
});

test('doctor detects iOS output/cache and configured staging mismatches separately', () => {
  const output = join(workspaceDerivedData(project), 'Build', 'Products');
  const findings = checkStorageLayout(project, {
    platform: 'ios',
    host: 'darwin',
    device: (path) => (path === cache ? 2 : 1),
    stagingRoot: () => base,
  });
  expect(findings.map((finding) => finding.title)).toEqual([
    'Cached app/APK staging crosses filesystems',
    'iOS build-cache storage crosses filesystems',
  ]);
  expect(findings[1]?.detail).toContain(output);
});

test.each(['win32', 'linux'] as const)('a %s host has no DerivedData, so iOS storage findings stay off', (host) => {
  mkdirSync(join(project, 'ios'));
  const device = (path: string) => (path === cache ? 2 : 1);
  const stagingRoot = () => base;
  const mac = checkStorageLayout(project, { device, stagingRoot, host: 'darwin' }).map((finding) => finding.title);
  expect(mac).toContain('iOS build-cache storage crosses filesystems');
  for (const platform of ['ios', undefined] as const) {
    const titles = checkStorageLayout(project, { platform, device, stagingRoot, host }).map((finding) => finding.title);
    expect(titles).toEqual(['Cached app/APK staging crosses filesystems']);
  }
});

test('an explicit override on another volume warns for artifact preparation but not direct warming', () => {
  const staging = join(base, 'override');
  const findings = checkStorageLayout(project, {
    platform: 'ios',
    host: 'darwin',
    device: (path) => (path === staging ? 2 : 1),
    stagingRoot: () => staging,
  });
  expect(findings.map((finding) => finding.title)).toEqual([
    'Cached app/APK staging crosses filesystems',
    'iOS device app staging crosses filesystems',
  ]);
  expect(findings.every((finding) => finding.level === 'cost' && finding.fix?.includes('STIM_TMPDIR'))).toBe(true);
});

test('an invalid machine override produces a finding instead of a healthy report', () => {
  mkdirSync(process.env.STIM_HOME!);
  writeFileSync(join(process.env.STIM_HOME!, 'config.json'), JSON.stringify({ tempDir: 'relative' }));
  const findings = checkStorageLayout(project);
  expect(findings.map((finding) => finding.title)).toEqual(['Could not resolve temporary storage']);
  expect(findings[0]?.detail).toMatch(/absolute directory/);
});
import { execFileSync } from 'node:child_process';
