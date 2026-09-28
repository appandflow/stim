import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isJsonObject } from './json-file.ts';
import { coerceSettingText, settingDefinition } from './settings-registry.ts';

/** The footage stim-server keeps per device: the last 15 minutes recorded, however long ago. */
export const RECORDING_FOOTAGE_MS: number = 15 * 60_000;

/** The recordings of every workspace of one Stim home together; past it the oldest footage goes first. */
export const RECORDING_CAP_BYTES: number = 1024 ** 3;

/** The platforms stim-server records: owned simulators and emulators, and the Stim-owned Chrome page. */
export const RECORDING_PLATFORMS = ['ios', 'android', 'web'] as const;

export type RecordingPlatform = (typeof RECORDING_PLATFORMS)[number];

/**
 * One file of H.264 footage. A closed segment is named `<start>-<end>.seg`, in epoch milliseconds of its first and
 * last access unit; the segment being written is `<start>.part`, and its end is its modification time.
 */
export interface RecordedSegment {
  file: string;
  start: number;
  end: number;
  bytes: number;
  open: boolean;
}

export interface RecordedDevice {
  platform: RecordingPlatform;
  slot: string;
  dir: string;
  segments: RecordedSegment[];
}

const SEGMENT = /^(\d+)-(\d+)\.seg$/;
const PART = /^(\d+)\.part$/;
const DEVICE = /^(ios|android|web)-(.+)$/;

/** The directory under a workspace's recordings that holds one device slot's footage. */
export function recordingDeviceName(platform: RecordingPlatform, slot: string): string {
  return `${platform}-${slot}`;
}

/** Segment names hold whole milliseconds: the start rounded down and the end rounded up. */
export function closedSegmentName(start: number, end: number): string {
  return `${Math.floor(start)}-${Math.ceil(end)}.seg`;
}

export function openSegmentName(start: number): string {
  return `${Math.floor(start)}.part`;
}

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** The segments in one device directory, oldest first. Files that are not segments are left out. */
export function listSegments(dir: string): RecordedSegment[] {
  const segments: RecordedSegment[] = [];
  for (const name of listDir(dir)) {
    const closed = SEGMENT.exec(name);
    const part = closed ? null : PART.exec(name);
    if (!closed && !part) continue;
    let stat;
    try {
      stat = statSync(join(dir, name));
    } catch {
      continue;
    }
    const start = Number((closed ?? part)![1]);
    segments.push({
      file: join(dir, name),
      start,
      end: closed ? Math.max(start, Number(closed[2])) : Math.max(start, Math.floor(stat.mtimeMs)),
      bytes: stat.size,
      open: part !== null,
    });
  }
  return segments.toSorted((a, b) => a.start - b.start);
}

/** Every device slot recorded under a workspace's recordings directory. */
export function listRecordedDevices(recordingsDir: string): RecordedDevice[] {
  return listDir(recordingsDir).flatMap((name) => {
    const match = DEVICE.exec(name);
    if (!match) return [];
    const dir = join(recordingsDir, name);
    return [{ platform: match[1] as RecordingPlatform, slot: match[2]!, dir, segments: listSegments(dir) }];
  });
}

export function recordedBytes(devices: readonly RecordedDevice[]): number {
  return devices.reduce((sum, device) => sum + device.segments.reduce((total, s) => total + s.bytes, 0), 0);
}

/**
 * The oldest closed segments to delete so that one device keeps at most `footageMs` of footage. Time between
 * segments, while nothing was recorded, does not count. The open segment is never chosen.
 */
export function footageDrops(segments: readonly RecordedSegment[], footageMs: number): RecordedSegment[] {
  let total = segments.reduce((sum, segment) => sum + (segment.end - segment.start), 0);
  const drops: RecordedSegment[] = [];
  for (const segment of segments) {
    if (total <= footageMs) break;
    if (segment.open) continue;
    drops.push(segment);
    total -= segment.end - segment.start;
  }
  return drops;
}

/** The oldest closed segments across all devices to delete so that together they hold at most `capBytes`. */
export function capDrops(devices: readonly RecordedDevice[], capBytes: number): RecordedSegment[] {
  let total = recordedBytes(devices);
  const drops: RecordedSegment[] = [];
  const oldest = devices.flatMap((device) => device.segments.filter((s) => !s.open)).toSorted((a, b) => a.end - b.end);
  for (const segment of oldest) {
    if (total <= capBytes) break;
    drops.push(segment);
    total -= segment.bytes;
  }
  return drops;
}

/** `STIM_RECORDING` as a boolean, read like `stim settings` reads it; any other value is not an override. */
function recordingEnvValue(raw: string | undefined): boolean | null {
  if (!raw) return null;
  const value = coerceSettingText(settingDefinition('recording.enabled')!, raw.trim());
  return typeof value === 'boolean' ? value : null;
}

/**
 * Whether stim-server records a workspace's devices: `STIM_RECORDING`, then `recording.enabled` in the workspace,
 * repo and machine layers, in that order, and true by default.
 */
export function recordingEnabled(env: NodeJS.ProcessEnv, layers: readonly unknown[]): boolean {
  const override = recordingEnvValue(env.STIM_RECORDING);
  if (override !== null) return override;
  for (const layer of layers) {
    const recording = isJsonObject(layer) ? layer.recording : undefined;
    const value = isJsonObject(recording) ? recording.enabled : undefined;
    if (typeof value === 'boolean') return value;
  }
  return true;
}
