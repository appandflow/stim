import { buildTimeline, markerSeek, positionOf, recordedLength, shortDuration, timeAt } from './replay';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

describe('the replay timeline', () => {
  const spans = [
    { start: 0, end: 4 * MINUTE },
    { start: 2 * HOUR, end: 2 * HOUR + 6 * MINUTE },
  ];

  it('lays spans out by recorded length and gives a stopped gap a fixed width', () => {
    const timeline = buildTimeline(spans)!;
    const [first, gap, second] = timeline.pieces;
    expect(gap).toMatchObject({ kind: 'gap', start: 4 * MINUTE, end: 2 * HOUR });
    expect(gap!.to - gap!.from).toBeCloseTo((0.8 * MINUTE) / (10 * MINUTE + 0.8 * MINUTE), 5);
    expect((second!.to - second!.from) / (first!.to - first!.from)).toBeCloseTo(1.5, 5);
    expect(second!.to).toBeCloseTo(1, 5);
    expect(recordedLength(timeline)).toBe(10 * MINUTE);
  });

  it('maps a time to its place and back, and a place in a gap to the recording after it', () => {
    const timeline = buildTimeline(spans)!;
    const at = 2 * HOUR + 3 * MINUTE;
    expect(timeAt(timeline, positionOf(timeline, at))).toBeCloseTo(at, -1);
    const gap = timeline.pieces[1]!;
    expect(timeAt(timeline, (gap.from + gap.to) / 2)).toBe(2 * HOUR);
    expect(positionOf(timeline, HOUR)).toBe(gap.to);
    expect(timeAt(timeline, -1)).toBe(0);
    expect(timeAt(timeline, 2)).toBe(2 * HOUR + 6 * MINUTE);
  });

  it('extends the last span to now while the device is recorded', () => {
    expect(buildTimeline(spans, 3 * HOUR)!.end).toBe(3 * HOUR);
    expect(buildTimeline([])).toBeNull();
  });

  it('lands a little before a marker, but not before its span', () => {
    const timeline = buildTimeline(spans)!;
    expect(markerSeek(timeline, { at: 2 * MINUTE, kind: 'action', label: 'Tapped' })).toBe(2 * MINUTE - 1500);
    expect(markerSeek(timeline, { at: 2 * HOUR + 500, kind: 'error', label: 'boom' })).toBe(2 * HOUR);
  });

  it('names durations in their largest unit', () => {
    expect([40_000, 14 * MINUTE, 2 * HOUR, 72 * HOUR].map(shortDuration)).toEqual(['40s', '14m', '2h', '3d']);
  });
});
