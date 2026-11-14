import { deviceSlotPlatforms } from '../devices/device-slots.ts';
import { ownedDeviceLabel } from '../workspace/project.ts';
import type { ProjectRecord } from '../workspace/config.ts';
import { pidExists } from '../metro.ts';
import type { IosSimulatorApp } from '../devices/ios-simulator-viewer.ts';
import { IOS_BOOT_TIMEOUT_MS, listAllIosSims, resolveOwnedIosSim, type IosSimSnapshot } from '../devices/ios.ts';
import { avdStorageExists, configureNewOwnedAvd } from '../devices/android.ts';
import { teardownOwnedAvd } from '../devices/teardown.ts';
import { clearDeferredShutdown } from '../devices/deferred-shutdown.ts';
import { clearDeviceIdleShutdown } from '../devices/idle-shutdown.ts';
import { realSimSlimOps, type SimSlimOps } from './simslim.ts';
import type { DeviceSlotWaitPolicy } from './device-capacity.ts';
import { ensureIosBooted, ensureOwnedIosDevice, type IosBoot } from './device-ios.ts';
import { ANDROID_BOOT_TIMEOUT_MS, ensureAndroidBooted, ensureOwnedAndroidDevice } from './device-android.ts';

import { RecordedDeviceLostError } from './recorded-device.ts';

export { RecordedDeviceLostError } from './recorded-device.ts';

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
  /** This call created, adopted or booted the device on Android. Never persisted. */
  setup?: boolean;
  androidBoot?: Promise<OwnedDeviceRecord>;
  adoptionPending?: boolean;
  parkedCacheKey?: string;
  schemeApprovals?: string[];
  poolConfiguration?: string;
  /**
   * The boot this call started, and the promise that finishes it: the wait on
   * `simctl bootstatus -b` and SpringBoard's startup, then the mute and the
   * SimSlim reconcile that follow it.
   * `ensureBooted` joins it instead of listing simulators again. It is never
   * persisted.
   */
  booting?: IosBoot;
  /**
   * The udid of the owned simulator this call found already booted and configured. `ensureBooted` checks that
   * it can still spawn a process before listing simulators again, and lists and boots it only when that check
   * fails. It is never persisted.
   */
  booted?: string;
  /**
   * An iOS simulator this call has yet to create: it waits for a boot slot, and `created` settles with the
   * device once the slot is taken and `simctl create` has run. `runtimeId` is the runtime it will have. It is never
   * persisted.
   */
  creating?: { runtimeId: string; created: Promise<OwnedDeviceRecord> };
}

export interface DeviceSettings {
  ios?: { deviceType?: string; runtime?: string; simslim?: string; simslimProfile?: string };
  android?: {
    systemImage?: string;
    deviceProfile?: string;
    dataPartitionSizeGb?: number;
    avdConfigFile?: string;
    avdConfig?: Record<string, unknown>;
  };
}

export interface DeviceFlags {
  deviceSlotWait?: DeviceSlotWaitPolicy;
  simulatorApp?: IosSimulatorApp;
  deviceType?: string | null;
  runtime?: string | null;
  runtimeFlag?: string | null;
  systemImage?: string | null;
  systemImageFlag?: string | null;
  deviceProfile?: string | null;
  /** The only device this run may use: the slot's simulator UDID or AVD name. It never creates or adopts another. */
  expectedDevice?: string;
  /**
   * Lets an iOS run that must create its simulator return once its creation waits in the boot queue, with the
   * pending creation in `creating`, instead of waiting for the slot and the creation.
   */
  allowPendingCreation?: boolean;
  allowPendingAndroidBoot?: boolean;
}

export type Notify = (msg: string) => void;

function recordedDeviceId(platform: string, record: OwnedDeviceRecord | null): string | undefined {
  return platform === 'ios' ? record?.deviceUdid : record?.avdName;
}

function requireRecordedDevice(
  platform: string,
  record: OwnedDeviceRecord | null,
  expected: string,
  simSnapshot: IosSimSnapshot | undefined,
): void {
  if (
    !record?.owned ||
    recordedDeviceId(platform, record) !== expected ||
    record.setupIncomplete ||
    record.adoptionPending
  ) {
    throw new RecordedDeviceLostError(platform, expected, "is no longer this slot's owned device");
  }
  const exists =
    platform === 'ios'
      ? Boolean(
          resolveOwnedIosSim(expected, simSnapshot ? simSnapshot.read() : listAllIosSims({ includeUnavailable: true }))
            .sim,
        )
      : avdStorageExists(expected);
  if (!exists) throw new RecordedDeviceLostError(platform, expected, 'no longer exists as a Stim-owned device');
}

export type Liveness = (pid: number) => boolean;

export interface EmulatorLogging {
  logFile?: string | null;
  alive?: Liveness;
}

/**
 * Whether `ensureOwnedDevice` created, adopted or started booting the device, rather than finding it booted.
 * Undefined for a remote device, which those functions do not describe.
 */
export function didSetUpDevice(device: OwnedDeviceRecord, remote: boolean): boolean | undefined {
  return remote ? undefined : Boolean(device.setup || device.booting);
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
  slimOps = realSimSlimOps,
  simSnapshot,
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
  slimOps?: SimSlimOps;
  simSnapshot?: IosSimSnapshot;
} & EmulatorLogging): Promise<OwnedDeviceRecord> {
  const record = (deviceSlotPlatforms(project, slot)?.[platform] as OwnedDeviceRecord | undefined) ?? null;
  const expected = flags.expectedDevice;
  if (expected !== undefined) requireRecordedDevice(platform, record, expected, simSnapshot);
  await clearDeviceIdleShutdown(projectPath, platform, slot);
  if (platform === 'ios') await clearDeferredShutdown(projectPath, slot);
  if (slot && slot !== 'default') label = `${label}-${slot}`;
  const ensured =
    platform === 'ios'
      ? await ensureOwnedIosDevice({
          record,
          projectPath,
          slot,
          settingsRoot,
          label,
          settings,
          flags,
          note,
          out,
          slimOps,
          simSnapshot,
        })
      : await ensureOwnedAndroidDevice({
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
  if (expected !== undefined && recordedDeviceId(platform, ensured) !== expected) {
    throw new RecordedDeviceLostError(platform, expected, 'was replaced while this run prepared it');
  }
  return ensured;
}

const BOOT_POLL_MS = 500;

export interface BootResult {
  ok?: boolean;
  udid?: string;
  serial?: string;
  failed?: boolean;
  code?: string;
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
  deviceSlotWait,
}: { projectPath: string } & Partial<
  {
    platform: string;
    device: OwnedDeviceRecord | null;
    simulatorApp: IosSimulatorApp;
    deviceSlotWait: DeviceSlotWaitPolicy;
    timeoutMs: number;
    pollMs: number;
    out: Notify;
    projectPath: string;
    slot: string;
  } & EmulatorLogging
>): Promise<BootResult> {
  if (platform === 'ios')
    return ensureIosBooted({
      device,
      projectPath,
      slot,
      deviceSlotWait,
      simulatorApp,
      timeoutMs: timeoutMs ?? IOS_BOOT_TIMEOUT_MS,
      pollMs,
      out,
    });
  if (platform === 'android')
    return ensureAndroidBooted({
      device,
      deviceSlotWait,
      projectPath,
      slot,
      timeoutMs: timeoutMs ?? ANDROID_BOOT_TIMEOUT_MS,
      out,
      logFile,
      alive,
    });
  return { failed: true, reason: `Unknown platform "${platform}".` };
}
