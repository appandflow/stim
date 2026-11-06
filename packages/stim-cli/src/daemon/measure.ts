import { cpus, freemem, loadavg, totalmem } from 'node:os';
import { configDir } from '@stim-cli/core';
import { INTERACTIONS_KEY, buildWorkerRoot, readInteractions, type DaemonMeasurement } from '@stim-cli/core/state';
import { readVolumeSpaceAsync } from '../stimd/passes/budget.ts';
import { collectOwnedDeviceActivityAsync, type OwnedDeviceActivity } from '../commands/gc/idle.ts';
import { deviceSlotKey, projectDeviceSlots } from '../devices/device-slots.ts';
import { listAllIosSimsAsync, type IosSimRecord } from '../devices/ios.ts';
import { getExecutor } from '../exec.ts';
import { readHostMemoryPressureAsync } from '../host-memory.ts';
import type { Config } from '../workspace/config.ts';
import { updateWorkspaceStateAsync } from '../workspace/workspace-state.ts';
import { readParked } from '../devices/sim-pool.ts';
import { ownedHere } from './idle.ts';
import { probeFocusedDeviceUse, type FocusedDeviceUse } from './probe.ts';

const SIM_LIST_TIMEOUT_MS = 10_000;

export interface TickMeasurement {
  measurement: DaemonMeasurement;
  /** The tick's one `simctl list`; null when it failed, so no owned simulator can be proven shut down. */
  sims: IosSimRecord[] | null;
  simsError: string | null;
  /** This home's booted owned simulators and running owned emulators, with their activity. */
  devices: OwnedDeviceActivity[];
}

/** Available memory from `vm_stat`: free, inactive and speculative pages. */
export function parseVmStatAvailable(output: string): number | null {
  const pageSize = Number(/page size of (\d+) bytes/.exec(output)?.[1]);
  if (!Number.isFinite(pageSize)) return null;
  let pages = 0;
  for (const name of ['free', 'inactive', 'speculative']) {
    const count = Number(new RegExp(`Pages ${name}:\\s+(\\d+)`).exec(output)?.[1]);
    if (!Number.isFinite(count)) return null;
    pages += count;
  }
  return pages * pageSize;
}

async function availableMemory(): Promise<number | null> {
  if (process.platform !== 'darwin') return freemem();
  try {
    return parseVmStatAvailable(await getExecutor().runFileAsync('vm_stat', [], { timeoutMs: 5000 }));
  } catch {
    return null;
  }
}

/** Free disk on the config dir's volume, every registered project's volume and the build worker root's. */
export function measureDisk(config: Config | null): Promise<DaemonMeasurement['disk']> {
  return readVolumeSpaceAsync([configDir(), ...Object.keys(config?.projects ?? {}), buildWorkerRoot(config)]);
}

/** macOS memory pressure and available memory, or free memory elsewhere. */
export async function measureMemory(): Promise<DaemonMeasurement['memory']> {
  const [level, availableBytes] = await Promise.all([readHostMemoryPressureAsync(), availableMemory()]);
  return { level, availableBytes, totalBytes: totalmem() };
}

/** Whether `measureTick` lists simulators: on macOS, when a registered workspace owns one. */
export function tickListsSims(config: Config | null): boolean {
  return (
    process.platform === 'darwin' &&
    (ownsDevice(config, 'ios') || readParked('ios', { config }).some((record) => record.bootedUntil !== undefined))
  );
}

function ownsDevice(config: Config | null, platform: 'ios' | 'android'): boolean {
  return Object.values(config?.projects ?? {}).some((project) =>
    projectDeviceSlots(project).some(({ platforms }) => platforms[platform]?.owned === true),
  );
}

/**
 * The device slots a person is using in the focused window: the focused simulator or emulator when it can be read,
 * else every booted simulator this home owns.
 */
export function focusedSlots(
  use: FocusedDeviceUse,
  config: Config | null,
  devices: readonly OwnedDeviceActivity[],
): { root: string; key: string; id: string }[] {
  if (use.platform === 'ios' && use.udid === null)
    return devices
      .filter((device) => device.kind === 'ios' && ownedHere(device))
      .map((device) => ({ root: device.project, key: deviceSlotKey('ios', device.slot), id: device.id }));
  return Object.entries(config?.projects ?? {}).flatMap(([root, project]) =>
    projectDeviceSlots(project).flatMap(({ slot, platforms }) => {
      const id =
        use.platform === 'ios'
          ? platforms.ios?.owned && platforms.ios.deviceUdid === use.udid && use.udid
          : platforms.android?.owned && platforms.android.avdName === use.avdName && use.avdName;
      return id ? [{ root, key: deviceSlotKey(use.platform, slot), id }] : [];
    }),
  );
}

/** Records a person's use of focused devices under their slots, for the activity pass that follows. */
async function recordFocusedUse(slots: ReturnType<typeof focusedSlots>, at: string): Promise<void> {
  for (const { root, key } of slots)
    await updateWorkspaceStateAsync(root, (state) => ({
      ...state,
      [INTERACTIONS_KEY]: { ...readInteractions(state), [key]: at },
    }));
}

/**
 * One tick's measurement: free disk on the volumes Stim writes to, memory, load, one `simctl list` when a workspace
 * owns a simulator, the owned devices' activity (with one `adb devices` when a workspace owns an emulator), and,
 * unless `probe` is false, the focused Simulator or emulator window a person is using.
 */
export async function measureTick(
  config: Config | null,
  now: number,
  { probe = true }: { probe?: boolean } = {},
): Promise<TickMeasurement> {
  const [disk, memory] = await Promise.all([measureDisk(config), measureMemory()]);
  let sims: IosSimRecord[] | null = [];
  let simsError: string | null = null;
  if (tickListsSims(config)) {
    try {
      sims = await listAllIosSimsAsync({ timeoutMs: SIM_LIST_TIMEOUT_MS });
    } catch (error) {
      sims = null;
      simsError = error instanceof Error ? error.message : String(error);
    }
  }
  const devices = await collectOwnedDeviceActivityAsync(config, sims ?? [], now);
  const use = probe ? await probeFocusedDeviceUse() : null;
  const used = use ? focusedSlots(use, config, devices) : [];
  const usedAt = use ? new Date(now - use.idleMs).toISOString() : '';
  await recordFocusedUse(used, usedAt);
  return {
    sims,
    simsError,
    devices,
    measurement: {
      disk,
      memory,
      load1: loadavg()[0] ?? 0,
      cores: cpus().length,
      bootedSimulators: sims === null ? null : sims.filter((sim) => sim.state === 'Booted').length,
      runningEmulators: ownsDevice(config, 'android')
        ? devices.filter((device) => device.kind === 'android').length
        : null,
      interaction: use && used.length ? { platform: use.platform, ids: used.map(({ id }) => id), at: usedAt } : null,
    },
  };
}
