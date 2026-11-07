import { isClaimUnavailable } from '@stim-cli/core/ownership-claim';
import { existsSync, readdirSync } from 'node:fs';
import type { StimContext } from '@stim-cli/core';
import {
  currentStage,
  DORMANT_STAGE_KEY,
  readDormantStage,
  readIdleStage,
  readInteractions,
  workspaceStateFile,
  type DaemonLadderAction,
  type DormantStageRecord,
  type MaintenanceAction,
} from '@stim-cli/core/state';
import { archiveWorkspace } from '../archive.ts';
import { canonicalPath } from '../commands/gc/paths.ts';
import { deleteProjectDevices, findStaleProjectDevices, withAndroidAvdSizes } from '../commands/gc/devices.ts';
import type { OwnedDeviceActivity } from '../commands/gc/idle.ts';
import { workspaceOutputPaths } from '../commands/gc/workspaces.ts';
import { listAvdsAsync } from '../devices/android.ts';
import { projectDeviceSlots } from '../devices/device-slots.ts';
import { listAllIosSimsAsync, type IosSimRecord } from '../devices/ios.ts';
import { withWorkspaceProcessLock, workspaceProcessLockError } from '../engine/workspace-process-lock.ts';
import { formatBytes } from '../fs-util.ts';
import { machineNumber } from '../machine-number.ts';
import {
  decideIdleStop,
  hostedFacts,
  idleStopEvidence,
  survivingServer,
  unseenEmulatorError,
} from '../stimd/passes/idle-stop.ts';
import { metroStoreRoot } from '../stimd/metro/metro-store.ts';
import { dormantAction, dormantThresholdMs, longestIdleFirst } from '../policy/pressure.ts';
import { resolveSupervisorTarget } from '../stimd/metro/ownership.ts';
import { loadConfig, type Config, type ProjectRecord } from '../workspace/config.ts';
import { withIdleWorkspace } from '../workspace/in-use.ts';
import { workspaceDir, workspaceLogsDir } from '../workspace/paths.ts';
import { existingBuildDirsAsync } from '../workspace/regenerable-dirs.ts';
import {
  idleMinutesSetting,
  maintenanceKeepSetting,
  resolveProjectSettings,
  resolveProjectSettingsAsync,
} from '../workspace/settings.ts';
import { readWorkspaceState, updateWorkspaceStateAsync } from '../workspace/workspace-state.ts';
import { deleteOutputs, idleOutputs, revivable, writeWorkspaceEvent, type IdlePassInput } from './idle.ts';

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
const SIM_LIST_TIMEOUT_MS = 30_000;

export interface StageCandidate {
  path: string;
  project: ProjectRecord;
  /** How long the workspace has had no activity. */
  idleMs: number;
}

/** `idle.dormantDays` in milliseconds; 0 when the dormant stage is off. */
export function dormantAfterMs(config: Config | null, env: NodeJS.ProcessEnv = process.env): number {
  const { value } = machineNumber('idle.dormantDays', config, env);
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
async function runsSomething(path: string, project: ProjectRecord, reading: DeviceReading): Promise<boolean> {
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
 * keeps it: a blocker, unreadable evidence, `maintenance.keep`, or `idle.minutes` 0.
 */
async function idleFor(
  path: string,
  thresholdMs: number,
  setting: string,
  { locked = false, operation }: { locked?: boolean; operation?: StimContext } = {},
): Promise<number | null> {
  const now = Date.now();
  const evidence = await idleStopEvidence(path, [], { now, idleMs: thresholdMs, locked, operation });
  const decision = decideIdleStop(evidence, { idleMs: thresholdMs, now, setting });
  if (!decision.stop) return null;
  try {
    const { settings } = await projectSettings(path, operation);
    if (maintenanceKeepSetting(settings) || idleMinutesSetting(settings) === 0) return null;
  } catch {
    return null;
  }
  return decision.idleMs;
}

async function idleWorkspaces(
  config: Config,
  reading: DeviceReading,
  thresholdMs: number,
  setting: string,
  worthIt: (path: string, project: ProjectRecord) => boolean | Promise<boolean>,
): Promise<StageCandidate[]> {
  const readings: (Omit<StageCandidate, 'idleMs'> & { idleMs: number | null })[] = [];
  for (const [path, project] of Object.entries(config.projects)) {
    if (sameRoot(path, reading.protectedRoot) || !(await worthIt(path, project))) continue;
    const used = Date.parse(String(readWorkspaceState(path)?.lastUsedAt ?? ''));
    if (Number.isFinite(used) && Date.now() - used < thresholdMs) continue;
    try {
      const idleMs = (await runsSomething(path, project, reading))
        ? null
        : await idleFor(path, thresholdMs, setting, { operation: reading.operation });
      readings.push({ path, project, idleMs });
    } catch {}
  }
  return longestIdleFirst(readings);
}

async function hasOutputs(path: string): Promise<boolean> {
  return (
    workspaceOutputPaths(workspaceDir(path)).length > 0 ||
    (await existingBuildDirsAsync(path)).length > 0 ||
    existsSync(metroStoreRoot(path))
  );
}

/** Whether the workspace is still idle `thresholdMs`, for a caller that holds its native-run claim. */
export async function stillIdle(path: string, thresholdMs: number, operation?: StimContext): Promise<boolean> {
  return (await idleFor(path, thresholdMs, 'the pressure idle threshold', { locked: true, operation })) !== null;
}

/** Workspaces with nothing running, idle `thresholdMs` by the activity definition, longest-idle first. */
export function idleStageCandidates(
  config: Config,
  reading: DeviceReading,
  thresholdMs: number,
): Promise<StageCandidate[]> {
  return idleWorkspaces(config, reading, thresholdMs, 'the pressure idle threshold', () => true);
}

/** Workspaces with nothing running and regenerable build outputs on disk, idle `thresholdMs`, longest-idle first. */
export function stoppedOutputCandidates(
  config: Config,
  reading: DeviceReading,
  thresholdMs: number,
): Promise<StageCandidate[]> {
  return idleWorkspaces(config, reading, thresholdMs, 'the pressure idle threshold', hasOutputs);
}

type StageResult = Pick<DaemonLadderAction, 'outcome' | 'bytes' | 'detail'>;

/**
 * Deletes a stopped workspace's regenerable build outputs under its native-run and metro-start locks. Null when every
 * output it has is kept, such as a Metro store a running dev server shares.
 */
export async function clearStoppedOutputs(
  candidate: StageCandidate,
  config: Config,
  thresholdMs: number,
  operation?: StimContext,
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
            if ((await idleFor(path, thresholdMs, 'the pressure idle threshold', { locked: true, operation })) === null)
              return { outcome: 'kept', bytes: 0, detail: 'it is no longer idle' };
            const outputs = await idleOutputs(path, config);
            if (!outputs.paths.length) return null;
            const bytes = await deleteOutputs(outputs.paths);
            return {
              outcome: 'done',
              bytes,
              detail: `deleted ${formatBytes(bytes)} of regenerable build outputs${outputs.kept.length ? `; ${outputs.kept.join('; ')}` : ''}`,
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
  { now = Date.now(), graceMs }: { now?: number; graceMs: number },
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
      const { settings } = await resolveProjectSettingsAsync(path);
      if (maintenanceKeepSetting(settings) || idleMinutesSetting(settings) === 0) continue;
    } catch {
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
export async function enterDormantStage(action: MaintenanceAction, operation?: StimContext): Promise<DormantOutcome> {
  const path = action.target;
  const thresholdMs = dormantThresholdMs(action);
  if (thresholdMs === null) return { status: 'kept', bytes: 0, detail: 'the action names no idle threshold' };
  const config = loadConfig();
  const project = config?.projects[path];
  if (!config || !project) return { status: 'kept', bytes: 0, detail: 'it is no longer a registered workspace' };
  const run = await withIdleWorkspace(
    path,
    async (): Promise<DormantOutcome> => {
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
