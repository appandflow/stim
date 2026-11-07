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
import { captureProcessToken, inspectProcessIdentity } from '../process-identity.ts';
import { readWorkspaceState } from '../workspace/workspace-state.ts';

const captured = vi.hoisted(() => ({ workers: [] as Worker[] }));
vi.mock('node:worker_threads', async (original) => {
  const actual = await original<typeof import('node:worker_threads')>();
  class CapturedWorker extends actual.Worker {
    constructor(...args: ConstructorParameters<typeof actual.Worker>) {
      super(...args);
      captured.workers.push(this);
    }
  }
  return { ...actual, Worker: CapturedWorker };
});

describe.skipIf(process.platform === 'win32')('logs worker failure', () => {
  test('main reaps its native child and releases the claim after the worker exits', async () => {
    const { createStreams } = await import('../stimd/logs/streams.ts');
    const home = mkdtempSync(join(tmpdir(), 'stim-worker-crash-home-'));
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-worker-crash-app-')));
    const bin = join(home, 'bin');
    mkdirSync(bin);
    vi.stubEnv('STIM_HOME', home);
    const pidFile = join(home, 'pid');
    const xcrun = join(bin, 'xcrun');
    writeFileSync(xcrun, '#!/bin/sh\necho $$ > "$TEST_PID"\nexec sleep 600\n');
    chmodSync(xcrun, 0o755);
    const env = { ...process.env, STIM_HOME: home, TEST_PID: pidFile, PATH: [bin, process.env.PATH].join(delimiter) };
    const messages: string[] = [];
    const streams = createStreams((message) => messages.push(message));
    let child: { pid: number; processToken: string } | null = null;
    try {
      await streams.start({ root, platform: 'ios', udid: 'U1', bundleId: 'com.test.app', appName: 'Test' }, env);
      await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true));
      const pid = Number(readFileSync(pidFile, 'utf8'));
      const token = captureProcessToken(pid);
      if (!token) throw new Error('the child has no process identity');
      child = { pid, processToken: token };
      const worker = captured.workers.at(-1);
      if (!worker) throw new Error('the logs worker was not started');
      await worker.terminate();
      await vi.waitFor(() => expect(streams.running()).toBe(false));
      expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);
      expect(readWorkspaceState(root)?.collectors).toBeUndefined();
      expect(messages.some((message) => message.includes('logs worker failed'))).toBe(true);
      const replacement = await streams.start(
        { root, platform: 'ios', udid: 'U1', bundleId: 'com.test.app', appName: 'Test' },
        env,
      );
      expect(await streams.stop(root, 'ios', 'default', replacement.streamId)).toBe(true);
    } finally {
      await streams.close().catch(() => {});
      if (child && inspectProcessIdentity(child) === 'same') process.kill(child.pid, 'SIGKILL');
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });
});
