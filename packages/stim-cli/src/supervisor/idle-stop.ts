import { statSync } from 'node:fs';
import { join } from 'node:path';
import { createActivityReader, type ActivityTarget } from '../devices/activity.ts';
import { ownedAvdSerialResolver } from '../devices/android.ts';
import { projectDeviceSlots } from '../devices/device-slots.ts';
import { workspaceBuildInProgress } from '../commands/gc/idle.ts';
import { getProject } from '../workspace/config.ts';
import { workspaceLogsDir } from '../workspace/paths.ts';
import { readWorkspaceState } from '../workspace/workspace-state.ts';
import { describeError } from './errors.ts';

const IDLE_CHECK_MS = 60_000;
const MINUTE_MS = 60_000;

export function isDevServerActivity(record: unknown): boolean {
  const event = (record as { event?: unknown } | null)?.event;
  return event === 'bundle_response_started' || event === 'expo_stdout';
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

export function workspaceIdleProbe(root: string): IdleProbe {
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
      const readActivity = createActivityReader();
      for (const target of deviceTargets(root)) {
        const activity = readActivity({ ...target, workspace: root });
        if (activity.state === 'driven') {
          return `${target.platform} device ${target.id} is driven by ${activity.driver?.tool ?? 'an unknown tool'}`;
        }
        if (activity.state === 'unknown') {
          return `${target.platform} device ${target.id} has unknown activity (${activity.basis.join(', ')})`;
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
  onIdle: (idleMinutes: number) => Promise<void>;
  checkMs?: number;
}): () => void {
  let deciding = false;
  const timer = setInterval(
    () => {
      if (deciding) return;
      const last = Math.max(serverActivityAt(), ...[probe.lastActivityAt()].filter(Number.isFinite));
      if (now() - last < idleStopMs) return;
      let blocker: string | null;
      try {
        blocker = probe.blocker();
      } catch (error) {
        blocker = describeError(error);
      }
      if (blocker) return;
      deciding = true;
      void onIdle(Math.floor((now() - last) / MINUTE_MS)).finally(() => {
        deciding = false;
      });
    },
    Math.min(checkMs, idleStopMs),
  );
  timer.unref?.();
  return () => clearInterval(timer);
}
