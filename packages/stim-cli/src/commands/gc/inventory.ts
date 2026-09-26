import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from '@stim-cli/core/state';
import { getExecutor } from '../../exec.ts';
import { isStimOwnedAvd, isStimOwnedSim } from '../../devices/device-ownership.ts';
import { projectDeviceSlots } from '../../devices/device-slots.ts';
import { listAllIosSims, type IosSimRecord } from '../../devices/ios.ts';
import {
  androidHome,
  androidToolPath,
  avdIniPaths,
  avdStorageRoots,
  listInstalledSystemImages,
  parseAvdDeviceProfile,
  parseAvdSystemImage,
} from '../../devices/android.ts';
import { readParked } from '../../devices/sim-pool.ts';
import { DEVICE_LIST_TIMEOUT_MS } from './devices.ts';
import { describeError } from './eas-sessions.ts';

/**
 * Who a simulator or AVD belongs to: a workspace of this Stim home, this home's parked pool, this home
 * with no workspace left, a `stim-*` device this home has no record of creating, or the user.
 */
type InventoryOwner = 'workspace' | 'parked' | 'orphaned' | 'otherStimHome' | 'user';

interface InventoryDevice {
  kind: 'ios' | 'android';
  id: string;
  name: string;
  model: string | null;
  runtime: string | null;
  state: string | null;
  lastUsedAt: string | null;
  bytes: number | null;
  directory: string | null;
  owner: InventoryOwner;
  project: string | null;
  slot: string | null;
}

interface InventoryRuntime {
  identifier: string;
  runtimeIdentifier: string | null;
  version: string | null;
  build: string | null;
  bytes: number | null;
  lastUsedAt: string | null;
  deviceCount: number;
  command: string | null;
}

interface InventorySystemImage {
  package: string;
  directory: string;
  avdCount: number;
  command: string;
}

export interface GcInventory {
  devices: InventoryDevice[];
  runtimes: InventoryRuntime[];
  systemImages: InventorySystemImage[];
  notices: string[];
}

interface AvdRecord {
  name: string;
  directory: string | null;
  systemImage: string | null;
  deviceProfile: string | null;
  lastUsedAt: string | null;
}

interface SimRuntimeRecord {
  identifier: string;
  runtimeIdentifier: string | null;
  version: string | null;
  build: string | null;
  sizeBytes: number | null;
  deletable: boolean;
  lastUsedAt: string | null;
}

const IOS_SIMULATOR_PLATFORM = 'com.apple.platform.iphonesimulator';

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function parseSimRuntimeList(jsonOutput: string): SimRuntimeRecord[] {
  const parsed: unknown = JSON.parse(jsonOutput);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Expected simctl runtime list to return a JSON object.');
  }
  const runtimes: SimRuntimeRecord[] = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue;
    const entry = value as Record<string, unknown>;
    if (entry.platformIdentifier !== IOS_SIMULATOR_PLATFORM) continue;
    runtimes.push({
      identifier: text(entry.identifier) ?? key,
      runtimeIdentifier: text(entry.runtimeIdentifier),
      version: text(entry.version),
      build: text(entry.build),
      sizeBytes: typeof entry.sizeBytes === 'number' && Number.isFinite(entry.sizeBytes) ? entry.sizeBytes : null,
      deletable: entry.deletable === true,
      lastUsedAt: text(entry.lastUsedAt),
    });
  }
  return runtimes;
}

function unlistedRuntimes(jsonOutput: string, images: readonly SimRuntimeRecord[]): SimRuntimeRecord[] {
  const known = new Set(images.map((image) => image.runtimeIdentifier));
  const parsed = JSON.parse(jsonOutput) as { runtimes?: unknown };
  if (!Array.isArray(parsed.runtimes)) throw new Error('Expected simctl list runtimes to return a runtimes array.');
  return parsed.runtimes.flatMap((value: unknown) => {
    if (value === null || typeof value !== 'object') return [];
    const entry = value as Record<string, unknown>;
    const identifier = text(entry.identifier);
    if (!identifier || !/\.iOS-/.test(identifier) || known.has(identifier)) return [];
    return [
      {
        identifier,
        runtimeIdentifier: identifier,
        version: text(entry.version),
        build: text(entry.buildversion),
        sizeBytes: null,
        deletable: false,
        lastUsedAt: null,
      },
    ];
  });
}

function modelName(deviceTypeIdentifier: string): string {
  return deviceTypeIdentifier.replace(/^com\.apple\.CoreSimulator\.SimDeviceType\./, '').replaceAll('-', ' ');
}

function sdkmanagerCommand(pkg: string): string {
  const tool = androidToolPath('sdkmanager');
  return `${tool === 'sdkmanager' ? tool : JSON.stringify(tool)} --uninstall ${JSON.stringify(pkg)}`;
}

function buildInventory({
  sims,
  avds,
  runtimes,
  systemImages,
  config,
  deadProjects = [],
}: {
  sims: readonly IosSimRecord[];
  avds: readonly AvdRecord[];
  runtimes: readonly SimRuntimeRecord[];
  systemImages: readonly { pkg: string; directory: string }[];
  config: Config | null;
  deadProjects?: readonly string[];
}): Omit<GcInventory, 'notices'> {
  const dead = new Set(deadProjects);
  const assigned = new Map<string, { project: string; slot: string }>();
  for (const [project, record] of Object.entries(config?.projects ?? {})) {
    if (dead.has(project)) continue;
    let slots: ReturnType<typeof projectDeviceSlots>;
    try {
      slots = projectDeviceSlots(record);
    } catch {
      continue;
    }
    for (const { slot, platforms } of slots) {
      if (platforms.ios?.deviceUdid) assigned.set(`ios:${platforms.ios.deviceUdid}`, { project, slot });
      if (platforms.android?.avdName) assigned.set(`android:${platforms.android.avdName}`, { project, slot });
    }
  }
  const parked = new Set([
    ...readParked('ios', { config }).map((sim) => `ios:${sim.udid}`),
    ...readParked('android', { config }).map((avd) => `android:${avd.name}`),
  ]);
  const owner = (
    key: string,
    name: string,
    created: () => boolean,
  ): Pick<InventoryDevice, 'owner' | 'project' | 'slot'> => {
    const workspace = assigned.get(key);
    if (workspace && created())
      return {
        owner: 'workspace',
        project: workspace.project,
        slot: workspace.slot,
      };
    if (parked.has(key)) return { owner: 'parked', project: null, slot: null };
    if (!name.startsWith('stim-')) return { owner: 'user', project: null, slot: null };
    return {
      owner: created() ? 'orphaned' : 'otherStimHome',
      project: null,
      slot: null,
    };
  };

  const devices: InventoryDevice[] = [
    ...sims.map((sim) => ({
      kind: 'ios' as const,
      id: sim.udid,
      name: sim.name,
      model: modelName(sim.deviceTypeIdentifier),
      runtime: sim.runtime,
      state: sim.state,
      lastUsedAt: sim.lastUsedAt ?? null,
      bytes: sim.dataPathSize ?? null,
      directory: sim.dataPath ? sim.dataPath.replace(/\/data\/?$/, '') : null,
      ...owner(`ios:${sim.udid}`, sim.name, () => isStimOwnedSim({ udid: sim.udid, name: sim.name })),
    })),
    ...avds.map((avd) => ({
      kind: 'android' as const,
      id: avd.name,
      name: avd.name,
      model: avd.deviceProfile,
      runtime: avd.systemImage,
      state: null,
      lastUsedAt: avd.lastUsedAt,
      bytes: null,
      directory: avd.directory,
      ...owner(`android:${avd.name}`, avd.name, () => isStimOwnedAvd(avd.name)),
    })),
  ];

  const simsByRuntime = new Map<string, number>();
  for (const sim of sims) simsByRuntime.set(sim.runtime, (simsByRuntime.get(sim.runtime) ?? 0) + 1);
  const avdsByImage = new Map<string, number>();
  for (const avd of avds) {
    if (avd.systemImage) avdsByImage.set(avd.systemImage, (avdsByImage.get(avd.systemImage) ?? 0) + 1);
  }
  return {
    devices,
    runtimes: runtimes.map((runtime) => ({
      identifier: runtime.identifier,
      runtimeIdentifier: runtime.runtimeIdentifier,
      version: runtime.version,
      build: runtime.build,
      bytes: runtime.sizeBytes,
      lastUsedAt: runtime.lastUsedAt,
      deviceCount: runtime.runtimeIdentifier ? (simsByRuntime.get(runtime.runtimeIdentifier) ?? 0) : 0,
      command: runtime.deletable ? `xcrun simctl runtime delete ${runtime.identifier}` : null,
    })),
    systemImages: systemImages.map((image) => ({
      package: image.pkg,
      directory: image.directory,
      avdCount: avdsByImage.get(image.pkg) ?? 0,
      command: sdkmanagerCommand(image.pkg),
    })),
  };
}

function modifiedAt(path: string): string | null {
  try {
    return statSync(path).mtime.toISOString();
  } catch {
    return null;
  }
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function unreadableNotice(what: string, error: unknown): string {
  const notice = `${what} not listed: ${describeError(error)}`;
  if (process.platform !== 'darwin' || (error as NodeJS.ErrnoException).code !== 'EPERM') return notice;
  const app = process.env.STIM_DESKTOP_APP ? 'Stim Desktop' : 'the app that runs stim';
  return `${notice}. macOS privacy protection blocked the read; allow ${app} under System Settings > Privacy & Security > Files and Folders (Removable Volumes for an external disk) or Full Disk Access`;
}

function listAvdRecords(notices: string[], roots: readonly string[] = avdStorageRoots()): AvdRecord[] {
  const records = new Map<string, AvdRecord>();
  for (const root of roots) {
    let names: string[];
    try {
      names = readdirSync(root);
    } catch (error) {
      if (!isMissing(error)) notices.push(unreadableNotice(`AVDs in ${root}`, error));
      continue;
    }
    for (const entry of names) {
      if (!entry.endsWith('.ini')) continue;
      const name = entry.slice(0, -4);
      if (records.has(name)) continue;
      let ini: string;
      try {
        ini = readFileSync(join(root, entry), 'utf8');
      } catch (error) {
        if (!isMissing(error)) notices.push(unreadableNotice(`AVD ${name}`, error));
        continue;
      }
      let directory: string | null = null;
      let config = '';
      let unreadable: unknown = null;
      for (const candidate of avdIniPaths(root, ini)) {
        try {
          config = readFileSync(join(candidate, 'config.ini'), 'utf8');
          directory = candidate;
          break;
        } catch (error) {
          if (!isMissing(error)) unreadable ??= error;
        }
      }
      if (!directory && unreadable) notices.push(unreadableNotice(`details of AVD ${name}`, unreadable));
      records.set(name, {
        name,
        directory,
        systemImage: parseAvdSystemImage(config),
        deviceProfile: parseAvdDeviceProfile(config),
        // The Android Emulator rewrites hardware-qemu.ini each time it boots the AVD.
        lastUsedAt: directory ? modifiedAt(join(directory, 'hardware-qemu.ini')) : null,
      });
    }
  }
  return [...records.values()];
}

function simctl(args: string[]): string {
  return getExecutor().runFile('xcrun', ['simctl', ...args], {
    timeoutMs: DEVICE_LIST_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  });
}

export function collectInventory(config: Config | null, deadProjects: readonly string[]): GcInventory {
  const notices: string[] = [];
  let sims: IosSimRecord[] = [];
  let runtimes: SimRuntimeRecord[] = [];
  if (process.platform === 'darwin') {
    try {
      sims = listAllIosSims({ timeoutMs: DEVICE_LIST_TIMEOUT_MS });
    } catch (error) {
      notices.push(`simulators not listed: ${describeError(error)}`);
    }
    try {
      runtimes = parseSimRuntimeList(simctl(['runtime', 'list', '-j']));
    } catch (error) {
      notices.push(`simulator runtime images not listed: ${describeError(error)}`);
    }
    try {
      runtimes.push(...unlistedRuntimes(simctl(['list', 'runtimes', '-j']), runtimes));
    } catch (error) {
      notices.push(`simulator runtimes not listed: ${describeError(error)}`);
    }
  }
  const imagesRoot = join(androidHome(), 'system-images');
  const images = listInstalledSystemImages((error) =>
    notices.push(unreadableNotice('Android system images', error)),
  ).map((image) => ({
    pkg: image.pkg,
    directory: join(imagesRoot, `android-${image.api}`, image.tag, image.arch),
  }));
  return {
    ...buildInventory({
      sims,
      avds: listAvdRecords(notices),
      runtimes,
      systemImages: images,
      config,
      deadProjects,
    }),
    notices,
  };
}
