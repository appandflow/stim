import assert from 'node:assert';
import { type ChildProcess } from 'node:child_process';
import { realpathSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve as absolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseNdjsonText } from '../ndjson.ts';
import { workspaceLogsDir, workspaceStateFile } from '../workspace/paths.ts';
import { parseArgs, readCollectors, registerCollector, runCollector, unregisterCollector } from '../collector/run.ts';

import { makeChildProcess } from './_factories.ts';

fileURLToPath(new URL('../collector/run.ts', import.meta.url));

function childPid(child: ChildProcess): number {
  assert(child.pid !== undefined, 'spawned child has no pid');
  return child.pid;
}

let tmpHome: string;
let root: string;
let shimDir: string;
let running: ChildProcess[] = [];

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'stim-test-'));
  process.env.STIM_HOME = tmpHome;
  root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-ws-')));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'ws' }));
  shimDir = mkdtempSync(join(tmpdir(), 'stim-shim-'));
  running = [];
});

afterEach(() => {
  for (const child of running) {
    try {
      process.kill(childPid(child), 'SIGKILL');
    } catch {}
  }
  rmSync(tmpHome, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
  rmSync(shimDir, { recursive: true, force: true });
  delete process.env.STIM_HOME;
});

function deviceLog() {
  try {
    return parseNdjsonText(readFileSync(join(workspaceLogsDir(root), 'device.ndjson'), 'utf-8'));
  } catch {
    return [];
  }
}

function state() {
  try {
    return JSON.parse(readFileSync(workspaceStateFile(root), 'utf-8'));
  } catch {
    return null;
  }
}

async function until<T>(
  predicate: () => T | null | undefined,
  { timeoutMs = 6000, label = 'condition' } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('parseArgs', () => {
  const absRoot = absolute('/abs');

  test('accepts the ios invocation and derives the predicate app name from the bundle id', () => {
    expect(
      parseArgs(['--platform', 'ios', '--root', absRoot, '--udid', 'U1', '--bundle', 'com.example.MyApp']),
    ).toEqual({
      platform: 'ios',
      root: absRoot,
      udid: 'U1',
      bundleId: 'com.example.MyApp',
      appName: 'MyApp',
      appExecutable: null,
      serial: null,
      packageName: null,
      physical: false,
      payloadUrl: null,
    });
  });

  test('--physical is refused on android, and --payload-url without it', () => {
    expect(
      parseArgs(['--platform', 'android', '--root', '/abs', '--serial', 'S', '--package', 'com.x', '--physical']).error,
    ).toMatch(/--physical is an iOS option/);
    expect(
      parseArgs(['--platform', 'ios', '--root', '/abs', '--udid', 'U1', '--bundle', 'com.x', '--payload-url', 'u'])
        .error,
    ).toMatch(/--payload-url only applies to --physical/);
    expect(
      parseArgs(['--platform', 'ios', '--root', '/abs', '--udid', 'U1', '--bundle', 'com.x', '--payload-url']).error,
    ).toMatch(/--payload-url needs a URL/);
  });

  test('--app-executable carries CFBundleExecutable separately from the .app basename', () => {
    expect(
      parseArgs([
        '--platform',
        'ios',
        '--root',
        '/abs',
        '--udid',
        'U1',
        '--bundle',
        'com.example.app',
        '--app-name',
        'MyAppDev',
        '--app-executable',
        'MyApp',
      ]).appExecutable,
    ).toBe('MyApp');
  });

  test('refuses a missing or unknown platform, a relative root, and each missing per-platform argument', () => {
    expect(parseArgs([]).error).toMatch(/--platform/);
    expect(parseArgs(['--platform', 'web', '--root', '/abs']).error).toMatch(/--platform/);
    expect(parseArgs(['--platform', 'ios', '--root', 'rel']).error).toMatch(/absolute/);
    expect(parseArgs(['--platform', 'ios', '--root', '/abs']).error).toMatch(/--udid/);
    expect(parseArgs(['--platform', 'ios', '--root', '/abs', '--udid', 'U']).error).toMatch(/--bundle/);
    expect(parseArgs(['--platform', 'android', '--root', '/abs']).error).toMatch(/--serial/);
    expect(parseArgs(['--platform', 'android', '--root', '/abs', '--serial', 'S']).error).toMatch(/--package/);
  });
});

describe('Contract 5: the registration', () => {
  test('a stale unregister from a replaced collector does not clobber the newer registration', () => {
    // #182: a replaced collector (proven unverified) is left running instead of signalled, so
    // it can still reach its own finish() -> unregisterCollector after a newer collector has
    // registered over the same platform key. Its own pid must not match the current record.
    registerCollector(root, 'ios', { pid: 1, startedAt: 'a', processToken: 'token' });
    registerCollector(root, 'ios', { pid: 2, startedAt: 'b', processToken: 'token' });
    unregisterCollector(root, 'ios', 1, 'token');
    expect(readCollectors(root)).toEqual({ ios: { pid: 2, startedAt: 'b', processToken: 'token' } });
  });
});

describe('runCollector seams', () => {
  test('a stream that fails to start is an error record rather than a throw', async () => {
    let code = null;
    const result = await runCollector({
      platform: 'ios',
      root,
      udid: 'U1',
      appName: 'MyApp',
      startStream: () => {
        throw new Error('spawn xcrun ENOENT');
      },
      attachSignals: false,
      onExit: (c) => {
        code = c;
      },
    });
    expect(result).toBe(null);
    expect(code).toBe(1);
    const failed = deviceLog().find((r) => r.event === 'collector_failed');
    assert(failed);
    expect(failed.msg).toMatch(/ENOENT/);
  });
});

describe('runCollector reattach seams', () => {
  const fakeChild = (pid: number | null | undefined) => makeChildProcess({ pid: pid ?? undefined });

  test('a newer pid reported while a reattach reads the device clock replaces it instead of adding a stream', async () => {
    const started: ChildProcess[] = [];
    const pendingClocks: Array<() => void> = [];
    let samples = 0;
    let reportPid: ((pid: number) => void | Promise<void>) | undefined;
    const result = await runCollector({
      platform: 'android',
      root,
      serial: 'emulator-5554',
      packageName: 'com.example.app',
      resolvePid: async () => ({ ok: true, pid: 3132 }),
      resolveClockOffset: () =>
        ++samples === 1 ? 0 : new Promise<number>((resolve) => pendingClocks.push(() => resolve(0))),
      watchPid: ({ onChange }) => {
        reportPid = onChange;
        return { stop: () => {}, probe: async () => 4200, pid: 3132 };
      },
      startStream: ({ pid: streamPid }) => {
        const c = fakeChild(streamPid);
        started.push(c);
        return c;
      },
      attachSignals: false,
      onExit: () => {},
    });
    const firstStream = started[0];
    assert(firstStream);
    firstStream.emit('exit', 0, null);
    await until(() => pendingClocks.length === 1, { label: 'the reattach clock read' });
    assert(reportPid);
    void reportPid(4300);
    await until(() => pendingClocks.length === 2, { label: 'the second clock read' });
    for (const release of pendingClocks) release();
    await until(() => started.length === 2, { label: 'the reattached stream' });
    await new Promise((r) => setTimeout(r, 50));
    expect(started.map((c) => c.pid)).toEqual([3132, 4300]);
    assert(result);
    result.finish(0, 'info', 'done', 'collector_stopped');
  });

  test('finish aborts the adb reads the collector still has in flight', async () => {
    let readSignal: AbortSignal | undefined;
    let watchSignal: AbortSignal | undefined;
    const result = await runCollector({
      platform: 'android',
      root,
      serial: 'emulator-5554',
      packageName: 'com.example.app',
      resolvePid: async () => ({ ok: true, pid: 3132 }),
      resolveClockOffset: (_serial, { signal }) => {
        readSignal = signal;
        return null;
      },
      watchPid: ({ signal }) => {
        watchSignal = signal;
        return { stop: () => {}, probe: async () => 3132, pid: 3132 };
      },
      startStream: ({ pid: streamPid }) => fakeChild(streamPid),
      attachSignals: false,
      onExit: () => {},
    });
    assert(result);
    expect(readSignal?.aborted).toBe(false);
    expect(watchSignal).toBe(readSignal);
    result.finish(0, 'info', 'done', 'collector_stopped');
    expect(readSignal?.aborted).toBe(true);
  });

  test('a stream that ends with no app left is still the end of the collector', async () => {
    let code: number | null = null;
    const result = await runCollector({
      platform: 'android',
      root,
      serial: 'emulator-5554',
      packageName: 'com.example.app',
      resolvePid: async () => ({ ok: true, pid: 3132 }),
      resolveClockOffset: () => null,
      pidOf: () => null,
      pidWatchMs: 60000,
      startStream: ({ pid: streamPid }) => fakeChild(streamPid),
      attachSignals: false,
      onExit: (c) => {
        code = c;
      },
    });
    assert(result?.child);
    result.child.emit('exit', 0, null);
    await until(() => code === 0, { label: 'the collector to finish' });
    expect(code).toBe(0);
    expect(deviceLog().some((r) => r.event === 'collector_stopped')).toBeTruthy();
    expect('collectors' in (state() || {})).toBe(false);
  });
});

describe('the collector never signals a pid it does not own', () => {
  test('reattaching kills the stream through its own handle, not process.kill on its pid', async () => {
    const signalled: [number, string | number][] = [];
    const killedHandles: (string | number | undefined)[] = [];
    const origKill = process.kill;
    process.kill = ((pid: number, sig: string | number) => {
      signalled.push([pid, sig]);
      return true;
    }) as typeof process.kill;
    try {
      const started: ChildProcess[] = [];
      let pid = 3132;
      const result = await runCollector({
        platform: 'android',
        root,
        serial: 'emulator-5554',
        packageName: 'com.example.app',
        resolvePid: async () => ({ ok: true, pid: 3132 }),
        resolveClockOffset: () => null,
        pidOf: () => pid,
        pidWatchMs: 60000,
        startStream: ({ pid: streamPid }) => {
          const c = makeChildProcess({
            pid: streamPid ?? undefined,
            kill: ((sig?: string | number) => {
              killedHandles.push(sig);
              return true;
            }) as ChildProcess['kill'],
          });
          started.push(c);
          return c;
        },
        attachSignals: false,
        onExit: () => {},
      });

      pid = 4200;
      const firstStarted = started[0];
      assert(firstStarted);
      firstStarted.emit('exit', 0, null);

      await until(() => started.length === 2, { label: 'the reattached stream' });
      expect(killedHandles).toEqual(['SIGTERM']);
      expect(signalled.filter(([, sig]) => sig !== 0)).toEqual([]);

      assert(result);
      result.finish(0, 'info', 'done', 'collector_stopped');
    } finally {
      process.kill = origKill;
    }
  });
});

test('named collectors attribute their output and finish without unregistering a sibling', async () => {
  const streams = [makeChildProcess({ pid: 3132 }), makeChildProcess({ pid: 3133 })];
  const handles = [];
  for (const [index, slot] of ['phone', 'tablet'].entries()) {
    const handle = await runCollector({
      platform: 'android',
      root,
      slot,
      serial: slot,
      packageName: 'com.example.app',
      resolvePid: async () => ({ ok: true, pid: 3132 + index }),
      resolveClockOffset: () => 0,
      startStream: () => streams[index]!,
      pidOf: () => 3132 + index,
      pidWatchMs: 60_000,
      attachSignals: false,
      onExit: () => {},
    });
    assert(handle);
    handles.push(handle);
  }
  try {
    expect(Object.keys(readCollectors(root))).toEqual(['android:phone', 'android:tablet']);
    streams[0]!.stdout!.emit('data', ' 1788902582.542 I/ReactNativeJS( 3132): phone-output\n');
    streams[1]!.stdout!.emit('data', ' 1788902582.542 I/ReactNativeJS( 3133): tablet-output\n');
    expect(
      deviceLog()
        .filter((r) => String(r.msg).endsWith('-output'))
        .map((r) => [r.slot, r.deviceId]),
    ).toEqual([
      ['phone', 'phone'],
      ['tablet', 'tablet'],
    ]);
    handles[0]!.finish(0, 'info', 'done', 'collector_stopped');
    expect(Object.keys(readCollectors(root))).toEqual(['android:tablet']);
  } finally {
    for (const handle of handles) handle.finish(0, 'info', 'done', 'collector_stopped');
  }
});
