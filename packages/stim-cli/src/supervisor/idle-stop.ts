import { hostedNativeRecords, parseHostedNativePlacement } from '@stim-cli/core/state';
import { readFileSync } from 'node:fs';
import { createActivityReader, workspaceDeviceLastUseAt, type ActivityTarget } from '../devices/activity.ts';
import { ownedAvdSerialResolver } from '../devices/android.ts';
import { parseDeviceSlotKey, projectDeviceSlots } from '../devices/device-slots.ts';
import { workspaceBuildInProgress } from '../commands/gc/idle.ts';
import { deviceLeasePath, leaseIsExpired, parseLease, parseWorkspaceLeases } from '../engine/device-lease.ts';
import { liveShareKeepReason } from '../local-server.ts';
import { getProject } from '../workspace/config.ts';
import { readWorkspaceState } from '../workspace/workspace-state.ts';
import { describeError } from './errors.ts';

const IDLE_CHECK_MS = 60_000;
const MINUTE_MS = 60_000;

/** The Metro log events that are a client's request: a bundle, a manifest or an HMR update. */
export const METRO_REQUEST_EVENTS: ReadonlySet<string> = new Set([
  'bundle_response_started',
  'bundle_response_progress',
  'bundle_response_finished',
  'bundle_response_failed',
  'bundle_build_started',
  'bundle_build_done',
  'bundle_build_failed',
  'manifest_request_started',
  'manifest_request_finished',
  'manifest_request_failed',
  'hmr_update',
]);

export interface DevServerActivity {
  record(entry: unknown): void;
  lastActivityAt(): number;
}

export function trackDevServerActivity(now: () => number): DevServerActivity {
  let last = now();
  const open = new Set<string>();
  return {
    record(entry) {
      const { event, requestId } = (entry ?? {}) as { event?: unknown; requestId?: unknown };
      if (typeof event !== 'string' || !METRO_REQUEST_EVENTS.has(event)) return;
      if (typeof requestId === 'string') {
        if (event === 'bundle_response_started') open.add(requestId);
        else if (event === 'bundle_response_finished' || event === 'bundle_response_failed') open.delete(requestId);
      }
      last = now();
    },
    lastActivityAt: () => (open.size > 0 ? now() : last),
  };
}

export interface IdleProbe {
  lastActivityAt(): number;
  blocker(): string | null | Promise<string | null>;
}

function deviceTargets(root: string): Omit<ActivityTarget, 'workspace'>[] {
  const serialOf = ownedAvdSerialResolver({ timeoutMs: 5000 });
  return projectDeviceSlots(getProject(root)).flatMap(({ slot, platforms }) => {
    const targets: Omit<ActivityTarget, 'workspace'>[] = [];
    if (platforms.ios?.deviceUdid) targets.push({ platform: 'ios', id: platforms.ios.deviceUdid, slot });
    const android = platforms.android;
    const serial = android?.avdName ? serialOf(android.avdName).serial : android?.serial;
    if (serial) targets.push({ platform: 'android', id: serial, slot });
    return targets;
  });
}

function heldDeviceLease(root: string, now: number): string | null {
  for (const [key, record] of Object.entries(parseWorkspaceLeases(readWorkspaceState(root)?.deviceLeases))) {
    const platform = parseDeviceSlotKey(key)?.platform;
    if (!platform) continue;
    let raw: string;
    try {
      raw = readFileSync(deviceLeasePath(platform, record.id), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      return `${platform} device ${record.id} has a lease that cannot be read (${describeError(error)})`;
    }
    const lease = parseLease(raw);
    if (!lease) return `${platform} device ${record.id} has a lease that cannot be read`;
    if (lease.token !== record.token || leaseIsExpired(lease, now)) continue;
    const by = record.kind === 'declared' ? 'stim device lock' : 'a stim ios or android run';
    return `${platform} device ${record.id} is leased by ${by} until ${lease.expiresAt}`;
  }
  return null;
}

export function workspaceIdleProbe(
  root: string,
  { platform = process.platform }: { platform?: NodeJS.Platform } = {},
): IdleProbe {
  return {
    lastActivityAt: () => workspaceDeviceLastUseAt(root),
    async blocker() {
      if (workspaceBuildInProgress(root)) return 'a build is in progress';
      for (const native of ['ios', 'android'] as const) {
        const records = Object.values(hostedNativeRecords(readWorkspaceState(root), native));
        if (records.length) {
          const placement = parseHostedNativePlacement(records[0], native);
          return placement
            ? `its ${native === 'ios' ? 'iOS simulator' : 'Android emulator'} runs on ${placement.machine}`
            : `its hosted ${native} placement is unreadable`;
        }
      }
      const lease = heldDeviceLease(root, Date.now());
      if (lease) return lease;
      const readActivity = createActivityReader();
      for (const target of deviceTargets(root)) {
        const activity = readActivity({ ...target, workspace: root });
        if (activity.state === 'driven') {
          return `${target.platform} device ${target.id} is driven by ${activity.driver?.tool ?? 'an unknown tool'}`;
        }
        // The host driver probe runs `ps -axww`, which Windows lacks. Stim drives only Android there, and
        // Android drivers (Maestro, Appium, UI Automator) run on-device instrumentation the adb probe reads.
        const unknown =
          platform === 'win32' ? activity.basis.filter((basis) => basis !== 'driver-process') : activity.basis;
        if (activity.state === 'unknown' && unknown.length > 0) {
          return `${target.platform} device ${target.id} has unknown activity (${unknown.join(', ')})`;
        }
      }
      return liveShareKeepReason(root);
    },
  };
}

export function watchIdleDevServer({
  idleStopMs,
  now,
  serverActivityAt,
  probe,
  onIdle,
  checkMs = IDLE_CHECK_MS,
}: {
  idleStopMs: number;
  now: () => number;
  serverActivityAt: () => number;
  probe: IdleProbe;
  onIdle: (idleMinutes: () => Promise<number | null>) => Promise<void>;
  checkMs?: number;
}): () => void {
  const idleMinutes = async (): Promise<number | null> => {
    const last = Math.max(serverActivityAt(), ...[probe.lastActivityAt()].filter(Number.isFinite));
    if (now() - last < idleStopMs) return null;
    let blocker: string | null;
    try {
      blocker = await probe.blocker();
    } catch (error) {
      blocker = describeError(error);
    }
    return blocker ? null : Math.floor((now() - last) / MINUTE_MS);
  };
  let deciding = false;
  const timer = setInterval(
    () => {
      if (deciding) return;
      deciding = true;
      void idleMinutes()
        .then((minutes) => (minutes === null ? undefined : onIdle(idleMinutes)))
        .finally(() => {
          deciding = false;
        });
    },
    Math.min(checkMs, idleStopMs),
  );
  timer.unref?.();
  return () => clearInterval(timer);
}

/**
 * Checks each minute, once the workspace has gone `idleMs` without a Stim command, whether an owned device is due
 * for idle shutdown, and runs `onDue` for it.
 */
export function watchIdleDevices({
  idleMs,
  now,
  lastUseAt,
  hasDue,
  onDue,
  checkMs = IDLE_CHECK_MS,
}: {
  idleMs: number;
  now: () => number;
  lastUseAt: () => number;
  hasDue: () => boolean;
  onDue: () => Promise<void>;
  checkMs?: number;
}): () => void {
  let deciding = false;
  const timer = setInterval(
    () => {
      if (deciding || now() - lastUseAt() < idleMs) return;
      let due: boolean;
      try {
        due = hasDue();
      } catch {
        return;
      }
      if (!due) return;
      deciding = true;
      void onDue().finally(() => {
        deciding = false;
      });
    },
    Math.min(checkMs, idleMs),
  );
  timer.unref?.();
  return () => clearInterval(timer);
}
