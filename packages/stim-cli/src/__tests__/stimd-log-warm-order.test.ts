import type { LogSink } from '../stimd/logs/writer.ts';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { getExecutor } from '../exec.ts';
import { readClaimSet } from '../ownership-claim.ts';
import { workspaceDir } from '../workspace/paths.ts';
import { makeChildProcess } from './_factories.ts';

const state = vi.hoisted(() => ({ queued: false, visible: false }));

vi.mock('../stimd/logs/android.ts', async (original) => {
  const actual = await original<typeof import('../stimd/logs/android.ts')>();
  return {
    ...actual,
    waitForAppPid: async () => {
      state.queued = true;
      return { ok: true, pid: 3132 };
    },
    androidClockOffset: async () => 0,
  };
});

test('unverified history cleanup after spawn leaves the child claim pending', async () => {
  const { backfillDeviceLog } = await import('../stimd/logs/backfill.ts');
  const home = mkdtempSync(join(tmpdir(), 'stim-history-home-'));
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-history-root-')));
  vi.stubEnv('STIM_HOME', home);
  const failure = Object.assign(new Error('history cleanup unknown'), {
    code: 'STIM_CLAIM_UNAVAILABLE',
    reportCleanup: true,
  });
  vi.spyOn(getExecutor(), 'runFileAsync').mockImplementation(async (_file, _args, options) => {
    options.onSpawn?.(makeChildProcess({ pid: process.pid }));
    throw failure;
  });
  const sink: LogSink = {
    writer: {
      file: '',
      written: 0,
      dropped: 0,
      lastError: null,
      write: () => true,
      close: () => ({ file: '', written: 0, dropped: 0, lastError: null }),
    },
    line: () => {},
    sync: async () => {},
    beginBackfill: async () => {},
    backfillLine: () => {},
    endBackfill: async () => {
      throw new Error('sink failed');
    },
    addAlias: async () => {},
    removeAlias: async () => {},
    closed: async () => {},
  };
  try {
    await expect(
      backfillDeviceLog({
        root,
        streamId: 'ios',
        spec: { root, platform: 'ios', udid: 'simulator', appName: 'Test' },
        since: 0,
        env: {},
        signal: new AbortController().signal,
        warm: () => false,
        sink,
      }),
    ).rejects.toBe(failure);
    const claimRoot = join(
      workspaceDir(root),
      'log-backfills',
      `${createHash('sha256').update('ios').digest('hex')}.claim`,
    );
    expect(readClaimSet(claimRoot).live[0]?.childPending).toBe(true);
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('a queued live write failure during PID resolution prevents a warm history skip', async () => {
  const { backfillDeviceLog } = await import('../stimd/logs/backfill.ts');
  state.queued = false;
  state.visible = false;
  const sink: LogSink = {
    writer: {
      file: '',
      written: 0,
      dropped: 0,
      lastError: null,
      write: () => true,
      close: () => ({ file: '', written: 0, dropped: 0, lastError: null }),
    },
    line: () => {},
    sync: async () => {
      if (state.queued) state.visible = true;
    },
    beginBackfill: async () => {
      throw new Error('history required');
    },
    backfillLine: () => {},
    endBackfill: async () => {},
    addAlias: async () => {},
    removeAlias: async () => {},
    closed: async () => {},
  };
  await expect(
    backfillDeviceLog({
      root: '/unused',
      streamId: 'android',
      spec: { root: '/unused', platform: 'android', serial: 'emulator', packageName: 'com.test.app' },
      since: 0,
      env: {},
      signal: new AbortController().signal,
      warm: () => !state.visible,
      sink,
    }),
  ).rejects.toThrow('history required');
});
