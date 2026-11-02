import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FeedListener } from '../src/feed.ts';
import type { Device, FramePool } from '../src/frames.ts';
import { Recorder, targetKey } from '../src/recorder.ts';

function status(basis: string[]) {
  return {
    environments: [
      {
        path: '/work/app',
        ios: {
          udid: 'SIM-1',
          owned: true,
          state: 'Booted',
          activity: { state: 'driven', driver: { tool: 'stim device lock', since: '2026-11-02T18:26:10.000Z' }, basis },
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
    ['records a locked device no web share controls', false, ['device-lock'], 1],
    ['does not record a device a web share controls through its lease alone', true, ['device-lock'], 0],
    ['records a shared device another tool also drives', true, ['device-lock', 'driver-process'], 1],
  ])('%s', (_name, shared, basis, recordings) => {
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
        listener.item(status(basis) as never, '');
        return () => {};
      },
      unrecordedTargets: () =>
        new Set(shared ? [targetKey({ workspace: '/work/app', platform: 'ios', slot: 'default' })] : []),
    });
    recorder.close();
    expect(recorded).toHaveLength(recordings);
  });
});
