import { DEVICE_RECLAIM_REASON } from '@stim-cli/core/state';
import { realpathSync } from 'node:fs';
import { canonicalPath } from '../commands/gc/paths.ts';
import { loadConfig } from '../workspace/config.ts';
import { workspaceDisplayLabel } from '../workspace/display-label.ts';
import { withIdleWorkspace } from '../workspace/in-use.ts';
import {
  dueIdleDevices,
  shutDownIdleDevices,
  writeIdleShutdownEvent,
  type IdleShutdownEvent,
} from './idle-shutdown.ts';

export async function reclaimIdleDevice(
  root: string,
  idleMs: number,
  out: (line: string) => void,
  now: () => number,
  skipped: Set<string>,
): Promise<number> {
  try {
    const self = canonicalPath(root);
    const candidates = dueIdleDevices(undefined, idleMs, now())
      .filter(({ device }) => {
        try {
          return realpathSync(device.project) !== self;
        } catch {
          return false;
        }
      })
      .toSorted((a, b) => b.idleForMs - a.idleForMs);
    const candidate = candidates.find(({ device }) => !skipped.has(`${device.kind}:${device.id}`));
    if (!candidate) return 0;
    const { device, idleForMs } = candidate;
    const label = workspaceDisplayLabel(device.project, loadConfig());
    const log = (event: IdleShutdownEvent) => {
      writeIdleShutdownEvent(device.project, event);
      if (event.level === 'warn') out(`${'device'.padEnd(11)} ${event.msg}`);
    };
    skipped.add(`${device.kind}:${device.id}`);
    const run = await withIdleWorkspace(
      device.project,
      () =>
        shutDownIdleDevices(device.project, idleMs, log, now(), {
          only: device,
          reason: DEVICE_RECLAIM_REASON,
        }),
      { purpose: 'device queue reclaim', supervisor: false, managedLocks: false },
    );
    if (!run.ran) {
      log({
        level: 'warn',
        event: 'device_idle_shutdown_failed',
        msg: `could not reclaim ${device.name}: ${run.reasons.join('; ')}`,
      });
      return 0;
    }
    if (!run.value) return 0;
    skipped.delete(`${device.kind}:${device.id}`);
    out(
      `${'device'.padEnd(11)} reclaimed ${device.kind === 'ios' ? 'iOS simulator' : 'Android emulator'} ${device.name} (workspace ${label}, idle ${Math.floor(idleForMs / 60_000)}m) for this waiting run`,
    );
    return run.value;
  } catch (error) {
    out(`${'device'.padEnd(11)} could not reclaim an idle device: ${(error as Error)?.message || error}`);
    return 0;
  }
}
