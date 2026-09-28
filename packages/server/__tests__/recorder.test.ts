import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workspaceStateDir } from '@stim-cli/core';
import { listSegments, workspaceRecordingsDir } from '@stim-cli/core/state';
import type { FeedListener } from '../src/feed.ts';
import type { FrameListener, FramePool } from '../src/frames.ts';
import { Recorder } from '../src/recorder.ts';

let root: string;
let recorder: Recorder | null = null;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stim-recorder-'));
  process.env.STIM_HOME = join(root, 'home');
});

afterEach(() => {
  recorder?.close();
  recorder = null;
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
  delete process.env.STIM_HOME;
});

const HOUR = 3_600_000;

function closedSegments(dir: string, ...ranges: [number, number][]): void {
  mkdirSync(dir, { recursive: true });
  for (const [start, end] of ranges) writeFileSync(join(dir, `${start}-${end}.seg`), 'x');
}

test.skipIf(process.platform === 'win32')('keeps a segment it cannot delete, logs it, and prunes the rest', () => {
  const locked = join(process.env.STIM_HOME!, 'workspaces', 'a', 'recordings', 'ios-default');
  const open = join(process.env.STIM_HOME!, 'workspaces', 'b', 'recordings', 'ios-default');
  closedSegments(locked, [1000, 2000], [3000, 4000]);
  closedSegments(open, [1000, 2000], [3000, 4000]);
  chmodSync(locked, 0o500);
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    recorder = new Recorder({
      frames: {} as FramePool,
      subscribeStatus: () => () => {},
      limits: { footageMs: 1000, pruneMs: HOUR, segmentMs: HOUR },
    });
  } finally {
    chmodSync(locked, 0o700);
  }
  expect(readdirSync(locked).toSorted()).toEqual(['1000-2000.seg', '3000-4000.seg']);
  expect(readdirSync(open)).toEqual(['3000-4000.seg']);
  expect(error).toHaveBeenCalledTimes(1);
  expect(error).toHaveBeenCalledWith(expect.stringContaining('could not delete the recording'));
});

test('starts a new segment when its recordings directory is deleted under it', () => {
  const workspace = join(root, 'app');
  mkdirSync(workspaceStateDir(workspace), { recursive: true });
  writeFileSync(join(workspaceStateDir(workspace), 'workspace.json'), '{}');
  const sim = { udid: 'SIM-1', owned: true, state: 'Booted', activity: { state: 'driven' } };
  const payload = { environments: [{ path: workspace, ios: sim, recording: { enabled: true } }] };
  let listener: FrameListener | null = null;
  const frames = {
    record: (_device: unknown, added: FrameListener) => {
      listener = added;
      return () => {};
    },
    recordKeyframe: () => {},
  } as unknown as FramePool;
  recorder = new Recorder({
    frames,
    subscribeStatus: (feed: FeedListener) => {
      feed.item(payload as never, JSON.stringify(payload));
      return () => {};
    },
    limits: { segmentMs: 1000, pruneMs: HOUR },
  });
  const unit = (capturedAt: number, keyframe: boolean) =>
    listener!.record!({ keyframe, capturedAt, width: 330, height: 720, data: Buffer.from([0, 0, 0, 1]) });
  const target = { workspace, platform: 'ios' as const, slot: 'default' };
  const dir = join(workspaceRecordingsDir(workspace), 'ios-default');

  unit(10_000, true);
  unit(10_100, false);
  rmSync(workspaceRecordingsDir(workspace), { recursive: true });
  unit(11_000, true);
  unit(11_100, false);
  unit(12_000, true);

  expect(recorder.recording(target)).toBe(true);
  expect(existsSync(dir)).toBe(true);
  expect(listSegments(dir).map(({ start, end, open }) => ({ start, end, open }))).toEqual([
    { start: 11_000, end: 12_000, open: false },
    { start: 12_000, end: expect.any(Number), open: true },
  ]);
});
