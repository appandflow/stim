import { join } from 'node:path';
import { deviceSlotPlatforms, projectDeviceSlots } from '../devices/device-slots.ts';
import {
  getConcurrencyLimits,
  getConfigDir,
  loadConfig,
  type Config,
  type ProjectRecord,
} from '../workspace/config.ts';
import {
  iosRuntimeMatches,
  listAllIosSims,
  listIosDeviceTypes,
  parseRuntimeVersion,
  type IosRuntime,
} from '../devices/ios.ts';
import { listAdbDevices, type SystemImage } from '../devices/android.ts';
import { formatElapsed, phaseLine } from '../command-output.ts';
import { readClaimSet, releaseClaim, tryAcquireClaim, type ClaimHandle } from '../ownership-claim.ts';
import { withWorkspaceProcessLock, workspaceProcessLockError } from './workspace-process-lock.ts';
import type { SettingScope } from '@stim-cli/core/state';

type SimRecord = ReturnType<typeof listAllIosSims>[number];
type DeviceTypeInfo = ReturnType<typeof listIosDeviceTypes>[number];
type AdbDevices = ReturnType<typeof listAdbDevices>;
type EmulatorPort = { consolePort?: number | null };
type Listing<T> = T | (() => T);

interface CapacityRefusal {
  code: string;
  message: string;
  remedy: string;
}

export interface BootingDevice {
  platform: string;
  key: string;
}

interface DeviceInventory {
  sims: SimRecord[];
  adb: AdbDevices;
  config: Config | null;
  booting: BootingDevice[];
}

export interface InventorySources {
  sims?: Listing<SimRecord[]>;
  adb?: Listing<AdbDevices>;
  config?: Listing<Config | null>;
  booting?: Listing<BootingDevice[]>;
}

const LIVE_SIM_STATES = new Set(['Booted', 'Booting']);
const ADMISSION_LOCK = 'device-admission';
const ADMISSION_LOCK_WAIT_MS = 5 * 60_000;
const LOCK_QUIET_MS = 5000;
const LOCK_PROGRESS_MS = 30_000;
const LISTING_TIMEOUT_MS = 30_000;
const NO_ADB: AdbDevices = { emulators: [], physical: [], unhealthy: [] };

export class DeviceAdmissionRefusal extends Error {
  readonly code: string;
  readonly remedy: string;

  constructor(refusal: CapacityRefusal) {
    super(refusal.message);
    this.code = refusal.code;
    this.remedy = refusal.remedy;
  }
}

class DeviceCountUnavailable extends Error {}

function deviceKey(platform: string, key: string): string {
  return `${platform}:${key}`;
}

function bootingDevicesRoot(): string {
  return join(getConfigDir(), 'device-boots');
}

function liveEmulatorPorts(adb: AdbDevices): EmulatorPort[] {
  return [...adb.emulators, ...adb.unhealthy.filter((entry) => entry.kind === 'emulator')];
}

function readBootingDevices(): BootingDevice[] {
  const survey = readClaimSet(bootingDevicesRoot());
  const booting: BootingDevice[] = [];
  for (const holder of survey.live) {
    const { platform, key } = holder.details;
    if (typeof platform === 'string' && typeof key === 'string') booting.push({ platform, key });
  }
  return booting;
}

function listSimsForCount(): SimRecord[] {
  return process.platform === 'darwin' ? listAllIosSims({ timeoutMs: LISTING_TIMEOUT_MS }) : [];
}

function listAdbForCount(): AdbDevices {
  return listAdbDevices({ timeoutMs: LISTING_TIMEOUT_MS });
}

function toolAbsent(error: unknown): boolean {
  const { code, status, stderr } = (error ?? {}) as { code?: unknown; status?: unknown; stderr?: unknown };
  return (
    code === 'ENOENT' ||
    status === 127 ||
    /unable to find utility|invalid active developer path|Xcode license/.test(String(stderr ?? ''))
  );
}

function recordsOwnedEmulator(config: Config | null): boolean {
  return Object.values(config?.projects || {}).some((project) =>
    projectDeviceSlots(project).some(
      ({ platforms }) => platforms.android?.owned && typeof platforms.android.consolePort === 'number',
    ),
  );
}

function liveOwnedDeviceKeys({
  sims = [],
  adbEmulators = [],
  config = null,
  booting = [],
}: Partial<Omit<DeviceInventory, 'adb'>> & { adbEmulators?: EmulatorPort[] }): Set<string> {
  const keys = new Set<string>();
  for (const sim of sims) {
    if (!sim?.name?.startsWith('stim-')) continue;
    if (LIVE_SIM_STATES.has(sim.state)) keys.add(deviceKey('ios', sim.udid));
  }
  const livePorts = new Set(adbEmulators.map((e) => e.consolePort));
  for (const proj of Object.values(config?.projects || {})) {
    for (const { platforms } of projectDeviceSlots(proj)) {
      const android = platforms.android;
      if (
        android?.owned &&
        android.avdName &&
        typeof android.consolePort === 'number' &&
        livePorts.has(android.consolePort)
      ) {
        keys.add(deviceKey('android', android.avdName));
      }
    }
  }
  for (const device of booting) keys.add(deviceKey(device.platform, device.key));
  return keys;
}

function inventoryKeys(inventory: DeviceInventory): Set<string> {
  return liveOwnedDeviceKeys({ ...inventory, adbEmulators: liveEmulatorPorts(inventory.adb) });
}

function atCapacityRefusal(count: number, max: number): CapacityRefusal {
  return {
    code: 'STIM_AT_CAPACITY',
    message: `${count} Stim device(s) are already booted and concurrency.maxDevices is ${max}, so booting another would exceed the cap.`,
    remedy: 'stop an environment (stim stop) or raise concurrency.maxDevices',
  };
}

function uncountedRefusal(error: unknown): CapacityRefusal {
  return {
    code: 'STIM_NO_DEVICE',
    message: `concurrency.maxDevices is set, and Stim could not count the booted devices: ${(error as Error)?.message || error}`,
    remedy: `Listing devices times out when the machine is overloaded: retry once the load falls. Otherwise run \`stim doctor\` to check the simulator and adb toolchains, and check that ${join(getConfigDir(), 'config.json')} and ${bootingDevicesRoot()} are readable.`,
  };
}

function listed<T>(source: Listing<T>, empty: T, absent: (error: unknown) => boolean = () => false): T {
  try {
    return (typeof source === 'function' ? (source as () => T)() : source) ?? empty;
  } catch (error) {
    if (absent(error)) return empty;
    throw new DeviceCountUnavailable('', { cause: error });
  }
}

function readInventory({
  sims = listSimsForCount,
  adb = listAdbForCount,
  config = loadConfig,
  booting = readBootingDevices,
}: InventorySources): DeviceInventory | CapacityRefusal {
  try {
    const recorded = listed(config, null);
    return {
      booting: listed(booting, []),
      sims: listed(sims, [], toolAbsent),
      adb: recordsOwnedEmulator(recorded) ? listed(adb, NO_ADB, toolAbsent) : NO_ADB,
      config: recorded,
    };
  } catch (error) {
    if (error instanceof DeviceCountUnavailable) return uncountedRefusal(error.cause);
    throw error;
  }
}

/**
 * Owned simulators that are booted or booting, owned emulators adb lists in any state, and devices another
 * run is booting under `concurrency.maxDevices`, each counted once; when a listing fails, why the count is unknown.
 */
export function countLiveOwnedDevices(sources: InventorySources = {}): number | { unknown: string } {
  const inventory = readInventory(sources);
  return 'code' in inventory ? { unknown: inventory.message } : inventoryKeys(inventory).size;
}

function workspaceHasLiveDevice({
  platform,
  project,
  slot = 'default',
  sims = [],
  adbEmulators = [],
}: Partial<{
  platform: string;
  project: ProjectRecord | null;
  slot: string;
  sims: SimRecord[];
  adbEmulators: EmulatorPort[];
}> = {}) {
  if (!platform) return false;
  const record = deviceSlotPlatforms(project, slot)?.[platform];
  if (!record) return false;
  if (platform === 'ios') {
    return sims.some((s) => s.udid === record.deviceUdid && LIVE_SIM_STATES.has(s.state));
  }
  return typeof record.consolePort === 'number' && adbEmulators.some((e) => e.consolePort === record.consolePort);
}

export function deviceCapacityRefusal({
  platform,
  project,
  slot = 'default',
  max,
  sims = [],
  adb = null,
  config = null,
  booting = [],
}: Partial<{
  platform: string;
  project: ProjectRecord | null;
  slot: string;
  max: number;
  sims: SimRecord[];
  adb: AdbDevices | null;
  config: Config | null;
  booting: BootingDevice[];
}> = {}): CapacityRefusal | null {
  if (!max || max <= 0) return null;
  const adbEmulators = liveEmulatorPorts(adb ?? NO_ADB);
  if (workspaceHasLiveDevice({ platform, project, slot, sims, adbEmulators })) return null;
  const count = liveOwnedDeviceKeys({ sims, adbEmulators, config, booting }).size;
  return count < max ? null : atCapacityRefusal(count, max);
}

/**
 * The early `concurrency.maxDevices` check, before Metro starts or a device is created. It is advisory, so an
 * unknown count passes: `withDeviceBootAdmission` makes the binding decision when the boot starts.
 */
export function checkDeviceCapacity({
  platform,
  project,
  slot = 'default',
  max,
  ...sources
}: Partial<{
  platform: string;
  project: ProjectRecord | null;
  slot: string;
  max: number;
}> &
  InventorySources = {}): CapacityRefusal | null {
  if (!max || max <= 0) return null;
  const inventory = readInventory(sources);
  if ('code' in inventory) return null;
  return deviceCapacityRefusal({ platform, project, slot, max, ...inventory });
}

function admissionRefusal(device: BootingDevice, max: number, sources: InventorySources): CapacityRefusal | null {
  const inventory = readInventory(sources);
  if ('code' in inventory) return inventory;
  const keys = inventoryKeys(inventory);
  const own = deviceKey(device.platform, device.key);
  if (device.platform === 'ios' && keys.has(own)) return null;
  keys.delete(own);
  return keys.size < max ? null : atCapacityRefusal(keys.size, max);
}

function takeBootMarker(device: BootingDevice): ClaimHandle {
  const attempt = tryAcquireClaim({
    root: bootingDevicesRoot(),
    mode: 'shared',
    label: 'device boot',
    details: { platform: device.platform, key: device.key },
  });
  if (attempt.acquired) return attempt.acquired;
  throw new DeviceAdmissionRefusal({
    code: 'STIM_NO_DEVICE',
    message: `Another process holds ${bootingDevicesRoot()} exclusively, so this boot cannot be counted toward concurrency.maxDevices.`,
    remedy: 'Retry once that process finishes.',
  });
}

async function admit(
  device: BootingDevice,
  max: number,
  sources: InventorySources,
  lockWaitMs: number,
  out: (line: string) => void,
): Promise<ClaimHandle> {
  const started = Date.now();
  let lastLine: number | null = null;
  const onHeld = () => {
    const elapsed = Date.now() - started;
    if (elapsed < LOCK_QUIET_MS || (lastLine !== null && Date.now() - lastLine < LOCK_PROGRESS_MS)) return;
    lastLine = Date.now();
    out(phaseLine('device', `waiting for other runs to finish counting booted devices (${formatElapsed(elapsed)})`));
  };
  try {
    return await withWorkspaceProcessLock(
      getConfigDir(),
      ADMISSION_LOCK,
      async () => {
        const refusal = admissionRefusal(device, max, sources);
        if (refusal) throw new DeviceAdmissionRefusal(refusal);
        return takeBootMarker(device);
      },
      { external: true, waitMs: lockWaitMs, onHeld },
    );
  } catch (error) {
    if (workspaceProcessLockError(error) !== 'timeout') throw error;
    throw new DeviceAdmissionRefusal({
      code: 'STIM_NO_DEVICE',
      message: `Waited ${formatElapsed(lockWaitMs)} for other runs to finish counting booted devices for concurrency.maxDevices.`,
      remedy: 'Listing devices is slow, which usually means the machine is overloaded. Retry once the load falls.',
    });
  }
}

/**
 * Boots `device` only if one more owned device fits under `concurrency.maxDevices`. The count and the
 * marker that makes this boot visible to other runs are taken under one lock in `$STIM_HOME`, so concurrent
 * runs cannot all pass the cap; the marker is held until `boot` settles. Throws DeviceAdmissionRefusal.
 */
export async function withDeviceBootAdmission<T>(
  device: BootingDevice,
  boot: () => Promise<T>,
  {
    max = getConcurrencyLimits().maxDevices,
    sources = {},
    lockWaitMs = ADMISSION_LOCK_WAIT_MS,
    out = () => {},
  }: { max?: number; sources?: InventorySources; lockWaitMs?: number; out?: (line: string) => void } = {},
): Promise<T> {
  if (!max || max <= 0) return boot();
  const marker = await admit(device, max, sources, lockWaitMs, out);
  try {
    return await boot();
  } finally {
    releaseClaim(marker);
  }
}

export function deviceTypeMismatch(
  recordedTypeId: string | undefined | null,
  requestedName: string | undefined | null,
  deviceTypes: DeviceTypeInfo[],
): string | null {
  if (!requestedName || !recordedTypeId) return null;
  const wanted = (deviceTypes || []).find((d) => d.name === requestedName);
  if (!wanted) return null;
  if (wanted.identifier === recordedTypeId) return null;
  const recorded = (deviceTypes || []).find((d) => d.identifier === recordedTypeId);
  return `this project's sim is ${recorded ? recorded.name : recordedTypeId}, but --device-type asked for ${requestedName}`;
}

export function runtimeMismatch(
  recordedRuntimeId: string | undefined | null,
  requested: string | undefined | null,
  runtimes: IosRuntime[],
): string | null {
  if (!requested || !recordedRuntimeId) return null;
  const wanted = runtimes.find((r) => iosRuntimeMatches(r, requested));
  if (!wanted || wanted.identifier === recordedRuntimeId) return null;
  return `this project's sim runs iOS ${parseRuntimeVersion(recordedRuntimeId)}, but --runtime asked for ${requested}`;
}

export interface UnknownDeviceNameRefusal {
  message: string;
  remedy: string;
}

function installedNames(names: Array<string | null | undefined>): string {
  const unique = [...new Set(names.filter((n): n is string => typeof n === 'string' && n !== ''))];
  return unique.length > 0 ? unique.join(', ') : 'none';
}

/** Appends which settings layer supplied an unresolved device selector, so the user knows where to fix it. */
export function layerNote(
  refusal: UnknownDeviceNameRefusal,
  key: string,
  flag: string | null | undefined,
  origin: SettingScope | null,
): UnknownDeviceNameRefusal {
  if (flag !== undefined && flag !== null) return refusal;
  if (!origin) return refusal;
  return {
    message: `${refusal.message} ${key} is set at the ${origin} layer.`,
    remedy: `${refusal.remedy} Fix it with \`stim settings set ${key} <value> --scope ${origin}\` or \`stim settings unset ${key} --scope ${origin}\`.`,
  };
}

export function unknownIosRuntimeRefusal(
  requested: string | null | undefined,
  runtimes: IosRuntime[],
): UnknownDeviceNameRefusal | null {
  if (!requested) return null;
  if ((runtimes || []).some((r) => iosRuntimeMatches(r, requested))) return null;
  return {
    message: `No installed simulator runtime matches "${requested}". Installed runtimes: ${installedNames((runtimes || []).map((r) => r.version))}.`,
    remedy:
      'Pass `--runtime` (or set ios.runtime) a version printed above ("26.5") or a runtime\'s full name ("iOS 26.5"); nothing else matches. Install more runtimes through Xcode.',
  };
}

function creatableIosDeviceTypeNames(runtimes: IosRuntime[], runtime?: string | null): string[] {
  const scoped = runtime ? (runtimes || []).filter((r) => iosRuntimeMatches(r, runtime)) : runtimes || [];
  return scoped.flatMap((r) => (r.supportedDeviceTypes || []).map((d) => d.name));
}

export function unknownIosDeviceTypeRefusal(
  requested: string | null | undefined,
  runtimes: IosRuntime[],
  runtime?: string | null,
): UnknownDeviceNameRefusal | null {
  if (!requested) return null;
  const creatable = creatableIosDeviceTypeNames(runtimes, runtime);
  if (creatable.includes(requested)) return null;
  const scope = runtime ? `runtime ${runtime}` : 'any installed simulator runtime';
  const offered = runtime ? `Device types runtime ${runtime} supports` : 'Device types the installed runtimes support';
  return {
    message: `No device type named "${requested}" can be created on ${scope}. ${offered}: ${installedNames(creatable)}.`,
    remedy:
      'Pass `--device-type` (or set ios.deviceType) one of the names printed above, exactly as `xcrun simctl list devicetypes` spells it. `xcrun simctl list devicetypes` also lists watchOS, tvOS and visionOS models, which no iOS runtime can create. Install more models through Xcode.',
  };
}

export function unknownAndroidSystemImageRefusal(
  requested: string | null | undefined,
  images: SystemImage[],
): UnknownDeviceNameRefusal | null {
  if (!requested) return null;
  if ((images || []).some((i) => i.pkg === requested)) return null;
  return {
    message: `No installed Android system image is named "${requested}". Installed system images: ${installedNames((images || []).map((i) => i.pkg))}.`,
    remedy:
      'Pass `--system-image` (or set android.systemImage) to one of the package ids printed above. Install more with `sdkmanager "system-images;android-36;google_apis;arm64-v8a"`.',
  };
}

export function unknownAndroidDeviceProfileRefusal(
  requested: string | null | undefined,
  profiles: string[],
): UnknownDeviceNameRefusal | null {
  if (!requested) return null;
  if (profiles.includes(requested)) return null;
  return {
    message: `No Android hardware profile is named "${requested}". Profiles avdmanager offers: ${installedNames(profiles)}.`,
    remedy:
      'Pass `--device-profile` (or set android.deviceProfile) to one of the ids printed above, exactly as `avdmanager list device -c` spells it, e.g. "pixel_fold" or "pixel_tablet".',
  };
}
