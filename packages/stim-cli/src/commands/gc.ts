import { throwIfCancelled } from '../cancellation.ts';
import { runProcessOperation } from '../cli-operation.ts';
import { withDrainingCancellation } from '../engine/operation-state.ts';
import { configDir, ensurePrivateDir, isScopedHome } from '@stim-cli/core';
import { randomBytes } from 'node:crypto';
import { realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import type { StimContext } from '@stim-cli/core';
import { dirname, sep } from 'node:path';
import { WorkspaceProcessCleanupError } from '../engine/workspace-process-lock.ts';
import { gcReportFile, type DaemonPressure, type PressureLevel, type RescuedCopy } from '@stim-cli/core/state';
import { getSwiftpmCacheUsage } from '../devices/swiftpm-cache-usage.ts';
import { getAgentDeviceUsage } from '../devices/agent-device-usage.ts';
import { getMachineCacheReport } from '../devices/machine-cache-usage.ts';
import { defineOp, type Op } from '../cli/define-op.ts';
import { loadConfig } from '../workspace/config.ts';
import { listMountedVolumes } from '../fs-util.ts';
import { claimFailure } from '../ownership-claim.ts';
import { keepReserve, releaseReserve } from '../disk-reserve.ts';
import { runMaintenanceAtLevel, type LevelRun, type LevelRunAction } from '../stimd/passes/level-run.ts';
import type { GcPassReply } from '../daemon/disk-owner.ts';
import { runGcThroughStimd } from '../daemon/client.ts';
import { discoverCaches, sizeCaches } from '../cache/caches.ts';
import { openGcLog, type GcLog } from './gc/log.ts';
import type { GcResult } from './gc/results.ts';
import { phase } from './gc/progress.ts';
import { markOverCapCompilationCache, previewScopedEmptying } from './gc/caches.ts';
import { collectParkedAvds, collectParkedSims, collectDeviceLeases } from './gc/devices.ts';
import { gcReportSections, type GcJsonSections, type GcReport } from './gc/report.ts';
import { formatGcSummary, formatUnmanagedUsage, gcDetailLines } from './gc/summary.ts';
import { unmanagedUsage, type UnmanagedUsage } from './gc/unmanaged.ts';
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
import { openGitReads } from '../workspace/git-reads.ts';
import { expireRescued, rescuedSince } from '../workspace/rescue.ts';
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
  /** Checkouts no stim command ran in that the run treats as workspaces, each with its actions. */
  discovered: LevelRun['discovered'];
  /** Worktrees outside the folders Stim manages, listed and never acted on. */
  outside: LevelRun['outside'];
  /** Each action that ran, as the outcome items Stim Desktop lists. Empty on a dry run. */
  results: GcResult[];
  /** On a dry run, what Stim keeps on disk, for Stim Desktop's storage view. */
  sections?: GcJsonSections;
  inventory?: GcInventory | null;
  /** What an acting run copied aside before deleting it, each with the path to copy a file back from. */
  rescued?: RescuedCopy[];
  /** The pass already under way that this acting run joined instead of starting its own, and whose actions it lists. */
  joined?: GcPassReply['joined'];
}

export type GcPayload = GcRunPayload | GcRefusal;

type GcDependencies = RecordDependencies;

export interface GcExecutionResult {
  payload: GcPayload;
  exitCode: 0 | 1;
  /** The maintenance run a plain run printed, for the unmanaged-usage report that follows it. */
  run?: LevelRun;
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
  const machineCaches = await getMachineCacheReport(agentDeviceUsage, { operation });
  const tempLeftovers = await collectTempLeftovers({ now, env, signal: operation?.signal, operation });
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
    await collectWorktreeSweep({ idle: false, olderThan: null, now, refresh: false, operation }),
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
      ? collectFinishedDevices({ config: cfg, ...devices.listed, sweep: worktreeSweep, now })
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
    discovered: run.discovered,
    outside: run.outside,
    results: act ? run.actions.filter((action) => action.outcome !== 'would').map(resultOf) : [],
  };
}

const RESULT_KINDS: Record<string, GcResult['kind']> = {
  'clear-outputs': 'workspaceOutputs',
  'delete-build-outputs': 'workspaceOutputs',
  'clear-build-dirs': 'workspaceOutputs',
  'trim-cargo': 'workspaceOutputs',
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
    bytes:
      (action.outcome === 'done' && (action.bytes || action.partial)) || (action.outcome === 'failed' && action.partial)
        ? action.bytes
        : null,
    ...(action.partial ? { partial: action.partial } : {}),
    detail: action.outcome === 'done' ? [action.reason, action.detail].filter(Boolean).join('; ') : action.detail,
  };
}

/** `stim gc --dry-run --json` as the API's read-only `gc()` returns it: the plan and the storage sections. */
export async function readGcReport(options: GcReadOptions = {}, deps: GcDependencies = {}): Promise<GcPayload> {
  const closeGitReads = openGitReads(deps.operation);
  try {
    const run = await runMaintenanceAtLevel({
      level: options.pressure,
      act: false,
      operation: deps.operation,
      walkUnknown: false,
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
  } finally {
    closeGitReads();
  }
}

/** A gc pass request: the level the caller chose, if any, which client asked, and `walkUnknown` for the API's. */
export interface GcPassRequest {
  level?: PressureLevel;
  client: 'manual' | 'desktop';
  walkUnknown?: false;
}

/** Runs one acting gc pass for `request`, or joins one under way, and hands each action to `onAction` as it lands. */
export type GcPassRunner = (
  request: GcPassRequest,
  operation: StimContext | undefined,
  onAction: (action: LevelRunAction) => void,
) => Promise<GcPassReply>;

/**
 * One acting gc pass in this process, as stimd's passes thread runs it for a gc request: its actions go to the gc log
 * under the request's client and a run id of its own. The maintenance disk reserve, a 1 MB file kept so a pass can start on a full disk, is
 * given back before the pass and written again once it ends.
 */
export async function runGcPass(
  request: GcPassRequest,
  operation: StimContext | undefined,
  onAction: (action: LevelRunAction) => void,
  onLevel?: (level: PressureLevel) => void,
  between?: () => Promise<void>,
): Promise<GcPassReply> {
  releaseReserve();
  const closeGitReads = openGitReads(operation);
  try {
    const env = operation?.env ?? process.env;
    const { engineRoot } = await import('../engine-store/store.ts');
    const store = engineRoot(env);
    if (collectsEngineStore(env, store, operation?.home ?? configDir())) {
      const { collectInstalledStore } = await import('../engine-store/gc.ts');
      await collectInstalledStore(store).catch((error: unknown) =>
        console.error(`Stim: the engine store was not collected: ${error instanceof Error ? error.message : error}`),
      );
    }
    let log: GcLog | null = null;
    const id = `gc-${randomBytes(6).toString('hex')}`;
    const since = Date.now();
    const run = await runMaintenanceAtLevel({
      level: request.level,
      act: true,
      operation,
      ...(between ? { between } : {}),
      ...(request.walkUnknown === false ? { walkUnknown: request.walkUnknown } : {}),
      ...(onLevel ? { onLevel } : {}),
      onAction: (action) => {
        if (action.outcome === 'would') return;
        onAction(action);
        log ??= openGcLog({
          trigger: request.client,
          runId: id,
          env: operation?.env,
          options: { level: request.level ?? 'normal', ...(request.level ? { pressure: true } : {}) },
          holdKept: true,
        });
        log.record({ ...resultOf(action), kind: action.kind });
      },
    });
    await expireRescued(Date.now());
    return { run, rescued: rescuedSince(since) };
  } finally {
    closeGitReads();
    keepReserve();
  }
}

const gcClient = (env: NodeJS.ProcessEnv = process.env): GcPassRequest['client'] =>
  env.STIM_DESKTOP_APP ? 'desktop' : 'manual';

function joinedLine(joined: NonNullable<GcPassReply['joined']>, forced: boolean): string {
  const skipped = forced && joined.trigger === 'pressure' ? '; it frees only the volumes under pressure' : '';
  return `Joined the ${joined.level} pass ${joined.trigger} started at ${joined.startedAt}${skipped}; the actions below are that pass's.`;
}

/**
 * Runs one acting GC through `pass`, or a dry run in this process, and prints its summary unless `opts.json`.
 */
export async function executeGc(
  opts: GcOptions & { walkUnknown?: false },
  deps: GcDependencies,
  write: (stream: 'stdout' | 'stderr', line: string) => void,
  pass: GcPassRunner,
): Promise<GcExecutionResult> {
  const signal = deps.operation?.signal;
  throwIfCancelled(signal, 'GC');
  const act = !opts.dryRun;
  const chosen = opts.pressure !== undefined;
  const walk = opts.walkUnknown === false ? { walkUnknown: opts.walkUnknown } : {};
  let closeGitReads: (() => void) | undefined;
  try {
    let reply: GcPassReply;
    if (act) {
      reply = await pass(
        { ...(chosen ? { level: opts.pressure } : {}), client: gcClient(deps.operation?.env), ...walk },
        deps.operation,
        (action) => phase(action.outcome, `${action.kind} ${action.target}`, deps.operation),
      );
    } else {
      closeGitReads = openGitReads(deps.operation);
      reply = {
        run: await runMaintenanceAtLevel({ level: opts.pressure, act, operation: deps.operation, ...walk }),
      };
    }
    const { run } = reply;
    throwIfCancelled(signal, 'GC');
    let payload: GcRunPayload = {
      ...runPayload(run, act),
      ...(reply.rescued ? { rescued: reply.rescued } : {}),
      ...(reply.joined ? { joined: reply.joined } : {}),
    };
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
      if (reply.joined) write('stdout', joinedLine(reply.joined, chosen));
      const detail = saveGcDetail(gcDetailLines(run));
      for (const line of formatGcSummary(run, { act, chosen, detail })) write('stdout', line);
      for (const copy of payload.rescued ?? [])
        write(
          'stdout',
          `Copied aside before deleting: ${copy.items.map((item) => item.source).join(', ')} -> ${copy.dir}`,
        );
      return { payload, exitCode: payload.failures ? 1 : 0, run };
    }
    return { payload, exitCode: payload.failures ? 1 : 0 };
  } finally {
    closeGitReads?.();
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

/**
 * Runs `stim gc`: a dry run in this process, an acting run through `pass`, by default on this home's stimd, which
 * starts one whatever daemon.mode says.
 */
export async function runGc(
  opts: GcOptions = {},
  deps: GcDependencies = {},
  pass: GcPassRunner = runGcThroughStimd,
): Promise<void> {
  let result: GcExecutionResult;
  try {
    result = await executeGc(
      opts,
      deps,
      (stream, line) => {
        if (stream === 'stderr' || opts.json) console.error(line);
        else console.log(line);
      },
      pass,
    );
  } catch (error) {
    const failure =
      claimFailure(error, gcRetryCommand(opts)) ??
      (deps.operation?.signal.aborted
        ? { code: 'STIM_CANCELLED', message: 'GC was cancelled.', remedy: 'Retry the same GC command.' }
        : error instanceof Error && 'code' in error && typeof error.code === 'string' && 'remedy' in error
          ? { code: error.code, message: error.message, remedy: String(error.remedy) }
          : null);
    if (!failure) throw error;
    console.error(`${failure.code}: ${failure.message}`);
    console.error(failure.remedy);
    result = { payload: failure, exitCode: 1 };
  }
  if (result.exitCode) process.exitCode = result.exitCode;
  if (opts.json) console.log(JSON.stringify(result.payload));
  if (result.run) {
    let unmanaged: UnmanagedUsage | null = null;
    try {
      unmanaged = await unmanagedUsage(result.run, !opts.dryRun, deps.operation);
    } catch (error) {
      if (error instanceof WorkspaceProcessCleanupError || (error instanceof Error && 'reportCleanup' in error))
        throw error;
    }
    for (const line of unmanaged ? formatUnmanagedUsage(unmanaged) : []) console.log(line);
  }
}

function realOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/**
 * Whether gc collects the engine store at `store`: always from the default home, and from a home STIM_HOME scopes only
 * when the store lies inside that home, since the shared store under `~/.stim/engine` serves every home.
 */
export function collectsEngineStore(env: NodeJS.ProcessEnv, store: string, home: string): boolean {
  if (!isScopedHome(env)) return true;
  const [root, scope] = [realOrNull(store), realOrNull(home)];
  return root !== null && scope !== null && (root === scope || root.startsWith(`${scope}${sep}`));
}

const gc: Op = defineOp({
  name: 'gc',
  description:
    "Run one automatic maintenance pass now at the measured pressure level, or the level --pressure names, and delete what it takes. At every level: workspace build outputs and shared caches over their caps, what the age sweep removes (on macOS and Linux, Jest's default cache directory in the temp directory included), unused iOS simulator runtimes, registry entries and owned devices of removed projects, stale records, workspace logs over their cap, finished linked worktrees past their grace period, and every workspace idle for idle.dormantDays reduced to its minimal size: build outputs, owned devices, and a linked worktree's node_modules and Pods; a source (main) checkout's node_modules and Pods go after those, once it is idle for idle.sourceDormantDays (7 days). At high, the pressure ladder to its end as well: parked devices, shared caches trimmed to half their caps, Cargo targets trimmed, idle dev servers and their build outputs, idle workspaces made dormant, idle Gradle daemons, unpinned Gradle versions and temporary leftovers. At critical, every shared cache Stim registered emptied, every device recording and archived content, then the caches of other tools (npm, Yarn, pnpm, CocoaPods, Gradle, SwiftPM) through their own commands where they have one, when --pressure critical names the level, or when a measured critical still leaves the disk under the critical level after the earlier rungs. The ladder only reports the node_modules and Pods of idle worktrees and source checkouts and the finished worktrees it would have removed, as kept. Finished worktrees go only while maintenance.removeFinishedWorktrees is true, and clean pushed idle ones only while maintenance.removeIdleWorktrees is true. It never touches a workspace that is building, driven, leased, hosted or pinned by maintenance.keep.",
  options: {
    dryRun: { flags: '--dry-run', description: 'report what the run would delete, and delete nothing' },
    pressure: {
      flags: '--pressure <level>',
      description: 'run at this level, normal, high or critical, instead of the measured one',
      parse: parsePressureLevel,
    },
    json: { flags: '--json', description: 'print the result as JSON on stdout; every other line goes to stderr' },
  },
  run: async ({ options: opts }) => {
    const { interrupted } = await runProcessOperation(process.cwd(), (operation) =>
      withDrainingCancellation(operation, operation.signal, () => runGc(opts, { operation })),
    );
    if (interrupted !== null) process.exitCode = interrupted;
  },
});

export default gc;
