import { cpus, freemem, loadavg, totalmem } from 'node:os';
import { configDir } from '@stim-cli/core';
import { INTERACTIONS_KEY, buildWorkerRoot, readInteractions, type DaemonMeasurement } from '@stim-cli/core/state';
import { readVolumeSpaceAsync } from '../budget.ts';
import { collectOwnedDeviceActivityAsync, type OwnedDeviceActivity } from '../commands/gc/idle.ts';
import { deviceSlotKey, projectDeviceSlots } from '../devices/device-slots.ts';
import { listAllIosSimsAsync, type IosSimRecord } from '../devices/ios.ts';
import { getExecutor } from '../exec.ts';
import { readHostMemoryPressureAsync } from '../host-memory.ts';
import type { Config } from '../workspace/config.ts';
import { updateWorkspaceStateAsync } from '../workspace/workspace-state.ts';
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

function ownsDevice(config: Config | null, platform: 'ios' | 'android'): boolean {
  return Object.values(config?.projects ?? {}).some((project) =>
    projectDeviceSlots(project).some(({ platforms }) => platforms[platform]?.owned === true),
  );
}

/** Records a person's use of a workspace's focused device under its slot, for the activity pass that follows. */
async function recordFocusedUse(config: Config | null, use: FocusedDeviceUse, now: number): Promise<string | null> {
  for (const [root, project] of Object.entries(config?.projects ?? {})) {
    for (const { slot, platforms } of projectDeviceSlots(project)) {
      const matches =
        use.platform === 'ios'
          ? platforms.ios?.owned && platforms.ios.deviceUdid === use.udid
          : platforms.android?.owned && platforms.android.avdName === use.avdName;
      if (!matches) continue;
      const at = new Date(now - use.idleMs).toISOString();
      const key = deviceSlotKey(use.platform, slot);
      await updateWorkspaceStateAsync(root, (state) => ({
        ...state,
        [INTERACTIONS_KEY]: { ...readInteractions(state), [key]: at },
      }));
      return at;
    }
  }
  return null;
}

/**
 * One tick's measurement: free disk on the volumes Stim writes to, memory, load, one `simctl list` when a workspace
 * owns a simulator, the owned devices' activity (with one `adb devices` when a workspace owns an emulator), and the
 * focused Simulator or emulator window a person is using.
 */
export async function measureTick(config: Config | null, now: number): Promise<TickMeasurement> {
  const disk = await readVolumeSpaceAsync([
    configDir(),
    ...Object.keys(config?.projects ?? {}),
    buildWorkerRoot(config),
  ]);
  const [level, availableBytes] = await Promise.all([readHostMemoryPressureAsync(), availableMemory()]);
  let sims: IosSimRecord[] | null = [];
  let simsError: string | null = null;
  if (process.platform === 'darwin' && ownsDevice(config, 'ios')) {
    try {
      sims = await listAllIosSimsAsync({ timeoutMs: SIM_LIST_TIMEOUT_MS });
    } catch (error) {
      sims = null;
      simsError = error instanceof Error ? error.message : String(error);
    }
  }
  const devices = await collectOwnedDeviceActivityAsync(config, sims ?? [], now);
  const use = await probeFocusedDeviceUse();
  const usedAt = use ? await recordFocusedUse(config, use, now) : null;
  return {
    sims,
    simsError,
    devices,
    measurement: {
      disk,
      memory: { level, availableBytes, totalBytes: totalmem() },
      load1: loadavg()[0] ?? 0,
      cores: cpus().length,
      bootedSimulators: sims === null ? null : sims.filter((sim) => sim.state === 'Booted').length,
      runningEmulators: ownsDevice(config, 'android')
        ? devices.filter((device) => device.kind === 'android').length
        : null,
      interaction:
        use && usedAt
          ? { platform: use.platform, id: use.platform === 'ios' ? use.udid : use.avdName, at: usedAt }
          : null,
    },
  };
}
