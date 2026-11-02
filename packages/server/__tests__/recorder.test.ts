import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FeedListener } from '../src/feed.ts';
import type { Device, FramePool } from '../src/frames.ts';
import { Recorder } from '../src/recorder.ts';

const SHARE_LEASE = '2026-11-02T18:26:10.000Z';

function status(since: string) {
  return {
    environments: [
      {
        path: '/work/app',
        ios: {
          udid: 'SIM-1',
          owned: true,
          state: 'Booted',
          activity: { state: 'driven', driver: { tool: 'stim device lock', since }, basis: [] },
        },
      },
    ],
  };
}

describe('recording a driven device', () => {
  let home: string;
  const previous = process.env.STIM_HOME;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'stim-recorder-'));
    process.env.STIM_HOME = home;
  });
  afterEach(() => {
    if (previous === undefined) delete process.env.STIM_HOME;
    else process.env.STIM_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  });

  it.each([
    ['records a device driven through another lease', '2026-11-02T18:00:00.000Z', 1],
    ['does not record a device driven only through a web share control lease', SHARE_LEASE, 0],
  ])('%s', (_name, since, recordings) => {
    const recorded: Device[] = [];
    const frames = {
      record: (device: Device) => {
        recorded.push(device);
        return () => {};
      },
      recordKeyframe: () => {},
    } as unknown as FramePool;
    const recorder = new Recorder({
      frames,
      subscribeStatus: (listener: FeedListener) => {
        listener.item(status(since) as never, '');
        return () => {};
      },
      unrecordedLeases: () => new Set([SHARE_LEASE]),
    });
    recorder.close();
    expect(recorded).toHaveLength(recordings);
  });
});
