import type { StimContext } from '@stim-cli/core';
import type { DaemonLadderAction } from '@stim-cli/core/state';
import type { IosSimRecord } from '../devices/ios.ts';
import { isBootedParked, readParked, type ParkedSim } from '../devices/sim-pool.ts';
import { shutDownBootedParkedIosSim } from '../devices/teardown.ts';
import type { HostMemoryPressure } from '../host-memory.ts';
import type { IdlePassInput } from './idle.ts';

export interface BootedParkedDue {
  record: ParkedSim;
  why: string;
}

/**
 * The parked simulators that carry a `bootedUntil` mark and must be shut down now: under memory pressure, once the grace
 * period has passed, or when the simulator is no longer booted (the mark then only needs clearing). Nothing is due
 * while the simulator list is unavailable, since no simulator can be proven booted or shut down.
 */
export function bootedParkedDue({
  records,
  sims,
  now,
  memory,
  all = false,
}: {
  records: readonly ParkedSim[];
  sims: readonly IosSimRecord[] | null;
  now: number;
  memory: HostMemoryPressure | null;
  /** Takes every marked simulator whatever its grace period, as `gc --delete` does. */
  all?: boolean;
}): BootedParkedDue[] {
  if (sims === null) return [];
  const due: BootedParkedDue[] = [];
  for (const record of records) {
    if (record.bootedUntil === undefined) continue;
    const live = sims.find((sim) => sim.udid === record.udid)?.state === 'Booted';
    let why: string | null = null;
    if (!live) why = 'it is no longer booted';
    else if (memory !== null && memory !== 'normal') why = `macOS memory pressure is ${memory}`;
    else if (!isBootedParked(record, now)) why = 'its grace period has passed';
    else if (all) why = 'every booted parked simulator is taken';
    if (why) due.push({ record, why });
  }
  return due;
}

/** Whether a parked simulator is still kept booted, which keeps the daemon running to end it. */
export function bootedParkedPending(now: number = Date.now()): boolean {
  return readParked('ios').some((record) => isBootedParked(record, now));
}

/**
 * Shuts down, through teardown, the parked simulators `bootedParkedDue` names, before any workspace's device is
 * touched. Each is shut down and stays parked.
 */
export async function runBootedParkedPass({
  sims,
  memory,
  act,
  log,
  operation,
  all,
  rung = 0,
  now = Date.now(),
}: {
  sims: readonly IosSimRecord[] | null;
  memory: HostMemoryPressure | null;
  act: boolean;
  log: IdlePassInput['log'];
  operation?: StimContext;
  all?: boolean;
  rung?: number;
  now?: number;
}): Promise<DaemonLadderAction[]> {
  const actions: DaemonLadderAction[] = [];
  for (const { record, why } of bootedParkedDue({ records: readParked('ios'), sims, now, memory, all })) {
    const target = record.udid;
    const label = `parked simulator ${record.name}`;
    if (!act) {
      log('info', 'booted_parked_would_shut_down', `would shut down ${label}: ${why}`);
      actions.push({
        rung,
        kind: 'shut-down-parked-device',
        target,
        outcome: 'would',
        bytes: 0,
        detail: 'daemon.mode report acts on nothing',
      });
      continue;
    }
    const outcome = await shutDownBootedParkedIosSim(target, { label: record.name, operation });
    const done = outcome.status === 'torn-down';
    const detail = done ? `shut down ${label}: ${why}` : `kept ${label} booted: ${outcome.reason ?? outcome.status}`;
    log(done ? 'info' : 'warn', done ? 'booted_parked_shut_down' : 'booted_parked_kept', detail, { target });
    if (outcome.status === 'skipped') continue;
    actions.push({
      rung,
      kind: 'shut-down-parked-device',
      target,
      outcome: done ? 'done' : 'failed',
      bytes: 0,
      detail,
    });
  }
  return actions;
}
