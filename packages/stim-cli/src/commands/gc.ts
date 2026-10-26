import { throwIfCancelled } from '../cancellation.ts';
import { runProcessOperation } from '../cli-operation.ts';
import { withDrainingCancellation } from '../engine/operation-state.ts';
import type { StimContext } from '@stim-cli/core';
import { WorkspaceProcessCleanupError } from '../engine/workspace-process-lock.ts';
import { declareSpawnsOn, stopDeclaringSpawnsOn } from '../engine/spawn-claims.ts';
import { maintenanceRunClaims } from '@stim-cli/core/state';
import { previewMaintenance, type MaintenancePreview } from '../maintenance/preview.ts';
import { collectArchives, deleteArchives, archiveRefusal, archiveWorkPending } from './gc/archives.ts';
import { getSwiftpmCacheUsage } from '../devices/swiftpm-cache-usage.ts';
import { getAgentDeviceUsage } from '../devices/agent-device-usage.ts';
import { getMachineCacheReport } from '../devices/machine-cache-usage.ts';
import {
  collectGradleVersions,
  deleteGradleVersions,
  gradleVersionsPending,
  includesGradleVersions,
} from './gc/gradle-versions.ts';
import { existsSync } from 'fs';
import { isAbsolute } from 'path';
import chalk from 'chalk';
import { InvalidArgumentError, type Command } from 'commander';
import { loadConfig, removeProject, withConfigLockAsync } from '../workspace/config.ts';
import { plural, quotedPath } from '../command-output.ts';
import { directorySizeAsync, isOnMountedVolume, listMountedVolumes, volumeRootFor } from '../fs-util.ts';
import { listBuildLocks } from '../engine/build-lock.ts';
import { listBuildSlots } from '../engine/build-slots.ts';
import { removeExpiredLease } from '../engine/device-lease.ts';
import {
  ClaimRefusedError,
  claimFailure,
  tryAcquireClaim,
  releaseClaim,
  clearFreeClaimSet,
  type ClaimHandle,
} from '../ownership-claim.ts';
import { detectIsExpo, findProjectRoot } from '../workspace/project.ts';
import { describeDereferenced, reclaimProject } from '../devices/reclaim.ts';
import { listAllIosSims, listAllIosSimsAsync, type IosSimRecord } from '../devices/ios.ts';
import { parkedMaxSetting, POOL_SETTING_REMEDY } from '../devices/sim-pool.ts';
import { listAvdsAsync, listOrphanedAvdDirectories, ownedAvdDirectory } from '../devices/android.ts';
import { discoverCaches, sizeCaches } from '../cache/caches.ts';
import { withEasProjectLock } from '../engine/eas-project-lock.ts';
import type { StimConfig } from '@stim-cli/core/state';
import type { GcSkip, OrphanedDevice } from './gc/types.ts';
import { gcOptionsOf, openGcLog } from './gc/log.ts';
import { createGcResults, GC_OUTPUT, type GcOutput, type GcResult } from './gc/results.ts';
import { phase } from './gc/progress.ts';
import {
  emptyCaches,
  includesArchives,
  includesParkedDevices,
  includesRecordings,
  includesWorkspaceOutputs,
  isWorkspacesScope,
  planCacheEmptying,
  previewScopedEmptying,
  selectCaches,
  selectsBeyondCaches,
  trimCaches,
} from './gc/caches.ts';
import {
  collectDeviceLeases,
  collectParkedSims,
  collectParkedAvds,
  deleteParkedAvds,
  deleteParkedSims,
  eraseParkedDevices,
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
import { findStaleEasLedgerEntries, forgetStaleEasLedgerEntries } from './gc/eas-ledger.ts';
import {
  collectEasSessionSweep,
  deleteEasSessions,
  describeError,
  withRemoteSessionGcLocks,
  type EasGcDependencies,
  type EasSessionSweep,
} from './gc/eas-sessions.ts';
import { formatGcReport, gcReportSections, type GcJsonSections, type GcReport } from './gc/report.ts';
import { collectWorktreeDependencies, lightenWorktreeDependencies } from './gc/dependencies.ts';
import {
  clearWorkspaceOutputs,
  collectOrphanedWorkspaces,
  collectWorkspaceOutputs,
  deleteOrphanedWorkspaces,
  isInsideWorkspaces,
} from './gc/workspaces.ts';
import { collectWorktreeSweep, removeWorktrees } from './gc/worktrees.ts';
import { measureWorktreeSweep } from './gc/worktree-sizes.ts';
import { collectStaleStatusCaches, deleteStaleStatusCaches } from './gc/status-caches.ts';
import {
  findStaleAndroidLedgerEntries,
  findStaleLedgerEntries,
  forgetStaleLedgerEntries,
  staleBrowserProfiles,
  type StaleLedgerEntry,
} from './gc/ledger.ts';
import { readCreatedDevices } from '../devices/created-devices.ts';
import { collectWorkspaceLogs, trimWorkspaceLogs } from './gc/logs.ts';
import { collectRecordings, deleteRecordings } from './gc/recordings.ts';
import { collectTempLeftovers, deleteTempLeftovers } from './gc/temp-leftovers.ts';
import { collectTrash, deleteTrash } from './gc/trash.ts';
import {
  collectIdleDevices,
  collectIdleDevicesAsync,
  parseIdleDuration,
  shutDownIdleDevices,
  type IdleDevice,
} from './gc/idle.ts';
import { workspaceDir } from '../workspace/paths.ts';
import { workspaceLastUsed } from '../workspace/workspace-state.ts';
import { collectInventory, type GcInventory } from './gc/inventory.ts';
import { collectParkedHostedDevices, deleteParkedHostedDevices } from './gc/hosted-devices.ts';
import { collectFinishedDevices, deleteFinishedDevices, ownedDeviceDisk } from './gc/finished-devices.ts';
import { ownedDeviceUsage } from '../maintenance/devices.ts';
import { stopIdleWorkspaces } from './gc/idle-workspaces.ts';
import {
  collectMemoryReport,
  GRADLE_DAEMONS_KIND,
  memoryCacheKind,
  memoryScope,
  memorySweepIsScoped,
  memoryWorkPending,
  reclaimMemory,
  scopedMemoryReport,
  type MemoryReport,
  type MemoryScope,
  WATCHMAN_KIND,
} from './gc/memory.ts';

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
  refresh?: boolean;
  measureBuildState?: boolean;
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
  /** False reports worktree build-state sizes only from the disk-usage cache: a stale one is unmeasured (null), and no `du` runs for it. */
  measureBuildState?: boolean;
}

interface GcRefusal {
  code: string;
  message: string;
  remedy: string;
}

export type GcPayload =
  | {
      mode: 'dry-run' | 'delete';
      idle: number | null;
      cacheScope: string | null;
      olderThan: number | null;
      worktreeSweep: { olderThan: number; defaulted: boolean } | null;
      actionable: boolean;
      failures: number | null;
      sections: GcJsonSections;
      maintenance?: MaintenancePreview;
      results: GcResult[];
      inventory: GcInventory | null;
    }
  | GcRefusal;

type GcDependencies = EasGcDependencies & GcDeviceDependencies;

interface GcExecution {
  output: GcOutput;
  takeResults: () => GcResult[];
}

export type GcMutationOptions = Omit<RunGcOptions, 'json'>;

export interface GcExecutionResult {
  payload: GcPayload;
  exitCode: 0 | 1;
}

export type GcReadOptions = Pick<RunGcOptions, 'olderThan' | 'cache' | 'worktrees' | 'measureBuildState'>;

export function readGcReport(options: GcReadOptions = {}, deps: GcDependencies = {}): Promise<GcPayload> {
  return sweep(
    {
      olderThan: options.olderThan,
      cache: options.cache,
      worktrees: options.worktrees,
      measureBuildState: options.measureBuildState,
      json: true,
    },
    deps,
    { output: GC_OUTPUT, takeResults: () => [] },
    true,
  );
}

async function removeInvalidProjectEntries(
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

function collectGcMemory(scope: MemoryScope, env: NodeJS.ProcessEnv, operation?: StimContext): Promise<MemoryReport> {
  return memorySweepIsScoped(env) ? Promise.resolve(scopedMemoryReport()) : collectMemoryReport(scope, true, operation);
}

function classifyProjectEntries(
  cfg: StimConfig | null,
  mountedVolumes: string[],
): { deadProjects: string[]; invalidProjects: string[]; skipped: GcSkip[] } {
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
  return { deadProjects, invalidProjects, skipped };
}

/** The workspace directories an unscoped run removes whole: those of dead projects and orphaned directories. */
async function removedWholeWorkspaceDirs(operation?: StimContext): Promise<string[]> {
  const mountedVolumes = listMountedVolumes();
  const cfg = loadConfig();
  const { deadProjects } = classifyProjectEntries(cfg, mountedVolumes);
  const { orphaned } = await collectOrphanedWorkspaces(Object.keys(cfg?.projects ?? {}), mountedVolumes, {
    measure: false,
    operation,
  });
  return [...orphaned.map((entry) => entry.dir), ...deadProjects.map(workspaceDir)];
}

export async function collectGcReport(
  {
    olderThan = null,
    cache = null,
    worktrees = false,
    refresh = true,
    measureBuildState = true,
    now = Date.now(),
    lastTouched = workspaceLastUsed,
  }: CollectGcReportOptions = {},
  deps: GcDependencies = {},
): Promise<GcReport> {
  const operation = deps.operation;
  const env = operation?.env ?? process.env;
  const scope = typeof cache === 'string' && cache.trim() ? cache : null;
  const all = scope !== null && olderThan === null;
  const withWorkspaces = includesWorkspaceOutputs(scope);
  const selected = selectCaches(discoverCaches(env, operation?.cwd), scope).filter(
    (c) => !withWorkspaces || !isInsideWorkspaces(c.dir),
  );
  if (selected.length) phase('caches', `measuring ${plural(selected.length, 'shared cache')}`, operation);
  const sized = await sizeCaches(selected, operation);
  const caches = scope === null ? previewScopedEmptying(sized, env) : planCacheEmptying(sized, all, env);

  if (scope) {
    return {
      archives: includesArchives(scope) ? await collectArchives(scope, olderThan, now, operation?.signal) : undefined,
      skipped: [],
      deadProjects: [],
      invalidProjects: [],
      orphanedWorkspaces: [],
      orphanedDevices: [],
      unverifiedDevices: [],
      staleDevices: [],
      finishedDevices: [],
      ownedDeviceDisk: [],
      staleDeviceRecords: [],
      staleLedgerEntries: [],
      staleEasLedgerEntries: [],
      staleStatusCaches: [],
      buildLocks: { stale: [], live: [], unresolved: [] },
      buildSlots: { stale: [], live: [], unresolved: [] },
      deviceLeases: { expired: [], kept: [] },
      idleDevices: [],
      deviceSweepNotices: [],
      easSessionSweep: { projectScope: null, orphaned: [], notices: [], deletionSafe: true },
      parkedSims: includesParkedDevices(scope) ? await collectParkedSims(deps, { olderThanDays: olderThan, now }) : [],
      parkedAvds: includesParkedDevices(scope) ? await collectParkedAvds(deps, { olderThanDays: olderThan, now }) : [],
      parkedHostedDevices: [],
      caches,
      workspaceOutputs: withWorkspaces
        ? await collectWorkspaceOutputs({
            olderThan,
            now,
            exclude: isWorkspacesScope(scope) ? await removedWholeWorkspaceDirs(operation) : [],
            signal: operation?.signal,
            operation,
            lighten: true,
          })
        : null,
      workspaceLogs: [],
      recordings: includesRecordings(scope)
        ? await collectRecordings({ whole: all, olderThan, now }, [], operation?.signal)
        : [],
      worktreeSweep: null,
      memory: memoryCacheKind(scope) ? await collectGcMemory(memoryScope(scope)!, env, operation) : null,
      agentDeviceUsage: null,
      swiftpmCacheUsage: null,
      machineCaches: null,
      tempLeftovers: null,
      trash: null,
      gradleVersions: includesGradleVersions(scope)
        ? await collectGradleVersions({ olderThanDays: olderThan, now, operation })
        : null,
      cacheScope: scope,
      olderThan,
      all,
    };
  }

  phase('agent-device', 'measuring report-only state', operation);
  const agentDeviceUsage = await getAgentDeviceUsage({ operation });
  phase('SwiftPM cache', 'measuring report-only state', operation);
  const swiftpmCacheUsage = await getSwiftpmCacheUsage({ operation });
  phase('machine caches', 'measuring report-only state', operation);
  const machineCaches = await getMachineCacheReport(agentDeviceUsage, { operation });
  if (!deviceSweepIsScoped(env)) phase('TMPDIR', 'checking recognized leftovers', operation);
  const tempLeftovers = await collectTempLeftovers({ now, env, signal: operation?.signal, operation });
  phase('trash', 'measuring worktree trash', operation);
  const trash = await collectTrash({ signal: operation?.signal, operation });
  const mountedVolumes = listMountedVolumes();
  const cfg = loadConfig();
  let easSessionSweep = deps.precollectedEasSessionSweep;
  if (!easSessionSweep) {
    try {
      easSessionSweep = await collectEasSessionSweep(cfg, deps);
    } catch (error) {
      if (error instanceof WorkspaceProcessCleanupError) throw error;
      operation?.signal.throwIfAborted();
      easSessionSweep = {
        projectScope: null,
        orphaned: [],
        notices: [`EAS session sweep failed: ${describeError(error)}`],
        deletionSafe: false,
      };
    }
  }
  const parkedSims = await collectParkedSims(deps, { olderThanDays: olderThan, now });
  const parkedAvds = await collectParkedAvds(deps, { olderThanDays: olderThan, now });
  const { deadProjects, invalidProjects, skipped } = classifyProjectEntries(cfg, mountedVolumes);
  const workspaceDirs = await collectOrphanedWorkspaces(Object.keys(cfg?.projects ?? {}), mountedVolumes, {
    operation,
  });
  skipped.push(...workspaceDirs.skipped);
  const statusCaches = collectStaleStatusCaches(mountedVolumes);
  skipped.push(...statusCaches.skipped);

  const hosted = collectParkedHostedDevices({ olderThanDays: olderThan, now });
  const deviceSweepNotices: string[] = [...hosted.notices];
  let orphanedDevices: OrphanedDevice[] = [];
  let unverifiedDevices: UnverifiedDevice[] = [];
  let staleDevices: StaleProjectDevice[] = [];
  let staleDeviceRecords: StaleDeviceRecord[] = [];
  let staleLedgerEntries: StaleLedgerEntry[] = staleBrowserProfiles(readCreatedDevices());
  let idleDevices: IdleDevice[] = [];
  let listed: { sims: IosSimRecord[]; avds: string[] } | null = null;
  let deviceDisk: GcReport['ownedDeviceDisk'] = [];
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

  phase('devices', 'listing simulators and emulators', operation);
  if (unsweepableReason) {
    let simNames: string[] = [];
    let avdNames: string[] = [];
    try {
      simNames = (
        await listAllIosSimsAsync({ timeoutMs: DEVICE_LIST_TIMEOUT_MS, operation, signal: operation?.signal })
      ).map((s) => s.name);
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
    deviceSweepNotices.push(...describeUnverifiableDevices(simNames, avdNames, { reason: unsweepableReason }));
  } else {
    let sims: IosSimRecord[] = [];
    let simsChecked = true;
    const ledger = readCreatedDevices();
    try {
      const allSims = await listAllIosSimsAsync({
        timeoutMs: DEVICE_LIST_TIMEOUT_MS,
        includeUnavailable: true,
        operation,
        signal: operation?.signal,
      });
      staleLedgerEntries = [...staleLedgerEntries, ...findStaleLedgerEntries(ledger, allSims)];
      sims = allSims.filter((sim) => sim.available);
    } catch (error) {
      if (error instanceof WorkspaceProcessCleanupError) throw error;
      operation?.signal.throwIfAborted();
      simsChecked = false;
      deviceSweepNotices.push(
        `ios device sweep skipped: simulator tooling did not answer within ${DEVICE_LIST_TIMEOUT_MS / 1000}s`,
      );
    }
    let avds: string[] = [];
    let avdsChecked = true;
    try {
      avds = await listAvdsAsync({ timeoutMs: DEVICE_LIST_TIMEOUT_MS, operation, signal: operation?.signal });
    } catch (error) {
      if (error instanceof WorkspaceProcessCleanupError) throw error;
      operation?.signal.throwIfAborted();
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
    if (avdsChecked) {
      staleLedgerEntries = [...staleLedgerEntries, ...findStaleAndroidLedgerEntries(ledger, avds, loadConfig())];
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
    orphanedDevices = await withAndroidAvdSizes(
      found.orphaned.flatMap((device) => {
        const directories =
          device.kind === 'android' ? orphanedAvdDirectories.filter((entry) => entry.name === device.name) : [];
        return directories.length
          ? directories.map((orphanedDirectory) => Object.assign({}, device, { orphanedDirectory }))
          : [device];
      }),
      {
        avdDirectory: deps.avdDirectory ?? ownedAvdDirectory,
        size: avdSize,
        operation,
      },
    );
    idleDevices = operation
      ? await collectIdleDevicesAsync(cfg, sims, deadProjects, now, env, operation.signal, operation)
      : collectIdleDevices(cfg, sims, deadProjects, now);
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
    staleDeviceRecords = findStaleDeviceRecords({
      config: cfg,
      sims,
      avds,
      deadProjects,
      simsChecked,
      avdsChecked,
    });
    if (olderThan !== null) {
      staleDevices = await withAndroidAvdSizes(
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
          size: avdSize,
          operation,
        },
      );
    }
  }

  const locks = listBuildLocks();
  const slots = listBuildSlots();
  const goneWorkspaceDirs = [...workspaceDirs.orphaned.map((entry) => entry.dir), ...deadProjects.map(workspaceDir)];
  const deviceLeases = collectDeviceLeases(now);
  const worktreeSweep = await measureWorktreeSweep(
    await collectWorktreeSweep({ idle: worktrees, olderThan, now, refresh, operation }),
    operation,
    measureBuildState,
  );

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
    parkedHostedDevices: hosted.devices,
    orphanedDevices,
    unverifiedDevices,
    staleDevices,
    staleDeviceRecords,
    staleLedgerEntries,
    staleEasLedgerEntries: findStaleEasLedgerEntries(mountedVolumes, deps),
    staleStatusCaches: statusCaches.stale,
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
    workspaceOutputs: await collectWorkspaceOutputs({
      olderThan,
      now,
      exclude: goneWorkspaceDirs,
      signal: operation?.signal,
      operation,
      lighten: true,
    }),
    worktreeDependencies: await collectWorktreeDependencies({ now, operation }),
    workspaceLogs: await collectWorkspaceLogs({ exclude: goneWorkspaceDirs, operation }),
    recordings: await collectRecordings({ whole: false, olderThan, now }, goneWorkspaceDirs, operation?.signal),
    worktreeSweep,
    finishedDevices: listed ? collectFinishedDevices({ config: cfg, ...listed, sweep: worktreeSweep, now }) : [],
    ownedDeviceDisk: deviceDisk,
    memory: await collectGcMemory({ watchman: true, gradle: true }, env, operation),
    agentDeviceUsage,
    swiftpmCacheUsage,
    machineCaches,
    tempLeftovers,
    trash,
    cacheScope: null,
    olderThan,
    all,
  };
}

const shellWord = (value: string) => (/^[\w.:-]+$/.test(value) ? value : quotedPath(value));

function gcRetryCommand(opts: RunGcOptions): string {
  return [
    'stim gc',
    opts.delete && '--delete',
    opts.worktrees && '--worktrees',
    opts.olderThan !== undefined && `--older-than ${opts.olderThan}`,
    opts.cache !== undefined && `--cache ${shellWord(opts.cache)}`,
    opts.idle !== undefined && `--idle ${opts.idle / 60_000}m`,
    opts.json && '--json',
  ]
    .filter(Boolean)
    .join(' ');
}

export async function runGc(opts: RunGcOptions = {}, deps: GcDependencies = {}): Promise<void> {
  let result: GcExecutionResult;
  try {
    result = await withGcMaintenanceClaim(opts, (claim) =>
      executeGc(
        opts,
        deps,
        (stream, line) => {
          if (stream === 'stderr' || opts.json) console.error(line);
          else console.log(line);
        },
        claim,
      ),
    );
  } catch (error) {
    const failure =
      claimFailure(error, gcRetryCommand(opts)) ??
      (deps.operation?.signal.aborted
        ? { code: 'STIM_CANCELLED', message: 'GC was cancelled.', remedy: 'Retry the same GC command.' }
        : null);
    if (!failure) throw error;
    console.error(`${failure.code}: ${failure.message}`);
    console.error(failure.remedy);
    result = { payload: failure, exitCode: 1 };
  }
  if (result.exitCode) process.exitCode = result.exitCode;
  if (opts.json) console.log(JSON.stringify(result.payload));
}

/** Runs GC under this home's exclusive maintenance claim, retaining it when owned cleanup is unresolved. */
export async function withGcMaintenanceClaim<T>(
  opts: GcMutationOptions,
  work: (claim: ClaimHandle | undefined) => Promise<T>,
): Promise<T> {
  if (!opts.delete && opts.idle === undefined) return work(undefined);
  let claim: ClaimHandle | undefined;
  let retained = false;
  try {
    const root = maintenanceRunClaims();
    const attempt = tryAcquireClaim({
      root,
      mode: 'exclusive',
      label: 'maintenance',
      details: { trigger: opts.delete ? 'gc --delete' : 'gc --idle' },
    });
    if (attempt.pending) releaseClaim(attempt.pending);
    claim = attempt.acquired;
    if (!claim) {
      const holder = attempt.held ?? attempt.waitingFor?.[0];
      throw new ClaimRefusedError({
        root,
        claimPath: holder?.path ?? root,
        label: 'maintenance',
        reason: `held by pid ${holder?.owner.pid ?? '?'} since ${holder?.startedAt ?? '?'} (${String(holder?.details.trigger ?? 'maintenance')})`,
      });
    }
    return await work(claim);
  } catch (cause) {
    if (
      claim &&
      (cause instanceof WorkspaceProcessCleanupError || (cause instanceof Error && 'reportCleanup' in cause))
    ) {
      retained = true;
      throw Object.assign(
        new WorkspaceProcessCleanupError(
          [...new Set([claim, ...(cause instanceof WorkspaceProcessCleanupError ? cause.claims : [])])],
          cause.message,
          'Verify GC and its owned children have stopped.',
        ),
        { reportCleanup: true },
      );
    }
    throw cause;
  } finally {
    if (claim && !retained) releaseClaim(claim);
  }
}

/** Executes one already-admitted sweep with separate progress, results and exit status. */
export async function executeGc(
  opts: RunGcOptions,
  deps: GcDependencies,
  write: (stream: 'stdout' | 'stderr', line: string) => void,
  claim?: ClaimHandle,
): Promise<GcExecutionResult> {
  const log =
    opts.delete || opts.idle !== undefined
      ? openGcLog({
          trigger: (deps.operation?.env ?? process.env).STIM_DESKTOP_APP ? 'desktop' : 'manual',
          env: deps.operation?.env,
          options: gcOptionsOf(opts),
          holdKept: true,
        })
      : null;
  const results = createGcResults(log?.record);
  let failed = false;
  const output: GcOutput = {
    log: (line) => write('stdout', line),
    error: (line) => write('stderr', line),
    record: results.record,
    fail: () => {
      failed = true;
    },
  };
  try {
    declareSpawnsOn(deps.operation, claim);
    const payload = await sweep(opts, deps, { output, takeResults: results.take });
    return { payload, exitCode: failed ? 1 : 0 };
  } finally {
    stopDeclaringSpawnsOn(deps.operation, claim);
  }
}

async function sweep(
  opts: RunGcOptions,
  deps: GcDependencies,
  execution: GcExecution,
  reportOnly = false,
): Promise<GcPayload> {
  const { output } = execution;
  const core = (dependencies: GcDependencies) => runGcCore(opts, dependencies, execution, reportOnly);
  if (opts.cache && (opts.worktrees || opts.idle !== undefined)) {
    const flag = opts.worktrees ? '--worktrees' : '--idle';
    const message = opts.worktrees
      ? '--cache acts only on the named caches, and --worktrees sweeps linked worktrees.'
      : '--cache acts only on the named caches, and --idle shuts down idle owned devices.';
    const remedy = `Run \`stim gc ${flag}${opts.worktrees ? '' : ' <duration>'}\` and \`stim gc --cache <name>\` separately.`;
    if (reportOnly) return { code: 'STIM_BAD_ARG', message, remedy };
    output.error(chalk.red(message));
    output.error(chalk.dim(remedy));
    output.error(chalk.red('failed: STIM_BAD_ARG'));
    output.fail();
    return { code: 'STIM_BAD_ARG', message, remedy };
  }
  const memoryKind = memoryCacheKind(opts.cache);
  if (memoryKind && opts.olderThan !== undefined) {
    const message = `--older-than does not apply to --cache ${memoryKind}, which acts on running processes.`;
    const remedy = `Run \`stim gc --cache ${memoryKind}\` without --older-than.`;
    if (reportOnly) return { code: 'STIM_BAD_ARG', message, remedy };
    output.error(chalk.red(message));
    output.error(chalk.dim(remedy));
    output.error(chalk.red('failed: STIM_BAD_ARG'));
    output.fail();
    return { code: 'STIM_BAD_ARG', message, remedy };
  }
  const poolError = parkedMaxSetting('ios').error || parkedMaxSetting('android').error;
  if (poolError) {
    if (reportOnly) phase('note', `${poolError} ${POOL_SETTING_REMEDY}`, deps.operation);
    else output.error(chalk.yellow(`${poolError} ${POOL_SETTING_REMEDY}`));
  }
  if (opts.cache) {
    return core({
      ...deps,
      precollectedEasSessionSweep: { projectScope: null, orphaned: [], notices: [], deletionSafe: true },
    });
  }
  let projectRoot: string | null = null;
  try {
    projectRoot = (deps.findProjectRoot ?? findProjectRoot)(deps.operation?.cwd ?? process.cwd());
    if (!projectRoot) {
      return core({
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
      return core({
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
    return core({
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
          collectEasSessionSweep(loadConfig(), coordinatedDeps),
        );
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
    const failure = sweepStarted ? 'EAS collection failed' : 'EAS project lock acquisition failed';
    easSessionSweep = {
      projectScope: projectRoot,
      orphaned: [],
      notices: [`EAS session sweep skipped: ${failure}: ${describeError(error)}`],
      deletionSafe: false,
    };
  }
  return core({ ...deps, precollectedEasSessionSweep: easSessionSweep });
}

async function pruneDeadProjects(deadProjects: string[], output: GcOutput, operation?: StimContext): Promise<number> {
  let deleteFailures = 0;
  for (const path of deadProjects) {
    operation?.signal.throwIfAborted();
    if (existsSync(path) || !isOnMountedVolume(path)) {
      output.log(chalk.yellow(`Kept ${path}: its absence can no longer be confirmed.`));
      output.record('project', 'kept', path, { detail: 'its absence can no longer be confirmed' });
      continue;
    }
    const result = await reclaimProject(path, {
      archive: { removedBy: 'gc' },
      stopRequester: { by: 'stim gc --delete' },
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
      output.log(chalk.yellow(`Could not fully prune ${path}; its registry entry was kept.`));
      output.record('project', 'kept', path, { detail: 'it could not be fully pruned; its registry entry was kept' });
    } else {
      output.log(chalk.green(`Pruned ${path}`));
      output.record('project', 'done', path);
    }
    for (const dir of result.removedWorkspaceDirs) {
      output.log(chalk.dim(`  removed workspace output ${dir}`));
      output.record('workspaceDirectory', 'done', dir);
    }
    for (const dir of result.failedWorkspaceDirs) {
      output.log(chalk.red(`  could not remove workspace output ${dir}`));
      output.record('workspaceDirectory', 'failed', dir, { detail: `could not remove it while pruning ${path}` });
      deleteFailures += 1;
    }
    if (result.killedPid) {
      output.log(chalk.dim(`  killed orphaned Metro pid ${result.killedPid}`));
    }
    if (result.stoppedSession) {
      output.log(chalk.dim(`  stopped remote session ${result.stoppedSession}`));
    }
    if (result.stoppedTunnel) {
      output.log(chalk.dim(`  stopped ${result.stoppedTunnel} tunnel`));
    }
    for (const name of result.deletedDevices) output.record('device', 'done', name);
    for (const s of result.skippedDevices) {
      output.log(chalk.yellow(`  ${s.name}: ${s.reason}`));
      output.record('device', result.failedDevices.includes(s) ? 'failed' : 'kept', s.name, {
        id: s.udid ?? null,
        detail: s.reason,
      });
    }
    deleteFailures += result.failedDevices.length;
  }
  return deleteFailures;
}

async function attachMaintenancePreview(
  report: GcReport,
  deleting: boolean,
  cache: string | null,
  refresh: boolean,
  operation?: StimContext,
): Promise<void> {
  if (!deleting) report.maintenance = await previewMaintenance({ devices: !cache, refresh, operation });
}

function scopedDryRunAction(cache: string | null): string {
  const memory = memoryCacheKind(cache);
  if (memory === WATCHMAN_KIND) return 'remove the stale roots and shut down the unused watchman';
  if (memory === GRADLE_DAEMONS_KIND) return 'stop the idle daemons';
  if (includesGradleVersions(cache)) return 'delete the Gradle versions marked deletable';
  return includesParkedDevices(cache) ? 'erase the parked devices' : 'empty the caches';
}

function dryRunHint(cache: string | null, all: boolean, actionable: boolean, caches: boolean): string | null {
  if (all && (!memoryCacheKind(cache) || actionable)) {
    return `Dry run. Re-run with --delete to ${scopedDryRunAction(cache)} above.`;
  }
  if (actionable) return 'Dry run. Re-run with --delete to reclaim.';
  if (caches)
    return 'Pass --delete --cache all to empty the caches above, or --delete --older-than <days> to trim them.';
  return null;
}

function scopedWorkPending(cache: string | null, report: GcReport): boolean {
  return memoryWorkPending(cache, report.memory) || gradleVersionsPending(report.gradleVersions);
}

async function pruneStatusCaches(report: GcReport, output: GcOutput, signal?: AbortSignal): Promise<number> {
  if (report.cacheScope !== null) return 0;
  return deleteStaleStatusCaches(collectStaleStatusCaches(listMountedVolumes()).stale, output, signal);
}

async function reclaimParkedDevices(report: GcReport, deps: GcDependencies, output: GcOutput): Promise<number> {
  return report.cacheScope
    ? await eraseParkedDevices(report.parkedSims, report.parkedAvds, output, deps.operation)
    : (await deleteParkedSims(report.parkedSims, deps, output)) +
        (await deleteParkedAvds(report.parkedAvds, output, deps.operation));
}

function reportActionable(report: GcReport): boolean {
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
    olderThan,
    all,
    cacheScope: cache,
  } = report;
  return archiveWorkPending(
    report.archives,
    deadProjects.length + invalidProjects.length > 0 ||
      report.orphanedWorkspaces.length > 0 ||
      Boolean(report.workspaceOutputs?.workspaces.some((entry) => entry.willClear)) ||
      Boolean(report.worktreeDependencies?.candidates.length) ||
      report.workspaceLogs.some((entry) => entry.willTrim) ||
      report.recordings.some((entry) => entry.willDelete && !entry.withWorkspace) ||
      Boolean(report.tempLeftovers?.entries.some((entry) => entry.willDelete)) ||
      Boolean(report.trash?.entries.some((entry) => entry.willDelete)) ||
      Boolean(report.worktreeSweep?.worktrees.some((entry) => !entry.skipped)) ||
      report.parkedSims.length > 0 ||
      report.parkedAvds.length + report.parkedHostedDevices.filter((device) => device.listed !== false).length > 0 ||
      orphanedDevices.length > 0 ||
      staleDevices.length + report.finishedDevices.length > 0 ||
      staleDeviceRecords.length > 0 ||
      report.staleLedgerEntries.length + report.staleEasLedgerEntries.length > 0 ||
      report.staleStatusCaches.length > 0 ||
      buildLocks.stale.length > 0 ||
      buildSlots.stale.length > 0 ||
      deviceLeases.expired.length > 0 ||
      easSessionSweep.orphaned.length > 0 ||
      ((olderThan !== null || all) && caches.length > 0) ||
      scopedWorkPending(cache, report),
  );
}

async function runGcCore(
  opts: RunGcOptions,
  deps: GcDependencies,
  execution: GcExecution,
  reportOnly = false,
): Promise<GcPayload> {
  const { output, takeResults } = execution;
  const signal = deps.operation?.signal;
  throwIfCancelled(signal, 'GC');
  const olderThan = typeof opts.olderThan === 'number' ? opts.olderThan : null;
  const cache = typeof opts.cache === 'string' && opts.cache.trim() ? opts.cache : null;
  const refresh = opts.delete === true;
  const report = await collectGcReport(
    {
      olderThan,
      cache,
      worktrees: Boolean(opts.worktrees),
      refresh,
      measureBuildState: opts.measureBuildState,
    },
    deps,
  );
  throwIfCancelled(signal, 'GC');
  if (cache && report.caches.length === 0 && report.workspaceOutputs === null && !selectsBeyondCaches(cache)) {
    const names = [
      ...new Set(discoverCaches(deps.operation?.env ?? process.env, deps.operation?.cwd).map((c) => c.name)),
    ];
    const message = `No shared cache carries "${cache}" in its name or directory.`;
    if (!reportOnly) {
      output.log(chalk.yellow(message));
      if (names.length) output.log(chalk.dim(`Caches on this machine: ${names.join(', ')}`));
      if (opts.json) output.fail();
    }
    return {
      code: 'STIM_BAD_ARG',
      message,
      remedy: names.length
        ? `Pass --cache all or a name from: ${names.join(', ')}.`
        : 'No shared cache was found on this machine.',
    };
  }

  await attachMaintenancePreview(report, opts.delete === true, cache, refresh, deps.operation);
  const refusal = archiveRefusal(report.archives);
  if (refusal !== null) {
    if (!reportOnly) {
      output.fail();
      output.error(chalk.red(refusal.message));
      output.error(chalk.dim(refusal.remedy));
      output.error(chalk.red(`failed: ${refusal.code}`));
    }
    return refusal;
  }
  const all = report.all;

  if (!reportOnly) for (const line of formatGcReport(report)) output.log(line);

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
  const actionable = reportActionable(report);
  const idle = opts.idle ?? null;
  throwIfCancelled(signal, 'GC');
  const idleFailures =
    idle === null
      ? 0
      : (
          await shutDownIdleDevices(
            report.idleDevices,
            idle,
            async () =>
              deps.operation
                ? collectIdleDevicesAsync(
                    loadConfig(),
                    await listAllIosSimsAsync({ timeoutMs: DEVICE_LIST_TIMEOUT_MS, operation: deps.operation, signal }),
                    report.deadProjects,
                    Date.now(),
                    deps.operation.env,
                    signal,
                    deps.operation,
                  )
                : collectIdleDevices(
                    loadConfig(),
                    listAllIosSims({ timeoutMs: DEVICE_LIST_TIMEOUT_MS }),
                    report.deadProjects,
                  ),
            output,
            signal,
            deps.operation,
          )
        ).failures;
  if (idleFailures) output.fail();
  const inventory =
    opts.json && !opts.delete && idle === null && report.cacheScope === null
      ? await collectInventory(loadConfig(), deadProjects, deps.operation?.env ?? process.env, deps.operation)
      : null;
  const payload = (failures: number | null): GcPayload => ({
    mode: opts.delete ? 'delete' : 'dry-run',
    idle,
    cacheScope: report.cacheScope,
    olderThan,
    worktreeSweep: report.worktreeSweep?.idle ?? null,
    actionable,
    failures,
    sections: gcReportSections(report),
    ...(report.maintenance ? { maintenance: report.maintenance } : {}),
    results: reportOnly ? [] : takeResults(),
    inventory,
  });

  if (!opts.delete) {
    const hint = dryRunHint(cache, all, actionable, caches.length > 0);
    if (hint && !reportOnly) output.log(chalk.dim(`\n${hint}`));
    return payload(idle === null ? null : idleFailures);
  }

  let deleteFailures = idleFailures;
  throwIfCancelled(signal, 'GC');
  if (cache === null) deleteFailures += await stopIdleWorkspaces(output, deps.operation);
  throwIfCancelled(signal, 'GC');
  deleteFailures += await deleteArchives(report.archives, output, signal);
  throwIfCancelled(signal, 'GC');
  deleteFailures += report.workspaceOutputs
    ? (
        await clearWorkspaceOutputs(
          report.workspaceOutputs,
          { olderThan, signal, operation: deps.operation, lighten: true },
          output,
        )
      ).failures
    : 0;
  throwIfCancelled(signal, 'GC');
  deleteFailures += await lightenWorktreeDependencies(report.worktreeDependencies, output, deps.operation);
  throwIfCancelled(signal, 'GC');
  deleteFailures += await trimWorkspaceLogs(report.workspaceLogs, output, deps.operation);
  throwIfCancelled(signal, 'GC');
  deleteFailures += await deleteRecordings(
    report.recordings,
    { whole: all, olderThan, now: Date.now() },
    output,
    signal,
  );
  throwIfCancelled(signal, 'GC');
  deleteFailures += await reclaimParkedDevices(report, deps, output);
  throwIfCancelled(signal, 'GC');
  deleteFailures += await deleteParkedHostedDevices(report.parkedHostedDevices, { operation: deps.operation }, output);
  throwIfCancelled(signal, 'GC');
  deleteFailures += await reclaimMemory(cache, report.memory, output, deps.operation);
  throwIfCancelled(signal, 'GC');
  deleteFailures += await deleteGradleVersions(report.gradleVersions, output, deps.operation);

  throwIfCancelled(signal, 'GC');
  await removeInvalidProjectEntries(invalidProjects, output, signal);

  throwIfCancelled(signal, 'GC');
  deleteFailures += await pruneDeadProjects(deadProjects, output, deps.operation);

  throwIfCancelled(signal, 'GC');
  deleteFailures += await deleteOrphanedWorkspaces(report.orphanedWorkspaces, output, deps.operation);

  throwIfCancelled(signal, 'GC');
  deleteFailures += await deleteProjectDevices(
    orphanedDevices,
    staleDevices,
    staleDeviceRecords,
    output,
    deps.operation,
  );
  throwIfCancelled(signal, 'GC');
  deleteFailures += await deleteFinishedDevices(report, output, deps.operation);
  throwIfCancelled(signal, 'GC');
  deleteFailures += await forgetStaleLedgerEntries(report.staleLedgerEntries, output, signal);
  throwIfCancelled(signal, 'GC');
  deleteFailures += await forgetStaleEasLedgerEntries(
    report.staleEasLedgerEntries,
    listMountedVolumes(),
    deps,
    output,
    signal,
  );
  throwIfCancelled(signal, 'GC');
  deleteFailures += await pruneStatusCaches(report, output, signal);
  if (report.tempLeftovers)
    deleteFailures += (
      await deleteTempLeftovers(
        { env: deps.operation?.env ?? process.env, signal: deps.operation?.signal, operation: deps.operation },
        output,
      )
    ).failures;
  if (report.trash) deleteFailures += (await deleteTrash(deps.operation, output)).failures;

  for (const lock of buildLocks.stale) {
    throwIfCancelled(signal, 'GC');
    const cleared = clearFreeClaimSet({ root: lock.path, label: `${lock.platform} build` });
    if (cleared.status === 'held') continue;
    if (cleared.status === 'refused') {
      output.log(chalk.yellow(`Left the build lock at ${lock.path} alone: ${cleared.reason}`));
      output.record('buildLock', 'kept', `${lock.platform} build lock`, { id: lock.path, detail: cleared.reason });
      continue;
    }
    if (cleared.status === 'failed') {
      deleteFailures++;
      output.log(chalk.red(`Failed to clear the build lock at ${lock.path}: ${cleared.reason}`));
      output.record('buildLock', 'failed', `${lock.platform} build lock`, { id: lock.path, detail: cleared.reason });
      continue;
    }
    output.record('buildLock', 'done', `${lock.platform} build lock`, { id: lock.path });
    output.log(
      chalk.green(
        `Cleared the ${lock.platform} build lock left by pid ${lock.pid ?? '?'} (${lock.projectRoot || 'unrecorded workspace'})`,
      ),
    );
  }

  for (const slot of buildSlots.stale) {
    throwIfCancelled(signal, 'GC');
    const cleared = clearFreeClaimSet({ root: slot.path, label: 'build slot' });
    if (cleared.status === 'held') continue;
    if (cleared.status === 'refused') {
      output.log(chalk.yellow(`Left the build slot at ${slot.path} alone: ${cleared.reason}`));
      output.record('buildSlot', 'kept', `build slot ${slot.index ?? '?'}`, { id: slot.path, detail: cleared.reason });
      continue;
    }
    if (cleared.status === 'failed') {
      deleteFailures++;
      output.log(chalk.red(`Failed to clear the build slot at ${slot.path}: ${cleared.reason}`));
      output.record('buildSlot', 'failed', `build slot ${slot.index ?? '?'}`, {
        id: slot.path,
        detail: cleared.reason,
      });
      continue;
    }
    output.record('buildSlot', 'done', `build slot ${slot.index ?? '?'}`, { id: slot.path });
    output.log(
      chalk.green(
        `Cleared build slot ${slot.index ?? '?'} left by pid ${slot.pid ?? '?'} (${slot.projectRoot || 'unrecorded workspace'})`,
      ),
    );
  }

  for (const entry of deviceLeases.expired) {
    throwIfCancelled(signal, 'GC');
    try {
      if (removeExpiredLease(entry)) {
        output.record('deviceLease', 'done', `${entry.platform} lease on ${entry.id ?? entry.name}`, {
          id: entry.path,
        });
        output.log(
          chalk.green(
            `Cleared the expired ${entry.platform} device lease on ${entry.id ?? entry.name} (held by ${entry.lease?.holder ?? 'an unrecorded workspace'})`,
          ),
        );
      } else {
        output.log(chalk.dim(`${entry.name} is no longer an expired lease; left alone.`));
      }
    } catch (err) {
      deleteFailures++;
      output.log(chalk.red(`Failed to clear the device lease at ${entry.path}: ${(err as Error)?.message || err}`));
      output.record('deviceLease', 'failed', `${entry.platform} lease on ${entry.id ?? entry.name}`, {
        id: entry.path,
        detail: (err as Error)?.message || String(err),
      });
    }
  }
  throwIfCancelled(signal, 'GC');
  deleteFailures += await deleteEasSessions(easSessionSweep, deps, output);
  throwIfCancelled(signal, 'GC');
  if (report.worktreeSweep)
    deleteFailures += await removeWorktrees(report.worktreeSweep, { operation: deps.operation }, output);

  if (deleteFailures) {
    output.log(
      chalk.red(`\n${deleteFailures} entr${deleteFailures === 1 ? 'y' : 'ies'} could not be deleted; see above.`),
    );
    output.fail();
  }

  throwIfCancelled(signal, 'GC');
  if (all) {
    deleteFailures += await emptyCaches(caches, output, signal, deps.operation);
  } else if (olderThan === null) {
    if (caches.length) {
      output.log(
        chalk.dim('Shared caches left alone: pass --cache all to empty them, or --older-than <days> to trim them.'),
      );
    }
  } else {
    deleteFailures += (await trimCaches(caches, olderThan, output, signal, deps.operation)).failures;
  }
  return payload(deleteFailures);
}

export default function gcCommand(program: Command): void {
  program
    .command('gc')
    .description(
      'Report what Stim has left behind: dead project entries, orphaned workspace directories, clean Stim-managed linked worktrees whose branch is merged or whose pull request was merged or closed, orphaned owned devices and EAS sessions, records of devices that no longer exist, build locks whose builder is gone, expired physical-device leases, the shared build caches, the build outputs and logs of each workspace, the memory of watchman and of the Gradle and Kotlin daemons, and recognized leftovers in TMPDIR. Reports by default; pass --delete to act.',
    )
    .option(
      '--worktrees',
      'also remove clean, idle Stim-managed linked worktrees, not only merged ones: with --delete run `stim worktree remove` (never --force) on each; idle means unused for --older-than days, 7 without it',
    )
    .option(
      '--delete',
      'actually prune the reported entries, reap the reported devices, lighten every workspace that is not building and ran no ios, android or macos command in the last 15 minutes by clearing its build outputs, a running dev server or booted device included, and trim its Metro, client and device logs to their newest 8 MiB',
    )
    .option(
      '--older-than <days>',
      'also reap owned devices whose workspace has not been used this long, trim shared cache entries nothing has used in that time and device recordings made before it, and clear workspace build outputs only for workspaces idle this long and parked devices only once parked this long',
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
      'act on the shared caches whose name or directory contains <name>, every cache, the workspace build outputs and the device recordings with --cache all, only the workspace build outputs with --cache workspaces, only the device recordings with --cache recordings, only the parked simulators and emulators with --cache parked, the watchman daemon and its stale roots with --cache watchman, the Gradle and Kotlin compile daemons with --cache gradle-daemons, or the Gradle version caches and wrapper distributions no registered project pins with --cache gradle-versions; archived, archived:<id>, archived-logs, archived-recordings and archived-agent select archived history explicitly, and the three kind selectors also take :<id> (archived-logs:<id>) to clear one kind of one archive; --cache all excludes archives. all, workspaces, recordings, parked, archived, archived:<id>, archived-logs, archived-recordings, archived-agent, their :<id> forms, watchman, gradle-daemons and gradle-versions are reserved names that never select a single cache, and --cache all never includes watchman, gradle-daemons or gradle-versions. With --delete they are emptied whole (a parked device is erased and stays parked, watchman loses its stale roots and shuts down only when no client uses it, and only daemons proven idle stop), which is the only way to clear an index-backed cache; add --older-than <days> to trim them by age instead. Archive ids, including the :<id> of a kind selector, ignore --older-than; archived and per-kind archive selectors without an id filter by removal age. Only those caches are reported; other devices and project entries are not inspected. Caches outside the config dir are refused while STIM_HOME is set.',
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
      const { interrupted } = await runProcessOperation(process.cwd(), (operation) =>
        withDrainingCancellation(operation, operation.signal, () => runGc(opts, { operation })),
      );
      if (interrupted !== null) process.exitCode = interrupted;
    });
}
