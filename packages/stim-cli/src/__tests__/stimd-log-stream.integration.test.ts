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
});
