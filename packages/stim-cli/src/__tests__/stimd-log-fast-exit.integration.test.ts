import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { readWorkspaceState } from '../workspace/workspace-state.ts';
import { waitForPid } from './_pid-file.ts';

const fault = vi.hoisted(() => ({ capture: false }));
vi.mock('../process-identity.ts', async (original) => {
  const actual = await original<typeof import('../process-identity.ts')>();
  return {
    ...actual,
    captureProcessToken: (pid: number) => {
      if (fault.capture) {
        fault.capture = false;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
        return null;
      }
      return actual.captureProcessToken(pid);
    },
  };
});

test.skipIf(process.platform === 'win32')(
  'a child that exits before its token is captured does not strand the stream',
  async () => {
    const { createStreams } = await import('../stimd/logs/streams.ts');
    const home = mkdtempSync(join(tmpdir(), 'stim-fast-exit-home-'));
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-fast-exit-app-')));
    const bin = join(home, 'bin');
    mkdirSync(bin);
    vi.stubEnv('STIM_HOME', home);
    const xcrun = join(bin, 'xcrun');
    writeFileSync(xcrun, '#!/bin/sh\nexit 0\n');
    chmodSync(xcrun, 0o755);
    const env = { ...process.env, STIM_HOME: home, PATH: [bin, process.env.PATH].join(delimiter) };
    const streams = createStreams(() => {});
    try {
      fault.capture = true;
      await streams.start({ root, platform: 'ios', udid: 'U1', bundleId: 'com.test.app', appName: 'Test' }, env);
      await vi.waitFor(() => expect(streams.running()).toBe(false));
      expect(readWorkspaceState(root)?.collectors).toBeUndefined();
    } finally {
      await streams.close().catch(() => {});
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === 'win32')('an unverified live child is retained until its group exits', async () => {
  const { createStreams } = await import('../stimd/logs/streams.ts');
  const { captureProcessToken, inspectProcessIdentity } = await import('../process-identity.ts');
  const home = mkdtempSync(join(tmpdir(), 'stim-fast-exit-home-'));
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-fast-exit-app-')));
  const bin = join(home, 'bin');
  mkdirSync(bin);
  vi.stubEnv('STIM_HOME', home);
  const pidFile = join(home, 'pid');
  const xcrun = join(bin, 'xcrun');
  writeFileSync(xcrun, '#!/bin/sh\necho $$ > "$TEST_PID"\nexec sleep 600\n');
  chmodSync(xcrun, 0o755);
  const env = { ...process.env, STIM_HOME: home, TEST_PID: pidFile, PATH: [bin, process.env.PATH].join(delimiter) };
  const streams = createStreams(() => {});
  let identity: { pid: number; processToken: string } | null = null;
  try {
    fault.capture = true;
    const { streamId } = await streams.start(
      { root, platform: 'ios', udid: 'U1', bundleId: 'com.test.app', appName: 'Test' },
      env,
    );
    const pid = await waitForPid(pidFile);
    const token = captureProcessToken(pid);
    if (!token) throw new Error('the fixture child has no process identity');
    const childIdentity = { pid, processToken: token };
    identity = childIdentity;
    await expect(streams.stop(root, 'ios', 'default', streamId)).rejects.toThrow(/cannot be verified stopped.*claim/);
    expect(readWorkspaceState(root)?.collectors?.ios).toMatchObject({ streamId });
    expect(inspectProcessIdentity(childIdentity)).toBe('same');
    process.kill(-pid, 'SIGTERM');
    await vi.waitFor(() => expect(inspectProcessIdentity(childIdentity)).not.toBe('same'));
    expect(await streams.stop(root, 'ios', 'default', streamId)).toBe(true);
  } finally {
    if (identity && inspectProcessIdentity(identity) === 'same') process.kill(-identity.pid, 'SIGKILL');
    await streams.close().catch(() => {});
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === 'win32')(
  'history keeps output when its child exits before token capture',
  async () => {
    const { backfillDeviceLog } = await import('../stimd/logs/backfill.ts');
    const { createLogWriters } = await import('../stimd/logs/writer.ts');
    const { workspaceLogsDir } = await import('../workspace/paths.ts');
    const { parseNdjsonText } = await import('../ndjson.ts');
    const home = mkdtempSync(join(tmpdir(), 'stim-fast-exit-home-'));
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-fast-exit-app-')));
    const bin = join(home, 'bin');
    mkdirSync(bin);
    vi.stubEnv('STIM_HOME', home);
    const xcrun = join(bin, 'xcrun');
    const line = JSON.stringify({
      eventType: 'logEvent',
      timestamp: new Date().toISOString(),
      eventMessage: 'early history',
    });
    writeFileSync(xcrun, `#!/bin/sh\necho '${line}'\n`);
    chmodSync(xcrun, 0o755);
    const env = { ...process.env, STIM_HOME: home, PATH: [bin, process.env.PATH].join(delimiter) };
    const writers = createLogWriters(() => {});
    try {
      const sink = await writers.open(
        { streamId: 'ios', slotKey: 'ios', root, platform: 'ios', physical: false, attribution: {} },
        () => {},
      );
      fault.capture = true;
      await backfillDeviceLog({
        root,
        streamId: 'ios',
        spec: { root, platform: 'ios', udid: 'U1', appName: 'Test' },
        since: Date.now() - 1000,
        env,
        signal: new AbortController().signal,
        warm: () => false,
        sink,
      });
      sink.writer.close();
      await sink.closed();
      const records = parseNdjsonText(readFileSync(join(workspaceLogsDir(root), 'device.ndjson'), 'utf8'));
      expect(records.some((record) => record.msg === 'early history')).toBe(true);
    } finally {
      await writers.close();
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === 'win32')('history drains the final record after a large dump', async () => {
  const { backfillDeviceLog } = await import('../stimd/logs/backfill.ts');
  const { createLogWriters } = await import('../stimd/logs/writer.ts');
  const { workspaceLogsDir } = await import('../workspace/paths.ts');
  const { parseNdjsonText } = await import('../ndjson.ts');
  const home = mkdtempSync(join(tmpdir(), 'stim-fast-exit-home-'));
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-fast-exit-app-')));
  const bin = join(home, 'bin');
  mkdirSync(bin);
  vi.stubEnv('STIM_HOME', home);
  const xcrun = join(bin, 'xcrun');
  const line = JSON.stringify({
    eventType: 'logEvent',
    timestamp: new Date().toISOString(),
    eventMessage: 'last record',
  });
  writeFileSync(
    xcrun,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} -e 'const fs = require("node:fs"); const record = ${line}; record.eventMessage = "x".repeat(256 * 1024); fs.writeSync(1, JSON.stringify(record) + "\\n"); fs.writeSync(1, ${JSON.stringify(`${line}\n`)});'\n`,
  );
  chmodSync(xcrun, 0o755);
  const env = { ...process.env, STIM_HOME: home, PATH: [bin, process.env.PATH].join(delimiter) };
  const writers = createLogWriters(() => {});
  try {
    const sink = await writers.open(
      { streamId: 'ios', slotKey: 'ios', root, platform: 'ios', physical: false, attribution: {} },
      () => {},
    );
    await backfillDeviceLog({
      root,
      streamId: 'ios',
      spec: { root, platform: 'ios', udid: 'U1', appName: 'Test' },
      since: Date.now() - 1000,
      env,
      signal: new AbortController().signal,
      warm: () => false,
      sink,
    });
    await sink.closed();
    const records = parseNdjsonText(readFileSync(join(workspaceLogsDir(root), 'device.ndjson'), 'utf8'));
    expect(records.some((record) => record.msg === 'last record')).toBe(true);
  } finally {
    await writers.close();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
