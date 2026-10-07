import { setTimeout as delay } from 'node:timers/promises';
import { basename, join } from 'node:path';
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
import { workspaceId } from '@stim-cli/core';
import { formatElapsed, phaseLine } from '../command-output.ts';
import { recordCapacityRefusal, recordCapacityWait } from './stats.ts';
import {
  ClaimRefusedError,
  inspectClaimSet,
  isClaimRefusal,
  readClaimSet,
  releaseClaim,
  tryAcquireClaim,
  type ClaimHandle,
  type ClaimHolder,
} from '../ownership-claim.ts';
import { withWorkspaceProcessLock, workspaceProcessLockError } from './workspace-process-lock.ts';
import { projectDeviceReclaimIdleMinutes } from '../workspace/settings.ts';
import { canonicalPath } from '../commands/gc/paths.ts';
import { reclaimIdleDevice } from '../devices/queue-reclaim.ts';
import type { BuildWaitingFor, SettingScope } from '@stim-cli/core/state';

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
  workspace?: string;
  displayName?: string;
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
const INVENTORY_REFRESH_MS = 10_000;
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
  const unresolved = survey.unresolved[0];
  if (unresolved) {
    throw new ClaimRefusedError({
      claimPath: unresolved.path,
      root: bootingDevicesRoot(),
      reason: unresolved.reason,
      label: 'device boot',
    });
  }
  const booting: BootingDevice[] = [];
  for (const holder of survey.live) {
    const { platform, key } = holder.details;
    if (typeof platform === 'string' && typeof key === 'string') {
      booting.push({
        platform,
        key,
        displayName: typeof holder.details.displayName === 'string' ? holder.details.displayName : undefined,
      });
    }
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
    message:
      count < max
        ? `${count}/${max} Stim devices are in use, but another run is ahead in the device slot queue.`
        : `${count} Stim device(s) are already booted and concurrency.maxDevices is ${max}, so booting another would exceed the cap.`,
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
    if (error instanceof DeviceCountUnavailable) {
      if (isClaimRefusal(error.cause)) throw error.cause;
      return uncountedRefusal(error.cause);
    }
    throw error;
  }
}

/**
 * Owned simulators that are booted or booting, owned emulators adb lists in any state, and devices another
 * run is booting under `concurrency.maxDevices`, each counted once; when a listing fails, why the count is unknown.
 */
export function countLiveOwnedDevices(sources: InventorySources = {}): number | { unknown: string } {
  try {
    const inventory = readInventory(sources);
    return 'code' in inventory ? { unknown: inventory.message } : inventoryKeys(inventory).size;
  } catch (error) {
    if (isClaimRefusal(error)) return { unknown: error.message };
    throw error;
  }
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
  let inventory: ReturnType<typeof readInventory>;
  try {
    inventory = readInventory(sources);
  } catch (error) {
    if (isClaimRefusal(error)) return null;
    throw error;
  }
  if ('code' in inventory) return null;
  return deviceCapacityRefusal({ platform, project, slot, max, ...inventory });
}

export interface DeviceSlotWaitPolicy {
  waitMs?: number;
  signal?: AbortSignal;
  noWait?: boolean;
  displayName?: string;
  waitingFor?: (info: BuildWaitingFor | null) => void;
  onWait?: (ms: number) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export const DEFAULT_DEVICE_SLOT_WAIT_MS = 600_000;

export function deviceSlotWaitingLine({
  count,
  max,
  holders,
  elapsedMs,
  queue,
}: {
  queue?: string;
  count: number;
  max: number;
  holders: string[];
  elapsedMs: number;
}): string {
  return `${'device'.padEnd(11)} waiting for a device slot (${count}/${max} in use${holders.length ? `: ${holders.join(', ')}` : ''}), ${formatElapsed(elapsedMs)} elapsed -- stim guide lifecycle concurrency${queue ? `; ${queue}` : ''}`;
}

function deviceHolders(inventory: DeviceInventory, keys: Set<string>): string[] {
  const names = new Map<string, string>();
  for (const [root, project] of Object.entries(inventory.config?.projects ?? {})) {
    for (const { platforms } of projectDeviceSlots(project)) {
      if (platforms.ios?.deviceUdid)
        names.set(deviceKey('ios', platforms.ios.deviceUdid), project.label || basename(root));
      if (platforms.android?.avdName)
        names.set(deviceKey('android', platforms.android.avdName), project.label || basename(root));
    }
  }
  for (const sim of inventory.sims) {
    const key = deviceKey('ios', sim.udid);
    if (!names.has(key)) names.set(key, sim.name);
  }
  for (const device of inventory.booting) {
    const key = deviceKey(device.platform, device.key);
    if (!names.has(key)) names.set(key, device.displayName ?? device.key);
  }
  return [...new Set([...keys].map((key) => names.get(key) ?? key.slice(key.indexOf(':') + 1)))].toSorted();
}

function liveWaiters(): ClaimHolder[] {
  const root = join(getConfigDir(), 'device-waits');
  const survey = inspectClaimSet(root, { label: 'device wait' });
  if (survey.exclusive) {
    throw new ClaimRefusedError({
      root,
      claimPath: survey.exclusive.path,
      reason: 'the wait queue is held exclusively',
      label: 'device wait',
    });
  }
  return survey.shared.toSorted(
    (a, b) =>
      (Number(a.details.sequence) || 0) - (Number(b.details.sequence) || 0) ||
      a.startedAt.localeCompare(b.startedAt) ||
      a.claimId.localeCompare(b.claimId),
  );
}

function takeWaitTicket(device: BootingDevice, waiters: ClaimHolder[]): ClaimHandle {
  const root = join(getConfigDir(), 'device-waits');
  const attempt = tryAcquireClaim({
    root,
    mode: 'shared',
    label: 'device wait',
    details: { ...device, sequence: Math.max(0, ...waiters.map((holder) => Number(holder.details.sequence) || 0)) + 1 },
  });
  if (attempt.acquired) return attempt.acquired;
  throw new ClaimRefusedError({
    root,
    claimPath: attempt.held?.path ?? root,
    reason: 'the wait queue is held exclusively',
    label: 'device wait',
  });
}

function takeBootMarker(device: BootingDevice): ClaimHandle {
  const attempt = tryAcquireClaim({
    root: bootingDevicesRoot(),
    mode: 'shared',
    label: 'device boot',
    details: { ...device },
  });
  if (attempt.acquired) return attempt.acquired;
  throw new DeviceAdmissionRefusal({
    code: 'STIM_NO_DEVICE',
    message: `Another process holds ${bootingDevicesRoot()} exclusively, so this boot cannot be counted toward concurrency.maxDevices.`,
    remedy: 'Retry once that process finishes.',
  });
}

async function admissionTransaction<T>(
  action: () => Promise<T>,
  lockWaitMs: number,
  out: (line: string) => void,
  signal?: AbortSignal,
): Promise<T> {
  const started = Date.now();
  let lastLine: number | null = null;
  const onHeld = () => {
    const elapsed = Date.now() - started;
    if (elapsed < LOCK_QUIET_MS || (lastLine !== null && Date.now() - lastLine < LOCK_PROGRESS_MS)) return;
    lastLine = Date.now();
    out(phaseLine('device', `waiting for other runs to finish counting booted devices (${formatElapsed(elapsed)})`));
  };
  try {
    return await withWorkspaceProcessLock(getConfigDir(), ADMISSION_LOCK, action, {
      external: true,
      waitMs: lockWaitMs,
      onHeld,
      signal,
    });
  } catch (error) {
    if (workspaceProcessLockError(error) !== 'timeout') throw error;
    throw new DeviceAdmissionRefusal({
      code: 'STIM_NO_DEVICE',
      message: `Waited ${formatElapsed(lockWaitMs)} for other runs to finish counting booted devices for concurrency.maxDevices.`,
      remedy: 'Listing devices is slow, which usually means the machine is overloaded. Retry once the load falls.',
    });
  }
}

/** Boots an owned device under the Stim home's cap, reserving capacity before releasing admission. */
export async function withDeviceBootAdmission<T>(
  device: BootingDevice,
  boot: () => Promise<T>,
  {
    root,
    max = getConcurrencyLimits().maxDevices,
    sources = {},
    lockWaitMs = ADMISSION_LOCK_WAIT_MS,
    out = () => {},
    waitMs = DEFAULT_DEVICE_SLOT_WAIT_MS,
    noWait = false,
    displayName = basename(root),
    now = Date.now,
    signal,
    sleep = (ms) => delay(ms, undefined, { signal }),
    waitingFor = () => {},
    onWait = () => {},
  }: DeviceSlotWaitPolicy & {
    root: string;
    max?: number;
    sources?: InventorySources;
    lockWaitMs?: number;
    out?: (line: string) => void;
  },
): Promise<T> {
  signal?.throwIfAborted();
  if (!max || max <= 0) return boot();
  const workspace = workspaceId(root);
  device = { ...device, workspace, displayName };
  let ticket: ClaimHandle | undefined;
  let marker: ClaimHandle | undefined;
  let started: number | undefined;
  let lastLine = -Infinity;
  let visibleWait = false;
  let lastInventory = { count: 0, holders: [] as string[] };
  let lastListed = -Infinity;
  let reclaimed = 0;
  let lastReclaim = -Infinity;
  const skippedReclaims = new Set<string>();
  try {
    try {
      for (;;) {
        const result = await admissionTransaction(
          async () => {
            signal?.throwIfAborted();
            const waiters = liveWaiters();
            const first = waiters[0];
            const turn = !first || first.claimId === ticket?.claimId;
            const admit = () => {
              const admitted = takeBootMarker(device);
              if (releaseClaim(ticket)) ticket = undefined;
              return { marker: admitted };
            };
            const wait = ({ count, holders }: typeof lastInventory) => {
              const ticketId = ticket?.claimId;
              const position = ticketId
                ? waiters.findIndex((holder) => holder.claimId === ticketId) + 1
                : waiters.length + 1;
              const headName = first?.details.displayName ?? displayName;
              const queue = `queue position ${position}${position > 1 ? ' behind' : ', head'} ${headName}; queue: ${join(getConfigDir(), 'device-waits')}`;
              if (noWait || waitMs === 0) throw new DeviceAdmissionRefusal(atCapacityRefusal(count, max));
              if (started !== undefined && now() - started >= waitMs) {
                throw new DeviceAdmissionRefusal({
                  code: 'STIM_AT_CAPACITY',
                  message: `Waited ${formatElapsed(now() - started)} for a device slot; ${count}/${max} Stim devices are in use; ${queue}.`,
                  remedy:
                    'Stop an environment (stim stop), retry with a longer --wait <seconds>, or raise concurrency.maxDevices.',
                });
              }
              if (!ticket) {
                ticket = takeWaitTicket(device, waiters);
                started = now();
              }
              return { count, holders, queue, reclaim: turn && count >= max };
            };
            if (ticket && !turn && now() - lastListed < INVENTORY_REFRESH_MS) {
              const booting = sources.booting ?? readBootingDevices;
              const own = deviceKey(device.platform, device.key);
              const claims = typeof booting === 'function' ? booting() : booting;
              if (claims.some((entry) => deviceKey(entry.platform, entry.key) === own)) return admit();
              return wait(lastInventory);
            }
            const inventory = readInventory(sources);
            if ('code' in inventory) throw new DeviceAdmissionRefusal(inventory);
            const keys = inventoryKeys(inventory);
            const own = deviceKey(device.platform, device.key);
            const ownBooting = inventory.booting.some((entry) => deviceKey(entry.platform, entry.key) === own);
            if ((device.platform === 'ios' && keys.has(own)) || ownBooting) return admit();
            keys.delete(own);
            if (keys.size < max && turn) return admit();
            lastListed = now();
            lastInventory = { count: keys.size, holders: deviceHolders(inventory, keys) };
            return wait(lastInventory);
          },
          lockWaitMs,
          out,
          signal,
        );
        if ('marker' in result) {
          marker = result.marker;
          signal?.throwIfAborted();
          break;
        }
        signal?.throwIfAborted();
        const elapsedMs = now() - started!;
        visibleWait = true;
        waitingFor({ kind: 'device-slot', inUse: result.count, max, since: new Date(started!).toISOString() });
        if (now() - lastLine >= 10_000) {
          lastLine = now();
          out(
            deviceSlotWaitingLine({
              count: result.count,
              max,
              holders: result.holders,
              elapsedMs,
              queue: result.queue,
            }),
          );
        }
        if (result.reclaim && now() - lastReclaim >= 15_000) {
          lastReclaim = now();
          try {
            const minutes = projectDeviceReclaimIdleMinutes(canonicalPath(root));
            if (minutes > 0) reclaimed += await reclaimIdleDevice(root, minutes * 60_000, out, now, skippedReclaims);
          } catch (error) {
            out(phaseLine('device', `could not reclaim an idle device: ${(error as Error)?.message || error}`));
          }
        }
        await sleep(Math.min(2000, Math.max(0, waitMs - elapsedMs)));
      }
    } catch (error) {
      if (error instanceof DeviceAdmissionRefusal && error.code === 'STIM_AT_CAPACITY') {
        recordCapacityRefusal({ platform: device.platform as 'ios' | 'android', max, workspace }, now());
      }
      throw error;
    } finally {
      releaseClaim(ticket);
      if (visibleWait) waitingFor(null);
      if (started !== undefined) {
        const ms = Math.max(0, Math.round(now() - started));
        recordCapacityWait(
          { platform: device.platform as 'ios' | 'android', ms, max, workspace, ...(reclaimed ? { reclaimed } : {}) },
          now(),
        );
        onWait(ms);
      }
    }
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
