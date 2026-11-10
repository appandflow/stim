import type { StimContext } from '@stim-cli/core';
import { DEVICE_RECLAIM_REASON, type DaemonLadderAction } from '@stim-cli/core/state';
import { workspaceBuildInProgress, type OwnedDeviceActivity } from '../commands/gc/idle.ts';
import { canonicalPath } from '../commands/gc/paths.ts';
import { workspaceDeviceLastUseAt } from '../devices/activity.ts';
import { idleShutdownDueMs, shutDownIdleDevices, writeIdleShutdownEvent } from '../devices/idle-shutdown.ts';
import type { IosSimRecord } from '../devices/ios.ts';
import { listAdbDevicesAsync } from '../devices/android.ts';
import { countLiveOwnedDevicesByPlatformAsync } from '../engine/device-capacity.ts';
import { liveWaiters } from '../engine/wait-queue.ts';
import { liveShareKeepReason, readWebShares, shareKeepReason } from '../local-server.ts';
import { readParked } from '../devices/sim-pool.ts';
import { shutDownBootedParkedIosSim } from '../devices/teardown.ts';
import { admissionLimits, getPlatformDeviceLimits, loadConfig } from '../workspace/config.ts';
import { withIdleWorkspace } from '../workspace/in-use.ts';
import { readDeferredMarks, shutDownDeferredIosSim, workspaceServing } from './booted-parked.ts';
import { ownedHere, type IdlePassInput } from './idle.ts';

/** A booted device of another workspace idle this long may be shut down for a run waiting to boot. */
const RECLAIM_IDLE_MS = 2 * 60_000;

function safeCanonical(path: string): string | null {
  try {
    return canonicalPath(path);
  } catch {
    return null;
  }
}

/**
 * The admission reclaim: while a run waits to boot because the booted devices fill a cap, counted as admission counts
 * them, shuts down the longest-idle booted device this home owns in another workspace that has been idle 2 minutes or
 * more and has no blocker, a live web share included, through teardown, one per tick. Returns the action, or null
 * when nothing waits on a cap, the devices cannot be counted, or no device qualifies.
 */
export async function reclaimForBootWaiters({
  devices,
  sims,
  act,
  log,
  operation,
  now = Date.now(),
}: {
  devices: readonly OwnedDeviceActivity[];
  /** The tick's simulator listing; null when it failed. */
  sims: IosSimRecord[] | null;
  act: boolean;
  log: IdlePassInput['log'];
  /** The daemon tick's context: the locked re-check reads processes and simulators without blocking its event loop. */
  operation: StimContext;
  now?: number;
}): Promise<DaemonLadderAction | null> {
  operation.signal.throwIfAborted();
  let waiters;
  try {
    waiters = liveWaiters('boot');
  } catch {
    return null;
  }
  if (!waiters.length || sims === null) return null;
  const counts = await countLiveOwnedDevicesByPlatformAsync({
    sims,
    adb: () => listAdbDevicesAsync({ signal: operation.signal, operation }),
  });
  operation.signal.throwIfAborted();
  if ('unknown' in counts) return null;
  const { maxDevices } = admissionLimits();
  const platformCaps = getPlatformDeviceLimits();
  const totalFull = counts.ios + counts.android >= maxDevices;
  const fullPlatforms = new Set(
    waiters.flatMap(({ details }) => {
      const platform = String(details.platform);
      if (platform !== 'ios' && platform !== 'android') return [];
      const cap = platformCaps[platform];
      return cap > 0 && counts[platform] >= cap ? [platform] : [];
    }),
  );
  if (!totalFull && fullPlatforms.size === 0) return null;
  const waiting = new Set(
    waiters.flatMap(({ details }) => {
      const root = typeof details.root === 'string' ? safeCanonical(details.root) : null;
      return root ? [root] : [];
    }),
  );
  const booted = (udid: string) => sims.find((sim) => sim.udid === udid)?.state === 'Booted';
  const parked = readParked('ios')
    .filter((record) => record.bootedUntil !== undefined && booted(record.udid))
    .toSorted((a, b) => a.parkedAt.localeCompare(b.parkedAt))[0];
  const left = parked
    ? undefined
    : readDeferredMarks(loadConfig())
        .filter((mark) => {
          const root = safeCanonical(mark.root);
          return root !== null && !waiting.has(root) && booted(mark.udid) && !workspaceServing(mark.root);
        })
        .toSorted((a, b) => a.until.localeCompare(b.until))[0];
  const held = parked
    ? {
        udid: parked.udid,
        name: parked.name,
        what: 'a parked simulator',
        label: `parked simulator ${parked.name}`,
        shutDown: () => shutDownBootedParkedIosSim(parked.udid, { label: parked.name, operation }),
      }
    : left && {
        udid: left.udid,
        name: left.name,
        what: 'a simulator that stop left booted',
        label: `simulator ${left.name} that stop left booted`,
        shutDown: () => shutDownDeferredIosSim(left, operation),
      };
  if (held && (totalFull || fullPlatforms.has('ios'))) {
    const { label } = held;
    const reason = `a run waits to boot and the booted devices fill ${totalFull ? `concurrency.maxDevices (${maxDevices})` : 'the ios cap'}; ${held.what} held booted goes first`;
    if (!act) {
      log('info', 'device_would_reclaim', `would shut down ${label}: ${reason}`);
      return {
        rung: 0,
        kind: 'reclaim-device',
        target: held.udid,
        outcome: 'would',
        bytes: 0,
        detail: 'daemon.mode report acts on nothing',
      };
    }
    const outcome = await held.shutDown();
    const done = outcome?.status === 'torn-down';
    const detail = done
      ? `shut down ${label} for a waiting run: ${reason}`
      : `kept ${label}: ${outcome?.reason ?? outcome?.status ?? 'its workspace is in use'}`;
    log(done ? 'info' : 'warn', done ? 'device_reclaimed' : 'device_reclaim_kept', detail, { target: held.udid });
    if (done || outcome?.status === 'failed')
      return {
        rung: 0,
        kind: 'reclaim-device',
        target: held.udid,
        outcome: done ? 'done' : 'failed',
        bytes: 0,
        detail,
      };
  }
  const candidates = devices
    .flatMap((device) => {
      if (!ownedHere(device)) return [];
      const project = safeCanonical(device.project);
      if (!project || waiting.has(project)) return [];
      if (!totalFull && !fullPlatforms.has(device.kind)) return [];
      const usedAt = workspaceDeviceLastUseAt(device.project);
      if (Number.isFinite(usedAt) && now - usedAt < RECLAIM_IDLE_MS) return [];
      const idleMs = idleShutdownDueMs(device.activity, {
        idleMs: RECLAIM_IDLE_MS,
        now,
        buildInProgress: workspaceBuildInProgress(device.project),
      });
      return idleMs === null ? [] : [{ device, idleMs }];
    })
    .toSorted((a, b) => b.idleMs - a.idleMs);
  const shares = candidates.length ? await readWebShares() : null;
  if (shares !== null && !Array.isArray(shares)) {
    log(
      'warn',
      'device_reclaim_kept',
      `no device reclaimed for a waiting run: this home's web shares cannot be listed (${shares.unreadable})`,
    );
    return null;
  }
  operation.signal.throwIfAborted();
  const chosen = candidates.find(({ device }) => shareKeepReason(shares, device.project, now) === null);
  if (!chosen) return null;
  const { device, idleMs } = chosen;
  const label = `${device.kind === 'ios' ? 'iOS simulator' : 'Android emulator'} ${device.name}`;
  const reason = `a run waits to boot and the booted devices fill ${totalFull ? `concurrency.maxDevices (${maxDevices})` : `the ${[...fullPlatforms].join(' and ')} cap`}; idle ${Math.floor(idleMs / 60_000)} minutes`;
  if (!act) {
    log('info', 'device_would_reclaim', `${device.project}: would shut down ${label}: ${reason}`, {
      workspace: device.project,
    });
    return {
      rung: 0,
      kind: 'reclaim-device',
      target: device.id,
      workspace: device.project,
      outcome: 'would',
      bytes: 0,
      detail: 'daemon.mode report acts on nothing',
    };
  }
  const run = await withIdleWorkspace(
    device.project,
    async () =>
      (await liveShareKeepReason(device.project)) ??
      shutDownIdleDevices(
        device.project,
        RECLAIM_IDLE_MS,
        (event) => writeIdleShutdownEvent(device.project, event),
        Date.now(),
        { only: device, reason: DEVICE_RECLAIM_REASON, operation },
      ),
    { purpose: 'device queue reclaim', supervisor: false, managedLocks: false, operation },
  );
  const done = run.ran && typeof run.value === 'number' && run.value > 0;
  const detail = done
    ? `shut down ${label} for a waiting run: ${reason}`
    : `kept ${label}: ${run.ran ? (typeof run.value === 'string' ? run.value : 'it is no longer idle') : `in use: ${run.reasons.join('; ')}`}`;
  log(done ? 'info' : 'warn', done ? 'device_reclaimed' : 'device_reclaim_kept', `${device.project}: ${detail}`, {
    workspace: device.project,
    restore: 'stim revive, or the next stim ios or stim android',
  });
  return {
    rung: 0,
    kind: 'reclaim-device',
    target: device.id,
    workspace: device.project,
    outcome: done ? 'done' : 'kept',
    bytes: 0,
    detail,
    ...(done ? { restore: 'stim revive, or the next stim ios or stim android' } : {}),
  };
}
