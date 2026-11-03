import { existsSync, readdirSync } from 'node:fs';
import {
  currentStage,
  DORMANT_STAGE_KEY,
  readDormantStage,
  type DaemonLadderAction,
  type DormantStageRecord,
} from '@stim-cli/core/state';
import { archiveWorkspace } from '../archive.ts';
import { canonicalPath } from '../commands/gc/paths.ts';
import { deleteProjectDevices, findStaleProjectDevices } from '../commands/gc/devices.ts';
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
} from '../maintenance/idle-stop.ts';
import { metroStoreRoot } from '../supervisor/metro-store.ts';
import { resolveSupervisorTarget } from '../supervisor/ownership.ts';
import type { Config, ProjectRecord } from '../workspace/config.ts';
import { withIdleWorkspace } from '../workspace/in-use.ts';
import { workspaceDir, workspaceLogsDir } from '../workspace/paths.ts';
import { ARTIFACT_DIRS, existingDirsOf } from '../workspace/regenerable-dirs.ts';
import { idleMinutesSetting, maintenanceKeepSetting, resolveProjectSettings } from '../workspace/settings.ts';
import { readWorkspaceState, updateWorkspaceStateAsync } from '../workspace/workspace-state.ts';
import { deleteOutputs, idleOutputs, writeWorkspaceEvent, type IdlePassInput } from './idle.ts';
import { lowestFreeMb, measureDisk } from './measure.ts';

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
  return avds.length > 0 && (await unseenEmulatorError(avds)) !== null;
}

/**
 * How long a workspace with nothing running has had no activity, when that is at least `thresholdMs` and nothing
 * keeps it: a blocker, unreadable evidence, `maintenance.keep`, or `idle.minutes` 0.
 */
async function idleFor(path: string, thresholdMs: number, setting: string, locked = false): Promise<number | null> {
  const now = Date.now();
  const evidence = await idleStopEvidence(path, [], { now, idleMs: thresholdMs, locked });
  const decision = decideIdleStop(evidence, { idleMs: thresholdMs, now, setting });
  if (!decision.stop) return null;
  try {
    const { settings } = resolveProjectSettings(path);
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
  worthIt: (path: string, project: ProjectRecord) => boolean,
): Promise<StageCandidate[]> {
  const found: StageCandidate[] = [];
  for (const [path, project] of Object.entries(config.projects)) {
    if (sameRoot(path, reading.protectedRoot) || !worthIt(path, project)) continue;
    const used = Date.parse(String(readWorkspaceState(path)?.lastUsedAt ?? ''));
    if (Number.isFinite(used) && Date.now() - used < thresholdMs) continue;
    try {
      if (await runsSomething(path, project, reading)) continue;
      const idleMs = await idleFor(path, thresholdMs, setting);
      if (idleMs !== null) found.push({ path, project, idleMs });
    } catch {}
  }
  return found.toSorted((a, b) => b.idleMs - a.idleMs);
}

function hasOutputs(path: string): boolean {
  return (
    workspaceOutputPaths(workspaceDir(path)).length > 0 ||
    existingDirsOf(path, ARTIFACT_DIRS.build).length > 0 ||
    existsSync(metroStoreRoot(path))
  );
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
            if ((await idleFor(path, thresholdMs, 'the pressure idle threshold', true)) === null)
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
          { external: true, waitMs: 0, ownerPurpose: 'pressure ladder' },
        );
      } catch (error) {
        if (workspaceProcessLockError(error))
          return { outcome: 'kept', bytes: 0, detail: 'a stim start holds its metro-start lock' };
        throw error;
      }
    },
    { purpose: 'pressure ladder', devServer: false, hosted: false, hostedMacos: false },
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

/**
 * A workspace the dormant stage will take later, which keeps the daemon alive: registered, not dormant yet, with an
 * owned device or logs to act on, and not kept out by `maintenance.keep` or `idle.minutes` 0. Null when there is none
 * or the stage is off.
 */
export function pendingDormant(config: Config | null): string | null {
  if (!config || dormantAfterMs(config) <= 0) return null;
  for (const [path, project] of Object.entries(config.projects)) {
    if (alreadyDormant(path) || !(ownsDevice(project) || hasLogs(path))) continue;
    try {
      const { settings } = resolveProjectSettings(path);
      if (maintenanceKeepSetting(settings) || idleMinutesSetting(settings) === 0) continue;
    } catch {
      continue;
    }
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
 * The dormant stage, under the workspace's native-run lock after deciding again: its owned simulators and emulators
 * deleted through ledger teardown (the parked pool is untouched), then its logs archived. node_modules and Pods stay.
 */
export async function enterDormantStage(
  candidate: StageCandidate,
  config: Config,
  thresholdMs: number,
  why: string,
): Promise<StageResult & { deleted: string[] }> {
  const { path, project } = candidate;
  const run = await withIdleWorkspace(
    path,
    async (): Promise<StageResult & { deleted: string[] }> => {
      if ((await idleFor(path, thresholdMs, 'idle.dormantDays', true)) === null)
        return { outcome: 'kept', bytes: 0, detail: 'it is no longer idle', deleted: [] };
      const owns = (kind: 'ios' | 'android') =>
        projectDeviceSlots(project).some(({ platforms }) => platforms[kind]?.owned === true);
      let sims: IosSimRecord[] = [];
      let avds: string[] = [];
      try {
        if (owns('ios') && process.platform === 'darwin')
          sims = await listAllIosSimsAsync({ timeoutMs: SIM_LIST_TIMEOUT_MS });
        if (owns('android')) avds = await listAvdsAsync();
      } catch (error) {
        return {
          outcome: 'failed',
          bytes: 0,
          detail: `its owned devices cannot be listed: ${error instanceof Error ? error.message : String(error)}`,
          deleted: [],
        };
      }
      const before = lowestFreeMb(await measureDisk(config));
      const devices = findStaleProjectDevices({
        config: { ...config, projects: { [path]: project } },
        sims,
        avds,
        olderThanDays: 0,
        lastTouched: () => 0,
      });
      const deleted: string[] = [];
      const failures = await deleteProjectDevices([], devices, [], {
        log: () => {},
        error: () => {},
        fail: () => {},
        record: (_kind, status, label) => {
          if (status === 'done') deleted.push(label);
        },
      });
      const logs = hasLogs(path);
      if (logs) await archiveWorkspace(path, 'maintenance', readWorkspaceState(path));
      const archived = logs && !hasLogs(path);
      const freed = Math.max(0, lowestFreeMb(await measureDisk(config)) - before);
      const bytes = Number.isFinite(freed) ? Math.round(freed * 1024 * 1024) : 0;
      const record: DormantStageRecord = {
        at: new Date().toISOString(),
        dormantDays: dormantAfterMs(config) / DAY_MS,
        deletedDevices: deleted,
        archived,
      };
      await updateWorkspaceStateAsync(path, (state) => ({ ...state, [DORMANT_STAGE_KEY]: record }));
      const detail = `no activity for ${Math.floor(candidate.idleMs / MINUTE_MS)} minutes (${why}): ${deleted.length ? `deleted ${deleted.join(', ')}` : 'no owned device to delete'}${failures ? `; ${failures} could not be deleted and stay recorded` : ''}; ${archived ? 'archived its logs' : 'kept its logs (archive.enabled is off or nothing to archive)'}; node_modules and Pods stay. The next stim ios or stim android creates a device.`;
      writeWorkspaceEvent(path, failures ? 'warn' : 'info', 'workspace_dormant', detail, {
        bytes,
        deletedDevices: deleted,
        archived,
        restore: 'stim ios or stim android',
      });
      return { outcome: failures ? 'failed' : 'done', bytes, detail, deleted };
    },
    { purpose: 'dormant stage', devServer: false, hosted: false, hostedMacos: false },
  );
  return run.ran ? run.value : { outcome: 'kept', bytes: 0, detail: `in use: ${run.reasons.join('; ')}`, deleted: [] };
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
      ? await enterDormantStage(candidate, config, afterMs, why)
      : { outcome: 'would' as const, bytes: 0, detail: 'daemon.mode report acts on nothing' };
    const action: DaemonLadderAction = {
      rung: 4,
      kind: 'dormant-stage',
      target: candidate.path,
      workspace: candidate.path,
      outcome: result.outcome,
      bytes: result.bytes,
      detail: result.detail,
      ...(result.outcome === 'done' ? { restore: 'stim ios or stim android' } : {}),
    };
    actions.push(action);
    input.log(
      result.outcome === 'failed' ? 'warn' : 'info',
      `workspace_${result.outcome === 'would' ? 'would_dormant' : result.outcome === 'done' ? 'dormant' : `dormant_${result.outcome}`}`,
      `${candidate.path}: ${result.detail}`,
      { workspace: candidate.path, bytes: result.bytes, restore: 'stim ios or stim android' },
    );
  }
  return actions;
}
