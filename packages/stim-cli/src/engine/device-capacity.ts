import { deviceSlotPlatforms, projectDeviceSlots } from '../devices/device-slots.ts';
import { loadConfig, type Config, type ProjectRecord } from '../workspace/config.ts';
import { iosRuntimeMatches, listAllIosSims, listIosDeviceTypes, type IosRuntime } from '../devices/ios.ts';
import { listAdbDevices, type SystemImage } from '../devices/android.ts';

type SimRecord = ReturnType<typeof listAllIosSims>[number];
type DeviceTypeInfo = ReturnType<typeof listIosDeviceTypes>[number];
type AdbDevices = ReturnType<typeof listAdbDevices>;
type EmulatorRecord = AdbDevices['emulators'][number];

interface CapacityRefusal {
  code: string;
  message: string;
  remedy: string;
}

export function liveOwnedDeviceCount({
  sims = [],
  adbEmulators = [],
  config = null,
}: { sims?: SimRecord[]; adbEmulators?: EmulatorRecord[]; config?: Config | null } = {}): number {
  let count = 0;
  for (const sim of sims) {
    if (sim?.state === 'Booted' && sim.name?.startsWith('stim-')) count++;
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
        count++;
      }
    }
  }
  return count;
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
  adbEmulators: EmulatorRecord[];
}> = {}) {
  if (!platform) return false;
  const record = deviceSlotPlatforms(project, slot)?.[platform];
  if (!record) return false;
  if (platform === 'ios') {
    return sims.some((s) => s.udid === record.deviceUdid && s.state === 'Booted');
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
}: Partial<{
  platform: string;
  project: ProjectRecord | null;
  slot: string;
  max: number;
  sims: SimRecord[];
  adb: AdbDevices | null;
  config: Config | null;
}> = {}): CapacityRefusal | null {
  if (!max || max <= 0) return null;
  const adbEmulators = adb?.emulators || [];
  if (workspaceHasLiveDevice({ platform, project, slot, sims, adbEmulators })) return null;
  const count = liveOwnedDeviceCount({ sims, adbEmulators, config });
  if (count < max) return null;
  return {
    code: 'STIM_AT_CAPACITY',
    message: `${count} Stim device(s) are already booted and concurrency.maxDevices is ${max}, so booting another would exceed the cap.`,
    remedy: 'stop an environment (stim stop) or raise concurrency.maxDevices',
  };
}

export function checkDeviceCapacity({
  platform,
  project,
  slot = 'default',
  max,
  sims = listAllIosSims,
  adb = listAdbDevices,
  config = loadConfig,
}: Partial<{
  platform: string;
  project: ProjectRecord | null;
  slot: string;
  max: number;
  sims: SimRecord[] | (() => SimRecord[]);
  adb: AdbDevices | (() => AdbDevices);
  config: Config | null | (() => Config | null);
}> = {}): CapacityRefusal | null {
  if (!max || max <= 0) return null;
  let simList: SimRecord[] = [];
  let adbRes: AdbDevices = { emulators: [], physical: [], unhealthy: [] };
  try {
    simList = typeof sims === 'function' ? sims() || [] : sims || [];
  } catch {}
  try {
    adbRes = typeof adb === 'function' ? adb() || adbRes : adb || adbRes;
  } catch {}
  let cfg: Config | null = null;
  try {
    cfg = typeof config === 'function' ? config() : (config ?? null);
  } catch {}
  return deviceCapacityRefusal({ platform, project, slot, max, sims: simList, adb: adbRes, config: cfg });
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

export interface UnknownDeviceNameRefusal {
  message: string;
  remedy: string;
}

function installedNames(names: Array<string | null | undefined>): string {
  const unique = [...new Set(names.filter((n): n is string => typeof n === 'string' && n !== ''))];
  return unique.length > 0 ? unique.join(', ') : 'none';
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
