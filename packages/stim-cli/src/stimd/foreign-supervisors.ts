import { inspectProcessIdentity, type ProcessRecord } from '@stim-cli/core/process-identity';
import { isJsonObject } from '@stim-cli/core/state';
import { loadConfig } from '../workspace/config.ts';
import { readWorkspaceState } from '../workspace/workspace-state.ts';
import { workspaceIdleProbe } from './metro/idle-stop.ts';

const IDLE_POINT_MS = 2 * 60_000;

/**
 * After an engine switch, stops this home's dev server supervisors and device log collectors that record another
 * build's `engineDir`, each at its workspace's next idle point: no build, lease, driver or share keeps it and nothing
 * used it for two minutes. Records with no `engineDir` stay. Returns how many such processes still run.
 */
export async function stopForeignSupervisors(build: string, now: number = Date.now()): Promise<number> {
  let left = 0;
  // compat C25 until removal-minor
  for (const root of Object.keys(loadConfig()?.projects ?? {})) {
    const state = readWorkspaceState(root);
    const foreign = [state?.supervisor, ...Object.values(state?.collectors ?? {})].filter(
      (record): record is ProcessRecord =>
        isJsonObject(record) &&
        typeof record.engineDir === 'string' &&
        record.engineDir !== build &&
        inspectProcessIdentity(record) === 'same',
    );
    if (!foreign.length) continue;
    const probe = workspaceIdleProbe(root);
    if ((await probe.blocker()) !== null || now - probe.lastActivityAt() < IDLE_POINT_MS) {
      left += foreign.length;
      continue;
    }
    for (const record of foreign)
      try {
        process.kill(Number(record.pid), 'SIGTERM');
      } catch {}
  }
  // compat end
  return left;
}
