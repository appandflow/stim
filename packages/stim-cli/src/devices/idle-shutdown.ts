import { join } from 'node:path';
import { LOG_ROTATE_BYTES } from '@stim-cli/core';
import {
  DEVICE_IDLE_SHUTDOWN_KEY,
  DEVICE_METRO_IDLE_STOP_REASON,
  DEVICE_RECLAIM_REASON,
  readDeviceIdleShutdowns,
  type DeviceActivity,
  type DeviceIdleShutdownRecord,
} from '@stim-cli/core/state';
import { formatLongDuration } from '../command-output.ts';
import { collectOwnedDeviceActivity, workspaceBuildInProgress, type OwnedDeviceActivity } from '../commands/gc/idle.ts';
import { canonicalPath } from '../commands/gc/paths.ts';
import { createNdjsonWriter } from '../ndjson.ts';
import { loadConfig } from '../workspace/config.ts';
import { workspaceLogsDir } from '../workspace/paths.ts';
import { launchWithoutMetro, readWorkspaceLaunches } from '../supervisor/state.ts';
import { readWorkspaceState, updateWorkspaceStateAsync } from '../workspace/workspace-state.ts';
import { workspaceDeviceLastUseAt } from './activity.ts';
import { deviceSlotKey } from './device-slots.ts';
import { listAllIosSims, type IosSimRecord } from './ios.ts';
import { teardownOwnedAvd, teardownOwnedIosSim } from './teardown.ts';

const SIM_LIST_TIMEOUT_MS = 10_000;
const MINUTE_MS = 60_000;

/**
 * How long a booted owned device has been idle, when that is at least `idleMs` and nothing keeps it in use: no
 * driver, Stim or agent-device lock, or unreadable activity evidence, no build in the workspace, and no activity
 * (including an open stim-server viewer) for `idleMs`. `countDeviceLogs: false` leaves device log records out of
 * that activity. Null keeps the device running.
 */
export function idleShutdownDueMs(
  activity: DeviceActivity,
  {
    idleMs,
    now,
    buildInProgress,
    platform = process.platform,
    countDeviceLogs = true,
  }: { idleMs: number; now: number; buildInProgress: boolean; platform?: NodeJS.Platform; countDeviceLogs?: boolean },
): number | null {
  if (buildInProgress || activity.state === 'driven') return null;
  // The host driver probe runs `ps -axww`, which Windows lacks. Stim drives only Android there, and Android
  // drivers run on-device instrumentation the adb probe reads.
  const unknown = platform === 'win32' ? activity.basis.filter((basis) => basis !== 'driver-process') : activity.basis;
  if (activity.state === 'unknown' && unknown.length > 0) return null;
  const last = countDeviceLogs
    ? Date.parse(activity.lastActivityAt ?? '')
    : (newestActivity(activity, false)?.at ?? NaN);
  if (!Number.isFinite(last)) return null;
  const idle = now - last;
  return idle >= idleMs ? idle : null;
}

function newestActivity(activity: DeviceActivity, countDeviceLogs: boolean): { basis: string; at: number } | null {
  let newest: { basis: string; at: number } | null = null;
  for (const [basis, iso] of Object.entries(activity.recent ?? {})) {
    const at = Date.parse(iso ?? '');
    if ((countDeviceLogs || basis !== 'device-log') && Number.isFinite(at) && !(newest && newest.at >= at))
      newest = { basis, at };
  }
  return newest;
}

export interface DueDevice {
  device: OwnedDeviceActivity;
  idleForMs: number;
}

export interface DeviceLogRule {
  /**
   * Whether the workspace's Metro is stopped or stopping. Its device log records then stop counting as use of a slot
   * whose last launch loads its JS from Metro, since that app cannot run without it.
   */
  metroStopped?: (project: string) => boolean;
}

interface IdleDecision {
  device: OwnedDeviceActivity;
  idleForMs: number | null;
  keptBecause: () => string;
}

function listSims(): IosSimRecord[] {
  try {
    return listAllIosSims({ timeoutMs: SIM_LIST_TIMEOUT_MS });
  } catch {
    return [];
  }
}

function idleDecisions(
  root: string | undefined,
  idleMs: number,
  now: number,
  { metroStopped }: DeviceLogRule,
): IdleDecision[] {
  const config = loadConfig();
  if (!config) return [];
  const self = root === undefined ? undefined : canonicalPath(root);
  const stopped = new Set<string>();
  const projects = Object.fromEntries(
    Object.entries(config.projects).filter(([path]) => {
      if (self !== undefined && canonicalPath(path) !== self) return false;
      if (metroStopped?.(path)) stopped.add(path);
      const usedAt = workspaceDeviceLastUseAt(path, { countDeviceLogs: !stopped.has(path) });
      return !Number.isFinite(usedAt) || now - usedAt >= idleMs;
    }),
  );
  if (!Object.keys(projects).length) return [];
  const builds = new Map(Object.keys(projects).map((path) => [path, workspaceBuildInProgress(path)]));
  return collectOwnedDeviceActivity({ ...config, projects }, listSims(), now).map((device) => {
    const metroGone = stopped.has(device.project);
    const launch = metroGone
      ? readWorkspaceLaunches(device.project)[deviceSlotKey(device.kind, device.slot)]
      : undefined;
    const withoutMetro = launch ? launchWithoutMetro(launch) : null;
    const countDeviceLogs = !launch || withoutMetro !== null;
    const buildInProgress = builds.get(device.project) ?? true;
    const idleForMs = idleShutdownDueMs(device.activity, { idleMs, now, buildInProgress, countDeviceLogs });
    return {
      device,
      idleForMs,
      keptBecause: () => {
        const newest =
          !buildInProgress && (device.activity.state === 'idle' || device.activity.state === 'active')
            ? newestActivity(device.activity, countDeviceLogs)
            : null;
        if (newest?.basis === 'viewer') return 'a stim-server client is viewing it';
        if (newest?.basis === 'device-log' && metroGone) {
          const logged = `it logged ${formatLongDuration(Math.max(0, now - newest.at))} ago`;
          return withoutMetro
            ? `its last launch, ${withoutMetro}, runs without Metro, and ${logged}`
            : `no launch is recorded on its slot, and ${logged}`;
        }
        return `it is not idle for ${formatLongDuration(idleMs)}`;
      },
    };
  });
}

/** Booted owned devices idle for `idleMs`, in one workspace or all registered workspaces when root is absent. */
export function dueIdleDevices(
  root: string | undefined,
  idleMs: number,
  now: number = Date.now(),
  rule: DeviceLogRule = {},
): DueDevice[] {
  return idleDecisions(root, idleMs, now, rule).flatMap(({ device, idleForMs }) =>
    idleForMs === null ? [] : [{ device, idleForMs }],
  );
}

export interface IdleShutdownEvent {
  level: 'info' | 'warn';
  event: 'device_idle_shutdown' | 'device_idle_shutdown_failed';
  msg: string;
  skipped?: true;
}

/** Appends an idle shutdown record to the workspace's metro.ndjson, where the supervisor writes its own. */
export function writeIdleShutdownEvent(root: string, event: IdleShutdownEvent): void {
  const writer = createNdjsonWriter(join(workspaceLogsDir(root), 'metro.ndjson'), { maxBytes: LOG_ROTATE_BYTES });
  writer.write({ src: 'metro', ...event });
  writer.close();
}

/**
 * Shuts down, through centralized teardown, each of the workspace's owned devices that is still idle for `idleMs`,
 * and records why. `kept` hears why each other booted owned device stays up. The caller holds the workspace's
 * native-run lock, so no `ios` or `android` run is booting or installing on them.
 */
export async function shutDownIdleDevices(
  root: string,
  idleMs: number,
  log: (event: IdleShutdownEvent) => void,
  now: number = Date.now(),
  {
    only,
    reason,
    kept,
    ...rule
  }: {
    only?: OwnedDeviceActivity;
    reason?: DeviceIdleShutdownRecord['reason'];
    kept?: (line: string) => void;
  } & DeviceLogRule = {},
): Promise<number> {
  let shutDown = 0;
  for (const { device, idleForMs, keptBecause } of idleDecisions(root, idleMs, now, rule)) {
    if (
      only &&
      (device.kind !== only.kind ||
        device.id !== only.id ||
        device.project !== only.project ||
        device.slot !== only.slot)
    )
      continue;
    const what = `${device.kind === 'ios' ? 'simulator' : 'emulator'} ${device.name}`;
    if (idleForMs === null) {
      kept?.(`kept ${what} up: ${keptBecause()}`);
      continue;
    }
    const outcome =
      device.kind === 'ios'
        ? await teardownOwnedIosSim(device.id, { label: device.name, workspace: root })
        : await teardownOwnedAvd(device.id, {
            owner: { projectPath: device.project, slot: device.slot },
            workspace: root,
          });
    if (outcome.status === 'torn-down') {
      shutDown++;
      const idleMinutes = Math.floor(idleForMs / MINUTE_MS);
      try {
        await updateWorkspaceStateAsync(root, (state) => ({
          ...state,
          [DEVICE_IDLE_SHUTDOWN_KEY]: {
            ...readDeviceIdleShutdowns(state),
            [deviceSlotKey(device.kind, device.slot)]: {
              at: new Date(now).toISOString(),
              idleMinutes,
              ...(reason ? { reason } : {}),
            },
          },
        }));
      } catch (error) {
        log({
          level: 'warn',
          event: 'device_idle_shutdown_failed',
          msg: `shut down idle ${what} but could not record it: ${(error as Error)?.message || error}`,
        });
      }
      log({
        level: 'info',
        event: 'device_idle_shutdown',
        msg: `shut down ${what}, idle ${formatLongDuration(idleForMs)}${reason === DEVICE_RECLAIM_REASON ? ', reclaimed for a waiting run' : reason === DEVICE_METRO_IDLE_STOP_REASON ? ", with Metro's idle stop" : ''}`,
      });
    } else if (outcome.status !== 'missing') {
      log({
        level: 'warn',
        event: 'device_idle_shutdown_failed',
        msg: `could not shut down idle ${what}: ${outcome.reason}`,
        ...(outcome.status === 'skipped' ? { skipped: true as const } : {}),
      });
    }
  }
  return shutDown;
}

/** Forgets the slot's idle shutdown once a run boots its device again. */
export async function clearDeviceIdleShutdown(root: string, platform: string, slot: string = 'default'): Promise<void> {
  const key = deviceSlotKey(platform, slot);
  if (!(key in readDeviceIdleShutdowns(readWorkspaceState(root)))) return;
  await updateWorkspaceStateAsync(root, (state) => {
    const { [key]: _cleared, ...rest } = readDeviceIdleShutdowns(state);
    const { [DEVICE_IDLE_SHUTDOWN_KEY]: _all, ...others } = state;
    return Object.keys(rest).length ? { ...others, [DEVICE_IDLE_SHUTDOWN_KEY]: rest } : others;
  });
}
