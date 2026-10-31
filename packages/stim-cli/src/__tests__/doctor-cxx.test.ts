import { afterEach, beforeEach, expect, test } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { Command } from 'commander';
import { getExecutor } from '../exec.ts';
import doctorCommand from '../commands/doctor.ts';
import { analyzeStimVersions } from '../diagnostics/stim-installations.ts';
import { acquireBuildLock, releaseBuildLock } from '../engine/build-lock.ts';
import { readCxxLauncherStates, repairCxxLauncherState } from '../diagnostics/doctor-cxx.ts';
import { checkCxxCompilerLauncher } from '../diagnostics/doctor.ts';
import { resolveProjectSettings } from '../workspace/settings.ts';
import { writeCasToolchain } from './_factories.ts';

let root: string;
let home: string;
let previousPath: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stim-cxx-project-'));
  home = mkdtempSync(join(tmpdir(), 'stim-cxx-home-'));
  process.env.STIM_HOME = home;
  previousPath = process.env.PATH;
  writeFileSync(join(home, 'ccache'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  process.env.PATH = `${home}${delimiter}${previousPath}`;
  getExecutor().runFile('git', ['init', '-q', root], { timeoutMs: 60_000 });
  writeFileSync(join(root, '.gitignore'), '.cxx/\nnode_modules/\n');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  delete process.env.STIM_HOME;
  if (previousPath === undefined) delete process.env.PATH;
  else process.env.PATH = previousPath;
});

const projectSettings = () => resolveProjectSettings(root).settings;

function cache(module: string, launcher: string | null, abi = 'arm64-v8a'): string {
  const path = join(root, module, '.cxx', 'Debug', 'abc123', abi);
  mkdirSync(path, { recursive: true });
  writeFileSync(
    join(path, 'CMakeCache.txt'),
    `CMAKE_BUILD_TYPE:STRING=Debug\nCMAKE_CXX_COMPILER_LAUNCHER:STRING=${launcher ?? ''}\n`,
  );
  return path;
}

test.skipIf(process.platform === 'win32')(
  'a healthy ABI cannot hide a stale app or scoped native-module configuration (ccache PATH lookup is POSIX-only; skipped on win32)',
  () => {
    const stale = cache('android/app', null);
    const healthy = cache('android/app', join(home, 'ccache'), 'x86_64');
    const module = cache('node_modules/@example/native/android', '/missing/bin/ccache');
    const states = readCxxLauncherStates(root);
    expect(states).toHaveLength(3);
    expect(checkCxxCompilerLauncher({ states, ccacheOnPath: true })).not.toBeNull();
    const result = repairCxxLauncherState(root, projectSettings());
    expect(result.refused).toEqual([]);
    expect(result.removed).toHaveLength(2);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(module)).toBe(false);
    expect(existsSync(healthy)).toBe(true);
    expect(checkCxxCompilerLauncher({ states: readCxxLauncherStates(root), ccacheOnPath: true })).toBeNull();
    expect(repairCxxLauncherState(root, projectSettings())).toEqual({ removed: [], refused: [] });
  },
);

test.skipIf(process.platform === 'win32')(
  'repair refuses an external linked dependency and an active Stim Android build (ccache PATH lookup is POSIX-only; skipped on win32)',
  () => {
    const external = join(home, 'native/android/.cxx/Debug/abc123/arm64-v8a');
    mkdirSync(external, { recursive: true });
    writeFileSync(join(external, 'CMakeCache.txt'), 'CMAKE_BUILD_TYPE:STRING=Debug\n');
    mkdirSync(join(root, 'node_modules'), { recursive: true });
    symlinkSync(join(home, 'native'), join(root, 'node_modules/native'), 'dir');
    expect(repairCxxLauncherState(root, projectSettings()).refused[0]?.reason).toMatch(/outside/);
    expect(existsSync(external)).toBe(true);
    const app = cache('android/app', null);
    const lock = acquireBuildLock({ platform: 'android', key: 'test', root });
    try {
      expect(
        repairCxxLauncherState(root, projectSettings()).refused.some(({ reason }) => /build is active/.test(reason)),
      ).toBe(true);
      expect(existsSync(app)).toBe(true);
    } finally {
      releaseBuildLock(lock);
    }
  },
);

join(import.meta.dirname, '../../dist/cli.mjs');

test.skipIf(process.platform === 'win32')(
  'doctor --fix repairs nothing when the config cannot be read (ccache PATH lookup is POSIX-only; skipped on win32)',
  async () => {
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'fixture', dependencies: { 'react-native': '0.81.0' } }),
    );
    const path = cache('android/app', null);
    writeFileSync(join(home, 'config.json'), '{ "projects": ');
    const program = new Command();
    doctorCommand(program, '1.2.3', () => analyzeStimVersions('1.2.3', '/tools/stim-cli', []));
    const cwd = process.cwd();
    const log = console.log;
    const error = console.error;
    console.log = () => {};
    console.error = () => {};
    process.chdir(root);
    try {
      await expect(
        program.parseAsync(['node', 'stim', 'doctor', '--json', '--fix', '--platform', 'android']),
      ).rejects.toMatchObject({ code: 'STIM_CONFIG_CORRUPT' });
    } finally {
      process.chdir(cwd);
      console.log = log;
      console.error = error;
      process.exitCode = undefined;
    }
    expect(existsSync(path)).toBe(true);
  },
);

test.skipIf(process.platform === 'win32')(
  'a CAS toolchain selected in the environment is judged by whether Stim can use it (ccache PATH lookup is POSIX-only; skipped on win32)',
  () => {
    const previous = process.env.STIM_ANDROID_CAS_TOOLCHAIN;
    const path = cache('android/app', null);
    const { manifest } = writeCasToolchain(join(home, 'cas'));
    process.env.STIM_ANDROID_CAS_TOOLCHAIN = manifest;
    try {
      expect(repairCxxLauncherState(root, projectSettings())).toEqual({ removed: [], refused: [] });
      expect(existsSync(path)).toBe(true);
      process.env.STIM_ANDROID_CAS_TOOLCHAIN = join(home, 'gone', 'toolchain.json');
      expect(repairCxxLauncherState(root, projectSettings()).removed).toEqual([
        'android/app/.cxx/Debug/abc123/arm64-v8a',
      ]);
      expect(existsSync(path)).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.STIM_ANDROID_CAS_TOOLCHAIN;
      else process.env.STIM_ANDROID_CAS_TOOLCHAIN = previous;
    }
  },
);
