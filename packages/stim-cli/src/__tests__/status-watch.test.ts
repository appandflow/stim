import assert from 'node:assert';
import { type ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  type WatchOptions,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentSessionsCacheFile } from '@stim-cli/core/state';
import { saveConfig } from '../workspace/config.ts';
import { makeConfig, makeEnvironmentState } from './_factories.ts';

import { resetExecutor, setExecutor } from '../exec.ts';
import {
  createRefreshScheduler,
  gitChange,
  statusChange,
  watchChangeKey,
  watchPayload,
  watchStatusSources,
  type RefreshKind,
} from '../status-watch.ts';
import type {
  MachineOwner,
  MaintenancePass,
  MaintenanceStatus,
  StatusPayload,
  WorktreeFacts,
} from '@stim-cli/core/state';

const watchListeners = vi.hoisted(() => new Map<string, (event: string, name: string | null) => void>());
const nativeEvents = vi.hoisted(() => ({ enabled: false, generation: 0, ignorePath: '' }));

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return {
    ...fs,
    watch: (
      path: string,
      options: WatchOptions | ((event: string, name: string | null) => void),
      callback?: (event: string, name: string | null) => void,
    ) => {
      const listener = typeof options === 'function' ? options : callback;
      assert(listener);
      const generation = nativeEvents.generation;
      const file = fs.statSync(path).isFile();
      const watcher = fs.watch(path, (event, name) => {
        if (
          nativeEvents.enabled &&
          path !== nativeEvents.ignorePath &&
          (!file || generation === nativeEvents.generation)
        )
          listener(event, name === null ? null : String(name));
      });
      watchListeners.set(path, listener);
      watcher.once('close', () => {
        if (watchListeners.get(path) === listener) watchListeners.delete(path);
      });
      return watcher;
    },
  };
});

describe('createRefreshScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('triggers during a run cause exactly one more run, never an overlapping one', async () => {
    let runs = 0;
    let active = 0;
    let maxActive = 0;
    let release: (() => void) | null = null;
    const scheduler = createRefreshScheduler({
      debounceMs: 250,
      run: async () => {
        runs++;
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise<void>((resolve) => (release = resolve));
        active--;
      },
    });
    scheduler.trigger('full', 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(runs).toBe(1);
    scheduler.trigger();
    scheduler.trigger();
    await vi.advanceTimersByTimeAsync(1000);
    expect(runs).toBe(1);
    release!();
    await vi.advanceTimersByTimeAsync(250);
    expect(runs).toBe(2);
    release!();
    await vi.advanceTimersByTimeAsync(1000);
    expect(runs).toBe(2);
    expect(maxActive).toBe(1);
    scheduler.stop();
  });

  test('a log trigger runs promptly after quiet, then at most once per interval, and a full trigger overrides it', async () => {
    const runs: RefreshKind[] = [];
    const scheduler = createRefreshScheduler({
      debounceMs: 250,
      lightIntervalMs: 15_000,
      run: async (kind) => void runs.push(kind),
    });
    scheduler.trigger('light');
    await vi.advanceTimersByTimeAsync(250);
    expect(runs).toEqual(['light']);

    for (let i = 0; i < 20; i++) {
      scheduler.trigger('light');
      await vi.advanceTimersByTimeAsync(500);
    }
    expect(runs).toEqual(['light']);
    await vi.advanceTimersByTimeAsync(5000);
    expect(runs).toEqual(['light', 'light']);

    scheduler.trigger('light');
    await vi.advanceTimersByTimeAsync(1000);
    scheduler.trigger('full');
    await vi.advanceTimersByTimeAsync(250);
    expect(runs).toEqual(['light', 'light', 'full']);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(runs).toEqual(['light', 'light', 'full']);
    scheduler.stop();
  });
});

test('a log append or build detail needs only a log refresh; other state changes need a full one, and locks none', () => {
  expect(statusChange('home', 'config.json')).toBe('full');
  expect(statusChange('home', 'build-cache')).toBe(null);
  expect(statusChange('home', 'maintenance')).toBe('light');
  expect(statusChange('maintenance', 'state.json')).toBe('light');
  expect(statusChange('maintenance', 'state.json.123.tmp')).toBe(null);
  expect(statusChange('maintenance', 'run.claims')).toBe(null);
  expect(statusChange('maintenance', 'child.log')).toBe(null);
  expect(statusChange('workspace', 'state.json')).toBe('full');
  expect(statusChange('workspace', 'logs')).toBe('full');
  expect(statusChange('workspace', 'ended-agents.json')).toBe('full');
  expect(statusChange('workspace', 'build-detail.json')).toBe('light');
  expect(statusChange('workspace', 'derived-data')).toBe(null);
  expect(statusChange('workspace', 'state.lock')).toBe(null);
  expect(statusChange('logs', 'device.ndjson')).toBe('light');
  expect(statusChange('logs', null)).toBe('light');
  expect(statusChange('logs', 'device.ndjson.lock.claims')).toBe(null);
  expect(statusChange('leases', null)).toBe('full');
  expect(statusChange('eas', 'sessions.json')).toBe('full');
  expect(statusChange('eas', 'ledger.lock')).toBe(null);
});

test('a HEAD, index or ref change in a repository or a linked worktree refreshes status; objects, logs and locks do not', () => {
  for (const name of ['HEAD', 'index', 'packed-refs', 'FETCH_HEAD', 'refs/heads/feature/x', 'worktrees/wt-1/HEAD'])
    expect(gitChange(name)).toBe(true);
  expect(gitChange('worktrees/wt-1/index')).toBe(true);
  expect(gitChange('worktrees/wt-1')).toBe(true);
  expect(gitChange(null)).toBe(true);
  for (const name of ['objects/ab/cdef', 'logs/HEAD', 'index.lock', 'refs/heads/main.lock', 'worktrees/wt-1/logs/HEAD'])
    expect(gitChange(name)).toBe(false);
});

describe('watchPayload', () => {
  const owner = (overrides: Partial<MachineOwner> = {}): MachineOwner => ({
    kind: 'simulator',
    name: 'sim',
    workspace: '/w/a',
    id: 'UDID',
    owned: true,
    cpuPercent: 10,
    residentMb: 500,
    memoryMb: 300,
    processes: 6,
    ...overrides,
  });
  const payload = (overrides: Partial<StatusPayload> = {}): StatusPayload => ({
    environments: [makeEnvironmentState({ path: '/w/a', memoryMb: 300 })],
    capacity: { liveCount: 1, committedMb: 300, totalMemoryMb: 16384, overCapacity: false },
    deviceLeases: [],
    unprovisionedWorktrees: [],
    simctlAvailable: true,
    machine: { memorySource: 'footprint', owners: [owner()] },
    ...overrides,
  });

  test('load is held until it moves a whole step from the last printed value or its state changes', () => {
    const at = (loadPerCore: number, state: 'free' | 'busy' = 'busy') =>
      payload({ capacity: { ...payload().capacity, load: { cpus: 14, loadPerCore, busyAt: 2, limit: null, state } } });
    const first = watchPayload(null, at(17.6));
    const held = watchPayload(first, at(18.5));
    const moved = watchPayload(held, at(18.6));
    expect([first, held, moved].map((p) => p.capacity.load?.loadPerCore)).toEqual([17.6, 17.6, 18.6]);
    expect(JSON.stringify(held)).toBe(JSON.stringify(first));
    expect(watchPayload(watchPayload(null, at(2.3)), at(3.3)).capacity.load?.loadPerCore).toBe(3.3);
    expect(watchPayload(watchPayload(null, at(2.1)), at(1.9, 'free')).capacity.load?.state).toBe('free');
  });
});

describe('watchChangeKey', () => {
  const pr = (checkedAt: string, state: 'open' | 'merged' = 'open'): WorktreeFacts['pullRequest'] => ({
    number: 7,
    url: 'https://github.com/o/r/pull/7',
    title: 'T',
    state,
    checks: null,
    reviewDecision: null,
    checkedAt,
  });
  const passAt = (at: number): MaintenancePass => ({
    startedAt: at,
    durationMs: at % 100,
    trigger: 'status-watch',
    mode: 'on',
    freedBytes: 0,
    actions: 0,
    stopped: 0,
    blocked: [],
  });
  const maintenance = (at: number, overrides: Partial<MaintenanceStatus> = {}): MaintenanceStatus => ({
    mode: 'on',
    lastChecks: { pressure: at, size: at, worktree: at, sweep: at },
    pressure: null,
    sizes: [],
    lastPass: passAt(at),
    running: null,
    recent: [],
    plan: [],
    ...overrides,
  });
  const payload = (
    at: number,
    state: 'open' | 'merged' = 'open',
    extra: Partial<StatusPayload> = {},
  ): StatusPayload => ({
    environments: [
      makeEnvironmentState({
        path: '/w/a',
        worktree: { path: '/w/a', pullRequest: pr(`2026-10-10T00:00:${at}Z`, state) },
      }),
    ],
    capacity: { liveCount: 0, committedMb: 0, totalMemoryMb: 16384, overCapacity: false },
    deviceLeases: [],
    unprovisionedWorktrees: [{ path: '/w/b', pullRequest: pr(`2026-10-10T00:00:${at}Z`) }],
    simctlAvailable: true,
    machine: null,
    maintenance: maintenance(at),
    ...extra,
  });

  test('the key is not the printed payload: masking leaves the payload untouched', () => {
    const value = payload(10);
    watchChangeKey(value);
    expect(value.unprovisionedWorktrees[0]?.pullRequest?.checkedAt).toBe('2026-10-10T00:00:10Z');
  });
});

test('CoreSimulator device set writes report a simulator change at once; the slow poll shares its listing until then', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  const home = mkdtempSync(join(tmpdir(), 'stim-watch-sims-'));
  vi.stubEnv('STIM_HOME', home);
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  const developer = join(home, 'Developer');
  const deviceSet = join(developer, 'CoreSimulator', 'Devices');
  const udid = '3A2178C2-DB3D-4B23-876E-4BC6BFD5AE32';
  mkdirSync(developer);
  const listing = (state: string) =>
    JSON.stringify({
      devices: {
        'com.apple.CoreSimulator.SimRuntime.iOS-27-0': [
          { udid, name: 'stim-a', state, isAvailable: true, deviceTypeIdentifier: 'iPhone' },
        ],
      },
    });
  let output = listing('Shutdown');
  let reads = 0;
  setExecutor({
    findExecutable: () => null,
    spawn(file: string) {
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), kill: () => true });
      if (file !== 'xcrun') return child;
      reads++;
      child.stdout.write(output);
      setTimeout(() => child.emit('close', 0), 10);
      return child;
    },
  });
  const changes: string[] = [];
  const sources = watchStatusSources({ home, deviceSet, onChange: (kind) => changes.push(kind), platform: 'darwin' });
  try {
    await vi.advanceTimersByTimeAsync(20);
    expect([reads, sources.simulatorListing()]).toEqual([1, listing('Shutdown')]);

    mkdirSync(join(developer, 'CoreSimulator'));
    watchListeners.get(developer)?.('rename', 'CoreSimulator');
    expect(changes).toEqual([]);
    mkdirSync(join(deviceSet, udid), { recursive: true });
    watchListeners.get(join(developer, 'CoreSimulator'))?.('rename', 'Devices');
    expect(changes).toEqual(['full']);

    await vi.advanceTimersByTimeAsync(20);
    output = listing('Booted');
    watchListeners.get(join(deviceSet, udid))?.('rename', 'data');
    expect(changes).toHaveLength(2);
    for (let i = 0; i < 5; i++) watchListeners.get(join(deviceSet, udid))?.('rename', 'device.plist');
    expect(sources.simulatorListing()).toBe(null);

    await vi.advanceTimersByTimeAsync(30);
    expect([reads, changes.length, sources.simulatorListing()]).toEqual([4, 8, listing('Booted')]);
    await vi.advanceTimersByTimeAsync(29_000);
    expect(reads).toBe(4);
    await vi.advanceTimersByTimeAsync(1_100);
    expect([reads, changes.length, sources.simulatorListing()]).toEqual([5, 8, listing('Booted')]);

    writeFileSync(join(home, 'config.json'), '{}');
    watchListeners.get(home)?.('change', 'config.json');
    expect(sources.simulatorListing()).toBe(null);

    output = 'not json';
    await vi.advanceTimersByTimeAsync(61_000);
    expect(sources.simulatorListing()).toBe(null);
  } finally {
    sources.stop();
    resetExecutor();
    vi.useRealTimers();
    rmSync(home, { recursive: true, force: true });
    vi.unstubAllEnvs();
  }
});

test.skipIf(process.platform !== 'darwin').each(['replacement and recreation', 'missed event repair'])(
  'native simulator metadata supports %s',
  async (scenario) => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const home = mkdtempSync(join(tmpdir(), 'stim-watch-plist-'));
    vi.stubEnv('STIM_HOME', home);
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    const deviceSet = join(home, 'Devices');
    const udid = '3A2178C2-DB3D-4B23-876E-4BC6BFD5AE32';
    const plist = join(deviceSet, udid, 'device.plist');
    mkdirSync(join(deviceSet, udid), { recursive: true });
    writeFileSync(plist, 'Shutdown');
    setExecutor({
      findExecutable: () => null,
      spawn(file: string) {
        const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), kill: () => true });
        if (file !== 'xcrun') return child;
        let devices: { udid: string; name: string; state: string; isAvailable: boolean }[] = [];
        try {
          devices = [{ udid, name: 'stim-a', state: readFileSync(plist, 'utf8'), isAvailable: true }];
        } catch {}
        child.stdout.write(JSON.stringify({ devices: { runtime: devices } }));
        queueMicrotask(() => child.emit('close', 0));
        return child;
      },
    });
    nativeEvents.enabled = true;
    const sources = watchStatusSources({
      home,
      deviceSet,
      onChange: () => {},
      platform: 'darwin',
      simctlIntervalMs: 500,
    });
    const observed = async (state: string | undefined) => {
      await vi.waitFor(
        () => {
          const listing = sources.simulatorListing();
          assert(listing);
          assert.equal(JSON.parse(listing).devices.runtime[0]?.state, state);
        },
        { timeout: 5000 },
      );
    };
    try {
      await observed('Shutdown');
      if (scenario === 'replacement and recreation') {
        for (const state of ['Booted', 'Shutdown']) {
          writeFileSync(`${plist}.next`, state);
          renameSync(`${plist}.next`, plist);
          await observed(state);
        }
        unlinkSync(plist);
        await observed(undefined);
        writeFileSync(plist, 'Shutdown');
        await observed('Shutdown');
      } else {
        nativeEvents.enabled = false;
        nativeEvents.ignorePath = deviceSet;
        nativeEvents.generation++;
        writeFileSync(`${plist}.next`, 'Booted');
        renameSync(`${plist}.next`, plist);
        await vi.advanceTimersByTimeAsync(500);
        nativeEvents.enabled = true;
        await observed('Booted');
        vi.clearAllTimers();
        await vi.waitFor(
          () => {
            writeFileSync(plist, 'Shutdown');
            const listing = sources.simulatorListing();
            assert(listing);
            assert.equal(JSON.parse(listing).devices.runtime[0]?.state, 'Shutdown');
          },
          { timeout: 2000 },
        );
      }
    } finally {
      sources.stop();
      nativeEvents.enabled = false;
      nativeEvents.ignorePath = '';
      vi.useRealTimers();
      resetExecutor();
      rmSync(home, { recursive: true, force: true });
      vi.unstubAllEnvs();
    }
  },
);

test('macOS workspace events refresh state and flat logs but ignore generated trees', () => {
  const home = mkdtempSync(join(tmpdir(), 'stim-watch-workspaces-'));
  vi.stubEnv('STIM_HOME', home);
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  vi.stubEnv('ANDROID_HOME', join(home, 'sdk'));
  const workspaces = join(home, 'workspaces');
  mkdirSync(join(workspaces, 'app', 'logs'), { recursive: true });
  setExecutor({ findExecutable: () => null });
  const changes: RefreshKind[] = [];
  const sources = watchStatusSources({
    home,
    deviceSet: null,
    platform: 'darwin',
    onChange: (kind) => changes.push(kind),
  });
  try {
    const changed = watchListeners.get(workspaces);
    assert(changed);
    for (const name of ['app', 'app/state.json', 'new/ended-agents.json', 'app/logs']) changed('rename', name);
    for (const name of ['app/build-detail.json', 'app/logs/metro.ndjson']) changed('change', name);
    expect(changes).toEqual(['full', 'full', 'full', 'full', 'light', 'light']);
    changes.length = 0;
    for (const name of [
      'app/build/outputs/state.json',
      'app/web/Default/History',
      'app/logs/nested/state.json',
      'app/state.lock',
      'app/logs/metro.ndjson.lock.claims',
    ])
      changed('change', name);
    expect(changes).toEqual([]);
    changed('change', null);
    expect(changes).toEqual(['full']);
  } finally {
    sources.stop();
    resetExecutor();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  }
});

describe('stim status --watch --json', () => {
  let root: string;
  let child: ChildProcess | null = null;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'stim-watch-'));
    process.env.STIM_HOME = join(root, 'home');
    mkdirSync(process.env.STIM_HOME);
  });

  afterEach(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child!.once('exit', resolve));
      child.kill('SIGTERM');
      await exited;
    }
    child = null;
    rmSync(root, { recursive: true, force: true });
    delete process.env.STIM_HOME;
  });

  const cli = join(import.meta.dirname, '..', '..', 'bin', 'cli.ts');

  function watchEnv() {
    return {
      STIM_HOME: process.env.STIM_HOME,
      ANDROID_HOME: join(root, 'sdk'),
      PATH: join(root, 'bin'),
      HOME: root,
      USERPROFILE: root,
    };
  }

  /** An adb whose `track-devices` records its pid and stays up; the pid file's path. */
  function adbShim(silent = false): string {
    const androidHome = join(root, 'sdk');
    mkdirSync(join(androidHome, 'platform-tools'), { recursive: true });
    const adb = join(androidHome, 'platform-tools', 'adb');
    const adbPid = join(root, 'adb.pid');
    writeFileSync(
      adb,
      `#!/bin/sh\nif [ "$1" = track-devices ]; then echo $$ > '${adbPid}'; ${silent ? '' : 'printf 0000;'} exec /bin/sleep 600; fi\n`,
    );
    chmodSync(adb, 0o755);
    return adbPid;
  }

  function startWatch(controlledWatch = false) {
    if (controlledWatch) {
      writeFileSync(agentSessionsCacheFile(), JSON.stringify({ discoveredAt: new Date().toISOString(), sessions: [] }));
    }
    const adbPid = adbShim(controlledWatch);
    const preload = new URL('./_status-watch-preload.mjs', import.meta.url).href;
    const args = [...(controlledWatch ? ['--import', preload] : []), cli, 'status', '--watch', '--json'];
    const proc = spawn(process.execPath, args, {
      cwd: root,
      env: watchEnv(),
      stdio: controlledWatch ? ['ignore', 'pipe', 'ignore', 'ipc'] : ['ignore', 'pipe', 'ignore'],
    });
    child = proc;
    const lines: string[] = [];
    let buffered = '';
    proc.stdout!.on('data', (chunk: Buffer) => {
      buffered += chunk.toString();
      const parts = buffered.split('\n');
      buffered = parts.pop() ?? '';
      lines.push(...parts);
    });
    const exited = new Promise<number | null>((resolve) => proc.on('exit', (code) => resolve(code)));
    return { proc, lines, exited, adbPid };
  }

  async function until(check: () => boolean, ms = 10_000) {
    const deadline = Date.now() + ms;
    while (!check()) {
      if (Date.now() > deadline) throw new Error('timed out');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  describe.skipIf(process.platform !== 'darwin')('machine usage on the light interval', () => {
    async function machineWatch(cpuExpr: string) {
      const udid = 'AAAAAAAA-0000-4000-8000-000000000001';
      saveConfig(
        makeConfig({
          projects: {
            [join(root, 'app')]: { label: 'watched', platforms: { ios: { deviceUdid: udid, owned: true } } },
          },
        }),
      );
      const bin = join(root, 'bin');
      mkdirSync(bin);
      const list = JSON.stringify({
        devices: {
          'com.apple.CoreSimulator.SimRuntime.iOS-26-5': [
            { udid, name: 'stim-watched', state: 'Booted', isAvailable: true, deviceTypeIdentifier: 'iphone-17' },
          ],
        },
      });
      writeFileSync(join(bin, 'xcrun'), `#!/bin/sh\nprintf '%s' '${list}'\n`);
      const count = join(root, 'ps.count');
      const moved = join(root, 'cpu.moved');
      writeFileSync(
        join(bin, 'ps'),
        [
          '#!/bin/sh',
          `[ -f '${moved}' ] && up=1 || up=0`,
          `n=0; [ -f '${count}' ] && read n < '${count}'; n=$((n + 1)); echo $n > '${count}'`,
          `echo "100 1 1024 ${cpuExpr}.0 Sat Sep 26 15:33:49 2026 launchd_sim /Users/me/Library/Developer/CoreSimulator/Devices/${udid}/data/var/run/launchd_bootstrap.plist"`,
        ].join('\n'),
      );
      chmodSync(join(bin, 'xcrun'), 0o755);
      chmodSync(join(bin, 'ps'), 0o755);
      const { lines } = startWatch();
      await until(() => lines.length > 0);
      return {
        lines,
        cpu: (line: string) => JSON.parse(line).machine.owners[0].cpuPercent as number,
        reads: () => Number(readFileSync(count, 'utf-8')),
        moveCpu: () => writeFileSync(moved, ''),
      };
    }

    test('a CPU move past a step prints a new line without any state change; skipped off macOS, where no simulator runs', async () => {
      const { lines, cpu, reads, moveCpu } = await machineWatch('$((up ? 20 : 10))');
      const before = cpu(last(lines));
      await until(() => reads() >= 2, 30_000);
      moveCpu();
      await until(() => cpu(last(lines)) > before, 25_000);
      expect(cpu(last(lines))).toBe(20);
    }, 40_000);

    test('CPU jitter below a step prints no line even though the process table is read again', async () => {
      const { lines, cpu, reads } = await machineWatch('$((50 + n % 2))');
      const before = cpu(last(lines));
      const seen = lines.length;
      await until(() => reads() > 2, 30_000);
      await new Promise((resolve) => setTimeout(resolve, 1000));
      expect(lines).toHaveLength(seen);
      expect(cpu(last(lines))).toBe(before);
    }, 40_000);
  });

  function last(lines: string[]): string {
    const line = lines.at(-1);
    assert(line !== undefined);
    return line;
  }
});
