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
import type { Worker } from 'node:worker_threads';
import { readWorkspaceState } from '../workspace/workspace-state.ts';
import { getExecutor } from '../exec.ts';
import { createStreams } from '../stimd/logs/streams.ts';

const identity = vi.hoisted<{ windows: boolean; live: boolean; workers: Worker[] }>(() => ({
  windows: false,
  live: true,
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
    inspectProcessIdentity: (...args: Parameters<typeof actual.inspectProcessIdentity>) =>
      identity.windows ? (identity.live ? 'same' : 'gone') : actual.inspectProcessIdentity(...args),
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
      await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true));
      const pid = Number(readFileSync(pidFile, 'utf8').trim());
      const executor = getExecutor();
      const run = vi.spyOn(executor, 'runFileAsync').mockImplementation(async (file, args, opts) => {
        expect(file).toBe(join('C:\\Windows-Test', 'System32', 'taskkill.exe'));
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
      await streams.start({ root, platform: 'ios', udid: 'U1', bundleId: 'com.test.app', appName: 'Test' }, env);
      await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true));
      pid = Number(readFileSync(pidFile, 'utf8').trim());
      const run = vi.spyOn(getExecutor(), 'runFileAsync').mockImplementation(async () => {
        await held;
        identity.live = false;
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
      await vi.waitFor(() =>
        expect(messages.some((message) => message.includes('could not be verified stopped'))).toBe(true),
      );
      expect(readWorkspaceState(root)?.collectors?.ios).toBeDefined();
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
