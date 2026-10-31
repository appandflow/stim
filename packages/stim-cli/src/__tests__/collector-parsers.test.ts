import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { levelForEvent, logStreamArgs, parseLogStreamLine } from '../collector/ios.ts';
import { androidClockOffset, waitForAppPid, watchAppPid, parseLogcatLine } from '../collector/android.ts';
import { deviceConsoleArgs, parseDeviceConsoleLine, CONSOLE_ENV } from '../collector/ios-device.ts';
import { LEVELS, SOURCES } from '../ndjson.ts';
import { makeChildProcess, makeExecutor } from './_factories.ts';

function isNotNull<T>(value: T | null): value is T {
  return value !== null;
}

function fixture(name: string) {
  return readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf-8');
}

describe('ios: log stream ndjson', () => {
  const lines = fixture('ios-log-stream.ndjson').split(/\r?\n/).filter(Boolean);

  test('the real capture yields Contract-1 records for the log events only', () => {
    const records = lines.map((l) => parseLogStreamLine(l)).filter(isNotNull);
    expect(lines.length).toBe(5);
    expect(records.length).toBe(3);
    for (const record of records) {
      assert(record.src);
      assert(record.level);
      expect(record.src).toBe('device');
      expect(SOURCES.includes(record.src)).toBeTruthy();
      expect(LEVELS.includes(record.level)).toBeTruthy();
      expect(typeof record.msg).toBe('string');
      expect(Number.isFinite(record.ts)).toBeTruthy();
    }
  });

  test('logStreamArgs anchors to CFBundleExecutable when it differs from the .app basename', () => {
    const args = logStreamArgs('U1', 'MyAppDev', 'MyApp');
    expect(args[args.indexOf('--predicate') + 1]).toBe('processImagePath ENDSWITH "/MyAppDev.app/MyApp"');
  });
});

describe('ios: the physical-device console', () => {
  const at = () => 1788271500000;

  test('blank lines and non-strings are not records', () => {
    expect(parseDeviceConsoleLine('')).toBe(null);
    expect(parseDeviceConsoleLine('   ')).toBe(null);
    expect(parseDeviceConsoleLine(null as unknown as string)).toBe(null);
    expect(parseDeviceConsoleLine('2026-09-01 10:03:46.971266-0400 App[1:2] ', { now: at })).toBe(null);
  });

  test('deviceConsoleArgs is the exact argv, and it turns the os_log mirror on', () => {
    expect(deviceConsoleArgs({ udid: 'U1', bundleId: 'com.example.app' })).toEqual([
      'devicectl',
      'device',
      'process',
      'launch',
      '--quiet',
      '--device',
      'U1',
      '--console',
      '--terminate-existing',
      '--environment-variables',
      '{"OS_ACTIVITY_DT_MODE":"enable"}',
      'com.example.app',
    ]);
    expect(CONSOLE_ENV['OS_ACTIVITY_DT_MODE']).toBe('enable');
  });

  test('a dev-client deep link travels as --payload-url, before the bundle id', () => {
    const args = deviceConsoleArgs({ udid: 'U1', bundleId: 'com.example.app', payloadUrl: 'stim://x?url=y' });
    expect(args.slice(-8, -5)).toEqual(['--payload-url', 'stim://x?url=y', 'com.example.app']);
  });
});

describe('ios: demoting device noise', () => {
  const app =
    '/Users/x/Library/Developer/CoreSimulator/Devices/U/data/Containers/Bundle/Application/ABC/MyApp.app/MyApp';
  const focusCacheMessage =
    'RCTScrollViewComponentView implements focusItemsInRect: - caching for linear focus movement is limited as long as this view is on screen.';
  const event = (over: Record<string, unknown>): Record<string, unknown> => ({
    eventType: 'logEvent',
    messageType: 'Error',
    subsystem: '',
    category: '',
    processImagePath: app,
    timestamp: '2026-08-24 16:03:54.196749-0400',
    ...over,
  });

  test('the focus-cache rule requires the exact UIKit focus event', () => {
    const nearMisses = [
      event({ subsystem: 'com.apple.UIKit.child', category: 'UIFocus', eventMessage: focusCacheMessage }),
      event({ subsystem: 'com.apple.UIKit', category: 'default', eventMessage: focusCacheMessage }),
      event({ subsystem: 'com.apple.UIKit', category: 'UIFocus', eventMessage: `${focusCacheMessage} Extra` }),
    ];
    for (const nearMiss of nearMisses) {
      expect(levelForEvent(nearMiss)).toBe('error');
    }
  });

  test('a subsystem rule matches dotted children, not lookalike names', () => {
    expect(levelForEvent(event({ subsystem: 'com.apple.network.tcp' }))).toBe('info');
    expect(
      levelForEvent(event({ subsystem: 'com.apple.networkextension', eventMessage: 'provider failed to start' })),
    ).toBe('error');
  });
});

describe('android: logcat -v time', () => {
  test('the clock sample and the pid reads use the async executor with their adb argument lists', async () => {
    const asyncCalls: string[][] = [];
    const exec = makeExecutor({
      runFile: () => {
        throw new Error('a synchronous adb read blocks the log stream');
      },
      runFileQuiet: () => {
        throw new Error('a synchronous adb read blocks the log stream');
      },
      runFileAsync: async (_file, args) => {
        asyncCalls.push(args);
        return args.includes('date') ? String(Date.now()) : '3132\n';
      },
    });
    expect(await androidClockOffset('serial', { exec })).not.toBeNull();
    expect(await waitForAppPid({ serial: 'serial', packageName: 'com.x', exec })).toEqual({ ok: true, pid: 3132 });
    const watcher = watchAppPid({ serial: 'serial', packageName: 'com.x', pid: 3132, exec, onChange: () => {} });
    try {
      expect(await watcher.probe()).toBe(3132);
    } finally {
      watcher.stop();
    }
    expect(asyncCalls).toEqual([
      ['-s', 'serial', 'shell', 'date', '+%s%3N'],
      ['-s', 'serial', 'shell', 'pidof', '-s', 'com.x'],
      ['-s', 'serial', 'shell', 'pidof', '-s', 'com.x'],
    ]);
  });

  test('an adb read still in flight when the collector stops is killed instead of orphaned', async () => {
    const killed: Array<NodeJS.Signals | number | undefined> = [];
    const child = makeChildProcess({
      kill: (signal?: NodeJS.Signals | number) => {
        killed.push(signal);
        return true;
      },
    });
    const exec = makeExecutor({
      runFileAsync: (_file, _args, options) => {
        options.onSpawn?.(child);
        return new Promise<string>(() => {});
      },
    });
    const stopping = new AbortController();
    void androidClockOffset('serial', { exec, signal: stopping.signal });
    void waitForAppPid({ serial: 'serial', packageName: 'com.x', exec, signal: stopping.signal });
    expect(killed).toEqual([]);
    stopping.abort();
    expect(killed).toEqual(['SIGKILL', 'SIGKILL']);
  });

  test('epoch logcat keeps device time and shifts timestamps without reviving buffered records', () => {
    const launch = 1788902585000;
    const line = '         1788902582.542 I/ReactNativeJS( 1247): [stim:readiness] pending';
    const current = parseLogcatLine(line, { clockOffsetMs: 2739, now: () => launch });
    expect(current).toMatchObject({
      ts: 1788902585281,
      deviceTs: 1788902582542,
      clockOffsetMs: 2739,
      proc: 'ReactNativeJS(1247)',
      msg: '[stim:readiness] pending',
      level: 'info',
    });
    expect(current!.ts! > launch).toBe(true);
    const old = parseLogcatLine(line.replace('2582.542', '2570.542'), { clockOffsetMs: 2739, now: () => launch });
    expect(old!.ts! < launch).toBe(true);
    expect(parseLogcatLine(line, { clockOffsetMs: -2739 })!.ts).toBe(1788902579803);
    expect(parseLogcatLine(line)).toMatchObject({ ts: 1788902582542, deviceTs: 1788902582542 });
    expect(parseLogcatLine(line)).not.toHaveProperty('clockOffsetMs');
    expect(parseLogcatLine(line.replace('.542', '.542987'))!.ts).toBe(1788902582542);
  });
});

describe('watchAppPid', () => {
  function driver() {
    const queue: Array<() => void> = [];
    return {
      setTimer: (fn: () => void): ReturnType<typeof setTimeout> => {
        queue.push(fn);
        const handle = setTimeout(() => {}, 0);
        clearTimeout(handle);
        return handle;
      },
      clearTimer: () => {
        queue.length = 0;
      },
      async tick() {
        const fn = queue.shift();
        if (fn) await fn();
      },
      get pending() {
        return queue.length;
      },
    };
  }

  test('the app being GONE is not a restart -- the pid that comes back is', async () => {
    const d = driver();
    const seen: number[] = [];
    let answer: number | null = null;
    const w = watchAppPid({
      serial: 'emulator-5554',
      packageName: 'com.x',
      pid: 3132,
      intervalMs: 1,
      resolve: () => answer,
      onChange: (pid) => {
        seen.push(pid);
      },
      setTimer: d.setTimer,
      clearTimer: d.clearTimer,
    });
    await d.tick();
    expect(seen).toEqual([]);
    answer = 4200;
    await d.tick();
    expect(seen).toEqual([4200]);
    w.stop();
  });

  test('an adb that throws is a missed poll, not a dead watcher', async () => {
    const d = driver();
    const seen: number[] = [];
    let throwing = true;
    const w = watchAppPid({
      serial: 'emulator-5554',
      packageName: 'com.x',
      pid: 3132,
      intervalMs: 1,
      resolve: () => {
        if (throwing) throw new Error('device offline');
        return 4200;
      },
      onChange: (pid) => {
        seen.push(pid);
      },
      setTimer: d.setTimer,
      clearTimer: d.clearTimer,
    });
    await d.tick();
    expect(seen).toEqual([]);
    expect(d.pending).toBe(1);
    throwing = false;
    await d.tick();
    expect(seen).toEqual([4200]);
    w.stop();
    expect(d.pending).toBe(0);
  });
});
