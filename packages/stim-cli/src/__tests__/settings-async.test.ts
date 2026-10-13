import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import { git } from '../workspace/git.ts';
import { upsertProject, writeConfigSetting } from '../workspace/config.ts';
import { projectSettingsContextAsync, resolveProjectSettingsAsync } from '../workspace/settings.ts';

let directory: string;
let children: ChildProcess[];

beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'stim-settings-async-')));
  process.env.STIM_HOME = join(directory, 'home');
  children = [];
});

afterEach(() => {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  resetExecutor();
  rmSync(directory, { recursive: true, force: true });
  delete process.env.STIM_HOME;
});

function delayedGit(delay: number): void {
  const real = getExecutor();
  setExecutor({
    ...real,
    runFileAsync: (file, args, options) => {
      if (file !== 'git') return real.runFileAsync(file, args, options);
      const script = `
        setTimeout(() => {
          if (process.env.HOME || !process.env.SETTINGS_ROOT) process.exit(1);
          console.log(process.env.SETTINGS_ROOT + ${JSON.stringify(args.includes('--git-common-dir') ? '/.git' : '')});
        }, ${delay});
      `;
      return real.runFileAsync(process.execPath, ['-e', script], {
        ...options,
        onSpawn: (child) => {
          children.push(child);
          options.onSpawn?.(child);
        },
      });
    },
  });
}

test('delayed Git leaves the event loop responsive and uses only the caller environment', async () => {
  delayedGit(200);
  let finished = false;
  const pending = projectSettingsContextAsync(directory, undefined, { env: { SETTINGS_ROOT: directory } });
  void pending.then(() => (finished = true));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(finished).toBe(false);
  await expect(pending).resolves.toEqual({
    projectPath: directory,
    gitCommonDir: join(directory, '.git'),
    repoRoot: directory,
  });
});

test('cancellation stops active Git children and rejects instead of using fallback settings', async () => {
  delayedGit(30_000);
  const controller = new AbortController();
  const reason = new Error('cancel settings resolution');
  const pending = resolveProjectSettingsAsync(directory, {
    env: { SETTINGS_ROOT: directory },
    signal: controller.signal,
  });
  expect(children.length).toBeGreaterThan(0);
  controller.abort(reason);
  await expect(pending).rejects.toBe(reason);
  expect(children.every((child) => child.exitCode !== null || child.signalCode !== null)).toBe(true);
});

test('async settings preserve repository, app and workspace precedence and non-Git fallback', async () => {
  const repository = join(directory, 'repo');
  const app = join(repository, 'app');
  mkdirSync(app, { recursive: true });
  git(repository, ['init', '-q'], { write: true });
  writeFileSync(join(repository, '.stim.json'), JSON.stringify({ ios: { configuration: 'Release' } }));
  writeFileSync(join(app, '.stim.json'), JSON.stringify({ ios: { configuration: 'Debug', runtime: '26.2' } }));
  writeConfigSetting({ scope: 'repo', gitCommonDir: join(repository, '.git') }, 'ios.runtime', '26.3');
  upsertProject(app, {});
  writeConfigSetting({ scope: 'workspace', projectPath: app }, 'ios.runtime', '26.4');
  const resolved = await resolveProjectSettingsAsync(app);
  expect(resolved.context).toEqual({ projectPath: app, gitCommonDir: join(repository, '.git'), repoRoot: repository });
  expect(resolved.settings.ios).toEqual({ configuration: 'Debug', runtime: '26.4' });
  writeFileSync(join(directory, '.stim.json'), JSON.stringify({ android: { variant: 'demoDebug' } }));
  const outside = await resolveProjectSettingsAsync(directory);
  expect(outside.context).toEqual({ projectPath: directory, gitCommonDir: null, repoRoot: null });
  expect(outside.settings.android).toEqual({ variant: 'demoDebug' });
});
