import { randomUUID } from 'node:crypto';
import { lstatSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadConfig, withConfigLock } from './config.ts';
import {
  clearAppDataContainer,
  deleteParkedIosSim,
  deleteIosSim,
  findAppDataContainer,
  listIosDeviceTypes,
  parkedSimName,
  parseRuntimeVersion,
  renameIosSim,
  resolveOwnedIosSim,
  shutdownIosSim,
  type IosSimRecord,
} from './sim/ios.ts';
import {
  assertOwnedAvdStopped,
  avdPathExists,
  avdStorageRoots,
  listOrphanedAvdDirectories,
  ownedAvdDirectory,
  type OrphanedAvdDirectory,
  resolveOwnedAvdSerial,
  shutdownAndroidEmulator,
  waitForAndroidEmulatorShutdown,
  deleteAvd,
  ownedAvdMatchesConfiguration,
  ownedAvdSystemImage,
} from './sim/android.ts';
import { parkSim, readParked, removeParkedAfter, type ParkedSim } from './sim-pool.ts';

export interface ParkedDevice {
  udid: string;
  name: string;
  platform?: 'ios' | 'android';
}

export interface TeardownOutcome {
  status: 'torn-down' | 'missing' | 'skipped' | 'failed';
  label?: string;
  kind?: string;
  reason?: string;
  serial?: string | null;
  holders?: string[];
  parked?: ParkedDevice;
  evicted?: ParkedDevice[];
  evictionFailures?: string[];
  parkFallback?: string;
}

export interface ParkRequest {
  projectPath: string;
  max: number;
  bundleId?: string | null;
  cacheKey?: string | null;
  simslimManaged?: boolean;
  configuration?: string;
}

export function teardownParkedAvd(avdName: string): TeardownOutcome {
  try {
    const removed = removeParkedAfter('android', avdName, () => {
      const result = teardownOwnedAvd(avdName, { del: true, owner: { pool: true } });
      if (result.status !== 'torn-down' && result.status !== 'missing') throw new Error(result.reason);
    });
    return removed
      ? { status: 'torn-down', label: avdName }
      : { status: 'skipped', kind: 'not-parked', reason: 'emulator is no longer parked' };
  } catch (error) {
    return { status: 'failed', reason: String((error as Error)?.message || error) };
  }
}

export function teardownParkedIosSim(
  udid: string,
  { label, deleteSim = deleteParkedIosSim }: { label?: string; deleteSim?: typeof deleteParkedIosSim } = {},
): TeardownOutcome {
  try {
    const removed = removeParkedAfter('ios', udid, () => deleteSim(udid));
    if (!removed) return { status: 'skipped', kind: 'not-parked', reason: 'simulator is no longer parked' };
    return { status: 'torn-down', label: label ?? removed.name };
  } catch (error) {
    return { status: 'failed', reason: String((error as Error)?.message || error) };
  }
}

function parkOwnedIosSim(udid: string, park: ParkRequest): { record: ParkedSim; evicted: ParkedSim[] } {
  const resolved = resolveOwnedIosSim(udid);
  if (resolved.missing) throw new Error(`simulator ${udid} disappeared after shutdown`);
  if (resolved.notOwned) throw new Error(`simulator ${udid} is now named ${JSON.stringify(resolved.notOwned)}`);
  const sim = resolved.sim as IosSimRecord;
  if (sim.state !== 'Shutdown') throw new Error(`simulator ${udid} is still ${sim.state} after shutdown`);
  const model = listIosDeviceTypes().find((d) => d.identifier === sim.deviceTypeIdentifier)?.name ?? null;
  const runtime = parseRuntimeVersion(sim.runtime);
  if (park.bundleId) {
    if (!sim.dataPath) throw new Error(`simulator ${udid} did not report a data path for app cleanup`);
    const container = findAppDataContainer(sim.dataPath, park.bundleId);
    if (container) clearAppDataContainer(container);
  }
  const name = parkedSimName(sim.udid, { model, runtime });
  renameIosSim(sim.udid, name);
  const record: ParkedSim = {
    udid: sim.udid,
    name,
    deviceTypeIdentifier: sim.deviceTypeIdentifier,
    runtimeIdentifier: sim.runtime,
    parkedAt: new Date().toISOString(),
    simslimManaged: Boolean(park.simslimManaged),
    ...(park.bundleId ? { bundleId: park.bundleId } : {}),
    ...(park.cacheKey ? { cacheKey: park.cacheKey } : {}),
  };
  const evicted = parkSim({ platform: 'ios', projectPath: park.projectPath, record, max: park.max });
  return { record, evicted };
}

export function teardownOwnedIosSim(
  udid: string,
  { del = false, label, park }: { del?: boolean; label?: string; park?: ParkRequest } = {},
): TeardownOutcome {
  let parkFallback: string | undefined;
  try {
    const resolved = resolveOwnedIosSim(udid);
    if (resolved.notOwned) {
      return {
        status: 'skipped',
        kind: 'not-owned',
        reason: `sim is now named "${resolved.notOwned}", not Stim-owned by name`,
      };
    }
    if (resolved.missing) return { status: 'missing' };
    shutdownIosSim(udid);
    const sim = resolved.sim as IosSimRecord;
    if (del && park && park.max > 0) {
      try {
        const { record, evicted } = parkOwnedIosSim(udid, park);
        const removed: ParkedDevice[] = [];
        const failures: string[] = [];
        for (const entry of evicted) {
          const result = teardownParkedIosSim(entry.udid, { label: entry.name });
          if (result.status === 'torn-down') {
            removed.push({ udid: entry.udid, name: entry.name });
          } else if (result.status === 'failed') {
            failures.push(`could not delete evicted ${entry.name} (${entry.udid}): ${result.reason}`);
          }
        }
        return {
          status: 'torn-down',
          label: label ?? sim.name ?? udid,
          parked: { udid: record.udid, name: record.name },
          evicted: removed,
          ...(failures.length ? { evictionFailures: failures } : {}),
        };
      } catch (e) {
        parkFallback = String((e as Error)?.message || e);
      }
    }
    if (del) deleteIosSim(udid);
    return { status: 'torn-down', label: label ?? sim.name ?? udid, ...(parkFallback ? { parkFallback } : {}) };
  } catch (e) {
    return {
      status: 'failed',
      reason: String((e as Error)?.message || e),
      ...(parkFallback ? { parkFallback } : {}),
    };
  }
}

type AvdOwner = { projectPath: string } | { pool: true };

function removeOrphanedAvdDirectory(candidate: OrphanedAvdDirectory, owner?: AvdOwner): void {
  const detached = withConfigLock(() => {
    const current = listOrphanedAvdDirectories(candidate.name).find((entry) => entry.directory === candidate.directory);
    if (!current || current.name !== candidate.name || current.dev !== candidate.dev || current.ino !== candidate.ino) {
      throw new Error(`AVD data at ${candidate.directory} changed or is registered; it was kept.`);
    }
    const config = loadConfig();
    if (!config) throw new Error('Cannot verify AVD references without a Stim config; the data was kept.');
    for (const [projectPath, project] of Object.entries(config.projects)) {
      if (project.platforms?.android?.avdName !== candidate.name) continue;
      if (
        !owner ||
        !('projectPath' in owner) ||
        owner.projectPath !== projectPath ||
        !project.platforms.android.owned
      ) {
        throw new Error(`AVD ${candidate.name} is referenced by ${projectPath}; its data was kept.`);
      }
    }
    if (
      readParked('android', { config }).some((entry) => entry.name === candidate.name) &&
      !(owner && 'pool' in owner)
    ) {
      throw new Error(`AVD ${candidate.name} is in the emulator pool; its data was kept.`);
    }
    assertOwnedAvdStopped(candidate.name, { resolveDirectory: () => candidate.directory });
    const destination = join(dirname(candidate.directory), `stim-gc-${randomUUID()}.avd`);
    renameSync(candidate.directory, destination);
    return destination;
  });
  const current = lstatSync(detached);
  if (!current.isDirectory() || current.dev !== candidate.dev || current.ino !== candidate.ino) {
    throw new Error(`Detached AVD data changed at ${detached}; it was kept.`);
  }
  try {
    rmSync(detached, { recursive: true });
  } catch (error) {
    throw new Error(`Could not remove AVD data at ${detached}; retry gc --delete: ${(error as Error).message}`, {
      cause: error,
    });
  }
}

function teardownUnregisteredAvd(
  avdName: string,
  del: boolean,
  owner?: AvdOwner,
  surveyed?: OrphanedAvdDirectory,
): TeardownOutcome {
  const candidates = surveyed ? [surveyed] : listOrphanedAvdDirectories(avdName);
  if (candidates.length === 0) {
    if (
      avdStorageRoots().some(
        (root) => avdPathExists(join(root, `${avdName}.ini`)) || avdPathExists(join(root, `${avdName}.avd`)),
      )
    )
      throw new Error(`AVD ${avdName} is not listed but its storage remains; it was kept.`);
    return { status: 'missing' };
  }
  if (!del) return { status: 'skipped', reason: 'AVD registration is missing; its data was kept.' };
  for (const candidate of candidates) {
    if (candidate.name !== avdName) throw new Error(`AVD data does not match ${avdName}; it was kept.`);
    removeOrphanedAvdDirectory(candidate, owner);
  }
  return { status: 'torn-down', label: avdName };
}

export function teardownOwnedAvd(
  avdName: string,
  {
    del = false,
    park,
    owner,
    orphanedDirectory,
    waitForShutdown = waitForAndroidEmulatorShutdown,
    assertStopped = assertOwnedAvdStopped,
    resolveAvd = resolveOwnedAvdSerial,
  }: {
    del?: boolean;
    park?: ParkRequest;
    owner?: AvdOwner;
    orphanedDirectory?: OrphanedAvdDirectory;
    waitForShutdown?: typeof waitForAndroidEmulatorShutdown;
    assertStopped?: typeof assertOwnedAvdStopped;
    resolveAvd?: typeof resolveOwnedAvdSerial;
  } = {},
): TeardownOutcome {
  let parkFallback: string | undefined;
  try {
    if (!/^stim-[A-Za-z0-9._-]+$/.test(avdName)) {
      return { status: 'skipped', kind: 'not-owned', reason: `AVD ${avdName} is not Stim-owned by name` };
    }
    const resolved = resolveAvd(avdName);
    if (resolved.notOwned) {
      return { status: 'skipped', kind: 'not-owned', reason: `AVD ${avdName} is not Stim-owned by name` };
    }
    if (resolved.missing) return teardownUnregisteredAvd(avdName, del, owner, orphanedDirectory);
    if (orphanedDirectory) return { status: 'skipped', reason: 'AVD registration appeared; its data was kept.' };
    const serial = resolved.serial;
    if (serial) {
      waitForShutdown(avdName, (timeoutMs) => shutdownAndroidEmulator(serial, timeoutMs));
    } else {
      assertStopped(avdName);
    }
    if (del) {
      const current = resolveAvd(avdName);
      if (current.notOwned) {
        return { status: 'skipped', kind: 'not-owned', reason: `AVD ${avdName} is not Stim-owned by name` };
      }
      if (current.missing) return teardownUnregisteredAvd(avdName, del, owner);
      if (current.serial) throw new Error(`Owned AVD ${avdName} started again before deletion.`);
      assertStopped(avdName);
      if (park && park.max > 0) {
        try {
          const systemImage = ownedAvdSystemImage(avdName);
          if (!systemImage || !park.configuration || !ownedAvdMatchesConfiguration(avdName, park.configuration)) {
            throw new Error('the AVD has no verified creation configuration');
          }
          const evicted = parkSim({
            platform: 'android',
            projectPath: park.projectPath,
            max: park.max,
            record: {
              udid: avdName,
              name: avdName,
              systemImage,
              configuration: park.configuration,
              parkedAt: new Date().toISOString(),
            },
          });
          const removed: ParkedDevice[] = [];
          const failures: string[] = [];
          for (const entry of evicted) {
            const result = teardownParkedAvd(entry.name);
            if (result.status === 'torn-down')
              removed.push({ udid: entry.name, name: entry.name, platform: 'android' });
            else if (result.status === 'failed')
              failures.push(`could not delete evicted ${entry.name}: ${result.reason}`);
          }
          return {
            status: 'torn-down',
            label: avdName,
            parked: { udid: avdName, name: avdName, platform: 'android' },
            evicted: removed,
            ...(failures.length ? { evictionFailures: failures } : {}),
          };
        } catch (error) {
          parkFallback = String((error as Error)?.message || error);
        }
      }
      const directory = ownedAvdDirectory(avdName);
      const paths = avdStorageRoots().map((root) => join(root, `${avdName}.ini`));
      if (directory) paths.push(directory);
      deleteAvd(avdName);
      const remaining = paths.filter(avdPathExists);
      if (remaining.length)
        throw new Error(`AVD ${avdName} was only partially deleted; data remains at ${remaining.join(', ')}.`);
    }
    return {
      status: 'torn-down',
      label: avdName,
      serial: resolved.serial ?? null,
      ...(parkFallback ? { parkFallback } : {}),
    };
  } catch (e) {
    return { status: 'failed', reason: String((e as Error)?.message || e) };
  }
}
