import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import type { Transferable } from 'node:worker_threads';

const state = vi.hoisted<{ onSync: (() => void) | null }>(() => ({ onSync: null }));
vi.mock('node:worker_threads', async (original) => {
  const actual = await original<typeof import('node:worker_threads')>();
  class Worker extends actual.Worker {
    override postMessage(value: unknown, transferList?: readonly Transferable[]): void {
      if (value && typeof value === 'object' && Reflect.get(value, 'op') === 'sync' && state.onSync) {
        const onSync = state.onSync;
        state.onSync = null;
        onSync();
      }
      super.postMessage(value, transferList);
    }
  }
  return { ...actual, Worker };
});

test.skipIf(process.platform === 'win32')('coverage synchronization and revision wait share one timeout', async () => {
  const { createStreams } = await import('../stimd/logs/streams.ts');
  const home = mkdtempSync(join(tmpdir(), 'stim-budget-home-'));
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-budget-app-')));
  const bin = join(home, 'bin');
  mkdirSync(bin);
  vi.stubEnv('STIM_HOME', home);
  const marker = join(home, 'history-started');
  const xcrun = join(bin, 'xcrun');
  writeFileSync(
    xcrun,
    '#!/bin/sh\ncase "$*" in *"log show"*) if [ -f "$MARKER" ]; then exec sleep 600; fi; touch "$MARKER"; echo \'{"eventType":"logEvent","eventMessage":"history"}\';; *) exec sleep 600;; esac\n',
  );
  chmodSync(xcrun, 0o755);
  const env = { ...process.env, STIM_HOME: home, MARKER: marker, PATH: [bin, process.env.PATH].join(delimiter) };
  const streams = createStreams(() => {});
  try {
    const { streamId } = await streams.start({ root, platform: 'ios', udid: 'U1', appName: 'Test' }, env);
    const signal = new AbortController().signal;
    const since = Date.now() - 1000;
    let reply = await streams.wait(root, 'ios', 'default', streamId, since, 0, 0, signal, env);
    while (reply.coverage === 'pending')
      reply = await streams.wait(root, 'ios', 'default', streamId, since, reply.revision, 1000, signal, env);
    expect(reply.coverage).toBe('covered');
    const now = Date.now() + 1;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    const timer = vi.spyOn(globalThis, 'setTimeout');
    state.onSync = () => clock.mockReturnValue(now + 150);
    reply = await streams.wait(root, 'ios', 'default', streamId, since, reply.revision, 200, signal, env, now, true);
    expect(reply.coverage).toBe('pending');
    expect(timer.mock.calls.some(([, ms]) => ms === 50)).toBe(true);
    clock.mockRestore();
    timer.mockRestore();
  } finally {
    state.onSync = null;
    vi.restoreAllMocks();
    await streams.close().catch(() => {});
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
