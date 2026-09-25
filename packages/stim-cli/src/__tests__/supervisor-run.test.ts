import assert from 'node:assert';
import {
  realpathSync,
  existsSync,
  utimesSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve as absolute } from 'node:path';
import { getProject, upsertProject } from '../workspace/config.ts';
import { parseNdjsonText } from '../ndjson.ts';
import { supervisorPidFile, workspaceDir, workspaceLogsDir, workspaceStateFile } from '../workspace/paths.ts';
import { describeError, supervisorError } from '../supervisor/errors.ts';
import { readWorkspaceState, recordWorkspaceUse, writeWorkspaceState } from '../workspace/workspace-state.ts';
import { readIdleStop } from '@stim-cli/core/state';
import { workspaceIdleProbe, type IdleProbe } from '../supervisor/idle-stop.ts';
import { releaseClaim, tryAcquireClaim, type ClaimHandle } from '../ownership-claim.ts';
import { startBuildProgress } from '../engine/build-progress.ts';
import { takeLease } from '../engine/device-lease.ts';
import type { NdjsonWriter } from '../ndjson.ts';
import { withWorkspaceProcessLock, workspaceProcessLockPath } from '../engine/workspace-process-lock.ts';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import { inspectProcessIdentity } from '../process-identity.ts';
import {
  MODE_BARE,
  MODE_EXPO,
  type ServerExitInfo,
  clearWorkspaceSupervisor,
  parseArgs,
  readPidFile,
  runSupervisor,
  writePidFile,
} from '../supervisor/run.ts';

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
  await running.shutdown(0, 'supervisor_stopped', 'test shutdown');
  expect(closed).toBe(true);
  expect(readWorkspaceState(root)?.supervisor).toEqual(replacement);
  expect(readWorkspaceState(root)?.metroTunnel).toEqual(metroTunnel);
  expect(getProject(root)?.supervisor).toEqual(replacement);
  expect(readPidFile(root)).toBe(process.pid);
});

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'stim-test-'));
  process.env.STIM_HOME = tmpHome;
  root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-ws-')));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'ws' }));
});

afterEach(() => {
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

  test('accepts --root and --port', () => {
    expect(parseArgs(['--root', absRoot, '--port', '8082'])).toEqual({
      root: absRoot,
      port: 8082,
      tunnel: false,
      resetCache: false,
      idleStopMinutes: 0,
    });
  });

  test('parses --idle-stop-minutes and refuses a value that is not a whole number', () => {
    expect(parseArgs(['--root', absRoot, '--port', '1', '--idle-stop-minutes', '60']).idleStopMinutes).toBe(60);
    expect(parseArgs(['--root', absRoot, '--port', '1', '--idle-stop-minutes', '1.5']).error).toMatch(/whole number/);
    expect(parseArgs(['--root', absRoot, '--port', '1', '--idle-stop-minutes']).error).toMatch(/whole number/);
  });

  test('accepts --tunnel', () => {
    expect(parseArgs(['--root', absRoot, '--port', '8082', '--tunnel'])).toEqual({
      root: absRoot,
      port: 8082,
      tunnel: true,
      resetCache: false,
      idleStopMinutes: 0,
    });
  });

  test('refuses a relative root: every other path in the supervisor derives from it', () => {
    expect(parseArgs(['--root', 'rel', '--port', '8082']).error).toMatch(/absolute/);
  });

  test('refuses a missing or non-numeric port', () => {
    expect(parseArgs(['--root', '/abs']).error).toMatch(/--port/);
    expect(parseArgs(['--root', '/abs', '--port', 'metro']).error).toMatch(/--port/);
    expect(parseArgs(['--root', '/abs', '--port', '70000']).error).toMatch(/--port/);
  });

  test('parses --reset-cache as a one-shot flag', () => {
    expect(parseArgs(['--root', '/abs', '--port', '1', '--reset-cache']).resetCache).toBe(true);
    expect(parseArgs(['--root', '/abs', '--port', '1']).resetCache).toBe(false);
  });

  test('refuses an unknown argument rather than ignoring it', () => {
    expect(parseArgs(['--root', '/abs', '--port', '1', '--clear']).error).toMatch(/Unknown/);
  });
});

describe('describeError', () => {
  test('renders a structured error as code, message and remedy', () => {
    const err = supervisorError('STIM_BARE_DEPS', 'metro is not resolvable', 'Run `npm install`.');
    const text = describeError(err);
    expect(text).toMatch(/^STIM_BARE_DEPS: metro is not resolvable/);
    expect(text).toMatch(/Remedy: Run `npm install`\./);
  });

  test('renders a plain error as its message', () => {
    expect(describeError(new Error('boom'))).toBe('boom');
    expect(describeError(null)).toBe('unknown error');
  });
});

describe('Contract 2: the workspace state file', () => {
  test('writeWorkspaceState creates the global state.json and reads back', () => {
    writeWorkspaceState(root, { supervisor: { pid: 1, port: 8082, mode: MODE_BARE } });
    expect(existsSync(workspaceStateFile(root))).toBeTruthy();
    const state = readWorkspaceState(root);
    assert(state);
    assert(state.supervisor);
    expect(state.supervisor.port).toBe(8082);
  });

  test("writing merges rather than replaces, so a later step's lastBuild survives", () => {
    writeWorkspaceState(root, { lastBuild: { fingerprint: 'abc' } });
    writeWorkspaceState(root, { supervisor: { pid: 2, port: 8083 } });
    const state = readWorkspaceState(root);
    assert(state);
    assert(state.lastBuild);
    assert(state.supervisor);
    expect(state.lastBuild.fingerprint).toBe('abc');
    expect(state.supervisor.pid).toBe(2);
  });

  test('writing leaves no temp file behind: readers must never see a partial state', () => {
    writeWorkspaceState(root, { supervisor: { pid: 3, port: 8084 } });
    const leftovers = existsSync(workspaceDir(root)) ? readFileSync(workspaceStateFile(root), 'utf-8') : '';
    expect(leftovers).toMatch(/"pid": 3/);
    const dir = workspaceDir(root);
    const entries = existsSync(dir) ? readdirSync(dir) : [];
    expect(entries.filter((e) => e.includes('.tmp-'))).toEqual([]);
  });

  test('an unparseable state file reads as no state instead of throwing', () => {
    writeWorkspaceState(root, { supervisor: { pid: 4, port: 1 } });
    writeFileSync(workspaceStateFile(root), '{ half written');
    expect(readWorkspaceState(root)).toBe(null);
  });

  test('clearWorkspaceSupervisor removes only the supervisor key', () => {
    writeWorkspaceState(root, { lastBuild: { fingerprint: 'abc' }, supervisor: { pid: 5, port: 1 } });
    clearWorkspaceSupervisor(root);
    const state = readWorkspaceState(root);
    assert(state);
    expect(state.supervisor).toBe(undefined);
    assert(state.lastBuild);
    expect(state.lastBuild.fingerprint).toBe('abc');
  });

  test('clearWorkspaceSupervisor removes the file when nothing else is in it', () => {
    writeWorkspaceState(root, { supervisor: { pid: 6, port: 1 } });
    clearWorkspaceSupervisor(root);
    expect(existsSync(workspaceStateFile(root))).toBe(false);
  });

  test('the pid file round-trips and reads as null when absent', () => {
    expect(readPidFile(root)).toBe(null);
    writePidFile(root, 4242);
    expect(readFileSync(supervisorPidFile(root), 'utf-8').trim()).toBe('4242');
    expect(readPidFile(root)).toBe(4242);
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
        'const startAt = Number(process.argv[4]);',
        'while (Date.now() < startAt) {}',
        'writeWorkspaceState(root, { [key]: { pid: process.pid } });',
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
    for (let round = 0; round < 8; round++) {
      mkdirSync(workspaceDir(root), { recursive: true });
      writeFileSync(workspaceStateFile(root), '{}\n');
      const startAt = Date.now() + 250;
      await Promise.all(
        keys.map(
          (key) =>
            new Promise<void>((resolve, reject) => {
              execFile(
                process.execPath,
                [script, root, key, String(startAt)],
                { env: { ...process.env, STIM_HOME: tmpHome } },
                (err) => (err ? reject(err) : resolve()),
              );
            }),
        ),
      );

      const state = readWorkspaceState(root);
      for (const key of keys) {
        expect(state && state[key]).toBeTruthy();
      }
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

  test('records the supervisor BEFORE the server starts', async () => {
    const seen: {
      current: {
        pid: ReturnType<typeof readPidFile>;
        state: ReturnType<typeof readWorkspaceState>;
        config: NonNullable<ReturnType<typeof getProject>>['supervisor'] | null;
      } | null;
    } = { current: null };
    const server = fakeServer();
    await runSupervisor({
      root,
      port: 8091,
      isExpo: () => false,
      attachSignals: false,
      onExit: () => {},
      startBare: async () => {
        seen.current = {
          pid: readPidFile(root),
          state: readWorkspaceState(root),
          config: getProject(root)?.supervisor ?? null,
        };
        return server.handle;
      },
    });

    const seenAtStart = seen.current;
    assert(seenAtStart);
    const startState = seenAtStart.state;
    assert(startState);
    assert(startState.supervisor);
    const startConfig = seenAtStart.config;
    assert(startConfig);
    expect(seenAtStart.pid).toBe(process.pid);
    expect(startState.supervisor.port).toBe(8091);
    expect(startState.supervisor.mode).toBe(MODE_BARE);
    expect(startConfig.pid).toBe(process.pid);
    expect(startConfig.port).toBe(8091);
    expect(typeof startState.supervisor.startedAt).toBe('string');
  });

  test('a new supervisor clears a stale Expo tunnel before it starts the server', async () => {
    writeWorkspaceState(root, { metroTunnel: { kind: 'expo', url: 'exp://stale.exp.direct' } });
    const server = fakeServer({ mode: MODE_EXPO, serverPid: 31336 });
    let tunnelAtStart: unknown = 'not observed';

    await runSupervisor({
      root,
      port: 8090,
      tunnel: true,
      isExpo: () => true,
      attachSignals: false,
      onExit: () => {},
      startExpo: async () => {
        tunnelAtStart = readWorkspaceState(root)?.metroTunnel;
        return server.handle;
      },
    });

    expect(tunnelAtStart).toBe(undefined);
  });

  test('detects the ecosystem and hosts Expo as a child', async () => {
    const server = fakeServer({ mode: MODE_EXPO, serverPid: 31337 });
    let bareCalled = false;
    const running = await runSupervisor({
      root,
      port: 8092,
      isExpo: () => true,
      attachSignals: false,
      onExit: () => {},
      startBare: async () => {
        bareCalled = true;
        return server.handle;
      },
      startExpo: async () => server.handle,
    });
    assert(running);
    expect(bareCalled).toBe(false);
    expect(running.mode).toBe(MODE_EXPO);
    const state = readWorkspaceState(root);
    assert(state);
    assert(state.supervisor);
    expect(state.supervisor.serverPid).toBe(31337);
    expect(state.supervisor.mode).toBe(MODE_EXPO);
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

  test.each([
    ['SIGTERM', 143],
    ['SIGINT', 130],
  ] as const)(
    'a %s while the bare server hangs in startup exits at once and clears the records',
    async (signal, code) => {
      const before = { SIGTERM: process.listeners('SIGTERM'), SIGINT: process.listeners('SIGINT') };
      const exits: number[] = [];
      void runSupervisor({
        root,
        port: 8100,
        isExpo: () => false,
        onExit: (exitCode) => exits.push(exitCode),
        startBare: () => new Promise(() => {}),
      });
      try {
        const added = process.listeners(signal).filter((listener) => !before[signal].includes(listener));
        expect(added).toHaveLength(1);
        added[0]?.(signal);
        expect(exits).toEqual([code]);
        expect(existsSync(supervisorPidFile(root))).toBe(false);
        expect(readWorkspaceState(root)).toBe(null);
        expect(getProject(root)?.supervisor).toBe(undefined);
        expect(readMetroLog().at(-1)?.event).toBe('supervisor_stopped');
      } finally {
        for (const name of ['SIGTERM', 'SIGINT'] as const) {
          for (const listener of process.listeners(name)) {
            if (!before[name].includes(listener)) process.off(name, listener);
          }
        }
      }
    },
  );

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
      expect(readWorkspaceState(root)).toBe(null);
      expect(readMetroLog().some((record) => record.event === 'server_started')).toBe(false);
    } finally {
      for (const name of ['SIGTERM', 'SIGINT'] as const) {
        for (const listener of process.listeners(name)) {
          if (!before[name].includes(listener)) process.off(name, listener);
        }
      }
    }
  });

  test('a SIGTERM once the Expo child is up closes it before the supervisor exits', async () => {
    const before = { SIGTERM: process.listeners('SIGTERM'), SIGINT: process.listeners('SIGINT') };
    const server = fakeServer({ mode: MODE_EXPO, serverPid: 31339 });
    const exits: number[] = [];
    await runSupervisor({
      root,
      port: 8101,
      isExpo: () => true,
      onExit: (code) => exits.push(code),
      startExpo: async () => server.handle,
    });
    try {
      const added = process.listeners('SIGTERM').filter((listener) => !before.SIGTERM.includes(listener));
      expect(added).toHaveLength(1);
      added[0]?.('SIGTERM');
      await vi.waitFor(() => expect(exits).toEqual([0]));
      expect(server.state.closed).toBe(1);
      expect(readWorkspaceState(root)).toBe(null);
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

  test('the bare path is never asked to tunnel -- there is no dev server to hand a flag to', async () => {
    const server = fakeServer();
    let bareSawTunnel: unknown = 'not called';
    await runSupervisor({
      root,
      port: 8098,
      tunnel: true,
      isExpo: () => false,
      attachSignals: false,
      onExit: () => {},
      startBare: async (opts) => {
        bareSawTunnel = opts.tunnel;
        return server.handle;
      },
    });
    expect(bareSawTunnel).toBe(true);
  });

  test('SIGTERM-shaped shutdown closes the server, writes a final record and clears every registration', async () => {
    upsertProject(root, { bundleId: undefined, androidPackage: undefined, isExpo: false });
    const server = fakeServer();
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
    await running.shutdown(0, 'supervisor_stopped', 'received SIGTERM; stopping the dev server');

    expect(server.state.closed).toBe(1);
    expect(exits).toEqual([0]);
    expect(existsSync(supervisorPidFile(root))).toBe(false);
    expect(readWorkspaceState(root)).toBe(null);
    expect(getProject(root)?.supervisor).toBe(undefined);
    expect(getProject(root)).toBeTruthy();

    const records = readMetroLog();
    const first = records.at(0);
    assert(first);
    const last = records.at(-1);
    assert(last);
    expect(first.event).toBe('supervisor_started');
    expect(last.event).toBe('supervisor_stopped');
    expect(last.level).toBe('info');
    expect(last.src).toBe('metro');
  });

  test('a second shutdown is a no-op: the server is closed once', async () => {
    const server = fakeServer();
    const exits: number[] = [];
    const running = await runSupervisor({
      root,
      port: 8094,
      isExpo: () => false,
      attachSignals: false,
      onExit: (code) => exits.push(code),
      startBare: async () => server.handle,
    });
    assert(running);
    await running.shutdown(0, 'supervisor_stopped', 'first');
    await running.shutdown(0, 'supervisor_stopped', 'second');
    expect(server.state.closed).toBe(1);
    expect(exits).toEqual([0]);
  });

  test('a dev server that dies on its own takes the supervisor with it, exit 1', async () => {
    const server = fakeServer();
    const exits: number[] = [];
    await runSupervisor({
      root,
      port: 8095,
      isExpo: () => false,
      attachSignals: false,
      onExit: (code) => exits.push(code),
      startBare: async () => server.handle,
    });

    expect(server.state.listeners.length).toBe(1);
    server.state.listeners[0]?.({ code: 3, signal: null });
    await new Promise((r) => setTimeout(r, 10));

    expect(exits).toEqual([1]);
    expect(existsSync(supervisorPidFile(root))).toBe(false);
    expect(getProject(root)?.supervisor).toBe(undefined);
    const last = readMetroLog().at(-1);
    assert(last);
    expect(last.event).toBe('supervisor_stopped');
    expect(last.level).toBe('error');
    expect(last.msg).toMatch(/exited unexpectedly \(exit code 3\)/);
  });

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
    vi.useRealTimers();
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

  test('stops the dev server after metro.idleStopMinutes with no activity and records why', async () => {
    const seen = await startIdleSupervisor({ probe: quiet });
    await vi.advanceTimersByTimeAsync(59 * MINUTE);
    expect(seen.closed).toBe(0);

    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(seen.closed).toBe(1);
    expect(seen.exits).toEqual([0]);
    const state = readWorkspaceState(root);
    expect(readIdleStop(state)).toEqual({ reason: 'idle', at: expect.any(String), idleMinutes: 60 });
    expect(state?.supervisor).toBeUndefined();
    const stopped = readMetroLog().find((record) => record.event === 'supervisor_idle_stopped');
    expect(stopped?.msg).toMatch(/no bundle request, client log or Stim command for 60 minutes/);
  });

  test('a bundle request, an Expo client log line, a Stim command and a client log write each restart the clock', async () => {
    const seen = await startIdleSupervisor();
    await vi.advanceTimersByTimeAsync(50 * MINUTE);
    seen.writer?.write({ src: 'metro', event: 'bundle_response_started', platform: 'ios', requestId: 'r1' });
    seen.writer?.write({ src: 'metro', event: 'bundle_response_finished', platform: 'ios', requestId: 'r1' });
    await vi.advanceTimersByTimeAsync(50 * MINUTE);
    seen.writer?.write({ src: 'metro', event: 'expo_stdout', msg: ' LOG  hello', raw: true });
    await vi.advanceTimersByTimeAsync(50 * MINUTE);
    recordWorkspaceUse(root);
    await vi.advanceTimersByTimeAsync(50 * MINUTE);
    const clientLog = join(workspaceLogsDir(root), 'client.ndjson');
    writeFileSync(clientLog, '{}\n');
    const at = new Date(Date.now());
    utimesSync(clientLog, at, at);
    await vi.advanceTimersByTimeAsync(59 * MINUTE);
    expect(seen.closed).toBe(0);

    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    expect(seen.closed).toBe(1);
    expect(readIdleStop(readWorkspaceState(root))?.idleMinutes).toBe(60);
  });

  test('keeps an idle dev server while a blocker holds and stops it at the first check after', async () => {
    let blocker: string | null = 'a build is in progress';
    const seen = await startIdleSupervisor({ probe: { lastActivityAt: () => NaN, blocker: () => blocker } });
    await vi.advanceTimersByTimeAsync(180 * MINUTE);
    expect(seen.closed).toBe(0);

    blocker = null;
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(seen.closed).toBe(1);
    expect(readIdleStop(readWorkspaceState(root))?.idleMinutes).toBe(181);
  });

  test('a stop that is already closing the server is not recorded as an idle stop', async () => {
    let finishClose = () => {};
    const seen = await startIdleSupervisor({
      probe: quiet,
      close: () => new Promise<void>((resolve) => (finishClose = resolve)),
    });
    await vi.advanceTimersByTimeAsync(59 * MINUTE);
    const stopped = seen.running.shutdown(0, 'supervisor_stopped', 'received SIGTERM');
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    finishClose();
    await stopped;
    expect(seen.closed).toBe(1);
    expect(readIdleStop(readWorkspaceState(root))).toBe(null);
  });

  test('a stim start holding the metro-start lock defers the idle stop until it releases', async () => {
    const seen = await startIdleSupervisor({ probe: quiet });
    let release = () => {};
    const held = withWorkspaceProcessLock(
      dirname(workspaceLogsDir(root)),
      'metro-start',
      () => new Promise<void>((resolve) => (release = resolve)),
      { external: true },
    );
    await vi.advanceTimersByTimeAsync(90 * MINUTE);
    expect(seen.closed).toBe(0);

    release();
    await held;
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(seen.closed).toBe(1);
  });

  test('a probe that throws keeps the dev server running', async () => {
    const seen = await startIdleSupervisor({
      probe: {
        lastActivityAt: () => NaN,
        blocker: () => {
          throw new Error('adb did not answer');
        },
      },
    });
    await vi.advanceTimersByTimeAsync(180 * MINUTE);
    expect(seen.closed).toBe(0);
  });

  test('metro.idleStopMinutes 0 never stops the dev server', async () => {
    const seen = await startIdleSupervisor({ probe: quiet, minutes: 0 });
    await vi.advanceTimersByTimeAsync(24 * 60 * MINUTE);
    expect(seen.closed).toBe(0);
  });

  test('the workspace probe blocks during a build and while a workspace device is driven', () => {
    useProbeHost({ ps: '' });
    const probe = workspaceIdleProbe(root);
    expect(probe.blocker()).toBe(null);

    const attempt = tryAcquireClaim({
      root: join(tmpHome, 'native-run.lock'),
      mode: 'exclusive',
      label: 'native-run lock',
    });
    assert(attempt.acquired);
    startBuildProgress({ root, platform: 'ios', slot: 'default', claim: attempt.acquired });
    expect(probe.blocker()).toBe('a build is in progress');
    releaseClaim(attempt.acquired);
    expect(probe.blocker()).toBe(null);

    upsertProject(root, { platforms: { ios: { deviceUdid: 'STIM-IDLE-TEST-UDID', owned: true } } });
    expect(probe.blocker()).toBe(null);
    takeLease({ root, platform: 'ios', id: 'STIM-IDLE-TEST-UDID', kind: 'declared' });
    expect(probe.blocker()).toMatch(/^ios device STIM-IDLE-TEST-UDID is leased by stim device lock until /);
  });

  test('a physical device this workspace locks blocks the stop until the lease expires', () => {
    useProbeHost({ ps: '' });
    const probe = workspaceIdleProbe(root);
    takeLease({ root, platform: 'android', id: 'PHYSICAL-SERIAL', kind: 'declared', durationMs: 30 * MINUTE });
    expect(probe.blocker()).toMatch(/^android device PHYSICAL-SERIAL is leased by stim device lock until /);

    vi.setSystemTime(Date.now() + 30 * MINUTE);
    expect(probe.blocker()).toBe(null);
  });

  test('on Windows, where ps does not exist, only the missing host driver probe is ignored', () => {
    upsertProject(root, { platforms: { android: { serial: 'emulator-5554', owned: true } } });
    const adb = useProbeHost({ ps: null, adb: '  PID ARGS\n  1 init\n' });
    expect(workspaceIdleProbe(root, { platform: 'darwin' }).blocker()).toBe(
      'android device emulator-5554 has unknown activity (driver-process)',
    );
    expect(workspaceIdleProbe(root, { platform: 'win32' }).blocker()).toBe(null);

    adb.output = null;
    expect(workspaceIdleProbe(root, { platform: 'win32' }).blocker()).toBe(
      'android device emulator-5554 has unknown activity (instrumentation)',
    );
  });

  test('a Stim command recorded while the idle check runs keeps the dev server', async () => {
    const workspace = workspaceIdleProbe(root);
    let checks = 0;
    const seen = await startIdleSupervisor({
      probe: {
        lastActivityAt: () => workspace.lastActivityAt(),
        blocker: () => {
          if (++checks === 1) recordWorkspaceUse(root);
          return null;
        },
      },
    });
    await vi.advanceTimersByTimeAsync(60 * MINUTE);
    expect(checks).toBeGreaterThan(0);
    expect(seen.closed).toBe(0);

    await vi.advanceTimersByTimeAsync(60 * MINUTE);
    expect(seen.closed).toBe(1);
  });

  test('a stim ios or android run that takes native-run while the idle check runs keeps the dev server', async () => {
    let run: ClaimHandle | null = null;
    const seen = await startIdleSupervisor({
      probe: {
        lastActivityAt: () => NaN,
        blocker: () => {
          if (!run) {
            const attempt = tryAcquireClaim({
              root: workspaceProcessLockPath(dirname(workspaceLogsDir(root)), 'native-run', true),
              mode: 'exclusive',
              label: 'native-run lock',
            });
            assert(attempt.acquired);
            run = attempt.acquired;
          }
          return null;
        },
      },
    });
    await vi.advanceTimersByTimeAsync(90 * MINUTE);
    expect(run).not.toBe(null);
    expect(seen.closed).toBe(0);

    releaseClaim(run!);
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(seen.closed).toBe(1);
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

  test('a new supervisor clears the previous idle stop', async () => {
    writeWorkspaceState(root, { devServerStop: { reason: 'idle', at: new Date().toISOString(), idleMinutes: 60 } });
    await startIdleSupervisor({ probe: quiet });
    expect(readIdleStop(readWorkspaceState(root))).toBe(null);
  });
});
