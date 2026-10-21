import { isJsonObject } from '@stim-cli/core/state';
import type { StimContext } from '@stim-cli/core';
import { readWorkspaceState, updateWorkspaceStateAsync } from '../workspace/workspace-state.ts';
import { removeMetroReverses } from './android.ts';
import { deviceSlotKey, parseDeviceSlotKey } from './device-slots.ts';

const KEY = 'phoneReverses';

interface PhoneReverseRecord {
  serial: string;
  ports: number[];
}

function readRecords(state: { [key: string]: unknown } | null | undefined): Record<string, PhoneReverseRecord> {
  const raw = state?.[KEY];
  const records: Record<string, PhoneReverseRecord> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return records;
  for (const [key, value] of Object.entries(raw)) {
    if (!isJsonObject(value)) continue;
    const entry = value;
    if (typeof entry.serial !== 'string' || !Array.isArray(entry.ports) || !parseDeviceSlotKey(key)) continue;
    records[key] = {
      serial: entry.serial,
      ports: entry.ports.filter((port) => Number.isSafeInteger(port) && port > 0),
    };
  }
  return records;
}

export async function recordPhoneReverse(root: string, slot: string, serial: string, port: number): Promise<void> {
  const key = deviceSlotKey('android', slot);
  await updateWorkspaceStateAsync(root, (state) => {
    const records = readRecords(state);
    const previous = records[key]?.serial === serial ? records[key].ports : [];
    records[key] = { serial, ports: [...new Set([...previous, port])] };
    return { ...state, [KEY]: records };
  });
}

export async function removePhoneReverses(
  root: string,
  { slot, operation }: { slot?: string; operation?: StimContext } = {},
): Promise<void> {
  const records = Object.entries(readRecords(readWorkspaceState(root))).filter(
    ([key]) => slot === undefined || parseDeviceSlotKey(key)?.slot === slot,
  );
  for (const [, { serial, ports }] of records) await removeMetroReverses(serial, ports, operation);
  if (records.length === 0) return;
  await updateWorkspaceStateAsync(root, (state) => {
    const remaining = readRecords(state);
    for (const [key, done] of records) {
      const current = remaining[key];
      if (current?.serial !== done.serial) continue;
      current.ports = current.ports.filter((port) => !done.ports.includes(port));
      if (current.ports.length === 0) delete remaining[key];
    }
    const { [KEY]: _, ...rest } = state;
    return Object.keys(remaining).length ? { ...rest, [KEY]: remaining } : rest;
  });
}
