import {
  DEVICE_IDLE_SHUTDOWN_KEY,
  readDeviceIdleShutdowns,
  type DeviceActivity,
  type DeviceIdleShutdownRecord,
} from '@stim-cli/core/state';
import { formatLongDuration } from '../command-output.ts';
import { collectOwnedDeviceActivity, workspaceBuildInProgress, type OwnedDeviceActivity } from '../commands/gc/idle.ts';
import { canonicalPath } from '../commands/gc/paths.ts';
import { loadConfig } from '../workspace/config.ts';
import { readWorkspaceState, updateWorkspaceState } from '../workspace/workspace-state.ts';
import { deviceSlotKey } from './device-slots.ts';
import { listAllIosSims, type IosSimRecord } from './ios.ts';
import { teardownOwnedAvd, teardownOwnedIosSim } from './teardown.ts';

const SIM_LIST_TIMEOUT_MS = 10_000;
const MINUTE_MS = 60_000;

/**
 * How long a booted owned device has been idle, when that is at least `idleMs` and nothing keeps it in use: no
 * driver, Stim or agent-device lock, or unreadable activity evidence, no build in the workspace, and no activity
 * (including an open stim-server viewer) for `idleMs`. Null keeps the device running.
 */
export function idleShutdownDueMs(
  activity: DeviceActivity,
  {
    idleMs,
    now,
    buildInProgress,
    platform = process.platform,
  }: { idleMs: number; now: number; buildInProgress: boolean; platform?: NodeJS.Platform },
): number | null {
  if (buildInProgress || activity.state === 'driven') return null;
  // The host driver probe runs `ps -axww`, which Windows lacks. Stim drives only Android there, and Android
  // drivers run on-device instrumentation the adb probe reads.
  const unknown = platform === 'win32' ? activity.basis.filter((basis) => basis !== 'driver-process') : activity.basis;
  if (activity.state === 'unknown' && unknown.length > 0) return null;
  const last = Date.parse(activity.lastActivityAt ?? '');
  if (!Number.isFinite(last)) return null;
  const idle = now - last;
  return idle >= idleMs ? idle : null;
}

export interface DueDevice {
  device: OwnedDeviceActivity;
  idleForMs: number;
}

function listSims(): IosSimRecord[] {
  try {
    return listAllIosSims({ timeoutMs: SIM_LIST_TIMEOUT_MS });
  } catch {
    return [];
  }
}

/** Booted owned devices idle for `idleMs`, in one workspace or all registered workspaces when root is absent. */
export function dueIdleDevices(root: string | undefined, idleMs: number, now: number = Date.now()): DueDevice[] {
  const config = loadConfig();
  if (!config) return [];
  const self = root === undefined ? undefined : canonicalPath(root);
  const projects = Object.fromEntries(
    Object.entries(config.projects).filter(([path]) => self === undefined || canonicalPath(path) === self),
  );
  const builds = new Map(Object.keys(projects).map((path) => [path, workspaceBuildInProgress(path)]));
  return collectOwnedDeviceActivity({ ...config, projects }, listSims(), now).flatMap((device) => {
    const idleForMs = idleShutdownDueMs(device.activity, {
      idleMs,
      now,
      buildInProgress: builds.get(device.project) ?? true,
    });
    return idleForMs === null ? [] : [{ device, idleForMs }];
  });
}

export interface IdleShutdownEvent {
  level: 'info' | 'warn';
  event: 'device_idle_shutdown' | 'device_idle_shutdown_failed';
  msg: string;
}

/**
 * Shuts down, through centralized teardown, each of the workspace's owned devices that is still idle for `idleMs`,
 * and records why. The caller holds the workspace's native-run lock, so no `ios` or `android` run is booting or
 * installing on them.
 */
export function shutDownIdleDevices(
  root: string,
  idleMs: number,
  log: (event: IdleShutdownEvent) => void,
  now: number = Date.now(),
  { only, reason }: { only?: OwnedDeviceActivity; reason?: DeviceIdleShutdownRecord['reason'] } = {},
): number {
  let shutDown = 0;
  for (const { device, idleForMs } of dueIdleDevices(root, idleMs, now)) {
    if (
      only &&
      (device.kind !== only.kind ||
        device.id !== only.id ||
        device.project !== only.project ||
        device.slot !== only.slot)
    )
      continue;
    const what = `${device.kind === 'ios' ? 'simulator' : 'emulator'} ${device.name}`;
    const outcome =
      device.kind === 'ios'
        ? teardownOwnedIosSim(device.id, { label: device.name, workspace: root })
        : teardownOwnedAvd(device.id, {
            owner: { projectPath: device.project, slot: device.slot },
            workspace: root,
          });
    if (outcome.status === 'torn-down') {
      shutDown++;
      const idleMinutes = Math.floor(idleForMs / MINUTE_MS);
      try {
        updateWorkspaceState(root, (state) => ({
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
        msg: `shut down ${what}, idle ${formatLongDuration(idleForMs)}${reason === 'reclaimed for a waiting run' ? ', reclaimed for a waiting run' : ''}`,
      });
    } else if (outcome.status !== 'missing') {
      log({
        level: 'warn',
        event: 'device_idle_shutdown_failed',
        msg: `could not shut down idle ${what}: ${outcome.reason}`,
      });
    }
  }
  return shutDown;
}

/** Forgets the slot's idle shutdown once a run boots its device again. */
export function clearDeviceIdleShutdown(root: string, platform: string, slot: string = 'default'): void {
  const key = deviceSlotKey(platform, slot);
  if (!(key in readDeviceIdleShutdowns(readWorkspaceState(root)))) return;
  updateWorkspaceState(root, (state) => {
    const { [key]: _cleared, ...rest } = readDeviceIdleShutdowns(state);
    const { [DEVICE_IDLE_SHUTDOWN_KEY]: _all, ...others } = state;
    return Object.keys(rest).length ? { ...others, [DEVICE_IDLE_SHUTDOWN_KEY]: rest } : others;
  });
}
