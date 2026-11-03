import assert from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn as spawnChild, type SpawnOptions } from 'node:child_process';
import { daemonClaimRoot, daemonNdjsonFile, daemonSocket, readDaemonSnapshot } from '@stim-cli/core/state';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import { readClaimSet, releaseClaim, tryAcquireClaim } from '../ownership-claim.ts';
import { releaseBuildSlot, tryAcquireBuildSlot } from '../engine/build-slots.ts';
import { beforeCommand, ensureDaemon, requestDaemonTick } from '../daemon/client.ts';
import * as measure from '../daemon/measure.ts';
import { HOME_PASSES_TEST_GUARD_ENV } from '../daemon/passes-guard-env.ts';
import { runDaemon } from '../daemon/run.ts';
import { daemonStatus } from '../daemon/status.ts';
import * as maintenanceRun from '../maintenance/run.ts';
import { saveConfig } from '../workspace/config.ts';

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
      STIM_MAINTENANCE: 'off',
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

test('win32 runs no daemon: a command starts none and status reports it off, whatever STIM_DAEMON says', async () => {
  const spawn = vi.fn<ReturnType<typeof getExecutor>['spawn']>(() => {
    throw new Error('not started in this test');
  });
  setExecutor({ ...getExecutor(), spawn });
  const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
  onTestFinished(() => {
    platform.mockRestore();
    resetExecutor();
  });
  const env = { ...process.env, STIM_HOME: home, STIM_DAEMON: 'on' };

  expect(await ensureDaemon(env)).toBe(false);
  expect(spawn).not.toHaveBeenCalled();
  expect(daemonStatus(env)).toMatchObject({ mode: 'off', running: null });
});

test('doctor, and start, ios and android with no daemon holding the home, run automatic maintenance in-process', async () => {
  const ran = vi.spyOn(maintenanceRun, 'runMaintenance').mockResolvedValue();
  const env: NodeJS.ProcessEnv = { ...process.env, STIM_DAEMON: 'off' };
  delete env[HOME_PASSES_TEST_GUARD_ENV];

  for (const name of ['start', 'ios', 'android', 'doctor', 'web', 'macos', 'revive', 'logs', 'status'])
    await beforeCommand(name, env);
  expect(ran.mock.calls).toEqual(['start', 'ios', 'android', 'doctor'].map((name) => [name, { report: false }]));

  ran.mockClear();
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
});
