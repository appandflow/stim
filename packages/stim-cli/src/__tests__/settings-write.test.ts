import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { workspaceName, withAmbientContext } from '@stim-cli/core';
import { releaseClaim, tryAcquireClaim } from '../ownership-claim.ts';
import { createStim, StimError } from '../api.ts';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import { writeConfigSettingAsync } from '../workspace/config.ts';
import { testContext } from './_context.ts';

let directory: string;
let project: string;

beforeEach(() => {
  directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'stim-settings-write-')));
  project = join(directory, 'project');
  mkdirSync(project);
  writeFileSync(join(project, 'package.json'), '{}\n');
  vi.stubEnv('STIM_HOME', join(directory, 'caller-home'));
});

afterEach(() => {
  resetExecutor();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

function client(home: string, env = process.env) {
  return createStim({ projectRoot: project, home, env });
}

test('concurrent settings writes keep homes, overrides and the caller process separate', async () => {
  const first = join(directory, 'first');
  const second = join(directory, 'second');
  const cwd = process.cwd();
  const env = { ...process.env };
  const one = client(first, { ...process.env, STIM_MAX_BUILDS: '7' });
  const two = client(second);
  const [a, b] = await Promise.all([
    one.setSetting('concurrency.maxBuilds', '2'),
    two.setSetting('concurrency.maxBuilds', '3'),
  ]);
  expect(a.setting).toMatchObject({ value: 7, origin: 'env', layers: { machine: 2 } });
  expect(b.setting).toMatchObject({ value: 3, origin: 'machine', layers: { machine: 3 } });
  expect(await one.unsetSetting('concurrency.maxBuilds')).toMatchObject({
    changed: true,
    setting: { value: 7, layers: {} },
  });
  expect(JSON.parse(readFileSync(join(second, 'config.json'), 'utf8')).concurrency.maxBuilds).toBe(3);
  expect(existsSync(join(directory, 'caller-home'))).toBe(false);
  expect(process.cwd()).toBe(cwd);
  expect(process.env).toEqual(env);
});

test('committed writes preserve indentation and unrelated keys and refuse malformed files', async () => {
  const file = join(project, '.stim.json');
  const home = join(directory, 'home');
  writeFileSync(file, '{\n\t"keep": true\n}\n');
  const stim = client(home);
  await expect(stim.setSetting('ios.runtime', '26.4', { scope: 'committed' })).resolves.toMatchObject({
    file,
    changed: true,
    setting: { value: '26.4', origin: 'committed' },
  });
  expect(readFileSync(file, 'utf8')).toBe('{\n\t"keep": true,\n\t"ios": {\n\t\t"runtime": "26.4"\n\t}\n}\n');
  await stim.unsetSetting('ios.runtime', { scope: 'committed' });
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ keep: true });
  writeFileSync(file, '{ broken');
  await expect(stim.setSetting('ios.runtime', '26.4', { scope: 'committed' })).rejects.toMatchObject({
    code: 'STIM_BAD_ARG',
  });
  expect(readFileSync(file, 'utf8')).toBe('{ broken');
});

test('sensitive writes mask returned values and refuse committed literals', async () => {
  const stim = client(join(directory, 'home'));
  const result = await stim.setSetting('android.keystorePassword', 'secret', { scope: 'workspace' });
  expect(JSON.stringify(result)).not.toContain('secret');
  expect(result.setting).toMatchObject({ value: '********', layers: { workspace: '********' } });
  await expect(stim.setSetting('android.keystorePassword', 'secret', { scope: 'committed' })).rejects.toMatchObject({
    code: 'STIM_BAD_ARG',
  });
  expect(existsSync(join(project, '.stim.json'))).toBe(false);
});

test('a settings admission keeps its resolved project when registered monorepo apps change', async () => {
  getExecutor().runFile('git', ['init'], { cwd: project, timeoutMs: 5000 });
  const first = join(project, 'first');
  const second = join(project, 'second');
  for (const app of [first, second]) {
    mkdirSync(app);
    writeFileSync(join(app, 'package.json'), JSON.stringify({ dependencies: { expo: '~54.0.0' } }));
  }
  const home = join(directory, 'home');
  mkdirSync(home);
  const config = join(home, 'config.json');
  writeFileSync(config, JSON.stringify({ projects: { [first]: {} } }));
  const admitted: Array<string | null> = [];
  const result = await client(home).setSetting('ios.runtime', '26.4', {
    scope: 'workspace',
    beforeWrite: (workspace) => {
      admitted.push(workspace);
      writeFileSync(config, JSON.stringify({ projects: { [first]: {}, [second]: {} } }));
    },
  });
  expect(admitted).toEqual([first]);
  expect(result).toMatchObject({ setting: { value: '26.4', origin: 'workspace' } });
  expect(JSON.parse(readFileSync(config, 'utf8')).projects).toEqual({
    [first]: { settings: { ios: { runtime: '26.4' } } },
    [second]: {},
  });
});

test.each(['set', 'unset'] as const)('a refused %s admission leaves settings unchanged', async (action) => {
  const home = join(directory, 'home');
  const stim = client(home);
  await stim.setSetting('ios.runtime', '26.4', { scope: 'workspace' });
  const options = {
    scope: 'workspace' as const,
    beforeWrite: () => {
      throw new StimError({ code: 'STIM_CANCELLED', message: 'The workspace is busy.' });
    },
  };
  await expect(
    action === 'set' ? stim.setSetting('ios.runtime', '27.0', options) : stim.unsetSetting('ios.runtime', options),
  ).rejects.toMatchObject({ code: 'STIM_CANCELLED' });
  expect(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')).projects[project].settings.ios.runtime).toBe(
    '26.4',
  );
});

test.each(['commit', 'abort'] as const)('a contended config write yields and can %s', async (action) => {
  const home = join(directory, 'locked');
  mkdirSync(home);
  const holder = tryAcquireClaim({
    root: join(home, 'config.lock.claims'),
    mode: 'exclusive',
    label: 'settings fixture',
  });
  if (!holder.acquired) throw new Error('Could not hold config claim');
  const controller = new AbortController();
  const operation = testContext({
    home,
    projectRoot: project,
    cwd: project,
    env: { STIM_HOME: home },
    signal: controller.signal,
  });
  let settled = false;
  const pending = withAmbientContext(operation, () =>
    writeConfigSettingAsync({ scope: 'machine' }, 'concurrency.maxBuilds', 4, controller.signal),
  );
  void pending.then(
    () => (settled = true),
    () => (settled = true),
  );
  try {
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    expect(existsSync(join(home, 'config.json'))).toBe(false);
    if (action === 'abort') controller.abort();
    else releaseClaim(holder.acquired);
    const outcome = await pending.then(
      (changed) => ({ changed }),
      (error: unknown) => ({ name: error instanceof Error ? error.name : String(error) }),
    );
    expect(outcome).toEqual(action === 'commit' ? { changed: true } : { name: 'AbortError' });
    const config = existsSync(join(home, 'config.json'))
      ? JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'))
      : null;
    expect(config?.concurrency?.maxBuilds).toBe(action === 'commit' ? 4 : undefined);
  } finally {
    releaseClaim(holder.acquired);
    await pending.catch(() => {});
  }
});

test('a committed recording disable finishes deleting its files before settling cancellation', async () => {
  const home = join(directory, 'home');
  const stim = client(home);
  await stim.setSetting('ios.runtime', '26.4', { scope: 'workspace' });
  const recordings = join(home, 'workspaces', workspaceName(project), 'recordings');
  mkdirSync(recordings, { recursive: true });
  writeFileSync(join(recordings, 'segment'), 'recorded bytes');
  const controller = new AbortController();
  const remove = fsPromises.rm;
  const deletion = vi.spyOn(fsPromises, 'rm').mockImplementation((path, options) => {
    controller.abort();
    return remove(path, options);
  });
  syncBuiltinESMExports();
  try {
    await expect(
      stim.setSetting('recording.enabled', 'false', { scope: 'workspace', signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'STIM_CANCELLED' });
    expect(existsSync(recordings)).toBe(false);
    expect((await stim.settings()).settings.find((entry) => entry.key === 'recording.enabled')?.value).toBe(false);
  } finally {
    deletion.mockRestore();
    syncBuiltinESMExports();
  }
});

test('invalid writes and a pre-aborted request leave settings files untouched', async () => {
  const home = join(directory, 'home');
  const stim = client(home);
  await expect(stim.setSetting('ios.runtime', '26.4')).rejects.toMatchObject({ code: 'STIM_BAD_ARG' });
  await expect(stim.setSetting('concurrency.maxBuilds', 'many')).rejects.toMatchObject({ code: 'STIM_BAD_ARG' });
  await expect(stim.setSetting('missing.setting', 'true')).rejects.toMatchObject({ code: 'STIM_BAD_ARG' });
  await expect(stim.setSetting('concurrency.maxBuilds', '3', { signal: AbortSignal.abort() })).rejects.toMatchObject({
    code: 'STIM_CANCELLED',
  });
  expect(existsSync(home)).toBe(false);
  expect(existsSync(join(project, '.stim.json'))).toBe(false);
});

test('cancelling a device-pool write drains its asynchronous Tailscale probe before committing', async () => {
  const real = getExecutor();
  let started: (child: ChildProcess) => void = () => {};
  const ready = new Promise<ChildProcess>((resolve) => {
    started = resolve;
  });
  setExecutor({
    ...real,
    runFileAsync: (file, args, options) => {
      if (!/tailscale$/i.test(file)) return real.runFileAsync(file, args, options);
      return real.runFileAsync(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {
        ...options,
        onSpawn: (child) => {
          options.onSpawn?.(child);
          started(child);
        },
      });
    },
  });
  const home = join(directory, 'home');
  const controller = new AbortController();
  const pending = client(home).setSetting('remote.devicePoolDisabled', '["local"]', { signal: controller.signal });
  try {
    const child = await ready;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'STIM_CANCELLED' });
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    expect(existsSync(join(home, 'config.json'))).toBe(false);
  } finally {
    controller.abort();
    await pending.catch(() => {});
  }
});

test('a default home is storage context without turning on scoped-home overrides', async () => {
  const env = { ...process.env, HOME: directory, USERPROFILE: directory, STIM_HOME: undefined, CI: undefined };
  const stim = createStim({ projectRoot: project, env });
  const result = await stim.setSetting('archive.enabled', 'true', { scope: 'workspace' });
  expect(result.setting).toMatchObject({ value: true, origin: 'workspace' });
  expect((await stim.settings()).settings.find((entry) => entry.key === 'archive.enabled')).toEqual(result.setting);
  expect(existsSync(join(directory, '.stim', 'config.json'))).toBe(true);
});

test('recording changes serialize across workspaces through pending deletion', async () => {
  const real = getExecutor();
  setExecutor({
    ...real,
    runFileAsync: (file, args, options) =>
      file === 'git' ? Promise.resolve('') : real.runFileAsync(file, args, options),
  });
  const home = join(directory, 'home');
  const other = join(directory, 'other');
  mkdirSync(other);
  writeFileSync(join(other, 'package.json'), '{}\n');
  const one = client(home);
  const two = createStim({ projectRoot: other, home });
  await one.setSetting('ios.runtime', '26.4', { scope: 'workspace' });
  await two.setSetting('ios.runtime', '26.4', { scope: 'workspace' });
  const firstRecordings = join(home, 'workspaces', workspaceName(project), 'recordings');
  const secondRecordings = join(home, 'workspaces', workspaceName(other), 'recordings');
  for (const dir of [firstRecordings, secondRecordings]) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'old'), 'old recording');
  }
  let started: () => void = () => {};
  let release: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const remove = fsPromises.rm;
  const deletion = vi.spyOn(fsPromises, 'rm').mockImplementation(async (path, options) => {
    if (path === firstRecordings) {
      started();
      await blocked;
    }
    return remove(path, options);
  });
  syncBuiltinESMExports();
  const disable = one.setSetting('recording.enabled', 'false', { scope: 'machine' });
  let enable: ReturnType<typeof two.setSetting> | undefined;
  try {
    await ready;
    const controller = new AbortController();
    const cancelled = two.setSetting('recording.enabled', 'true', { scope: 'workspace', signal: controller.signal });
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ code: 'STIM_CANCELLED' });
    let enabled = false;
    enable = two.setSetting('recording.enabled', 'true', { scope: 'workspace' });
    void enable.then(() => (enabled = true));
    await new Promise((resolve) => setImmediate(resolve));
    expect(enabled).toBe(false);
    release();
    await disable;
    await enable;
    mkdirSync(secondRecordings, { recursive: true });
    writeFileSync(join(secondRecordings, 'new'), 'new recording');
    expect(readFileSync(join(secondRecordings, 'new'), 'utf8')).toBe('new recording');
    expect(existsSync(join(secondRecordings, 'old'))).toBe(false);
  } finally {
    release();
    await Promise.allSettled([disable, enable]);
    deletion.mockRestore();
    syncBuiltinESMExports();
  }
});
