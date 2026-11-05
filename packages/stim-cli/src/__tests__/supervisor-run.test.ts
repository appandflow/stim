import assert from 'node:assert';
import {
  realpathSync,
  existsSync,
  utimesSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join, resolve as absolute } from 'node:path';
import { getProject, upsertProject } from '../workspace/config.ts';
import { parseNdjsonText } from '../ndjson.ts';
import { supervisorPidFile, workspaceDir, workspaceLogsDir, workspaceStateFile } from '../workspace/paths.ts';
import { supervisorError } from '../supervisor/errors.ts';
import { readWorkspaceState, recordWorkspaceUse, writeWorkspaceState } from '../workspace/workspace-state.ts';
import { daemonClaimRoot, deviceViewersDir, readDeviceIdleShutdowns, readIdleStop } from '@stim-cli/core/state';
import * as ios from '../devices/ios.ts';
import * as teardown from '../devices/teardown.ts';
import { workspaceIdleProbe, type IdleProbe } from '../supervisor/idle-stop.ts';
import { serveShareList, shareRow } from './_share-list-server.ts';
import { releaseClaim, tryAcquireClaim } from '../ownership-claim.ts';
import { startBuildProgress } from '../engine/build-progress.ts';
import { deviceLeasePath, takeLease } from '../engine/device-lease.ts';
import type { NdjsonWriter } from '../ndjson.ts';
import { type ExecOptions, getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import { captureProcessToken, inspectProcessIdentity } from '../process-identity.ts';
import { MODE_COMMAND, type WorkspaceLaunchRecord } from '../supervisor/state.ts';
import {
  MODE_BARE,
  MODE_EXPO,
  type DeviceIdleOps,
  type ServerExitInfo,
  parseArgs,
  readPidFile,
  runSupervisor,
  writePidFile,
} from '../supervisor/run.ts';

const hostedMetro = vi.hoisted(() => ({ open: false }));
vi.mock('../supervisor/hosted-metro.ts', () => ({
  watchHostedMetro: () => {
    hostedMetro.open = true;
    return async () => {
      hostedMetro.open = false;
    };
  },
}));

let tmpHome: string;
let root: string;

test('an old supervisor finishing cannot erase its replacement registration or tunnel', async () => {
  let closed = false;
  const running = await runSupervisor({
    root,
    port: 8083,
    isExpo: () => false,
    attachSignals: false,
    onExit: () => {},
    startBare: async () => ({
      close() {
        closed = true;
      },
    }),
  });
  assert(running);
  const replacement = { pid: process.pid, processToken: 'replacement-instance', port: 8083 };
  const metroTunnel = { kind: 'expo' as const, url: 'https://replacement.example.com' };
  writeWorkspaceState(root, { supervisor: replacement, metroTunnel });
  upsertProject(root, { supervisor: replacement });
  writePidFile(root, process.pid);
  await running.shutdown(0, 'supervisor_stopped', 'test shutdown', {
    reason: 'signal',
    at: '2026-09-26T20:00:00.000Z',
    signal: 'SIGTERM',
  });
  expect(closed).toBe(true);
  expect(readWorkspaceState(root)?.supervisor).toEqual(replacement);
  expect(readWorkspaceState(root)?.devServerStop).toBeUndefined();
  expect(readWorkspaceState(root)?.metroTunnel).toEqual(metroTunnel);
  expect(getProject(root)?.supervisor).toEqual(replacement);
  expect(readPidFile(root)).toBe(process.pid);
});

beforeEach(() => {
  hostedMetro.open = false;
  tmpHome = mkdtempSync(join(tmpdir(), 'stim-test-'));
  process.env.STIM_HOME = tmpHome;
  root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-ws-')));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'ws' }));
  const real = getExecutor();
  setExecutor({
    ...real,
    runFileAsync: (file: string, args: string[], opts: ExecOptions) =>
      file === 'watchman'
        ? Promise.reject(new Error('watchman is not used here'))
        : real.runFileAsync(file, args, opts),
  });
});

afterEach(() => {
  resetExecutor();
  rmSync(tmpHome, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
  delete process.env.STIM_HOME;
});

function readMetroLog() {
  try {
    return parseNdjsonText(readFileSync(join(workspaceLogsDir(root), 'metro.ndjson'), 'utf-8'));
  } catch {
    return [];
  }
}

describe('parseArgs', () => {
  const absRoot = absolute('/abs/path');

  test('parses --idle-stop-minutes and refuses a value that is not a whole number', () => {
    expect(parseArgs(['--root', absRoot, '--port', '1', '--idle-stop-minutes', '60']).idleStopMinutes).toBe(60);
    expect(parseArgs(['--root', absRoot, '--port', '1', '--idle-stop-minutes', '1.5']).error).toMatch(/whole number/);
    expect(parseArgs(['--root', absRoot, '--port', '1', '--idle-stop-minutes']).error).toMatch(/whole number/);
    expect(parseArgs(['--root', absRoot, '--port', '1', '--device-idle-minutes', '30']).deviceIdleMinutes).toBe(30);
    expect(parseArgs(['--root', absRoot, '--port', '1', '--device-idle-minutes', '-1']).error).toMatch(/whole number/);
  });
});

describe('state.json concurrent writers (Contract 2 lock)', () => {
  test('4+ processes writing different keys never lose an update', async () => {
    const script = join(tmpHome, 'state-writer.mjs');
    const runUrl = new URL('../workspace/workspace-state.ts', import.meta.url).href;
    writeFileSync(
      script,
      [
        `const { writeWorkspaceState } = await import(${JSON.stringify(runUrl)});`,
        'const root = process.argv[2];',
        'const key = process.argv[3];',
        "process.on('message', () => {",
        '  writeWorkspaceState(root, { [key]: { pid: process.pid } });',
        "  process.send('done');",
        '});',
        "process.send('ready');",
      ].join('\n'),
    );

    const keys = [
      'supervisor',
      'lastBuild',
      'collectorsIos',
      'collectorsAndroid',
      'extra',
      'sixth',
      'seventh',
      'eighth',
    ];
    const children = keys.map((key) =>
      fork(script, [root, key], {
        env: { ...process.env, STIM_HOME: tmpHome },
        execArgv: [],
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      }),
    );
    function nextWrite(child: ChildProcess): Promise<void> {
      return new Promise((resolve, reject) => {
        const detach = () => {
          child.off('message', received);
          child.off('error', failed);
          child.off('exit', exited);
        };
        const received = () => {
          detach();
          resolve();
        };
        const failed = (error: Error) => {
          detach();
          reject(error);
        };
        const exited = (code: number | null) => failed(new Error(`State writer exited with ${code}`));
        child.once('message', received);
        child.once('error', failed);
        child.once('exit', exited);
      });
    }
    try {
      await Promise.all(children.map(nextWrite));
      for (let round = 0; round < 8; round++) {
        mkdirSync(workspaceDir(root), { recursive: true });
        writeFileSync(workspaceStateFile(root), '{}\n');
        const written = children.map(nextWrite);
        for (const child of children) child.send('write');
        await Promise.all(written);
        const state = readWorkspaceState(root);
        for (const key of keys) expect(state && state[key]).toBeTruthy();
      }
    } finally {
      await Promise.all(
        children.map(async (child) => {
          if (child.exitCode !== null || child.signalCode !== null) return;
          const exited = once(child, 'exit');
          child.kill('SIGKILL');
          await exited;
        }),
      );
    }
  }, 15_000);
});

describe('runSupervisor', () => {
  function fakeServer(overrides = {}) {
    const state: { closed: number; listeners: Array<(info?: ServerExitInfo | null) => void> } = {
      closed: 0,
      listeners: [],
    };
    return {
      state,
      handle: {
        mode: MODE_BARE,
        serverPid: null,
        onExit(cb: (info?: ServerExitInfo | null) => void) {
          state.listeners.push(cb);
        },
        async close() {
          state.closed += 1;
        },
        ...overrides,
      },
    };
  }

  test('metro.command hosts the configured command instead of the detected ecosystem', async () => {
    const command = ['node', 'cli.js', 'start', '--port', '{port}'];
    writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { expo: '58' } }));
    writeFileSync(join(root, 'app.json'), JSON.stringify({ expo: { slug: 'app' } }));
    writeFileSync(join(root, '.stim.json'), JSON.stringify({ metro: { command } }));
    const server = fakeServer({ mode: MODE_COMMAND, serverPid: 31338 });
    let received: readonly string[] | null = null;
    let receivedSettings: unknown = null;
    const running = await runSupervisor({
      root,
      port: 8093,
      attachSignals: false,
      onExit: () => {},
      startExpo: async () => {
        throw new Error('the Expo server must not start');
      },
      startCommand: async (opts) => {
        received = opts.command;
        receivedSettings = opts.settings;
        return server.handle;
      },
    });
    assert(running);
    expect(running.mode).toBe(MODE_COMMAND);
    expect(received).toEqual(command);
    expect(receivedSettings).toMatchObject({ metro: { command } });
    expect(readWorkspaceState(root)?.supervisor?.mode).toBe(MODE_COMMAND);
    expect(readWorkspaceState(root)?.supervisor?.hmrUpdates).toBeUndefined();
  });

  test('records the Expo child with a process token that proves it after the supervisor is gone', async () => {
    const server = fakeServer({ mode: MODE_EXPO, serverPid: process.pid });
    await runSupervisor({
      root,
      port: 8099,
      isExpo: () => true,
      attachSignals: false,
      onExit: () => {},
      startExpo: async () => server.handle,
    });
    const supervisor = readWorkspaceState(root)?.supervisor;
    assert(supervisor);
    expect(inspectProcessIdentity({ pid: supervisor.serverPid, processToken: supervisor.serverProcessToken })).toBe(
      'same',
    );
  });

  test('a server that comes up after an early signal is closed and never registered', async () => {
    const before = { SIGTERM: process.listeners('SIGTERM'), SIGINT: process.listeners('SIGINT') };
    const server = fakeServer();
    const exits: number[] = [];
    let started!: () => void;
    const running = runSupervisor({
      root,
      port: 8102,
      isExpo: () => false,
      onExit: (code) => exits.push(code),
      startBare: () =>
        new Promise((resolve) => {
          started = () => resolve(server.handle);
        }),
    });
    try {
      process.listeners('SIGTERM').find((listener) => !before.SIGTERM.includes(listener))?.('SIGTERM');
      started();
      expect(await running).toBe(null);
      expect(exits).toEqual([143]);
      expect(server.state.closed).toBe(1);
      expect(readWorkspaceState(root)?.supervisor).toBeUndefined();
      expect(readMetroLog().some((record) => record.event === 'server_started')).toBe(false);
    } finally {
      for (const name of ['SIGTERM', 'SIGINT'] as const) {
        for (const listener of process.listeners(name)) {
          if (!before[name].includes(listener)) process.off(name, listener);
        }
      }
    }
  });

  test('forwards `tunnel` to the expo starter, and records the URL it reports', async () => {
    const server = fakeServer({ mode: MODE_EXPO, serverPid: 31338 });
    let seenTunnel: boolean | undefined;
    const running = await runSupervisor({
      root,
      port: 8097,
      tunnel: true,
      isExpo: () => true,
      attachSignals: false,
      onExit: () => {},
      startExpo: async (opts) => {
        seenTunnel = opts.tunnel;
        opts.onTunnelUrl?.('exp://abc123.exp.direct');
        return server.handle;
      },
    });
    assert(running);
    expect(seenTunnel).toBe(true);
    const state = readWorkspaceState(root);
    expect(state?.metroTunnel).toEqual({ kind: 'expo', url: 'exp://abc123.exp.direct' });
    const records = readMetroLog();
    expect(records.some((r) => r.event === 'expo_tunnel_ready')).toBe(true);
  });

  test('a failed server close keeps ownership and a later shutdown can retry', async () => {
    let attempts = 0;
    const server = fakeServer({
      close: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('dev-server group is still alive');
      },
    });
    const exits: number[] = [];
    const running = await runSupervisor({
      root,
      port: 8093,
      isExpo: () => false,
      attachSignals: false,
      onExit: (code) => exits.push(code),
      startBare: async () => server.handle,
    });
    assert(running);
    try {
      await running.shutdown(0, 'supervisor_stopped', 'first shutdown');
      expect(exits).toEqual([]);
      expect(hostedMetro.open).toBe(true);
      expect(readPidFile(root)).toBe(process.pid);
      expect(readWorkspaceState(root)?.supervisor?.pid).toBe(process.pid);
      expect(getProject(root)?.supervisor?.pid).toBe(process.pid);
      expect(readMetroLog()).toContainEqual(expect.objectContaining({ event: 'server_close_failed' }));
      await running.shutdown(0, 'supervisor_stopped', 'retry shutdown');
      expect(attempts).toBe(2);
      expect(hostedMetro.open).toBe(false);
      expect(exits).toEqual([0]);
      expect(readPidFile(root)).toBeNull();
      expect(readWorkspaceState(root)).toBeNull();
      expect(getProject(root)?.supervisor).toBeUndefined();
    } finally {
      await running.shutdown(0, 'supervisor_stopped', 'fixture cleanup');
    }
  });

  const requestStop = (processToken: unknown, extra: { idleMinutes?: number } = {}) =>
    writeWorkspaceState(root, {
      devServerStopRequest: { processToken, by: 'stim stop', pid: 4242, at: '2026-09-26T20:00:00.000Z', ...extra },
    });

  const requested = { reason: 'requested', by: 'stim stop', byPid: 4242 };

  test.each([
    ['this supervisor', true, requested, 'info', /stop requested by stim stop \(pid 4242\)/, {}],
    ['an earlier supervisor', false, { reason: 'signal', signal: 'SIGTERM' }, 'warn', /from outside Stim/, {}],
    [
      'the idle stop of this supervisor',
      true,
      { reason: 'idle', idleMinutes: 15 },
      'info',
      /idle for 15 minutes/,
      { idleMinutes: 15 },
    ],
  ])(
    'a SIGTERM after a stop request for %s is attributed only when the token matches',
    async (_, matches, stop, level, msg, extra) => {
      const before = process.listeners('SIGTERM');
      const exits: number[] = [];
      await runSupervisor({
        root,
        port: 8104,
        isExpo: () => false,
        onExit: (code) => exits.push(code),
        startBare: async () => fakeServer().handle,
      });
      try {
        requestStop(matches ? readWorkspaceState(root)?.supervisor?.processToken : 'upid1.earlier', extra);
        process.listeners('SIGTERM').find((listener) => !before.includes(listener))?.('SIGTERM');
        await vi.waitFor(() => expect(exits).toEqual([0]));
        expect(readWorkspaceState(root)).toEqual({ devServerStop: { ...stop, at: expect.any(String) } });
        expect(readMetroLog().at(-1)).toMatchObject({ level, msg: expect.stringMatching(msg) });
      } finally {
        for (const listener of process.listeners('SIGTERM')) {
          if (!before.includes(listener)) process.off('SIGTERM', listener);
        }
      }
    },
  );

  test.each([
    [true, 0, requested, 'info', /stop requested by stim stop/],
    [
      false,
      1,
      { reason: 'server-exited', mode: MODE_EXPO, code: 0, signal: null },
      'error',
      /exit code 0\); Expo CLI also exits 0 on SIGTERM/,
    ],
  ])(
    'an Expo exit 0 with a stop request (%s) is that request, and without one it is flagged',
    async (hasRequest, exitCode, stop, level, msg) => {
      const server = fakeServer({ mode: MODE_EXPO, serverPid: 31340 });
      const exits: number[] = [];
      await runSupervisor({
        root,
        port: 8105,
        isExpo: () => true,
        attachSignals: false,
        onExit: (code) => exits.push(code),
        startExpo: async () => server.handle,
      });
      if (hasRequest) requestStop(readWorkspaceState(root)?.supervisor?.processToken);
      server.state.listeners[0]?.({ code: 0, signal: null });
      await vi.waitFor(() => expect(exits).toEqual([exitCode]));
      expect(readWorkspaceState(root)?.devServerStop).toEqual({ ...stop, at: expect.any(String) });
      expect(readMetroLog().at(-1)).toMatchObject({ level, msg: expect.stringMatching(msg) });
    },
  );

  test('a server that fails to start leaves no registration and exits 1 with the structured error', async () => {
    const exits: number[] = [];
    const stderr: string[] = [];
    const handle = await runSupervisor({
      root,
      port: 8096,
      isExpo: () => false,
      attachSignals: false,
      onExit: (code) => exits.push(code),
      stderr: (line) => stderr.push(line),
      startBare: async () => {
        throw supervisorError('STIM_BARE_DEPS', 'metro is not resolvable from the project', 'Run `npm install`.');
      },
    });

    expect(handle).toBe(null);
    expect(exits).toEqual([1]);
    expect(existsSync(supervisorPidFile(root))).toBe(false);
    expect(readWorkspaceState(root)).toBe(null);
    expect(getProject(root)?.supervisor).toBe(undefined);

    const last = readMetroLog().at(-1);
    assert(last);
    expect(last.event).toBe('supervisor_failed');
    expect(last.level).toBe('fatal');
    expect(last.msg).toMatch(/STIM_BARE_DEPS/);
    expect(last.msg).toMatch(/Remedy: Run `npm install`\./);
    expect(stderr.join('\n')).toMatch(/STIM_BARE_DEPS: metro is not resolvable/);
  });
});

describe('idle stop', () => {
  const MINUTE = 60_000;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  });

  afterEach(() => {
    vi.clearAllTimers();
  });

  async function startIdleSupervisor({
    probe,
    minutes = 60,
    close = () => {},
  }: { probe?: IdleProbe; minutes?: number; close?: () => Promise<void> | void } = {}) {
    const seen = { closed: 0, exits: [] as number[], writer: null as NdjsonWriter | null };
    const running = await runSupervisor({
      root,
      port: 8095,
      isExpo: () => false,
      attachSignals: false,
      onExit: (code) => seen.exits.push(code),
      idleStopMinutes: minutes,
      idleProbe: probe,
      startBare: async ({ writer }) => {
        seen.writer = writer ?? null;
        return {
          observesRequests: true,
          close() {
            seen.closed += 1;
            return close();
          },
        };
      },
    });
    assert(running);
    return Object.assign(seen, { running });
  }

  const quiet: IdleProbe = { lastActivityAt: () => NaN, blocker: () => null };

  function useProbeHost({ ps, adb = '' }: { ps: string | null; adb?: string | null }) {
    const outputs = { output: adb };
    const real = getExecutor();
    setExecutor({
      ...real,
      runFileQuiet: (file, args, opts) =>
        file === 'ps' ? ps : file === 'adb' ? outputs.output : real.runFileQuiet(file, args, opts),
    });
    const home = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    process.env.HOME = process.env.USERPROFILE = tmpHome;
    onTestFinished(() => {
      resetExecutor();
      for (const [key, value] of Object.entries(home)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
    return outputs;
  }

  test('a bundle request and a Stim command restart the clock, while dev server output and the client log do not', async () => {
    const seen = await startIdleSupervisor();
    await vi.advanceTimersByTimeAsync(50 * MINUTE);
    seen.writer?.write({ src: 'metro', event: 'bundle_response_started', platform: 'ios', requestId: 'r1' });
    seen.writer?.write({ src: 'metro', event: 'bundle_response_finished', platform: 'ios', requestId: 'r1' });
    await vi.advanceTimersByTimeAsync(50 * MINUTE);
    recordWorkspaceUse(root);
    await vi.advanceTimersByTimeAsync(50 * MINUTE);
    seen.writer?.write({ src: 'metro', event: 'expo_stdout', msg: ' LOG  hello', raw: true });
    const clientLog = join(workspaceLogsDir(root), 'client.ndjson');
    writeFileSync(clientLog, '{}\n');
    const at = new Date(Date.now());
    utimesSync(clientLog, at, at);
    await vi.advanceTimersByTimeAsync(9 * MINUTE);
    expect(seen.closed).toBe(0);

    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    expect(seen.closed).toBe(1);
    expect(readIdleStop(readWorkspaceState(root))?.idleMinutes).toBe(60);
  });

  test('metro.idleStopMinutes 0 never stops the dev server', async () => {
    const seen = await startIdleSupervisor({ probe: quiet, minutes: 0 });
    await vi.advanceTimersByTimeAsync(24 * 60 * MINUTE);
    expect(seen.closed).toBe(0);
  });

  test('the workspace probe blocks during a build and while a workspace device is driven', async () => {
    useProbeHost({ ps: '' });
    const probe = workspaceIdleProbe(root);
    expect(await probe.blocker()).toBe(null);

    const attempt = tryAcquireClaim({
      root: join(tmpHome, 'native-run.lock'),
      mode: 'exclusive',
      label: 'native-run lock',
    });
    assert(attempt.acquired);
    startBuildProgress({ root, platform: 'ios', slot: 'default', claim: attempt.acquired });
    expect(await probe.blocker()).toBe('a build is in progress');
    releaseClaim(attempt.acquired);
    expect(await probe.blocker()).toBe(null);

    upsertProject(root, { platforms: { ios: { deviceUdid: 'STIM-IDLE-TEST-UDID', owned: true } } });
    expect(await probe.blocker()).toBe(null);
    takeLease({ root, platform: 'ios', id: 'STIM-IDLE-TEST-UDID', kind: 'declared' });
    expect(await probe.blocker()).toMatch(/^ios device STIM-IDLE-TEST-UDID is leased by stim device lock until /);
  });

  test('a physical device this workspace locks blocks the stop until the lease expires', async () => {
    useProbeHost({ ps: '' });
    const probe = workspaceIdleProbe(root);
    takeLease({ root, platform: 'android', id: 'PHYSICAL-SERIAL', kind: 'declared', durationMs: 30 * MINUTE });
    expect(await probe.blocker()).toMatch(/^android device PHYSICAL-SERIAL is leased by stim device lock until /);

    vi.setSystemTime(Date.now() + 30 * MINUTE);
    expect(await probe.blocker()).toBe(null);

    writeFileSync(deviceLeasePath('android', 'PHYSICAL-SERIAL'), '{');
    expect(await probe.blocker()).toBe('android device PHYSICAL-SERIAL has a lease that cannot be read');
    rmSync(deviceLeasePath('android', 'PHYSICAL-SERIAL'));
    expect(await probe.blocker()).toBe(null);
  });

  test('on Windows, where ps does not exist, only the missing host driver probe is ignored', async () => {
    upsertProject(root, { platforms: { android: { serial: 'emulator-5554', owned: true } } });
    const adb = useProbeHost({ ps: null, adb: '  PID ARGS\n  1 init\n' });
    expect(await workspaceIdleProbe(root, { platform: 'darwin' }).blocker()).toBe(
      'android device emulator-5554 has unknown activity (driver-process)',
    );
    expect(await workspaceIdleProbe(root, { platform: 'win32' }).blocker()).toBe(null);

    adb.output = null;
    expect(await workspaceIdleProbe(root, { platform: 'win32' }).blocker()).toBe(
      'android device emulator-5554 has unknown activity (instrumentation)',
    );
  });

  test('a bundle response in flight keeps the dev server until it finishes or fails', async () => {
    const seen = await startIdleSupervisor({ probe: quiet });
    seen.writer?.write({ src: 'metro', event: 'bundle_response_started', platform: 'ios', requestId: 'r1' });
    seen.writer?.write({ src: 'metro', event: 'bundle_response_started', platform: 'android', requestId: 'r2' });
    await vi.advanceTimersByTimeAsync(90 * MINUTE);
    seen.writer?.write({ src: 'metro', event: 'bundle_response_finished', platform: 'ios', requestId: 'r1' });
    await vi.advanceTimersByTimeAsync(90 * MINUTE);
    expect(seen.closed).toBe(0);

    seen.writer?.write({ src: 'metro', event: 'bundle_response_failed', platform: 'android', requestId: 'r2' });
    await vi.advanceTimersByTimeAsync(59 * MINUTE);
    expect(seen.closed).toBe(0);
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(seen.closed).toBe(1);
  });
});

describe('device idle shutdown', () => {
  const MINUTE = 60_000;
  const quiet: IdleProbe = { lastActivityAt: () => NaN, blocker: () => null };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  });

  afterEach(() => {
    vi.clearAllTimers();
  });

  async function startDeviceIdleSupervisor({
    deviceMinutes = 2,
    metroMinutes = 0,
    due = () => true,
    observesRequests = true,
    probe = quiet,
  }: {
    deviceMinutes?: number;
    metroMinutes?: number;
    due?: () => boolean;
    observesRequests?: boolean;
    probe?: IdleProbe;
  } = {}) {
    const seen = { closed: 0, checks: 0, shutDowns: [] as number[] };
    const deviceIdle: DeviceIdleOps = {
      due: () => {
        seen.checks++;
        return due() ? [{ device: {} as never, idleForMs: deviceMinutes * MINUTE }] : [];
      },
      shutDown: async (_root, idleMs, log) => {
        seen.shutDowns.push(idleMs);
        log({ level: 'info', event: 'device_idle_shutdown', msg: 'shut down simulator stim-test, idle 2m' });
        return 1;
      },
    };
    recordWorkspaceUse(root);
    const running = await runSupervisor({
      root,
      port: 8096,
      isExpo: () => false,
      attachSignals: false,
      onExit: () => {},
      idleStopMinutes: metroMinutes,
      idleProbe: probe,
      deviceIdleMinutes: deviceMinutes,
      deviceIdle,
      startBare: async () => ({
        observesRequests,
        close() {
          seen.closed += 1;
        },
      }),
    });
    assert(running);
    return seen;
  }

  test('checks devices only after devices.idleShutdownMinutes without a Stim command, then shuts down the due ones', async () => {
    const seen = await startDeviceIdleSupervisor();
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(seen.checks).toBe(0);

    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(seen.shutDowns).toEqual([2 * MINUTE]);
    expect(seen.closed).toBe(0);
    expect(readMetroLog().find((record) => record.event === 'device_idle_shutdown')?.msg).toMatch(/stim-test/);

    recordWorkspaceUse(root);
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(seen.shutDowns).toHaveLength(1);
  });

  test('stops neither the dev server nor devices while its requests are invisible to Stim', async () => {
    const seen = await startDeviceIdleSupervisor({ deviceMinutes: 1, metroMinutes: 2, observesRequests: false });
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect(seen.shutDowns).toEqual([]);
    expect(seen.closed).toBe(0);
  });

  test('stops neither the dev server nor devices on its own while a home daemon holds its claim', async () => {
    const seen = await startDeviceIdleSupervisor({ deviceMinutes: 1, metroMinutes: 2 });
    const daemon = tryAcquireClaim({ root: daemonClaimRoot(), mode: 'exclusive' }).acquired;
    assert(daemon);
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect(seen.shutDowns).toEqual([]);
    expect(seen.closed).toBe(0);

    releaseClaim(daemon);
    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    expect(seen.shutDowns.length).toBeGreaterThan(0);
    expect(seen.closed).toBe(1);
  });

  test.skipIf(process.platform === 'win32')(
    'stops neither the dev server nor devices while a web share of the workspace is live',
    async () => {
      let shares = [shareRow(root, '2099-01-01T00:00:00.000Z')];
      let asked = 0;
      const server = await serveShareList(() => {
        asked++;
        return { shares };
      });
      onTestFinished(() => server.close());
      let shutDowns: number[] = [];
      const seen = await startDeviceIdleSupervisor({
        deviceMinutes: 1,
        metroMinutes: 2,
        probe: workspaceIdleProbe(root),
        due: () => shutDowns.length === 0,
      });
      shutDowns = seen.shutDowns;
      await vi.advanceTimersByTimeAsync(3 * MINUTE);
      expect(seen.shutDowns).toEqual([]);
      expect(seen.closed).toBe(0);
      await vi.waitFor(() => expect(asked).toBeGreaterThanOrEqual(2));
      await vi.advanceTimersByTimeAsync(MINUTE);
      await vi.waitFor(() => expect(asked).toBeGreaterThanOrEqual(4));
      expect(seen.shutDowns).toEqual([]);
      expect(seen.closed).toBe(0);

      shares = [];
      await vi.waitFor(
        async () => {
          await vi.advanceTimersByTimeAsync(MINUTE);
          expect(seen.closed).toBe(1);
        },
        { timeout: 5000 },
      );
      expect(seen.shutDowns.length).toBeGreaterThan(0);
    },
  );

  test.skipIf(process.platform === 'win32')(
    "keeps devices up when a share goes live between the device watcher's first read and its locked one",
    async () => {
      let asked = 0;
      const server = await serveShareList(() => ({
        shares: asked++ === 0 ? [] : [shareRow(root, '2099-01-01T00:00:00.000Z')],
      }));
      onTestFinished(() => server.close());
      const seen = await startDeviceIdleSupervisor({ deviceMinutes: 1 });
      await vi.waitFor(
        async () => {
          if (asked >= 3) return;
          await vi.advanceTimersByTimeAsync(MINUTE);
          throw new Error(`the share list was read ${asked} times`);
        },
        { timeout: 4000 },
      );
      expect(seen.shutDowns).toEqual([]);
    },
  );

  test("Metro's idle stop first shuts down devices idle for metro.idleStopMinutes when that is shorter", async () => {
    const seen = await startDeviceIdleSupervisor({ deviceMinutes: 90, metroMinutes: 60, due: () => false });
    await vi.advanceTimersByTimeAsync(60 * MINUTE);
    expect(seen.shutDowns).toEqual([60 * MINUTE]);
    expect(seen.closed).toBe(1);
  });

  test("devices.idleShutdownMinutes 0 keeps every device through Metro's idle stop, and the stop says so", async () => {
    const seen = await startDeviceIdleSupervisor({ deviceMinutes: 0, metroMinutes: 60 });
    await vi.advanceTimersByTimeAsync(60 * MINUTE);
    expect(seen.closed).toBe(1);
    expect(seen.shutDowns).toEqual([]);
    expect(readMetroLog().find((record) => record.event === 'supervisor_idle_stopped')?.msg).toContain(
      'idle.minutes is 0 for devices, so no device was shut down',
    );
  });

  describe("at Metro's idle stop", () => {
    let tornDown: string[];

    beforeEach(() => {
      const real = getExecutor();
      setExecutor({
        ...real,
        runFileQuiet: (file, args, opts) => (file === 'ps' ? '' : real.runFileQuiet(file, args, opts)),
        runFileQuietAsync: async (file, args, opts) => (file === 'ps' ? '' : real.runFileQuietAsync(file, args, opts)),
      });
      vi.stubEnv('HOME', tmpHome);
      vi.stubEnv('USERPROFILE', tmpHome);
      tornDown = [];
      vi.spyOn(teardown, 'teardownOwnedIosSim').mockImplementation(async (udid) => {
        tornDown.push(udid);
        return { status: 'torn-down', label: `stim-${udid}` };
      });
    });

    afterEach(() => {
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
    });

    const launch = (deviceId: string, release: boolean): WorkspaceLaunchRecord => ({
      appId: 'com.example.app',
      deviceId,
      metroPort: release ? null : 8097,
      release,
      launchedAt: new Date().toISOString(),
    });

    function bootedSims(...udids: string[]) {
      const listed = () =>
        udids
          .filter((udid) => !tornDown.includes(udid))
          .map((udid) => ({
            udid,
            name: `stim-${udid}`,
            state: 'Booted',
            runtime: 'iOS 27.0',
            deviceTypeIdentifier: 'iPhone',
            available: true,
          }));
      vi.spyOn(ios, 'listAllIosSims').mockImplementation(listed);
      vi.spyOn(ios, 'listAllIosSimsAsync').mockImplementation(async () => listed());
    }

    function writeDeviceLogs(slots: (string | undefined)[]) {
      const file = join(workspaceLogsDir(root), 'device.ndjson');
      mkdirSync(workspaceLogsDir(root), { recursive: true });
      const ts = Date.now();
      writeFileSync(
        file,
        slots
          .map((slot) => JSON.stringify({ src: 'device', platform: 'ios', ts, msg: 'nw_connection retry', slot }))
          .join('\n') + '\n',
      );
      utimesSync(file, new Date(ts), new Date(ts));
    }

    async function startSupervisor() {
      recordWorkspaceUse(root);
      const running = await runSupervisor({
        root,
        port: 8097,
        isExpo: () => false,
        attachSignals: false,
        onExit: () => {},
        idleStopMinutes: 15,
        deviceIdleMinutes: 15,
        startBare: async () => ({ observesRequests: true, close() {} }),
      });
      assert(running);
    }

    const idleStopMessage = () => readMetroLog().find((record) => record.event === 'supervisor_idle_stopped')?.msg;

    test('a Debug app logging 11 minutes before the window does not keep its simulator booted', async () => {
      upsertProject(root, { metroPort: 8097, platforms: { ios: { deviceUdid: 'DEBUG', owned: true } } });
      writeWorkspaceState(root, { launches: { ios: launch('DEBUG', false) } });
      bootedSims('DEBUG');
      await startSupervisor();
      await vi.advanceTimersByTimeAsync(4 * MINUTE);
      writeDeviceLogs([undefined]);

      await vi.advanceTimersByTimeAsync(11 * MINUTE);

      expect(tornDown).toEqual(['DEBUG']);
      expect(readMetroLog().map((record) => record.event)).toContain('device_idle_shutdown');
      expect(readDeviceIdleShutdowns(readWorkspaceState(root)).ios).toEqual(
        expect.objectContaining({ idleMinutes: 15 }),
      );
    });

    test('a simulator a stim-server client sent input to stays booted, and one it only streams frames of does not', async () => {
      upsertProject(root, {
        metroPort: 8097,
        platforms: { ios: { deviceUdid: 'VIEWED', owned: true } },
        deviceSlots: { touched: { ios: { deviceUdid: 'TOUCHED', owned: true } } },
      });
      writeWorkspaceState(root, {
        launches: { ios: launch('VIEWED', false), 'ios:touched': launch('TOUCHED', false) },
      });
      bootedSims('VIEWED', 'TOUCHED');
      await startSupervisor();
      await vi.advanceTimersByTimeAsync(11 * MINUTE);
      mkdirSync(deviceViewersDir(), { recursive: true });
      writeFileSync(
        join(deviceViewersDir(), 'server.json'),
        JSON.stringify({
          pid: process.pid,
          processToken: captureProcessToken(process.pid),
          devices: [
            { platform: 'ios', id: 'VIEWED' },
            { platform: 'ios', id: 'TOUCHED', lastInputAt: new Date(Date.now()).toISOString() },
          ],
        }),
      );

      await vi.advanceTimersByTimeAsync(4 * MINUTE);

      expect(tornDown).toEqual(['VIEWED']);
      expect(idleStopMessage()).toContain('kept simulator stim-TOUCHED up: a stim-server client sent it input');
    });

    test('device logs keep no simulator up, whatever its last launch', async () => {
      upsertProject(root, {
        metroPort: 8097,
        platforms: { ios: { deviceUdid: 'RELEASE', owned: true } },
        deviceSlots: {
          debug: { ios: { deviceUdid: 'DEBUG', owned: true } },
          bare: { ios: { deviceUdid: 'BARE', owned: true } },
        },
      });
      writeWorkspaceState(root, {
        launches: { ios: launch('RELEASE', true), 'ios:debug': launch('DEBUG', false) },
      });
      bootedSims('RELEASE', 'DEBUG', 'BARE');
      await startSupervisor();
      await vi.advanceTimersByTimeAsync(14 * MINUTE);
      writeDeviceLogs([undefined, 'debug', 'bare']);

      await vi.advanceTimersByTimeAsync(MINUTE);

      expect(tornDown.toSorted()).toEqual(['BARE', 'DEBUG', 'RELEASE']);
    });
  });
});
