import { afterEach, beforeEach, expect, test } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { getExecutor } from '../exec.ts';
import { acquireBuildLock, releaseBuildLock } from '../engine/build-lock.ts';
import { readCxxLauncherStates, repairCxxLauncherState } from '../doctor-cxx.ts';
import { checkCxxCompilerLauncher } from '../doctor.ts';
import { claudeLocalSettingsPath, missingAllowance } from '../sandbox.ts';

let root: string;
let home: string;
let previousPath: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stim-cxx-project-'));
  home = mkdtempSync(join(tmpdir(), 'stim-cxx-home-'));
  process.env.STIM_HOME = home;
  previousPath = process.env.PATH;
  writeFileSync(join(home, 'ccache'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  process.env.PATH = `${home}:${previousPath}`;
  getExecutor().runFile('git', ['init', '-q', root]);
  writeFileSync(join(root, '.gitignore'), '.cxx/\nnode_modules/\n');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  delete process.env.STIM_HOME;
  if (previousPath === undefined) delete process.env.PATH;
  else process.env.PATH = previousPath;
});

function cache(module: string, launcher: string | null, abi = 'arm64-v8a'): string {
  const path = join(root, module, '.cxx', 'Debug', 'abc123', abi);
  mkdirSync(path, { recursive: true });
  writeFileSync(
    join(path, 'CMakeCache.txt'),
    `CMAKE_BUILD_TYPE:STRING=Debug\nCMAKE_CXX_COMPILER_LAUNCHER:STRING=${launcher ?? ''}\n`,
  );
  return path;
}

test('a healthy ABI cannot hide a stale app or scoped native-module configuration', () => {
  const stale = cache('android/app', null);
  const healthy = cache('android/app', join(home, 'ccache'), 'x86_64');
  const module = cache('node_modules/@example/native/android', '/missing/bin/ccache');
  const states = readCxxLauncherStates(root);
  expect(states).toHaveLength(3);
  expect(checkCxxCompilerLauncher({ states, ccacheOnPath: true })).not.toBeNull();
  const result = repairCxxLauncherState(root);
  expect(result.refused).toEqual([]);
  expect(result.removed).toHaveLength(2);
  expect(existsSync(stale)).toBe(false);
  expect(existsSync(module)).toBe(false);
  expect(existsSync(healthy)).toBe(true);
  expect(checkCxxCompilerLauncher({ states: readCxxLauncherStates(root), ccacheOnPath: true })).toBeNull();
  expect(repairCxxLauncherState(root)).toEqual({ removed: [], refused: [] });
});

test('repair refuses tracked or non-ignored output and leaves neighboring source intact', () => {
  const tracked = cache('android/app', null);
  getExecutor().runFile('git', ['add', '-f', join(tracked, 'CMakeCache.txt')], { cwd: root });
  writeFileSync(join(root, '.gitignore'), '');
  const source = join(root, 'android/app/CMakeLists.txt');
  writeFileSync(source, 'project(Example)\n');
  const result = repairCxxLauncherState(root);
  expect(result.removed).toEqual([]);
  expect(result.refused[0]?.reason).toMatch(/tracked/);
  expect(existsSync(tracked)).toBe(true);
  expect(existsSync(source)).toBe(true);
  getExecutor().runFile('git', ['rm', '--cached', '-f', join(tracked, 'CMakeCache.txt')], { cwd: root });
  expect(repairCxxLauncherState(root).refused).toHaveLength(1);
  expect(existsSync(tracked)).toBe(true);
});

test('repair preserves explicit project launchers and healthy custom launchers', () => {
  const stale = cache('android/app', null);
  const custom = cache('node_modules/native/android', 'sccache');
  writeFileSync(join(root, 'android/app/build.gradle.kts'), 'arguments.add("-DCMAKE_CXX_COMPILER_LAUNCHER=sccache")');
  expect(repairCxxLauncherState(root).refused[0]?.reason).toMatch(/own compiler launcher/);
  expect(existsSync(stale)).toBe(true);
  expect(existsSync(custom)).toBe(true);
});

test('repair refuses an external linked dependency and an active Stim Android build', () => {
  const external = join(home, 'native/android/.cxx/Debug/abc123/arm64-v8a');
  mkdirSync(external, { recursive: true });
  writeFileSync(join(external, 'CMakeCache.txt'), 'CMAKE_BUILD_TYPE:STRING=Debug\n');
  mkdirSync(join(root, 'node_modules'), { recursive: true });
  symlinkSync(join(home, 'native'), join(root, 'node_modules/native'), 'dir');
  expect(repairCxxLauncherState(root).refused[0]?.reason).toMatch(/outside/);
  expect(existsSync(external)).toBe(true);
  const app = cache('android/app', null);
  const lock = acquireBuildLock({ platform: 'android', key: 'test', root });
  try {
    expect(repairCxxLauncherState(root).refused.some(({ reason }) => /build is active/.test(reason))).toBe(true);
    expect(existsSync(app)).toBe(true);
  } finally {
    releaseBuildLock(lock);
  }
});

test('repair refuses a redirected .cxx directory even when its target is within the checkout', () => {
  const app = cache('android/generated', null);
  mkdirSync(join(root, 'android/app'), { recursive: true });
  symlinkSync(dirname(dirname(dirname(app))), join(root, 'android/app/.cxx'), 'dir');
  expect(repairCxxLauncherState(root).refused[0]?.reason).toMatch(/symbolic link/);
  expect(existsSync(app)).toBe(true);
});

test('repair follows pnpm package links within the checkout for Git safety checks', () => {
  const module = 'node_modules/.pnpm/native@1/node_modules/native';
  const stale = cache(`${module}/android`, null);
  symlinkSync(join(root, module), join(root, 'node_modules/native'), 'dir');
  expect(repairCxxLauncherState(root)).toEqual({
    removed: ['node_modules/native/android/.cxx/Debug/abc123/arm64-v8a'],
    refused: [],
  });
  expect(existsSync(stale)).toBe(false);
});

test.each(['claude', 'codex'])(
  'Android doctor --json --fix repairs CMake under %s without a false sandbox failure',
  (harness) => {
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'fixture', dependencies: { 'react-native': '0.81.0' } }),
    );
    const stale = cache('android/app', null);
    const cli = join(import.meta.dirname, '../../dist/cli.mjs');
    const plain = JSON.parse(
      getExecutor().runFile(process.execPath, [cli, 'doctor', '--json', '--platform', 'android'], { cwd: root }),
    );
    expect(plain.findings.some((finding: { code?: string }) => finding.code === 'android-cmake-launcher')).toBe(true);
    expect(existsSync(stale)).toBe(true);
    const fixed = JSON.parse(
      getExecutor().runFile(process.execPath, [cli, 'doctor', '--json', '--fix', '--platform', 'android'], {
        cwd: root,
        env: harness === 'claude' ? { CLAUDECODE: '1' } : { CODEX_SANDBOX: 'seatbelt' },
        omitEnv: harness === 'codex' ? ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT'] : [],
      }),
    );
    expect(fixed.findings.some((finding: { code?: string }) => finding.code === 'android-cmake-launcher')).toBe(false);
    expect(missingAllowance([claudeLocalSettingsPath(root)], home)).toHaveLength(harness === 'claude' ? 0 : 3);
    expect(existsSync(claudeLocalSettingsPath(root))).toBe(harness === 'claude');
    expect(existsSync(stale)).toBe(false);
  },
);
