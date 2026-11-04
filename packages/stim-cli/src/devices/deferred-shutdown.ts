import {
  DEFERRED_SHUTDOWN_KEY,
  readDeferredShutdowns,
  type DeferredShutdownRecord,
  type WorkspaceState,
} from '@stim-cli/core/state';
import { readWorkspaceState, updateWorkspaceStateAsync } from '../workspace/workspace-state.ts';
import { deviceSlotKey } from './device-slots.ts';

export async function recordDeferredShutdown(
  root: string,
  slot: string,
  record: DeferredShutdownRecord,
): Promise<void> {
  await updateWorkspaceStateAsync(root, (state) => ({
    ...state,
    [DEFERRED_SHUTDOWN_KEY]: { ...readDeferredShutdowns(state), [deviceSlotKey('ios', slot)]: record },
  }));
}

/** Forgets the slot's deferred shutdown, once the simulator is shut down or a run uses it again. */
export async function clearDeferredShutdown(root: string, slot: string = 'default'): Promise<void> {
  const key = deviceSlotKey('ios', slot);
  if (!(key in readDeferredShutdowns(readWorkspaceState(root)))) return;
  await updateWorkspaceStateAsync(root, (state) => {
    const { [key]: _cleared, ...rest } = readDeferredShutdowns(state);
    const { [DEFERRED_SHUTDOWN_KEY]: _all, ...others } = state;
    return Object.keys(rest).length ? { ...others, [DEFERRED_SHUTDOWN_KEY]: rest } : others;
  });
}

/** Whether `stop` left this slot's simulator booted and its deferral has not passed. */
export function holdsDeferredShutdown(
  state: WorkspaceState | null | undefined,
  slot: string,
  udid: string,
  now: number = Date.now(),
): boolean {
  const record = readDeferredShutdowns(state)[deviceSlotKey('ios', slot)];
  return record?.udid === udid && Date.parse(record.until) > now;
}
