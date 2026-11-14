import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { delimiter, join } from 'node:path';
import type { Worker } from 'node:worker_threads';
import { markClaimChildPending } from '@stim-cli/core/ownership-claim';
import { claimLiveness, readClaimSet } from '../ownership-claim.ts';
import * as ownership from '../ownership-claim.ts';
import * as streamState from '../stimd/logs/state.ts';
import { workspaceDir } from '../workspace/paths.ts';
import { readWorkspaceState } from '../workspace/workspace-state.ts';
import { getExecutor } from '../exec.ts';
import { createStreams } from '../stimd/logs/streams.ts';
import { waitForPid } from './_pid-file.ts';

const identity = vi.hoisted<{ windows: boolean; live: boolean; unknown: boolean; workers: Worker[] }>(() => ({
  windows: false,
  live: true,
  unknown: false,
  workers: [],
}));
vi.mock('node:worker_threads', async (load) => {
  const actual = await load<typeof import('node:worker_threads')>();
  class CapturedWorker extends actual.Worker {
    constructor(...args: ConstructorParameters<typeof actual.Worker>) {
      super(...args);
      identity.workers.push(this);
    }
  }
  return { ...actual, Worker: CapturedWorker };
});
vi.mock('../process-identity.ts', async (load) => {
  const actual = await load<typeof import('../process-identity.ts')>();
  return {
    ...actual,
    captureProcessToken: (pid: number) => (identity.windows ? 'windows-token' : actual.captureProcessToken(pid)),
    inspectProcessIdentity: (...args: Parameters<typeof actual.inspectProcessIdentity>) =>
      identity.windows
        ? identity.unknown
          ? 'unknown'
          : identity.live
            ? 'same'
            : 'gone'
        : actual.inspectProcessIdentity(...args),
  };
});

test.skipIf(process.platform === 'win32')(
  'Windows stream stop uses the system taskkill without blocking other work',
  async () => {
    const home = mkdtempSync(join(tmpdir(), 'stim-stream-home-'));
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-stream-app-')));
    const bin = join(home, 'bin');
    mkdirSync(bin);
    vi.stubEnv('STIM_HOME', home);
    const pidFile = join(home, 'pid');
    const xcrun = join(bin, 'xcrun');
    writeFileSync(xcrun, '#!/bin/sh\necho $$ > "$TEST_PID"\nexec sleep 600\n');
    chmodSync(xcrun, 0o755);
    const env = { ...process.env, TEST_PID: pidFile, PATH: [bin, process.env.PATH].join(delimiter) };
    const streams = createStreams(() => {});
    const realProcess = process;
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      const { streamId } = await streams.start(
        { root, platform: 'ios', udid: 'U1', bundleId: 'com.test.app', appName: 'Test' },
        env,
      );
      const pid = await waitForPid(pidFile);
      const executor = getExecutor();
      const run = vi.spyOn(executor, 'runFileAsync').mockImplementation(async (file, args, opts) => {
        expect(file).toBe('C:\\Windows-Test\\System32\\taskkill.exe');
        expect(args).toEqual(['/PID', String(pid), '/T', '/F']);
        expect(opts.timeoutMs).toBe(30_000);
        await held;
        identity.live = false;
        vi.unstubAllGlobals();
        realProcess.kill(pid, 'SIGTERM');
        return '';
      });
      vi.stubEnv('SystemRoot', 'C:\\Windows-Test');
      vi.stubEnv('PATH', '/bin');
      identity.windows = true;
      vi.stubGlobal('process', Object.create(realProcess, { platform: { value: 'win32' } }));
      const stopping = streams.stop(root, 'ios', 'default', streamId);
      await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
      let responsive = false;
      await new Promise<void>((resolve) =>
        setTimeout(() => {
          responsive = true;
          resolve();
        }, 0),
      );
      expect(responsive).toBe(true);
      release();
      expect(await stopping).toBe(true);
    } finally {
      release();
      vi.unstubAllGlobals();
      identity.windows = false;
      identity.live = true;
      vi.restoreAllMocks();
      await streams.close().catch(() => {});
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === 'win32')(
  'worker failure waits for tree termination and retains an unverified claim',
  async () => {
    const home = mkdtempSync(join(tmpdir(), 'stim-stream-home-'));
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-stream-app-')));
    const bin = join(home, 'bin');
    mkdirSync(bin);
    vi.stubEnv('STIM_HOME', home);
    const pidFile = join(home, 'pid');
    const xcrun = join(bin, 'xcrun');
    writeFileSync(xcrun, '#!/bin/sh\necho $$ > "$TEST_PID"\nexec sleep 600\n');
    chmodSync(xcrun, 0o755);
    const env = { ...process.env, TEST_PID: pidFile, PATH: [bin, process.env.PATH].join(delimiter) };
    const messages: string[] = [];
    const streams = createStreams((message) => messages.push(message));
    const realProcess = process;
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let pid = 0;
    try {
      const { streamId } = await streams.start(
        { root, platform: 'ios', udid: 'U1', bundleId: 'com.test.app', appName: 'Test' },
        env,
      );
      pid = await waitForPid(pidFile);
      const run = vi.spyOn(getExecutor(), 'runFileAsync').mockImplementation(async () => {
        await held;
        throw new Error('tree stop failed');
      });
      identity.windows = true;
      vi.stubGlobal('process', Object.create(realProcess, { platform: { value: 'win32' } }));
      const worker = identity.workers.at(-1);
      if (!worker) throw new Error('worker not started');
      await worker.terminate();
      await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
      expect(() => realProcess.kill(pid, 0)).not.toThrow();
      release();
      const attempt = run.mock.results[0]?.value;
      if (!attempt) throw new Error('taskkill was not attempted');
      await expect(attempt).rejects.toThrow('tree stop failed');
      expect(() => realProcess.kill(pid, 0)).not.toThrow();
      expect(messages.some((message) => message.includes('logs worker failed'))).toBe(true);
      vi.unstubAllGlobals();
      expect(readWorkspaceState(root)?.collectors?.ios).toBeDefined();
      identity.windows = false;
      const claimRoot = join(
        workspaceDir(root),
        'log-streams',
        `stream-${createHash('sha256').update(streamId).digest('hex')}.claim`,
      );
      const holder = readClaimSet(claimRoot).live[0];
      expect(holder).toBeDefined();
      if (!holder) throw new Error('claim missing');
      expect(claimLiveness({ ...holder, owner: { pid: 99999999, processToken: 'gone' } })).toBe('unknown');
    } finally {
      release();
      vi.unstubAllGlobals();
      identity.windows = false;
      identity.live = true;
      vi.restoreAllMocks();
      await streams.close().catch(() => {});
      if (pid) {
        try {
          realProcess.kill(pid, 'SIGKILL');
        } catch {}
      }
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === 'win32')('a pending claim write failure does not kill the stream leader', async () => {
  const home = mkdtempSync(join(tmpdir(), 'stim-stream-home-'));
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-stream-app-')));
  const bin = join(home, 'bin');
  mkdirSync(bin);
  vi.stubEnv('STIM_HOME', home);
  const pidFile = join(home, 'pid');
  const xcrun = join(bin, 'xcrun');
  writeFileSync(xcrun, '#!/bin/sh\necho $$ > "$TEST_PID"\nexec sleep 600\n');
  chmodSync(xcrun, 0o755);
  const env = { ...process.env, TEST_PID: pidFile, PATH: [bin, process.env.PATH].join(delimiter) };
  const streams = createStreams(() => {});
  const realProcess = process;
  let pid = 0;
  try {
    const { streamId } = await streams.start(
      { root, platform: 'ios', udid: 'U1', bundleId: 'com.test.app', appName: 'Test' },
      env,
    );
    pid = await waitForPid(pidFile);
    vi.spyOn(ownership, 'markClaimChildPending').mockImplementation(() => {
      throw new Error('write failed');
    });
    identity.windows = true;
    vi.stubGlobal('process', Object.create(realProcess, { platform: { value: 'win32' } }));
    await expect(streams.stop(root, 'ios', 'default', streamId)).rejects.toThrow('write failed');
    expect(() => realProcess.kill(pid, 0)).not.toThrow();
  } finally {
    vi.unstubAllGlobals();
    identity.windows = false;
    vi.restoreAllMocks();
    await streams.close().catch(() => {});
    if (pid) {
      try {
        realProcess.kill(pid, 'SIGKILL');
      } catch {}
    }
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === 'win32')('natural Windows stream exit keeps its child claim unresolved', async () => {
  const home = mkdtempSync(join(tmpdir(), 'stim-stream-home-'));
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-stream-app-')));
  const bin = join(home, 'bin');
  mkdirSync(bin);
  vi.stubEnv('STIM_HOME', home);
  const pidFile = join(home, 'pid');
  const done = join(home, 'done');
  const xcrun = join(bin, 'xcrun');
  writeFileSync(xcrun, '#!/bin/sh\necho $$ > "$TEST_PID"\nwhile [ ! -f "$DONE" ]; do sleep .05; done\n');
  chmodSync(xcrun, 0o755);
  const env = { ...process.env, TEST_PID: pidFile, DONE: done, PATH: [bin, process.env.PATH].join(delimiter) };
  const messages: string[] = [];
  const streams = createStreams((message) => messages.push(message));
  const realProcess = process;
  const executor = getExecutor();
  const originalSpawn = executor.spawn.bind(executor);
  const originalMark = markClaimChildPending;
  try {
    vi.spyOn(ownership, 'markClaimChildPending').mockImplementation((claim) => {
      originalMark(claim);
      identity.windows = true;
      vi.stubGlobal('process', Object.create(realProcess, { platform: { value: 'win32' } }));
    });
    vi.spyOn(executor, 'spawn').mockImplementation((file, args, options) => {
      vi.unstubAllGlobals();
      const child = originalSpawn(file, args, options);
      vi.stubGlobal('process', Object.create(realProcess, { platform: { value: 'win32' } }));
      return child;
    });
    const { streamId } = await streams.start(
      { root, platform: 'ios', udid: 'U1', bundleId: 'com.test.app', appName: 'Test' },
      env,
    );
    const pid = await waitForPid(pidFile);
    writeFileSync(done, '');
    await vi.waitFor(() => expect(() => realProcess.kill(pid, 0)).toThrow(/ESRCH/));
    await vi.waitFor(() =>
      expect(messages.some((message) => message.includes('could not be verified stopped'))).toBe(true),
    );
    vi.unstubAllGlobals();
    identity.windows = false;
    const claimRoot = join(
      workspaceDir(root),
      'log-streams',
      `stream-${createHash('sha256').update(streamId).digest('hex')}.claim`,
    );
    const holder = readClaimSet(claimRoot).live[0];
    expect(holder).toBeDefined();
    if (!holder) throw new Error('claim missing');
    expect(claimLiveness({ ...holder, owner: { pid: 99999999, processToken: 'gone' } })).toBe('unknown');
  } finally {
    vi.unstubAllGlobals();
    identity.windows = false;
    vi.restoreAllMocks();
    await streams.close().catch(() => {});
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === 'win32')(
  'a successful tree stop remains valid when pipe closure needs a retry',
  async () => {
    const home = mkdtempSync(join(tmpdir(), 'stim-stream-home-'));
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-stream-app-')));
    const bin = join(home, 'bin');
    mkdirSync(bin);
    vi.stubEnv('STIM_HOME', home);
    const pidFile = join(home, 'pid');
    const done = join(home, 'done');
    const xcrun = join(bin, 'xcrun');
    writeFileSync(xcrun, '#!/bin/sh\necho $$ > "$TEST_PID"\n(sleep 3; touch "$DONE") &\nexec sleep 600\n');
    chmodSync(xcrun, 0o755);
    const env = { ...process.env, TEST_PID: pidFile, DONE: done, PATH: [bin, process.env.PATH].join(delimiter) };
    const streams = createStreams(() => {});
    const realProcess = process;
    let pid = 0;
    try {
      const { streamId } = await streams.start(
        { root, platform: 'ios', udid: 'U1', bundleId: 'com.test.app', appName: 'Test' },
        env,
      );
      pid = await waitForPid(pidFile);
      vi.spyOn(getExecutor(), 'runFileAsync').mockImplementation(async () => {
        identity.live = false;
        realProcess.kill(pid, 'SIGTERM');
        return '';
      });
      identity.windows = true;
      vi.stubGlobal('process', Object.create(realProcess, { platform: { value: 'win32' } }));
      await expect(streams.stop(root, 'ios', 'default', streamId)).rejects.toThrow('pipes did not close');
      await vi.waitFor(() => expect(existsSync(done)).toBe(true), { timeout: 3000 });
      const unregister = streamState.unregisterStreamAll;
      vi.spyOn(streamState, 'unregisterStreamAll').mockImplementation((...args) => {
        vi.unstubAllGlobals();
        return unregister(...args);
      });
      expect(await streams.stop(root, 'ios', 'default', streamId)).toBe(true);
    } finally {
      vi.unstubAllGlobals();
      identity.windows = false;
      identity.live = true;
      vi.restoreAllMocks();
      await streams.close().catch(() => {});
      if (pid) {
        try {
          realProcess.kill(pid, 'SIGKILL');
        } catch {}
      }
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  },
  10000,
);

test.skipIf(process.platform === 'win32')(
  'a failed Windows tree stop keeps the launcher alive for a successful retry',
  async () => {
    const home = mkdtempSync(join(tmpdir(), 'stim-stream-home-'));
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-stream-app-')));
    const bin = join(home, 'bin');
    mkdirSync(bin);
    vi.stubEnv('STIM_HOME', home);
    const pidFile = join(home, 'pid');
    const xcrun = join(bin, 'xcrun');
    writeFileSync(xcrun, '#!/bin/sh\necho $$ > "$TEST_PID"\nexec sleep 600\n');
    chmodSync(xcrun, 0o755);
    const env = { ...process.env, TEST_PID: pidFile, PATH: [bin, process.env.PATH].join(delimiter) };
    const streams = createStreams(() => {});
    const realProcess = process;
    let pid = 0;
    let attempts = 0;
    try {
      const { streamId } = await streams.start(
        { root, platform: 'ios', udid: 'U1', bundleId: 'com.test.app', appName: 'Test' },
        env,
      );
      pid = await waitForPid(pidFile);
      vi.spyOn(getExecutor(), 'runFileAsync').mockImplementation(async () => {
        if (++attempts === 1) throw new Error('taskkill failed');
        identity.live = false;
        vi.unstubAllGlobals();
        realProcess.kill(pid, 'SIGTERM');
        return '';
      });
      identity.windows = true;
      vi.stubGlobal('process', Object.create(realProcess, { platform: { value: 'win32' } }));
      await expect(streams.stop(root, 'ios', 'default', streamId)).rejects.toThrow('could not be stopped');
      expect(() => realProcess.kill(pid, 0)).not.toThrow();
      expect(await streams.stop(root, 'ios', 'default', streamId)).toBe(true);
      expect(attempts).toBe(2);
    } finally {
      vi.unstubAllGlobals();
      identity.windows = false;
      identity.live = true;
      vi.restoreAllMocks();
      await streams.close().catch(() => {});
      if (pid) {
        try {
          realProcess.kill(pid, 'SIGKILL');
        } catch {}
      }
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === 'win32')('unknown Windows identity leaves the launcher alive', async () => {
  const home = mkdtempSync(join(tmpdir(), 'stim-stream-home-'));
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-stream-app-')));
  const bin = join(home, 'bin');
  mkdirSync(bin);
  vi.stubEnv('STIM_HOME', home);
  const pidFile = join(home, 'pid');
  const xcrun = join(bin, 'xcrun');
  writeFileSync(xcrun, '#!/bin/sh\necho $$ > "$TEST_PID"\nexec sleep 600\n');
  chmodSync(xcrun, 0o755);
  const env = { ...process.env, TEST_PID: pidFile, PATH: [bin, process.env.PATH].join(delimiter) };
  const streams = createStreams(() => {});
  const realProcess = process;
  let pid = 0;
  try {
    const { streamId } = await streams.start(
      { root, platform: 'ios', udid: 'U1', bundleId: 'com.test.app', appName: 'Test' },
      env,
    );
    pid = await waitForPid(pidFile);
    identity.windows = true;
    identity.unknown = true;
    vi.stubGlobal('process', Object.create(realProcess, { platform: { value: 'win32' } }));
    await expect(streams.stop(root, 'ios', 'default', streamId)).rejects.toThrow('could not be stopped');
    expect(() => realProcess.kill(pid, 0)).not.toThrow();
  } finally {
    vi.unstubAllGlobals();
    identity.windows = false;
    identity.unknown = false;
    vi.restoreAllMocks();
    await streams.close().catch(() => {});
    if (pid) {
      try {
        realProcess.kill(pid, 'SIGKILL');
      } catch {}
    }
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
