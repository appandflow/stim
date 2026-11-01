import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { execFile } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  loadConfig,
  claimMetroPort,
  getProject,
  upsertProject,
  setDevice,
  releaseAndroidConsolePort,
  allConsolePortsAndSerials,
  getProjectSettings,
  getRepoSettings,
  writeConfigSetting,
  type ConfigSettingsTarget,
} from '../workspace/config.ts';
import assert from 'node:assert';

let tmpHome: string;

function liveProjectDir(name: string) {
  const dir = join(tmpHome, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'stim-test-'));
  process.env.STIM_HOME = tmpHome;
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
  delete process.env.STIM_HOME;
});

test('concurrent processes each keep their record', async () => {
  const script = join(tmpHome, 'writer.mjs');
  const configUrl = new URL('../workspace/config.ts', import.meta.url).href;
  writeFileSync(
    script,
    [
      `const { upsertProject } = await import(${JSON.stringify(configUrl)});`,
      'const key = process.argv[2];',
      'upsertProject(key, { bundleId: key, androidPackage: key, isExpo: false });',
    ].join('\n'),
  );

  const keys = ['/p1', '/p2', '/p3', '/p4', '/p5', '/p6'];
  await Promise.all(
    keys.map(
      (key) =>
        new Promise<void>((resolve, reject) => {
          execFile(process.execPath, [script, key], { env: { ...process.env, STIM_HOME: tmpHome } }, (err) =>
            err ? reject(err) : resolve(),
          );
        }),
    ),
  );

  const cfg = loadConfig();
  assert(cfg);
  for (const key of keys) {
    expect(cfg.projects[key]).toBeTruthy();
  }
});

test('claimMetroPort records the port when nothing else holds it', () => {
  upsertProject('/a', { bundleId: 'a', androidPackage: 'a', isExpo: false });
  expect(claimMetroPort('/a', 8082)).toBe(8082);
  const a = getProject('/a');
  assert(a);
  expect(a.metroPort).toBe(8082);
});

test('claimMetroPort refuses a port another project claimed first', () => {
  upsertProject('/a', { bundleId: 'a', androidPackage: 'a', isExpo: false });
  upsertProject('/b', { bundleId: 'b', androidPackage: 'b', isExpo: false });
  expect(claimMetroPort('/a', 8082)).toBe(8082);
  expect(claimMetroPort('/b', 8082)).toBe(null);
  const b = getProject('/b');
  assert(b);
  expect(b.metroPort).toBe(null);
});

test("claimMetroPort re-claiming a project's own port is not a conflict", () => {
  upsertProject('/a', { bundleId: 'a', androidPackage: 'a', isExpo: false });
  claimMetroPort('/a', 8082);
  expect(claimMetroPort('/a', 8082)).toBe(8082);
});

test('releaseAndroidConsolePort frees the claimed port and keeps the AVD recorded for gc', () => {
  const a = liveProjectDir('a');
  upsertProject(a, { bundleId: 'com.a', androidPackage: 'com.a', isExpo: false });
  setDevice(a, 'android', { avdName: 'stim-a', consolePort: 5554, owned: true, deviceName: 'stim-a' });
  expect(releaseAndroidConsolePort(a, 5554)).toBe(true);
  expect(getProject(a)?.platforms?.android).toEqual({ avdName: 'stim-a', owned: true, deviceName: 'stim-a' });
  expect(allConsolePortsAndSerials().androidConsolePorts).toEqual([]);
});

test('allConsolePortsAndSerials keeps the claim of a project on an unmounted volume', () => {
  const unmounted = '/Volumes/NotPluggedIn/worktree';
  upsertProject(unmounted, { bundleId: 'com.x', androidPackage: 'com.x', isExpo: false });
  setDevice(unmounted, 'android', { avdName: 'stim-x', consolePort: 5554 });
  const result = allConsolePortsAndSerials({ isMounted: () => false });
  expect(result.androidConsolePorts).toEqual([5554]);
});

test('allConsolePortsAndSerials frees the claim of a dead project on a mounted volume', () => {
  upsertProject('/definitely/gone', { bundleId: 'com.x', androidPackage: 'com.x', isExpo: false });
  setDevice('/definitely/gone', 'android', { avdName: 'stim-x', consolePort: 5554 });
  const result = allConsolePortsAndSerials({ isMounted: () => true });
  expect(result.androidConsolePorts).toEqual([]);
});

test('writeConfigSetting writes, overwrites, and unsets dotted workspace keys', () => {
  upsertProject('/p', { bundleId: 'a', androidPackage: 'a', isExpo: false });
  const target: ConfigSettingsTarget = { scope: 'workspace', projectPath: '/p' };
  writeConfigSetting(target, 'ios.deviceType', 'iPhone 16');
  writeConfigSetting(target, 'ios.script', 'dev:ios');
  writeConfigSetting(target, 'android.script', 'dev:android');
  writeConfigSetting(target, 'ios.deviceType', 'iPhone 17');
  expect(getProjectSettings('/p')).toEqual({
    ios: { deviceType: 'iPhone 17', script: 'dev:ios' },
    android: { script: 'dev:android' },
  });
  expect(writeConfigSetting(target, 'ios.script', undefined)).toBe(true);
  expect(writeConfigSetting(target, 'ios.script', undefined)).toBe(false);
  expect(getProjectSettings('/p')).toEqual({ ios: { deviceType: 'iPhone 17' }, android: { script: 'dev:android' } });
});

test('repo settings round-trip by git common dir', () => {
  const target: ConfigSettingsTarget = { scope: 'repo', gitCommonDir: '/repo/.git' };
  writeConfigSetting(target, 'ios.deviceType', 'iPhone 17');
  writeConfigSetting(target, 'worktree.exclude', ['.env']);
  expect(getRepoSettings('/repo/.git')).toEqual({
    ios: { deviceType: 'iPhone 17' },
    worktree: { exclude: ['.env'] },
  });
  expect(writeConfigSetting(target, 'worktree.exclude', undefined)).toBe(true);
  expect(getRepoSettings('/repo/.git')).toEqual({ ios: { deviceType: 'iPhone 17' } });
});

test('slot registry rejects unsafe names without mutating assignments', () => {
  const root = liveProjectDir('invalid-slots');
  upsertProject(root, {});
  const before = loadConfig();
  for (const slot of ['', '../phone', '__proto__', 'constructor', 'prototype', 'a'.repeat(65)]) {
    expect(() => setDevice(root, 'ios', { deviceUdid: 'test' }, slot)).toThrow(/device slot/);
  }
  expect(loadConfig()).toEqual(before);
});

test.each(['[]'])('refuses a config.json holding %s instead of dropping writes', (content) => {
  const p = join(tmpHome, 'config.json');
  writeFileSync(p, content);
  let err: unknown;
  try {
    upsertProject('/p', { bundleId: 'a', androidPackage: 'a', isExpo: false });
  } catch (e) {
    err = e;
  }
  expect((err as { code?: string } | undefined)?.code).toBe('STIM_CONFIG_CORRUPT');
  expect((err as Error).message).toContain(`${p} is not a JSON object`);
  expect(readFileSync(p, 'utf-8')).toBe(content);
});
