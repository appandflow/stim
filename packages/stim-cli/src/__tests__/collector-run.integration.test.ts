import assert from 'node:assert';
import type { ChildProcess } from 'node:child_process';
import { realpathSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseNdjsonText } from '../ndjson.ts';
import { workspaceLogsDir, workspaceStateFile } from '../workspace/paths.ts';
import { runCollector } from '../stimd/logs/collector.ts';
import { awaitIosDeviceLaunch, iosLaunchRemedy } from '../engine/ios-device.ts';

import { makeChildProcess } from './_factories.ts';

let tmpHome: string;
let root: string;

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

describe('runCollector seams', () => {
  test('a failed physical console drains its final diagnostic before launch readiness resolves', async () => {
    const child = makeChildProcess({ pid: 4242 });
    await runCollector({
      platform: 'ios',
      root,
      udid: 'U1',
      appName: 'MyApp',
      bundleId: 'com.test.app',
      physical: true,
      startStream: () => child,
      onExit: () => {},
    });
    assert(child.stderr);
    child.stderr.emit('data', 'BSErrorCodeDescription = Locked');
    child.emit('exit', 1, null);
    expect(deviceLog().some((record) => record.event === 'collector_failed')).toBe(false);
    const result = await awaitIosDeviceLaunch({
      udid: 'U1',
      bundleId: 'com.test.app',
      appName: 'MyApp',
      collectorStreamId: 'one',
      readRecords: () => deviceLog().map((record) => Object.assign(record, { streamId: 'one' })),
      probe: () => ({ state: 'stopped' }),
      sleep: async () => {
        child.emit('close', 1, null);
      },
    });
    expect(result.remedy).toBe(iosLaunchRemedy('locked', { udid: 'U1', bundleId: 'com.test.app' }));
    const records = deviceLog();
    expect(records.findIndex((record) => record.msg === 'BSErrorCodeDescription = Locked')).toBeLessThan(
      records.findIndex((record) => record.event === 'collector_failed'),
    );
  });
  test('stopping a worker-owned stream ends its child and records its end without a collector process record', async () => {
    const controller = new AbortController();
    const child = makeChildProcess({ pid: 4242 });
    const kill = vi.spyOn(child, 'kill');
    const ended = vi.fn<() => void>();
    const result = await runCollector({
      platform: 'ios',
      root,
      udid: 'U1',
      appName: 'MyApp',
      startStream: () => child,
      signal: controller.signal,
      onExit: ended,
    });
    assert(result);
    controller.abort();
    expect(kill).toHaveBeenCalledWith('SIGTERM');
    expect(ended).toHaveBeenCalledOnce();
    expect(deviceLog().some((record) => record.event === 'collector_stopped')).toBe(true);
  });

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

  test('late output retains the child that produced it after Android reattachment', async () => {
    const started: ChildProcess[] = [];
    const lines: ChildProcess[] = [];
    let reportPid: ((pid: number) => void | Promise<void>) | undefined;
    const result = await runCollector({
      platform: 'android',
      root,
      serial: 'emulator-5554',
      packageName: 'com.example.app',
      resolvePid: async () => ({ ok: true, pid: 3132 }),
      resolveClockOffset: () => 0,
      watchPid: ({ onChange }) => {
        reportPid = onChange;
        return { stop: () => {}, probe: async () => 4200, pid: 3132 };
      },
      startStream: ({ pid }) => {
        const child = fakeChild(pid);
        started.push(child);
        return child;
      },
      stopStream: async () => {},
      recordLine: (_line, _offset, child) => lines.push(child),
      onExit: () => {},
    });
    assert(reportPid);
    await reportPid(4200);
    await until(() => started.length === 2, { label: 'the reattached stream' });
    started[0]!.stdout!.emit('data', 'old line\n');
    started[1]!.stdout!.emit('data', 'new line\n');
    expect(lines).toEqual([started[0], started[1]]);
    assert(result);
    result.finish(0, 'info', 'done', 'collector_stopped');
  });

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
      onExit: () => {},
    });
    const firstStream = started[0];
    assert(firstStream);
    firstStream.emit('close', 0, null);
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
      onExit: (c) => {
        code = c;
      },
    });
    assert(result?.child);
    result.child.emit('close', 0, null);
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
        onExit: () => {},
      });

      pid = 4200;
      const firstStarted = started[0];
      assert(firstStarted);
      firstStarted.emit('close', 0, null);

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
