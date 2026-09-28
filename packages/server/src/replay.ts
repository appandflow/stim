import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  listSegments,
  recordingDeviceName,
  workspaceRecordingsDir,
  type NdjsonRecord,
  type RecordedSegment,
  type RecordingPlatform,
} from '@stim-cli/core/state';
import { VIDEO_FOLDED, VIDEO_KEYFRAME, VIDEO_UNFOLDED, type ReplayMarker, type ReplaySpan } from './protocol.ts';
import type { AccessUnit } from './video.ts';

/** Segments less than this far apart are one span; a longer gap is time nothing was recorded. */
const SPAN_GAP_MS = 1500;
const MAX_ACTION_MARKERS = 400;
const MAX_ERROR_MARKERS = 100;
const MARKER_LABEL_CHARS = 120;

export function recordingDir(workspace: string, platform: RecordingPlatform, slot: string): string {
  return join(workspaceRecordingsDir(workspace), recordingDeviceName(platform, slot));
}

/** The access units of one segment file, in order; a record cut short at the end of a file being written is left out. */
export function readUnits(file: string): AccessUnit[] {
  let bytes: Buffer;
  try {
    bytes = readFileSync(file);
  } catch {
    return [];
  }
  const units: AccessUnit[] = [];
  for (let at = 0; at + 4 <= bytes.length;) {
    const length = bytes.readUInt32BE(at);
    if (length < 13 || at + 4 + length > bytes.length) break;
    const flags = bytes[at + 4]!;
    units.push({
      keyframe: (flags & VIDEO_KEYFRAME) !== 0,
      capturedAt: bytes.readDoubleBE(at + 5),
      width: bytes.readUInt16BE(at + 13),
      height: bytes.readUInt16BE(at + 15),
      data: bytes.subarray(at + 17, at + 4 + length),
      ...(flags & VIDEO_FOLDED ? { posture: 'folded' as const } : {}),
      ...(flags & VIDEO_UNFOLDED ? { posture: 'unfolded' as const } : {}),
    });
    at += 4 + length;
  }
  return units;
}

/** The recorded time ranges of one device slot, oldest first, with the gaps where nothing was recorded. */
export function recordedSpans(segments: readonly RecordedSegment[]): ReplaySpan[] {
  const spans: ReplaySpan[] = [];
  for (const segment of segments) {
    const last = spans.at(-1);
    if (last && segment.start - last.end <= SPAN_GAP_MS) last.end = Math.max(last.end, segment.end);
    else spans.push({ start: segment.start, end: segment.end });
  }
  return spans;
}

/**
 * Agent and device records name their slot only outside the default one; other records name none and belong to
 * every slot.
 */
function slotMatches(record: NdjsonRecord, slot: string): boolean {
  if (typeof record.slot === 'string') return record.slot === slot;
  return slot === 'default' || (record.src !== 'agent' && record.src !== 'device');
}

function label(text: unknown): string {
  const line = typeof text === 'string' ? (text.split('\n')[0] ?? '') : '';
  return line.length > MARKER_LABEL_CHARS ? `${line.slice(0, MARKER_LABEL_CHARS - 1)}...` : line;
}

/**
 * Timeline markers for one device slot from workspace log records: agent actions on it (agent-device's, and the
 * owned Chrome page's agent input), and errors. An error that names no platform or slot, like most Metro and
 * client errors, belongs to every device of the workspace. Keeps the newest 400 actions and 100 errors at or after `since`.
 */
export function timelineMarkers(
  records: readonly NdjsonRecord[],
  platform: RecordingPlatform,
  slot: string,
  since: number,
): ReplayMarker[] {
  const markers: ReplayMarker[] = [];
  for (const record of records) {
    const at =
      typeof record.startedAt === 'number' ? record.startedAt : typeof record.ts === 'number' ? record.ts : NaN;
    if (!(at >= since)) continue;
    const platformMatches = record.platform === undefined || record.platform === platform;
    if (!platformMatches || !slotMatches(record, slot)) continue;
    if (record.src === 'agent') {
      if (record.platform !== platform || (record.event !== 'agent_action' && record.event !== 'agent_failed'))
        continue;
      markers.push({
        at,
        kind: 'action',
        ...(typeof record.command === 'string' ? { command: record.command } : {}),
        label: label(record.msg),
      });
    } else if (record.level === 'error' || record.level === 'fatal') {
      markers.push({ at, kind: record.level === 'fatal' ? 'crash' : 'error', label: label(record.msg) });
    }
  }
  const sorted = markers.toSorted((a, b) => a.at - b.at);
  return [
    ...sorted.filter((marker) => marker.kind === 'action').slice(-MAX_ACTION_MARKERS),
    ...sorted.filter((marker) => marker.kind !== 'action').slice(-MAX_ERROR_MARKERS),
  ].toSorted((a, b) => a.at - b.at);
}

export interface PlayerOutput {
  unit: (unit: AccessUnit) => void;
  /** Bytes the client has not read yet; playback waits while it is over `congestedBytes`. */
  bufferedBytes: () => number;
  /** Playback reached the newest recorded unit; `at` is its capture time. */
  ended: (at: number) => void;
}

const CONGESTED_RETRY_MS = 50;

/**
 * Plays one device slot's recorded footage into a subscription. `seek` shows the frame at `at` at once, by sending
 * the units from the keyframe before it through it, and then plays on at `rate` (0 stays paused). Time where
 * nothing was recorded is skipped.
 */
export class Player {
  private readonly dir: string;
  private readonly output: PlayerOutput;
  private readonly congestedBytes: number;
  private timer: NodeJS.Timeout | null = null;
  private generation = 0;
  private position = 0;
  private rate = 0;
  stopped = false;

  constructor(dir: string, output: PlayerOutput, congestedBytes: number) {
    this.dir = dir;
    this.output = output;
    this.congestedBytes = congestedBytes;
  }

  /** The capture time of the last unit sent. */
  get at(): number {
    return this.position;
  }

  /** Returns the capture time of the frame shown, or null when nothing was recorded at or after `at`. */
  seek(at: number, rate: number): number | null {
    this.cancel();
    const generation = ++this.generation;
    this.rate = rate;
    const segments = listSegments(this.dir);
    const index = segments.findIndex((segment) => segment.end >= at);
    if (index === -1) return null;
    const units = readUnits(segments[index]!.file);
    const target = Math.max(at, segments[index]!.start);
    let first = -1;
    for (let i = 0; i < units.length && units[i]!.capturedAt <= target; i++) if (units[i]!.keyframe) first = i;
    if (first === -1) first = units.findIndex((unit) => unit.keyframe);
    if (first === -1) return null;
    let next = first;
    while (next < units.length && (next === first || units[next]!.capturedAt <= target)) next++;
    const shown = units[next - 1]!.capturedAt;
    const burst = () => {
      if (generation !== this.generation || this.stopped) return;
      if (this.output.bufferedBytes() > this.congestedBytes) {
        this.timer = setTimeout(burst, CONGESTED_RETRY_MS);
        return;
      }
      for (const unit of units.slice(first, next)) this.output.unit(unit);
      this.position = shown;
      if (rate > 0) this.play(generation, segments, index, units, next, Date.now(), shown);
    };
    this.position = shown;
    burst();
    return shown;
  }

  /** Sends the frame at the current position again, from its keyframe, for a client whose decoder lost its state. */
  resend(): void {
    if (this.position) this.seek(this.position, this.rate);
  }

  stop(): void {
    this.stopped = true;
    this.cancel();
  }

  private cancel(): void {
    this.generation++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private play(
    generation: number,
    segments: RecordedSegment[],
    index: number,
    units: AccessUnit[],
    next: number,
    wallStart: number,
    mediaStart: number,
  ): void {
    if (generation !== this.generation || this.stopped) return;
    let segmentIndex = index;
    let list = units;
    let at = next;
    while (at >= list.length) {
      const fresh = listSegments(this.dir);
      const current = fresh.findIndex((segment) => segment.start === segments[segmentIndex]?.start);
      const reread = current === -1 ? [] : readUnits(fresh[current]!.file);
      if (reread.length > list.length) {
        segments = fresh;
        segmentIndex = current;
        list = reread;
        break;
      }
      const following = fresh.findIndex((segment) => segment.start > (segments[segmentIndex]?.start ?? Infinity));
      if (following === -1) {
        this.output.ended(this.position);
        return;
      }
      segments = fresh;
      segmentIndex = following;
      list = readUnits(fresh[following]!.file);
      at = 0;
      if (list[0] && list[0].capturedAt - this.position > SPAN_GAP_MS) {
        wallStart = Date.now();
        mediaStart = list[0].capturedAt;
      }
    }
    const unit = list[at]!;
    const send = () => {
      if (generation !== this.generation || this.stopped) return;
      if (this.output.bufferedBytes() > this.congestedBytes) {
        stalled = true;
        this.timer = setTimeout(send, CONGESTED_RETRY_MS);
        return;
      }
      this.output.unit(unit);
      this.position = unit.capturedAt;
      if (stalled) this.play(generation, segments, segmentIndex, list, at + 1, Date.now(), unit.capturedAt);
      else this.play(generation, segments, segmentIndex, list, at + 1, wallStart, mediaStart);
    };
    let stalled = false;
    this.timer = setTimeout(send, Math.max(0, wallStart + (unit.capturedAt - mediaStart) / this.rate - Date.now()));
  }
}
