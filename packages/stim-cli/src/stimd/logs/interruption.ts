import { readFile } from 'node:fs/promises';
import { rotatedLogPath } from '@stim-cli/core';
import { parseNdjsonLine } from '../../ndjson.ts';
import { deviceSlotPlatforms } from '../../devices/device-slots.ts';
import { resolveOwnedAvdSerialAsync } from '../../devices/android.ts';
import { listAllIosSimsAsync, resolveOwnedIosSim } from '../../devices/ios.ts';
import { getProject } from '../../workspace/config.ts';
import type { StreamSpec } from './streams.ts';

export interface LastWritten {
  /** The newest device line (a record without an `event`) this stream wrote, in ms. */
  line: number | null;
  /** The newest record of any kind this stream wrote, in ms. */
  record: number | null;
}

/** Reads both generations of `file`, newest first, for the last records `streamId` wrote. */
export async function lastWrittenFor(file: string, streamId: string): Promise<LastWritten> {
  const found: LastWritten = { line: null, record: null };
  const needle = `"streamId":${JSON.stringify(streamId)}`;
  for (const path of [file, rotatedLogPath(file)]) {
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch {
      continue;
    }
    const lines = text.split('\n');
    for (let index = lines.length - 1; index >= 0; index--) {
      const raw = lines[index];
      if (!raw || !raw.includes(needle)) continue;
      const record = parseNdjsonLine(raw);
      if (!record || record.streamId !== streamId || typeof record.ts !== 'number') continue;
      found.record = Math.max(found.record ?? 0, record.ts);
      if (record.event === undefined) {
        found.line = record.ts;
        return found;
      }
    }
  }
  return found;
}

export function interruptedRecord({
  platform,
  from,
  until,
  reason,
  outcome,
}: {
  platform: 'ios' | 'android';
  from: number | null;
  until: number;
  reason: string;
  outcome: 'backfill' | 'lost';
}): Record<string, unknown> {
  const range =
    from === null
      ? `until ${new Date(until).toISOString()}`
      : `from ${new Date(from).toISOString()} until ${new Date(until).toISOString()}`;
  const tail =
    outcome === 'lost'
      ? 'The stream was not restarted, so lines logged since then are not captured.'
      : platform === 'ios'
        ? "Lines logged in between are replayed from the simulator's log store where it kept them."
        : "Lines logged in between are replayed from logcat's buffer for the app's current pid where it still holds them.";
  return {
    src: 'device',
    platform,
    level: 'warn',
    event: 'collector_interrupted',
    ts: until,
    interruptedFrom: from,
    interruptedUntil: until,
    msg: `Device log capture was interrupted ${range}: ${reason}. ${tail}`,
  };
}

/** Why a workspace's simulator or emulator for `spec` cannot be logged now, or null when it is owned and booted. */
export async function deviceUnavailable(spec: StreamSpec, signal?: AbortSignal): Promise<string | null> {
  const slot = spec.slot ?? 'default';
  const record = deviceSlotPlatforms(getProject(spec.root), slot)?.[spec.platform];
  try {
    if (spec.platform === 'ios') {
      if (!record || record.owned !== true || record.deviceUdid !== spec.udid)
        return `the workspace no longer records ${spec.udid} as its owned simulator`;
      const resolved = resolveOwnedIosSim(spec.udid ?? '', await listAllIosSimsAsync({ timeoutMs: 15_000, signal }));
      if ('missing' in resolved) return `simulator ${spec.udid} no longer exists`;
      if ('notOwned' in resolved) return `simulator ${spec.udid} is not owned by this Stim home`;
      return resolved.sim?.state === 'Booted' ? null : `simulator ${spec.udid} is not booted`;
    }
    const avd = typeof record?.avdName === 'string' ? record.avdName : null;
    if (!record || record.owned !== true || !avd) return `the workspace no longer records an owned emulator`;
    const resolved = await resolveOwnedAvdSerialAsync(avd, {
      timeoutMs: 15_000,
      signal,
      preferredSerial: spec.serial,
    });
    if ('missing' in resolved) return `emulator ${avd} no longer exists`;
    if ('notOwned' in resolved) return `emulator ${avd} is not owned by this Stim home`;
    if ('notRunning' in resolved) return `emulator ${avd} is not running`;
    return resolved.serial === spec.serial
      ? null
      : `emulator ${avd} now runs as ${resolved.serial}, not ${spec.serial}`;
  } catch (error) {
    return `the device could not be verified: ${error instanceof Error ? error.message : String(error)}`;
  }
}
