import { throwIfCancelled } from '../cancellation.ts';
import { runProcessOperation } from '../cli-operation.ts';
import { withDrainingCancellation } from '../engine/operation-state.ts';
import { ensurePrivateDir } from '@stim-cli/core';
import { renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { WorkspaceProcessCleanupError } from '../engine/workspace-process-lock.ts';
import { declareSpawnsOn, stopDeclaringSpawnsOn } from '../engine/spawn-claims.ts';
import { gcReportFile, maintenanceRunClaims, type DaemonPressure, type PressureLevel } from '@stim-cli/core/state';
import { getSwiftpmCacheUsage } from '../devices/swiftpm-cache-usage.ts';
import { getAgentDeviceUsage } from '../devices/agent-device-usage.ts';
import { getMachineCacheReport } from '../devices/machine-cache-usage.ts';
import { defineOp, type Op } from '../cli/define-op.ts';
import { loadConfig } from '../workspace/config.ts';
import { listMountedVolumes } from '../fs-util.ts';
import { ClaimRefusedError, claimFailure, releaseClaim, type ClaimHandle } from '../ownership-claim.ts';
import { claimPass, keepReserve, releaseReserve } from '../stimd/passes/run.ts';
import { runMaintenanceAtLevel, type LevelRun, type LevelRunAction } from '../stimd/passes/level-run.ts';
import { discoverCaches, sizeCaches } from '../cache/caches.ts';
import { openGcLog, type GcLog } from './gc/log.ts';
import type { GcResult } from './gc/results.ts';
import { phase } from './gc/progress.ts';
import { markOverCapCompilationCache, previewScopedEmptying } from './gc/caches.ts';
import { collectParkedAvds, collectParkedSims, collectDeviceLeases } from './gc/devices.ts';
import { gcReportSections, type GcJsonSections, type GcReport } from './gc/report.ts';
import { formatGcSummary, gcDetailLines } from './gc/summary.ts';
import { collectOrphanedWorkspaces, collectWorkspaceOutputs, isInsideWorkspaces } from './gc/workspaces.ts';
import { collectWorktreeSweep } from './gc/worktrees.ts';
import { measureWorktreeSweep } from './gc/worktree-sizes.ts';
import { collectStaleStatusCaches } from './gc/status-caches.ts';
import { collectWorkspaceLogs } from './gc/logs.ts';
import { collectRecordings } from './gc/recordings.ts';
import { collectTempLeftovers } from './gc/temp-leftovers.ts';
import { collectTrash } from './gc/trash.ts';
import { workspaceDir } from '../workspace/paths.ts';
import { collectInventory, type GcInventory } from './gc/inventory.ts';
import { collectParkedHostedDevices } from './gc/hosted-devices.ts';
import { collectHostedAppStorage } from './gc/hosted-apps.ts';
import { collectFinishedDevices } from './gc/finished-devices.ts';
import { collectGcMemory } from './gc/memory.ts';
import {
  collectDeviceRecords,
  collectProjectEasSessions,
  collectProjectRecords,
  collectStaleClaims,
  findStaleEasLedgerEntries,
  type RecordDependencies,
} from './gc/records.ts';

export {
  deleteParkedSims,
  describeParkedSims,
  describeUnverifiableDevices,
  findOrphanedDevices,
  findStaleDeviceRecords,
  findStaleProjectDevices,
  type ParkedSimReport,
} from './gc/devices.ts';

const LEVELS: readonly PressureLevel[] = ['normal', 'high', 'critical'];

interface GcOptions {
  dryRun?: boolean;
  /** The level to run at instead of the measured one. */
  pressure?: PressureLevel;
  json?: boolean;
  /** False reports worktree build-state sizes only from the disk-usage cache: a stale one is unmeasured (null), and no `du` runs for it. */
  measureBuildState?: boolean;
}

interface GcRefusal {
  code: string;
  message: string;
  remedy: string;
}

export interface GcRunPayload {
  mode: 'dry-run' | 'delete';
  /** The level this run ran at: `pressure.level` unless `--pressure` chose one. */
  level: PressureLevel;
  /** What the machine measured. */
  pressure: DaemonPressure;
  /** Whether the run would take, or took, at least one action. */
  actionable: boolean;
  /** Failed actions; null on a dry run. */
  failures: number | null;
  actions: LevelRunAction[];
  /** What the run could not decide or reach, each for a person to look at. */
  blocked: string[];
  /** Each action that ran, as the outcome items Stim Desktop lists. Empty on a dry run. */
  results: GcResult[];
  /** On a dry run, what Stim keeps on disk, for Stim Desktop's storage view. */
  sections?: GcJsonSections;
  inventory?: GcInventory | null;
}

export type GcPayload = GcRunPayload | GcRefusal;

type GcDependencies = RecordDependencies;

export interface GcExecutionResult {
  payload: GcPayload;
  exitCode: 0 | 1;
}

export type GcReadOptions = Pick<GcOptions, 'pressure' | 'measureBuildState'>;
export type GcMutationOptions = Pick<GcOptions, 'pressure'>;

export function parsePressureLevel(value: string): PressureLevel {
  const level = value.trim().toLowerCase() as PressureLevel;
  if (!LEVELS.includes(level)) throw new Error(`must be one of ${LEVELS.join(', ')}`);
  return level;
}

/** What Stim keeps on disk, for the storage view: every section `stim gc --dry-run --json` carries. */
async function collectGcReport(
  { measureBuildState = true, now = Date.now() }: { measureBuildState?: boolean; now?: number },
  deps: GcDependencies = {},
): Promise<GcReport> {
  const operation = deps.operation;
  const env = operation?.env ?? process.env;
  const caches = await sizeCaches(
    discoverCaches(env, operation?.cwd).filter((cache) => !isInsideWorkspaces(cache.dir)),
    operation,
  );
  phase('report', 'measuring what Stim keeps on disk', operation);
  const agentDeviceUsage = await getAgentDeviceUsage({ operation });
  const swiftpmCacheUsage = await getSwiftpmCacheUsage({ operation });
  const machineCaches = await getMachineCacheReport(agentDeviceUsage, {
    operation,
  });
  const tempLeftovers = await collectTempLeftovers({
    now,
    env,
    signal: operation?.signal,
    operation,
  });
  const trash = await collectTrash({ signal: operation?.signal, operation });
  const mountedVolumes = listMountedVolumes();
  const cfg = loadConfig();
  const { deadProjects, invalidProjects, skipped } = collectProjectRecords(cfg);
  const workspaceDirs = await collectOrphanedWorkspaces(Object.keys(cfg?.projects ?? {}), mountedVolumes, {
    operation,
  });
  skipped.push(...workspaceDirs.skipped);
  const statusCaches = collectStaleStatusCaches(mountedVolumes);
  skipped.push(...statusCaches.skipped);
  const hosted = collectParkedHostedDevices({ now });
  const hostedApps = await collectHostedAppStorage(operation);
  const devices = await collectDeviceRecords(cfg, deadProjects, deps);
  const worktreeSweep = await measureWorktreeSweep(
    await collectWorktreeSweep({
      idle: false,
      olderThan: null,
      now,
      refresh: false,
      operation,
    }),
    operation,
    measureBuildState,
  );
  const gone = [...workspaceDirs.orphaned.map((entry) => entry.dir), ...deadProjects.map(workspaceDir)];
  const easSessionSweep = (await collectProjectEasSessions(deps)) ?? {
    projectScope: null,
    orphaned: [],
    notices: [],
    deletionSafe: true,
  };
  return {
    skipped,
    deadProjects,
    orphanedPorts: deadProjects.flatMap((project) =>
      Object.entries(cfg?.projects[project]?.ports ?? {}).map(([label, port]) => ({ project, label, port })),
    ),
    invalidProjects,
    orphanedWorkspaces: workspaceDirs.orphaned,
    parkedSims: await collectParkedSims(deps, { now }),
    parkedAvds: await collectParkedAvds(deps, { now }),
    parkedHostedDevices: hosted.devices,
    hostedAppStorage: hostedApps.areas,
    otherHomes: devices.otherHomes?.homes ?? [],
    orphanedDevices: devices.orphanedDevices,
    unverifiedDevices: devices.unverifiedDevices,
    simulatorLaunchdFolders: devices.simulatorLaunchdFolders,
    staleDevices: [],
    staleDeviceRecords: devices.staleDeviceRecords,
    staleLedgerEntries: devices.staleLedgerEntries,
    staleEasLedgerEntries: findStaleEasLedgerEntries(mountedVolumes, deps),
    staleStatusCaches: statusCaches.stale,
    ...collectStaleClaims(),
    deviceLeases: collectDeviceLeases(now),
    deviceSweepNotices: [...hosted.notices, ...hostedApps.notices, ...devices.notices],
    easSessionSweep,
    caches: markOverCapCompilationCache(previewScopedEmptying(caches, env), env),
    workspaceOutputs: await collectWorkspaceOutputs({
      olderThan: null,
      now,
      exclude: gone,
      signal: operation?.signal,
      operation,
      lighten: true,
    }),
    workspaceLogs: await collectWorkspaceLogs({ exclude: gone, operation }),
    recordings: await collectRecordings({ whole: false, olderThan: null, now }, gone, operation?.signal),
    worktreeSweep,
    finishedDevices: devices.listed
      ? collectFinishedDevices({
          config: cfg,
          ...devices.listed,
          sweep: worktreeSweep,
          now,
        })
      : [],
    ownedDeviceDisk: devices.ownedDeviceDisk,
    memory: await collectGcMemory({ watchman: true, gradle: true }, env, operation),
    gradleVersions: null,
    agentDeviceUsage,
    swiftpmCacheUsage,
    machineCaches,
    tempLeftovers,
    trash,
  };
}

function runPayload(run: LevelRun, act: boolean): GcRunPayload {
  const failed = run.actions.filter((action) => action.outcome === 'failed').length;
  return {
    mode: act ? 'delete' : 'dry-run',
    level: run.level,
    pressure: run.pressure,
    actionable: run.actions.some((action) => action.outcome === (act ? 'done' : 'would')),
    failures: act ? failed : null,
    actions: run.actions,
    blocked: run.blocked,
    results: act ? run.actions.filter((action) => action.outcome !== 'would').map(resultOf) : [],
  };
}

const RESULT_KINDS: Record<string, GcResult['kind']> = {
  'clear-outputs': 'workspaceOutputs',
  'delete-build-outputs': 'workspaceOutputs',
  'clear-build-dirs': 'workspaceOutputs',
  'idle-stage': 'devServer',
  'trim-cache': 'cache',
  'empty-cache': 'cache',
  'unregister-cache': 'cache',
  'remove-worktree': 'worktree',
  'delete-dependencies': 'worktreeDependencies',
  'remove-orphan': 'workspaceDirectory',
  'prune-project': 'project',
  'delete-parked-device': 'parkedDevice',
  'delete-hosted-devices': 'parkedHostedDevice',
  'delete-devices': 'device',
  'dormant-stage': 'device',
  'delete-orphaned-devices': 'device',
  'forget-stale-records': 'ledgerEntry',
  'delete-status-caches': 'statusCache',
  'delete-process-locks': 'homeEntry',
  'delete-device-lease': 'deviceLease',
  'delete-expired-archives': 'archive',
  'delete-archives': 'archive',
  'delete-recordings': 'recording',
  'trim-workspace-logs': 'workspaceLogs',
  'delete-eas-sessions': 'easSession',
  'stop-gradle-daemons': 'gradleDaemon',
  'stop-watchman': 'watchman',
  'delete-gradle-version': 'gradleVersion',
  'delete-temp-leftovers': 'tempLeftover',
  'delete-trash': 'trash',
  'delete-runtime': 'runtime',
  'delete-unavailable-sim': 'device',
  'clean-tool-cache': 'toolCache',
};

function resultOf(action: LevelRunAction): GcResult {
  return {
    kind: RESULT_KINDS[action.kind] ?? 'cache',
    status: action.outcome === 'would' ? 'kept' : action.outcome,
    label: action.target,
    id: action.workspace ?? null,
    bytes: action.outcome === 'done' && action.bytes ? action.bytes : null,
    detail: action.outcome === 'done' ? [action.reason, action.detail].filter(Boolean).join('; ') : action.detail,
  };
}

/** `stim gc --dry-run --json` as the API's read-only `gc()` returns it: the plan and the storage sections. */
export async function readGcReport(options: GcReadOptions = {}, deps: GcDependencies = {}): Promise<GcPayload> {
  const run = await runMaintenanceAtLevel({
    level: options.pressure,
    act: false,
    operation: deps.operation,
  });
  const report = await collectGcReport({ measureBuildState: options.measureBuildState }, deps);
  return {
    ...runPayload(run, false),
    sections: gcReportSections(report),
    inventory: await collectInventory(
      loadConfig(),
      report.deadProjects,
      deps.operation?.env ?? process.env,
      deps.operation,
    ),
  };
}

function gcLogOf(level: PressureLevel, chosen: boolean, env?: NodeJS.ProcessEnv): GcLog {
  return openGcLog({
    trigger: (env ?? process.env).STIM_DESKTOP_APP ? 'desktop' : 'manual',
    env,
    options: { level, ...(chosen ? { pressure: true } : {}) },
    holdKept: true,
  });
}

/** Runs one acting GC, or a dry run, already admitted under the maintenance claim when it acts. */
export async function executeGc(
  opts: GcOptions,
  deps: GcDependencies,
  write: (stream: 'stdout' | 'stderr', line: string) => void,
  claim?: ClaimHandle,
): Promise<GcExecutionResult> {
  const signal = deps.operation?.signal;
  throwIfCancelled(signal, 'GC');
  const act = !opts.dryRun;
  const chosen = opts.pressure !== undefined;
  let log: GcLog | null = null;
  try {
    declareSpawnsOn(deps.operation, claim);
    const run = await runMaintenanceAtLevel({
      level: opts.pressure,
      act,
      operation: deps.operation,
      onAction: (action) => {
        if (!act || action.outcome === 'would') return;
        log ??= gcLogOf(opts.pressure ?? 'normal', chosen, deps.operation?.env);
        log.record({ ...resultOf(action), kind: action.kind });
      },
    });
    throwIfCancelled(signal, 'GC');
    let payload: GcRunPayload = runPayload(run, act);
    if (!act && opts.json) {
      const report = await collectGcReport({ measureBuildState: opts.measureBuildState }, deps);
      payload = {
        ...payload,
        sections: gcReportSections(report),
        inventory: await collectInventory(
          loadConfig(),
          report.deadProjects,
          deps.operation?.env ?? process.env,
          deps.operation,
        ),
      };
    }
    if (!opts.json) {
      const detail = saveGcDetail(gcDetailLines(run));
      for (const line of formatGcSummary(run, { act, chosen, detail })) write('stdout', line);
    }
    return { payload, exitCode: payload.failures ? 1 : 0 };
  } finally {
    stopDeclaringSpawnsOn(deps.operation, claim);
  }
}

function saveGcDetail(lines: readonly string[]): string {
  const file = gcReportFile();
  const staged = `${file}.${process.pid}.tmp`;
  try {
    ensurePrivateDir(dirname(file));
    writeFileSync(staged, `${lines.join('\n')}\n`, { mode: 0o600 });
    renameSync(staged, file);
    return file;
  } catch (error) {
    rmSync(staged, { force: true });
    return `not written (${error instanceof Error ? error.message : String(error)}); stim gc --json prints every entry`;
  }
}

function gcRetryCommand(opts: GcOptions): string {
  return ['stim gc', opts.dryRun && '--dry-run', opts.pressure && `--pressure ${opts.pressure}`, opts.json && '--json']
    .filter(Boolean)
    .join(' ');
}

export async function runGc(opts: GcOptions = {}, deps: GcDependencies = {}): Promise<void> {
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
        ? {
            code: 'STIM_CANCELLED',
            message: 'GC was cancelled.',
            remedy: 'Retry the same GC command.',
          }
        : null);
    if (!failure) throw error;
    console.error(`${failure.code}: ${failure.message}`);
    console.error(failure.remedy);
    result = { payload: failure, exitCode: 1 };
  }
  if (result.exitCode) process.exitCode = result.exitCode;
  if (opts.json) console.log(JSON.stringify(result.payload));
}

/**
 * Runs an acting GC under this home's exclusive maintenance claim, the one the stim-daemon's maintenance pass takes, so
 * the two never delete at once; while a pass holds it, an acting GC refuses at once with STIM_CLAIM_REFUSED naming the
 * holder. The claim is retained when owned cleanup is unresolved. The maintenance disk reserve, a 1 MB file kept so a
 * pass can start on a full disk, is given back before the claim's first write and written again once the run ends.
 */
export async function withGcMaintenanceClaim<T>(
  opts: Pick<GcOptions, 'dryRun' | 'pressure'>,
  work: (claim: ClaimHandle | undefined) => Promise<T>,
): Promise<T> {
  if (opts.dryRun) return work(undefined);
  let claim: ClaimHandle | undefined;
  let retained = false;
  try {
    releaseReserve();
    const attempt = claimPass('gc');
    claim = attempt.acquired;
    if (!claim) {
      const holder = attempt.held;
      throw new ClaimRefusedError({
        root: maintenanceRunClaims(),
        claimPath: holder?.path ?? maintenanceRunClaims(),
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
          cause,
        ),
        { reportCleanup: true },
      );
    }
    throw cause;
  } finally {
    if (claim && !retained) releaseClaim(claim);
    if (!retained) keepReserve();
  }
}

const gc: Op = defineOp({
  name: 'gc',
  description:
    "Run one automatic maintenance pass now at the measured pressure level, or the level --pressure names, and delete what it takes. At every level: workspace build outputs and shared caches over their caps, what the age sweep removes, unused iOS simulator runtimes, registry entries and owned devices of removed projects, stale records, workspace logs over their cap, finished linked worktrees past their grace period, and every workspace idle for idle.dormantDays reduced to its minimal size: build outputs, owned devices, and a linked worktree's node_modules and Pods. At high, the pressure ladder to its end as well: idle dev servers and their build outputs, parked devices, shared caches trimmed to half their caps, idle workspaces made dormant, node_modules and Pods of idle linked worktrees, idle Gradle daemons, unpinned Gradle versions, temporary leftovers, and clean merged worktrees without the grace period. At critical, every shared cache Stim registered emptied, clean pushed worktrees idle 7 days, every device recording and archived content, then the caches of other tools through their own commands (npm, Yarn, pnpm, CocoaPods, Gradle), which high also runs while free disk stays under disk.minFreeGb. It never touches a workspace that is building, driven, leased, hosted or pinned by maintenance.keep.",
  options: {
    dryRun: {
      flags: '--dry-run',
      description: 'report what the run would delete, and delete nothing',
    },
    pressure: {
      flags: '--pressure <level>',
      description: 'run at this level, normal, high or critical, instead of the measured one',
      parse: parsePressureLevel,
    },
    json: {
      flags: '--json',
      description: 'print the result as JSON on stdout; every other line goes to stderr',
    },
  },
  run: async ({ options: opts }) => {
    if (!opts.dryRun) {
      const { collectInstalledStore } = await import('../engine-store/gc.ts');
      const { engineRoot } = await import('../engine-store/store.ts');
      await collectInstalledStore(engineRoot(process.env)).catch((error: unknown) =>
        console.error(`Stim: the engine store was not collected: ${error instanceof Error ? error.message : error}`),
      );
    }
    const { interrupted } = await runProcessOperation(process.cwd(), (operation) =>
      withDrainingCancellation(operation, operation.signal, () => runGc(opts, { operation })),
    );
    if (interrupted !== null) process.exitCode = interrupted;
  },
});

export default gc;
