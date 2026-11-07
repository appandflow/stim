import type { LogSink } from '../stimd/logs/writer.ts';

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
    beforeFinish: () => {},
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
