import type { SpawnOptions } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { verifyLaunch } from '../engine/launch-verify.ts';
import { ensureDevServer } from '../commands/native-runtime.ts';
import type { startDevServer } from '../commands/start.ts';
import { projectSettingsContext } from '../workspace/settings.ts';
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
const installed = (name: string, bin?: string, version = '5.4.1') => {
  file(
    `node_modules/${name}/package.json`,
    JSON.stringify({ name, version, ...(bin ? { bin: { [name]: bin } } : {}) }),
  );
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
  const bareApp = () => file('package.json', JSON.stringify({ dependencies: { 'react-native': '0.86.0' } }));
  test.each([
    {
      name: 'an Expo-modules app that bundles with Rock and Re.Pack runs Re.Pack, not expo start',
      setup: () => (expoModulesApp(), file('rock.config.mjs', ROCK_REPACK)),
      expected: { mode: 'repack-child', config: 'rock.config.mjs' },
    },
    {
      name: 'a Rock config that requires the Re.Pack plugin runs Re.Pack',
      setup: () =>
        file('rock.config.cjs', "const { pluginRepack } = require('@rock-js/plugin-repack');\nmodule.exports = {};\n"),
      expected: { mode: 'repack-child', config: 'rock.config.cjs' },
    },
    {
      name: 'a Rock config that imports the Re.Pack plugin dynamically runs Re.Pack',
      setup: () =>
        file(
          'rock.config.mjs',
          "export default { bundler: (await import('@rock-js/plugin-repack')).pluginRepack() };\n",
        ),
      expected: { mode: 'repack-child', config: 'rock.config.mjs' },
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
      name: 'a Rock app on Metro that installs expo keeps expo start',
      setup: () => (
        expoModulesApp(),
        file('rock.config.mjs', "import { pluginMetro } from '@rock-js/plugin-metro';\n")
      ),
      expected: { mode: 'expo-child', config: null },
    },
    {
      name: 'a Rock app on Metro without expo keeps Stim-hosted Metro',
      setup: () => (bareApp(), file('rock.config.mjs', "import { pluginMetro } from '@rock-js/plugin-metro';\n")),
      expected: { mode: 'bare-inproc', config: null },
    },
    {
      name: 'a commented-out Re.Pack import does not switch an Expo app',
      setup: () => (
        expoModulesApp(),
        file(
          'rock.config.mjs',
          "// import { pluginRepack } from '@rock-js/plugin-repack';\n/* import '@rock-js/plugin-repack'; */\nexport default {};\n",
        )
      ),
      expected: { mode: 'expo-child', config: null },
    },
    {
      name: 'a string that mentions Re.Pack does not switch a bare app',
      setup: () => (bareApp(), file('rock.config.mjs', "const todo = 'migrate to @rock-js/plugin-repack';\n")),
      expected: { mode: 'bare-inproc', config: null },
    },
    {
      name: 'an Expo app with no bundler config stays Expo',
      setup: expoModulesApp,
      expected: { mode: 'expo-child', config: null },
    },
    {
      name: 'a bare React Native app with a react-native.config.js that has no Re.Pack stays Stim-hosted Metro',
      setup: () => (bareApp(), file('react-native.config.js', 'module.exports = { assets: [] };\n')),
      expected: { mode: 'bare-inproc', config: null },
    },
  ])('$name', ({ setup, expected }) => {
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

  test('refuses Re.Pack 4, whose start command rejects the flags Stim passes', () => {
    file('react-native.config.js', "module.exports = { commands: require('@callstack/repack/commands') };\n");
    installed('react-native', 'cli.js');
    installed('@callstack/repack', undefined, '4.4.1');
    expect(repackServerProblem(root, null)?.message).toContain('resolves `@callstack/repack` 4.4.1');
    installed('@callstack/repack', undefined, 'next');
    expect(repackServerProblem(root, null)?.message).toContain('resolves `@callstack/repack` next');
    installed('@callstack/repack', undefined, '5.0.0');
    expect(repackServerProblem(root, null)).toBeNull();
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

// Lines a Re.Pack 5.4.1 dev server printed under `rock start --json --log-requests` for Expensify/App.
const REAL = {
  statusIn:
    '{"type":"info","timestamp":1794425632514,"issuer":"DevServer","message":[{"reqId":"req-1","req":{"method":"GET","url":"/status","host":"localhost:8082","remoteAddress":"::1","remotePort":54263},"msg":"incoming request"}]}',
  statusOut:
    '{"type":"info","timestamp":1794425632516,"issuer":"DevServer","message":[{"reqId":"req-1","res":{"statusCode":200},"responseTime":1.7669169999999212,"msg":"request completed"}]}',
  bundleIn:
    '{"type":"info","timestamp":1794425642379,"issuer":"DevServer","message":[{"reqId":"req-9","req":{"method":"GET","url":"/index.bundle?platform=ios&dev=true&minify=false","host":"localhost:8082","remoteAddress":"::1","remotePort":54324},"msg":"incoming request"}]}',
  progress:
    '{"issuer":"DevServer","message":[{"progress":{"platform":"ios","value":0.08}}],"timestamp":1794425642399,"type":"progress"}',
  progressLast:
    '{"issuer":"DevServer","message":[{"progress":{"platform":"ios","value":1}}],"timestamp":1794425684444,"type":"progress"}',
  done: '{"issuer":"DevServer","message":[{"progress":{"platform":"ios","time":42298}}],"timestamp":1794425684768,"type":"progress"}',
  bundleOut:
    '{"type":"info","timestamp":1794425685757,"issuer":"DevServer","message":[{"reqId":"req-9","res":{"statusCode":200},"responseTime":43377.698625,"msg":"request completed"}]}',
  listening:
    '{"type":"info","timestamp":1794425632503,"issuer":"DevServer","message":[{"msg":"Server listening at http://[::1]:8082"}]}',
  failed:
    '\u001b[31m✖\u001b[39m \u001b[90m[19:35:04.813Z]\u001b[39m\u001b[1m[LoggerPlugin]\u001b[22m \u001b[31mFailed to build bundle due to errors\u001b[39m ',
  banner: '5.4.1, powered by \u001b[1mRspack\u001b[22m',
};

describe('repackRecords', () => {
  test('turns a bundle request and its compile into iOS evidence, drops other requests and keeps other lines', () => {
    const toRecord = repackRecords();
    const records = [
      REAL.statusIn,
      REAL.statusOut,
      REAL.listening,
      REAL.bundleIn,
      REAL.progress,
      REAL.progressLast,
      REAL.done,
      REAL.bundleOut,
      REAL.banner,
    ].map((line) => toRecord(line, 'stdout'));

    expect(records.map((record) => record?.event ?? null)).toEqual([
      null,
      null,
      'repack_stdout',
      'bundle_response_started',
      'bundle_build_started',
      null,
      'bundle_build_done',
      'bundle_response_finished',
      'repack_stdout',
    ]);
    expect(records[3]).toMatchObject({ platform: 'ios', requestId: 'repack-req-9' });
    expect(records[6]).toMatchObject({ platform: 'ios', msg: 'Re.Pack compiled ios in 42.3s' });
    expect(records[7]).toMatchObject({ platform: 'ios', requestId: 'repack-req-9', statusCode: 200 });
    expect(records[8]).toMatchObject({ raw: true });
  });

  test("a compile error LoggerPlugin prints after the compile's done event carries that compile's platform", () => {
    const toRecord = repackRecords();
    expect(toRecord(REAL.failed, 'stdout')).not.toHaveProperty('platform');
    [REAL.progress, REAL.done].forEach((line) => toRecord(line, 'stdout'));
    expect(toRecord(REAL.failed, 'stdout')).toMatchObject({ level: 'error', platform: 'ios' });
  });

  test('an error response fails its bundle request', () => {
    const toRecord = repackRecords();
    const failed = REAL.bundleOut.replace('"statusCode":200', '"statusCode":500');
    const records = [REAL.bundleIn, failed].map((line) => toRecord(line, 'stdout'));
    expect(records[1]).toMatchObject({ event: 'bundle_response_failed', level: 'error', platform: 'ios' });
  });
});

describe('verifyLaunch on Re.Pack records', () => {
  const verify = (lines: string[], mode: string) => {
    let t = 1000;
    const toRecord = repackRecords();
    const records = lines.flatMap((line, index) => {
      const record = toRecord(line, 'stdout');
      return record ? [Object.assign(record, { ts: 1001 + index })] : [];
    });
    return verifyLaunch({
      platform: 'ios',
      mode,
      requireBundleResponse: true,
      since: 1000,
      timeoutMs: 100,
      pollMs: 25,
      stabilityMs: 0,
      now: () => t,
      sleep: async (ms: number) => {
        t += ms;
      },
      readRecords: () => records,
      readDeviceRecords: () => [],
      readClientRecords: () => [],
    });
  };

  test("a cold or warm bundle delivery verifies the launch through Stim's bundle response records", async () => {
    const cold = [REAL.bundleIn, REAL.progress, REAL.done, REAL.bundleOut];
    expect(await verify(cold, 'repack-child')).toMatchObject({ verified: true });
    expect(await verify([REAL.bundleIn, REAL.bundleOut], 'repack-child')).toMatchObject({ verified: true });
  });

  test('a bundle whose compile logged an error leaves the launch unverified, not proven', async () => {
    const result = await verify([REAL.bundleIn, REAL.progress, REAL.done, REAL.failed, REAL.bundleOut], 'repack-child');
    expect(result).toMatchObject({
      verified: false,
      errors: [expect.objectContaining({ level: 'error', platform: 'ios' })],
    });
    expect(result).not.toHaveProperty('fatal');
  });

  test('an error from an earlier compile does not taint a bundle a later clean compile produced', async () => {
    const lines = [REAL.progress, REAL.done, REAL.failed, REAL.bundleIn, REAL.progress, REAL.done, REAL.bundleOut];
    expect(await verify(lines, 'repack-child')).toMatchObject({ verified: true });
  });
});

describe('ensureDevServer for Re.Pack', () => {
  const gate = (reach: 'hosted' | 'device' | null, remote: boolean, settings = {}) => {
    const start = vi.fn<typeof startDevServer>();
    return {
      start,
      result: ensureDevServer({
        root,
        port: 8095,
        settings,
        settingsContext: projectSettingsContext(root),
        remote,
        reach,
        note: () => {},
        resolve: async () => ({ metro: { pid: 1 } }),
        start,
      }),
    };
  };

  test.each([
    { reach: 'device' as const, remote: false, code: 'STIM_LAN_METRO_UNREACHABLE' },
    { reach: 'hosted' as const, remote: false, code: 'STIM_REMOTE_METRO_UNREACHABLE' },
    { reach: null, remote: true, code: 'STIM_REMOTE_METRO_UNREACHABLE' },
  ])('refuses a $code device before reusing or starting Re.Pack', async ({ reach, remote, code }) => {
    file('rock.config.mjs', ROCK_REPACK);
    const { start, result } = gate(reach, remote);
    expect(await result).toMatchObject({ ok: false, code, remedy: expect.stringContaining('metro.command') });
    expect(start).not.toHaveBeenCalled();
  });

  test('metro.command lets a phone reach a Re.Pack app, and a non-Re.Pack app is not refused', async () => {
    file('rock.config.mjs', ROCK_REPACK);
    const command = { metro: { command: ['npx', 'rock', 'start', '--port', '{port}', '--host', '0.0.0.0'] } };
    expect(await gate('device', false, command).result).toMatchObject({ ok: true });
    file('rock.config.mjs', "import { pluginMetro } from '@rock-js/plugin-metro';\n");
    expect(await gate('device', false).result).toMatchObject({ ok: true });
  });
});
