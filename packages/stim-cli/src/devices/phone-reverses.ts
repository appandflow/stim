import type { StimContext } from '@stim-cli/core';
import { readWorkspaceState, updateWorkspaceState, updateWorkspaceStateAsync } from '../workspace/workspace-state.ts';
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
    const entry = value as Partial<PhoneReverseRecord> | null;
    if (typeof entry?.serial !== 'string' || !Array.isArray(entry.ports) || !parseDeviceSlotKey(key)) continue;
    records[key] = {
      serial: entry.serial,
      ports: entry.ports.filter((port) => Number.isSafeInteger(port) && port > 0),
    };
  }
  return records;
}

export function recordPhoneReverse(root: string, slot: string, serial: string, port: number): void {
  const key = deviceSlotKey('android', slot);
  updateWorkspaceState(root, (state) => {
    const records = readRecords(state);
    const previous = records[key]?.serial === serial ? records[key].ports : [];
    records[key] = { serial, ports: [...new Set([...previous, port])] };
    return { ...state, [KEY]: records };
  });
}

/**
 * Removes the Metro reverses a `--device` run added to a physical Android phone and forgets them. Only the host
 * ports the run recorded are removed, on the serial it recorded; every other reverse on the phone stays.
 * https://github.com/appandflow/stim/issues/4132
 */
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
      if (remaining[key]?.serial === done.serial) delete remaining[key];
    }
    const { [KEY]: _, ...rest } = state;
    return Object.keys(remaining).length ? { ...rest, [KEY]: remaining } : rest;
  });
}
