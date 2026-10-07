import { realpathSync } from 'node:fs';
import { basename, join } from 'node:path';
import { canonicalPath } from '../commands/gc/paths.ts';
import { createNdjsonWriter } from '../ndjson.ts';
import { loadConfig } from '../workspace/config.ts';
import { withIdleWorkspace } from '../workspace/in-use.ts';
import { workspaceLogsDir } from '../workspace/paths.ts';
import { dueIdleDevices, shutDownIdleDevices, type IdleShutdownEvent } from './idle-shutdown.ts';

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
    if (!candidate) {
      skipped.clear();
      return 0;
    }
    const { device, idleForMs } = candidate;
    const label = loadConfig()?.projects[device.project]?.label || basename(device.project);
    const log = (event: IdleShutdownEvent) => {
      const writer = createNdjsonWriter(join(workspaceLogsDir(device.project), 'metro.ndjson'));
      writer.write({ src: 'metro', ...event });
      writer.close();
      if (event.level === 'warn') out(`${'device'.padEnd(11)} ${event.msg}`);
    };
    skipped.add(`${device.kind}:${device.id}`);
    const run = await withIdleWorkspace(
      device.project,
      () =>
        shutDownIdleDevices(device.project, idleMs, log, now(), {
          only: device,
          reason: 'reclaimed for a waiting run',
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
