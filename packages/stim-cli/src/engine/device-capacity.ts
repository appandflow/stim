import { randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';
import { deviceSlotPlatforms, projectDeviceSlots } from '../devices/device-slots.ts';
import {
  admissionLimits,
  getConfigDir,
  getPlatformDeviceLimits,
  loadConfig,
  withConfigLockAsync,
  type Config,
  type ProjectRecord,
} from '../workspace/config.ts';
import {
  iosRuntimeMatches,
  listAllIosSims,
  listAllIosSimsAsync,
  listIosDeviceTypes,
  parseRuntimeVersion,
  type IosRuntime,
} from '../devices/ios.ts';
import { listAdbDevices, listAdbDevicesAsync, type SystemImage } from '../devices/android.ts';
import { workspaceId } from '@stim-cli/core';
import {
  automaticMachineEnabled,
  deviceListingCacheFile,
  isJsonObject,
  readDaemonSnapshot,
  readJsonObject,
} from '@stim-cli/core/state';
import { writeCacheFile } from '../status-measures.ts';
import { formatElapsed, phaseLine } from '../command-output.ts';
import { recordCapacityRefusal, recordCapacityWait } from './stats.ts';
import {
  ClaimRefusedError,
  isClaimRefusal,
  readClaimSet,
  releaseClaim,
  tryAcquireClaim,
  type ClaimHandle,
  type ClaimHolder,
} from '../ownership-claim.ts';
import { withWorkspaceProcessLock, workspaceProcessLockError } from './workspace-process-lock.ts';
import { workspaceDisplayLabel, workspaceLabels } from '../workspace/display-label.ts';
import { daemonWaiter, notifyReleased } from '../daemon/client.ts';
import { liveWaiters, queuePosition, takeWaitTicket, waitCeiling } from './wait-queue.ts';
import { readWebShares, shareKeepReason } from '../local-server.ts';
import type { StimContext } from '@stim-cli/core';
import type {
  BuildWaitingFor,
  HostedLocalPlatformCounts,
  SettingScope,
  StatusCapacity,
  StatusDeviceSlotHolder,
  StatusPlatformDeviceSlots,
} from '@stim-cli/core/state';

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
  root?: string;
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

export interface DeviceCountExclusion {
  platform: string;
  key?: string;
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
  exclude = [],
}: Partial<Omit<DeviceInventory, 'adb'>> & {
  adbEmulators?: EmulatorPort[];
  exclude?: DeviceCountExclusion[];
}): Set<string> {
  const keys = new Set<string>();
  for (const sim of sims) {
    if (!sim?.name?.startsWith('stim-')) continue;
    if (exclude.some((device) => device.platform === 'ios' && device.key === sim.udid)) continue;
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
  for (const device of booting) {
    if (!exclude.some((excluded) => excluded.platform === device.platform && excluded.key === device.key))
      keys.add(deviceKey(device.platform, device.key));
  }
  return keys;
}

function inventoryKeys(inventory: DeviceInventory, exclude: DeviceCountExclusion[] = []): Set<string> {
  return liveOwnedDeviceKeys({ ...inventory, adbEmulators: liveEmulatorPorts(inventory.adb), exclude });
}

type CappedPlatform = 'ios' | 'android';

/** A cap a boot must fit: `count` of `max` are taken. `platform` is set for a per-platform cap. */
export interface DeviceLimit {
  setting: string;
  noun: string;
  count: number;
  max: number;
  platform?: CappedPlatform;
  /** Set when `max` is the cap Stim derived because `setting` is unset. */
  derived?: true;
}

const PLATFORM_CAPS: Record<CappedPlatform, { setting: string; noun: string }> = {
  ios: { setting: 'concurrency.maxIosDevices', noun: 'iOS simulator' },
  android: { setting: 'concurrency.maxAndroidDevices', noun: 'Android emulator' },
};

function isCappedPlatform(platform: string): platform is CappedPlatform {
  return platform === 'ios' || platform === 'android';
}

function platformCount(keys: Set<string>, platform: CappedPlatform): number {
  return [...keys].filter((key) => key.startsWith(`${platform}:`)).length;
}

/**
 * The caps that apply to a boot on `platform` given the booted `keys`, the platform's own cap first. `derived` marks
 * `max` as the cap Stim derived because `concurrency.maxDevices` is unset.
 */
function deviceLimits(
  keys: Set<string>,
  platform: string,
  max: number,
  platformMax: number,
  derived = false,
): DeviceLimit[] {
  const limits: DeviceLimit[] = [];
  if (platformMax > 0 && isCappedPlatform(platform))
    limits.push({ ...PLATFORM_CAPS[platform], count: platformCount(keys, platform), max: platformMax, platform });
  if (max > 0)
    limits.push({
      setting: 'concurrency.maxDevices',
      noun: 'device',
      count: keys.size,
      max,
      ...(derived ? { derived: true } : {}),
    });
  return limits;
}

/** Whether a queued waiter is held back by its own platform cap, so it does not hold up the runs behind it. */
function platformWalled(
  keys: Set<string>,
  waiter: ClaimHolder,
  platformMax: Partial<Record<CappedPlatform, number>>,
): boolean {
  const platform = String(waiter.details.platform);
  if (!isCappedPlatform(platform)) return false;
  const cap = platformMax[platform] ?? 0;
  return cap > 0 && platformCount(keys, platform) >= cap;
}

function atCapacityRefusal({ count, max, setting, noun, derived }: DeviceLimit): CapacityRefusal {
  return {
    code: 'STIM_AT_CAPACITY',
    message:
      count < max
        ? `${count}/${max} Stim ${noun}s are in use, but another run is ahead in the device slot queue.`
        : `${count} Stim ${noun}(s) are already booted and ${derived ? `the derived ${noun} cap` : setting} is ${max}, so booting another would exceed the cap.`,
    remedy: `stop an environment (stim stop) or ${derived ? `set ${setting} to override the derived cap` : `raise ${setting}`}`,
  };
}

function uncountedRefusal(error: unknown): CapacityRefusal {
  return {
    code: 'STIM_NO_DEVICE',
    message: `Stim could not count the booted devices against concurrency.maxDevices (derived from RAM when 0) and the per-platform caps: ${(error as Error)?.message || error}`,
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

async function listedAwait<T>(
  read: () => T | Promise<T>,
  empty: T,
  absent: (error: unknown) => boolean = () => false,
): Promise<T> {
  try {
    return (await read()) ?? empty;
  } catch (error) {
    if (absent(error)) return empty;
    throw new DeviceCountUnavailable('', { cause: error });
  }
}

type AsyncListing<T> = T | (() => T | Promise<T>);

interface AsyncInventorySources {
  sims?: AsyncListing<SimRecord[]>;
  adb?: AsyncListing<AdbDevices>;
  config?: AsyncListing<Config | null>;
  booting?: AsyncListing<BootingDevice[]>;
}

async function readInventoryAsync({
  sims = () => (process.platform === 'darwin' ? listAllIosSimsAsync({ timeoutMs: LISTING_TIMEOUT_MS }) : []),
  adb = () => listAdbDevicesAsync({ timeoutMs: LISTING_TIMEOUT_MS }),
  config = loadConfig,
  booting = readBootingDevices,
}: AsyncInventorySources): Promise<DeviceInventory | CapacityRefusal> {
  try {
    const recorded = await listedAwait(() => (typeof config === 'function' ? config() : config), null);
    return {
      booting: await listedAwait(() => (typeof booting === 'function' ? booting() : booting), []),
      sims: await listedAwait(() => (typeof sims === 'function' ? sims() : sims), [], toolAbsent),
      adb: recordsOwnedEmulator(recorded)
        ? await listedAwait(() => (typeof adb === 'function' ? adb() : adb), NO_ADB, toolAbsent)
        : NO_ADB,
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
 * run is booting under `concurrency.maxDevices`, each counted once unless excluded; when a listing fails, why the count is unknown.
 */
export function countLiveOwnedDevices(
  sources: InventorySources = {},
  { exclude = [] }: { exclude?: DeviceCountExclusion[] } = {},
): number | { unknown: string } {
  const counts = countLiveOwnedDevicesByPlatform(sources, { exclude });
  return 'unknown' in counts ? counts : counts.ios + counts.android;
}

/** The counts of {@link countLiveOwnedDevices} split by platform. */
export function countLiveOwnedDevicesByPlatform(
  sources: InventorySources = {},
  { exclude = [] }: { exclude?: DeviceCountExclusion[] } = {},
): HostedLocalPlatformCounts | { unknown: string } {
  try {
    const inventory = readInventory(sources);
    if ('code' in inventory) return { unknown: inventory.message };
    const keys = inventoryKeys(inventory, exclude);
    return { ios: platformCount(keys, 'ios'), android: platformCount(keys, 'android') };
  } catch (error) {
    if (isClaimRefusal(error)) return { unknown: error.message };
    throw error;
  }
}

async function listedAsync<T>(source: () => Promise<T>, empty: T): Promise<T> {
  try {
    return await source();
  } catch (error) {
    if (toolAbsent(error)) return empty;
    throw new DeviceCountUnavailable('', { cause: error });
  }
}

/** The counts of {@link countLiveOwnedDevicesByPlatform}, read without blocking the event loop. */
export async function countLiveOwnedDevicesByPlatformAsync(
  sources: AsyncInventorySources,
): Promise<HostedLocalPlatformCounts | { unknown: string }> {
  try {
    const inventory = await readInventoryAsync(sources);
    if ('code' in inventory) return { unknown: inventory.message };
    const keys = inventoryKeys(inventory);
    return { ios: platformCount(keys, 'ios'), android: platformCount(keys, 'android') };
  } catch (error) {
    if (isClaimRefusal(error)) return { unknown: error.message };
    throw error;
  }
}

export async function countLiveOwnedDevicesFrom(
  sources: AsyncInventorySources,
  { exclude = [] }: { exclude?: DeviceCountExclusion[] } = {},
): Promise<number | { unknown: string }> {
  try {
    const inventory = await readInventoryAsync(sources);
    return 'code' in inventory ? { unknown: inventory.message } : inventoryKeys(inventory, exclude).size;
  } catch (error) {
    if (isClaimRefusal(error)) return { unknown: error.message };
    throw error;
  }
}

export async function countLiveOwnedDevicesAsync(operation: StimContext): Promise<number | { unknown: string }> {
  try {
    operation.signal.throwIfAborted();
    const config = loadConfig();
    const booting = readBootingDevices();
    const [sims, adb] = await Promise.all([
      process.platform === 'darwin'
        ? listedAsync(() => listAllIosSimsAsync({ timeoutMs: LISTING_TIMEOUT_MS }), [])
        : [],
      recordsOwnedEmulator(config)
        ? listedAsync(() => listAdbDevicesAsync({ timeoutMs: LISTING_TIMEOUT_MS }), NO_ADB)
        : NO_ADB,
    ]);
    operation.signal.throwIfAborted();
    return countLiveOwnedDevices({ config, booting, sims, adb });
  } catch (error) {
    operation.signal.throwIfAborted();
    if (isClaimRefusal(error)) return { unknown: error.message };
    if (error instanceof DeviceCountUnavailable) return { unknown: uncountedRefusal(error.cause).message };
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
  platformMax,
  sims = [],
  adb = null,
  config = null,
  booting = [],
}: Partial<{
  platform: string;
  project: ProjectRecord | null;
  slot: string;
  max: number;
  platformMax: number;
  sims: SimRecord[];
  adb: AdbDevices | null;
  config: Config | null;
  booting: BootingDevice[];
}> = {}): (CapacityRefusal & { max: number }) | null {
  if (!(max && max > 0) && !(platformMax && platformMax > 0)) return null;
  const adbEmulators = liveEmulatorPorts(adb ?? NO_ADB);
  if (workspaceHasLiveDevice({ platform, project, slot, sims, adbEmulators })) return null;
  const keys = liveOwnedDeviceKeys({ sims, adbEmulators, config, booting });
  const full = deviceLimits(keys, platform ?? '', max ?? 0, platformMax ?? 0).find((limit) => limit.count >= limit.max);
  return full ? { ...atCapacityRefusal(full), max: full.max } : null;
}

/**
 * The early `concurrency.maxDevices` check, before Metro starts or a device is created. It is advisory, so an
 * unknown count passes: `withDeviceBootAdmission` makes the binding decision when the boot starts.
 */
export async function checkDeviceCapacity({
  platform,
  project,
  slot = 'default',
  max,
  platformMax = platform && isCappedPlatform(platform) ? getPlatformDeviceLimits()[platform] : 0,
  ...sources
}: Partial<{
  platform: string;
  project: ProjectRecord | null;
  slot: string;
  max: number;
  platformMax: number;
}> &
  AsyncInventorySources = {}): Promise<(CapacityRefusal & { max: number }) | null> {
  if (!(max && max > 0) && !(platformMax && platformMax > 0)) return null;
  let inventory: Awaited<ReturnType<typeof readInventoryAsync>>;
  try {
    inventory = await readInventoryAsync(sources);
  } catch (error) {
    if (isClaimRefusal(error)) return null;
    throw error;
  }
  if ('code' in inventory) return null;
  return deviceCapacityRefusal({ platform, project, slot, max, platformMax, ...inventory });
}

export async function peekDeviceSlots({
  platform,
  project,
  slot = 'default',
  max: maxOption,
  platformMax = getPlatformDeviceLimits()[platform],
  sources = {},
}: {
  platform: 'ios' | 'android';
  project: ProjectRecord | null;
  slot?: string;
  max?: number;
  platformMax?: number;
  sources?: AsyncInventorySources;
}): Promise<{ count: number | null; max: number; queued: number; localLive: boolean; limit?: string }> {
  const admission = maxOption === undefined ? admissionLimits() : null;
  const max = maxOption ?? admission?.maxDevices ?? 0;
  try {
    const inventory = await readInventoryAsync(sources);
    if ('code' in inventory) return { count: null, max, queued: 0, localLive: false };
    const owned = deviceSlotPlatforms(project, slot)?.[platform]?.owned === true;
    const keys = inventoryKeys(inventory);
    const limits = deviceLimits(keys, platform, max, platformMax, admission?.derived.devices);
    const tightest = limits.length ? limits.reduce((a, b) => (b.max - b.count < a.max - a.count ? b : a)) : undefined;
    return {
      count: tightest?.count ?? keys.size,
      max: tightest?.max ?? max,
      queued: liveWaiters('boot').filter(
        (waiter) => !platformWalled(keys, waiter, { ...getPlatformDeviceLimits(), [platform]: platformMax }),
      ).length,
      localLive:
        owned &&
        workspaceHasLiveDevice({
          platform,
          project,
          slot,
          sims: inventory.sims,
          adbEmulators: liveEmulatorPorts(inventory.adb),
        }),
      ...(tightest?.platform ? { limit: tightest.setting } : {}),
    };
  } catch (error) {
    if (!isClaimRefusal(error)) throw error;
    return { count: null, max, queued: 0, localLive: false };
  }
}

export interface DeviceSlotWaitPolicy {
  automatic?: boolean;
  /** An explicit `--wait <seconds>` in milliseconds; absent, the queue's liveness ceiling applies. */
  waitMs?: number;
  signal?: AbortSignal;
  noWait?: boolean;
  displayName?: string;
  waitingFor?: (info: BuildWaitingFor | null) => void;
  onWait?: (ms: number) => void;
  /** Called once admission lets the boot start, just before it runs. */
  onBootStart?: () => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Boots, each an owned device's creation when it needs one and its boot, that may run at once in a Stim home. */
export const BOOTS_IN_FLIGHT = 2;
const LOW_MEMORY_FOR_BOOT_BYTES = 2 * 1024 ** 3;

export function deviceSlotWaitingLine({
  what,
  position,
  waiting,
  elapsedMs,
}: {
  /** The resource the run waits for, with its use, such as `a device slot (8/8 booted: a, b)`. */
  what: string;
  position: number;
  waiting: number;
  elapsedMs: number;
}): string {
  return `${'device'.padEnd(11)} waiting for ${what}: queue position ${position} of ${waiting}, ${formatElapsed(elapsedMs)} elapsed -- stim guide lifecycle concurrency`;
}

const SNAPSHOT_FRESH_MS = 3 * 60_000;

/** Memory as the stim-daemon's last tick measured it, while that tick is fresh; null without a daemon. */
function snapshotMemory(): { level: string | null; availableBytes: number | null } | null {
  const snapshot = readDaemonSnapshot();
  const age = Date.now() - Date.parse(snapshot?.tickAt ?? '');
  return snapshot && age >= 0 && age <= SNAPSHOT_FRESH_MS ? snapshot.measurement.memory : null;
}

/** Why memory holds a boot back: critical macOS memory pressure, or warning with under 2 GB available. */
export function memoryHold(memory: { level: string | null; availableBytes: number | null }): string | null {
  if (memory.level === 'critical') return 'memory (macOS memory pressure is critical)';
  if (memory.level === 'warning' && memory.availableBytes !== null && memory.availableBytes < LOW_MEMORY_FOR_BOOT_BYTES)
    return `memory (macOS memory pressure is warning with ${(memory.availableBytes / 1024 ** 3).toFixed(1)} GB available)`;
  return null;
}

function unrecordedHolder(label: string): { label: string; workspace: null; slot: null } {
  return { label, workspace: null, slot: null };
}

function slotHolders(inventory: DeviceInventory, keys: Set<string>): StatusDeviceSlotHolder[] {
  const owners = new Map<string, { label: string; workspace: string | null; slot: string | null }>();
  const projects = Object.entries(inventory.config?.projects ?? {});
  const labels = workspaceLabels(projects.map(([root, project]) => ({ root, label: project.label })));
  for (const [root, project] of projects) {
    const label = labels.get(root) ?? basename(root);
    for (const { slot, platforms } of projectDeviceSlots(project)) {
      if (platforms.ios?.deviceUdid)
        owners.set(deviceKey('ios', platforms.ios.deviceUdid), { label, workspace: root, slot });
      if (platforms.android?.avdName)
        owners.set(deviceKey('android', platforms.android.avdName), { label, workspace: root, slot });
    }
  }
  for (const sim of inventory.sims) {
    const key = deviceKey('ios', sim.udid);
    if (!owners.has(key)) owners.set(key, unrecordedHolder(sim.name));
  }
  const booting = new Set<string>();
  for (const device of inventory.booting) {
    const key = deviceKey(device.platform, device.key);
    booting.add(key);
    if (!owners.has(key)) owners.set(key, unrecordedHolder(device.displayName ?? device.key));
  }
  return [...keys]
    .map((key): StatusDeviceSlotHolder => {
      const { label, workspace, slot } = owners.get(key) ?? unrecordedHolder(key.slice(key.indexOf(':') + 1));
      const platform = key.startsWith('android:') ? 'android' : 'ios';
      return booting.has(key)
        ? { platform, label, workspace, slot, booting: true }
        : { platform, label, workspace, slot };
    })
    .toSorted((a, b) => a.label.localeCompare(b.label) || a.platform.localeCompare(b.platform));
}

function holderLabels(holders: readonly StatusDeviceSlotHolder[]): string[] {
  return [...new Set(holders.map((holder) => holder.label))].toSorted();
}

/**
 * Each holder whose workspace a live web share keeps booted, named with the share, or every holder when the shares
 * cannot be listed: the daemon reclaims none of them.
 */
async function sharedHolders(holders: readonly StatusDeviceSlotHolder[], now: number): Promise<string[]> {
  const roots = new Map(holders.flatMap((holder) => (holder.workspace ? [[holder.workspace, holder.label]] : [])));
  if (!roots.size) return [];
  const shares = await readWebShares();
  if (shares === null) return [];
  if (!Array.isArray(shares)) {
    const labels = [...new Set(roots.values())];
    return [
      `${labels.join(', ')} ${labels.length === 1 ? 'stays' : 'stay'} booted: this home's web shares cannot be listed (${shares.unreadable})`,
    ];
  }
  return [...roots].flatMap(([root, label]) => {
    const reason = shareKeepReason(shares, root, now);
    return reason ? [`${label} stays booted: ${reason}`] : [];
  });
}

/**
 * `concurrency.maxDevices` usage for status (the owned devices the cap counts and who holds each) and the usage of each
 * per-platform cap that is set, from one inventory read. `sims` is the listing status already read; an unknown count
 * reports why instead of failing.
 */
export async function deviceSlotUsages(
  max: number,
  platformMax: Partial<Record<CappedPlatform, number>>,
  sources: AsyncInventorySources = {},
): Promise<Pick<StatusCapacity, 'devices' | 'platformDevices'>> {
  const capped: [CappedPlatform, number][] = [];
  for (const platform of ['ios', 'android'] as const) {
    const cap = platformMax[platform] ?? 0;
    if (cap > 0) capped.push([platform, cap]);
  }
  const platformDevices = (count: (platform: CappedPlatform) => Partial<StatusPlatformDeviceSlots>) =>
    capped.length
      ? {
          platformDevices: Object.fromEntries(
            capped.map(([platform, cap]) => [platform, { max: cap, ...count(platform) }]),
          ),
        }
      : {};
  try {
    const inventory = await readInventoryAsync(sources);
    if ('code' in inventory)
      return {
        ...(max > 0 ? { devices: { max, inUse: null, unknown: inventory.message, holders: [] } } : {}),
        ...platformDevices(() => ({ inUse: null, unknown: inventory.message })),
      };
    const keys = inventoryKeys(inventory);
    return {
      ...(max > 0 ? { devices: { max, inUse: keys.size, holders: slotHolders(inventory, keys) } } : {}),
      ...platformDevices((platform) => ({ inUse: platformCount(keys, platform) })),
    };
  } catch (error) {
    if (!isClaimRefusal(error)) throw error;
    return {
      ...(max > 0 ? { devices: { max, inUse: null, unknown: error.message, holders: [] } } : {}),
      ...platformDevices(() => ({ inUse: null, unknown: error.message })),
    };
  }
}

interface SharedListing {
  listedAt: number;
  sims: SimRecord[];
  adb: AdbDevices | null;
}

const SHARED_LISTING_SCHEMA = 1;

function isSimRecord(value: unknown): value is SimRecord {
  if (!isJsonObject(value)) return false;
  return (
    ['udid', 'name', 'state', 'runtime', 'deviceTypeIdentifier'].every((field) => typeof value[field] === 'string') &&
    typeof value.available === 'boolean' &&
    (value.dataPathSize === undefined || typeof value.dataPathSize === 'number')
  );
}

function readSharedListing(at: number, { complete = false }: { complete?: boolean } = {}): SharedListing | null {
  const record = readJsonObject(deviceListingCacheFile());
  const listedAt = record?.listedAt;
  const sims = record?.sims;
  if (typeof listedAt !== 'number' || !Array.isArray(sims) || at < listedAt || at - listedAt > INVENTORY_REFRESH_MS)
    return null;
  if (complete && (record?.schema !== SHARED_LISTING_SCHEMA || !sims.every(isSimRecord))) return null;
  const adb = isJsonObject(record?.adb) ? record.adb : null;
  if (adb && Array.isArray(adb.emulators) && Array.isArray(adb.physical) && Array.isArray(adb.unhealthy))
    return { listedAt, sims, adb: { emulators: adb.emulators, physical: adb.physical, unhealthy: adb.unhealthy } };
  return { listedAt, sims, adb: null };
}

/**
 * The simulator records (and the emulator listing, when the writer took one) of the last device listing a boot
 * admission took, while it is at most `INVENTORY_REFRESH_MS` old. Null when the file is missing, stale, corrupt or
 * written without simulator records, and when it lacks a simulator `config` records, which a boot admission creates
 * after listing. The emulator listing is dropped when it lacks a recorded owned emulator.
 */
export function readFreshDeviceListing(
  config: Config | null,
  at: number = Date.now(),
): Pick<SharedListing, 'sims' | 'adb'> | null {
  const listing = readSharedListing(at, { complete: true });
  if (!listing) return null;
  const listedUdids = new Set(listing.sims.map((sim) => sim.udid));
  const slots = Object.values(config?.projects || {}).flatMap((project) => projectDeviceSlots(project));
  if (slots.some(({ platforms }) => platforms.ios?.deviceUdid && !listedUdids.has(platforms.ios.deviceUdid)))
    return null;
  const ports = new Set(listing.adb ? liveEmulatorPorts(listing.adb).map((entry) => entry.consolePort) : []);
  const emulatorsListed = slots.every(
    ({ platforms }) =>
      !platforms.android?.owned ||
      typeof platforms.android.consolePort !== 'number' ||
      ports.has(platforms.android.consolePort),
  );
  return { sims: listing.sims, adb: emulatorsListed ? listing.adb : null };
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
    message: `Another process holds ${bootingDevicesRoot()} exclusively, so this boot cannot be counted toward the device caps.`,
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
      message: `Waited ${formatElapsed(lockWaitMs)} for other runs to finish counting booted devices for the device caps.`,
      remedy: 'Listing devices is slow, which usually means the machine is overloaded. Retry once the load falls.',
    });
  }
}

/** The boot admission let start. */
export interface AdmittedBoot {
  /** Counts the boot under `key` from now on: the device it created under a key from {@link uncreatedDeviceKey}. */
  rekey(key: string): void;
}

/** The key a boot counts under until it creates its device, unique so no other run takes it for its own device. */
export function uncreatedDeviceKey(): string {
  return `new-${randomUUID()}`;
}

/**
 * Boots an owned device once admission lets it: in arrival order per the `device-waits` queue, while the booted devices
 * can be counted and stay under `concurrency.maxDevices` (derived from RAM when 0) and the per-platform caps, at most
 * two boots run at once, and memory pressure is not critical (nor warning with under 2 GB available). A boot that
 * needs a new device creates it inside `boot`. The boot holds a marker that counts it until it finishes or throws. A
 * waiting run prints a progress line every 10 seconds, and refuses with `STIM_AT_CAPACITY` after `waitMs`; without
 * it, once the devices have stayed uncountable for the position-based ceiling, or after 90 minutes in all. The
 * stim-daemon wakes it when a boot finishes and reclaims an idle device of another workspace for it.
 */
export async function withDeviceBootAdmission<T>(
  device: BootingDevice,
  boot: (admitted: AdmittedBoot) => Promise<T>,
  {
    root,
    max: maxOption,
    platformMax: platformMaxOption,
    sources = {},
    lockWaitMs = ADMISSION_LOCK_WAIT_MS,
    out = () => {},
    waitMs,
    noWait = false,
    automatic = false,
    displayName = workspaceDisplayLabel(root, loadConfig()),
    memory = snapshotMemory,
    now = Date.now,
    signal,
    sleep,
    waitingFor = () => {},
    onWait = () => {},
    onBootStart = () => {},
  }: DeviceSlotWaitPolicy & {
    root: string;
    max?: number;
    platformMax?: Partial<Record<CappedPlatform, number>>;
    sources?: InventorySources;
    lockWaitMs?: number;
    out?: (line: string) => void;
    memory?: () => { level: string | null; availableBytes: number | null } | null;
  },
): Promise<T> {
  let admission: ReturnType<typeof admissionLimits> | null = null;
  let max = maxOption ?? 0;
  let platformMax: Partial<Record<CappedPlatform, number>> = platformMaxOption ?? {};
  let ownCap = 0;
  const readLimits = () => {
    admission = maxOption === undefined ? admissionLimits() : null;
    max = maxOption ?? admission?.maxDevices ?? 0;
    platformMax = platformMaxOption ?? getPlatformDeviceLimits();
    ownCap = isCappedPlatform(device.platform) ? (platformMax[device.platform] ?? 0) : 0;
  };
  const requireMembership = () => {
    if (automatic && !automaticMachineEnabled('device', 'local'))
      throw new DeviceAdmissionRefusal({
        code: 'STIM_HOSTING_REFUSED',
        message: "local is disabled in this requester's automatic device pool.",
        remedy: 'Enable local in remote.devicePoolDisabled or select a machine explicitly.',
      });
  };
  signal?.throwIfAborted();
  requireMembership();
  const workspace = workspaceId(root);
  device = { ...device, workspace, displayName, root };
  const wake = daemonWaiter('boot');
  const pause =
    sleep ??
    (async (ms: number) => {
      try {
        await wake.wait(ms, signal);
      } catch (error) {
        signal?.throwIfAborted();
        throw error;
      }
    });
  const ceiling = waitCeiling(now);
  let ticket: ClaimHandle | undefined;
  let marker: ClaimHandle | undefined;
  let started: number | undefined;
  let lastLine = -Infinity;
  let visibleWait = false;
  let lastInventory: { limit: DeviceLimit; holders: StatusDeviceSlotHolder[] } | undefined;
  let binding: DeviceLimit | undefined;
  const own = deviceKey(device.platform, device.key);
  const round = () => {
    signal?.throwIfAborted();
    requireMembership();
    readLimits();
    const waiters = liveWaiters('boot');
    const mine = waiters.findIndex((holder) => holder.claimId === ticket?.claimId);
    const ahead = mine < 0 ? waiters : waiters.slice(0, mine);
    const position = queuePosition(waiters, ticket);
    const admit = () => {
      const admitted = takeBootMarker(device);
      if (releaseClaim(ticket)) ticket = undefined;
      return { marker: admitted };
    };
    const wait = (
      what: string,
      resource: string,
      use: { inUse: number; max: number },
      limit: DeviceLimit | undefined,
      holders: string[],
      unverified: string | null = null,
      held: readonly StatusDeviceSlotHolder[] = [],
    ) => {
      const shown = holders.length ? `${what} held by ${holders.join(', ')}` : what;
      const queue = `queue position ${position} of ${Math.max(waiters.length, position)}`;
      const refusal = (message: string, remedy: string) =>
        new DeviceAdmissionRefusal({ code: 'STIM_AT_CAPACITY', message, remedy });
      const state = `${shown}; ${queue}${waiters.length ? ` (${waiters.map((holder, index) => `${index + 1}. ${String(holder.details.displayName ?? holder.details.key)}`).join(', ')})` : ''}`;
      const remedy = `Stop an environment (stim stop), retry with a longer --wait <seconds>, or ${limit?.derived ? 'set' : 'raise'} ${limit?.setting ?? 'concurrency.maxDevices'}.`;
      if (noWait || waitMs === 0)
        throw limit && limit.count >= limit.max
          ? new DeviceAdmissionRefusal(atCapacityRefusal(limit))
          : refusal(`This run would wait for ${state}.`, remedy);
      if (!ticket) {
        ticket = takeWaitTicket('boot', { ...device }, waiters);
        started = now();
        ceiling.update(waiters.length + 1, unverified);
      } else ceiling.update(position, unverified);
      const elapsed = now() - started!;
      const overdue =
        waitMs === undefined
          ? ceiling.overdue()
          : elapsed >= waitMs
            ? ({ kind: 'absolute', waitedMs: elapsed } as const)
            : null;
      if (overdue)
        throw refusal(
          `Waited ${formatElapsed(elapsed)} for ${state}${overdue.kind === 'unverified' ? `; ${overdue.reason} for ${formatElapsed(overdue.waitedMs)}` : waitMs === undefined ? ', the 90-minute ceiling' : ''}.`,
          remedy,
        );
      return {
        what: shown,
        resource,
        use,
        limit,
        position,
        waiting: Math.max(waiters.length, position),
        held,
      };
    };
    const decide = (read: DeviceInventory | CapacityRefusal) => {
      if ('code' in read)
        return wait(
          `a device count (${read.message})`,
          'device count',
          { inUse: lastInventory?.limit.count ?? 0, max: lastInventory?.limit.max ?? max },
          undefined,
          [],
          read.message,
        );
      const inventory = read;
      const keys = inventoryKeys(inventory);
      const ownBooting = inventory.booting.some((entry) => deviceKey(entry.platform, entry.key) === own);
      if ((device.platform === 'ios' && keys.has(own)) || ownBooting) return null;
      keys.delete(own);
      const limits = deviceLimits(keys, device.platform, max, ownCap, admission?.derived.devices);
      const turn = ahead.every((waiter) => platformWalled(keys, waiter, platformMax));
      const full = limits.find((limit) => limit.count >= limit.max);
      const limit = full ?? limits[0];
      binding = limit;
      if (limit) {
        const held = limit.platform ? new Set([...keys].filter((key) => key.startsWith(`${limit.platform}:`))) : keys;
        lastInventory = { limit, holders: slotHolders(inventory, held) };
      }
      if (full)
        return wait(
          `a device slot (${limitUse(full)})`,
          'booted devices',
          { inUse: full.count, max: full.max },
          full,
          holderLabels(lastInventory?.holders ?? []),
          null,
          lastInventory?.holders ?? [],
        );
      const booting = inventory.booting.filter((entry) => deviceKey(entry.platform, entry.key) !== own);
      if (booting.length >= BOOTS_IN_FLIGHT)
        return wait(
          `a boot slot (${booting.length}/${BOOTS_IN_FLIGHT} boots in flight)`,
          'boots in flight',
          { inUse: booting.length, max: BOOTS_IN_FLIGHT },
          undefined,
          booting.map((entry) => entry.displayName ?? entry.key),
        );
      const deviceUse = { inUse: limit?.count ?? keys.size, max: limit?.max ?? max };
      if (!turn) return wait(`its turn in the device queue (${limitUse(limit)})`, 'its turn', deviceUse, limit, []);
      const measured = memory();
      const held = measured ? memoryHold(measured) : null;
      if (held) return wait(held, 'memory', deviceUse, undefined, []);
      return null;
    };
    const shared = async () => {
      if (ahead.length === 0) return null;
      const listing = readSharedListing(now());
      if (!listing) return null;
      const read = await readInventoryAsync({ ...sources, sims: listing.sims, adb: listing.adb ?? NO_ADB });
      return listing.adb === null && !('code' in read) && recordsOwnedEmulator(read.config) ? null : read;
    };
    return { admit, decide, shared };
  };
  const reuse = async () => {
    if (!ticket) return null;
    const { decide, shared } = round();
    const read = await shared();
    return read && decide(read);
  };
  const count = async () => {
    const { admit, decide, shared } = round();
    const reused = await shared();
    const waiting = reused && decide(reused);
    if (waiting) return waiting;
    const read = await readInventoryAsync(sources);
    if (!('code' in read)) {
      const listing: SharedListing = {
        listedAt: now(),
        sims: read.sims,
        adb: recordsOwnedEmulator(read.config) ? read.adb : null,
      };
      writeCacheFile(deviceListingCacheFile(), { schema: SHARED_LISTING_SCHEMA, ...listing });
    }
    return decide(read) ?? admit();
  };
  try {
    try {
      for (;;) {
        const result = (await reuse()) ?? (await admissionTransaction(count, lockWaitMs, out, signal));
        if ('marker' in result) {
          marker = result.marker;
          signal?.throwIfAborted();
          break;
        }
        signal?.throwIfAborted();
        visibleWait = true;
        waitingFor({
          kind: 'device-slot',
          ...result.use,
          since: new Date(started!).toISOString(),
          position: result.position,
          resource: result.resource,
        });
        if (now() - lastLine >= 10_000) {
          lastLine = now();
          const shared = await sharedHolders(result.held, now());
          out(
            deviceSlotWaitingLine({
              what: [result.what, ...shared].join('; '),
              position: result.position,
              waiting: result.waiting,
              elapsedMs: now() - started!,
            }),
          );
        }
        signal?.throwIfAborted();
        await pause(2000);
      }
    } catch (error) {
      if (error instanceof DeviceAdmissionRefusal && error.code === 'STIM_AT_CAPACITY') {
        const at = now();
        await withConfigLockAsync(() =>
          recordCapacityRefusal(
            { platform: device.platform as 'ios' | 'android', max: binding?.max ?? max, workspace },
            at,
          ),
        ).catch(() => {});
      }
      throw error;
    } finally {
      releaseClaim(ticket);
      wake.close();
      if (visibleWait) waitingFor(null);
      if (started !== undefined) {
        const ms = Math.max(0, Math.round(now() - started));
        const at = now();
        await withConfigLockAsync(() =>
          recordCapacityWait(
            { platform: device.platform as 'ios' | 'android', ms, max: binding?.max ?? max, workspace },
            at,
          ),
        ).catch(() => {});
        onWait(ms);
      }
    }
    requireMembership();
    onBootStart();
    return await boot({
      rekey(key) {
        const next = takeBootMarker({ ...device, key });
        releaseClaim(marker);
        marker = next;
      },
    });
  } finally {
    if (releaseClaim(marker)) notifyReleased('boot');
  }
}

function limitUse(limit: DeviceLimit | undefined): string {
  if (!limit) return 'no device cap';
  const cap = limit.derived
    ? `the derived ${limit.noun} cap of ${limit.max}; set ${limit.setting} to override`
    : limit.setting;
  return `${limit.count}/${limit.max} ${limit.noun}s booted, ${cap}`;
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
    remedy: /^(?:iOS )?\d+\.\d+(?:\.\d+)?$/.test(requested)
      ? `Retry with --runtime "${requested}" --install-runtime on the local or named Mac, or run \`xcodebuild -downloadPlatform iOS -buildVersion ${requested.replace(/^iOS /, '')} -architectureVariant ${process.arch === 'arm64' ? 'arm64' : 'universal'}\` on the simulator Mac. Xcode Settings > Components lists available versions.`
      : 'Pass --runtime (or set ios.runtime) an installed version or full name printed above. To install another exact version, pass --runtime <major.minor[.patch]> --install-runtime on the local or named Mac.',
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
    remedy: 'Pass `--system-image` (or set android.systemImage) to one of the package ids printed above.',
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
