import { deviceSlotPlatforms } from '../devices/device-slots.ts';
import { ownedDeviceLabel } from '../workspace/project.ts';
import type { ProjectRecord } from '../workspace/config.ts';
import { pidExists } from '../metro.ts';
import type { IosSimulatorApp } from '../devices/ios-simulator-viewer.ts';
import { IOS_BOOT_TIMEOUT_MS } from '../devices/ios.ts';
import { configureNewOwnedAvd } from '../devices/android.ts';
import { teardownOwnedAvd } from '../devices/teardown.ts';
import { reconcileSimSlim } from './simslim.ts';
import { ensureIosBooted, ensureOwnedIosDevice, type IosBoot } from './device-ios.ts';
import { ANDROID_BOOT_TIMEOUT_MS, ensureAndroidBooted, ensureOwnedAndroidDevice } from './device-android.ts';

export interface OwnedDeviceRecord {
  deviceUdid?: string;
  deviceName?: string;
  owned?: boolean;
  created?: boolean;
  avdName?: string;
  consolePort?: number;
  serial?: string;
  setupIncomplete?: boolean;
  bootPending?: boolean;
  simslimManaged?: boolean;
  deviceType?: string | null;
  runtime?: string | null;
  systemImage?: string | null;
  deviceProfile?: string | null;
  adopted?: boolean;
  adoptionPending?: boolean;
  parkedCacheKey?: string;
  poolConfiguration?: string;
  /**
   * The boot this call started, and the promise that finishes it: the wait on
   * `simctl bootstatus -b` and the SimSlim reconcile that follows it.
   * `ensureBooted` joins it instead of listing simulators again. It is never
   * persisted.
   */
  booting?: IosBoot;
}

export interface DeviceSettings {
  ios?: { deviceType?: string; runtime?: string; simslimProfile?: string };
  android?: {
    systemImage?: string;
    deviceProfile?: string;
    dataPartitionSizeGb?: number;
    avdConfigFile?: string;
    avdConfig?: Record<string, unknown>;
  };
}

export interface DeviceFlags {
  simulatorApp?: IosSimulatorApp;
  deviceType?: string | null;
  runtime?: string | null;
  systemImage?: string | null;
  /** The `--system-image` flag alone; unlike `systemImage`, never filled in from settings. */
  explicitSystemImage?: string | null;
  deviceProfile?: string | null;
}

export type Notify = (msg: string) => void;

export type Liveness = (pid: number) => boolean;

export interface EmulatorLogging {
  logFile?: string | null;
  alive?: Liveness;
}

export async function ensureOwnedDevice({
  platform,
  project,
  projectPath,
  slot,
  settingsRoot = projectPath,
  label = ownedDeviceLabel(projectPath),
  settings,
  flags = {},
  note = () => {},
  out = () => {},
  logFile = null,
  alive = pidExists,
  configureAvd = configureNewOwnedAvd,
  teardownAvd = teardownOwnedAvd,
  reconcileIosSimulator = reconcileSimSlim,
}: {
  platform: string;
  project?: ProjectRecord | null;
  projectPath: string;
  slot?: string;
  settingsRoot?: string;
  label?: string;
  settings: DeviceSettings;
  flags?: DeviceFlags;
  note?: Notify;
  out?: Notify;
  configureAvd?: typeof configureNewOwnedAvd;
  teardownAvd?: typeof teardownOwnedAvd;
  reconcileIosSimulator?: typeof reconcileSimSlim;
} & EmulatorLogging): Promise<OwnedDeviceRecord> {
  if (slot && slot !== 'default') label = `${label}-${slot}`;
  const record = (deviceSlotPlatforms(project, slot)?.[platform] as OwnedDeviceRecord | undefined) ?? null;
  if (platform === 'ios') {
    return ensureOwnedIosDevice({
      record,
      projectPath,
      slot,
      settingsRoot,
      label,
      settings,
      flags,
      note,
      out,
      reconcileIosSimulator,
    });
  }
  return ensureOwnedAndroidDevice({
    record,
    projectPath,
    slot,
    settingsRoot,
    label,
    settings,
    flags,
    note,
    out,
    logFile,
    alive,
    configureAvd,
    teardownAvd,
  });
}

const BOOT_POLL_MS = 500;

export interface BootResult {
  ok?: boolean;
  udid?: string;
  serial?: string;
  failed?: boolean;
  reason?: string;
  remedy?: string;
}

export async function ensureBooted({
  platform,
  device,
  simulatorApp,
  timeoutMs,
  pollMs = BOOT_POLL_MS,
  out = () => {},
  logFile = null,
  alive = pidExists,
  projectPath,
  slot,
}: Partial<
  {
    platform: string;
    device: OwnedDeviceRecord | null;
    simulatorApp: IosSimulatorApp;
    timeoutMs: number;
    pollMs: number;
    out: Notify;
    projectPath: string;
    slot: string;
  } & EmulatorLogging
> = {}): Promise<BootResult> {
  if (platform === 'ios')
    return ensureIosBooted({ device, simulatorApp, timeoutMs: timeoutMs ?? IOS_BOOT_TIMEOUT_MS, pollMs, out });
  if (platform === 'android')
    return ensureAndroidBooted({
      device,
      projectPath,
      slot,
      timeoutMs: timeoutMs ?? ANDROID_BOOT_TIMEOUT_MS,
      out,
      logFile,
      alive,
    });
  return { failed: true, reason: `Unknown platform "${platform}".` };
}
