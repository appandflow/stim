import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const { execFileSync, sleep, clock } = vi.hoisted(() => ({
  execFileSync: vi.fn(),
  sleep: vi.fn(),
  clock: { now: 0 },
}));
vi.mock('node:child_process', () => ({ execFileSync }));
vi.mock('node:timers/promises', () => ({ setTimeout: sleep }));

let directory;
beforeEach(() => {
  vi.resetModules();
  execFileSync.mockReset();
  clock.now = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => clock.now);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  sleep.mockReset().mockImplementation(async (ms) => {
    clock.now += ms;
  });
  directory = mkdtempSync(join(tmpdir(), 'stim-ci-app-smoke-'));
  const result = join(directory, 'run.json');
  writeFileSync(
    result,
    JSON.stringify({ platform: 'ios', facts: { udid: 'owned-device', bundleId: 'com.example.app' } }),
  );
  vi.stubEnv('STIM_CI_RUN_RESULT', result);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(directory, { recursive: true, force: true });
});

function processLists(...lists) {
  execFileSync.mockImplementation((_file, args) => {
    if (args.includes('get_app_container')) return '/installed/app';
    return lists.length > 1 ? lists.shift() : lists[0];
  });
}

it('accepts the exact installed app staying alive alongside a sibling process', async () => {
  processLists('20 0 UIKitApplication:com.example.app.xctrunner[abc]\n21 0 UIKitApplication:com.example.app[def]');
  await expect(import('./app-smoke.mjs')).resolves.toBeDefined();
});

it.each([
  '20 0 UIKitApplication:com.example.app.xctrunner[abc]',
  '- 0 UIKitApplication:com.example.app[abc]',
  '0 0 UIKitApplication:com.example.app[abc]',
])('refuses an installed app without its own live process: %s', async (list) => {
  processLists(list);
  await expect(import('./app-smoke.mjs')).rejects.toThrow('iOS app must have a running process');
});

it('refuses an app that restarts during the smoke interval', async () => {
  processLists('21 0 UIKitApplication:com.example.app[abc]', '22 0 UIKitApplication:com.example.app[abc]');
  await expect(import('./app-smoke.mjs')).rejects.toThrow('App process restarted during the smoke interval');
});

function timeout() {
  clock.now += 15_000;
  throw Object.assign(new Error('spawnSync xcrun ETIMEDOUT'), {
    code: 'ETIMEDOUT',
    stdout: 'partial output',
    stderr: 'simulator observation stalled',
  });
}

it.each(['get_app_container', 'launchctl'])(
  'retries an unavailable %s observation without shortening the smoke interval',
  async (command) => {
    processLists('21 0 UIKitApplication:com.example.app[abc]');
    const success = execFileSync.getMockImplementation();
    let pending = true;
    execFileSync.mockImplementation((file, args) => {
      if (pending && args.includes(command)) {
        pending = false;
        timeout();
      }
      return success(file, args);
    });
    await expect(import('./app-smoke.mjs')).resolves.toBeDefined();
    expect(clock.now).toBeGreaterThanOrEqual(20_000);
    expect(sleep).toHaveBeenCalledWith(5000);
    const diagnostic = JSON.parse(console.error.mock.calls[0][0]);
    expect(diagnostic).toMatchObject({
      outcome: 'unavailable',
      code: 'ETIMEDOUT',
      elapsedMs: 15_000,
      stdout: 'partial output',
      stderr: 'simulator observation stalled',
    });
    expect(diagnostic.args).toContain(command);
    expect(execFileSync.mock.calls.every(([, , options]) => options.timeout === 15_000)).toBe(true);
  },
);

it('fails persistent unavailable observations within the shared deadline and retains their errors', async () => {
  execFileSync.mockImplementation(timeout);
  await expect(import('./app-smoke.mjs')).rejects.toThrow('simulator observations unavailable');
  expect(clock.now).toBeLessThanOrEqual(60_000);
  expect(execFileSync).toHaveBeenCalledTimes(3);
  expect(console.error).toHaveBeenCalledTimes(3);
  expect(sleep).not.toHaveBeenCalledWith(5000);
});

it('does not retry a genuine installed-app query failure', async () => {
  const error = Object.assign(new Error('The application is not installed'), { status: 1, stderr: 'not installed' });
  execFileSync.mockImplementation(() => {
    throw error;
  });
  await expect(import('./app-smoke.mjs')).rejects.toBe(error);
  expect(execFileSync).toHaveBeenCalledTimes(1);
  expect(sleep).not.toHaveBeenCalled();
  expect(JSON.parse(console.error.mock.calls[0][0])).toMatchObject({ outcome: 'failed', stderr: 'not installed' });
});

it('retains the first PID when the second observation times out before reporting a replacement', async () => {
  execFileSync
    .mockReturnValueOnce('/installed/app')
    .mockReturnValueOnce('21 0 UIKitApplication:com.example.app[abc]')
    .mockReturnValueOnce('/installed/app')
    .mockImplementationOnce(timeout)
    .mockReturnValueOnce('22 0 UIKitApplication:com.example.app[abc]');
  await expect(import('./app-smoke.mjs')).rejects.toThrow('App process restarted during the smoke interval');
  expect(clock.now).toBeGreaterThanOrEqual(20_000);
});

it('shares the observation deadline across both installed-app and process samples', async () => {
  execFileSync
    .mockImplementationOnce(timeout)
    .mockReturnValueOnce('/installed/app')
    .mockReturnValueOnce('21 0 UIKitApplication:com.example.app[abc]')
    .mockImplementationOnce(timeout)
    .mockImplementationOnce(timeout)
    .mockReturnValue('21 0 UIKitApplication:com.example.app[abc]');
  await expect(import('./app-smoke.mjs')).rejects.toThrow('simulator observations unavailable');
  expect(sleep).toHaveBeenCalledWith(5000);
  expect(clock.now).toBeLessThanOrEqual(60_000);
  expect(execFileSync).toHaveBeenCalledTimes(5);
});
