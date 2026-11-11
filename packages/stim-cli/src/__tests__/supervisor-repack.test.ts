import type { SpawnOptions } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { isBundleProof } from '../engine/launch-verify.ts';
import { closeMetroChildren, ensureMetro, openMetroChildren } from '../stimd/metro/children.ts';
import { repackRecords, repackServerProblem, startRepackServer } from '../stimd/metro/server-repack.ts';
import { detectDevServer } from '../stimd/metro/state.ts';
import { makeChildProcess } from './_factories.ts';

let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-repack-')));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const file = (name: string, contents = '') => {
  mkdirSync(dirname(join(root, name)), { recursive: true });
  writeFileSync(join(root, name), contents);
};
const installed = (name: string, bin?: string) => {
  file(`node_modules/${name}/package.json`, JSON.stringify({ name, ...(bin ? { bin: { [name]: bin } } : {}) }));
  if (!bin) return;
  file(`node_modules/${name}/${bin}`, '#!/usr/bin/env node\n');
  chmodSync(join(root, 'node_modules', name, bin), 0o755);
};
const expoModulesApp = () => {
  file('package.json', JSON.stringify({ dependencies: { expo: '57.0.0', 'react-native': '0.86.0' } }));
  installed('expo', 'bin/cli');
};
const ROCK_REPACK =
  "import { pluginRepack } from '@rock-js/plugin-repack';\nexport default { bundler: pluginRepack() };\n";

describe('detectDevServer', () => {
  test.each([
    {
      name: 'an Expo-modules app that bundles with Rock and Re.Pack runs Re.Pack, not expo start',
      setup: () => file('rock.config.mjs', ROCK_REPACK),
      expected: { mode: 'repack-child', config: 'rock.config.mjs' },
    },
    {
      name: 'a Rock app on Metro keeps Stim-hosted Metro',
      setup: () => file('rock.config.mjs', "import { pluginMetro } from '@rock-js/plugin-metro';\n"),
      expected: { mode: 'bare-inproc', config: 'rock.config.mjs' },
    },
    {
      name: "Re.Pack registered in react-native.config.js runs through the React Native CLI's commands",
      setup: () =>
        file(
          'react-native.config.js',
          "module.exports = { commands: require('@callstack/repack/commands/rspack') };\n",
        ),
      expected: { mode: 'repack-child', config: 'react-native.config.js' },
    },
    {
      name: 'an app with no bundler config stays Expo',
      setup: () => {},
      expected: { mode: 'expo-child', config: null },
    },
  ])('$name', ({ setup, expected }) => {
    expoModulesApp();
    setup();
    expect(detectDevServer(root)).toEqual(expected);
  });

  test('metro.command wins over a Re.Pack config', () => {
    file('rock.config.mjs', ROCK_REPACK);
    expect(detectDevServer(root, ['node', 'start.js', '{port}']).mode).toBe('command-child');
  });
});

describe('startRepackServer', () => {
  test("runs Rock's bin with the fixed Re.Pack flags and no adb for Re.Pack's own reverse, and Stim's own node on Windows", async () => {
    file('rock.config.mjs', ROCK_REPACK);
    installed('rock', 'dist/src/bin.js');
    installed('@callstack/repack');
    const calls: { cmd: string; args: string[]; opts: SpawnOptions }[] = [];
    const spawnFn = (cmd: string, args: string[], opts: SpawnOptions) => {
      calls.push({ cmd, args, opts });
      return makeChildProcess({ pid: 4242 });
    };
    const logsDir = join(root, 'logs');
    await startRepackServer({ root, port: 8095, logsDir, spawnFn, platform: 'darwin', resetCache: true });
    await startRepackServer({ root, port: 8095, logsDir, spawnFn, platform: 'win32' });

    const flags = ['start', '--port', '8095', '--no-interactive', '--no-reverse-port', '--json', '--log-requests'];
    expect(calls[0]).toMatchObject({ args: [...flags, '--reset-cache'], opts: { cwd: root } });
    expect(calls[0]?.opts.env?.ANDROID_HOME).toBe(devNull);
    expect(calls[0]?.cmd.endsWith(join('rock', 'dist', 'src', 'bin.js'))).toBe(true);
    expect(calls[1]?.cmd).toBe(process.execPath);
    expect(calls[1]?.args.slice(1)).toEqual(flags);
    expect(calls[1]?.args[0]?.endsWith(join('rock', 'dist', 'src', 'bin.js'))).toBe(true);
  });

  test('refuses with STIM_REPACK_BIN instead of falling back when the config names Re.Pack but it is not installed', async () => {
    expoModulesApp();
    file('rock.config.mjs', ROCK_REPACK);
    const spawnFn = vi.fn<(cmd: string, args: string[], opts: SpawnOptions) => never>();
    await expect(startRepackServer({ root, port: 8095, logsDir: join(root, 'logs'), spawnFn })).rejects.toMatchObject({
      code: 'STIM_REPACK_BIN',
      message: expect.stringContaining('rock.config.mjs'),
    });
    expect(spawnFn).not.toHaveBeenCalled();
    expect(repackServerProblem(root, null)).not.toBeNull();
    expect(repackServerProblem(root, ['node', 'start.js', '{port}'])).toBeNull();
  });

  test('stimd answers start with STIM_REPACK_BIN and its remedy, not a generic dev server failure', async () => {
    const previousHome = process.env.STIM_HOME;
    process.env.STIM_HOME = join(root, 'home');
    file('package.json', JSON.stringify({ dependencies: { 'react-native': '0.86.0' } }));
    file('rock.config.mjs', ROCK_REPACK);
    openMetroChildren();
    try {
      expect(await ensureMetro({ root, port: 8183 }, () => {})).toMatchObject({
        op: 'error',
        code: 'STIM_REPACK_BIN',
        remedy: expect.stringContaining('metro.command'),
      });
    } finally {
      await closeMetroChildren();
      if (previousHome === undefined) delete process.env.STIM_HOME;
      else process.env.STIM_HOME = previousHome;
    }
  });
});

describe('repackRecords', () => {
  const entry = (type: string, message: unknown[], issuer = 'DevServer') =>
    JSON.stringify({ timestamp: 1, type, issuer, message });
  const incoming = (reqId: string, url: string) =>
    entry('info', [{ reqId, req: { method: 'GET', url }, msg: 'incoming request' }]);
  const completed = (reqId: string, statusCode: number) =>
    entry('info', [{ reqId, res: { statusCode }, responseTime: 5, msg: 'request completed' }]);
  const progress = (value: number | null, time?: number) =>
    entry('progress', [{ progress: { platform: 'android', ...(time === undefined ? { value } : { time }) } }]);

  test('turns a bundle request and its compile into Android evidence, drops other requests and keeps other lines', () => {
    const toRecord = repackRecords();
    const records = [
      incoming('req-1', '/index.bundle?platform=android&dev=true'),
      incoming('req-2', '/status'),
      progress(0.1),
      progress(0.6),
      progress(null, 12_345),
      completed('req-2', 200),
      completed('req-1', 200),
      entry('error', ['Module not found:', "Can't resolve './missing'"]),
      'info Starting dev server on port 8095',
    ].map((line) => toRecord(line, 'stdout'));

    expect(records.map((record) => record?.event ?? null)).toEqual([
      'bundle_response_started',
      null,
      'bundle_build_started',
      null,
      'bundle_build_done',
      null,
      'bundle_response_finished',
      'repack_stdout',
      'repack_stdout',
    ]);
    expect(records[0]).toMatchObject({ platform: 'android', requestId: 'repack-req-1' });
    expect(records[6]).toMatchObject({ platform: 'android', requestId: 'repack-req-1', statusCode: 200 });
    expect(records[4]).toMatchObject({ platform: 'android', msg: 'Re.Pack compiled android in 12.3s' });
    expect(records[7]).toMatchObject({
      level: 'error',
      msg: "[DevServer] Module not found: Can't resolve './missing'",
    });
    expect(records[8]).toMatchObject({ raw: true });
    const proof = { ...records[4], ts: 10 };
    expect(isBundleProof(proof, 5, 'android')).toBe(true);
    expect(isBundleProof(proof, 5, 'ios')).toBe(false);
  });

  test('a compile whose errors Re.Pack reports after its done event fails that platform, and an error response fails its request', () => {
    const toRecord = repackRecords();
    const records = [
      progress(0.5),
      progress(null, 900),
      entry('error', ['Failed to build bundle due to errors'], 'LoggerPlugin'),
      incoming('req-3', '/index.bundle?platform=android'),
      completed('req-3', 500),
    ].map((line) => toRecord(line, 'stdout'));

    expect(records[2]).toMatchObject({ event: 'bundle_build_failed', level: 'error', platform: 'android' });
    expect(records[4]).toMatchObject({ event: 'bundle_response_failed', level: 'error', platform: 'android' });
  });
});
