import { type ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveConfig } from '../workspace/config.ts';
import { makeConfig } from './_factories.ts';
import { ensureWorkspaceStorage, workspaceLogsDir } from '../workspace/paths.ts';
import { resetExecutor, setExecutor } from '../exec.ts';
import { createRefreshScheduler, statusChange, watchStatusSources, type RefreshKind } from '../status-watch.ts';

describe('createRefreshScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('a burst of triggers runs once after the debounce', async () => {
    let runs = 0;
    const scheduler = createRefreshScheduler({ debounceMs: 250, run: async () => void runs++ });
    for (let i = 0; i < 5; i++) {
      scheduler.trigger();
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(runs).toBe(0);
    await vi.advanceTimersByTimeAsync(250);
    expect(runs).toBe(1);
    scheduler.stop();
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

  test('a trigger during a run queues one more run: full at the debounce, log-only after the log interval', async () => {
    const runs: RefreshKind[] = [];
    let release: (() => void) | null = null;
    const scheduler = createRefreshScheduler({
      debounceMs: 250,
      logsIntervalMs: 15_000,
      run: async (kind) => {
        runs.push(kind);
        await new Promise<void>((resolve) => (release = resolve));
      },
    });
    scheduler.trigger('full', 0);
    await vi.advanceTimersByTimeAsync(0);
    scheduler.trigger('logs');
    scheduler.trigger('full');
    scheduler.trigger('logs');
    release!();
    await vi.advanceTimersByTimeAsync(250);
    expect(runs).toEqual(['full', 'full']);

    scheduler.trigger('logs');
    release!();
    await vi.advanceTimersByTimeAsync(14_000);
    expect(runs).toEqual(['full', 'full']);
    await vi.advanceTimersByTimeAsync(1000);
    expect(runs).toEqual(['full', 'full', 'logs']);
    release!();
    scheduler.stop();
  });

  test('a log trigger runs promptly after quiet, then at most once per interval, and a full trigger overrides it', async () => {
    const runs: RefreshKind[] = [];
    const scheduler = createRefreshScheduler({
      debounceMs: 250,
      logsIntervalMs: 15_000,
      run: async (kind) => void runs.push(kind),
    });
    scheduler.trigger('logs');
    await vi.advanceTimersByTimeAsync(250);
    expect(runs).toEqual(['logs']);

    for (let i = 0; i < 20; i++) {
      scheduler.trigger('logs');
      await vi.advanceTimersByTimeAsync(500);
    }
    expect(runs).toEqual(['logs']);
    await vi.advanceTimersByTimeAsync(5000);
    expect(runs).toEqual(['logs', 'logs']);

    scheduler.trigger('logs');
    await vi.advanceTimersByTimeAsync(1000);
    scheduler.trigger('full');
    await vi.advanceTimersByTimeAsync(250);
    expect(runs).toEqual(['logs', 'logs', 'full']);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(runs).toEqual(['logs', 'logs', 'full']);
    scheduler.stop();
  });
});

test('a log append needs only a log refresh; other state changes need a full one, and locks none', () => {
  expect(statusChange('home', 'config.json')).toBe('full');
  expect(statusChange('home', 'build-cache')).toBe(null);
  expect(statusChange('workspace', 'state.json')).toBe('full');
  expect(statusChange('workspace', 'logs')).toBe('full');
  expect(statusChange('workspace', 'derived-data')).toBe(null);
  expect(statusChange('workspace', 'state.lock')).toBe(null);
  expect(statusChange('logs', 'device.ndjson')).toBe('logs');
  expect(statusChange('logs', null)).toBe('logs');
  expect(statusChange('logs', 'device.ndjson.lock.claims')).toBe(null);
  expect(statusChange('leases', null)).toBe('full');
  expect(statusChange('eas', 'sessions.json')).toBe('full');
  expect(statusChange('eas', 'ledger.lock')).toBe(null);
});

test('the simulator poller shares its last readable listing until it ages out or Stim state changes', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'Date'] });
  const home = mkdtempSync(join(tmpdir(), 'stim-watch-sims-'));
  const listing = (state: string) =>
    JSON.stringify({
      devices: {
        'com.apple.CoreSimulator.SimRuntime.iOS-27-0': [
          { udid: 'U1', name: 'stim-a', state, isAvailable: true, deviceTypeIdentifier: 'iPhone' },
        ],
      },
    });
  let output = listing('Shutdown');
  setExecutor({
    findExecutable: () => null,
    spawn(file: string) {
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), kill: () => true });
      if (file !== 'xcrun') return child;
      setTimeout(() => {
        child.stdout.end(output);
        child.emit('close', 0);
      }, 10);
      return child;
    },
  });
  const sources = watchStatusSources({ home, onChange: () => {}, platform: 'darwin' });
  try {
    expect(sources.simulatorListing()).toBe(null);
    await vi.advanceTimersByTimeAsync(20);
    expect(sources.simulatorListing()).toBe(listing('Shutdown'));

    output = listing('Booted');
    await vi.advanceTimersByTimeAsync(5000);
    expect(sources.simulatorListing()).toBe(listing('Booted'));

    const deadline = performance.now() + 5000;
    while (sources.simulatorListing() !== null && performance.now() < deadline) {
      writeFileSync(join(home, 'config.json'), '{}');
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(sources.simulatorListing()).toBe(null);
    await vi.advanceTimersByTimeAsync(5000);
    expect(sources.simulatorListing()).toBe(listing('Booted'));

    output = 'not json';
    await vi.advanceTimersByTimeAsync(11_000);
    expect(sources.simulatorListing()).toBe(null);
  } finally {
    sources.stop();
    resetExecutor();
    vi.useRealTimers();
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

  function startWatch() {
    const androidHome = join(root, 'sdk');
    mkdirSync(join(androidHome, 'platform-tools'), { recursive: true });
    const adb = join(androidHome, 'platform-tools', 'adb');
    const adbPid = join(root, 'adb.pid');
    writeFileSync(
      adb,
      `#!/bin/sh\nif [ "$1" = track-devices ]; then echo $$ > '${adbPid}'; printf 0000; exec /bin/sleep 600; fi\n`,
    );
    chmodSync(adb, 0o755);
    const cli = join(import.meta.dirname, '..', '..', 'bin', 'cli.ts');
    const proc = spawn(process.execPath, [cli, 'status', '--watch', '--json'], {
      cwd: root,
      env: { STIM_HOME: process.env.STIM_HOME, ANDROID_HOME: androidHome, PATH: join(root, 'bin'), HOME: root },
      stdio: ['ignore', 'pipe', 'ignore'],
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

  function alive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  test('prints one line per change and suppresses identical payloads', async () => {
    const { lines } = startWatch();
    await until(() => lines.length === 1);
    expect(JSON.parse(lines[0]!).environments).toEqual([]);

    const config = makeConfig({ projects: { [join(root, 'app')]: { label: 'watched', platforms: {} } } });
    saveConfig(config);
    await until(() => lines.length === 2);
    expect(JSON.parse(lines[1]!).environments.map((env: { path: string }) => env.path)).toEqual([join(root, 'app')]);

    saveConfig(config);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(lines).toHaveLength(2);
  }, 30_000);

  test('a log append waits for the log interval, then refreshes the error count', async () => {
    const app = join(root, 'app');
    saveConfig(makeConfig({ projects: { [app]: { label: 'watched', platforms: {} } } }));
    ensureWorkspaceStorage(app);
    mkdirSync(workspaceLogsDir(app), { recursive: true });
    const log = join(workspaceLogsDir(app), 'metro.ndjson');
    const record = (ts: number, level: string) => `${JSON.stringify({ ts, src: 'metro', level, msg: 'm' })}\n`;
    writeFileSync(log, record(1, 'info'));
    const errors = (line: string) => JSON.parse(line).environments[0].logs.errorsSinceMarker;
    const { lines } = startWatch();
    await until(() => lines.length === 1);
    expect(errors(lines[0]!)).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 1000));

    appendFileSync(log, record(2, 'error'));
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(lines).toHaveLength(1);
    await until(() => lines.length === 2, 20_000);
    expect(errors(lines[1]!)).toBe(1);
  }, 40_000);

  test.skipIf(process.platform === 'win32')(
    'stops adb on SIGTERM; skipped on win32, which cannot run the sh adb shim or deliver SIGTERM to a handler',
    async () => {
      const { proc, exited, adbPid } = startWatch();
      await until(() => {
        try {
          return readFileSync(adbPid, 'utf-8').trim() !== '';
        } catch {
          return false;
        }
      });
      const tracker = Number(readFileSync(adbPid, 'utf-8'));
      expect(alive(tracker)).toBe(true);
      proc.kill('SIGTERM');
      expect(await exited).toBe(0);
      await until(() => !alive(tracker), 5000);
    },
    30_000,
  );

  test('exits when stdout closes', async () => {
    const { proc, lines, exited } = startWatch();
    await until(() => lines.length === 1);
    proc.stdout!.destroy();
    saveConfig(makeConfig({ projects: { [join(root, 'app')]: { label: 'watched', platforms: {} } } }));
    expect(await exited).toBe(0);
  }, 30_000);
});
