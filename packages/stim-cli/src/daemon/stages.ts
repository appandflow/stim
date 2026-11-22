import { isClaimUnavailable } from '@stim-cli/core/ownership-claim';
import { existsSync, readdirSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { answered } from '../workspace/bounded-read.ts';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { StimContext } from '@stim-cli/core';
import {
  currentStage,
  DORMANT_STAGE_KEY,
  readDormantStage,
  readIdleStage,
  readInteractions,
  workspaceMetadataFile,
  workspaceStateFile,
  type DaemonLadderAction,
  type DormantStageRecord,
  type MaintenanceAction,
  type GcMark,
} from '@stim-cli/core/state';
import { archiveWorkspace } from '../archive.ts';
import { canonicalPath, realpathAsync } from '../commands/gc/paths.ts';
import { deleteProjectDevices, findStaleProjectDevices, withAndroidAvdSizes } from '../commands/gc/devices.ts';
import type { OwnedDeviceActivity } from '../commands/gc/idle.ts';
import { workspaceOutputPaths } from '../commands/gc/workspaces.ts';
import { avdDataDirectories, listAvdsAsync } from '../devices/android.ts';
import { projectDeviceSlots } from '../devices/device-slots.ts';
import { listAllIosSimsAsync, type IosSimRecord } from '../devices/ios.ts';
import { withWorkspaceProcessLock, workspaceProcessLockError } from '../engine/workspace-process-lock.ts';
import { formatSize } from '../fs-util.ts';
import { machineNumber } from '../machine-number.ts';
import {
  decideIdleStop,
  hostedFacts,
  idleStopEvidence,
  survivingServer,
  unseenEmulatorError,
} from '../stimd/passes/idle-stop.ts';
import { metroStoreRoot } from '../stimd/metro/metro-store.ts';
import { linkedFirst, type CheckoutRole } from '../policy/checkout-order.ts';
import { dormantAction, dormantThresholdMs, longestIdleFirst } from '../policy/pressure.ts';
import { resolveSupervisorTarget } from '../stimd/metro/ownership.ts';
import { getProject, loadConfig, type Config, type ProjectRecord } from '../workspace/config.ts';
import { checkoutOwnerOf, type Checkout } from '../workspace/checkout-role.ts';
import { discoverCheckouts, type DiscoveredCheckout } from '../workspace/discovery.ts';
import { discoveredEvidence } from '../workspace/discovered-activity.ts';
import { lockReason, worktreeLockAsync } from '../workspace/worktree.ts';
import { discoveredReads, type DiscoveredReads } from '../workspace/discovered-reads.ts';
import { listedRoots } from '../commands/gc/worktrees.ts';
import { withIdleWorkspace } from '../workspace/in-use.ts';
import { workspaceDir, workspaceLogsDir } from '../workspace/paths.ts';
import { existingBuildDirKindsAsync } from '../workspace/regenerable-dirs.ts';
import {
  idleMinutesSetting,
  maintenanceKeepSetting,
  resolveProjectSettings,
  resolveProjectSettingsAsync,
} from '../workspace/settings.ts';
import { readWorkspaceState, updateWorkspaceStateAsync } from '../workspace/workspace-state.ts';
import { deleteOutputs, idleOutputs, revivable, writeWorkspaceEvent, type IdlePassInput } from './idle.ts';
import { timedStep, type DaemonLog, type StepTally } from './step-timing.ts';
import { forgetGitReads } from '../workspace/git-reads.ts';

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
const SIM_LIST_TIMEOUT_MS = 30_000;

export interface StageCandidate {
  path: string;
  project: ProjectRecord;
  /** How long the workspace has had no activity. */
  idleMs: number;
  /** A source checkout is taken after every linked worktree. */
  role: CheckoutRole;
  /** The git worktree root that owns the workspace, whose activity counts for it. */
  checkout: Checkout;
}

/** `idle.dormantDays` in milliseconds; 0 when the dormant stage is off. */
export function dormantAfterMs(config: Config | null, env: NodeJS.ProcessEnv = process.env): number {
  const { value } = machineNumber('idle.dormantDays', config, env);
  return (value ?? 0) * DAY_MS;
}

/** `idle.sourceDormantDays` in milliseconds; 0 when a source checkout's dependencies are never deleted for idleness. */
export function sourceDormantAfterMs(config: Config | null, env: NodeJS.ProcessEnv = process.env): number {
  const { value } = machineNumber('idle.sourceDormantDays', config, env);
  return (value ?? 0) * DAY_MS;
}

/** What the tick measured of the owned devices: those booted, and whether its `simctl list` failed. */
export interface DeviceReading {
  devices: readonly OwnedDeviceActivity[];
  simsFailed: boolean;
  /** The workspace of the command that runs this pass, which no stage takes. */
  protectedRoot?: string;
  /** The context whose reads run without blocking the event loop: the daemon tick's or a command's. */
  operation?: StimContext;
  /** Where the evidence loops write their `daemon_step` record; absent, they write none. */
  log?: DaemonLog;
}

function projectSettings(path: string, operation: StimContext | undefined) {
  return operation
    ? resolveProjectSettingsAsync(path, { env: operation.env, signal: operation.signal, declareFor: operation })
    : resolveProjectSettings(path);
}

function sameRoot(path: string, root: string | undefined): boolean {
  if (!root) return false;
  try {
    return canonicalPath(path) === canonicalPath(root);
  } catch {
    return false;
  }
}

/**
 * Whether anything of the workspace runs or cannot be shown not to: a booted owned device, a dev server, a hosted
 * placement (whose own automatic stop covers it), an owned simulator while `simctl list` failed, or an owned emulator
 * `adb devices` cannot rule out.
 */
export async function runsSomething(path: string, project: ProjectRecord, reading: DeviceReading): Promise<boolean> {
  if (reading.devices.some((device) => device.project === path)) return true;
  const slots = projectDeviceSlots(project);
  if (reading.simsFailed && slots.some(({ platforms }) => platforms.ios?.owned)) return true;
  const hosted = hostedFacts(path);
  if (hosted.placements.length || hosted.unreadable.length) return true;
  const state = readWorkspaceState(path);
  const supervisor = resolveSupervisorTarget({
    state: state?.supervisor,
    record: project.supervisor,
    reservedPort: project.metroPort,
  });
  if (
    supervisor.status === 'ours' ||
    supervisor.status === 'unverified' ||
    (supervisor.status === 'stale' && survivingServer(state?.supervisor) !== null)
  )
    return true;
  const avds = slots.flatMap(({ platforms }) =>
    platforms.android?.owned && platforms.android.avdName ? [platforms.android.avdName] : [],
  );
  return avds.length > 0 && (await unseenEmulatorError(avds, reading.operation)) !== null;
}

/**
 * How long a workspace with nothing running has had no activity, when that is at least `thresholdMs` and nothing
 * keeps it: a blocker, unreadable evidence, `maintenance.keep`, or `idle.minutes` 0; else why it is kept.
 */
const PRESSURE_THRESHOLD = 'the pressure idle threshold';

async function idleVerdict(
  path: string,
  thresholdMs: number,
  setting: string,
  {
    locked = false,
    operation,
    reads = discoveredReads(operation?.signal),
    full = false,
    checkout = path,
  }: {
    locked?: boolean;
    operation?: StimContext;
    reads?: DiscoveredReads;
    full?: boolean;
    /** The checkout whose source and git writes, processes and agent sessions count; default `path`. */
    checkout?: string;
  },
): Promise<{ idleMs: number; lastAt: number } | { kept: string; lastAt: number | null; active?: true }> {
  const now = Date.now();
  const pressured = setting === PRESSURE_THRESHOLD;
  const stim = await idleStopEvidence(path, [], { now, idleMs: thresholdMs, locked, pressured, operation });
  const evidence =
    !full && (getProject(path) || existsSync(workspaceMetadataFile(path)))
      ? stim
      : mergeEvidence(stim, await discoveredEvidence(checkout, { now, idleMs: thresholdMs, reads, operation }));
  const decision = decideIdleStop(evidence, { idleMs: thresholdMs, now, setting, pressured });
  const times = evidence.activity.map(({ at }) => at).filter(Number.isFinite);
  const lastAt = times.length ? Math.max(...times) : null;
  if (!decision.stop) return { kept: decision.reason, lastAt, ...(decision.active ? { active: true as const } : {}) };
  try {
    const { settings } = await projectSettings(path, operation);
    if (maintenanceKeepSetting(settings)) return { kept: 'pinned by maintenance.keep', lastAt };
    if (idleMinutesSetting(settings) === 0) return { kept: 'idle.minutes is 0', lastAt };
  } catch (error) {
    if (isClaimUnavailable(error) && 'reportCleanup' in error) throw error;
    operation?.signal.throwIfAborted();
    return {
      kept: `its settings cannot be resolved: ${error instanceof Error ? error.message : String(error)}`,
      lastAt,
    };
  }
  return { idleMs: decision.idleMs, lastAt: decision.last.at };
}

async function idleFor(
  path: string,
  thresholdMs: number,
  setting: string,
  options: Parameters<typeof idleVerdict>[3],
): Promise<number | null> {
  const verdict = await idleVerdict(path, thresholdMs, setting, options);
  return 'idleMs' in verdict ? verdict.idleMs : null;
}

/**
 * How long a source checkout has had no activity, by the full evidence whether or not a workspace is registered for it:
 * the newest of Stim activity, source file writes, git writes and the last commit. An unreadable state or a source scan
 * that ran out of time keeps it, and the reason says so.
 */
export function sourceCheckoutIdle(
  path: string,
  thresholdMs: number,
  setting: string,
  {
    operation,
    locked = false,
    reads,
    checkout,
  }: { operation?: StimContext; locked?: boolean; reads?: DiscoveredReads; checkout?: string },
): Promise<{ idleMs: number } | { kept: string }> {
  return idleVerdict(path, thresholdMs, setting, {
    operation,
    full: true,
    locked,
    ...(reads ? { reads } : {}),
    ...(checkout ? { checkout } : {}),
  });
}

/** Why a discovered checkout is not idle `thresholdMs` by the activity definition, or null when it is. */
export async function discoveredKeepReason(
  path: string,
  thresholdMs: number,
  operation?: StimContext,
  reads?: DiscoveredReads,
): Promise<string | null> {
  const verdict = await idleVerdict(path, thresholdMs, 'idle.dormantDays', {
    operation,
    ...(reads ? { reads } : {}),
  });
  return 'kept' in verdict ? verdict.kept : null;
}

function mergeEvidence<T extends { activity: unknown[]; keep: string[] }>(a: T, b: T): T {
  return { ...a, activity: [...a.activity, ...b.activity], keep: [...a.keep, ...b.keep] };
}

/** What a walk read of one checkout: when its reads began, its newest activity, and why it is kept when not for activity. */
export interface CheckoutReading {
  path: string;
  at: number;
  lastActivityAt: number | null;
  kept: string | null;
}

export async function readCheckout(
  path: string,
  project: ProjectRecord,
  reading: DeviceReading,
  thresholdMs: number,
): Promise<CheckoutReading> {
  const at = Date.now();
  if (sameRoot(path, reading.protectedRoot)) return { path, at, lastActivityAt: null, kept: 'protected workspace' };
  if (await runsSomething(path, project, reading))
    return { path, at, lastActivityAt: at, kept: 'something of it runs' };
  const verdict = await idleVerdict(path, thresholdMs, PRESSURE_THRESHOLD, { operation: reading.operation });
  return {
    path,
    at,
    lastActivityAt: verdict.lastAt,
    kept: 'kept' in verdict && !verdict.active ? verdict.kept : null,
  };
}

/** `full` reads source and git evidence even for a registered workspace; `onKept` hears why a workspace is not idle. */
interface IdleSelection {
  /** The current normal phase's discovery result, shared with its artifact inventory. */
  discovered?: readonly DiscoveredCheckout[];
  full?: boolean;
  /** The setting the threshold comes from, named in the reason a workspace is kept; default the pressure threshold. */
  setting?: string;
  onKept?: (path: string, reason: string) => void;
  /** Whether a discovered checkout holds anything the caller reclaims; one that does not is left out before its source walk. */
  reclaimable?: (path: string) => boolean | Promise<boolean>;
  /** Runs before each checkout's reads, a unit boundary of the disk owner. */
  between?: () => Promise<void>;
  /** Hears each checkout the walk read, inside that checkout's unit. */
  onRead?: (reading: CheckoutReading) => Promise<void>;
}

function idleWorkspaces(
  step: string,
  config: Config,
  reading: DeviceReading,
  thresholdMs: number,
  setting: string,
  worthIt: (path: string, project: ProjectRecord) => boolean | Promise<boolean>,
  selection: Omit<IdleSelection, 'setting'> & { discover?: boolean } = {},
): Promise<StageCandidate[]> {
  return timedStep(
    reading.log,
    step,
    (tally) => readIdleWorkspaces(tally, config, reading, thresholdMs, setting, worthIt, selection),
    { signal: reading.operation?.signal },
  );
}

async function readIdleWorkspaces(
  tally: StepTally,
  config: Config,
  reading: DeviceReading,
  thresholdMs: number,
  setting: string,
  worthIt: (path: string, project: ProjectRecord) => boolean | Promise<boolean>,
  {
    discover = false,
    full = false,
    onKept,
    reclaimable,
    between,
    onRead,
    discovered: supplied,
  }: Omit<IdleSelection, 'setting'> & { discover?: boolean } = {},
): Promise<StageCandidate[]> {
  const readings: (Omit<StageCandidate, 'idleMs' | 'role' | 'checkout'> & { idleMs: number | null })[] = [];
  const reads = discoveredReads(reading.operation?.signal);
  const found = supplied ?? (discover ? await discoverCheckouts(config, listedRoots(), reading.operation) : []);
  const discovered = found.map(({ path }): [string, ProjectRecord] => [path, {}]);
  const discoveredPaths = new Set(found.map(({ path }) => path));
  const checkouts = [...Object.entries(config.projects), ...discovered];
  tally.items = checkouts.length;
  for (const [path, project] of checkouts) {
    await between?.();
    if (sameRoot(path, reading.protectedRoot) || !(await worthIt(path, project))) continue;
    if (reclaimable && discoveredPaths.has(path) && !(await reclaimable(path))) continue;
    const at = Date.now();
    try {
      const used = Date.parse(String(readWorkspaceState(path)?.lastUsedAt ?? ''));
      if (Number.isFinite(used) && Date.now() - used < thresholdMs) {
        onKept?.(path, `a Stim command used it ${Math.floor((Date.now() - used) / MINUTE_MS)} minutes ago`);
        await onRead?.({ path, at, lastActivityAt: used, kept: null });
        continue;
      }
      let idleMs: number | null = null;
      let read: CheckoutReading;
      if (await runsSomething(path, project, reading)) {
        onKept?.(path, 'something of it runs');
        read = { path, at, lastActivityAt: at, kept: 'something of it runs' };
      } else {
        const verdict = await idleVerdict(path, thresholdMs, setting, {
          operation: reading.operation,
          reads,
          full,
        });
        if ('idleMs' in verdict) idleMs = verdict.idleMs;
        else onKept?.(path, verdict.kept);
        const kept = 'kept' in verdict && !verdict.active ? verdict.kept : null;
        read = { path, at, lastActivityAt: verdict.lastAt, kept };
      }
      readings.push({ path, project, idleMs });
      await onRead?.(read);
    } catch (error) {
      if (isClaimUnavailable(error) && 'reportCleanup' in error) throw error;
      reading.operation?.signal.throwIfAborted();
    }
  }
  const idle = longestIdleFirst(readings);
  const candidates: StageCandidate[] = [];
  for (const entry of idle) candidates.push(Object.assign(entry, await checkoutOwnerOf(entry.path, reading.operation)));
  return linkedFirst(candidates);
}

/** Whether the checkout holds an output rung 1 deletes, which a Cargo `target/` is not. */
async function hasOutputs(path: string): Promise<boolean> {
  if (workspaceOutputPaths(workspaceDir(path)).length > 0 || existsSync(metroStoreRoot(path))) return true;
  const { dirs, cargo } = await existingBuildDirKindsAsync(path);
  return dirs.some((dir) => !cargo.includes(dir));
}

/** Whether the workspace is still idle `thresholdMs`, for a caller that holds its native-run claim. */
export async function stillIdle(
  path: string,
  thresholdMs: number,
  {
    operation,
    full = false,
    locked = true,
    setting = PRESSURE_THRESHOLD,
    checkout,
  }: { operation?: StimContext; full?: boolean; locked?: boolean; setting?: string; checkout?: string },
): Promise<boolean> {
  return (
    (await idleFor(path, thresholdMs, setting, {
      locked,
      operation,
      full,
      ...(checkout ? { checkout } : {}),
    })) !== null
  );
}

/** Workspaces with nothing running, idle `thresholdMs` by the activity definition: linked worktrees, then source checkouts, longest-idle first in each. */
export function idleStageCandidates(
  config: Config,
  reading: DeviceReading,
  thresholdMs: number,
  selection: IdleSelection = {},
): Promise<StageCandidate[]> {
  const { setting = PRESSURE_THRESHOLD, ...rest } = selection;
  return idleWorkspaces('idle_stage_candidates', config, reading, thresholdMs, setting, () => true, {
    discover: true,
    ...rest,
  });
}

/** Workspaces with nothing running and regenerable build outputs on disk, idle `thresholdMs`, longest-idle first. */
export function stoppedOutputCandidates(
  config: Config,
  reading: DeviceReading,
  thresholdMs: number,
): Promise<StageCandidate[]> {
  return idleWorkspaces('stopped_output_candidates', config, reading, thresholdMs, PRESSURE_THRESHOLD, hasOutputs, {
    discover: true,
  });
}

type StageResult = Pick<DaemonLadderAction, 'outcome' | 'bytes' | 'partial' | 'detail'>;

/**
 * The outputs rung 1 deletes for a stopped workspace, and why each other one stays: none while its worktree is
 * locked with git worktree lock or git cannot list it, and never a Cargo `target/`, which only the Cargo trim of rung
 * 3 reduces.
 */
export async function stoppedOutputs(
  candidate: Pick<StageCandidate, 'path'>,
  config: Config,
  operation?: StimContext,
  deletable?: (path: string) => boolean,
): Promise<{ paths: string[]; kept: string[] } | { locked: string }> {
  const lock = await worktreeLockAsync(candidate.path, {
    env: operation?.env,
    signal: operation?.signal,
    declareFor: operation,
  });
  if (lock) return { locked: lockReason(lock) };
  const outputs = await idleOutputs(candidate.path, config, deletable);
  return {
    paths: outputs.paths.filter((path) => !outputs.targets.includes(path)),
    kept: [
      ...outputs.kept,
      ...outputs.targets.map((target) => `kept ${target}: a Cargo target/ is left to the Cargo trim of rung 3`),
    ],
  };
}

/**
 * Deletes a stopped workspace's regenerable build outputs under its native-run and metro-start locks. Null when every
 * output it has is kept, such as a Metro store a running dev server shares.
 */
export async function clearStoppedOutputs(
  candidate: Pick<StageCandidate, 'path'>,
  config: Config,
  thresholdMs: number,
  operation?: StimContext,
  deletable?: (path: string) => boolean,
  mark?: GcMark,
  reading?: DeviceReading & { act?: boolean },
  throttleIo = true,
): Promise<StageResult | null> {
  const { path } = candidate;
  const run = await withIdleWorkspace(
    path,
    async (): Promise<StageResult | null> => {
      try {
        return await withWorkspaceProcessLock(
          workspaceDir(path),
          'metro-start',
          async (): Promise<StageResult | null> => {
            let outputs: { paths: string[]; kept: string[] } | { locked: string };
            let paths: string[];
            try {
              if (mark) {
                const canonical = await answered(path, () => realpathAsync(path), 3_000, operation?.signal);
                const info = await answered(path, () => stat(path), 3_000, operation?.signal);
                if (canonical !== mark.root || info.dev !== mark.device)
                  return { outcome: 'kept', bytes: 0, detail: 'marked checkout moved or changed volume' };
              }
              if (reading && (await runsSomething(path, config.projects[path] ?? {}, reading)))
                return { outcome: 'kept', bytes: 0, detail: 'something of it runs' };
              if (
                (await idleFor(path, thresholdMs, PRESSURE_THRESHOLD, {
                  locked: true,
                  operation,
                })) === null
              )
                return { outcome: 'kept', bytes: 0, detail: 'it is no longer idle' };
              outputs = await stoppedOutputs(candidate, config, operation, deletable);
              if ('locked' in outputs) return { outcome: 'kept', bytes: 0, detail: outputs.locked };
              paths = mark
                ? outputs.paths.filter((output) =>
                    mark.candidates.some((entry) => entry.kind === 'outputs' && entry.path === output),
                  )
                : outputs.paths;
              if (!paths.length) return null;
              if (mark) {
                const verified: string[] = [];
                for (const output of paths) {
                  const canonical = await answered(output, () => realpathAsync(output), 3_000, operation?.signal);
                  const info = await answered(output, () => stat(output), 3_000, operation?.signal);
                  const expected = mark.candidates.find((entry) => entry.kind === 'outputs' && entry.path === output);
                  if (canonical === output && info.dev === expected?.device) verified.push(output);
                  else outputs.kept.push(`kept ${output}: marked output moved or changed volume`);
                }
                paths = verified;
                if (!paths.length) return { outcome: 'kept', bytes: 0, detail: outputs.kept.join('; ') };
              }
            } catch (error) {
              if (isClaimUnavailable(error) && 'reportCleanup' in error) throw error;
              operation?.signal.throwIfAborted();
              return {
                outcome: 'kept',
                bytes: 0,
                detail: `output safety recheck failed: ${error instanceof Error ? error.message : String(error)}`,
              };
            }
            if (reading?.act === false)
              return { outcome: 'would', bytes: 0, detail: 'daemon.mode report acts on nothing' };
            const freed = await deleteOutputs(paths, operation?.signal, { operation, throttleIo });
            return {
              outcome: 'done',
              ...freed,
              detail: `deleted ${formatSize(freed)} of regenerable build outputs${outputs.kept.length ? `; ${outputs.kept.join('; ')}` : ''}`,
            };
          },
          {
            external: true,
            waitMs: 0,
            ownerPurpose: 'pressure ladder',
            signal: operation?.signal,
            declareSpawnsFor: operation,
          },
        );
      } catch (error) {
        if (workspaceProcessLockError(error))
          return { outcome: 'kept', bytes: 0, detail: 'a stim start holds its metro-start lock' };
        throw error;
      }
    },
    { purpose: 'pressure ladder', devServer: false, hosted: false, hostedMacos: false, operation },
  );
  return run.ran ? run.value : { outcome: 'kept', bytes: 0, detail: `in use: ${run.reasons.join('; ')}` };
}

function ownsDevice(project: ProjectRecord): boolean {
  return projectDeviceSlots(project).some(({ platforms }) => platforms.ios?.owned || platforms.android?.owned);
}

function hasLogs(path: string): boolean {
  try {
    return readdirSync(workspaceLogsDir(path)).length > 0;
  } catch {
    return false;
  }
}

function alreadyDormant(path: string): boolean {
  const state = readWorkspaceState(path);
  return currentStage(state, readDormantStage(state)) !== null;
}

/** The newest activity `state.json` records: a Stim command, the end of a native run, a window interaction, the idle stage. */
function recordedActivityAt(path: string): number {
  const state = readWorkspaceState(path);
  const build = state?.lastBuild;
  const builtAt =
    Date.parse(String(build?.startedAt ?? '')) + (typeof build?.durationMs === 'number' ? build.durationMs : 0);
  const times = [
    Date.parse(String(state?.lastUsedAt ?? '')),
    builtAt,
    Date.parse(readIdleStage(state)?.at ?? ''),
    ...Object.values(readInteractions(state)).map((at) => Date.parse(at)),
  ].filter(Number.isFinite);
  return times.length ? Math.max(...times) : Number.NaN;
}

/**
 * A workspace the dormant stage will take later, which keeps the daemon alive: registered, not dormant yet, with an
 * owned device or logs to act on, until its dormant due time plus `graceMs`. None without recorded activity, whose due
 * time is unknown, and none that the dormant pass keeps skipping whatever the daemon does: `maintenance.keep`, `idle.minutes` 0, a hosted placement, an unreadable state, or an owned
 * simulator while the tick's simulator listing failed. Null when there is none or the stage is off.
 */
export async function pendingDormant(
  config: Config | null,
  reading: Pick<DeviceReading, 'simsFailed'>,
  { now = Date.now(), graceMs, operation }: { now?: number; graceMs: number; operation?: StimContext },
): Promise<string | null> {
  const afterMs = dormantAfterMs(config);
  if (!config || afterMs <= 0) return null;
  for (const [path, project] of Object.entries(config.projects)) {
    if (alreadyDormant(path) || !(ownsDevice(project) || hasLogs(path))) continue;
    if (!readWorkspaceState(path) && existsSync(workspaceStateFile(path))) continue;
    if (reading.simsFailed && projectDeviceSlots(project).some(({ platforms }) => platforms.ios?.owned)) continue;
    const hosted = hostedFacts(path);
    if (hosted.placements.length || hosted.unreadable.length) continue;
    try {
      const { settings } = await resolveProjectSettingsAsync(
        path,
        operation
          ? {
              env: operation.env,
              signal: operation.signal,
              declareFor: operation,
            }
          : {},
      );
      if (maintenanceKeepSetting(settings) || idleMinutesSetting(settings) === 0) continue;
    } catch (error) {
      if (isClaimUnavailable(error) && 'reportCleanup' in error) throw error;
      operation?.signal.throwIfAborted();
      continue;
    }
    const activityAt = recordedActivityAt(path);
    if (!Number.isFinite(activityAt) || now >= activityAt + afterMs + graceMs) continue;
    return path;
  }
  return null;
}

/**
 * Workspaces with nothing running, idle `thresholdMs`, not yet dormant, that own a device or have logs to archive,
 * longest-idle first.
 */
export function dormantCandidates(
  config: Config,
  reading: DeviceReading,
  thresholdMs: number,
): Promise<StageCandidate[]> {
  return idleWorkspaces(
    'dormant_candidates',
    config,
    reading,
    thresholdMs,
    'idle.dormantDays',
    (path, project) => !alreadyDormant(path) && (ownsDevice(project) || hasLogs(path)),
  );
}

/**
 * What brings a dormant workspace back: `stim revive` while its dev server's idle stop survives and the stage deleted
 * none of its devices, else the next `stim ios` or `stim android`.
 */
function dormantRestore(path: string, deleted: readonly string[]): string {
  return revivable(path) && !deleted.length ? 'stim revive' : 'stim ios or stim android';
}

type DormantOutcome = {
  status: Exclude<DaemonLadderAction['outcome'], 'would'>;
  bytes: number;
  detail: string;
  restore?: string;
};

/**
 * Carries out a `would-dormant-stage` action under the workspace's native-run lock after deciding again: its owned
 * simulators and emulators deleted through ledger teardown (the parked pool is untouched), then its logs archived.
 * node_modules and Pods stay; `runDormantDependencies` takes those holding their own bytes.
 */
/** Where an owned device keeps its data: the simulator's listed data path or its default device set folder, or the AVD's. */
export function deviceDataDirs(
  sims: readonly IosSimRecord[] | null | undefined,
  kind: 'ios' | 'android',
  id: string,
): string[] {
  if (kind === 'android') return avdDataDirectories(id);
  return [
    sims?.find((sim) => sim.udid === id)?.dataPath ??
      join(homedir(), 'Library', 'Developer', 'CoreSimulator', 'Devices', id),
  ];
}

export async function enterDormantStage(
  action: MaintenanceAction,
  operation?: StimContext,
  deletable?: (path: string) => boolean,
  skipCompleted = false,
): Promise<DormantOutcome> {
  forgetGitReads(operation);
  const path = action.target;
  const thresholdMs = dormantThresholdMs(action);
  if (thresholdMs === null) return { status: 'kept', bytes: 0, detail: 'the action names no idle threshold' };
  const config = loadConfig();
  const project = config?.projects[path];
  if (!config || !project) return { status: 'kept', bytes: 0, detail: 'it is no longer a registered workspace' };
  const run = await withIdleWorkspace(
    path,
    async (): Promise<DormantOutcome> => {
      if (skipCompleted && alreadyDormant(path))
        return { status: 'kept', bytes: 0, detail: 'its dormant stage is already complete' };
      const idleMs = await idleFor(path, thresholdMs, 'idle.dormantDays', { locked: true, operation });
      if (idleMs === null) return { status: 'kept', bytes: 0, detail: 'it is no longer idle' };
      const owns = (kind: 'ios' | 'android') =>
        projectDeviceSlots(project).some(({ platforms }) => platforms[kind]?.owned === true);
      let sims: IosSimRecord[] = [];
      let avds: string[] = [];
      try {
        if (owns('ios') && process.platform === 'darwin')
          sims = await listAllIosSimsAsync({ timeoutMs: SIM_LIST_TIMEOUT_MS, signal: operation?.signal, operation });
        if (owns('android')) avds = await listAvdsAsync({ signal: operation?.signal, operation });
      } catch (error) {
        if (isClaimUnavailable(error)) throw error;
        operation?.signal.throwIfAborted();
        return {
          status: 'failed',
          bytes: 0,
          detail: `its owned devices cannot be listed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      const devices = await withAndroidAvdSizes(
        findStaleProjectDevices({
          config: { ...config, projects: { [path]: project } },
          sims,
          avds,
          olderThanDays: 0,
          lastTouched: () => 0,
        }).filter((device) => {
          const dirs = deletable ? deviceDataDirs(sims, device.kind, device.id) : [];
          return !deletable || (dirs.length > 0 && dirs.every(deletable));
        }),
      );
      const deleted: string[] = [];
      const unmeasured: string[] = [];
      let bytes = 0;
      const failures = await deleteProjectDevices(
        [],
        devices,
        [],
        {
          log: () => {},
          error: () => {},
          fail: () => {},
          record: (_kind, status, label, result) => {
            if (status !== 'done') return;
            deleted.push(label);
            if (typeof result?.bytes === 'number') bytes += result.bytes;
            else unmeasured.push(label);
          },
        },
        operation,
      );
      const logs = hasLogs(path);
      if (logs) await archiveWorkspace(path, 'maintenance', readWorkspaceState(path), operation);
      const archived = logs && !hasLogs(path);
      const record: DormantStageRecord = {
        at: new Date().toISOString(),
        dormantDays: dormantAfterMs(config) / DAY_MS,
        deletedDevices: deleted,
        archived,
      };
      await updateWorkspaceStateAsync(path, (state) => ({ ...state, [DORMANT_STAGE_KEY]: record }));
      const restore = dormantRestore(path, deleted);
      const detail = `no activity for ${Math.floor(idleMs / MINUTE_MS)} minutes (${action.reason}): ${deleted.length ? `deleted ${deleted.join(', ')}` : 'no owned device to delete'}${unmeasured.length ? ` (freed size not counted for ${unmeasured.join(', ')}: its data directory could not be measured)` : ''}${failures ? `; ${failures} could not be deleted and stay recorded` : ''}; ${archived ? 'archived its logs' : 'kept its logs (archive.enabled is off or nothing to archive)'}; node_modules and Pods that are copy-on-write clones stay. ${deleted.length ? 'The next stim ios or stim android creates a device.' : `${restore} resumes it.`}`;
      writeWorkspaceEvent(path, failures ? 'warn' : 'info', 'workspace_dormant', detail, {
        bytes,
        deletedDevices: deleted,
        archived,
        restore,
      });
      return { status: failures ? 'failed' : 'done', bytes, detail, restore };
    },
    { purpose: 'dormant stage', devServer: false, hosted: false, hostedMacos: false, operation },
  );
  return run.ran ? run.value : { status: 'kept', bytes: 0, detail: `in use: ${run.reasons.join('; ')}` };
}

/**
 * The dormant stage at `idle.dormantDays`, run each tick after the activity pass. Logs each workspace it takes or
 * would take in report mode.
 */
export async function runDormantPass(
  input: Pick<IdlePassInput, 'config' | 'act' | 'log'> & DeviceReading,
): Promise<DaemonLadderAction[]> {
  const config = input.config;
  const afterMs = dormantAfterMs(config);
  if (!config || afterMs <= 0) return [];
  const actions: DaemonLadderAction[] = [];
  for (const candidate of await dormantCandidates(config, input, afterMs)) {
    const why = `idle.dormantDays is ${afterMs / DAY_MS}`;
    const result = input.act
      ? await enterDormantStage(dormantAction(candidate.path, afterMs, why), input.operation)
      : {
          status: 'would' as const,
          bytes: 0,
          detail: 'daemon.mode report acts on nothing',
          restore: dormantRestore(candidate.path, []),
        };
    const action: DaemonLadderAction = {
      rung: 4,
      kind: 'dormant-stage',
      target: candidate.path,
      workspace: candidate.path,
      outcome: result.status,
      bytes: result.bytes,
      detail: result.detail,
      ...(result.status === 'done' && result.restore ? { restore: result.restore } : {}),
    };
    actions.push(action);
    input.log(
      result.status === 'failed' ? 'warn' : 'info',
      `workspace_${result.status === 'would' ? 'would_dormant' : result.status === 'done' ? 'dormant' : `dormant_${result.status}`}`,
      `${candidate.path}: ${result.detail}`,
      { workspace: candidate.path, bytes: result.bytes, ...(result.restore ? { restore: result.restore } : {}) },
    );
  }
  return actions;
}
