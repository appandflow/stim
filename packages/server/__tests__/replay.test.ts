import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listSegments } from '@stim-cli/core/state';
import { Player, readUnits, recordedSpans, timelineMarkers } from '../src/replay.ts';
import type { AccessUnit } from '../src/video.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stim-replay-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function record(capturedAt: number, keyframe: boolean, byte = 0): Buffer {
  const header = Buffer.alloc(17);
  header.writeUInt32BE(13 + 5, 0);
  header.writeUInt8(keyframe ? 1 : 0, 4);
  header.writeDoubleBE(capturedAt, 5);
  header.writeUInt16BE(330, 13);
  header.writeUInt16BE(720, 15);
  return Buffer.concat([header, Buffer.from([0, 0, 0, 1, byte])]);
}

/** A segment of units every 100 ms from `start`, a keyframe every `every` units. */
function segment(start: number, count: number, every = 5, open = false): string {
  const file = join(dir, open ? `${start}.part` : `${start}-${start + (count - 1) * 100}.seg`);
  writeFileSync(
    file,
    Buffer.concat(Array.from({ length: count }, (_, i) => record(start + i * 100, i % every === 0, i))),
  );
  return file;
}

test('reads the records of a segment and leaves out a record cut short at its end', () => {
  const file = segment(1000, 3);
  appendFileSync(file, record(1300, false).subarray(0, 10));
  expect(readUnits(file).map((unit) => [unit.capturedAt, unit.keyframe, unit.width, unit.height])).toEqual([
    [1000, true, 330, 720],
    [1100, false, 330, 720],
    [1200, false, 330, 720],
  ]);
});

test('joins adjacent segments into spans and keeps the gap where nothing was recorded', () => {
  segment(1000, 10);
  segment(1900, 10);
  segment(7_200_000, 10);
  expect(recordedSpans(listSegments(dir))).toEqual([
    { start: 1000, end: 2800 },
    { start: 7_200_000, end: 7_200_900 },
  ]);
});

test('markers are the agent actions on this device and errors of the workspace, oldest first', () => {
  const records = [
    { ts: 900, src: 'agent', event: 'agent_action', platform: 'ios', command: 'press', msg: 'too early' },
    {
      ts: 3200,
      startedAt: 1200,
      src: 'agent',
      event: 'agent_action',
      platform: 'ios',
      command: 'press',
      msg: 'press @e3',
    },
    {
      ts: 1250,
      src: 'agent',
      level: 'error',
      event: 'agent_failed',
      platform: 'ios',
      command: 'fill',
      msg: 'Failed fill',
    },
    { ts: 1100, src: 'agent', event: 'agent_action', platform: 'web', command: 'click', msg: 'other device' },
    { ts: 1300, src: 'agent', event: 'agent_action', platform: 'ios', slot: 'tablet', msg: 'other slot' },
    { ts: 1400, src: 'metro', level: 'error', msg: 'Unable to resolve module\n  at line 3' },
    { ts: 1500, src: 'device', level: 'fatal', platform: 'ios', event: 'native_crash', msg: 'crashed' },
    { ts: 1600, src: 'device', level: 'error', platform: 'android', msg: 'android only' },
    { ts: 1700, src: 'client', level: 'warn', msg: 'a warning' },
  ];
  expect(timelineMarkers(records, 'ios', 'default', 1000)).toEqual([
    { at: 1200, kind: 'action', command: 'press', label: 'press @e3' },
    { at: 1250, kind: 'action', command: 'fill', label: 'Failed fill' },
    { at: 1400, kind: 'error', label: 'Unable to resolve module' },
    { at: 1500, kind: 'crash', label: 'crashed' },
  ]);
});

test("a non-default slot gets the workspace's errors, and only its own device and agent records", () => {
  const records = [
    { ts: 1100, src: 'metro', level: 'error', msg: 'bundle failed' },
    { ts: 1200, src: 'device', level: 'error', platform: 'ios', msg: 'default slot device' },
    { ts: 1300, src: 'device', level: 'error', platform: 'ios', slot: 'tablet', msg: 'tablet device' },
    { ts: 1400, src: 'agent', event: 'agent_action', platform: 'ios', msg: 'default slot action' },
  ];
  expect(timelineMarkers(records, 'ios', 'tablet', 0).map((marker) => marker.label)).toEqual([
    'bundle failed',
    'tablet device',
  ]);
});

function player(): { player: Player; sent: AccessUnit[]; ended: number[] } {
  const sent: AccessUnit[] = [];
  const ended: number[] = [];
  const created = new Player(
    dir,
    { unit: (unit) => sent.push(unit), bufferedBytes: () => 0, ended: (at) => ended.push(at) },
    1024,
  );
  return { player: created, sent, ended };
}

test('a paused seek sends the units from the keyframe before the time through the frame at it', () => {
  segment(1000, 20);
  const { player: paused, sent } = player();

  expect(paused.seek(1730, 0)).toBe(1700);
  expect(sent.map((unit) => unit.capturedAt)).toEqual([1500, 1600, 1700]);
  expect(sent[0]!.keyframe).toBe(true);
  expect(paused.seek(500, 0)).toBe(1000);
  expect(paused.seek(10_000, 0)).toBe(2900);
  rmSync(join(dir, '1000-2900.seg'));
  expect(paused.seek(1000, 0)).toBeNull();
});

test('a seek waits for the client to drain before it sends the frame, and a newer seek replaces it', async () => {
  segment(1000, 20);
  let buffered = 10_000;
  const sent: number[] = [];
  const congested = new Player(
    dir,
    { unit: (unit) => sent.push(unit.capturedAt), bufferedBytes: () => buffered, ended: () => {} },
    1024,
  );

  expect(congested.seek(1300, 0)).toBe(1300);
  expect(congested.seek(1700, 0)).toBe(1700);
  expect(sent).toEqual([]);
  buffered = 0;
  await vi.waitUntil(() => sent.length > 0, { timeout: 1000 });
  expect(sent).toEqual([1500, 1600, 1700]);
});

test('plays on at the rate asked, skips unrecorded time, and reports the end', async () => {
  segment(1000, 3);
  segment(60_000, 3, 5, true);
  const { player: playing, sent, ended } = player();
  const started = Date.now();

  playing.seek(1000, 2);
  await vi.waitUntil(() => ended.length > 0, { timeout: 2000 });

  expect(sent.map((unit) => unit.capturedAt)).toEqual([1000, 1100, 1200, 60_000, 60_100, 60_200]);
  expect(ended).toEqual([60_200]);
  const took = Date.now() - started;
  expect(took).toBeGreaterThanOrEqual(180);
  expect(took).toBeLessThan(1000);
});
