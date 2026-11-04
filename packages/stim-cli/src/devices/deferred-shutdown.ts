import {
  DEFERRED_SHUTDOWN_KEY,
  readDeferredShutdowns,
  type DeferredShutdownRecord,
  type WorkspaceState,
} from '@stim-cli/core/state';
import { readWorkspaceState, updateWorkspaceStateAsync } from '../workspace/workspace-state.ts';
import { deviceSlotKey } from './device-slots.ts';

/** Records the deferral and returns its expiry: a repeated `stop` keeps the unexpired expiry of the same simulator. */
export async function recordDeferredShutdown(
  root: string,
  slot: string,
  record: DeferredShutdownRecord,
): Promise<string> {
  const key = deviceSlotKey('ios', slot);
  let until = record.until;
  await updateWorkspaceStateAsync(root, (state) => {
    const existing = readDeferredShutdowns(state)[key];
    if (existing?.udid === record.udid && Date.parse(existing.until) > Date.now()) until = existing.until;
    return {
      ...state,
      [DEFERRED_SHUTDOWN_KEY]: { ...readDeferredShutdowns(state), [key]: { udid: record.udid, until } },
    };
  });
  return until;
}

/** Forgets the slot's deferred shutdown; with `until`, only that record, so a newer `stop` keeps its own. */
export async function clearDeferredShutdown(root: string, slot: string = 'default', until?: string): Promise<void> {
  const key = deviceSlotKey('ios', slot);
  const matches = (state: WorkspaceState | null) => {
    const record = readDeferredShutdowns(state)[key];
    return record !== undefined && (until === undefined || record.until === until);
  };
  if (!matches(readWorkspaceState(root))) return;
  await updateWorkspaceStateAsync(root, (state) => {
    if (!matches(state)) return state;
    const { [key]: _cleared, ...rest } = readDeferredShutdowns(state);
    const { [DEFERRED_SHUTDOWN_KEY]: _all, ...others } = state;
    return Object.keys(rest).length ? { ...others, [DEFERRED_SHUTDOWN_KEY]: rest } : others;
  });
}

export function holdsDeferredShutdown(
  state: WorkspaceState | null | undefined,
  slot: string,
  udid: string,
  now: number = Date.now(),
): boolean {
  const record = readDeferredShutdowns(state)[deviceSlotKey('ios', slot)];
  return record?.udid === udid && Date.parse(record.until) > now;
}
