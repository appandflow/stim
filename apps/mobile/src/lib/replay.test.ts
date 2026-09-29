import {
  buildTimeline,
  layoutGapLabels,
  LONG_GAP_MS,
  markerSeek,
  positionOf,
  shortDuration,
  timeAt,
  WINDOW_STEP_MS,
  type Timeline,
} from './replay';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

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
    expect([40_000, 14 * MINUTE, 2 * HOUR, 72 * HOUR].map(shortDuration)).toEqual(['40s', '14m', '2h', '3d']);
  });

  it('lays out several stopped labels near the start without overlap, inside the track, longest stop first', () => {
    const timeline = buildTimeline([
      { start: 0, end: 1_000 },
      { start: 12_000, end: 14_000 },
      { start: 60_000, end: 62_000 },
      { start: 86_000, end: 4 * MINUTE },
    ])!;
    const width = 360;
    const labels = layoutGapLabels(timeline.pieces, width);
    expect(labels.map((label) => label.text)).toEqual(['stopped 46s']);
    const wide = layoutGapLabels(timeline.pieces, 2000);
    expect(wide.map((label) => label.text)).toEqual(['stopped 11s', 'stopped 46s', 'stopped 24s']);
    const edge = buildTimeline([
      { start: 0, end: 1_000 },
      { start: 12_000, end: 4 * MINUTE },
    ])!;
    expect(layoutGapLabels(edge.pieces, width)[0]!.left).toBe(0);
    for (const [laid, trackWidth] of [
      [labels, width],
      [wide, 2000],
    ] as const) {
      for (const [index, label] of laid.entries()) {
        expect(label.left).toBeGreaterThanOrEqual(0);
        expect(label.left + label.width).toBeLessThanOrEqual(trackWidth);
        const next = laid[index + 1];
        if (next) expect(label.left + label.width).toBeLessThanOrEqual(next.left);
      }
    }
  });

  it('keeps a stopped label at the right end inside the track, and drops one wider than the track', () => {
    const timeline = buildTimeline([
      { start: 0, end: 4 * MINUTE },
      { start: 4 * MINUTE + 30_000, end: 4 * MINUTE + 31_000 },
    ])!;
    const [label] = layoutGapLabels(timeline.pieces, 300);
    expect(label!.left + label!.width).toBeLessThanOrEqual(300);
    expect(layoutGapLabels(timeline.pieces, 40)).toEqual([]);
  });
});
