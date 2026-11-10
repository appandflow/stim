import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import type { Worker } from 'node:worker_threads';
import type { RunCollectorOptions } from '../stimd/logs/collector.ts';
import { getExecutor } from '../exec.ts';
import { makeChildProcess } from './_factories.ts';

const state = vi.hoisted<{
  options: RunCollectorOptions | null;
  windows: boolean;
  alive: boolean;
  child: ChildProcess | null;
  workers: Worker[];
}>(() => ({ options: null, windows: false, alive: true, child: null, workers: [] }));
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
  return {
    ...actual,
    captureProcessToken: (pid: number) => (state.windows ? 'test-token' : actual.captureProcessToken(pid)),
    inspectProcessIdentity: () => (state.alive ? 'same' : 'gone'),
  };
});
vi.mock('../stimd/logs/collector.ts', () => ({
  runCollector: async (options: RunCollectorOptions) => {
    state.options = options;
    const child = options.startStream({ platform: 'android', serial: 'emulator-1', pid: 100 });
    return { child, writer: options.writer, finish: () => {}, settled: async () => {}, startedAt: '', pid: 100 };
  },
}));

test.skipIf(process.platform === 'win32')('a previous tree stop does not verify a replacement child', async () => {
  const { createStreams } = await import('../stimd/logs/streams.ts');
  const home = mkdtempSync(join(tmpdir(), 'stim-reattach-home-'));
  const root = mkdtempSync(join(tmpdir(), 'stim-reattach-root-'));
  vi.stubEnv('STIM_HOME', home);
  const realProcess = process;
  const messages: string[] = [];
  const streams = createStreams((message) => messages.push(message));
  let pid = 1000;
  try {
    vi.spyOn(getExecutor(), 'findExecutable').mockReturnValue('C:\\adb.exe');
    vi.spyOn(getExecutor(), 'spawn').mockImplementation(() => {
      state.windows = true;
      vi.stubGlobal('process', Object.create(realProcess, { platform: { value: 'win32' } }));
      state.alive = true;
      state.child = makeChildProcess({ pid: ++pid });
      return state.child;
    });
    vi.spyOn(getExecutor(), 'runFileAsync').mockImplementation(async () => {
      state.alive = false;
      state.child?.emit('close');
      return '';
    });
    await streams.start(
      { root, platform: 'android', serial: 'emulator-1', packageName: 'com.test' },
      { PATH: 'tools' },
    );
    await vi.waitFor(() => expect(state.options).not.toBeNull());
    if (!state.options?.stopStream) throw new Error('collector not started');
    await state.options.stopStream(state.child);
    try {
      state.options.startStream({ platform: 'android', serial: 'emulator-1', pid: 200 });
    } catch (error) {
      console.error('REATTACH ERROR', error);
      throw error;
    }

    state.alive = false;
    state.child?.emit('close');
    state.options.writer?.close();
    state.options.onExit(0);

    await vi.waitFor(() =>
      expect(messages.some((message) => message.includes('could not be verified stopped'))).toBe(true),
    );
    expect(streams.running()).toBe(true);
  } finally {
    state.options?.writer?.close();
    state.options?.onExit(0);
    vi.unstubAllGlobals();
    state.windows = false;
    vi.restoreAllMocks();
    await state.workers.at(-1)?.terminate();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
