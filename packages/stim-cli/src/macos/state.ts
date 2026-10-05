import { join } from 'node:path';
import { readMacosRecord, type MacosAppRecord, type MacosProcess } from '@stim-cli/core/state';
import { captureProcessToken, processStartMicros, sameProcessRecord } from '../process-identity.ts';
import { workspaceDir, workspaceLogsDir } from '../workspace/paths.ts';
import { readWorkspaceState, updateWorkspaceState } from '../workspace/workspace-state.ts';

export const macosDir = (root: string): string => join(workspaceDir(root), 'macos');
export const macosLogFile = (root: string): string => join(workspaceLogsDir(root), 'macos.ndjson');
export const macosRuntimeClaim = (root: string): string => join(macosDir(root), 'runtime.lock');

export function macosProcess(pid: number): MacosProcess {
  const processToken = captureProcessToken(pid);
  const start = processStartMicros(pid);
  if (!processToken || start.status !== 'running') {
    throw Object.assign(new Error(`Cannot verify macOS process ${pid}; refusing unmanaged launch.`), {
      code: 'STIM_CLAIM_UNAVAILABLE',
    });
  }
  return { pid, processToken, startedAtMicros: start.startedAtMicros };
}

export function requiredMacosRecord(root: string): MacosAppRecord | null {
  const record = readMacosRecord(root);
  if (!record && readWorkspaceState(root)?.macos !== undefined) {
    throw Object.assign(
      new Error('The recorded macOS owner is malformed; repair its workspace state before running.'),
      {
        code: 'STIM_MACOS_OWNER_UNVERIFIED',
      },
    );
  }
  return record;
}

export function updateMacosRecord(root: string, owner: MacosProcess, patch: Partial<MacosAppRecord>): boolean {
  let updated = false;
  updateWorkspaceState(root, (state) => {
    const record = readMacosRecord(root);
    if (!record || !sameProcessRecord(record.supervisor, owner)) return state;
    updated = true;
    return { ...state, macos: { ...record, ...patch } };
  });
  return updated;
}
