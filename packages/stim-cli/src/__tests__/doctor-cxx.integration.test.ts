import { afterEach, beforeEach, expect, test } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { stimdBootsFile } from '@stim-cli/core/state';
import { getExecutor } from '../exec.ts';
import { createStim } from '../api.ts';
import { doctorOp } from '../commands/doctor.ts';
import { runCli } from '../cli/define-op.ts';
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
  async () => {
    const stale = cache('android/app', null);
    const healthy = cache('android/app', join(home, 'ccache'), 'x86_64');
    const module = cache('node_modules/@example/native/android', '/missing/bin/ccache');
    const states = await readCxxLauncherStates(root);
    expect(states).toHaveLength(3);
    expect(checkCxxCompilerLauncher({ states, ccacheOnPath: true })).not.toBeNull();
    const result = await repairCxxLauncherState(root, projectSettings());
    expect(result.refused).toEqual([]);
    expect(result.removed).toHaveLength(2);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(module)).toBe(false);
    expect(existsSync(healthy)).toBe(true);
    expect(checkCxxCompilerLauncher({ states: await readCxxLauncherStates(root), ccacheOnPath: true })).toBeNull();
    expect(await repairCxxLauncherState(root, projectSettings())).toEqual({ removed: [], refused: [] });
  },
);

test.skipIf(process.platform === 'win32')(
  'repair refuses tracked or non-ignored output and leaves neighboring source intact (ccache PATH lookup is POSIX-only; skipped on win32)',
  async () => {
    const tracked = cache('android/app', null);
    getExecutor().runFile('git', ['add', '-f', join(tracked, 'CMakeCache.txt')], { cwd: root, timeoutMs: 60_000 });
    writeFileSync(join(root, '.gitignore'), '');
    const source = join(root, 'android/app/CMakeLists.txt');
    writeFileSync(source, 'project(Example)\n');
    const result = await repairCxxLauncherState(root, projectSettings());
    expect(result.removed).toEqual([]);
    expect(result.refused[0]?.reason).toMatch(/tracked/);
    expect(existsSync(tracked)).toBe(true);
    expect(existsSync(source)).toBe(true);
    getExecutor().runFile('git', ['rm', '--cached', '-f', join(tracked, 'CMakeCache.txt')], {
      cwd: root,
      timeoutMs: 60_000,
    });
    expect((await repairCxxLauncherState(root, projectSettings())).refused).toHaveLength(1);
    expect(existsSync(tracked)).toBe(true);
  },
);

test.skipIf(process.platform === 'win32')(
  'repair preserves explicit project launchers and healthy custom launchers (ccache PATH lookup is POSIX-only; skipped on win32)',
  async () => {
    const stale = cache('android/app', null);
    const custom = cache('node_modules/native/android', 'sccache');
    writeFileSync(join(root, 'android/app/build.gradle.kts'), 'arguments.add("-DCMAKE_CXX_COMPILER_LAUNCHER=sccache")');
    expect((await repairCxxLauncherState(root, projectSettings())).refused[0]?.reason).toMatch(/own compiler launcher/);
    expect(existsSync(stale)).toBe(true);
    expect(existsSync(custom)).toBe(true);
  },
);

test.skipIf(process.platform === 'win32')(
  'repair refuses an external linked dependency and an active Stim Android build (ccache PATH lookup is POSIX-only; skipped on win32)',
  async () => {
    const external = join(home, 'native/android/.cxx/Debug/abc123/arm64-v8a');
    mkdirSync(external, { recursive: true });
    writeFileSync(join(external, 'CMakeCache.txt'), 'CMAKE_BUILD_TYPE:STRING=Debug\n');
    mkdirSync(join(root, 'node_modules'), { recursive: true });
    symlinkSync(join(home, 'native'), join(root, 'node_modules/native'), 'dir');
    expect((await repairCxxLauncherState(root, projectSettings())).refused[0]?.reason).toMatch(/outside/);
    expect(existsSync(external)).toBe(true);
    const app = cache('android/app', null);
    const lock = acquireBuildLock({ platform: 'android', key: 'test', root });
    try {
      expect(
        (await repairCxxLauncherState(root, projectSettings())).refused.some(({ reason }) =>
          /build is active/.test(reason),
        ),
      ).toBe(true);
      expect(existsSync(app)).toBe(true);
    } finally {
      releaseBuildLock(lock);
    }
  },
);

test.skipIf(process.platform === 'win32')(
  'repair refuses a redirected .cxx directory even when its target is within the checkout (ccache PATH lookup is POSIX-only; skipped on win32)',
  async () => {
    const app = cache('android/generated', null);
    mkdirSync(join(root, 'android/app'), { recursive: true });
    symlinkSync(dirname(dirname(dirname(app))), join(root, 'android/app/.cxx'), 'dir');
    expect((await repairCxxLauncherState(root, projectSettings())).refused[0]?.reason).toMatch(/symbolic link/);
    expect(existsSync(app)).toBe(true);
  },
);

test.skipIf(process.platform === 'win32')(
  'doctor --fix repairs nothing when the config cannot be read (ccache PATH lookup is POSIX-only; skipped on win32)',
  async () => {
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'fixture', dependencies: { 'react-native': '0.81.0' } }),
    );
    const path = cache('android/app', null);
    writeFileSync(join(home, 'config.json'), '{ "projects": ');
    const boots = stimdBootsFile();
    mkdirSync(dirname(boots), { recursive: true });
    writeFileSync(
      boots,
      JSON.stringify({ format: 1, boots: [{ at: Date.now(), build: 'b', pid: 1, abnormal: true, cause: 'engine' }] }),
    );
    const doctor = doctorOp(() => analyzeStimVersions('1.2.3', '/tools/stim-cli', []));
    const cwd = process.cwd();
    const log = console.log;
    const error = console.error;
    const notes: string[] = [];
    console.log = () => {};
    console.error = (...args: unknown[]) => void notes.push(args.join(' '));
    process.chdir(root);
    try {
      await expect(
        runCli(doctor, ['--json', '--fix', '--platform', 'android'], { version: '1.2.3' }),
      ).rejects.toMatchObject({ code: 'STIM_CONFIG_CORRUPT' });
      expect(existsSync(boots)).toBe(true);
      expect(notes.join('\n')).not.toContain('crash hold cleared');
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
  async () => {
    const previous = process.env.STIM_ANDROID_CAS_TOOLCHAIN;
    const path = cache('android/app', null);
    const { manifest } = writeCasToolchain(join(home, 'cas'));
    process.env.STIM_ANDROID_CAS_TOOLCHAIN = manifest;
    try {
      expect(await repairCxxLauncherState(root, projectSettings())).toEqual({ removed: [], refused: [] });
      expect(existsSync(path)).toBe(true);
      process.env.STIM_ANDROID_CAS_TOOLCHAIN = join(home, 'gone', 'toolchain.json');
      expect((await repairCxxLauncherState(root, projectSettings())).removed).toEqual([
        'android/app/.cxx/Debug/abc123/arm64-v8a',
      ]);
      expect(existsSync(path)).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.STIM_ANDROID_CAS_TOOLCHAIN;
      else process.env.STIM_ANDROID_CAS_TOOLCHAIN = previous;
    }
  },
);

test.skipIf(process.platform === 'win32')(
  'in-process doctor repair removes stale ignored CMake output and keeps caller process state',
  async () => {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { 'react-native': '0.81.0' } }));
    const stale = cache('android/app', null);
    const tracked = cache('node_modules/native/android', null);
    getExecutor().runFile('git', ['add', '-f', join(tracked, 'CMakeCache.txt')], { cwd: root, timeoutMs: 60_000 });
    const cwd = process.cwd();
    const environment = { ...process.env };
    const exit = process.exitCode;
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      ANDROID_HOME: join(home, 'missing-sdk'),
      ANDROID_SDK_ROOT: join(home, 'missing-sdk'),
      STIM_DAEMON: 'off',
    };
    for (const key of Object.keys(env)) if (key.startsWith('CODEX_') || key.startsWith('CLAUDE')) delete env[key];
    const progress: string[] = [];
    const result = await createStim({
      projectRoot: root,
      home,
      env,
      onProgress: ({ message }) => progress.push(message),
    }).repairDoctor({ platform: 'android' });
    expect(result.exitCode).toBe(1);
    expect(result.report.project).toBe(realpathSync(root));
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(tracked)).toBe(true);
    expect(progress.some((line) => line.includes('tracked'))).toBe(true);
    expect(process.cwd()).toBe(cwd);
    expect(process.env).toEqual(environment);
    expect(process.exitCode).toBe(exit);
  },
);

test.skipIf(process.getuid?.() === 0 || process.platform === 'win32')(
  'a refused generated directory deletion still returns the doctor report and failing status',
  async () => {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { 'react-native': '0.81.0' } }));
    const target = cache('android/app', null);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      ANDROID_HOME: join(home, 'missing-sdk'),
      ANDROID_SDK_ROOT: join(home, 'missing-sdk'),
      STIM_DAEMON: 'off',
    };
    for (const key of Object.keys(env)) if (key.startsWith('CODEX_') || key.startsWith('CLAUDE')) delete env[key];
    const progress: string[] = [];
    chmodSync(dirname(target), 0o555);
    try {
      const result = await createStim({
        projectRoot: root,
        home,
        env,
        onProgress: ({ message }) => progress.push(message),
      }).repairDoctor({ platform: 'android' });
      expect(result.exitCode).toBe(1);
      expect(result.report.project).toBe(realpathSync(root));
      expect(existsSync(target)).toBe(true);
      expect(progress.some((line) => line.includes('kept') && /EACCES|EPERM/.test(line))).toBe(true);
    } finally {
      chmodSync(dirname(target), 0o755);
    }
  },
);
