import assert from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn as spawnChild, type SpawnOptions } from 'node:child_process';
import {
  daemonClaimRoot,
  daemonHandoverClaimRoot,
  daemonNdjsonFile,
  daemonSocket,
  maintenanceNdjsonFile,
  readDaemonSnapshot,
  readMaintenanceState,
} from '@stim-cli/core/state';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import { readClaimSet, releaseClaim, tryAcquireClaim } from '../ownership-claim.ts';
import { acquireBuildSlot, releaseBuildSlot, tryAcquireBuildSlot } from '../engine/build-slots.ts';
import { liveWaiters, takeWaitTicket } from '../engine/wait-queue.ts';
import { askDaemon, beforeCommand, ensureDaemon, passPlacement, requestDaemonTick } from '../daemon/client.ts';
import { reclaimForBootWaiters } from '../daemon/reclaim.ts';
import { recordCreatedDevice } from '../devices/created-devices.ts';
import * as gcDevices from '../commands/gc/devices.ts';
import * as measure from '../daemon/measure.ts';
import { HOME_PASSES_TEST_GUARD_ENV } from '../daemon/passes-guard-env.ts';
import { runHomePasses } from '../daemon/passes.ts';
import { macosDir } from '../macos/state.ts';
import { runDaemon } from '../daemon/run.ts';
import * as maintenanceMeasure from '../maintenance/measure.ts';
import * as maintenanceRun from '../maintenance/run.ts';
import * as spawnEntry from '../spawn-entry.ts';
import * as ndjson from '../ndjson.ts';
import { loadConfig, saveConfig, upsertProject } from '../workspace/config.ts';
import { ensureWorkspaceStorage } from '../workspace/paths.ts';
import { recordWorkspaceUse } from '../workspace/workspace-state.ts';

const entry = fileURLToPath(new URL('../daemon/run.ts', import.meta.url));
let home: string;
interface SpawnedDaemon {
  child: ReturnType<ReturnType<typeof getExecutor>['spawn']>;
  exited: Promise<number | null>;
}
let daemons: SpawnedDaemon[] = [];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-test-'));
  process.env.STIM_HOME = home;
});

afterEach(async () => {
  for (const daemon of daemons) daemon.child.kill('SIGTERM');
  await Promise.all(daemons.map((daemon) => daemon.exited));
  daemons = [];
  rmSync(home, { recursive: true, force: true });
  delete process.env.STIM_HOME;
});

/**
 * A stand-in for a stim-daemon from before handovers: it answers `hello` with no build, closes on an unknown op,
 * answers a tick when the pass after the request ends, and runs passes back to back, as with other runs asking for
 * ticks. Like that daemon, SIGTERM releases its claim at once and the process exits only after the pass in progress.
 * It appends `listening`, `sigterm` per signal, and `exit <ms>` to the file named by its first argument.
 */
const LEGACY_DAEMON = `
import { appendFileSync, mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { daemonClaimRoot, daemonDir, daemonSocket } from '@stim-cli/core/state';
import { releaseClaim, tryAcquireClaim } from '@stim-cli/core/ownership-claim';
const record = process.argv[1];
const note = (line) => appendFileSync(record, line + '\\n');
mkdirSync(daemonDir(), { recursive: true, mode: 0o700 });
const claim = tryAcquireClaim({ root: daemonClaimRoot(), mode: 'exclusive', label: 'stim-daemon' }).acquired;
let pending = [];
let closing = false;
const server = createServer((socket) => {
  socket.setEncoding('utf8');
  socket.on('error', () => {});
  socket.on('data', (chunk) => {
    for (const line of chunk.split('\\n').filter(Boolean)) {
      const { op } = JSON.parse(line);
      if (op === 'hello') socket.end(JSON.stringify({ op: 'hello', pid: process.pid }) + '\\n');
      else if (op === 'tick') pending.push(socket);
      else socket.destroy();
    }
  });
});
process.on('SIGTERM', () => {
  note('sigterm');
  if (closing) return;
  closing = true;
  server.close();
  rmSync(daemonSocket(), { force: true });
  releaseClaim(claim);
  for (const socket of pending) socket.destroy();
});
const pass = () => {
  const replying = pending;
  pending = [];
  setTimeout(() => {
    if (closing) {
      note('exit ' + Date.now());
      process.exit(0);
    }
    for (const socket of replying) socket.end(JSON.stringify({ op: 'ticked', level: 'normal' }) + '\\n');
    pass();
  }, 600);
};
server.listen(daemonSocket(), () => {
  note('listening');
  pass();
});
`;

function daemonLog(): string {
  return existsSync(daemonNdjsonFile()) ? readFileSync(daemonNdjsonFile(), 'utf8') : '';
}

function startDaemonProcess(): SpawnedDaemon {
  const child = getExecutor().spawn(process.execPath, [entry], { env: { ...process.env }, stdio: 'ignore' });
  const exited = new Promise<number | null>((done) => child.once('exit', (code) => done(code)));
  daemons.push({ child, exited });
  return { child, exited };
}

async function listening(): Promise<void> {
  await vi.waitFor(() => expect(daemonLog()).toContain('"event":"daemon_started"'), { timeout: 10_000, interval: 20 });
}

function lines(socket: Socket): string[] {
  const received: string[] = [];
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
      received.push(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
    }
  });
  return received;
}

async function waiter(resource: 'slot' | 'boot' = 'slot'): Promise<{ socket: Socket; received: string[] }> {
  const socket = connect(daemonSocket());
  onTestFinished(() => {
    socket.destroy();
  });
  const received = lines(socket);
  socket.write(`${JSON.stringify({ op: `${resource}.wait` })}\n`);
  await vi.waitFor(() => expect(received.join()).toContain(`"op":"${resource}.waiting"`), {
    timeout: 10_000,
    interval: 20,
  });
  return { socket, received };
}

function release(resource: 'slot' | 'boot' = 'slot'): void {
  const socket = connect(daemonSocket());
  socket.once('connect', () => socket.end(`${JSON.stringify({ op: `${resource}.released` })}\n`));
}

describe.skipIf(process.platform === 'win32')('the stim-daemon (skipped on win32, where Stim runs no daemon)', () => {
  test('one daemon per home: a second one exits and leaves the first one holding the claim and socket', async () => {
    const first = startDaemonProcess();
    await listening();
    const second = startDaemonProcess();
    expect(await second.exited).toBe(0);
    expect(daemonLog()).toContain('"event":"daemon_claim_held"');
    expect(readClaimSet(daemonClaimRoot()).live.map((holder) => holder.owner.pid)).toEqual([first.child.pid]);
    expect(existsSync(daemonSocket())).toBe(true);
  }, 20_000);

  test('a released build slot wakes the oldest waiter at once, and the next release the one after it', async () => {
    startDaemonProcess();
    await listening();
    const holder = tryAcquireBuildSlot({ max: 1 });
    assert(holder);
    const first = await waiter();
    const second = await waiter();
    expect(releaseBuildSlot(holder)).toBe(true);
    await vi.waitFor(() => expect(first.received.join()).toContain('"op":"slot.changed"'), {
      timeout: 10_000,
      interval: 20,
    });
    expect(second.received.join()).not.toContain('"op":"slot.changed"');
    first.socket.destroy();
    release();
    await vi.waitFor(() => expect(second.received.join()).toContain('"op":"slot.changed"'), {
      timeout: 10_000,
      interval: 20,
    });
  }, 20_000);

  test('a finished boot wakes the oldest boot waiter only, never a build waiter', async () => {
    startDaemonProcess();
    await listening();
    const build = await waiter('slot');
    const first = await waiter('boot');
    const second = await waiter('boot');
    release('boot');
    await vi.waitFor(() => expect(first.received.join()).toContain('"op":"boot.changed"'), {
      timeout: 10_000,
      interval: 20,
    });
    expect(second.received.join()).not.toContain('"op":"boot.changed"');
    expect(build.received.join()).not.toContain('changed');
    first.socket.destroy();
    release('boot');
    await vi.waitFor(() => expect(second.received.join()).toContain('"op":"boot.changed"'), {
      timeout: 10_000,
      interval: 20,
    });
  }, 20_000);

  test('a tick request is answered when a tick finishes, and the snapshot carries the pressure level', async () => {
    startDaemonProcess();
    await listening();
    await expect(requestDaemonTick({ STIM_DAEMON: 'on' })).resolves.toBe(true);
    expect(readDaemonSnapshot()).toMatchObject({
      pressure: { level: expect.stringMatching(/^(normal|high|critical)$/) },
      actions: expect.any(Array),
      waiting: [],
    });
  }, 20_000);

  test('exits after two ticks with nothing running in its home, releasing its claim and removing its socket', async () => {
    const measureTick = measure.measureTick;
    const normal = vi.spyOn(measure, 'measureTick').mockImplementation(async (...args) => {
      const measured = await measureTick(...args);
      return {
        ...measured,
        measurement: {
          ...measured.measurement,
          disk: [{ volume: '/', freeMb: 500_000 }],
          memory: { level: 'normal', availableBytes: 8 * 1024 ** 3, totalBytes: 16 * 1024 ** 3 },
        },
      };
    });
    onTestFinished(() => normal.mockRestore());
    await runDaemon({ tickMs: 50 });
    expect(readClaimSet(daemonClaimRoot()).live).toEqual([]);
    expect(existsSync(daemonSocket())).toBe(false);
    expect(daemonLog().match(/"event":"daemon_tick"/g)).toHaveLength(2);
    expect(readDaemonSnapshot()).toMatchObject({ mode: 'on', intervalMs: 250, workspaces: [] });
  }, 20_000);

  function normalMeasurement(level: 'normal' | 'warning' = 'normal'): void {
    const measureTick = measure.measureTick;
    const normal = vi.spyOn(measure, 'measureTick').mockImplementation(async (...args) => {
      const measured = await measureTick(...args);
      return {
        ...measured,
        measurement: {
          ...measured.measurement,
          disk: [{ volume: '/', freeMb: 500_000 }],
          memory: { level, availableBytes: 8 * 1024 ** 3, totalBytes: 16 * 1024 ** 3 },
        },
      };
    });
    onTestFinished(() => normal.mockRestore());
  }

  function firstTick(): { eventLoopDelay: { maxMs: number }; phases: { maintenanceMs: number } } | undefined {
    return daemonLog()
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .find((record) => record.event === 'daemon_tick');
  }

  test('a tick that blocks the event loop reports the stall in its daemon_tick record', async () => {
    normalMeasurement();
    const blocking = vi.spyOn(maintenanceRun, 'runMaintenance').mockImplementation(async () => {
      const until = Date.now() + 300;
      while (Date.now() < until);
    });
    onTestFinished(() => blocking.mockRestore());
    await runDaemon({ tickMs: 50 });
    expect(firstTick()?.eventLoopDelay.maxMs).toBeGreaterThanOrEqual(250);
    expect(firstTick()?.phases.maintenanceMs).toBeGreaterThanOrEqual(250);
  }, 20_000);

  test.skipIf(process.platform !== 'darwin')(
    "under memory pressure, the tick's maintenance pass names memory culprits from a slow top without blocking the event loop",
    async () => {
      normalMeasurement('warning');
      const real = getExecutor();
      const slowTop = ['-e', `setTimeout(() => process.stdout.write('PID MEM COMMAND\\n123 80G fseventsd\\n'), 600)`];
      setExecutor({
        ...real,
        runFileQuietAsync: (file, args, options) =>
          file === '/usr/bin/top'
            ? real.runFileQuietAsync(process.execPath, slowTop, options)
            : real.runFileQuietAsync(file, args, options),
      });
      process.env.STIM_DAEMON = 'report';
      onTestFinished(() => {
        resetExecutor();
        delete process.env.STIM_DAEMON;
      });
      await runDaemon({ tickMs: 50 });
      expect(readFileSync(maintenanceNdjsonFile(), 'utf8')).toContain('fseventsd (pid 123) uses 80.0G');
      expect(firstTick()?.phases.maintenanceMs).toBeGreaterThanOrEqual(600);
      expect(firstTick()?.eventLoopDelay.maxMs).toBeLessThan(500);
    },
    20_000,
  );

  let sims: { udid: string; name: string; state: 'Booted' | 'Shutdown' }[] = [];

  function toolOutput(file: string, args: readonly string[]): string {
    const name = file.split('/').at(-1);
    if (name === 'xcrun' && args.includes('list'))
      return JSON.stringify({
        devices: {
          'com.apple.CoreSimulator.SimRuntime.iOS-18-0': sims.map((sim) => ({
            ...sim,
            isAvailable: true,
            deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-16',
            dataPathSize: 1,
          })),
        },
      });
    if (name === 'xcrun' && args[1] === 'shutdown') {
      sims = sims.map((sim) => (sim.udid === args[2] ? { ...sim, state: 'Shutdown' } : sim));
      return '';
    }
    if (name === 'sysctl') return '1\n';
    if (name === 'adb' && args[0] === 'devices') return 'List of devices attached\nemulator-5554\tdevice\n';
    if (name === 'adb') return 'stim-other\nOK\n';
    if (name === 'vm_stat')
      return 'page size of 16384 bytes\nPages free: 1.\nPages inactive: 1.\nPages speculative: 1.\n';
    return '';
  }

  function asyncOnlyTools(): { sync: string[]; async: string[] } {
    sims = [{ udid: 'UDID-1', name: 'stim-app (iPhone 16 18.0)', state: 'Shutdown' }];
    const real = getExecutor();
    const calls: { sync: string[]; async: string[] } = { sync: [], async: [] };
    const refuse = (file: string, args: readonly string[] = []): never => {
      calls.sync.push([file, ...args].join(' '));
      throw new Error(`synchronous ${file} in a daemon tick`);
    };
    setExecutor({
      ...real,
      run: (command: string) => refuse(command),
      runQuiet: (command: string) => refuse(command),
      runFile: (file: string, args: string[]) => refuse(file, args),
      runFileQuiet: (file: string, args: string[]) => refuse(file, args),
      spawn: (file: string, args: readonly string[] = []) => refuse(file, args),
      runFileAsync: async (file: string, args: string[], options) => {
        calls.async.push([file, ...args].join(' '));
        return file === 'git' ? real.runFileAsync(file, args, options) : toolOutput(file, args);
      },
      runFileQuietAsync: async (file: string, args: string[], options) => {
        calls.async.push([file, ...args].join(' '));
        return file === 'git' ? real.runFileQuietAsync(file, args, options) : toolOutput(file, args);
      },
    });
    onTestFinished(() => resetExecutor());
    return calls;
  }

  function idleWorkspaces(): string[] {
    const git = (cwd: string, ...args: string[]) =>
      getExecutor().runFile('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, timeoutMs: 10_000 });
    const repo = join(home, 'repo');
    const linked = join(home, 'linked');
    mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'init');
    git(repo, 'worktree', 'add', '-q', '-b', 'feature', linked);
    for (const root of [repo, linked]) {
      writeFileSync(join(root, 'package.json'), '{"name":"app"}');
      ensureWorkspaceStorage(root);
      upsertProject(root, {
        platforms: { ios: { deviceUdid: 'UDID-1', owned: true }, android: { avdName: 'stim-app', owned: true } },
      });
      recordWorkspaceUse(root, new Date(Date.now() - 30 * 86_400_000));
    }
    return [repo, linked];
  }

  test('a tick with every maintenance check due, the dormant stage due and disk pressure high starts no child process synchronously', async () => {
    for (const root of idleWorkspaces()) {
      mkdirSync(macosDir(root), { recursive: true });
      mkdirSync(join(root, 'node_modules'));
    }
    const config = loadConfig();
    assert(config);
    saveConfig({ ...config, idle: { dormantDays: 0.000_001 } });
    process.env.STIM_DAEMON = 'on';
    process.env.STIM_DISK_MIN_FREE_GB = '100000000';
    onTestFinished(() => {
      delete process.env.STIM_DAEMON;
      delete process.env.STIM_DISK_MIN_FREE_GB;
    });
    vi.spyOn(maintenanceMeasure, 'sizeScanDeferred').mockReturnValue(false);
    vi.spyOn(gcDevices, 'deviceSweepIsScoped').mockReturnValue(false);
    onTestFinished(() => {
      vi.restoreAllMocks();
    });
    const calls = asyncOnlyTools();

    const passes = await runHomePasses({ act: true, trigger: 'daemon', log: () => {} });

    expect(passes.pressure.level).not.toBe('normal');
    expect(readMaintenanceState()?.lastPass?.trigger).toBe('daemon');
    expect(calls.sync).toEqual([]);
  }, 60_000);

  test.skipIf(process.platform !== 'darwin')(
    'a tick that idles a workspace with an owned booted simulator, then re-checks it for a waiting run, starts no child process synchronously',
    async () => {
      const root = join(home, 'booted');
      mkdirSync(root);
      writeFileSync(join(root, 'package.json'), '{"name":"app"}');
      ensureWorkspaceStorage(root);
      upsertProject(root, {
        platforms: {
          ios: { deviceUdid: 'UDID-B', owned: true },
          android: { avdName: 'stim-app', owned: true, consolePort: 5554 },
        },
      });
      recordCreatedDevice('ios', 'UDID-B');
      recordWorkspaceUse(root, new Date(Date.now() - 30 * 86_400_000));
      const waiting = join(home, 'waiting');
      mkdirSync(waiting);
      const ticket = takeWaitTicket('boot', { platform: 'ios', key: 'new', root: waiting, displayName: 'waiting' }, []);
      process.env.STIM_DAEMON = 'on';
      process.env.STIM_MAX_DEVICES = '1';
      onTestFinished(() => {
        releaseClaim(ticket);
        delete process.env.STIM_DAEMON;
        delete process.env.STIM_MAX_DEVICES;
      });
      vi.spyOn(gcDevices, 'deviceSweepIsScoped').mockReturnValue(false);
      onTestFinished(() => {
        vi.restoreAllMocks();
      });
      const calls = asyncOnlyTools();
      sims = [{ udid: 'UDID-B', name: 'stim-booted (iPhone 16 18.0)', state: 'Booted' }];

      const passes = await runHomePasses({ act: true, trigger: 'daemon', log: () => {} });
      const reclaimed = await reclaimForBootWaiters({
        devices: passes.measured.devices,
        sims: passes.measured.sims,
        act: true,
        log: () => {},
        operation: passes.operation,
      });

      expect(calls.sync).toEqual([]);
      expect(passes.workspaces).toEqual([expect.objectContaining({ path: root, outcome: 'idle' })]);
      expect(sims).toEqual([expect.objectContaining({ udid: 'UDID-B', state: 'Shutdown' })]);
      expect(reclaimed).toMatchObject({
        target: 'UDID-B',
        outcome: 'kept',
        detail: expect.stringContaining('no longer idle'),
      });
    },
    60_000,
  );

  test.skipIf(process.platform !== 'darwin')(
    "a tick's maintenance pass takes memory pressure and simulator sizes from the tick's measurement instead of reading them again",
    async () => {
      idleWorkspaces();
      process.env.STIM_DAEMON = 'on';
      onTestFinished(() => {
        delete process.env.STIM_DAEMON;
      });
      vi.spyOn(maintenanceMeasure, 'sizeScanDeferred').mockReturnValue(false);
      vi.spyOn(gcDevices, 'deviceSweepIsScoped').mockReturnValue(false);
      onTestFinished(() => {
        vi.restoreAllMocks();
      });
      const measureTick = measure.measureTick;
      vi.spyOn(measure, 'measureTick').mockImplementation(async (...args) => {
        const measured = await measureTick(...args);
        return {
          ...measured,
          sims: measured.sims?.map((sim) => ({ ...sim, dataPathSize: 4096 })) ?? null,
          measurement: {
            ...measured.measurement,
            memory: { level: 'warning', availableBytes: 8 * 1024 ** 3, totalBytes: 16 * 1024 ** 3 },
          },
        };
      });
      const calls = asyncOnlyTools();

      await runHomePasses({ act: false, trigger: 'daemon', log: () => {} });

      const state = readMaintenanceState();
      expect(state?.pressure?.memory.level).toBe('warning');
      expect(state?.sizes).toContainEqual(
        expect.objectContaining({
          category: 'owned-devices',
          name: 'owned simulator stim-app (iPhone 16 18.0)',
          bytes: 4096,
        }),
      );
      expect(calls.async.filter((call) => call.includes('kern.memorystatus_vm_pressure_level'))).toHaveLength(1);
    },
    60_000,
  );

  test('a tick that fails hands the timers back: the daemon releases its claim and exits instead of holding it idle', async () => {
    writeFileSync(join(home, 'config.json'), '{ not json');
    await runDaemon({ tickMs: 50 });
    expect(readClaimSet(daemonClaimRoot()).live).toEqual([]);
    expect(existsSync(daemonSocket())).toBe(false);
  }, 20_000);

  test('a command starts the daemon in the mode it resolved, with its locations, CI and non-sensitive setting overrides only', async () => {
    const spawned: { args: readonly string[]; options: SpawnOptions | undefined }[] = [];
    setExecutor({
      ...getExecutor(),
      spawn(_file, args = [], options) {
        spawned.push({ args, options });
        throw new Error('not started in this test');
      },
    });
    onTestFinished(() => resetExecutor());
    const kept = {
      PATH: '/usr/bin:/bin',
      CI: '1',
      STIM_HOME: home,
      STIM_DAEMON: 'report',
      STIM_DISK_MIN_FREE_GB: '12',
      STIM_MAINTENANCE_IDLE_STOP_HOURS: '2',
      AGENT_DEVICE_CLAIMS_DIR: '/claims',
      ANDROID_SDK_HOME: '/android',
      ANDROID_ADB_SERVER_PORT: '5038',
      GRADLE_USER_HOME: '/gradle',
      XDG_CONFIG_HOME: '/config',
      XDG_CACHE_HOME: '/cache',
    };
    const dropped = {
      API_TOKEN: 'secret',
      NODE_OPTIONS: '--inspect',
      GRADLE_ENTERPRISE_ACCESS_KEY: 'secret',
      GRADLE_OPTS: '-Dorg.gradle.project.signingPassword=secret',
      XDG_RUNTIME_DIR: '/run',
      STIM_ASC_KEY_PATH: '/keys/AuthKey.p8',
    };

    expect(await ensureDaemon({ ...kept, ...dropped })).toBe(false);

    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.args.slice(1)).toEqual(['--mode', 'report']);
    expect(spawned[0]?.options?.env).toEqual(kept);
  });

  test('a command counts the home as held only once the daemon it started takes the claim', async () => {
    const env = { ...process.env, STIM_HOME: home, STIM_DAEMON: 'on' };
    setExecutor({ ...getExecutor(), spawn: () => spawnChild(process.execPath, ['-e', ''], { stdio: 'ignore' }) });
    try {
      expect(await ensureDaemon(env)).toBe(false);
    } finally {
      resetExecutor();
    }

    expect(await ensureDaemon(env)).toBe(true);
    const [holder] = readClaimSet(daemonClaimRoot()).live;
    assert(holder);
    process.kill(holder.owner.pid, 'SIGTERM');
    await vi.waitFor(() => expect(readClaimSet(daemonClaimRoot()).live).toEqual([]), { timeout: 10_000, interval: 50 });
  }, 20_000);

  test('an installed build replaces only a daemon with no installed build or an older version, one at a time', async () => {
    const current = { installed: true, digest: 'digest-current', version: '1.40.0-next.20261103195518.g76cb4df' };
    const build = vi.spyOn(spawnEntry, 'stimBuild').mockReturnValue(current);
    const spawned: (readonly string[])[] = [];
    setExecutor({
      ...getExecutor(),
      spawn(_file, args = []) {
        spawned.push(args);
        return spawnChild(process.execPath, ['-e', ''], { stdio: 'ignore' });
      },
    });
    onTestFinished(() => {
      resetExecutor();
      build.mockRestore();
    });
    const env = { ...process.env, STIM_HOME: home, STIM_DAEMON: 'on' };
    const run = runDaemon({ tickMs: 60_000 });
    await listening();

    for (const other of [
      { ...current, digest: 'digest-other' },
      { installed: true, digest: 'digest-older', version: '1.40.0-next.20261102000000.gaaaaaaa' },
      { installed: false, digest: null, version: '1.40.0' },
    ]) {
      build.mockReturnValue(other);
      expect(await ensureDaemon(env)).toBe(true);
    }
    build.mockReturnValue({ installed: true, digest: 'digest-newer', version: '1.40.0-next.20261104000000.gbbbbbbb' });
    const taking = tryAcquireClaim({
      root: daemonHandoverClaimRoot(),
      mode: 'exclusive',
      label: 'stim-daemon handover',
    });
    assert(taking.acquired);
    expect(await ensureDaemon(env)).toBe(true);
    releaseClaim(taking.acquired);
    expect(spawned).toEqual([]);

    expect(await ensureDaemon(env)).toBe(true);
    expect(spawned.map((args) => args.slice(1))).toEqual([['--mode', 'on', '--replace', String(process.pid)]]);

    const idle = connect(daemonSocket());
    idle.on('error', () => {});
    const closed = new Promise<void>((done) => idle.once('close', () => done()));
    await new Promise<void>((done) => idle.once('connect', () => done()));
    idle.resume();
    expect(await askDaemon('handover', 1000, { pid: process.pid, build: 'digest-other' })).toEqual({
      op: 'handover',
      accepted: false,
    });
    expect(await askDaemon('handover', 1000, { pid: process.pid, build: 'digest-current' })).toEqual({
      op: 'handover',
      accepted: true,
    });
    await run;
    await closed;
    expect(daemonLog()).not.toContain('"event":"daemon_tick"');
    expect(readClaimSet(daemonClaimRoot()).live).toEqual([]);
  }, 20_000);

  test('a command arriving while a successor takes over starts no daemon and leaves the claim to the successor', async () => {
    const spawned: (readonly string[])[] = [];
    setExecutor({
      ...getExecutor(),
      spawn(_file, args = []) {
        spawned.push(args);
        return spawnChild(process.execPath, ['-e', ''], { stdio: 'ignore' });
      },
    });
    onTestFinished(() => resetExecutor());
    const taking = tryAcquireClaim({
      root: daemonHandoverClaimRoot(),
      mode: 'exclusive',
      label: 'stim-daemon handover',
    });
    assert(taking.acquired);
    onTestFinished(() => {
      releaseClaim(taking.acquired);
    });

    const command = ensureDaemon({ ...process.env, STIM_HOME: home, STIM_DAEMON: 'on' });
    await new Promise((done) => setTimeout(done, 300));
    const successor = runDaemon({ tickMs: 60_000 });
    expect(await command).toBe(true);
    expect(spawned).toEqual([]);
    expect(readClaimSet(daemonClaimRoot()).live.map((claim) => claim.owner.pid)).toEqual([process.pid]);

    await listening();
    expect(await askDaemon('handover', 1000, { pid: process.pid, build: null })).toEqual({
      op: 'handover',
      accepted: true,
    });
    await successor;
  }, 20_000);

  test('a dev-build daemon hands over to an installed build only after the tick in progress, and queued runs keep their places', async () => {
    normalMeasurement();
    let entered!: () => void;
    const inPass = new Promise<void>((done) => (entered = done));
    let finishPass!: () => void;
    const pass = new Promise<void>((done) => (finishPass = done));
    const blocked = vi.spyOn(maintenanceRun, 'runMaintenance').mockImplementation(async () => {
      entered();
      await pass;
    });
    const build = vi
      .spyOn(spawnEntry, 'stimBuild')
      .mockReturnValue({ installed: false, digest: null, version: '1.40.0' });
    onTestFinished(() => {
      blocked.mockRestore();
      build.mockRestore();
    });
    const run = runDaemon({ tickMs: 50 });
    await inPass;
    const holder = tryAcquireBuildSlot({ max: 1 });
    assert(holder);
    const acquired: string[] = [];
    const queue = (root: string) =>
      acquireBuildSlot({ max: 1, root }).then((slot) => {
        acquired.push(root);
        return slot;
      });
    const first = queue('/a');
    await vi.waitFor(() => expect(liveWaiters('build')).toHaveLength(1), { timeout: 10_000, interval: 20 });
    const second = queue('/b');
    await vi.waitFor(() => expect(liveWaiters('build')).toHaveLength(2), { timeout: 10_000, interval: 20 });

    build.mockReturnValue({ installed: true, digest: 'digest-installed', version: '1.39.0' });
    expect(await ensureDaemon({ ...process.env, STIM_HOME: home, STIM_DAEMON: 'on' })).toBe(true);
    await vi.waitFor(() => expect(daemonLog()).toContain('"event":"daemon_handover"'), {
      timeout: 10_000,
      interval: 20,
    });
    expect(readClaimSet(daemonClaimRoot()).live.map((claim) => claim.owner.pid)).toEqual([process.pid]);
    expect(daemonLog()).not.toContain('"event":"daemon_exited"');
    const ticked = requestDaemonTick({ ...process.env, STIM_DAEMON: 'on' });
    await new Promise((done) => setTimeout(done, 200));

    finishPass();
    await run;
    await vi.waitFor(
      () => expect(readClaimSet(daemonClaimRoot()).live.map((claim) => claim.owner.pid)).toEqual([expect.any(Number)]),
      { timeout: 10_000, interval: 50 },
    );
    const [successor] = readClaimSet(daemonClaimRoot()).live;
    assert(successor && successor.owner.pid !== process.pid);
    try {
      await vi.waitFor(() => expect(daemonLog().match(/"event":"daemon_started"/g)).toHaveLength(2), {
        timeout: 10_000,
        interval: 20,
      });
      const events = daemonLog()
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line).event)
        .filter((event) => ['daemon_started', 'daemon_handover', 'daemon_tick', 'daemon_exited'].includes(event));
      expect(events.slice(0, 5)).toEqual([
        'daemon_started',
        'daemon_handover',
        'daemon_tick',
        'daemon_exited',
        'daemon_started',
      ]);
      expect(await ticked).toBe(true);

      expect(liveWaiters('build').map((queued) => queued.details.root)).toEqual(['/a', '/b']);
      releaseBuildSlot(holder);
      const slot = await first;
      expect(acquired).toEqual(['/a']);
      releaseBuildSlot(slot);
      releaseBuildSlot(await second);
      expect(acquired).toEqual(['/a', '/b']);
    } finally {
      process.kill(successor.owner.pid, 'SIGTERM');
      await vi.waitFor(() => expect(() => process.kill(successor.owner.pid, 0)).toThrow('ESRCH'), {
        timeout: 30_000,
        interval: 50,
      });
    }
  }, 90_000);

  test('of many successors started at once against a daemon from before handovers, one signals it once and ticks only after it exits', async () => {
    const record = join(home, 'legacy.log');
    const legacy = spawnChild(process.execPath, ['--input-type=module', '-e', LEGACY_DAEMON, record], {
      cwd: fileURLToPath(new URL('../..', import.meta.url)),
      env: { ...process.env },
      stdio: 'ignore',
    });
    const legacyExited = new Promise<void>((done) => legacy.once('exit', () => done()));
    onTestFinished(async () => {
      legacy.kill('SIGKILL');
      await legacyExited;
    });
    await vi.waitFor(() => expect(readFileSync(record, 'utf8')).toContain('listening'), {
      timeout: 10_000,
      interval: 20,
    });
    assert(legacy.pid);
    const successors = Array.from({ length: 6 }, () => {
      const child = spawnChild(process.execPath, [entry, '--mode', 'on', '--replace', String(legacy.pid)], {
        env: { ...process.env },
        stdio: 'ignore',
      });
      return { child, exited: new Promise<void>((done) => child.once('exit', () => done())) };
    });
    onTestFinished(async () => {
      for (const { child } of successors) child.kill('SIGTERM');
      await Promise.all(successors.map(({ exited }) => exited));
    });

    await vi.waitFor(
      () => expect(readClaimSet(daemonClaimRoot()).live.map((claim) => claim.owner.pid)).not.toEqual([legacy.pid]),
      { timeout: 20_000, interval: 50 },
    );
    await vi.waitFor(() => expect(readClaimSet(daemonClaimRoot()).live).toHaveLength(1), {
      timeout: 20_000,
      interval: 50,
    });
    expect(await requestDaemonTick({ ...process.env, STIM_DAEMON: 'on' })).toBe(true);
    const [winner] = readClaimSet(daemonClaimRoot()).live;
    assert(winner);
    const losers = successors.filter(({ child }) => child.pid !== winner.owner.pid);
    expect(losers).toHaveLength(5);
    await Promise.race([
      Promise.all(losers.map(({ exited }) => exited)),
      new Promise((_, fail) => setTimeout(() => fail(new Error('a losing successor still runs')), 1000)),
    ]);

    await vi.waitFor(() => expect(daemonLog()).toContain('"event":"daemon_tick"'), { timeout: 10_000, interval: 20 });
    const noted = readFileSync(record, 'utf8').trim().split('\n');
    expect(noted.filter((line) => line === 'sigterm')).toHaveLength(1);
    const exitedAt = Number(noted.find((line) => line.startsWith('exit '))?.slice(5));
    const records = daemonLog()
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(records.filter((logged) => logged.event === 'daemon_handover')).toHaveLength(1);
    const successorTick = records.find((logged) => logged.event === 'daemon_tick');
    expect(successorTick?.ts).toBeGreaterThanOrEqual(exitedAt);
  }, 60_000);

  test('a daemon signalled right after its tick exits at once instead of sleeping through its wait', async () => {
    normalMeasurement();
    const before = new Set(process.listeners('SIGTERM'));
    const create = ndjson.createNdjsonWriter;
    let signal: (() => void) | null = null;
    const spy = vi.spyOn(ndjson, 'createNdjsonWriter').mockImplementation((...args) => {
      const writer = create(...args);
      return {
        ...writer,
        write(record: unknown) {
          const written = writer.write(record);
          if (typeof record === 'object' && record !== null && 'event' in record && record.event === 'daemon_tick')
            signal?.();
          return written;
        },
      };
    });
    onTestFinished(() => spy.mockRestore());
    const run = runDaemon({ tickMs: 60_000 });
    await listening();
    const handler = process.listeners('SIGTERM').find((listener) => !before.has(listener));
    assert(handler);
    signal = () => handler('SIGTERM');
    expect(await askDaemon('tick', 10_000)).toMatchObject({ op: 'ticked' });
    const started = Date.now();
    await run;
    expect(Date.now() - started).toBeLessThan(5000);
    expect(daemonLog()).toContain('exiting: SIGTERM');
  }, 90_000);

  test('a daemon started in report mode stays in report mode', async () => {
    await runDaemon({ tickMs: 50, mode: 'report' });
    expect(readDaemonSnapshot()).toMatchObject({ mode: 'report' });
  }, 20_000);

  test('daemon.mode turned off in config after the daemon started stops it on its next tick', async () => {
    const run = runDaemon({ tickMs: 1500, mode: 'on' });
    await listening();
    saveConfig({ version: 2, projects: {}, repos: {}, daemon: { mode: 'off' } });
    await run;
    expect(daemonLog()).toContain('exiting: daemon.mode is off');
    expect(daemonLog()).not.toContain('"event":"daemon_tick"');
  }, 20_000);
});

test('on win32 a command starts no daemon, whatever STIM_DAEMON says', async () => {
  const spawn = vi.fn<ReturnType<typeof getExecutor>['spawn']>(() => {
    throw new Error('not started in this test');
  });
  setExecutor({ ...getExecutor(), spawn });
  const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
  onTestFinished(() => {
    platform.mockRestore();
    resetExecutor();
  });

  expect(await ensureDaemon({ ...process.env, STIM_HOME: home, STIM_DAEMON: 'on' })).toBe(false);
  expect(spawn).not.toHaveBeenCalled();
});

test.skipIf(process.platform === 'win32')(
  'doctor, and start, ios and android with no daemon holding the home, run automatic maintenance in-process unless daemon.mode is off',
  async () => {
    const ran = vi.spyOn(maintenanceRun, 'runMaintenance').mockResolvedValue();
    setExecutor({
      ...getExecutor(),
      spawn() {
        throw new Error('no daemon starts in this test');
      },
    });
    onTestFinished(() => resetExecutor());
    const env: NodeJS.ProcessEnv = { ...process.env, STIM_DAEMON: 'on' };
    delete env[HOME_PASSES_TEST_GUARD_ENV];

    for (const name of ['start', 'ios', 'android', 'doctor', 'web', 'macos', 'revive', 'logs', 'status'])
      await beforeCommand(name, env);
    expect(ran.mock.calls).toEqual(['start', 'ios', 'android', 'doctor'].map((name) => [name, { report: false }]));

    ran.mockClear();
    for (const name of ['start', 'doctor']) await beforeCommand(name, { ...env, STIM_DAEMON: 'off' });
    expect(ran).not.toHaveBeenCalled();
    await beforeCommand('doctor', { ...env, [HOME_PASSES_TEST_GUARD_ENV]: '1' });
    const claim = tryAcquireClaim({ root: daemonClaimRoot(), mode: 'exclusive', label: 'stim-daemon' }).acquired;
    assert(claim);
    try {
      await beforeCommand('doctor', env);
      await beforeCommand('start', env);
    } finally {
      releaseClaim(claim);
    }
    expect(ran).not.toHaveBeenCalled();
  },
);

test('where no daemon runs, doctor, start, ios and android run the passes in process and other commands in a background child, never guide, settings, help, gc or agent-device', () => {
  const placements = (platform: NodeJS.Platform) =>
    Object.fromEntries(
      [
        'doctor',
        'start',
        'ios',
        'android',
        'web',
        'revive',
        'logs',
        'status',
        'reload',
        'stop',
        'guide',
        'settings',
        'help',
        'gc',
        'agent-device',
      ].map((name) => [name, passPlacement(name, platform)]),
    );
  const none = { guide: 'none', settings: 'none', help: 'none', gc: 'none', 'agent-device': 'none' };
  const inline = { doctor: 'inline', start: 'inline', ios: 'inline', android: 'inline' };

  expect(placements('win32')).toEqual({
    ...inline,
    ...none,
    web: 'background',
    revive: 'background',
    logs: 'background',
    status: 'background',
    reload: 'background',
    stop: 'background',
  });
  expect(placements('darwin')).toEqual({
    ...inline,
    ...none,
    web: 'none',
    revive: 'none',
    logs: 'none',
    status: 'none',
    reload: 'none',
    stop: 'none',
  });
});

describe('on win32, which has no daemon', () => {
  const spawned: { file: string; options: SpawnOptions }[] = [];
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    spawned.length = 0;
    setExecutor({
      ...getExecutor(),
      spawn(file, _args, options) {
        spawned.push({ file, options: options ?? {} });
        throw new Error('no child starts in this test');
      },
    });
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    onTestFinished(() => {
      platform.mockRestore();
      resetExecutor();
    });
    env = { ...process.env, STIM_DAEMON: 'on' };
    delete env[HOME_PASSES_TEST_GUARD_ENV];
  });

  test('doctor, start, ios and android run automatic maintenance before the command', async () => {
    const ran = vi.spyOn(maintenanceRun, 'runMaintenance').mockResolvedValue();

    for (const name of ['start', 'ios', 'android', 'doctor']) await beforeCommand(name, env);

    expect(ran.mock.calls).toEqual(['start', 'ios', 'android', 'doctor'].map((name) => [name, { report: false }]));
    expect(spawned).toEqual([]);
  });

  test('other commands start the passes in a detached child that prints nothing, at most once a minute', async () => {
    const ran = vi.spyOn(maintenanceRun, 'runMaintenance').mockResolvedValue();

    await beforeCommand('logs', env);
    await beforeCommand('status', env);

    expect(ran).not.toHaveBeenCalled();
    expect(spawned).toEqual([
      expect.objectContaining({
        options: expect.objectContaining({ detached: true, stdio: ['ignore', expect.any(Number), expect.any(Number)] }),
      }),
    ]);

    writeFileSync(join(home, 'daemon', 'command-passes.json'), `${JSON.stringify({ at: Date.now() - 61_000 })}\n`);
    await beforeCommand('reload', env);
    expect(spawned).toHaveLength(2);

    for (const unreadable of ['not json', JSON.stringify({ at: Date.now() + 3_600_000 })]) {
      writeFileSync(join(home, 'daemon', 'command-passes.json'), unreadable);
      await beforeCommand('web', env);
    }
    expect(spawned).toHaveLength(4);
  });

  test('guide, settings, help, gc and agent-device start nothing', async () => {
    const ran = vi.spyOn(maintenanceRun, 'runMaintenance').mockResolvedValue();

    for (const name of ['guide', 'settings', 'help', 'gc', 'agent-device']) await beforeCommand(name, env);

    expect(ran).not.toHaveBeenCalled();
    expect(spawned).toEqual([]);
  });

  test('daemon.mode off starts nothing', async () => {
    await beforeCommand('logs', { ...env, STIM_DAEMON: 'off' });
    expect(spawned).toEqual([]);
  });
});
