import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { captureProcessToken, inspectProcessIdentity } from '../process-identity.ts';
import { parseNdjsonText } from '../ndjson.ts';
import { createStreams } from '../stimd/logs/streams.ts';
import { readWorkspaceState } from '../workspace/workspace-state.ts';
import { workspaceLogsDir } from '../workspace/paths.ts';

describe.skipIf(process.platform === 'win32')('native device streams', () => {
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
      `#!/bin/sh\nexec "${process.execPath}" -e 'const fs = require("fs"); process.on("SIGTERM", () => { console.log(JSON.stringify({eventType:"logEvent",eventMessage:"trailer"})); process.exit(0); }); fs.appendFileSync(process.env.READY, "ready\\n"); setInterval(() => {}, 1000);'\n`,
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
      await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true));
      const pid = Number(readFileSync(pidFile, 'utf8'));
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
    writeFileSync(xcrun, `#!/bin/sh\ncase "$*" in\n  *"log show"*) echo '${event}';;\n  *) exec sleep 600;;\nesac\n`);
    chmodSync(xcrun, 0o755);
    const env = { ...process.env, STIM_HOME: home, PATH: [bin, process.env.PATH].join(delimiter) };
    const errors: string[] = [];
    const streams = createStreams((message) => errors.push(message));
    try {
      const { streamId } = await streams.start(
        { root, platform: 'ios', udid: 'U1', bundleId: 'com.test.app', appName: 'Test' },
        env,
      );
      await streams.wait(root, 'ios', 'default', streamId, since, 0, 500, new AbortController().signal, env);
      await vi.waitFor(() => {
        const records = parseNdjsonText(readFileSync(join(workspaceLogsDir(root), 'device.ndjson'), 'utf8'));
        expect(records.some((record) => record.msg === 'early launch')).toBe(true);
      });
      expect(await streams.stop(root, 'ios', 'default', streamId)).toBe(true);
      expect(errors).toEqual([]);
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
      await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true));
      const pid = Number(readFileSync(pidFile, 'utf8'));
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
while (!existsSync(${JSON.stringify(pidFile)})) await new Promise(r => setTimeout(r, 10));
console.log(readFileSync(${JSON.stringify(pidFile)}, 'utf8').trim());
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
      await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true));
      const newPid = Number(readFileSync(pidFile, 'utf8'));
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
      const first = await streams.start({ ...spec, slot: 'phone' }, env);
      const second = await streams.start({ ...spec, slot: 'tablet' }, env);
      expect(second.streamId).toBe(first.streamId);
      await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true));
      const pids = readFileSync(pidFile, 'utf8').trim().split('\n').map(Number);
      expect(pids).toHaveLength(1);
      const pid = pids[0]!;
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
