import { existsSync } from 'fs';
import { isAbsolute } from 'path';
import chalk from 'chalk';
import { InvalidArgumentError, type Command } from 'commander';
import { loadConfig, removeProject } from '../workspace/config.ts';
import { directorySize, isOnMountedVolume, listMountedVolumes, volumeRootFor } from '../fs-util.ts';
import { listBuildLocks } from '../engine/build-lock.ts';
import { listBuildSlots } from '../engine/build-slots.ts';
import { removeExpiredLease } from '../engine/device-lease.ts';
import { clearFreeClaimSet } from '../ownership-claim.ts';
import { detectIsExpo, findProjectRoot } from '../workspace/project.ts';
import { describeDereferenced, reclaimProject } from '../devices/reclaim.ts';
import { listAllIosSims, type IosSimRecord } from '../devices/ios.ts';
import { parkedMaxSetting, POOL_SETTING_REMEDY } from '../devices/sim-pool.ts';
import { listAvds, listOrphanedAvdDirectories, ownedAvdDirectory } from '../devices/android.ts';
import { discoverCaches, sizeCaches } from '../cache/caches.ts';
import { withEasProjectLock } from '../engine/eas-project-lock.ts';
import type { GcSkip, OrphanedDevice } from './gc/types.ts';
import { recordGcResult, takeGcResults, type GcResult } from './gc/results.ts';
import { emptyCaches, includesWorkspaceOutputs, planCacheEmptying, selectCaches, trimCaches } from './gc/caches.ts';
import {
  collectDeviceLeases,
  collectParkedSims,
  collectParkedAvds,
  deleteParkedAvds,
  deleteParkedSims,
  deleteProjectDevices,
  describeUnverifiableDevices,
  deviceSweepIsScoped,
  DEVICE_LIST_TIMEOUT_MS,
  findOrphanedDevices,
  findStaleDeviceRecords,
  findStaleProjectDevices,
  withAndroidAvdSizes,
  type GcDeviceDependencies,
  type StaleDeviceRecord,
  type StaleProjectDevice,
  type UnverifiedDevice,
} from './gc/devices.ts';
import {
  collectEasSessionSweep,
  deleteEasSessions,
  describeError,
  withRemoteSessionGcLocks,
  type EasGcDependencies,
  type EasSessionSweep,
} from './gc/eas-sessions.ts';
import { formatGcReport, gcReportSections, type GcJsonSections, type GcReport } from './gc/report.ts';
import {
  clearWorkspaceOutputs,
  collectOrphanedWorkspaces,
  collectWorkspaceOutputs,
  deleteOrphanedWorkspaces,
  isInsideWorkspaces,
} from './gc/workspaces.ts';
import { collectWorktreeSweep, removeWorktrees } from './gc/worktrees.ts';
import { collectIdleDevices, parseIdleDuration, shutDownIdleDevices, type IdleDevice } from './gc/idle.ts';
import { workspaceDir } from '../workspace/paths.ts';
import { workspaceLastUsed } from '../workspace/workspace-state.ts';

export { selectCaches } from './gc/caches.ts';
export {
  deleteParkedSims,
  describeParkedSims,
  describeUnverifiableDevices,
  findOrphanedDevices,
  findStaleDeviceRecords,
  findStaleProjectDevices,
  type ParkedSimReport,
} from './gc/devices.ts';
export { formatGcReport } from './gc/report.ts';

interface CollectGcReportOptions {
  olderThan?: number | null;
  cache?: string | null;
  worktrees?: boolean;
  now?: number;
  lastTouched?: (path: string) => number;
}

interface RunGcOptions {
  idle?: number;
  olderThan?: number;
  cache?: string;
  delete?: boolean;
  worktrees?: boolean;
  json?: boolean;
}

interface GcRefusal {
  code: string;
  message: string;
  remedy: string;
}

type GcPayload =
  | {
      mode: 'dry-run' | 'delete';
      idle: number | null;
      cacheScope: string | null;
      olderThan: number | null;
      worktreeSweep: { olderThan: number; defaulted: boolean } | null;
      actionable: boolean;
      failures: number | null;
      sections: GcJsonSections;
      results: GcResult[];
    }
  | GcRefusal;

type GcDependencies = EasGcDependencies & GcDeviceDependencies;

function removeInvalidProjectEntries(invalidProjects: string[]): void {
  for (const path of invalidProjects) {
    removeProject(path);
    console.log(chalk.green(`Removed the invalid registry entry ${path}`));
    recordGcResult('project', 'done', path);
  }
}

export async function collectGcReport(
  {
    olderThan = null,
    cache = null,
    worktrees = false,
    now = Date.now(),
    lastTouched = workspaceLastUsed,
  }: CollectGcReportOptions = {},
  deps: GcDependencies = {},
): Promise<GcReport> {
  const scope = typeof cache === 'string' && cache.trim() ? cache : null;
  const all = scope !== null && olderThan === null;
  const withWorkspaces = includesWorkspaceOutputs(scope);
  const selected = selectCaches(discoverCaches(), scope).filter((c) => !withWorkspaces || !isInsideWorkspaces(c.dir));
  const caches = planCacheEmptying(sizeCaches(selected), all);

  if (scope) {
    return {
      skipped: [],
      deadProjects: [],
      invalidProjects: [],
      orphanedWorkspaces: [],
      orphanedDevices: [],
      unverifiedDevices: [],
      staleDevices: [],
      staleDeviceRecords: [],
      buildLocks: { stale: [], live: [], unresolved: [] },
      buildSlots: { stale: [], live: [], unresolved: [] },
      deviceLeases: { expired: [], kept: [] },
      idleDevices: [],
      deviceSweepNotices: [],
      easSessionSweep: { projectScope: null, orphaned: [], notices: [], deletionSafe: true },
      parkedSims: [],
      parkedAvds: [],
      caches,
      workspaceOutputs: withWorkspaces ? collectWorkspaceOutputs({ olderThan, now }) : null,
      worktreeSweep: null,
      cacheScope: scope,
      olderThan,
      all,
    };
  }

  const mountedVolumes = listMountedVolumes();
  const cfg = loadConfig();
  let easSessionSweep = deps.precollectedEasSessionSweep;
  if (!easSessionSweep) {
    try {
      easSessionSweep = collectEasSessionSweep(cfg, deps);
    } catch (error) {
      easSessionSweep = {
        projectScope: null,
        orphaned: [],
        notices: [`EAS session sweep failed: ${describeError(error)}`],
        deletionSafe: false,
      };
    }
  }
  const parkedSims = collectParkedSims(deps, { olderThanDays: olderThan, now });
  const parkedAvds = collectParkedAvds(deps, { olderThanDays: olderThan, now });
  const deadProjects: string[] = [];
  const invalidProjects: string[] = [];
  const skipped: GcSkip[] = [];
  for (const [path, project] of Object.entries(cfg?.projects || {})) {
    if (!isAbsolute(path)) {
      const claimed = describeDereferenced(project);
      if (claimed.length) {
        skipped.push({
          dir: path,
          reason:
            `not an absolute path, so this record is invalid; kept because it still claims ${claimed.join(' and ')}; ` +
            'gc removes it once that claim is gone, or drop the entry from the config file by hand',
        });
      } else {
        invalidProjects.push(path);
      }
      continue;
    }
    if (existsSync(path)) continue;
    if (!isOnMountedVolume(path, mountedVolumes)) {
      const volume = volumeRootFor(path);
      skipped.push({ dir: path, reason: `volume ${volume} is not mounted` });
    } else {
      deadProjects.push(path);
    }
  }
  const workspaceDirs = collectOrphanedWorkspaces(Object.keys(cfg?.projects ?? {}), mountedVolumes);
  skipped.push(...workspaceDirs.skipped);

  const deviceSweepNotices: string[] = [];
  let orphanedDevices: OrphanedDevice[] = [];
  let unverifiedDevices: UnverifiedDevice[] = [];
  let staleDevices: StaleProjectDevice[] = [];
  let staleDeviceRecords: StaleDeviceRecord[] = [];
  let idleDevices: IdleDevice[] = [];

  const unsweepableReason =
    cfg === null
      ? 'no Stim config found'
      : deviceSweepIsScoped()
        ? 'STIM_HOME scopes this config, but simulators and AVDs are machine-global'
        : null;

  if (unsweepableReason) {
    let simNames: string[] = [];
    let avdNames: string[] = [];
    try {
      simNames = listAllIosSims({ timeoutMs: DEVICE_LIST_TIMEOUT_MS }).map((s) => s.name);
    } catch {}
    try {
      avdNames = listAvds({ timeoutMs: DEVICE_LIST_TIMEOUT_MS });
    } catch {}
    deviceSweepNotices.push(...describeUnverifiableDevices(simNames, avdNames, { reason: unsweepableReason }));
  } else {
    let sims: IosSimRecord[] = [];
    let simsChecked = true;
    try {
      sims = listAllIosSims({ timeoutMs: DEVICE_LIST_TIMEOUT_MS });
    } catch {
      simsChecked = false;
      deviceSweepNotices.push(
        `ios device sweep skipped: simulator tooling did not answer within ${DEVICE_LIST_TIMEOUT_MS / 1000}s`,
      );
    }
    let avds: string[] = [];
    let avdsChecked = true;
    try {
      avds = listAvds({ timeoutMs: DEVICE_LIST_TIMEOUT_MS });
    } catch {
      avdsChecked = false;
      deviceSweepNotices.push(
        `android device sweep skipped: emulator tooling did not answer within ${DEVICE_LIST_TIMEOUT_MS / 1000}s`,
      );
    }

    let orphanedAvdDirectories: ReturnType<typeof listOrphanedAvdDirectories> = [];
    if (avdsChecked) {
      try {
        orphanedAvdDirectories = listOrphanedAvdDirectories();
      } catch (error) {
        avdsChecked = false;
        deviceSweepNotices.push(`android data sweep skipped: ${(error as Error).message}`);
      }
    }
    const registeredAvds = new Set(avds);
    avds = [...new Set([...avds, ...orphanedAvdDirectories.map((entry) => entry.name)])];
    const isMounted = (path: string) => isOnMountedVolume(path, mountedVolumes);
    const found = findOrphanedDevices({
      sims,
      avds,
      config: cfg,
      isMounted,
      deadProjects,
    });
    unverifiedDevices = found.unverified.flatMap((device) => {
      const directories =
        device.kind === 'android' && !registeredAvds.has(device.id)
          ? orphanedAvdDirectories.filter((entry) => entry.name === device.id)
          : [];
      return directories.length
        ? directories.map(({ directory }) => Object.assign({}, device, { directory }))
        : [device];
    });
    orphanedDevices = withAndroidAvdSizes(
      found.orphaned.flatMap((device) => {
        const directories =
          device.kind === 'android' ? orphanedAvdDirectories.filter((entry) => entry.name === device.name) : [];
        return directories.length
          ? directories.map((orphanedDirectory) => Object.assign({}, device, { orphanedDirectory }))
          : [device];
      }),
      {
        avdDirectory: deps.avdDirectory ?? ownedAvdDirectory,
        size: deps.directorySize ?? directorySize,
      },
    );
    idleDevices = collectIdleDevices(cfg, sims, deadProjects, now);
    staleDeviceRecords = findStaleDeviceRecords({
      config: cfg,
      sims,
      avds,
      deadProjects,
      simsChecked,
      avdsChecked,
    });
    if (olderThan !== null) {
      staleDevices = withAndroidAvdSizes(
        findStaleProjectDevices({
          config: cfg,
          sims,
          avds,
          olderThanDays: olderThan,
          now,
          lastTouched,
          deadProjects,
        }),
        {
          avdDirectory: deps.avdDirectory ?? ownedAvdDirectory,
          size: deps.directorySize ?? directorySize,
        },
      );
    }
  }

  const locks = listBuildLocks();
  const slots = listBuildSlots();
  const deviceLeases = collectDeviceLeases(now);

  return {
    skipped,
    deadProjects,
    orphanedPorts: deadProjects.flatMap((project) =>
      Object.entries(cfg?.projects[project]?.ports ?? {}).map(([label, port]) => ({ project, label, port })),
    ),
    invalidProjects,
    orphanedWorkspaces: workspaceDirs.orphaned,
    parkedSims,
    parkedAvds,
    orphanedDevices,
    unverifiedDevices,
    staleDevices,
    staleDeviceRecords,
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
    deviceLeases,
    idleDevices,
    deviceSweepNotices,
    easSessionSweep,
    caches,
    workspaceOutputs: collectWorkspaceOutputs({
      olderThan,
      now,
      exclude: [...workspaceDirs.orphaned.map((entry) => entry.dir), ...deadProjects.map(workspaceDir)],
    }),
    worktreeSweep: collectWorktreeSweep({ idle: worktrees, olderThan, now }),
    cacheScope: null,
    olderThan,
    all,
  };
}

export async function runGc(opts: RunGcOptions = {}, deps: GcDependencies = {}): Promise<void> {
  if (!opts.json) {
    await sweep(opts, deps);
    return;
  }
  const log = console.log;
  console.log = console.error;
  let payload: GcPayload;
  try {
    payload = await sweep(opts, deps);
  } finally {
    console.log = log;
  }
  console.log(JSON.stringify(payload));
}

async function sweep(opts: RunGcOptions, deps: GcDependencies): Promise<GcPayload> {
  if (opts.cache && (opts.worktrees || opts.idle !== undefined)) {
    const flag = opts.worktrees ? '--worktrees' : '--idle';
    const message = opts.worktrees
      ? '--cache acts only on the named caches, and --worktrees sweeps linked worktrees.'
      : '--cache acts only on the named caches, and --idle shuts down idle owned devices.';
    const remedy = `Run \`stim gc ${flag}${opts.worktrees ? '' : ' <duration>'}\` and \`stim gc --cache <name>\` separately.`;
    console.error(chalk.red(message));
    console.error(chalk.dim(remedy));
    console.error(chalk.red('failed: STIM_BAD_ARG'));
    process.exitCode = 1;
    return { code: 'STIM_BAD_ARG', message, remedy };
  }
  const poolError = parkedMaxSetting('ios').error || parkedMaxSetting('android').error;
  if (poolError) {
    console.error(chalk.yellow(`${poolError} ${POOL_SETTING_REMEDY}`));
  }
  if (opts.cache) {
    return runGcCore(opts, {
      ...deps,
      precollectedEasSessionSweep: { projectScope: null, orphaned: [], notices: [], deletionSafe: true },
    });
  }
  let projectRoot: string | null = null;
  try {
    projectRoot = (deps.findProjectRoot ?? findProjectRoot)(process.cwd());
    if (!projectRoot) {
      return runGcCore(opts, {
        ...deps,
        precollectedEasSessionSweep: {
          projectScope: null,
          orphaned: [],
          notices: ['EAS session sweep skipped: no current project was available before EAS project lock acquisition.'],
          deletionSafe: false,
        },
      });
    }
    if (!(deps.detectIsExpo ?? detectIsExpo)(projectRoot)) {
      return runGcCore(opts, {
        ...deps,
        precollectedEasSessionSweep: {
          projectScope: projectRoot,
          orphaned: [],
          notices: [],
          deletionSafe: true,
        },
      });
    }
  } catch (error) {
    return runGcCore(opts, {
      ...deps,
      precollectedEasSessionSweep: {
        projectScope: projectRoot,
        orphaned: [],
        notices: [
          `EAS session sweep skipped: project classification failed before EAS project lock acquisition: ${describeError(error)}`,
        ],
        deletionSafe: false,
      },
    });
  }
  const withProjectLock = deps.withEasProjectLock ?? withEasProjectLock;
  let sweepStarted = false;
  let easSessionSweep: EasSessionSweep;
  try {
    easSessionSweep = await withProjectLock(
      projectRoot,
      () => {
        sweepStarted = true;
        return withRemoteSessionGcLocks(projectRoot, deps, (coordinatedDeps) =>
          Promise.resolve(collectEasSessionSweep(loadConfig(), coordinatedDeps)),
        );
      },
      { waitMs: 0, ownerPurpose: 'EAS orphan sweep', machineRoot: deps.easLedgerRoot },
    );
  } catch (error) {
    const failure = sweepStarted ? 'EAS collection failed' : 'EAS project lock acquisition failed';
    easSessionSweep = {
      projectScope: projectRoot,
      orphaned: [],
      notices: [`EAS session sweep skipped: ${failure}: ${describeError(error)}`],
      deletionSafe: false,
    };
  }
  return runGcCore(opts, { ...deps, precollectedEasSessionSweep: easSessionSweep });
}

async function pruneDeadProjects(deadProjects: string[]): Promise<number> {
  let deleteFailures = 0;
  for (const path of deadProjects) {
    if (existsSync(path) || !isOnMountedVolume(path)) {
      console.log(chalk.yellow(`Kept ${path}: its absence can no longer be confirmed.`));
      recordGcResult('project', 'kept', path, { detail: 'its absence can no longer be confirmed' });
      continue;
    }
    const result = await reclaimProject(path).catch((error: unknown) => {
      deleteFailures++;
      console.log(chalk.red(`Could not prune ${path}; its registry entry was kept: ${(error as Error).message}`));
      recordGcResult('project', 'failed', path, { detail: `its registry entry was kept: ${(error as Error).message}` });
      return null;
    });
    if (!result) continue;
    if (result.keptEntry) {
      console.log(chalk.yellow(`Could not fully prune ${path}; its registry entry was kept.`));
      recordGcResult('project', 'kept', path, { detail: 'it could not be fully pruned; its registry entry was kept' });
    } else {
      console.log(chalk.green(`Pruned ${path}`));
      recordGcResult('project', 'done', path);
    }
    for (const dir of result.removedWorkspaceDirs) console.log(chalk.dim(`  removed workspace output ${dir}`));
    for (const dir of result.failedWorkspaceDirs) {
      console.log(chalk.red(`  could not remove workspace output ${dir}`));
      recordGcResult('workspaceDirectory', 'failed', dir, { detail: `could not remove it while pruning ${path}` });
      deleteFailures += 1;
    }
    if (result.killedPid) {
      console.log(chalk.dim(`  killed orphaned Metro pid ${result.killedPid}`));
    }
    if (result.stoppedSession) {
      console.log(chalk.dim(`  stopped remote session ${result.stoppedSession}`));
    }
    if (result.stoppedTunnel) {
      console.log(chalk.dim(`  stopped ${result.stoppedTunnel} tunnel`));
    }
    for (const name of result.deletedDevices) recordGcResult('device', 'done', name);
    for (const s of result.skippedDevices) {
      console.log(chalk.yellow(`  ${s.name}: ${s.reason}`));
      recordGcResult('device', result.failedDevices.includes(s) ? 'failed' : 'kept', s.name, {
        id: s.udid ?? null,
        detail: s.reason,
      });
    }
    deleteFailures += result.failedDevices.length;
  }
  return deleteFailures;
}

async function runGcCore(opts: RunGcOptions, deps: GcDependencies): Promise<GcPayload> {
  takeGcResults();
  const olderThan = typeof opts.olderThan === 'number' ? opts.olderThan : null;
  const cache = typeof opts.cache === 'string' && opts.cache.trim() ? opts.cache : null;
  const report = await collectGcReport(
    {
      olderThan,
      cache,
      worktrees: Boolean(opts.worktrees),
    },
    deps,
  );
  if (cache && report.caches.length === 0 && report.workspaceOutputs === null) {
    const names = [...new Set(discoverCaches().map((c) => c.name))];
    const message = `No shared cache carries "${cache}" in its name or directory.`;
    console.log(chalk.yellow(message));
    if (names.length) console.log(chalk.dim(`Caches on this machine: ${names.join(', ')}`));
    if (opts.json) process.exitCode = 1;
    return {
      code: 'STIM_BAD_ARG',
      message,
      remedy: names.length
        ? `Pass --cache all or a name from: ${names.join(', ')}.`
        : 'No shared cache was found on this machine.',
    };
  }

  const all = report.all;

  for (const line of formatGcReport(report)) console.log(line);

  const {
    deadProjects,
    invalidProjects,
    orphanedDevices,
    staleDevices,
    staleDeviceRecords,
    buildLocks,
    buildSlots,
    deviceLeases,
    easSessionSweep,
    caches,
  } = report;
  const actionable =
    deadProjects.length + invalidProjects.length > 0 ||
    report.orphanedWorkspaces.length > 0 ||
    Boolean(report.workspaceOutputs?.workspaces.some((entry) => entry.willClear)) ||
    Boolean(report.worktreeSweep?.worktrees.some((entry) => !entry.skipped)) ||
    report.parkedSims.length > 0 ||
    report.parkedAvds.length > 0 ||
    orphanedDevices.length > 0 ||
    staleDevices.length > 0 ||
    staleDeviceRecords.length > 0 ||
    buildLocks.stale.length > 0 ||
    buildSlots.stale.length > 0 ||
    deviceLeases.expired.length > 0 ||
    easSessionSweep.orphaned.length > 0 ||
    ((olderThan !== null || all) && caches.length > 0);
  const idle = opts.idle ?? null;
  const idleFailures =
    idle === null
      ? 0
      : shutDownIdleDevices(report.idleDevices, idle, () =>
          collectIdleDevices(loadConfig(), listAllIosSims({ timeoutMs: DEVICE_LIST_TIMEOUT_MS }), report.deadProjects),
        ).failures;
  if (idleFailures) process.exitCode = 1;
  const payload = (failures: number | null): GcPayload => ({
    mode: opts.delete ? 'delete' : 'dry-run',
    idle,
    cacheScope: report.cacheScope,
    olderThan,
    worktreeSweep: report.worktreeSweep?.idle ?? null,
    actionable,
    failures,
    sections: gcReportSections(report),
    results: takeGcResults(),
  });

  if (!opts.delete) {
    if (all) console.log(chalk.dim('\nDry run. Re-run with --delete to empty the caches above.'));
    else if (actionable) console.log(chalk.dim('\nDry run. Re-run with --delete to reclaim.'));
    else if (caches.length) {
      console.log(
        chalk.dim(
          '\nPass --delete --cache all to empty the caches above, or --delete --older-than <days> to trim them.',
        ),
      );
    }
    return payload(idle === null ? null : idleFailures);
  }

  let deleteFailures = idleFailures;
  deleteFailures += report.workspaceOutputs
    ? (await clearWorkspaceOutputs(report.workspaceOutputs, { olderThan })).failures
    : 0;
  deleteFailures += deleteParkedSims(report.parkedSims, deps) + deleteParkedAvds(report.parkedAvds);

  removeInvalidProjectEntries(invalidProjects);

  deleteFailures += await pruneDeadProjects(deadProjects);

  deleteFailures += await deleteOrphanedWorkspaces(report.orphanedWorkspaces);

  deleteFailures += deleteProjectDevices(orphanedDevices, staleDevices, staleDeviceRecords);

  for (const lock of buildLocks.stale) {
    const cleared = clearFreeClaimSet({ root: lock.path, label: `${lock.platform} build` });
    if (cleared.status === 'held') continue;
    if (cleared.status === 'refused') {
      console.log(chalk.yellow(`Left the build lock at ${lock.path} alone: ${cleared.reason}`));
      recordGcResult('buildLock', 'kept', `${lock.platform} build lock`, { id: lock.path, detail: cleared.reason });
      continue;
    }
    if (cleared.status === 'failed') {
      deleteFailures++;
      console.log(chalk.red(`Failed to clear the build lock at ${lock.path}: ${cleared.reason}`));
      recordGcResult('buildLock', 'failed', `${lock.platform} build lock`, { id: lock.path, detail: cleared.reason });
      continue;
    }
    recordGcResult('buildLock', 'done', `${lock.platform} build lock`, { id: lock.path });
    console.log(
      chalk.green(
        `Cleared the ${lock.platform} build lock left by pid ${lock.pid ?? '?'} (${lock.projectRoot || 'unrecorded workspace'})`,
      ),
    );
  }

  for (const slot of buildSlots.stale) {
    const cleared = clearFreeClaimSet({ root: slot.path, label: 'build slot' });
    if (cleared.status === 'held') continue;
    if (cleared.status === 'refused') {
      console.log(chalk.yellow(`Left the build slot at ${slot.path} alone: ${cleared.reason}`));
      recordGcResult('buildSlot', 'kept', `build slot ${slot.index ?? '?'}`, { id: slot.path, detail: cleared.reason });
      continue;
    }
    if (cleared.status === 'failed') {
      deleteFailures++;
      console.log(chalk.red(`Failed to clear the build slot at ${slot.path}: ${cleared.reason}`));
      recordGcResult('buildSlot', 'failed', `build slot ${slot.index ?? '?'}`, {
        id: slot.path,
        detail: cleared.reason,
      });
      continue;
    }
    recordGcResult('buildSlot', 'done', `build slot ${slot.index ?? '?'}`, { id: slot.path });
    console.log(
      chalk.green(
        `Cleared build slot ${slot.index ?? '?'} left by pid ${slot.pid ?? '?'} (${slot.projectRoot || 'unrecorded workspace'})`,
      ),
    );
  }

  for (const entry of deviceLeases.expired) {
    try {
      if (removeExpiredLease(entry)) {
        recordGcResult('deviceLease', 'done', `${entry.platform} lease on ${entry.id ?? entry.name}`, {
          id: entry.path,
        });
        console.log(
          chalk.green(
            `Cleared the expired ${entry.platform} device lease on ${entry.id ?? entry.name} (held by ${entry.lease?.holder ?? 'an unrecorded workspace'})`,
          ),
        );
      } else {
        console.log(chalk.dim(`${entry.name} is no longer an expired lease; left alone.`));
      }
    } catch (err) {
      deleteFailures++;
      console.log(chalk.red(`Failed to clear the device lease at ${entry.path}: ${(err as Error)?.message || err}`));
      recordGcResult('deviceLease', 'failed', `${entry.platform} lease on ${entry.id ?? entry.name}`, {
        id: entry.path,
        detail: (err as Error)?.message || String(err),
      });
    }
  }
  deleteFailures += await deleteEasSessions(easSessionSweep, deps);
  if (report.worktreeSweep) deleteFailures += await removeWorktrees(report.worktreeSweep);

  if (deleteFailures) {
    console.log(
      chalk.red(`\n${deleteFailures} entr${deleteFailures === 1 ? 'y' : 'ies'} could not be deleted; see above.`),
    );
    process.exitCode = 1;
  }

  if (all) {
    emptyCaches(caches);
  } else if (olderThan === null) {
    if (caches.length) {
      console.log(
        chalk.dim('Shared caches left alone: pass --cache all to empty them, or --older-than <days> to trim them.'),
      );
    }
  } else {
    trimCaches(caches, olderThan);
  }
  return payload(deleteFailures);
}

export default function gcCommand(program: Command): void {
  program
    .command('gc')
    .description(
      'Report what Stim has left behind: dead project entries, orphaned workspace directories, clean Stim-managed linked worktrees whose branch is merged or whose pull request was merged or closed, orphaned owned devices and EAS sessions, records of devices that no longer exist, build locks whose builder is gone, expired physical-device leases, the shared build caches, and the build outputs of each workspace. Reports by default; pass --delete to act.',
    )
    .option(
      '--worktrees',
      'also remove clean, idle Stim-managed linked worktrees, not only merged ones: with --delete run `stim worktree remove` (never --force) on each; idle means unused for --older-than days, 7 without it',
    )
    .option(
      '--delete',
      'actually prune the reported entries, reap the reported devices, and clear the build outputs of every workspace not in use',
    )
    .option(
      '--older-than <days>',
      'also reap owned devices whose workspace has not been used this long, trim shared cache entries nothing has used in that time, and clear workspace build outputs only for workspaces idle this long and parked devices only once parked this long',
      (v: string) => {
        const n = parseInt(v, 10);
        if (!Number.isFinite(n) || String(n) !== String(v).trim()) {
          throw new InvalidArgumentError('must be a whole number of days, e.g. --older-than 30');
        }
        return n;
      },
    )
    .option(
      '--cache <name>',
      'act on the shared caches whose name or directory contains <name>, every cache and the workspace build outputs with --cache all, or only the workspace build outputs with --cache workspaces; all and workspaces are reserved names that never select a single cache. With --delete they are emptied whole, which is the only way to clear an index-backed cache; add --older-than <days> to trim them by age instead. Only those caches are reported; devices and project entries are not inspected. Caches outside the config dir are refused while STIM_HOME is set.',
      (v: string) => {
        if (!v.trim()) throw new InvalidArgumentError('must name a cache, e.g. --cache "compilation cache"');
        return v;
      },
    )
    .option(
      '--idle <duration>',
      'shut down (never delete) owned simulators and emulators that have had no driver, claim, or activity for at least <duration>, such as 30m, 2h, or 1d; acts without --delete',
      (v: string) => {
        const ms = parseIdleDuration(v);
        if (ms === null)
          throw new InvalidArgumentError('must be a whole number of minutes, hours, or days, e.g. --idle 2h');
        return ms;
      },
    )
    .option('--json', 'print the report as JSON on stdout; every other line goes to stderr')
    .action(async (opts: RunGcOptions) => {
      await runGc(opts);
    });
}
