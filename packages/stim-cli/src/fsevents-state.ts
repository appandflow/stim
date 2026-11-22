import { randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { configDir } from '@stim-cli/core';
import { gcMarkFile, isJsonObject, readGcMark, readJsonObject } from '@stim-cli/core/state';

interface HistoryCheckpoint {
  uuid: string | null;
  eventId: number;
  sinceAt: number;
  roots: string[];
}

export type HistoryCheckpoints = Record<string, HistoryCheckpoint>;
const checkpointFile = () => join(configDir(), 'gc', 'fsevents.json');

function writeRecord(file: string, record: object): void {
  const temporary = `${file}.${randomUUID()}.tmp`;
  mkdirSync(dirname(file), { recursive: true });
  try {
    writeFileSync(temporary, JSON.stringify(record));
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** Marks existing roots dirty on the passes isolate; a missing mark is already due. Write failures propagate. */
export function dirtyGcMarks(roots: readonly string[], at: number): void {
  for (const root of roots) {
    const mark = readGcMark(root);
    if (!mark) continue;
    const dirtyAt = new Date(Math.max(at, Date.parse(mark.markedAt) + 1)).toISOString();
    if (mark.dirtyAt && Date.parse(mark.dirtyAt) >= Date.parse(dirtyAt)) continue;
    writeRecord(gcMarkFile(root), { ...mark, dirtyAt });
  }
}

/** Unknown or incomplete checkpoint state replays as absent, making the helper invalidate that device. */
export function readHistoryCheckpoints(): HistoryCheckpoints {
  const state = readJsonObject(checkpointFile());
  if (!state || state.v !== 1 || !isJsonObject(state.devices)) return {};
  const devices: HistoryCheckpoints = {};
  for (const [dev, value] of Object.entries(state.devices)) {
    if (
      !/^\d+$/.test(dev) ||
      !isJsonObject(value) ||
      (value.uuid !== null && typeof value.uuid !== 'string') ||
      !Number.isSafeInteger(value.eventId) ||
      Number(value.eventId) < 0 ||
      !Number.isSafeInteger(value.sinceAt) ||
      Number(value.sinceAt) < 0 ||
      !Array.isArray(value.roots) ||
      !value.roots.every((root) => typeof root === 'string')
    )
      return {};
    devices[dev] = {
      uuid: value.uuid,
      eventId: Number(value.eventId),
      sinceAt: Number(value.sinceAt),
      roots: value.roots,
    };
  }
  return devices;
}

/** Writes only after the corresponding dirty-mark acknowledgement; a failed write keeps the prior cursor. */
export function writeHistoryCheckpoints(devices: HistoryCheckpoints): void {
  writeRecord(checkpointFile(), { v: 1, devices });
}
