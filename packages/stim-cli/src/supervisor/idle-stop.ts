import { statSync } from 'node:fs';
import { join } from 'node:path';
import { createActivityReader, type ActivityTarget } from '../devices/activity.ts';
import { ownedAvdSerialResolver } from '../devices/android.ts';
import { projectDeviceSlots } from '../devices/device-slots.ts';
import { workspaceBuildInProgress } from '../commands/gc/idle.ts';
import { leaseIsExpired, listLeaseFiles, parseWorkspaceLeases } from '../engine/device-lease.ts';
import { getProject } from '../workspace/config.ts';
import { workspaceLogsDir } from '../workspace/paths.ts';
import { readWorkspaceState } from '../workspace/workspace-state.ts';
import { describeError } from './errors.ts';

const IDLE_CHECK_MS = 60_000;
const MINUTE_MS = 60_000;

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
      if (event === 'bundle_response_started') {
        if (typeof requestId === 'string') open.add(requestId);
      } else if (event === 'bundle_response_finished' || event === 'bundle_response_failed') {
        if (typeof requestId === 'string') open.delete(requestId);
      } else if (event !== 'expo_stdout') {
        return;
      }
      last = now();
    },
    lastActivityAt: () => (open.size > 0 ? now() : last),
  };
}

export interface IdleProbe {
  lastActivityAt(): number;
  blocker(): string | null;
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
  const held = new Map(
    Object.values(parseWorkspaceLeases(readWorkspaceState(root)?.deviceLeases)).map((record) => [
      record.token,
      record.kind,
    ]),
  );
  if (held.size === 0) return null;
  for (const { lease } of listLeaseFiles()) {
    const kind = lease ? held.get(lease.token) : undefined;
    if (!lease || !kind || leaseIsExpired(lease, now)) continue;
    const by = kind === 'declared' ? 'stim device lock' : 'a stim ios or android run';
    return `${lease.platform} device ${lease.id} is leased by ${by} until ${lease.expiresAt}`;
  }
  return null;
}

export function workspaceIdleProbe(
  root: string,
  { platform = process.platform }: { platform?: NodeJS.Platform } = {},
): IdleProbe {
  return {
    lastActivityAt() {
      const used = Date.parse(String(readWorkspaceState(root)?.lastUsedAt ?? ''));
      let clientLog = NaN;
      try {
        clientLog = statSync(join(workspaceLogsDir(root), 'client.ndjson')).mtimeMs;
      } catch {}
      const times = [used, clientLog].filter(Number.isFinite);
      return times.length ? Math.max(...times) : NaN;
    },
    blocker() {
      if (workspaceBuildInProgress(root)) return 'a build is in progress';
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
      return null;
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
  onIdle: (idleMinutes: () => number | null) => Promise<void>;
  checkMs?: number;
}): () => void {
  const idleMinutes = (): number | null => {
    const last = Math.max(serverActivityAt(), ...[probe.lastActivityAt()].filter(Number.isFinite));
    if (now() - last < idleStopMs) return null;
    let blocker: string | null;
    try {
      blocker = probe.blocker();
    } catch (error) {
      blocker = describeError(error);
    }
    return blocker ? null : Math.floor((now() - last) / MINUTE_MS);
  };
  let deciding = false;
  const timer = setInterval(
    () => {
      if (deciding || idleMinutes() === null) return;
      deciding = true;
      void onIdle(idleMinutes).finally(() => {
        deciding = false;
      });
    },
    Math.min(checkMs, idleStopMs),
  );
  timer.unref?.();
  return () => clearInterval(timer);
}
