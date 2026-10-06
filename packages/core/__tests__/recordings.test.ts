import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  capDrops,
  footageDrops,
  listRecordedDevices,
  listSegments,
  recordingEnabled,
  type RecordedDevice,
  type RecordedSegment,
} from '../state/recordings.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stim-recordings-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function segment(start: number, end: number, bytes = 10, open = false): RecordedSegment {
  return { file: `${start}`, start, end, bytes, open };
}

test('lists each device slot, with the open segment ending at its last write', () => {
  const ios = join(dir, 'ios-default');
  mkdirSync(ios);
  mkdirSync(join(dir, 'android-tablet'));
  writeFileSync(join(ios, '1000-4000.seg'), 'abc');
  writeFileSync(join(ios, '4000.part'), 'ab');
  utimesSync(join(ios, '4000.part'), 9, 9);
  writeFileSync(join(ios, 'notes.txt'), 'x');
  mkdirSync(join(dir, 'unknown-thing'));
  mkdirSync(join(dir, 'tmp'));

  expect(listRecordedDevices(dir).toSorted((a, b) => a.platform.localeCompare(b.platform))).toEqual([
    { platform: 'android', slot: 'tablet', dir: join(dir, 'android-tablet'), segments: [] },
    {
      platform: 'ios',
      slot: 'default',
      dir: ios,
      segments: [
        { file: join(ios, '1000-4000.seg'), start: 1000, end: 4000, bytes: 3, open: false },
        { file: join(ios, '4000.part'), start: 4000, end: 9000, bytes: 2, open: true },
      ],
    },
  ]);
  expect(listSegments(ios, true)).toEqual([
    { file: join(ios, '1000-4000.seg'), start: 1000, end: 4000, bytes: 3, open: false },
  ]);
});

test('keeps the last footage however long the device sat unrecorded between segments', () => {
  const old = segment(0, 60_000);
  const afterStop = segment(7_200_000, 7_260_000);
  const open = segment(7_260_000, 7_300_000, 10, true);

  expect(footageDrops([old, afterStop, open], 100_000)).toEqual([old]);
  expect(footageDrops([old, afterStop, open], 160_000)).toEqual([]);
  expect(footageDrops([open], 1)).toEqual([]);
});

test('the disk cap drops the oldest closed footage across devices first', () => {
  const device = (segments: RecordedSegment[]): RecordedDevice => ({ platform: 'ios', slot: 'x', dir, segments });
  const a1 = segment(0, 10, 40);
  const b1 = segment(5, 20, 40);
  const a2 = segment(30, 40, 40, true);

  expect(capDrops([device([a1, a2]), device([b1])], 50)).toEqual([a1, b1]);
  expect(capDrops([device([a1, a2]), device([b1])], 90)).toEqual([a1]);
});

test('STIM_RECORDING wins over the workspace, repo and machine layers, which win in that order', () => {
  const off = { recording: { enabled: false } };
  const on = { recording: { enabled: true } };

  expect(recordingEnabled({}, [])).toBe(true);
  expect(recordingEnabled({}, [undefined, off, on])).toBe(false);
  expect(recordingEnabled({}, [on, off, off])).toBe(true);
  expect(recordingEnabled({ STIM_RECORDING: '0' }, [on])).toBe(false);
  expect(recordingEnabled({ STIM_RECORDING: 'true' }, [off])).toBe(true);
  expect(recordingEnabled({ STIM_RECORDING: 'nope' }, [off])).toBe(false);
});
