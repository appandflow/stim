import chalk from 'chalk';
import { configDir, isScopedHome, type StimContext } from '@stim-cli/core';
import { WorkspaceProcessCleanupError } from '../../engine/workspace-process-lock.ts';
import { loadConfig, removeProject, withConfigLockAsync, type Config } from '../../workspace/config.ts';
import { directorySizeAsync, isAbsentPath, isOnMountedVolume, listMountedVolumes } from '../../fs-util.ts';
import { listBuildLocks, type BuildLockInfo } from '../../engine/build-lock.ts';
import { listBuildSlots, type BuildSlotInfo } from '../../engine/build-slots.ts';
import { clearFreeClaimSet } from '../../ownership-claim.ts';
import { detectIsExpo, findProjectRoot } from '../../workspace/project.ts';
import { reclaimProject } from '../../devices/reclaim.ts';
import { listAllIosSimsAsync, listIosLaunchdOverridesFolders, type IosSimRecord } from '../../devices/ios.ts';
import { listAvdsAsync, listOrphanedAvdDirectories, ownedAvdDirectory } from '../../devices/android.ts';
import { readCreatedDevices } from '../../devices/created-devices.ts';
import { withEasProjectLock } from '../../engine/eas-project-lock.ts';
import { ownedDeviceUsage } from '../../stimd/passes/devices.ts';
import type { OrphanedDevice } from './types.ts';
import { classifyProjectEntries } from './projects.ts';
import type { GcOutput } from './results.ts';
import {
  describeDeadProjectDevices,
  describeUnverifiableDevices,
  deviceSweepIsScoped,
  DEVICE_LIST_TIMEOUT_MS,
  findDeadProjectOwnedDevices,
  findOrphanedDevices,
  findSimulatorLaunchdLeftovers,
  findStaleDeviceRecords,
  sizeSimulatorLaunchdFolders,
  withAndroidAvdSizes,
  type GcDeviceDependencies,
  type SimulatorLaunchdFolder,
  type StaleDeviceRecord,
  type UnverifiedDevice,
} from './devices.ts';
import { findStaleEasLedgerEntries } from './eas-ledger.ts';
import { collectOtherHomes, type OtherHomesDependencies, type OtherHomesReport } from './other-homes.ts';
import {
  collectEasSessionSweep,
  describeError,
  withRemoteSessionGcLocks,
  type EasGcDependencies,
  type EasSessionSweep,
} from './eas-sessions.ts';
import { findStaleAndroidLedgerEntries, findStaleLedgerEntries, staleBrowserProfiles, type StaleLedgerEntry } from './ledger.ts';
import { ownedDeviceDisk, type OwnedDeviceDisk } from './finished-devices.ts';

export type RecordDependencies = EasGcDependencies & GcDeviceDependencies & OtherHomesDependencies;

/** What outlived the project, device or process it describes: registry entries, owned devices, ledgers and claims. */
export interface DeviceRecords {
  orphanedDevices: OrphanedDevice[];
  unverifiedDevices: UnverifiedDevice[];
  simulatorLaunchdFolders: SimulatorLaunchdFolder[];
  staleDeviceRecords: StaleDeviceRecord[];
  staleLedgerEntries: StaleLedgerEntry[];
  otherHomes: OtherHomesReport | null;
  ownedDeviceDisk: OwnedDeviceDisk[];
  /** The available simulators and registered AVDs, when either list answered. */
  listed: { sims: IosSimRecord[]; avds: string[] } | null;
  notices: string[];
}

/**
 * Lists simulators and AVDs once and finds the owned devices whose project is gone, device records and ledger entries
 * whose device is gone, and other Stim homes that no longer exist. A scoped home lists devices only to name the ones a
 * dead project owned, since simulators and AVDs are machine-global.
 */
export async function collectDeviceRecords(
  cfg: Config | null,
  deadProjects: string[],
  deps: RecordDependencies = {},
): Promise<DeviceRecords> {
  const operation = deps.operation;
  const env = operation?.env ?? process.env;
  const mountedVolumes = listMountedVolumes();
  const notices: string[] = [];
  let orphanedDevices: OrphanedDevice[] = [];
  let unverifiedDevices: UnverifiedDevice[] = [];
  let simulatorLaunchdFolders: SimulatorLaunchdFolder[] = [];
  let staleDeviceRecords: StaleDeviceRecord[] = [];
  let staleLedgerEntries: StaleLedgerEntry[] = staleBrowserProfiles(readCreatedDevices());
  let listed: DeviceRecords['listed'] = null;
  let otherHomes: OtherHomesReport | null = null;
  let deviceDisk: OwnedDeviceDisk[] = [];
  const avdSizes = new Map<string, Promise<number>>();
  const avdSize: typeof directorySizeAsync = (dir, options) => {
    let bytes = avdSizes.get(dir);
    if (bytes === undefined)
      avdSizes.set(
        dir,
        (bytes = Promise.resolve(
          (deps.directorySize ?? directorySizeAsync)(dir, { ...options, operation, signal: operation?.signal }),
        )),
      );
    return bytes;
  };
  const unsweepableReason =
    cfg === null
      ? 'no Stim config found'
      : deviceSweepIsScoped(env)
        ? 'STIM_HOME scopes this config, but simulators and AVDs are machine-global'
        : null;

  if (unsweepableReason) {
    let allSims: IosSimRecord[] = [];
    let avdNames: string[] = [];
    try {
      allSims = await listAllIosSimsAsync({ timeoutMs: DEVICE_LIST_TIMEOUT_MS, operation, signal: operation?.signal });
    } catch (error) {
      if (error instanceof WorkspaceProcessCleanupError) throw error;
      operation?.signal.throwIfAborted();
    }
    try {
      avdNames = await listAvdsAsync({ timeoutMs: DEVICE_LIST_TIMEOUT_MS, operation, signal: operation?.signal });
    } catch (error) {
      if (error instanceof WorkspaceProcessCleanupError) throw error;
      operation?.signal.throwIfAborted();
    }
    const deadOwned =
      cfg === null ? [] : findDeadProjectOwnedDevices({ config: cfg, deadProjects, sims: allSims, avds: avdNames });
    const deadOwnedIds = new Set(deadOwned.map((device) => device.id));
    notices.push(
      ...describeDeadProjectDevices(deadOwned),
      ...describeUnverifiableDevices(
        allSims.filter((sim) => !deadOwnedIds.has(sim.udid)).map((sim) => sim.name),
        avdNames.filter((name) => !deadOwnedIds.has(name)),
        { reason: unsweepableReason },
      ),
    );
    return {
      orphanedDevices,
      unverifiedDevices,
      simulatorLaunchdFolders,
      staleDeviceRecords,
      staleLedgerEntries,
      otherHomes,
      ownedDeviceDisk: deviceDisk,
      listed,
      notices,
    };
  }

  let sims: IosSimRecord[] = [];
  let simsChecked = true;
  let everySim: IosSimRecord[] | null = null;
  const ledger = readCreatedDevices();
  try {
    const allSims = await listAllIosSimsAsync({
      timeoutMs: DEVICE_LIST_TIMEOUT_MS,
      includeUnavailable: true,
      operation,
      signal: operation?.signal,
    });
    everySim = allSims;
    staleLedgerEntries = [...staleLedgerEntries, ...findStaleLedgerEntries(ledger, allSims)];
    sims = allSims.filter((sim) => sim.available);
  } catch (error) {
    if (error instanceof WorkspaceProcessCleanupError) throw error;
    operation?.signal.throwIfAborted();
    simsChecked = false;
    notices.push(`ios device sweep skipped: simulator tooling did not answer within ${DEVICE_LIST_TIMEOUT_MS / 1000}s`);
  }
  let avds: string[] = [];
  let avdsChecked = true;
  try {
    avds = await listAvdsAsync({ timeoutMs: DEVICE_LIST_TIMEOUT_MS, operation, signal: operation?.signal });
  } catch (error) {
    if (error instanceof WorkspaceProcessCleanupError) throw error;
    operation?.signal.throwIfAborted();
    avdsChecked = false;
    notices.push(
      `android device sweep skipped: emulator tooling did not answer within ${DEVICE_LIST_TIMEOUT_MS / 1000}s`,
    );
  }

  if (everySim !== null) {
    simulatorLaunchdFolders = await sizeSimulatorLaunchdFolders(
      findSimulatorLaunchdLeftovers({ folders: listIosLaunchdOverridesFolders(), sims: everySim }),
      operation,
    );
  }

  let orphanedAvdDirectories: ReturnType<typeof listOrphanedAvdDirectories> = [];
  if (avdsChecked) {
    try {
      orphanedAvdDirectories = listOrphanedAvdDirectories();
    } catch (error) {
      avdsChecked = false;
      notices.push(`android data sweep skipped: ${(error as Error).message}`);
    }
  }
  if (avdsChecked) {
    staleLedgerEntries = [...staleLedgerEntries, ...findStaleAndroidLedgerEntries(ledger, avds, loadConfig())];
  }
  const registeredAvds = new Set(avds);
  avds = [...new Set([...avds, ...orphanedAvdDirectories.map((entry) => entry.name)])];
  const isMounted = (path: string) => isOnMountedVolume(path, mountedVolumes);
  const found = findOrphanedDevices({ sims, avds, config: cfg, isMounted, deadProjects });
  unverifiedDevices = found.unverified.flatMap((device) => {
    const directories =
      device.kind === 'android' && !registeredAvds.has(device.id)
        ? orphanedAvdDirectories.filter((entry) => entry.name === device.id)
        : [];
    return directories.length ? directories.map(({ directory }) => Object.assign({}, device, { directory })) : [device];
  });
  orphanedDevices = await withAndroidAvdSizes(
    found.orphaned.flatMap((device) => {
      const directories =
        device.kind === 'android' ? orphanedAvdDirectories.filter((entry) => entry.name === device.name) : [];
      return directories.length
        ? directories.map((orphanedDirectory) => Object.assign({}, device, { orphanedDirectory }))
        : [device];
    }),
    { avdDirectory: deps.avdDirectory ?? ownedAvdDirectory, size: avdSize, operation },
  );
  if (!isScopedHome(env)) {
    otherHomes = await collectOtherHomes(
      configDir(),
      { sims: everySim, avds: avdsChecked ? avds : null },
      mountedVolumes,
      deps,
      operation,
    );
    if (otherHomes.notice) notices.push(otherHomes.notice);
  }
  if (simsChecked || avdsChecked) {
    const lists = { sims, avds: [...registeredAvds] };
    listed = lists;
    let unmeasured = 0;
    const usage = await ownedDeviceUsage(
      (_target, workspace) => {
        if (workspace) unmeasured++;
      },
      {
        sims: () => lists.sims,
        avds: () => lists.avds,
        avdDirectory: deps.avdDirectory ?? ownedAvdDirectory,
        size: async (dir) => (await avdSize(dir, { timeoutMs: 5000 })) || null,
      },
    );
    deviceDisk = ownedDeviceDisk(usage, { android: unmeasured });
  }
  staleDeviceRecords = findStaleDeviceRecords({ config: cfg, sims, avds, deadProjects, simsChecked, avdsChecked });
  return {
    orphanedDevices,
    unverifiedDevices,
    simulatorLaunchdFolders,
    staleDeviceRecords,
    staleLedgerEntries,
    otherHomes,
    ownedDeviceDisk: deviceDisk,
    listed,
    notices,
  };
}

/** The registry entries whose project is gone or that cannot be read, and the ones whose absence cannot be proven. */
export function collectProjectRecords(cfg: Config | null = loadConfig()): ReturnType<typeof classifyProjectEntries> {
  return classifyProjectEntries(cfg?.projects ?? {}, listMountedVolumes());
}

export interface StaleClaims {
  buildLocks: { stale: BuildLockInfo[]; live: BuildLockInfo[]; unresolved: BuildLockInfo[] };
  buildSlots: { stale: BuildSlotInfo[]; live: BuildSlotInfo[]; unresolved: BuildSlotInfo[] };
}

export function collectStaleClaims(): StaleClaims {
  const locks = listBuildLocks();
  const slots = listBuildSlots();
  return {
    buildLocks: {
      stale: locks.filter((l) => !l.alive && !l.unresolved),
      live: locks.filter((l) => l.alive),
      unresolved: locks.filter((l) => l.unresolved),
    },
    buildSlots: {
      stale: slots.filter((s) => !s.alive && !s.unresolved),
      live: slots.filter((s) => s.alive),
      unresolved: slots.filter((s) => s.unresolved),
    },
  };
}

export { findStaleEasLedgerEntries };

export async function removeInvalidProjectEntries(
  invalidProjects: string[],
  output: GcOutput,
  signal?: AbortSignal,
): Promise<void> {
  for (const path of invalidProjects) {
    signal?.throwIfAborted();
    await withConfigLockAsync(() => removeProject(path), signal);
    output.log(chalk.green(`Removed the invalid registry entry ${path}`));
    output.record('project', 'done', path);
  }
}

export async function pruneDeadProjects(
  deadProjects: string[],
  output: GcOutput,
  operation?: StimContext,
): Promise<number> {
  let deleteFailures = 0;
  for (const path of deadProjects) {
    operation?.signal.throwIfAborted();
    if (!isAbsentPath(path) || !isOnMountedVolume(path)) {
      output.log(chalk.yellow(`Kept ${path}: its absence can no longer be confirmed.`));
      output.record('project', 'kept', path, { detail: 'its absence can no longer be confirmed' });
      continue;
    }
    const result = await reclaimProject(path, {
      archive: { removedBy: 'gc' },
      deleteOwnedDevices: deviceSweepIsScoped(operation?.env ?? process.env),
      stopRequester: { by: 'stim gc' },
      operation,
    }).catch((error: unknown) => {
      if (error instanceof WorkspaceProcessCleanupError) throw error;
      operation?.signal.throwIfAborted();
      deleteFailures++;
      output.log(chalk.red(`Could not prune ${path}; its registry entry was kept: ${(error as Error).message}`));
      output.record('project', 'failed', path, { detail: `its registry entry was kept: ${(error as Error).message}` });
      return null;
    });
    if (!result) continue;
    if (result.keptEntry) {
      output.record('project', 'kept', path, { detail: 'it could not be fully pruned; its registry entry was kept' });
    } else {
      output.record('project', 'done', path);
    }
    for (const dir of result.removedWorkspaceDirs) output.record('workspaceDirectory', 'done', dir);
    for (const dir of result.failedWorkspaceDirs) {
      output.record('workspaceDirectory', 'failed', dir, { detail: `could not remove it while pruning ${path}` });
      deleteFailures += 1;
    }
    for (const name of result.deletedDevices) output.record('device', 'done', name);
    for (const s of result.skippedDevices) {
      output.record('device', result.failedDevices.includes(s) ? 'failed' : 'kept', s.name, {
        id: s.udid ?? null,
        detail: s.reason,
      });
    }
    deleteFailures += result.failedDevices.length;
  }
  return deleteFailures;
}

/** Clears the build locks and slots whose holder is proven gone; a held or refused one stays. */
export function clearStaleClaims(claims: StaleClaims, output: GcOutput, signal?: AbortSignal): number {
  let failures = 0;
  const clear = (path: string, label: string, kind: 'buildLock' | 'buildSlot') => {
    signal?.throwIfAborted();
    const cleared = clearFreeClaimSet({ root: path, label });
    if (cleared.status === 'held') return;
    if (cleared.status === 'refused') {
      output.record(kind, 'kept', label, { id: path, detail: cleared.reason });
      return;
    }
    if (cleared.status === 'failed') {
      failures++;
      output.record(kind, 'failed', label, { id: path, detail: cleared.reason });
      return;
    }
    output.record(kind, 'done', label, { id: path });
  };
  for (const lock of claims.buildLocks.stale) clear(lock.path, `${lock.platform} build lock`, 'buildLock');
  for (const slot of claims.buildSlots.stale) clear(slot.path, `build slot ${slot.index ?? '?'}`, 'buildSlot');
  return failures;
}

/**
 * The orphaned EAS sessions of the Expo project `cwd` is in, collected under that project's EAS lock without waiting
 * for it. Null outside an Expo project.
 */
export async function collectProjectEasSessions(deps: RecordDependencies): Promise<EasSessionSweep | null> {
  let projectRoot: string | null = null;
  try {
    projectRoot = (deps.findProjectRoot ?? findProjectRoot)(deps.operation?.cwd ?? process.cwd());
    if (!projectRoot || !(deps.detectIsExpo ?? detectIsExpo)(projectRoot)) return null;
  } catch (error) {
    return {
      projectScope: projectRoot,
      orphaned: [],
      notices: [`EAS session sweep skipped: project classification failed: ${describeError(error)}`],
      deletionSafe: false,
    };
  }
  const root = projectRoot;
  let started = false;
  try {
    return await (deps.withEasProjectLock ?? withEasProjectLock)(
      root,
      () => {
        started = true;
        return withRemoteSessionGcLocks(root, deps, (coordinated) => collectEasSessionSweep(loadConfig(), coordinated));
      },
      {
        waitMs: 0,
        ownerPurpose: 'EAS orphan sweep',
        machineRoot: deps.easLedgerRoot,
        ...(deps.operation ? { signal: deps.operation.signal, declareSpawnsFor: deps.operation } : {}),
      },
    );
  } catch (error) {
    if (error instanceof WorkspaceProcessCleanupError || (error instanceof Error && 'reportCleanup' in error))
      throw error;
    deps.operation?.signal.throwIfAborted();
    return {
      projectScope: root,
      orphaned: [],
      notices: [
        `EAS session sweep skipped: ${started ? 'EAS collection failed' : 'EAS project lock acquisition failed'}: ${describeError(error)}`,
      ],
      deletionSafe: false,
    };
  }
}
