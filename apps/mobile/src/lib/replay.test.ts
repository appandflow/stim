import fixture from '../../../desktop/Tests/StimKitTests/Fixtures/replay-timeline-vectors.json';

import {
  adjacentAction,
  buildTimeline,
  LONG_GAP_MS,
  markerSeek,
  positionOf,
  replayDuration,
  stepFrom,
  timeAt,
  WINDOW_STEP_MS,
  type Timeline,
} from './replay';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const vectors = fixture as unknown as {
  timelines: {
    name: string;
    input: { spans: { start: number; end: number }[]; liveEnd?: number; previousLength?: number };
    timeline: Pick<Timeline, 'start' | 'end' | 'length' | 'pieces'>;
    positions: [number, number][];
    times: [number, number][];
  }[];
};

describe('the replay timeline vectors Stim Desktop replays too', () => {
  it.each(vectors.timelines.map((c) => [c.name, c] as const))('%s', (_, vector) => {
    const timeline = buildTimeline(vector.input.spans, vector.input.liveEnd, vector.input.previousLength)!;
    expect(timeline).toEqual({ ...vector.timeline, spans: vector.input.spans });
    expect(vector.positions.map(([at]) => [at, positionOf(timeline, at)])).toEqual(vector.positions);
    expect(vector.times.map(([position]) => [position, timeAt(timeline, position)])).toEqual(vector.times);
  });
});

describe('the replay timeline', () => {
  const spans = [
    { start: 0, end: 4 * MINUTE },
    { start: 2 * HOUR, end: 2 * HOUR + 6 * MINUTE },
  ];

  it('gives every recorded or short-stopped millisecond the same width', () => {
    const timeline = buildTimeline([
      { start: 0, end: 60_000 },
      { start: 90_000, end: 150_000 },
      { start: 160_000, end: 180_000 },
    ])!;
    const perSecond = (a: number, b: number) =>
      (positionOf(timeline, b * 1000) - positionOf(timeline, a * 1000)) / (b - a);
    expect(perSecond(10, 40)).toBeCloseTo(1 / 180, 6);
    expect(perSecond(65, 85)).toBeCloseTo(1 / 180, 6);
    expect(perSecond(100, 170)).toBeCloseTo(1 / 180, 6);
    expect(timeline.pieces[1]).toMatchObject({ kind: 'gap', collapsed: false });
    expect(timeAt(timeline, positionOf(timeline, 120_000))).toBeCloseTo(120_000, 3);
  });

  it('collapses only a stop longer than a minute, to a minute', () => {
    const timeline = buildTimeline(spans)!;
    const [first, gap, second] = timeline.pieces;
    expect(gap).toMatchObject({ kind: 'gap', start: 4 * MINUTE, end: 2 * HOUR, collapsed: true });
    expect((gap!.to - gap!.from) / (first!.to - first!.from)).toBeCloseTo(LONG_GAP_MS / (4 * MINUTE), 6);
    expect((second!.to - second!.from) / (first!.to - first!.from)).toBeCloseTo(1.5, 6);
    expect(second!.to).toBe(1);
  });

  it('keeps its scale while footage grows within a minute, and pads the room before the oldest footage', () => {
    const recording = [{ start: 0, end: 4 * MINUTE + 5_000 }];
    const before = buildTimeline(recording)!;
    const later = buildTimeline(recording, 4 * MINUTE + 15_000)!;
    const scale = (timeline: Timeline) => positionOf(timeline, 2 * MINUTE) - positionOf(timeline, MINUTE);
    expect(scale(later)).toBeCloseTo(scale(before), 9);
    expect(scale(before)).toBeCloseTo(MINUTE / WINDOW_STEP_MS / 5, 9);
    expect(before.pieces[0]!.from).toBeCloseTo(55_000 / (5 * MINUTE), 9);
    expect(later.end).toBe(4 * MINUTE + 15_000);
    expect(positionOf(later, later.end)).toBe(1);
    expect(timeAt(later, 0)).toBe(0);
    const next = buildTimeline(recording, 5 * MINUTE + 1)!;
    expect(scale(next)).toBeCloseTo(MINUTE / WINDOW_STEP_MS / 6, 9);
  });

  it('keeps its length while footage hovers around a whole minute as the Mac prunes it', () => {
    const atCap = buildTimeline([{ start: 0, end: 15 * MINUTE }], 15 * MINUTE + 20_000)!;
    expect(atCap.length).toBe(16 * MINUTE);
    const pruned = buildTimeline([{ start: 25_000, end: 15 * MINUTE + 25_000 }], undefined, atCap.length)!;
    expect(pruned.length).toBe(16 * MINUTE);
    expect(buildTimeline([{ start: 25_000, end: 15 * MINUTE + 25_000 }])!.length).toBe(15 * MINUTE);
    expect(buildTimeline([{ start: 0, end: 5 * MINUTE }], undefined, atCap.length)!.length).toBe(5 * MINUTE);
  });

  it('maps a time to its place and back, and a place in a gap to the recording after it', () => {
    const timeline = buildTimeline(spans)!;
    const at = 2 * HOUR + 3 * MINUTE;
    expect(timeAt(timeline, positionOf(timeline, at))).toBeCloseTo(at, -1);
    const gap = timeline.pieces[1]!;
    expect(timeAt(timeline, (gap.from + gap.to) / 2)).toBe(2 * HOUR);
    expect(positionOf(timeline, 4 * MINUTE + (2 * HOUR - 4 * MINUTE) / 2)).toBeCloseTo((gap.from + gap.to) / 2, 9);
    expect(timeAt(timeline, -1)).toBe(0);
    expect(timeAt(timeline, 2)).toBe(2 * HOUR + 6 * MINUTE);
  });

  it('ends at the last recorded span, and is null without footage', () => {
    expect(buildTimeline(spans)!.end).toBe(spans.at(-1)!.end);
    expect(buildTimeline([])).toBeNull();
  });

  it('lands a little before a marker, but not before its span', () => {
    const timeline = buildTimeline(spans)!;
    expect(markerSeek(timeline, { at: 2 * MINUTE, kind: 'action', label: 'Tapped' })).toBe(2 * MINUTE - 1500);
    expect(markerSeek(timeline, { at: 2 * HOUR + 500, kind: 'error', label: 'boom' })).toBe(2 * HOUR);
  });

  it('names durations in their largest unit', () => {
    expect([40_000, 14 * MINUTE, 2 * HOUR, 72 * HOUR].map(replayDuration)).toEqual(['40s', '14m', '2h', '3d']);
  });

  it('steps to the next or previous agent action, skipping errors and the action it stands on', () => {
    const markers = [
      { at: 30_000, kind: 'action', label: 'tap "Settings"' },
      { at: 10_000, kind: 'action', label: 'open app' },
      { at: 20_000, kind: 'error', label: 'boom' },
      { at: 50_000, kind: 'action', label: 'type "hi"' },
    ] as const;
    expect(adjacentAction(markers, 12_000, 1)?.at).toBe(30_000);
    expect(adjacentAction(markers, 30_000, 1)?.at).toBe(50_000);
    expect(adjacentAction(markers, 50_000, 1)).toBeNull();
    expect(adjacentAction(markers, 40_000, -1)?.at).toBe(30_000);
    expect(adjacentAction(markers, 30_000, -1)?.at).toBe(10_000);
    expect(adjacentAction(markers, 10_000, -1)).toBeNull();
    expect(adjacentAction([], 0, 1)).toBeNull();
  });

  it('steps from the action it landed before, until the playhead passes it', () => {
    expect(stepFrom(26_500, 30_000, true)).toBe(30_000);
    expect(stepFrom(31_000, 30_000, true)).toBe(31_000);
    expect(stepFrom(40_000, 30_000, false)).toBe(30_000);
    expect(stepFrom(12_000, null, false)).toBe(12_000);
  });
});
