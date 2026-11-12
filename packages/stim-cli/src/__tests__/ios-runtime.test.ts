import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, statfsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ensureIosRuntime } from '../devices/ios-runtime.ts';
import { resetExecutor, setExecutor } from '../exec.ts';
import { buildSlotsDir } from '@stim-cli/core/state';
import { readClaimSet } from '../ownership-claim.ts';
import { makeChildProcess, makeExecutor } from './_factories.ts';

vi.mock('node:fs', async (original) => ({
  ...(await original<typeof import('node:fs')>()),
  statfsSync: vi.fn<typeof import('node:fs').statfsSync>(),
}));
let home: string;
let installed: boolean;
let downloads: number;
let command: string[];
const runtime = {
  identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
  name: 'iOS 26.5',
  version: '26.5',
  platform: 'iOS',
  isAvailable: true,
  supportedDeviceTypes: [],
};
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-runtime-test-'));
  vi.stubEnv('STIM_HOME', home);
  installed = false;
  downloads = 0;
  command = [];
  vi.mocked(statfsSync).mockReturnValue({ bavail: 30, bsize: 1024 ** 3 } as ReturnType<typeof statfsSync>);
  setExecutor(
    makeExecutor({
      runFileAsync: async (file, args) => {
        if (file === 'xcrun') return JSON.stringify({ runtimes: installed ? [runtime] : [] });
        command = [file, ...args];
        downloads++;
        installed = true;
        return '';
      },
    }),
  );
});
afterEach(() => {
  resetExecutor();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true });
});
const install = (requested = '26.5') => ensureIosRuntime({ requested, note: () => {} });

test('only an exact version can be requested, and an installed runtime never downloads', async () => {
  expect(await install('latest')).toMatchObject({ ok: false, code: 'STIM_BAD_ARG' });
  installed = true;
  expect(await install('iOS 26.5')).toEqual({ ok: true });
  expect(downloads).toBe(0);
});

describe.skipIf(process.platform !== 'darwin')('Xcode runtime installation', () => {
  test('a missing runtime is installed and verified; a second run reuses it', async () => {
    expect(await install()).toEqual({ ok: true });
    expect(await install()).toEqual({ ok: true });
    expect(downloads).toBe(1);
    expect(command).toEqual([
      'xcodebuild',
      '-downloadPlatform',
      'iOS',
      '-buildVersion',
      '26.5',
      '-architectureVariant',
      process.arch === 'arm64' ? 'arm64' : 'universal',
    ]);
  });
  test('a hosted install keeps the server-owned worker group claim until that group exits', async () => {
    setExecutor(
      makeExecutor({
        runFileAsync: async (file, _args, options) => {
          if (file === 'xcrun') return JSON.stringify({ runtimes: installed ? [runtime] : [] });
          options.onSpawn?.(makeChildProcess({ pid: process.pid }));
          installed = true;
          return '';
        },
      }),
    );
    expect(await ensureIosRuntime({ requested: '26.5', workerProcessGroup: true, note: () => {} })).toEqual({
      ok: true,
    });
    const claims = readClaimSet(join(home, 'ios-runtime-install'));
    expect(claims.live).toHaveLength(1);
    expect(claims.live[0]?.child).toEqual(claims.live[0]?.owner);
  });
  test('an installer that exited before its identity was read is refused with its own failure', async () => {
    const exited = spawn(process.execPath, ['-e', 'process.exit(1)'], { stdio: 'ignore' });
    const pid = exited.pid ?? 0;
    await new Promise((resolve) => exited.once('close', resolve));
    setExecutor(
      makeExecutor({
        runFileAsync: async (file, _args, options) => {
          if (file === 'xcrun') return JSON.stringify({ runtimes: [] });
          options.onSpawn?.(makeChildProcess({ pid }));
          throw new Error('Command failed: xcodebuild\nxcodebuild broke');
        },
      }),
    );
    const result = await install();
    expect(result).toMatchObject({ ok: false });
    expect(JSON.stringify(result)).toContain('xcodebuild broke');
    expect(JSON.stringify(result)).not.toContain('Cannot record');
  });
  test('unresolved local installer cleanup retains the installer identity on both claims', async () => {
    vi.stubEnv('STIM_MAX_BUILDS', '1');
    const unresolved = Object.assign(new Error('installer cleanup unresolved'), { reportCleanup: true });
    setExecutor(
      makeExecutor({
        runFileAsync: async (file, _args, options) => {
          if (file === 'xcrun') return JSON.stringify({ runtimes: [] });
          options.onSpawn?.(makeChildProcess({ pid: process.pid }));
          throw unresolved;
        },
      }),
    );
    await expect(install()).rejects.toBe(unresolved);
    const runtimeClaim = readClaimSet(join(home, 'ios-runtime-install')).live[0];
    const slotClaim = readClaimSet(join(buildSlotsDir(), 'slot-0')).live[0];
    expect(runtimeClaim?.child?.pid).toBe(process.pid);
    expect(slotClaim?.child).toEqual(runtimeClaim?.child);
  });
  test('concurrent callers download the same runtime once', async () => {
    let finish: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    setExecutor(
      makeExecutor({
        runFileAsync: async (file) => {
          if (file === 'xcrun') return JSON.stringify({ runtimes: installed ? [runtime] : [] });
          downloads++;
          await gate;
          installed = true;
          return '';
        },
      }),
    );
    const first = install();
    await vi.waitFor(() => expect(downloads).toBe(1));
    const second = install();
    finish();
    await vi.advanceTimersByTimeAsync(2000);
    expect(await Promise.all([first, second])).toEqual([{ ok: true }, { ok: true }]);
    expect(downloads).toBe(1);
  });
  test('insufficient or unreadable disk refuses before downloading', async () => {
    vi.mocked(statfsSync).mockReturnValue({ bavail: 19, bsize: 1024 ** 3 } as ReturnType<typeof statfsSync>);
    expect(await install()).toMatchObject({ ok: false, message: expect.stringContaining('20 GB') });
    vi.mocked(statfsSync).mockImplementation(() => {
      throw new Error('volume unavailable');
    });
    expect(await install()).toMatchObject({
      ok: false,
      message: expect.stringContaining('Cannot establish free disk space'),
    });
    expect(downloads).toBe(0);
  });
  test('Xcode refusal retains its diagnosis and does not continue the run', async () => {
    setExecutor(
      makeExecutor({
        runFileAsync: async (file) => {
          if (file === 'xcrun') return JSON.stringify({ runtimes: [] });
          throw new Error('iOS 26.5 (arm64Only) is not available for download.');
        },
      }),
    );
    expect(await install()).toMatchObject({
      ok: false,
      message: expect.stringContaining('not available for download'),
      remedy: expect.stringContaining('Xcode Settings > Components'),
    });
  });
  test('a successful process exit is insufficient without the requested simctl runtime', async () => {
    setExecutor(
      makeExecutor({ runFileAsync: async (file) => (file === 'xcrun' ? JSON.stringify({ runtimes: [] }) : '') }),
    );
    expect(await install()).toMatchObject({ ok: false, message: expect.stringContaining('not available in simctl') });
  });
});
