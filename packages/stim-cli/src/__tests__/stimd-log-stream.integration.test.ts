import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { captureProcessToken, inspectProcessIdentity } from '../process-identity.ts';
import { parseNdjsonText } from '../ndjson.ts';
import { createStreams } from '../stimd/logs/streams.ts';
import { waitForPid } from './_pid-file.ts';
import { readWorkspaceState } from '../workspace/workspace-state.ts';
import { workspaceLogsDir } from '../workspace/paths.ts';

describe.skipIf(process.platform === 'win32')('native device streams', () => {
  test('Android stream reuse respects the caller environment for the same app and aliases', async () => {
    const home = mkdtempSync(join(tmpdir(), 'stim-stream-home-'));
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-stream-app-')));
    const bin = join(home, 'bin');
    mkdirSync(bin);
    vi.stubEnv('STIM_HOME', home);
    const pidFile = join(home, 'pids');
    const adb = join(bin, 'adb');
    writeFileSync(
      adb,
      '#!/bin/sh\ncase "$*" in *pidof*) echo 3132;; *date*) date +%s000;; *logcat*) echo $$ >> "$TEST_PID"; exec sleep 600;; esac\n',
    );
    chmodSync(adb, 0o755);
    const env = { ...process.env, STIM_HOME: home, TEST_PID: pidFile, PATH: [bin, process.env.PATH].join(delimiter) };
    const streams = createStreams(() => {});
    try {
      const spec = { root, platform: 'android' as const, serial: 'emulator-1', packageName: 'com.test.app' };
      const first = await streams.start({ ...spec, slot: 'phone' }, { ...env, ANDROID_LOG_TAGS: '*:S' });
      await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true));
      const replacement = await streams.start({ ...spec, slot: 'phone' }, env);
      expect(replacement.streamId).not.toBe(first.streamId);
      const other = await streams.start({ ...spec, slot: 'tablet' }, { ...env, ANDROID_LOG_TAGS: '*:S' });
      expect(other.streamId).not.toBe(replacement.streamId);
      await vi.waitFor(() => expect(readFileSync(pidFile, 'utf8').trim().split('\n')).toHaveLength(3));
      expect(await streams.stop(root, 'android', 'phone', replacement.streamId)).toBe(true);
      expect(await streams.stop(root, 'android', 'tablet', other.streamId)).toBe(true);
    } finally {
      await streams.close().catch(() => {});
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });
  test('a deleted workspace can still stop its recorded stream', async () => {
    const home = mkdtempSync(join(tmpdir(), 'stim-stream-home-'));
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-stream-app-')));
    const bin = join(home, 'bin');
    mkdirSync(bin);
    vi.stubEnv('STIM_HOME', home);
    const xcrun = join(bin, 'xcrun');
    const pidFile = join(home, 'pid');
    writeFileSync(xcrun, '#!/bin/sh\necho $$ > "$TEST_PID"\nexec sleep 600\n');
    chmodSync(xcrun, 0o755);
    const env = { ...process.env, STIM_HOME: home, TEST_PID: pidFile, PATH: [bin, process.env.PATH].join(delimiter) };
    const streams = createStreams(() => {});
    try {
      const { streamId } = await streams.start(
        { root, platform: 'ios', udid: 'U1', bundleId: 'com.test.app', appName: 'Test' },
        env,
      );
      await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true));
      rmSync(root, { recursive: true, force: true });
      expect(await streams.stop(root, 'ios', 'default', streamId)).toBe(true);
      expect(readWorkspaceState(root)?.collectors).toBeUndefined();
    } finally {
      await streams.close().catch(() => {});
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });
  test('shutdown drains a final line without interrupting another stream', async () => {
    const home = mkdtempSync(join(tmpdir(), 'stim-stream-home-'));
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-stream-app-')));
    const bin = join(home, 'bin');
    mkdirSync(bin);
    vi.stubEnv('STIM_HOME', home);
    const ready = join(home, 'ready');
    const xcrun = join(bin, 'xcrun');
    writeFileSync(
      xcrun,
      `#!/bin/sh\nexec "${process.execPath}" -e 'const fs = require("fs"); process.on("SIGTERM", () => { process.stdout.write(JSON.stringify({eventType:"logEvent",eventMessage:"trailer"})); process.exit(0); }); fs.appendFileSync(process.env.READY, "ready\\n"); setInterval(() => {}, 1000);'\n`,
    );
    chmodSync(xcrun, 0o755);
    const env = { ...process.env, STIM_HOME: home, READY: ready, PATH: [bin, process.env.PATH].join(delimiter) };
    const errors: string[] = [];
    const streams = createStreams((message) => errors.push(message));
    try {
      const spec = { root, platform: 'ios' as const, bundleId: 'com.test.app', appName: 'Test' };
      const first = await streams.start({ ...spec, udid: 'U1', slot: 'one' }, env);
      const second = await streams.start({ ...spec, udid: 'U2', slot: 'two' }, env);
      await vi.waitFor(() => expect(readFileSync(ready, 'utf8').trim().split('\n')).toHaveLength(2));
      expect(await streams.stop(root, 'ios', 'one', first.streamId)).toBe(true);
      const records = parseNdjsonText(readFileSync(join(workspaceLogsDir(root), 'device.ndjson'), 'utf8'));
      expect(records.some((record) => record.msg === 'trailer' && record.slot === 'one')).toBe(true);
      expect(readWorkspaceState(root)?.collectors?.['ios:two']).toMatchObject({ streamId: second.streamId });
      expect(await streams.stop(root, 'ios', 'two', second.streamId)).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      await streams.close().catch(() => {});
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });
  test('an asynchronous executable-not-found error does not escape the stream owner', async () => {
    const home = mkdtempSync(join(tmpdir(), 'stim-stream-home-'));
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-stream-app-')));
    vi.stubEnv('STIM_HOME', home);
    const errors: string[] = [];
    const streams = createStreams((message) => errors.push(message));
    try {
      await streams.start(
        { root, platform: 'ios', udid: 'U1', bundleId: 'com.test.app', appName: 'Test' },
        { ...process.env, STIM_HOME: home, PATH: home },
      );
      await vi.waitFor(() => expect(readWorkspaceState(root)?.collectors).toBeUndefined());
      expect(streams.running()).toBe(false);
    } finally {
      await streams.close().catch(() => {});
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });
  test('cancelling readiness reaps its historical child without stopping the live stream', async () => {
    const home = mkdtempSync(join(tmpdir(), 'stim-stream-home-'));
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-stream-app-')));
    const bin = join(home, 'bin');
    mkdirSync(bin);
    vi.stubEnv('STIM_HOME', home);
    const pidFile = join(home, 'history-pid');
    const xcrun = join(bin, 'xcrun');
    writeFileSync(xcrun, '#!/bin/sh\ncase "$*" in *"log show"*) echo $$ > "$HISTORY_PID";; esac\nexec sleep 600\n');
    chmodSync(xcrun, 0o755);
    const env = {
      ...process.env,
      STIM_HOME: home,
      HISTORY_PID: pidFile,
      PATH: [bin, process.env.PATH].join(delimiter),
    };
    const streams = createStreams(() => {});
    try {
      const { streamId } = await streams.start(
        { root, platform: 'ios', udid: 'U1', bundleId: 'com.test.app', appName: 'Test' },
        env,
      );
      const controller = new AbortController();
      const waiting = streams
        .wait(root, 'ios', 'default', streamId, Date.now() - 1000, 0, 5000, controller.signal, env)
        .catch(() => {});
      const pid = await waitForPid(pidFile);
      controller.abort();
      await waiting;
      await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(/ESRCH/));
      expect(readWorkspaceState(root)?.collectors?.ios).toMatchObject({ streamId });
      expect(await streams.stop(root, 'ios', 'default', streamId)).toBe(true);
    } finally {
      await streams.close().catch(() => {});
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });
  test('a cold stream backfills launch evidence through the owned history child', async () => {
    const home = mkdtempSync(join(tmpdir(), 'stim-stream-home-'));
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-stream-app-')));
    const bin = join(home, 'bin');
    mkdirSync(bin);
    vi.stubEnv('STIM_HOME', home);
    const since = Date.now() - 1000;
    const event = JSON.stringify({
      eventType: 'logEvent',
      timestamp: new Date().toISOString(),
      eventMessage: 'early launch',
    });
    const xcrun = join(bin, 'xcrun');
    const queries = join(home, 'history-queries');
    writeFileSync(
      xcrun,
      `#!/bin/sh\ncase "$*" in\n  *"log show"*) echo query >> "$HISTORY_QUERIES"; sleep 0.2; echo '${event}';;\n  *) exec sleep 600;;\nesac\n`,
    );
    chmodSync(xcrun, 0o755);
    const env = {
      ...process.env,
      STIM_HOME: home,
      HISTORY_QUERIES: queries,
      PATH: [bin, process.env.PATH].join(delimiter),
    };
    const errors: string[] = [];
    const streams = createStreams((message) => errors.push(message));
    try {
      const { streamId } = await streams.start(
        { root, platform: 'ios', udid: 'U1', bundleId: 'com.test.app', appName: 'Test' },
        env,
      );
      const signal = new AbortController().signal;
      let reply = await streams.wait(root, 'ios', 'default', streamId, since, 0, 0, signal, env);
      expect(reply.coverage).toBe('pending');
      while (reply.coverage === 'pending') {
        reply = await streams.wait(root, 'ios', 'default', streamId, since, reply.revision, 1000, signal, env);
      }
      expect(reply.coverage).toBe('covered');
      const through = Date.now();
      reply = await streams.wait(root, 'ios', 'default', streamId, since, reply.revision, 0, signal, env, through);
      expect(reply.coverage).toBe('pending');
      while (reply.coverage === 'pending') {
        reply = await streams.wait(root, 'ios', 'default', streamId, since, reply.revision, 1000, signal, env, through);
      }
      expect(reply.coverage).toBe('covered');
      expect(readFileSync(queries, 'utf8').trim().split('\n')).toHaveLength(2);
      const waitStarted = Date.now();
      reply = await streams.wait(root, 'ios', 'default', streamId, since, reply.revision, 100, signal, env, through);
      expect(reply.coverage).toBe('covered');
      expect(Date.now() - waitStarted).toBeGreaterThanOrEqual(80);
      const records = parseNdjsonText(readFileSync(join(workspaceLogsDir(root), 'device.ndjson'), 'utf8'));
      expect(records.some((record) => record.msg === 'early launch')).toBe(true);
      expect(await streams.stop(root, 'ios', 'default', streamId)).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      await streams.close().catch(() => {});
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });
  test('a warm stream still queries history through the readiness boundary', async () => {
    const home = mkdtempSync(join(tmpdir(), 'stim-stream-home-'));
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-stream-app-')));
    const bin = join(home, 'bin');
    mkdirSync(bin);
    vi.stubEnv('STIM_HOME', home);
    const queries = join(home, 'queries');
    const line = JSON.stringify({ eventType: 'logEvent', eventMessage: 'warm' });
    const xcrun = join(bin, 'xcrun');
    writeFileSync(
      xcrun,
      `#!/bin/sh\ncase "$*" in *"log show"*) echo query >> "$QUERIES";; *) echo '${line}'; exec sleep 600;; esac\n`,
    );
    chmodSync(xcrun, 0o755);
    const env = { ...process.env, QUERIES: queries, PATH: [bin, process.env.PATH].join(delimiter) };
    const streams = createStreams(() => {});
    try {
      const { streamId } = await streams.start(
        { root, platform: 'ios', udid: 'U1', bundleId: 'com.test.app', appName: 'Test' },
        env,
      );
      const path = join(workspaceLogsDir(root), 'device.ndjson');
      await vi.waitFor(() => expect(readFileSync(path, 'utf8')).toContain('warm'));
      const since = Date.now();
      const signal = new AbortController().signal;
      let reply = await streams.wait(root, 'ios', 'default', streamId, since, 0, 0, signal, env, since);
      while (reply.coverage === 'pending')
        reply = await streams.wait(root, 'ios', 'default', streamId, since, reply.revision, 1000, signal, env, since);
      expect(reply.coverage).toBe('covered');
      expect(readFileSync(queries, 'utf8')).toContain('query');
    } finally {
      await streams.close().catch(() => {});
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });
  test('a live write failure during replay invalidates coverage', async () => {
    const home = mkdtempSync(join(tmpdir(), 'stim-stream-home-'));
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-stream-app-')));
    const bin = join(home, 'bin');
    mkdirSync(bin);
    vi.stubEnv('STIM_HOME', home);
    const liveGo = join(home, 'live-go');
    const liveReady = join(home, 'live-ready');
    const historyGo = join(home, 'history-go');
    const historyStarted = join(home, 'history-started');
    const xcrun = join(bin, 'xcrun');
    const line = JSON.stringify({
      eventType: 'logEvent',
      timestamp: new Date().toISOString(),
      eventMessage: 'evidence',
    });
    writeFileSync(
      xcrun,
      `#!/bin/sh\ncase "$*" in\n  *"log show"*) touch "$HISTORY_STARTED"; while [ ! -f "$HISTORY_GO" ]; do sleep .05; done; echo '${line}';;\n  *) ${JSON.stringify(process.execPath)} -e 'const r = ${line}; r.eventMessage = "x".repeat(1024 * 1024); process.stdout.write(JSON.stringify(r) + "\\n");'; touch "$LIVE_READY"; while [ ! -f "$LIVE_GO" ]; do sleep .05; done; echo '${line}'; exec sleep 600;;\nesac\n`,
    );
    chmodSync(xcrun, 0o755);
    const env = {
      ...process.env,
      STIM_HOME: home,
      LIVE_GO: liveGo,
      LIVE_READY: liveReady,
      HISTORY_GO: historyGo,
      HISTORY_STARTED: historyStarted,
      PATH: [bin, process.env.PATH].join(delimiter),
    };
    const streams = createStreams(() => {});
    try {
      const since = Date.now() - 1000;
      const { streamId } = await streams.start(
        { root, platform: 'ios', udid: 'U1', bundleId: 'com.test.app', appName: 'Test' },
        env,
      );
      await vi.waitFor(() => expect(existsSync(liveReady)).toBe(true));
      const signal = new AbortController().signal;
      let reply = await streams.wait(root, 'ios', 'default', streamId, since, 0, 0, signal, env);
      await vi.waitFor(() => expect(existsSync(historyStarted)).toBe(true));
      reply = await streams.wait(root, 'ios', 'default', streamId, since, reply.revision, 0, signal, env);
      const path = join(workspaceLogsDir(root), 'device.ndjson');
      rmSync(path, { force: true });
      mkdirSync(path, { recursive: true });
      const wake = streams.wait(root, 'ios', 'default', streamId, since, reply.revision, 2000, signal, env);
      writeFileSync(liveGo, '');
      reply = await wake;
      expect(reply.coverage).toBe('pending');
      rmSync(path, { recursive: true });
      writeFileSync(historyGo, '');
      while (reply.coverage === 'pending')
        reply = await streams.wait(root, 'ios', 'default', streamId, since, reply.revision, 1000, signal, env);
      expect(reply.coverage).toBe('failed');
    } finally {
      await streams.close().catch(() => {});
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  test.each([true, false])(
    'a live write failure invalidates an already waiting readiness check (physical: %s)',
    async (physical) => {
      const home = mkdtempSync(join(tmpdir(), 'stim-stream-home-'));
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-stream-app-')));
      const bin = join(home, 'bin');
      mkdirSync(bin);
      vi.stubEnv('STIM_HOME', home);
      const liveGo = join(home, 'live-go');
      const fillGo = join(home, 'fill-go');
      const xcrun = join(bin, 'xcrun');
      const line = physical ? 'lost' : JSON.stringify({ eventType: 'logEvent', eventMessage: 'lost' });
      const warm = physical ? 'x'.repeat(1) : JSON.stringify({ eventType: 'logEvent', eventMessage: 'warm' });
      const fill = `${JSON.stringify(process.execPath)} -e 'const r = ${JSON.stringify(warm)}; process.stdout.write(${physical ? '"x".repeat(1024 * 1024)' : 'JSON.stringify({...JSON.parse(r),eventMessage:"x".repeat(1024 * 1024)})'} + "\\n")'`;
      writeFileSync(
        xcrun,
        `#!/bin/sh\ncase "$*" in\n  *"log show"*) echo '${JSON.stringify({ eventType: 'logEvent', eventMessage: 'history' })}';;\n  *) ${fill}; while [ ! -f "$FILL_GO" ]; do sleep .05; done; ${fill}; while [ ! -f "$LIVE_GO" ]; do sleep .05; done; echo '${line}'; exec sleep 600;;\nesac\n`,
      );
      chmodSync(xcrun, 0o755);
      const env = {
        ...process.env,
        STIM_HOME: home,
        LIVE_GO: liveGo,
        FILL_GO: fillGo,
        PATH: [bin, process.env.PATH].join(delimiter),
      };
      const streams = createStreams(() => {});
      try {
        const { streamId } = await streams.start(
          { root, platform: 'ios', udid: 'U1', bundleId: 'com.test.app', appName: 'Test', physical },
          env,
        );
        const since = Date.now() - 1000;
        const signal = new AbortController().signal;
        const path = join(workspaceLogsDir(root), 'device.ndjson');
        await vi.waitFor(() => expect(statSync(path).size).toBeGreaterThan(1024 * 1024));
        let initial = await streams.wait(root, 'ios', 'default', streamId, since, 0, 0, signal, env);
        while (initial.coverage === 'pending')
          initial = await streams.wait(root, 'ios', 'default', streamId, since, initial.revision, 1000, signal, env);
        expect(initial.coverage).toBe(physical ? 'failed' : 'covered');
        const before = statSync(path).size;
        writeFileSync(fillGo, '');
        await vi.waitFor(() => expect(statSync(path).size).toBeGreaterThan(before + 1024 * 1024));
        initial = await streams.wait(root, 'ios', 'default', streamId, since, initial.revision, 0, signal, env);
        rmSync(path, { force: true });
        mkdirSync(path, { recursive: true });
        const waiting = streams.wait(root, 'ios', 'default', streamId, since, initial.revision, 2000, signal, env);
        writeFileSync(liveGo, '');
        expect((await waiting).coverage).toBe('failed');
        rmSync(path, { recursive: true });
      } finally {
        await streams.close().catch(() => {});
        vi.unstubAllEnvs();
        rmSync(home, { recursive: true, force: true });
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  test('Android replay coverage fails when the attached app PID changes', async () => {
    const home = mkdtempSync(join(tmpdir(), 'stim-stream-home-'));
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-stream-app-')));
    const bin = join(home, 'bin');
    mkdirSync(bin);
    vi.stubEnv('STIM_HOME', home);
    vi.stubEnv('STIM_PID_WATCH_MS', '500');
    const pidFile = join(home, 'app-pid');
    writeFileSync(pidFile, '3132');
    const adb = join(bin, 'adb');
    writeFileSync(
      adb,
      `#!/bin/sh\ncase "$*" in\n  *pidof*) cat "$APP_PID";;\n  *date*) date +%s000;;\n  *logcat*" -d "*) date '+%s.000 3132 3132 I Test: historical';;\n  *logcat*) exec sleep 600;;\nesac\n`,
    );
    chmodSync(adb, 0o755);
    const env = { ...process.env, STIM_HOME: home, APP_PID: pidFile, PATH: [bin, process.env.PATH].join(delimiter) };
    const streams = createStreams(() => {});
    try {
      const { streamId } = await streams.start(
        { root, platform: 'android', serial: 'emulator-1', packageName: 'com.test.app' },
        env,
      );
      const since = Date.now() - 1000;
      const signal = new AbortController().signal;
      let reply = await streams.wait(root, 'android', 'default', streamId, since, 0, 0, signal, env);
      while (reply.coverage === 'pending')
        reply = await streams.wait(root, 'android', 'default', streamId, since, reply.revision, 1000, signal, env);
      expect(reply.coverage).toBe('covered');
      writeFileSync(pidFile, '4141');
      const rerunSignal = new AbortController().signal;
      let rerun = await streams.wait(root, 'android', 'default', streamId, since, 0, 0, rerunSignal, env);
      expect(rerun.coverage).toBe('pending');
      await vi.waitFor(() => {
        const records = parseNdjsonText(readFileSync(join(workspaceLogsDir(root), 'device.ndjson'), 'utf8'));
        expect(records.some((record) => record.event === 'collector_reattached')).toBe(true);
      });
      reply = await streams.wait(root, 'android', 'default', streamId, since, reply.revision, 0, signal, env);
      expect(reply.coverage).toBe('failed');
      while (rerun.coverage === 'pending')
        rerun = await streams.wait(root, 'android', 'default', streamId, since, rerun.revision, 1000, rerunSignal, env);
      expect(rerun.coverage).toBe('covered');
    } finally {
      await streams.close().catch(() => {});
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a main-owned device stream writes logs, refuses stale stops, and reaps its child', async () => {
    const home = mkdtempSync(join(tmpdir(), 'stim-stream-home-'));
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-stream-app-')));
    const bin = join(home, 'bin');
    mkdirSync(bin);
    vi.stubEnv('STIM_HOME', home);
    const pidFile = join(home, 'pid');
    const xcrun = join(bin, 'xcrun');
    writeFileSync(
      xcrun,
      `#!/bin/sh\necho $$ > "$TEST_PID"\necho '{"eventType":"logEvent","eventMessage":"hello"}'\nexec sleep 600\n`,
    );
    chmodSync(xcrun, 0o755);
    const env = { ...process.env, STIM_HOME: home, TEST_PID: pidFile, PATH: [bin, process.env.PATH].join(delimiter) };
    const errors: string[] = [];
    const streams = createStreams((message) => errors.push(message));
    let child: { pid: number; processToken: string } | null = null;
    try {
      const { streamId } = await streams.start(
        { root, platform: 'ios', udid: 'U1', bundleId: 'com.test.app', appName: 'Test' },
        env,
      );
      const pid = await waitForPid(pidFile);
      const processToken = captureProcessToken(pid);
      if (processToken) child = { pid, processToken };
      await vi.waitFor(() => {
        const records = parseNdjsonText(readFileSync(join(workspaceLogsDir(root), 'device.ndjson'), 'utf8'));
        expect(records.some((record) => record.msg === 'hello')).toBe(true);
      });
      await expect(streams.stop(root, 'ios', 'default', 'old-stream')).rejects.toThrow('stream changed');
      expect(readWorkspaceState(root)?.collectors?.ios).toMatchObject({ streamId });
      expect(await streams.stop(root, 'ios', 'default', streamId)).toBe(true);
      expect(readWorkspaceState(root)?.collectors).toBeUndefined();
      expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);
      expect(errors).toEqual([]);
    } finally {
      await streams.close().catch(() => {});
      if (child && inspectProcessIdentity(child) === 'same') process.kill(child.pid, 'SIGKILL');
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('stopping a pending Android stream cancels its app-pid wait', async () => {
    const home = mkdtempSync(join(tmpdir(), 'stim-stream-home-'));
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-stream-app-')));
    const bin = join(home, 'bin');
    mkdirSync(bin);
    vi.stubEnv('STIM_HOME', home);
    const adb = join(bin, 'adb');
    writeFileSync(adb, '#!/bin/sh\nexit 0\n');
    chmodSync(adb, 0o755);
    const env = { ...process.env, STIM_HOME: home, PATH: [bin, process.env.PATH].join(delimiter) };
    const errors: string[] = [];
    const streams = createStreams((message) => errors.push(message));
    try {
      const { streamId } = await streams.start(
        { root, platform: 'android', serial: 'emulator-1', packageName: 'com.test.app' },
        env,
      );
      const started = Date.now();
      expect(await streams.stop(root, 'android', 'default', streamId)).toBe(true);
      expect(Date.now() - started).toBeLessThan(2000);
      expect(readWorkspaceState(root)?.collectors).toBeUndefined();
      expect(errors).toEqual([]);
    } finally {
      await streams.close().catch(() => {});
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a new owner stops the verified log child left by an exited owner before starting a replacement', async () => {
    const { spawn } = await import('node:child_process');
    const { once } = await import('node:events');
    const home = mkdtempSync(join(tmpdir(), 'stim-stream-home-'));
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-stream-app-')));
    const bin = join(home, 'bin');
    mkdirSync(bin);
    vi.stubEnv('STIM_HOME', home);
    const pidFile = join(home, 'pid');
    const xcrun = join(bin, 'xcrun');
    writeFileSync(xcrun, '#!/bin/sh\necho $$ > "$TEST_PID"\nexec sleep 600\n');
    chmodSync(xcrun, 0o755);
    const env = { ...process.env, STIM_HOME: home, TEST_PID: pidFile, PATH: [bin, process.env.PATH].join(delimiter) };
    const module = new URL('../stimd/logs/streams.ts', import.meta.url).href;
    const script = `import { createStreams } from ${JSON.stringify(module)};
import { existsSync, readFileSync } from 'node:fs';
const streams = createStreams(console.error);
await streams.start({ root: ${JSON.stringify(root)}, platform: 'ios', udid: 'U1', bundleId: 'com.test.app', appName: 'Test' }, process.env);
let pid = 0;
while (!(pid > 0)) {
  pid = existsSync(${JSON.stringify(pidFile)}) ? Number(readFileSync(${JSON.stringify(pidFile)}, 'utf8').trim()) : 0;
  if (!(pid > 0)) await new Promise(r => setTimeout(r, 10));
}
console.log(pid);
process.exit(0);`;
    const ownerScript = join(home, 'owner.mjs');
    writeFileSync(ownerScript, script);
    const owner = spawn(process.execPath, [ownerScript], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const exited = once(owner, 'exit');
    let output = '';
    let errorOutput = '';
    owner.stderr.on('data', (chunk: Buffer) => {
      errorOutput += chunk.toString();
    });
    owner.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    const children: { pid: number; processToken: string }[] = [];
    const streams = createStreams(() => {});
    try {
      await exited;
      expect({ code: owner.exitCode, error: errorOutput }).toEqual({ code: 0, error: '' });
      const oldPid = Number(output.trim());
      const token = captureProcessToken(oldPid);
      if (token) children.push({ pid: oldPid, processToken: token });
      expect(token).toBeTruthy();
      rmSync(pidFile);
      const { streamId } = await streams.start(
        { root, platform: 'ios', udid: 'U1', bundleId: 'com.test.app', appName: 'Test' },
        env,
      );
      expect(() => process.kill(oldPid, 0)).toThrow(/ESRCH/);
      const newPid = await waitForPid(pidFile);
      const newToken = captureProcessToken(newPid);
      if (newToken) children.push({ pid: newPid, processToken: newToken });
      expect(await streams.stop(root, 'ios', 'default', streamId)).toBe(true);
    } finally {
      if (owner.exitCode === null) owner.kill('SIGKILL');
      await streams.close().catch(() => {});
      for (const child of children) if (inspectProcessIdentity(child) === 'same') process.kill(child.pid, 'SIGKILL');
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a stream record without its ownership claim is not replaced or cleared', async () => {
    const home = mkdtempSync(join(tmpdir(), 'stim-stream-home-'));
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-stream-app-')));
    vi.stubEnv('STIM_HOME', home);
    const { registerCollector } = await import('../stimd/logs/state.ts');
    registerCollector(root, 'ios', { kind: 'stream', streamId: 'missing-claim' });
    const streams = createStreams(() => {});
    try {
      await expect(
        streams.start({ root, platform: 'ios', udid: 'U1', bundleId: 'com.test.app', appName: 'Test' }, {}),
      ).rejects.toThrow('no verifiable claim');
      await expect(streams.stop(root, 'ios', 'default', 'missing-claim')).rejects.toThrow('no verifiable claim');
      expect(readWorkspaceState(root)?.collectors?.ios).toMatchObject({ streamId: 'missing-claim' });
    } finally {
      await streams.close();
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('slots sharing a device and app share one child until the last subscriber stops', async () => {
    const home = mkdtempSync(join(tmpdir(), 'stim-stream-home-'));
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-stream-app-')));
    const bin = join(home, 'bin');
    mkdirSync(bin);
    vi.stubEnv('STIM_HOME', home);
    const pidFile = join(home, 'pids');
    const xcrun = join(bin, 'xcrun');
    writeFileSync(
      xcrun,
      `#!/bin/sh\necho $$ >> "$TEST_PID"\nexec "${process.execPath}" -e 'setInterval(() => console.log(JSON.stringify({eventType:"logEvent",eventMessage:"shared"})), 20)'\n`,
    );
    chmodSync(xcrun, 0o755);
    const env = { ...process.env, STIM_HOME: home, TEST_PID: pidFile, PATH: [bin, process.env.PATH].join(delimiter) };
    const streams = createStreams(() => {});
    let child: { pid: number; processToken: string } | null = null;
    try {
      const spec = { root, platform: 'ios' as const, udid: 'U1', bundleId: 'com.test.app', appName: 'Test' };
      const first = await streams.start({ ...spec, slot: 'phone' }, { ...env, STIM_RUN_ID: 'one', STIM_TRACE: '/one' });
      const second = await streams.start(
        { ...spec, slot: 'tablet' },
        { ...env, STIM_RUN_ID: 'two', STIM_TRACE: '/two' },
      );
      expect(second.streamId).toBe(first.streamId);
      const pid = await waitForPid(pidFile);
      expect(readFileSync(pidFile, 'utf8').trim().split('\n')).toHaveLength(1);
      const token = captureProcessToken(pid);
      if (token) child = { pid, processToken: token };
      await vi.waitFor(() => {
        const records = parseNdjsonText(readFileSync(join(workspaceLogsDir(root), 'device.ndjson'), 'utf8'));
        expect(records.filter((record) => record.msg === 'shared').map((record) => record.slot)).toEqual(
          expect.arrayContaining(['phone', 'tablet']),
        );
      });
      expect(await streams.stop(root, 'ios', 'phone', first.streamId)).toBe(true);
      expect(process.kill(pid, 0)).toBe(true);
      const replacement = await streams.start({ ...spec, udid: 'U2', slot: 'phone' }, env);
      expect(replacement.streamId).not.toBe(first.streamId);
      expect(await streams.stop(root, 'ios', 'phone', replacement.streamId)).toBe(true);
      expect(process.kill(pid, 0)).toBe(true);
      expect(await streams.stop(root, 'ios', 'tablet', first.streamId)).toBe(true);
      expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);
    } finally {
      await streams.close().catch(() => {});
      if (child && inspectProcessIdentity(child) === 'same') process.kill(child.pid, 'SIGKILL');
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });
  test('a later stop retries cleanup after a slow child eventually exits', async () => {
    const home = mkdtempSync(join(tmpdir(), 'stim-stream-home-'));
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-stream-app-')));
    const bin = join(home, 'bin');
    mkdirSync(bin);
    vi.stubEnv('STIM_HOME', home);
    const readyFile = join(home, 'ready');
    const xcrun = join(bin, 'xcrun');
    const script = `process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(process.env.TEST_READY, String(process.pid)); setTimeout(() => process.exit(0), 3200); setInterval(() => {}, 1000);`;
    writeFileSync(xcrun, `#!/bin/sh\nexec "${process.execPath}" -e ${JSON.stringify(script)}\n`);
    chmodSync(xcrun, 0o755);
    const env = {
      ...process.env,
      STIM_HOME: home,
      TEST_READY: readyFile,
      PATH: [bin, process.env.PATH].join(delimiter),
    };
    const streams = createStreams(() => {});
    let child: { pid: number; processToken: string } | null = null;
    try {
      const spec = { root, platform: 'ios' as const, udid: 'U1', bundleId: 'com.test.app', appName: 'Test' };
      const { streamId } = await streams.start(spec, env);
      await vi.waitFor(() => expect(existsSync(readyFile)).toBe(true));
      const pid = Number(readFileSync(readyFile, 'utf8'));
      const token = captureProcessToken(pid);
      if (!token) throw new Error('the child has no process identity');
      child = { pid, processToken: token };
      await expect(streams.stop(root, 'ios', 'default', streamId)).rejects.toThrow('could not be stopped');
      expect(readWorkspaceState(root)?.collectors?.ios).toMatchObject({ streamId });
      await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(/ESRCH/), { timeout: 5_000 });
      expect(await streams.stop(root, 'ios', 'default', streamId)).toBe(true);
      expect(readWorkspaceState(root)?.collectors).toBeUndefined();
      writeFileSync(xcrun, '#!/bin/sh\nexec sleep 600\n');
      const replacement = await streams.start(spec, env);
      expect(await streams.stop(root, 'ios', 'default', replacement.streamId)).toBe(true);
    } finally {
      await streams.close().catch(() => {});
      if (child && inspectProcessIdentity(child) === 'same') process.kill(child.pid, 'SIGKILL');
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);
});

test('an empty stored stream identity is refused without deleting its registration', async () => {
  const home = mkdtempSync(join(tmpdir(), 'stim-stream-home-'));
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-stream-app-')));
  vi.stubEnv('STIM_HOME', home);
  const { registerCollector } = await import('../stimd/logs/state.ts');
  registerCollector(root, 'ios', { kind: 'stream', streamId: '', startedAt: new Date().toISOString() });
  const streams = createStreams(() => {});
  try {
    await expect(
      streams.start({ root, platform: 'ios', udid: 'U1', bundleId: 'com.test', appName: 'Test' }, {}),
    ).rejects.toThrow('no identity');
    expect(readWorkspaceState(root)?.collectors?.ios).toMatchObject({ streamId: '' });
  } finally {
    await streams.close();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
