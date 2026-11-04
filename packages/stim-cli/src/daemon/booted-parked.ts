import type { StimContext } from '@stim-cli/core';
import { readDeferredShutdowns, type DaemonLadderAction } from '@stim-cli/core/state';
import { clearDeferredShutdown } from '../devices/deferred-shutdown.ts';
import { deviceSlotKey, deviceSlotPlatforms, parseDeviceSlotKey, projectDeviceSlots } from '../devices/device-slots.ts';
import type { IosSimRecord } from '../devices/ios.ts';
import { isBootedParked, readParked, type ParkedSim } from '../devices/sim-pool.ts';
import { shutDownBootedParkedIosSim, teardownOwnedIosSim, type TeardownOutcome } from '../devices/teardown.ts';
import type { HostMemoryPressure } from '../host-memory.ts';
import { resolveSupervisorTarget } from '../supervisor/ownership.ts';
import { getProject, loadConfig, type Config } from '../workspace/config.ts';
import { withIdleWorkspace } from '../workspace/in-use.ts';
import { readWorkspaceState } from '../workspace/workspace-state.ts';
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

/** A simulator `stop` left booted: the workspace's own owned device, with the time its shutdown is due. */
export interface DeferredMark {
  root: string;
  slot: string;
  udid: string;
  name: string;
  until: string;
}

/** The deferred shutdowns of the owned simulators the registered workspaces still hold. */
export function readDeferredMarks(config: Config | null): DeferredMark[] {
  const marks: DeferredMark[] = [];
  for (const [root, project] of Object.entries(config?.projects ?? {})) {
    if (!projectDeviceSlots(project).some(({ platforms }) => platforms.ios?.owned === true)) continue;
    for (const [key, record] of Object.entries(readDeferredShutdowns(readWorkspaceState(root)))) {
      const slot = parseDeviceSlotKey(key)?.slot;
      if (slot === undefined) continue;
      const ios = deviceSlotPlatforms(project, slot)?.ios;
      if (ios?.owned === true && ios.deviceUdid === record.udid)
        marks.push({
          root,
          slot,
          udid: record.udid,
          name: String(ios.deviceName ?? record.udid),
          until: record.until,
        });
    }
  }
  return marks;
}

interface DeferredShutdownDue {
  mark: DeferredMark;
  why: string;
  /** False when the simulator is no longer booted, so the mark only needs clearing. */
  shutDown: boolean;
}

/**
 * The deferred shutdowns that are due now: under memory pressure, once `until` has passed, or, with `all`, whatever
 * the time. A simulator that is no longer booted is due only for clearing its mark. Nothing is due while the
 * simulator list is unavailable.
 */
function deferredShutdownDue({
  marks,
  sims,
  now,
  memory,
  all = false,
}: {
  marks: readonly DeferredMark[];
  sims: readonly IosSimRecord[] | null;
  now: number;
  memory: HostMemoryPressure | null;
  all?: boolean;
}): DeferredShutdownDue[] {
  if (sims === null) return [];
  const due: DeferredShutdownDue[] = [];
  for (const mark of marks) {
    if (sims.find((sim) => sim.udid === mark.udid)?.state !== 'Booted') {
      due.push({ mark, why: 'it is no longer booted', shutDown: false });
      continue;
    }
    let why: string | null = null;
    if (memory !== null && memory !== 'normal') why = `macOS memory pressure is ${memory}`;
    else if (Date.parse(mark.until) <= now) why = 'its grace period has passed';
    else if (all) why = 'every deferred shutdown is taken';
    if (why) due.push({ mark, why, shutDown: true });
  }
  return due;
}

const RETRY_AFTER_EXPIRY_MS = 10 * 60_000;

/**
 * Whether a parked simulator, or one `stop` left booted, is still kept booted or passed its grace period within the
 * last 10 minutes and so may need another shutdown attempt, which keeps the daemon running to end it.
 */
export function bootedParkedPending(now: number = Date.now()): boolean {
  return (
    readParked('ios').some(
      (record) => record.bootedUntil !== undefined && Date.parse(record.bootedUntil) + RETRY_AFTER_EXPIRY_MS > now,
    ) || readDeferredMarks(loadConfig()).some((mark) => Date.parse(mark.until) + RETRY_AFTER_EXPIRY_MS > now)
  );
}

/** Whether the workspace's dev server runs, so it is in use again and a deferred shutdown no longer applies. */
export function workspaceServing(root: string): boolean {
  const project = getProject(root);
  const target = resolveSupervisorTarget({
    state: readWorkspaceState(root)?.supervisor,
    record: project?.supervisor,
    reservedPort: project?.metroPort,
  });
  return target.status === 'ours' || target.status === 'unverified';
}

/**
 * Shuts down a simulator `stop` left booted, through teardown under its workspace's native-run lock, and forgets the
 * deferral. Null when the workspace is in use or the deferral changed meanwhile.
 */
export async function shutDownDeferredIosSim(
  mark: DeferredMark,
  operation: StimContext | undefined,
): Promise<TeardownOutcome | null> {
  const run = await withIdleWorkspace(
    mark.root,
    async () => {
      const current = readDeferredShutdowns(readWorkspaceState(mark.root))[deviceSlotKey('ios', mark.slot)];
      if (current?.udid !== mark.udid) return null;
      const outcome = await teardownOwnedIosSim(mark.udid, { label: mark.name, workspace: mark.root, operation });
      if (outcome.status === 'torn-down' || outcome.status === 'missing')
        await clearDeferredShutdown(mark.root, mark.slot);
      return outcome;
    },
    { purpose: 'deferred simulator shutdown', operation, supervisor: false, managedLocks: false },
  );
  return run.ran ? run.value : null;
}

/**
 * Shuts down, through teardown, the parked simulators `bootedParkedDue` names, before any workspace's device is
 * touched. Each is shut down and stays parked. Then the simulators `stop` left booted: each goes through the same
 * teardown under the workspace's native-run lock and loses its deferral; one whose workspace serves again only loses it.
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
  for (const { mark, why, shutDown } of deferredShutdownDue({
    marks: readDeferredMarks(loadConfig()),
    sims,
    now,
    memory,
    all,
  })) {
    const target = mark.udid;
    const label = `simulator ${mark.name}`;
    if (!shutDown || workspaceServing(mark.root)) {
      if (act) await clearDeferredShutdown(mark.root, mark.slot);
      continue;
    }
    if (!act) {
      log('info', 'deferred_shutdown_would_run', `${mark.root}: would shut down ${label}: ${why}`, {
        workspace: mark.root,
      });
      actions.push({
        rung,
        kind: 'shut-down-deferred-device',
        target,
        workspace: mark.root,
        outcome: 'would',
        bytes: 0,
        detail: 'daemon.mode report acts on nothing',
      });
      continue;
    }
    const outcome = await shutDownDeferredIosSim(mark, operation);
    if (outcome === null) continue;
    const done = outcome.status === 'torn-down' || outcome.status === 'missing';
    const detail = done ? `shut down ${label}: ${why}` : `kept ${label} booted: ${outcome.reason ?? outcome.status}`;
    log(done ? 'info' : 'warn', done ? 'deferred_shutdown_done' : 'deferred_shutdown_kept', `${mark.root}: ${detail}`, {
      workspace: mark.root,
      target,
    });
    if (outcome.status === 'skipped') continue;
    actions.push({
      rung,
      kind: 'shut-down-deferred-device',
      target,
      workspace: mark.root,
      outcome: done ? 'done' : 'failed',
      bytes: 0,
      detail,
      ...(done ? { restore: 'stim ios' } : {}),
    });
  }
  return actions;
}
