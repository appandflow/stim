import type { ReplayMarker, ReplaySpan } from '@/protocol/types';

/** A gap takes this share of the recorded time on the track, so hours stopped do not squeeze the footage flat. */
const GAP_SHARE = 0.08;
const MIN_GAP_WEIGHT_MS = 2000;

export type TimelinePiece =
  | { kind: 'span'; start: number; end: number; from: number; to: number }
  | { kind: 'gap'; start: number; end: number; from: number; to: number };

/**
 * The scrubber's track: recorded spans laid end to end in proportion to their length, with each unrecorded gap
 * between them drawn at a fixed width. `from` and `to` are the piece's place on the track, 0 to 1.
 */
export interface Timeline {
  start: number;
  end: number;
  pieces: TimelinePiece[];
}

/** `end` extends the last span, while the device is still recorded, to now. */
export function buildTimeline(spans: readonly ReplaySpan[], end?: number): Timeline | null {
  if (!spans.length) return null;
  const merged = spans.map((span, index) =>
    index === spans.length - 1 && end !== undefined ? { start: span.start, end: Math.max(span.end, end) } : span,
  );
  const recorded = merged.reduce((sum, span) => sum + Math.max(span.end - span.start, 1), 0);
  const gapWeight = Math.max(recorded * GAP_SHARE, MIN_GAP_WEIGHT_MS);
  const total = recorded + gapWeight * (merged.length - 1);
  const pieces: TimelinePiece[] = [];
  let at = 0;
  merged.forEach((span, index) => {
    if (index > 0) {
      const previous = merged[index - 1]!;
      pieces.push({ kind: 'gap', start: previous.end, end: span.start, from: at, to: at + gapWeight / total });
      at += gapWeight / total;
    }
    const width = Math.max(span.end - span.start, 1) / total;
    pieces.push({ kind: 'span', start: span.start, end: span.end, from: at, to: at + width });
    at += width;
  });
  return { start: merged[0]!.start, end: merged.at(-1)!.end, pieces };
}

/** How much footage the timeline holds, gaps left out. */
export function recordedLength(timeline: Timeline): number {
  return timeline.pieces.reduce((sum, piece) => sum + (piece.kind === 'span' ? piece.end - piece.start : 0), 0);
}

/** Where `at` sits on the track, 0 to 1; a time in a gap sits at the gap's end. */
export function positionOf(timeline: Timeline, at: number): number {
  for (const piece of timeline.pieces) {
    if (at > piece.end) continue;
    if (piece.kind === 'gap') return piece.to;
    if (at <= piece.start) return piece.from;
    return piece.from + ((at - piece.start) / (piece.end - piece.start || 1)) * (piece.to - piece.from);
  }
  return 1;
}

/** The time at `position` on the track; a gap resolves to the start of the recording after it. */
export function timeAt(timeline: Timeline, position: number): number {
  const clamped = Math.min(1, Math.max(0, position));
  for (const piece of timeline.pieces) {
    if (clamped > piece.to) continue;
    if (piece.kind === 'gap') return piece.end;
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

export const MARKER_TITLES: Record<ReplayMarker['kind'], string> = {
  action: 'Agent',
  error: 'Error',
  crash: 'Crash',
};
