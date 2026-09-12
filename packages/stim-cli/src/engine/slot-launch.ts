import { fileLeaseIo } from './device-lease.ts';
import { getProject } from '../config.ts';
import { readWorkspaceState } from '../supervisor/state.ts';

export function launchSlotScope(root: string, slot = 'default'): string | undefined {
  if (slot !== 'default') return slot;
  if (Object.keys(getProject(root)?.deviceSlots ?? {}).length) return slot;
  const state = readWorkspaceState(root);
  if (Object.keys({ ...state?.collectors, ...fileLeaseIo.readHolder(root) }).some((key) => key.includes(':')))
    return slot;
  return undefined;
}
