import { setTimeout as delay } from 'node:timers/promises';
import { basename, join } from 'node:path';
import { deviceSlotPlatforms, projectDeviceSlots } from '../devices/device-slots.ts';
import {
  getConcurrencyLimits,
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
import { automaticMachineEnabled } from '@stim-cli/core/state';
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
import { deviceReclaimIdleMinutesSetting } from '../workspace/settings.ts';
import { workspaceDisplayLabel, workspaceLabels } from '../workspace/display-label.ts';
import { reclaimIdleDevice } from '../devices/queue-reclaim.ts';
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

/** The caps that apply to a boot on `platform` given the booted `keys`, the platform's own cap first. */
function deviceLimits(keys: Set<string>, platform: string, max: number, platformMax: number): DeviceLimit[] {
  const limits: DeviceLimit[] = [];
  if (platformMax > 0 && isCappedPlatform(platform))
    limits.push({ ...PLATFORM_CAPS[platform], count: platformCount(keys, platform), max: platformMax, platform });
  if (max > 0) limits.push({ setting: 'concurrency.maxDevices', noun: 'device', count: keys.size, max });
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

/** The first cap with no room left, or the first cap when all have room (for a run waiting behind another). */
function bindingLimit(limits: DeviceLimit[]): DeviceLimit | undefined {
  return limits.find((limit) => limit.count >= limit.max) ?? limits[0];
}

function atCapacityRefusal({ count, max, setting, noun }: DeviceLimit): CapacityRefusal {
  return {
    code: 'STIM_AT_CAPACITY',
    message:
      count < max
        ? `${count}/${max} Stim ${noun}s are in use, but another run is ahead in the device slot queue.`
        : `${count} Stim ${noun}(s) are already booted and ${setting} is ${max}, so booting another would exceed the cap.`,
    remedy: `stop an environment (stim stop) or raise ${setting}`,
  };
}

function uncountedRefusal(error: unknown): CapacityRefusal {
  return {
    code: 'STIM_NO_DEVICE',
    message: `A device cap (concurrency.maxDevices, concurrency.maxIosDevices or concurrency.maxAndroidDevices) is set, and Stim could not count the booted devices: ${(error as Error)?.message || error}`,
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
  max = getConcurrencyLimits().maxDevices,
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
  try {
    const inventory = await readInventoryAsync(sources);
    if ('code' in inventory) return { count: null, max, queued: 0, localLive: false };
    const owned = deviceSlotPlatforms(project, slot)?.[platform]?.owned === true;
    const keys = inventoryKeys(inventory);
    const limits = deviceLimits(keys, platform, max, platformMax);
    const tightest = limits.length ? limits.reduce((a, b) => (b.max - b.count < a.max - a.count ? b : a)) : undefined;
    return {
      count: tightest?.count ?? keys.size,
      max: tightest?.max ?? max,
      queued: liveWaiters().filter(
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
  waitMs?: number;
  signal?: AbortSignal;
  noWait?: boolean;
  displayName?: string;
  reclaimIdleMinutes?: number;
  waitingFor?: (info: BuildWaitingFor | null) => void;
  onWait?: (ms: number) => void;
  /** Called once admission lets the boot start, just before it runs. */
  onBootStart?: () => void;
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
  setting,
}: {
  queue?: string;
  count: number;
  max: number;
  holders: string[];
  elapsedMs: number;
  /** The per-platform cap the wait is on; absent for `concurrency.maxDevices`. */
  setting?: string;
}): string {
  return `${'device'.padEnd(11)} waiting for a device slot (${count}/${max} in use${setting ? ` by ${setting}` : ''}${holders.length ? `: ${holders.join(', ')}` : ''}), ${formatElapsed(elapsedMs)} elapsed -- stim guide lifecycle concurrency${queue ? `; ${queue}` : ''}`;
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

function deviceHolders(inventory: DeviceInventory, keys: Set<string>): string[] {
  return [...new Set(slotHolders(inventory, keys).map((holder) => holder.label))].toSorted();
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

/** Boots an owned device under the Stim home's cap, reserving capacity before releasing admission. */
export async function withDeviceBootAdmission<T>(
  device: BootingDevice,
  boot: () => Promise<T>,
  {
    root,
    max = getConcurrencyLimits().maxDevices,
    platformMax = getPlatformDeviceLimits(),
    sources = {},
    lockWaitMs = ADMISSION_LOCK_WAIT_MS,
    out = () => {},
    waitMs = DEFAULT_DEVICE_SLOT_WAIT_MS,
    noWait = false,
    automatic = false,
    displayName = workspaceDisplayLabel(root, loadConfig()),
    reclaimIdleMinutes = deviceReclaimIdleMinutesSetting({}),
    now = Date.now,
    signal,
    sleep = (ms) => delay(ms, undefined, { signal }),
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
  },
): Promise<T> {
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
  const ownCap = isCappedPlatform(device.platform) ? (platformMax[device.platform] ?? 0) : 0;
  if (!(max > 0) && !(ownCap > 0)) {
    onBootStart();
    return boot();
  }
  const workspace = workspaceId(root);
  device = { ...device, workspace, displayName };
  let ticket: ClaimHandle | undefined;
  let marker: ClaimHandle | undefined;
  let started: number | undefined;
  let lastLine = -Infinity;
  let visibleWait = false;
  let lastInventory: { limit: DeviceLimit; holders: string[] } | undefined;
  let lastTurn = false;
  let binding: DeviceLimit | undefined;
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
            requireMembership();
            const waiters = liveWaiters();
            const first = waiters[0];
            const mine = waiters.findIndex((holder) => holder.claimId === ticket?.claimId);
            const ahead = mine < 0 ? waiters : waiters.slice(0, mine);
            const admit = () => {
              const admitted = takeBootMarker(device);
              if (releaseClaim(ticket)) ticket = undefined;
              return { marker: admitted };
            };
            const wait = ({ limit, holders }: NonNullable<typeof lastInventory>, turn: boolean) => {
              const ticketId = ticket?.claimId;
              const position = ticketId
                ? waiters.findIndex((holder) => holder.claimId === ticketId) + 1
                : waiters.length + 1;
              const headName = first?.details.displayName ?? displayName;
              const queue = `queue position ${position}${position > 1 ? ' behind' : ', head'} ${headName}; queue: ${join(getConfigDir(), 'device-waits')}`;
              if (noWait || waitMs === 0) throw new DeviceAdmissionRefusal(atCapacityRefusal(limit));
              if (started !== undefined && now() - started >= waitMs) {
                throw new DeviceAdmissionRefusal({
                  code: 'STIM_AT_CAPACITY',
                  message: `Waited ${formatElapsed(now() - started)} for a device slot; ${limit.count}/${limit.max} Stim ${limit.noun}s are in use (${limit.setting}); ${queue}.`,
                  remedy: `Stop an environment (stim stop), retry with a longer --wait <seconds>, or raise ${limit.setting}.`,
                });
              }
              if (!ticket) {
                ticket = takeWaitTicket(device, waiters);
                started = now();
              }
              const firstOfPlatform = ahead.every((holder) => holder.details.platform !== device.platform);
              return { limit, holders, queue, reclaim: turn && firstOfPlatform && limit.count >= limit.max };
            };
            if (ticket && lastInventory && ahead.length > 0 && !lastTurn && now() - lastListed < INVENTORY_REFRESH_MS) {
              const booting = sources.booting ?? readBootingDevices;
              const own = deviceKey(device.platform, device.key);
              const claims = typeof booting === 'function' ? booting() : booting;
              if (claims.some((entry) => deviceKey(entry.platform, entry.key) === own)) return admit();
              return wait(lastInventory, false);
            }
            const inventory = await readInventoryAsync(sources);
            if ('code' in inventory) throw new DeviceAdmissionRefusal(inventory);
            const keys = inventoryKeys(inventory);
            const own = deviceKey(device.platform, device.key);
            const ownBooting = inventory.booting.some((entry) => deviceKey(entry.platform, entry.key) === own);
            if ((device.platform === 'ios' && keys.has(own)) || ownBooting) return admit();
            keys.delete(own);
            const limits = deviceLimits(keys, device.platform, max, ownCap);
            const turn = ahead.every((waiter) => platformWalled(keys, waiter, platformMax));
            if (turn && limits.every((limit) => limit.count < limit.max)) return admit();
            lastListed = now();
            lastTurn = turn;
            const limit = bindingLimit(limits);
            if (!limit) return admit();
            binding = limit;
            const held = limit.platform
              ? new Set([...keys].filter((key) => key.startsWith(`${limit.platform}:`)))
              : keys;
            lastInventory = { limit, holders: deviceHolders(inventory, held) };
            return wait(lastInventory, turn);
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
        waitingFor({
          kind: 'device-slot',
          inUse: result.limit.count,
          max: result.limit.max,
          since: new Date(started!).toISOString(),
        });
        if (now() - lastLine >= 10_000) {
          lastLine = now();
          out(
            deviceSlotWaitingLine({
              count: result.limit.count,
              max: result.limit.max,
              holders: result.holders,
              elapsedMs,
              queue: result.queue,
              ...(result.limit.platform ? { setting: result.limit.setting } : {}),
            }),
          );
        }
        signal?.throwIfAborted();
        if (result.reclaim && now() - lastReclaim >= 15_000) {
          lastReclaim = now();
          try {
            if (reclaimIdleMinutes > 0)
              reclaimed += await reclaimIdleDevice(
                root,
                reclaimIdleMinutes * 60_000,
                out,
                now,
                skippedReclaims,
                result.limit.platform,
              );
          } catch (error) {
            out(phaseLine('device', `could not reclaim an idle device: ${(error as Error)?.message || error}`));
          }
        }
        await sleep(Math.min(2000, Math.max(0, waitMs - elapsedMs)));
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
      if (visibleWait) waitingFor(null);
      if (started !== undefined) {
        const ms = Math.max(0, Math.round(now() - started));
        const at = now();
        await withConfigLockAsync(() =>
          recordCapacityWait(
            {
              platform: device.platform as 'ios' | 'android',
              ms,
              max: binding?.max ?? max,
              workspace,
              ...(reclaimed ? { reclaimed } : {}),
            },
            at,
          ),
        ).catch(() => {});
        onWait(ms);
      }
    }
    requireMembership();
    onBootStart();
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
