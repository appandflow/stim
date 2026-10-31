import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  reactNativeDoctorFindings,
  type DoctorInspectionOptions,
  runDoctor as inspectDoctor,
} from '../diagnostics/doctor.ts';
import { workspaceStateFile } from '../workspace/paths.ts';
import { upsertProject } from '../workspace/config.ts';
import { detectIsExpo, findServerWorkspace } from '../workspace/project.ts';
import { MODE_BARE, MODE_EXPO, runSupervisor } from '../supervisor/run.ts';
import { expoBinPath } from '../supervisor/server-expo.ts';

vi.mock('../engine/ios-signing.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../engine/ios-signing.ts')>()),
  probeSigningIdentities: async () => [{ sha1: 'A'.repeat(40), name: 'Apple Development: Doctor Test (TEAMID5678)' }],
}));

async function runDoctor(root: string, options: DoctorInspectionOptions = {}) {
  return (await inspectDoctor(root, options, [reactNativeDoctorFindings])).findings;
}

let home: string;
let ws: string;
let app: string;

function write(path: string, text: string, { exec = false } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  if (exec) chmodSync(path, 0o755);
  return path;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-home-'));
  process.env.STIM_HOME = home;
  ws = realpathSync(mkdtempSync(join(tmpdir(), 'stim-mono-')));
  app = join(ws, 'packages', 'app');

  write(join(ws, 'package.json'), JSON.stringify({ name: 'ws', private: true, workspaces: ['packages/*'] }));
  write(
    join(ws, 'node_modules', 'expo', 'package.json'),
    JSON.stringify({
      name: 'expo',
      version: '57.0.8',
      bin: { expo: 'bin/cli', fingerprint: 'bin/fingerprint' },
    }),
  );
  write(join(ws, 'node_modules', 'expo', 'bin', 'cli'), '#!/usr/bin/env node\n', { exec: true });
  write(join(ws, 'node_modules', '.bin', 'expo'), '#!/bin/sh\n', { exec: true });

  write(
    join(app, 'package.json'),
    JSON.stringify({
      name: '@ws/app',
      dependencies: { expo: '^57.0.8', 'expo-dev-client': '~57.0.9', react: '19.0.0' },
    }),
  );
  write(
    join(app, 'app.json'),
    JSON.stringify({
      name: 'app',
      platforms: ['ios', 'android'],
      plugins: ['expo-dev-client'],
      extra: { eas: { projectId: '439cfc57-af9a-461c-9d3c-89b985233942' } },
    }),
  );
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(ws, { recursive: true, force: true });
  delete process.env.STIM_HOME;
});

describe("finding the project's expo binary", () => {
  test.skipIf(process.platform === 'win32')(
    'a bin file that is not executable falls through to the .bin shim (POSIX execute bit; skipped on win32)',
    () => {
      mkdirSync(join(ws, '.git'));
      chmodSync(join(ws, 'node_modules', 'expo', 'bin', 'cli'), 0o644);
      expect(expoBinPath(app)).toBe(join(ws, 'node_modules', '.bin', 'expo'));
    },
  );

  test("expo on NODE_PATH, as pnpm's bin shims set it, does not make a bare project resolve it", () => {
    const bare = realpathSync(mkdtempSync(join(tmpdir(), 'stim-bare-')));
    try {
      write(join(bare, 'package.json'), JSON.stringify({ name: 'bare' }));
      const project = pathToFileURL(join(import.meta.dirname, '..', 'workspace', 'project.ts')).href;
      const script = `const { resolvePackageJson } = await import(${JSON.stringify(project)});
        process.stdout.write(JSON.stringify(resolvePackageJson(${JSON.stringify(bare)}, 'expo')));`;
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        env: { ...process.env, NODE_PATH: join(ws, 'node_modules') },
        encoding: 'utf8',
      });
      expect(result.stderr).toBe('');
      expect(JSON.parse(result.stdout)).toBe(null);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});

describe('detectIsExpo on a hoisted workspace', () => {
  test('a committed native project says so through use_expo_modules!', () => {
    const native = realpathSync(mkdtempSync(join(tmpdir(), 'stim-native-')));
    try {
      write(join(native, 'package.json'), JSON.stringify({ name: 'app', dependencies: { expo: '^57.0.0' } }));
      write(join(native, 'ios', 'Podfile'), "require 'json'\ntarget 'App' do\n  use_expo_modules!\nend\n");
      expect(detectIsExpo(native)).toBe(true);
    } finally {
      rmSync(native, { recursive: true, force: true });
    }
  });

  test('an explicit react-native run-ios script still wins: a bare project stays bare', () => {
    write(
      join(app, 'package.json'),
      JSON.stringify({
        name: '@ws/app',
        dependencies: { expo: '^57.0.8' },
        scripts: { ios: 'react-native run-ios' },
      }),
    );
    expect(detectIsExpo(app)).toBe(false);
  });
});

describe('detectIsExpo is the single source', () => {
  test('the supervisor picks the expo dev server for the project doctor treats as Expo', async () => {
    let startedExpo = false;
    const exited = [];
    await runSupervisor({
      root: app,
      port: 8199,
      attachSignals: false,
      watchman: async () => ({ roots: [] }),
      onExit: (code) => exited.push(code),
      startExpo: async () => {
        startedExpo = true;
        return { mode: MODE_EXPO, serverPid: 4242, onExit() {}, async close() {} };
      },
      startBare: async () => {
        throw new Error('a project detected as Expo must NOT get the bare in-process server');
      },
    });
    expect(startedExpo).toBe(true);
    expect(JSON.parse(readState()).supervisor.mode).toBe(MODE_EXPO);

    write(
      join(app, 'app.json'),
      JSON.stringify({
        name: 'app',
        platforms: ['ios', 'android'],
        plugins: ['expo-dev-client'],
        experiments: { buildCacheProvider: { plugin: '@stim-cli/expo-build-cache' } },
        extra: { eas: { projectId: '439cfc57-af9a-461c-9d3c-89b985233942' } },
      }),
    );
    const titles = (await runDoctor(app)).map((f) => f.title);
    expect(titles.some((t) => /build.?cache.?provider/i.test(t))).toBeTruthy();
  });

  test('and a bare project gets the bare server and none of the Expo findings', async () => {
    const bare = realpathSync(mkdtempSync(join(tmpdir(), 'stim-bare-')));
    try {
      write(join(bare, 'package.json'), JSON.stringify({ name: 'bare', dependencies: { 'react-native': '0.81.0' } }));
      let startedBare = false;
      await runSupervisor({
        root: bare,
        port: 8198,
        attachSignals: false,
        watchman: async () => ({ roots: [] }),
        onExit: () => {},
        startBare: async () => {
          startedBare = true;
          return { mode: MODE_BARE, serverPid: null, onExit() {}, async close() {} };
        },
        startExpo: async () => {
          throw new Error('a bare project must not spawn `expo start`');
        },
      });
      expect(startedBare).toBe(true);
      const titles = (await runDoctor(bare)).map((f) => f.title);
      expect(!titles.some((t) => /build.?cache.?provider|expo-dev-client/i.test(t))).toBeTruthy();
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});

function readState() {
  return readFileSync(workspaceStateFile(app), 'utf-8');
}

describe('the workspace a monorepo web server belongs to', () => {
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore' });
  let web: string;

  beforeEach(() => {
    web = join(ws, 'packages', 'web');
    write(join(web, 'package.json'), JSON.stringify({ name: '@ws/web', devDependencies: { vite: '^5.0.0' } }));
    git(ws, 'init', '-q', '-b', 'main');
    git(ws, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
  });

  test('ignores an app registered in another worktree nested under this one', () => {
    const nested = join(ws, '.worktrees', 'feature');
    git(ws, 'worktree', 'add', '-q', '--detach', nested);
    const nestedApp = join(nested, 'packages', 'app');
    write(join(nestedApp, 'package.json'), JSON.stringify({ name: '@ws/app', dependencies: { expo: '^57.0.8' } }));
    upsertProject(nestedApp, {});
    expect(findServerWorkspace(web)).toEqual({ root: web, from: null });
    upsertProject(app, {});
    expect(findServerWorkspace(web)).toEqual({ root: app, from: web });
  });
});
