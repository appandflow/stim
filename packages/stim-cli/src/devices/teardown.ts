import { closeOwnedDeviceSessions } from './agent-device-cleanup.ts';
import { deviceSlotPlatforms, projectDeviceSlots } from './device-slots.ts';
import { forgetCreatedDevice, readCreatedDevices, recordCreatedDevice } from './created-devices.ts';
import { isStimOwnedAvd } from './device-ownership.ts';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { existsSync, lstatSync, renameSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { getProject, loadConfig, withConfigLock } from '../workspace/config.ts';
import { withWorkspaceProcessLock } from '../engine/workspace-process-lock.ts';
import { signalProcessTree } from '../metro.ts';
import { releaseBrowserPort } from '../named-ports.ts';
import { inspectProcessIdentity, waitForProcessExit } from '../process-identity.ts';
import { chromeProcessState, liveProfileHolder, removeSingletonFiles } from '../web/profile.ts';
import {
  CDP_PORT_LABEL,
  clearWebRecord,
  readWebRecord,
  webClaimRoot,
  webProfileDir,
  type OwnedProcess,
} from '../web/state.ts';
import { workspaceDir } from '../workspace/paths.ts';
import {
  deleteParkedIosSim,
  deleteIosSim,
  eraseIosSim,
  listIosDeviceTypes,
  parkedSimName,
  parseRuntimeVersion,
  renameIosSim,
  resolveOwnedIosSim,
  shutdownIosSim,
  type IosSimRecord,
  type ResolvedIosSim,
} from './ios.ts';
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
  sleepSync,
  wipeAvdUserData,
} from './android.ts';
import { parkSim, readParked, removeParkedAfter, type ParkedSim } from './sim-pool.ts';
import { acquireAvdClaim } from './avd-claim.ts';
import {
  claimRemoveCommand,
  clearClaimChild,
  clearFreeClaimSet,
  markClaimChildPending,
  releaseClaim,
  type ClaimHandle,
} from '../ownership-claim.ts';

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
  slot?: string;
  projectPath: string;
  max: number;
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
    const removed = removeParkedAfter('ios', udid, () => {
      closeOwnedDeviceSessions({ platform: 'ios', id: udid }, () => Boolean(resolveOwnedIosSim(udid).sim));
      deleteSim(udid);
    });
    if (!removed) return { status: 'skipped', kind: 'not-parked', reason: 'simulator is no longer parked' };
    return { status: 'torn-down', label: label ?? removed.name };
  } catch (error) {
    return { status: 'failed', reason: String((error as Error)?.message || error) };
  }
}

const IOS_SHUTDOWN_SETTLE_MS = 15_000;
const IOS_SHUTDOWN_POLL_MS = 250;
const IOS_SHUTDOWN_ATTEMPTS = 2;

interface ShutdownSettleClock {
  now?: () => number;
  sleep?: (ms: number) => void;
}

function settleIosSimShutdown(
  udid: string,
  { now = Date.now, sleep = sleepSync }: ShutdownSettleClock,
): ResolvedIosSim {
  let resolved = resolveOwnedIosSim(udid);
  for (let attempt = 1; ; attempt++) {
    const deadline = now() + IOS_SHUTDOWN_SETTLE_MS;
    while (resolved.sim && resolved.sim.state !== 'Shutdown' && now() < deadline) {
      sleep(IOS_SHUTDOWN_POLL_MS);
      resolved = resolveOwnedIosSim(udid);
    }
    if (!resolved.sim || resolved.sim.state === 'Shutdown' || attempt === IOS_SHUTDOWN_ATTEMPTS) return resolved;
    shutdownIosSim(udid);
    resolved = resolveOwnedIosSim(udid);
  }
}

function iosShutdownFailureReason(udid: string, state: string): string {
  return `simulator ${udid} is still ${state} after ${IOS_SHUTDOWN_ATTEMPTS} shutdown attempts and ${(IOS_SHUTDOWN_ATTEMPTS * IOS_SHUTDOWN_SETTLE_MS) / 1000}s of waiting`;
}

function parkOwnedIosSim(
  settled: ResolvedIosSim,
  udid: string,
  park: ParkRequest,
): { record: ParkedSim; evicted: ParkedSim[] } {
  if (settled.missing) throw new Error(`simulator ${udid} disappeared after shutdown`);
  if (settled.notOwned) throw new Error(`simulator ${udid} is now named ${JSON.stringify(settled.notOwned)}`);
  const sim = settled.sim as IosSimRecord;
  if (sim.state !== 'Shutdown') {
    throw new Error(iosShutdownFailureReason(udid, sim.state));
  }
  const model = listIosDeviceTypes().find((d) => d.identifier === sim.deviceTypeIdentifier)?.name ?? null;
  const runtime = parseRuntimeVersion(sim.runtime);
  eraseIosSim(sim.udid);
  const name = parkedSimName(sim.udid, { model, runtime });
  renameIosSim(sim.udid, name);
  const record: ParkedSim = {
    udid: sim.udid,
    name,
    deviceTypeIdentifier: sim.deviceTypeIdentifier,
    runtimeIdentifier: sim.runtime,
    parkedAt: new Date().toISOString(),
    simslimManaged: Boolean(park.simslimManaged),
  };
  const evicted = parkSim({ platform: 'ios', projectPath: park.projectPath, slot: park.slot, record, max: park.max });
  return { record, evicted };
}

export function teardownOwnedIosSim(
  udid: string,
  {
    del = false,
    label,
    park,
    workspace,
    shutdownClock = {},
  }: {
    del?: boolean;
    label?: string;
    park?: ParkRequest;
    workspace?: string;
    shutdownClock?: ShutdownSettleClock;
  } = {},
): TeardownOutcome {
  let parkFallback: string | undefined;
  try {
    const resolved = resolveOwnedIosSim(udid);
    if (resolved.notOwned) {
      return {
        status: 'skipped',
        kind: 'not-owned',
        reason: `sim "${resolved.notOwned}" is not Stim-owned: Stim has no record of creating it`,
      };
    }
    if (resolved.missing) return { status: 'missing' };
    closeOwnedDeviceSessions({ platform: 'ios', id: udid }, () => Boolean(resolveOwnedIosSim(udid).sim), workspace);
    const current = resolveOwnedIosSim(udid);
    if (current.missing) return { status: 'missing' };
    if (current.notOwned)
      return { status: 'skipped', kind: 'not-owned', reason: 'simulator ownership changed before shutdown' };
    shutdownIosSim(udid);
    const sim = resolved.sim as IosSimRecord;
    if (del && park && park.max > 0) {
      try {
        const settled = settleIosSimShutdown(udid, shutdownClock);
        const { record, evicted } = parkOwnedIosSim(settled, udid, park);
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
    if (del) {
      deleteIosSim(udid);
      return { status: 'torn-down', label: label ?? sim.name ?? udid, ...(parkFallback ? { parkFallback } : {}) };
    }
    const settled = settleIosSimShutdown(udid, shutdownClock);
    if (settled.sim && settled.sim.state !== 'Shutdown') {
      return {
        status: 'failed',
        label: label ?? sim.name ?? udid,
        reason: iosShutdownFailureReason(udid, settled.sim.state),
      };
    }
    return { status: 'torn-down', label: label ?? sim.name ?? udid };
  } catch (e) {
    return {
      status: 'failed',
      reason: String((e as Error)?.message || e),
      ...(parkFallback ? { parkFallback } : {}),
    };
  }
}

type AvdOwner = { projectPath: string; slot?: string; expectedRecord?: object } | { pool: true };

function assertAvdReferences(avdName: string, owner?: AvdOwner): void {
  const config = loadConfig();
  if (!config) throw new Error('Cannot verify AVD references without a Stim config; the data was kept.');
  if (
    owner &&
    'projectPath' in owner &&
    owner.expectedRecord &&
    !isDeepStrictEqual(
      deviceSlotPlatforms(config.projects[owner.projectPath], owner.slot)?.android,
      owner.expectedRecord,
    )
  ) {
    throw new Error(`AVD ${avdName} has a changed workspace record; its data was kept.`);
  }
  for (const [projectPath, project] of Object.entries(config.projects)) {
    for (const { slot, platforms } of projectDeviceSlots(project)) {
      if (platforms.android?.avdName?.toLowerCase() !== avdName.toLowerCase()) continue;
      if (
        !owner ||
        !('projectPath' in owner) ||
        owner.projectPath !== projectPath ||
        (owner.slot ?? 'default') !== slot ||
        !platforms.android.owned
      ) {
        throw new Error(`AVD ${avdName} is referenced by ${projectPath} (${slot}); its data was kept.`);
      }
    }
  }
  if (
    readParked('android', { config }).some((entry) => entry.name.toLowerCase() === avdName.toLowerCase()) &&
    !(owner && 'pool' in owner)
  ) {
    throw new Error(`AVD ${avdName} is in the emulator pool; its data was kept.`);
  }
}

function removeOrphanedAvdDirectory(candidate: OrphanedAvdDirectory, owner?: AvdOwner): void {
  const surveyed = listOrphanedAvdDirectories(candidate.name).find((entry) => entry.directory === candidate.directory);
  if (
    !surveyed ||
    surveyed.name !== candidate.name ||
    surveyed.dev !== candidate.dev ||
    surveyed.ino !== candidate.ino
  ) {
    throw new Error(`AVD data at ${candidate.directory} changed or is registered; it was kept.`);
  }
  assertOwnedAvdStopped(candidate.name, { resolveDirectory: () => candidate.directory });
  const detached = withConfigLock(() => {
    const current = lstatSync(candidate.directory);
    if (!current.isDirectory() || current.dev !== candidate.dev || current.ino !== candidate.ino) {
      throw new Error(`AVD data at ${candidate.directory} changed or is registered; it was kept.`);
    }
    assertAvdReferences(candidate.name, owner);
    const name = `stim-gc-${randomUUID()}`;
    recordCreatedDevice('android', name);
    const destination = join(dirname(candidate.directory), `${name}.avd`);
    try {
      renameSync(candidate.directory, destination);
    } catch (error) {
      forgetCreatedDevice('android', name);
      throw error;
    }
    forgetCreatedDevice('android', candidate.name);
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
  forgetCreatedDevice('android', basename(detached, '.avd'));
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

interface AvdTeardownOptions {
  del?: boolean;
  park?: ParkRequest;
  owner?: AvdOwner;
  workspace?: string;
  orphanedDirectory?: OrphanedAvdDirectory;
  onlyIfMissing?: boolean;
  onRemoved?: () => void;
  waitForShutdown?: typeof waitForAndroidEmulatorShutdown;
  assertStopped?: typeof assertOwnedAvdStopped;
  resolveAvd?: typeof resolveOwnedAvdSerial;
}

export function teardownOwnedAvd(avdName: string, options: AvdTeardownOptions = {}): TeardownOutcome {
  let claim: ClaimHandle | undefined;
  try {
    if (!isStimOwnedAvd(avdName)) {
      return {
        status: 'skipped',
        kind: 'not-owned',
        reason: `AVD ${avdName} is not Stim-owned: Stim has no record of creating it`,
      };
    }
    claim = acquireAvdClaim(avdName);
    const result = teardownClaimedAvd(avdName, claim, options);
    if (result.status === 'torn-down' || result.status === 'missing') options.onRemoved?.();
    return result;
  } catch (error) {
    return { status: 'failed', reason: String((error as Error)?.message || error) };
  } finally {
    releaseClaim(claim);
  }
}

function teardownClaimedAvd(
  avdName: string,
  claim: ClaimHandle,
  {
    del = false,
    park,
    owner,
    workspace,
    orphanedDirectory,
    onlyIfMissing = false,
    waitForShutdown = waitForAndroidEmulatorShutdown,
    assertStopped = assertOwnedAvdStopped,
    resolveAvd = resolveOwnedAvdSerial,
  }: AvdTeardownOptions,
): TeardownOutcome {
  let parkFallback: string | undefined;
  try {
    if (del) withConfigLock(() => assertAvdReferences(avdName, owner));
    const resolved = resolveAvd(avdName);
    if (resolved.notOwned) {
      return {
        status: 'skipped',
        kind: 'not-owned',
        reason: `AVD ${avdName} is not Stim-owned: Stim has no record of creating it`,
      };
    }
    if (resolved.missing) return teardownUnregisteredAvd(avdName, del, owner, orphanedDirectory);
    if (onlyIfMissing) return { status: 'skipped', reason: 'AVD registration appeared; its record was kept.' };
    if (orphanedDirectory) return { status: 'skipped', reason: 'AVD registration appeared; its data was kept.' };
    const serial = resolved.serial;
    if (serial) {
      const stillOwned = () => {
        const current = resolveAvd(avdName);
        return !current.notOwned && !current.missing && current.serial === serial;
      };
      closeOwnedDeviceSessions({ platform: 'android', id: serial, avdName }, stillOwned, workspace);
      if (!stillOwned()) throw new Error(`Owned AVD ${avdName} changed before shutdown; it was kept.`);
      waitForShutdown(avdName, (timeoutMs) => {
        markClaimChildPending(claim);
        try {
          shutdownAndroidEmulator(serial, timeoutMs);
        } finally {
          clearClaimChild(claim);
        }
      });
    } else {
      waitForShutdown(avdName, null);
    }
    if (del) {
      const current = resolveAvd(avdName);
      if (current.notOwned) {
        return {
          status: 'skipped',
          kind: 'not-owned',
          reason: `AVD ${avdName} is not Stim-owned: Stim has no record of creating it`,
        };
      }
      if (current.missing) return teardownUnregisteredAvd(avdName, del, owner);
      if (current.serial) throw new Error(`Owned AVD ${avdName} started again before deletion.`);
      assertStopped(avdName);
      withConfigLock(() => assertAvdReferences(avdName, owner));
      if (park && park.max > 0) {
        try {
          const systemImage = ownedAvdSystemImage(avdName);
          if (!systemImage || !park.configuration || !ownedAvdMatchesConfiguration(avdName, park.configuration)) {
            throw new Error('the AVD has no verified creation configuration');
          }
          const directory = ownedAvdDirectory(avdName);
          if (!directory) throw new Error('the AVD data directory could not be resolved');
          wipeAvdUserData(directory);
          const evicted = parkSim({
            platform: 'android',
            projectPath: park.projectPath,
            slot: park.slot,
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
      markClaimChildPending(claim);
      try {
        deleteAvd(avdName);
      } finally {
        clearClaimChild(claim);
      }
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

const BROWSER_EXIT_WAIT_MS = 15_000;
const CHROME_KILL_WAIT_MS = 5_000;

async function stopOwnedChrome(record: OwnedProcess): Promise<boolean> {
  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    const state = chromeProcessState(record);
    if (state === 'gone') return true;
    if (state === 'unknown') return false;
    try {
      signalProcessTree(record.pid, signal, { group: true });
    } catch {}
    const deadline = Date.now() + CHROME_KILL_WAIT_MS;
    while (chromeProcessState(record) !== 'gone' && Date.now() < deadline) await sleepAsync(50);
  }
  return chromeProcessState(record) === 'gone';
}

const sleepAsync = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/** The `web` workspace process lock `stim web` and browser teardown share. */
export const BROWSER_LOCK = 'web';

/**
 * Closes the workspace's Stim-owned Chrome and its supervisor, after verifying both process identities. With
 * `deleteProfile`, it also deletes the profile directory, only when the created-devices ledger lists it.
 */
export async function teardownOwnedBrowser(
  root: string,
  options: { deleteProfile?: boolean } = {},
): Promise<TeardownOutcome> {
  try {
    return await withWorkspaceProcessLock(workspaceDir(root), BROWSER_LOCK, () => teardownBrowserHeld(root, options), {
      external: true,
      ownerPurpose: 'browser teardown',
    });
  } catch (error) {
    return { status: 'failed', reason: String((error as Error)?.message || error) };
  }
}

/** {@link teardownOwnedBrowser} for a caller that already holds the {@link BROWSER_LOCK} lock. */
export async function teardownBrowserHeld(
  root: string,
  { deleteProfile = false }: { deleteProfile?: boolean } = {},
): Promise<TeardownOutcome> {
  try {
    const record = readWebRecord(root);
    const profile = record?.profile ?? webProfileDir(root);
    if (record) {
      const supervisor = inspectProcessIdentity(record);
      const chrome = record.chromeProcess ? inspectProcessIdentity(record.chromeProcess) : 'gone';
      if (supervisor === 'unknown' || chrome === 'unknown') {
        return {
          status: 'skipped',
          kind: 'not-verified',
          reason: `the browser supervisor (pid ${record.pid}) or its Chrome could not be verified; its record was kept`,
        };
      }
      if (supervisor === 'same') {
        try {
          process.kill(record.pid, 'SIGTERM');
        } catch {}
        if (!(await waitForProcessExit(record, BROWSER_EXIT_WAIT_MS))) {
          return { status: 'failed', reason: `browser supervisor pid ${record.pid} did not exit` };
        }
      }
      if (record.chromeProcess && !(await stopOwnedChrome(record.chromeProcess))) {
        return { status: 'failed', reason: `Chrome pid ${record.chromeProcess.pid} did not exit` };
      }
      const holder = liveProfileHolder(profile);
      if (holder !== null) {
        return {
          status: 'skipped',
          kind: 'not-verified',
          reason: `pid ${holder} still holds ${profile}, and the browser record does not name it; it was left running`,
        };
      }
      const claims = clearFreeClaimSet({ root: webClaimRoot(root), label: 'browser supervisor' });
      if (claims.status !== 'cleared') {
        return {
          status: 'skipped',
          kind: 'not-verified',
          reason: `the browser supervisor claim could not be cleared (${claims.status === 'held' ? 'still held' : claims.reason}); remove it with ${claimRemoveCommand(webClaimRoot(root))}`,
        };
      }
      clearWebRecord(root, record);
      await releaseBrowserPort(root, record.cdpPort);
    } else {
      const holder = liveProfileHolder(profile);
      if (holder !== null) {
        return {
          status: 'skipped',
          kind: 'not-verified',
          reason: `pid ${holder} holds ${profile} but no browser supervisor is recorded; it was left running`,
        };
      }
      const port = getProject(root)?.ports?.[CDP_PORT_LABEL];
      if (typeof port === 'number') await releaseBrowserPort(root, port);
    }
    if (existsSync(profile)) removeSingletonFiles(profile);
    if (deleteProfile && existsSync(profile)) {
      if (!readCreatedDevices().web.has(profile)) {
        return { status: 'skipped', kind: 'not-owned', reason: `${profile} is not in Stim's ledger; it was kept` };
      }
      rmSync(profile, { recursive: true, force: true });
      forgetCreatedDevice('web', profile);
    }
    return record ? { status: 'torn-down', label: `Chrome (${profile})` } : { status: 'missing' };
  } catch (error) {
    return { status: 'failed', reason: String((error as Error)?.message || error) };
  }
}
