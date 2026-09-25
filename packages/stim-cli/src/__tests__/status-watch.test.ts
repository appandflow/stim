import { type ChildProcess, spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveConfig } from '../workspace/config.ts';
import { makeConfig } from './_factories.ts';
import { changeAffectsStatus, createRefreshScheduler } from '../status-watch.ts';

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
    scheduler.trigger(0);
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
});

test('changes that cannot alter the status payload do not trigger a refresh', () => {
  expect(changeAffectsStatus('home', 'config.json')).toBe(true);
  expect(changeAffectsStatus('home', 'build-cache')).toBe(false);
  expect(changeAffectsStatus('workspace', 'state.json')).toBe(true);
  expect(changeAffectsStatus('workspace', 'derived-data')).toBe(false);
  expect(changeAffectsStatus('workspace', 'state.lock')).toBe(false);
  expect(changeAffectsStatus('logs', 'device.ndjson')).toBe(true);
  expect(changeAffectsStatus('logs', 'device.ndjson.lock.claims')).toBe(false);
  expect(changeAffectsStatus('leases', null)).toBe(true);
  expect(changeAffectsStatus('eas', 'sessions.json')).toBe(true);
  expect(changeAffectsStatus('eas', 'ledger.lock')).toBe(false);
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
