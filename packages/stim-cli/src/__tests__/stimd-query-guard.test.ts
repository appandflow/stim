import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import type { Worker } from 'node:worker_threads';
import type { RunCollectorOptions } from '../stimd/logs/collector.ts';
import { getExecutor } from '../exec.ts';
import { readClaimSet } from '../ownership-claim.ts';
import { workspaceDir } from '../workspace/paths.ts';
import { makeChildProcess } from './_factories.ts';

const state = vi.hoisted<{ options: RunCollectorOptions | null; child: ChildProcess | null; workers: Worker[] }>(
  () => ({ options: null, child: null, workers: [] }),
);
vi.mock('node:worker_threads', async (load) => {
  const actual = await load<typeof import('node:worker_threads')>();
  class CapturedWorker extends actual.Worker {
    constructor(...args: ConstructorParameters<typeof actual.Worker>) {
      super(...args);
      state.workers.push(this);
    }
  }
  return { ...actual, Worker: CapturedWorker };
});
vi.mock('../process-identity.ts', async (load) => {
  const actual = await load<typeof import('../process-identity.ts')>();
  return { ...actual, captureProcessToken: () => 'test-token', inspectProcessIdentity: () => 'same' };
});
vi.mock('../metro.ts', async (load) => {
  const actual = await load<typeof import('../metro.ts')>();
  return { ...actual, signalProcessTree: () => true };
});
vi.mock('../stimd/logs/collector.ts', () => ({
  runCollector: async (options: RunCollectorOptions) => {
    state.options = options;
    const child = options.startStream({ platform: 'android', serial: 'emulator', pid: 100 });
    return { child, writer: options.writer, finish: () => {}, settled: async () => {}, startedAt: '', pid: 100 };
  },
}));

test.skipIf(process.platform === 'win32')(
  'overlapping queries keep the marker through log exit, replacement and late cleanup failure',
  async () => {
    const { createStreams } = await import('../stimd/logs/streams.ts');
    const home = mkdtempSync(join(tmpdir(), 'stim-query-guard-home-'));
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-query-guard-root-')));
    vi.stubEnv('STIM_HOME', home);
    const streams = createStreams(() => {});
    let pid = 100000000;
    vi.spyOn(getExecutor(), 'spawn').mockImplementation(() => {
      state.child = makeChildProcess({ pid: ++pid });
      return state.child;
    });
    let firstDone = () => {};
    let failSecond: (error: Error) => void = () => {};
    const first = new Promise<void>((resolve) => {
      firstDone = resolve;
    });
    const second = new Promise<void>((_resolve, reject) => {
      failSecond = reject;
    });
    const failure = Object.assign(new Error('late query cleanup'), {
      code: 'STIM_CLAIM_UNAVAILABLE',
      reportCleanup: true,
    });
    try {
      const { streamId } = await streams.start(
        { root, platform: 'android', serial: 'emulator', packageName: 'com.test' },
        {},
      );
      await vi.waitFor(() => expect(state.options).not.toBeNull());
      if (!state.options?.guardQuery || !state.options.stopStream) throw new Error('collector seam unavailable');
      const guard = state.options.guardQuery;
      const one = guard(() => first);
      const two = guard(() => second);
      void two.catch(() => {});
      const claimRoot = join(
        workspaceDir(root),
        'log-streams',
        `stream-${createHash('sha256').update(streamId).digest('hex')}.claim`,
      );
      expect(readClaimSet(claimRoot).live[0]?.childPending).toBe(true);
      state.child?.emit('close');
      await state.options.stopStream(state.child);
      state.options.startStream({ platform: 'android', serial: 'emulator', pid: 200 });
      expect(readClaimSet(claimRoot).live[0]?.childPending).toBe(true);
      firstDone();
      await one;
      expect(readClaimSet(claimRoot).live[0]?.childPending).toBe(true);
      failSecond(failure);
      await expect(two).rejects.toBe(failure);
      expect(readClaimSet(claimRoot).live[0]?.childPending).toBe(true);
    } finally {
      firstDone();
      failSecond(failure);
      await state.workers.at(-1)?.terminate();
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  },
);

describe.skipIf(process.platform === 'win32')('spawn failures with a pending query', () => {
  test.each(['throw', 'no-pid'])(
    'a %s spawn failure preserves the marker while a query remains active',
    async (failure) => {
      const { createStreams } = await import('../stimd/logs/streams.ts');
      const home = mkdtempSync(join(tmpdir(), 'stim-query-guard-home-'));
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-query-guard-root-')));
      vi.stubEnv('STIM_HOME', home);
      Reflect.set(state, 'options', null);
      const streams = createStreams(() => {});
      const spawn = vi.spyOn(getExecutor(), 'spawn').mockImplementation(() => {
        state.child = makeChildProcess({ pid: 100000001 });
        return state.child;
      });
      let release = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      try {
        const { streamId } = await streams.start(
          { root, platform: 'android', serial: 'emulator', packageName: 'com.test' },
          {},
        );
        await vi.waitFor(() => expect(state.options).not.toBeNull());
        if (!state.options?.guardQuery || !state.options.stopStream) throw new Error('collector seam unavailable');
        const query = state.options.guardQuery(() => held);
        state.child?.emit('close');
        await state.options.stopStream(state.child);
        spawn.mockImplementation(() => {
          if (failure === 'throw') throw new Error('spawn failed');
          return makeChildProcess({ pid: undefined });
        });
        expect(() => state.options?.startStream({ platform: 'android', serial: 'emulator', pid: 200 })).toThrow(
          failure === 'throw' ? 'spawn failed' : 'could not start',
        );
        const claimRoot = join(
          workspaceDir(root),
          'log-streams',
          `stream-${createHash('sha256').update(streamId).digest('hex')}.claim`,
        );
        expect(readClaimSet(claimRoot).live[0]?.childPending).toBe(true);
        release();
        await query;
      } finally {
        release();
        await state.workers.at(-1)?.terminate();
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
        rmSync(home, { recursive: true, force: true });
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
