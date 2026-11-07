import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { readWorkspaceState } from '../workspace/workspace-state.ts';

const fault = vi.hoisted(() => ({ fail: true }));
vi.mock('../stimd/logs/state.ts', async (original) => {
  const actual = await original<typeof import('../stimd/logs/state.ts')>();
  return {
    ...actual,
    unregisterStreamAll: (...args: Parameters<typeof actual.unregisterStreamAll>) => {
      if (fault.fail) {
        fault.fail = false;
        throw new Error('state write failed');
      }
      return actual.unregisterStreamAll(...args);
    },
  };
});

describe.skipIf(process.platform === 'win32')('device stream cleanup', () => {
  test('a later stop retries a failed state write after the claim was released', async () => {
    const { createStreams } = await import('../stimd/logs/streams.ts');
    const home = mkdtempSync(join(tmpdir(), 'stim-log-cleanup-home-'));
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-log-cleanup-app-')));
    const bin = join(home, 'bin');
    mkdirSync(bin);
    vi.stubEnv('STIM_HOME', home);
    const xcrun = join(bin, 'xcrun');
    writeFileSync(xcrun, '#!/bin/sh\nexec sleep 600\n');
    chmodSync(xcrun, 0o755);
    const env = { ...process.env, STIM_HOME: home, PATH: [bin, process.env.PATH].join(delimiter) };
    const messages: string[] = [];
    const streams = createStreams((message) => messages.push(message));
    try {
      const spec = { root, platform: 'ios' as const, udid: 'U1', bundleId: 'com.test.app', appName: 'Test' };
      const { streamId } = await streams.start(spec, env);
      await expect(streams.stop(root, 'ios', 'default', streamId)).rejects.toThrow('could not be stopped');
      expect(readWorkspaceState(root)?.collectors?.ios).toMatchObject({ streamId });
      expect(messages.some((message) => message.includes('state write failed'))).toBe(true);
      expect(await streams.stop(root, 'ios', 'default', streamId)).toBe(true);
      expect(readWorkspaceState(root)?.collectors).toBeUndefined();
      const next = await streams.start(spec, env);
      expect(await streams.stop(root, 'ios', 'default', next.streamId)).toBe(true);
    } finally {
      await streams.close().catch(() => {});
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });
});
