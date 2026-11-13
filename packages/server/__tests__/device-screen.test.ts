import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { androidScreen } from '../src/device-screen.ts';
import { adbPath } from '../src/frame-helper.ts';

const run = vi.hoisted(() => vi.fn<(file: string, args: string[], options: object) => Promise<{ stdout: string }>>());
vi.mock('node:child_process', async (original) => {
  const { promisify } = await import('node:util');
  return {
    ...(await original<typeof import('node:child_process')>()),
    execFile: Object.assign(() => {}, { [promisify.custom]: run }),
  };
});

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-server-adb-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  run.mockReset();
  rmSync(home, { recursive: true, force: true });
});

function addAdb(sdk: string, executable: string): string {
  const path = join(sdk, 'platform-tools', executable);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '');
  return path;
}

it('uses the Windows Android Studio SDK to measure a device with no adb on PATH', async () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
  const local = join(home, 'Local AppData');
  const adb = addAdb(join(local, 'Android', 'Sdk'), 'adb.exe');
  const env = { LOCALAPPDATA: local, USERPROFILE: home, PATH: '' };
  run.mockResolvedValue({ stdout: 'Physical size: 1080x2400\nOverride size: 720x1600\n' });

  expect(await androidScreen('fixture-serial', env)).toEqual({ width: 720, height: 1600 });
  expect(run).toHaveBeenCalledWith(
    adb,
    ['-s', 'fixture-serial', 'shell', 'wm', 'size'],
    expect.objectContaining({ env }),
  );
});

it('tries both explicit SDK roots before Windows defaults, then falls back to adb on PATH', () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
  const defaultSdk = join(home, 'AppData', 'Local', 'Android', 'Sdk');
  const firstSdk = join(home, 'home-sdk');
  const secondSdk = join(home, 'root-sdk');
  const env = { ANDROID_HOME: firstSdk, ANDROID_SDK_ROOT: secondSdk, USERPROFILE: home };

  expect(adbPath(env)).toBe('adb');
  const defaultAdb = addAdb(defaultSdk, 'adb.exe');
  expect(adbPath(env)).toBe(defaultAdb);
  const secondAdb = addAdb(secondSdk, 'adb.exe');
  expect(adbPath(env)).toBe(secondAdb);
  const firstAdb = addAdb(firstSdk, 'adb.exe');
  expect(adbPath(env)).toBe(firstAdb);
});

it.each([
  ['darwin', ['Library', 'Android', 'sdk']],
  ['linux', ['Android', 'Sdk']],
] as const)('uses the platform SDK location on %s without an executable suffix', (platform, parts) => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue(platform);
  const adb = addAdb(join(home, ...parts), 'adb');
  expect(adbPath({ HOME: home })).toBe(adb);
});
