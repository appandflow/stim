import type { ReplayMarker, ReplaySpan } from '@/protocol/types';

/** A stop longer than this takes only this much of the track, so hours stopped do not squeeze the footage flat. */
export const LONG_GAP_MS = 60_000;
/**
 * The track's length is a whole number of these, so it rescales at most once per step as footage grows. It shrinks
 * only by two steps or more, so footage that hovers around a step as stim-server prunes it does not flip the scale.
 */
export const WINDOW_STEP_MS = 60_000;

export type TimelinePiece =
  | { kind: 'span'; start: number; end: number; from: number; to: number }
  | { kind: 'gap'; start: number; end: number; from: number; to: number; collapsed: boolean };

/**
 * The scrubber's track, one scale for every recorded span and unrecorded gap: a millisecond takes the same width
 * anywhere, except in a gap longer than `LONG_GAP_MS`, which takes `LONG_GAP_MS` and is `collapsed`. The track's
 * length is rounded up to a whole `WINDOW_STEP_MS`, with the spare room before the oldest footage, so its right edge
 * is the newest footage. `from` and `to` are a piece's place on the track, 0 to 1.
 */
export interface Timeline {
  start: number;
  end: number;
  spans: readonly ReplaySpan[];
  /** The track's length in milliseconds of track time. */
  length: number;
  pieces: TimelinePiece[];
}

/**
 * Every time on the timeline is a Mac capture time; a device still recorded ends at its newest footage, or at
 * `liveEnd` when that is later, the Mac's estimated time now. `previousLength` is the length of the track shown
 * before, which the new one keeps unless footage grew past it or shrank by two steps.
 */
export function buildTimeline(
  spans: readonly ReplaySpan[],
  liveEnd?: number,
  previousLength?: number,
): Timeline | null {
  if (!spans.length) return null;
  const last = spans.at(-1)!;
  const shown =
    liveEnd !== undefined && liveEnd > last.end ? [...spans.slice(0, -1), { ...last, end: liveEnd }] : spans;
  const weights = shown.flatMap((span, index) => {
    const gap = index > 0 ? Math.min(span.start - shown[index - 1]!.end, LONG_GAP_MS) : 0;
    return [Math.max(gap, 0), Math.max(span.end - span.start, 1)];
  });
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const fitted = Math.max(1, Math.ceil(total / WINDOW_STEP_MS)) * WINDOW_STEP_MS;
  const length =
    previousLength !== undefined && fitted < previousLength && previousLength - fitted < 2 * WINDOW_STEP_MS
      ? previousLength
      : fitted;
  const pieces: TimelinePiece[] = [];
  let at = length - total;
  shown.forEach((span, index) => {
    if (index > 0) {
      const previous = shown[index - 1]!;
      const weight = weights[index * 2]!;
      pieces.push({
        kind: 'gap',
        start: previous.end,
        end: span.start,
        from: at / length,
        to: (at + weight) / length,
        collapsed: span.start - previous.end > LONG_GAP_MS,
      });
      at += weight;
    }
    const weight = weights[index * 2 + 1]!;
    pieces.push({ kind: 'span', start: span.start, end: span.end, from: at / length, to: (at + weight) / length });
    at += weight;
  });
  return { start: shown[0]!.start, end: shown.at(-1)!.end, spans, length, pieces };
}

/** How much footage the timeline holds, gaps left out. */
export function recordedLength(timeline: Timeline): number {
  return timeline.pieces.reduce((sum, piece) => sum + (piece.kind === 'span' ? piece.end - piece.start : 0), 0);
}

/** Where `at` sits on the track, 0 to 1; a time before the oldest footage sits where the footage starts. */
export function positionOf(timeline: Timeline, at: number): number {
  for (const piece of timeline.pieces) {
    if (at > piece.end) continue;
    if (at <= piece.start) return piece.from;
    return piece.from + ((at - piece.start) / (piece.end - piece.start || 1)) * (piece.to - piece.from);
  }
  return 1;
}

/**
 * The time at `position` on the track. A gap resolves to the start of the recording after it, and the room before
 * the oldest footage to its start.
 */
export function timeAt(timeline: Timeline, position: number): number {
  const clamped = Math.min(1, Math.max(0, position));
  for (const piece of timeline.pieces) {
    if (clamped > piece.to) continue;
    if (piece.kind === 'gap') return piece.end;
    if (clamped <= piece.from) return piece.start;
    return piece.start + ((clamped - piece.from) / (piece.to - piece.from || 1)) * (piece.end - piece.start);
  }
  return timeline.end;
}

/** Where to land for a marker: a little before it, so the action plays out on screen. */
export function markerSeek(timeline: Timeline, marker: ReplayMarker, leadMs = 1500): number {
  const before = marker.at - leadMs;
  const piece = timeline.pieces.find((candidate) => candidate.kind === 'span' && marker.at <= candidate.end);
  return piece ? Math.max(before, piece.start) : Math.max(before, timeline.start);
}

/** "2h", "14m", "40s": how long a gap or an age is, in its largest unit. */
export function shortDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

/** The label of a paused or playing frame: its time of day, and how long ago it was. */
export function replayLabel(at: number, now: number, locale?: string): string {
  const time = new Date(at).toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit', second: '2-digit' });
  return `${time} · ${shortDuration(now - at)} ago`;
}

const LABEL_CHAR_WIDTH = 6.5;
const LABEL_GAP = 6;

export interface GapLabel {
  start: number;
  text: string;
  left: number;
  width: number;
}

/**
 * The "stopped" labels to draw under the track's gaps, at most one per place: each is centred under its gap and
 * kept inside the track, and a label that would overlap a longer stop's is left out. `width` is the track's in
 * points; a label's width is estimated from its length.
 */
export function layoutGapLabels(pieces: readonly TimelinePiece[], width: number): GapLabel[] {
  const placed: GapLabel[] = [];
  const gaps = pieces.filter((piece) => piece.kind === 'gap').sort((a, b) => b.end - b.start - (a.end - a.start));
  for (const gap of gaps) {
    const text = `stopped ${shortDuration(gap.end - gap.start)}`;
    const labelWidth = Math.ceil(text.length * LABEL_CHAR_WIDTH);
    if (labelWidth > width) continue;
    const center = ((gap.from + gap.to) / 2) * width;
    const left = Math.min(Math.max(0, center - labelWidth / 2), width - labelWidth);
    const overlaps = placed.some(
      (other) => left < other.left + other.width + LABEL_GAP && other.left < left + labelWidth + LABEL_GAP,
    );
    if (!overlaps) placed.push({ start: gap.start, text, left, width: labelWidth });
  }
  return placed.sort((a, b) => a.left - b.left);
}

export const MARKER_TITLES: Record<ReplayMarker['kind'], string> = {
  action: 'Agent',
  error: 'Error',
  crash: 'Crash',
};
