import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { LOG_ROTATE_BYTES, type StimContext } from '@stim-cli/core';
import {
  DEVICE_IDLE_SHUTDOWN_KEY,
  DEVICE_METRO_IDLE_STOP_REASON,
  IDLE_STAGE_KEY,
  readDeviceIdleShutdowns,
  readIdleStop,
  type DaemonWorkspaceDecision,
  type IdleStageRecord,
} from '@stim-cli/core/state';
import { formatBytes, measuredDirectorySizeAsync } from '../fs-util.ts';
import { collectOwnedDeviceActivityAsync, type OwnedDeviceActivity } from '../commands/gc/idle.ts';
import { canonicalPath } from '../commands/gc/paths.ts';
import { workspaceOutputPaths } from '../commands/gc/workspaces.ts';
import { runIdleStop } from '../commands/stop.ts';
import { isStimOwnedAvd, isStimOwnedSim } from '../devices/device-ownership.ts';
import { holdsDeferredShutdown } from '../devices/deferred-shutdown.ts';
import { projectDeviceSlots } from '../devices/device-slots.ts';
import type { IosSimRecord } from '../devices/ios.ts';
import { withWorkspaceProcessLock, workspaceProcessLockError } from '../engine/workspace-process-lock.ts';
import {
  decideIdleStop,
  hostedFacts,
  idleStopEvidence,
  survivingServer,
  unseenEmulatorError,
  type IdleStopDecision,
} from '../maintenance/idle-stop.ts';
import { createNdjsonWriter } from '../ndjson.ts';
import { metroStoreRoot } from '../supervisor/metro-store.ts';
import { resolveSupervisorTarget } from '../supervisor/ownership.ts';
import { MODE_COMMAND } from '../supervisor/state.ts';
import { getProject, type Config, type ProjectRecord } from '../workspace/config.ts';
import { withIdleWorkspace } from '../workspace/in-use.ts';
import { workspaceDir, workspaceLogsDir } from '../workspace/paths.ts';
import { existingBuildDirsAsync, regenerableDirProblem } from '../workspace/regenerable-dirs.ts';
import {
  idleMinutesSetting,
  maintenanceKeepSetting,
  resolveProjectSettings,
  resolveProjectSettingsAsync,
} from '../workspace/settings.ts';
import { readWorkspaceState, updateWorkspaceStateAsync } from '../workspace/workspace-state.ts';

const MINUTE_MS = 60_000;
const SIZE_TIMEOUT_MS = 60_000;
const SETTING = 'idle.minutes';
/** Under high or critical pressure, the idle stage takes every workspace idle this long (ladder rung 1). */
export const PRESSURE_IDLE_MS: number = 2 * MINUTE_MS;

export interface IdlePassInput {
  config: Config | null;
  now: number;
  sims: IosSimRecord[] | null;
  simsError: string | null;
  devices: OwnedDeviceActivity[];
  /** False in `daemon.mode report`: decide and log, act on nothing. */
  act: boolean;
  /** Set while the pressure level is high or critical: the idle stage then takes every workspace idle 2 minutes. */
  pressure?: { level: 'high' | 'critical'; reasons: string[] };
  /** Leaves out every workspace whose dev server runs, whose own supervisor times its idle stop. */
  unsupervised?: boolean;
  /** A workspace the pass never takes: the one the running command belongs to. */
  protectedRoot?: string;
  /** The daemon tick's context, whose reads run without blocking its event loop. */
  operation?: StimContext;
  log: (level: 'info' | 'warn' | 'error', event: string, msg: string, fields?: Record<string, unknown>) => void;
}

type Candidate =
  | { runs: false }
  | { runs: true; kept: string }
  | { runs: true; idleMs: number; minutes: number; serving: boolean; booted: OwnedDeviceActivity[] };

function thresholdName(input: Pick<IdlePassInput, 'pressure'>): string {
  return input.pressure
    ? `the ${PRESSURE_IDLE_MS / MINUTE_MS}-minute idle threshold of ${input.pressure.level} pressure`
    : SETTING;
}

function thresholdWhy(input: Pick<IdlePassInput, 'pressure'>, minutes: number): string {
  return input.pressure
    ? `pressure level ${input.pressure.level}: ${input.pressure.reasons.join('; ')}`
    : `${SETTING} is ${minutes}`;
}

/** Whether this Stim home owns the device: config records alone do not prove it in a scoped home. */
export function ownedHere(device: OwnedDeviceActivity): boolean {
  return device.kind === 'ios' ? isStimOwnedSim({ udid: device.id, name: device.name }) : isStimOwnedAvd(device.id);
}

function supervisorOf(path: string, project: ProjectRecord) {
  return resolveSupervisorTarget({
    state: readWorkspaceState(path)?.supervisor,
    record: project.supervisor,
    reservedPort: project.metroPort,
  });
}

/**
 * Whether anything of the workspace runs, and what keeps it out of the idle stage whatever its activity: a dev
 * server whose requests Stim cannot see or whose owner it cannot verify, a hosted placement, `maintenance.keep`, an
 * owned device it cannot see, or `idle.minutes` 0.
 */
async function candidate(path: string, project: ProjectRecord, input: IdlePassInput): Promise<Candidate> {
  if (input.protectedRoot && canonicalPath(input.protectedRoot) === canonicalPath(path)) return { runs: false };
  const supervisor = supervisorOf(path, project);
  const state = readWorkspaceState(path);
  const booted = input.devices.filter((device) => device.project === path && ownedHere(device));
  const slots = projectDeviceSlots(project);
  const ownsIos = slots.some(({ platforms }) => platforms.ios?.owned === true);
  const orphan = supervisor.status === 'stale' ? survivingServer(state?.supervisor) : null;
  const serving = supervisor.status === 'ours' || supervisor.status === 'unverified' || orphan !== null;
  if (input.unsupervised && serving) return { runs: false };
  if (ownsIos && input.sims === null)
    return { runs: true, kept: `its simulators cannot be listed (${input.simsError ?? 'unknown error'})` };
  const deferredHere = (device: OwnedDeviceActivity) =>
    device.kind === 'ios' && holdsDeferredShutdown(state, device.slot, device.id, input.now);
  if (!serving && booted.length > 0 && booted.every(deferredHere)) return { runs: false };
  if (!serving && booted.length === 0) {
    const foreign = input.devices.filter((device) => device.project === path && !ownedHere(device));
    if (!foreign.length) return { runs: false };
    return {
      runs: true,
      kept: `${foreign.map((device) => device.name).join(', ')} not in this Stim home's created-devices ledger, so the idle stage leaves it`,
    };
  }
  let minutes: number;
  try {
    const { operation } = input;
    const { settings } = operation
      ? await resolveProjectSettingsAsync(path, { env: operation.env, signal: operation.signal, declareFor: operation })
      : resolveProjectSettings(path);
    if (maintenanceKeepSetting(settings)) return { runs: true, kept: 'pinned by maintenance.keep' };
    minutes = idleMinutesSetting(settings);
  } catch (error) {
    return {
      runs: true,
      kept: `its settings cannot be resolved: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (minutes === 0) return { runs: true, kept: `${SETTING} is 0` };
  if (supervisor.status === 'unverified')
    return {
      runs: true,
      kept: `its dev server supervisor cannot be verified: ${supervisor.reason ?? 'unknown identity'}`,
    };
  if (orphan) return { runs: true, kept: orphan };
  if (supervisor.status === 'ours' && state?.supervisor?.mode === MODE_COMMAND)
    return { runs: true, kept: 'its dev server runs metro.command, whose bundle and HMR requests Stim cannot see' };
  if (supervisor.status === 'ours' && state?.supervisor?.hmrUpdates !== true)
    return {
      runs: true,
      kept: 'its dev server does not report its requests to Stim: an Expo SDK before 54, or a server an older Stim started, which stim stop and stim start restart',
    };
  const hosted = hostedFacts(path);
  if (hosted.unreadable.length) return { runs: true, kept: hosted.unreadable.join('; ') };
  const [placement] = hosted.placements;
  if (placement) return { runs: true, kept: `its ${placement.label} runs on ${placement.machine}` };
  const seen = new Set(booted.flatMap((device) => (device.kind === 'android' ? [device.id] : [])));
  const unseen = slots.flatMap(({ platforms }) =>
    platforms.android?.owned && platforms.android.avdName && !seen.has(platforms.android.avdName)
      ? [platforms.android.avdName]
      : [],
  );
  const emulators = unseen.length ? await unseenEmulatorError(unseen, input.operation) : null;
  if (emulators) return { runs: true, kept: emulators };
  const idleMs = input.pressure ? Math.min(minutes * MINUTE_MS, PRESSURE_IDLE_MS) : minutes * MINUTE_MS;
  return {
    runs: true,
    idleMs,
    minutes: Math.ceil(idleMs / MINUTE_MS),
    serving: supervisor.status === 'ours',
    booted,
  };
}

async function decide(
  path: string,
  project: ProjectRecord,
  input: IdlePassInput,
  locked: boolean,
): Promise<{ candidate: Candidate; decision: IdleStopDecision | null }> {
  const found = await candidate(path, project, input);
  if (!found.runs || 'kept' in found) return { candidate: found, decision: null };
  const now = Date.now();
  const evidence = await idleStopEvidence(path, found.booted, {
    now,
    idleMs: found.idleMs,
    locked,
    serving: found.serving,
    driversBlock: true,
    operation: input.operation,
  });
  return {
    candidate: found,
    decision: decideIdleStop(evidence, { idleMs: found.idleMs, now, setting: thresholdName(input) }),
  };
}

/** The regenerable outputs the idle stage deletes, and why each other one stays. */
export async function idleOutputs(path: string, config: Config): Promise<{ paths: string[]; kept: string[] }> {
  const paths = workspaceOutputPaths(workspaceDir(path));
  const kept: string[] = [];
  for (const dir of await existingBuildDirsAsync(path)) {
    const problem = await regenerableDirProblem(path, dir);
    if (problem) kept.push(`kept ${dir}: ${problem}`);
    else paths.push(dir);
  }
  const store = metroStoreRoot(path);
  if (existsSync(store)) {
    const sharer = Object.entries(config.projects).find(
      ([other, project]) =>
        canonicalPath(other) !== canonicalPath(path) &&
        canonicalPath(metroStoreRoot(other)) === canonicalPath(store) &&
        supervisorOf(other, project).status !== 'none' &&
        supervisorOf(other, project).status !== 'stale',
    );
    if (sharer) kept.push(`kept the Metro store ${store}: the running dev server of ${sharer[0]} shares it`);
    else paths.push(store);
  }
  return { paths, kept };
}

export async function deleteOutputs(paths: readonly string[]): Promise<number> {
  let freed = 0;
  for (const path of paths) {
    freed += (await measuredDirectorySizeAsync(path, { timeoutMs: SIZE_TIMEOUT_MS })) ?? 0;
    await rm(path, { recursive: true, force: true });
  }
  return freed;
}

export function writeWorkspaceEvent(
  root: string,
  level: 'info' | 'warn',
  event: string,
  msg: string,
  fields = {},
): void {
  const writer = createNdjsonWriter(join(workspaceLogsDir(root), 'metro.ndjson'), { maxBytes: LOG_ROTATE_BYTES });
  writer.write({ src: 'metro', level, event, msg, ...fields });
  writer.close();
}

/** Whether `stim revive` resumes the workspace: its dev server recorded an idle stop and its port is still reserved. */
export function revivable(path: string): boolean {
  return readIdleStop(readWorkspaceState(path)) !== null && typeof getProject(path)?.metroPort === 'number';
}

async function recordStage(path: string, minutes: number, shutDown: readonly string[], freedBytes: number) {
  const at = new Date().toISOString();
  const stage: IdleStageRecord = { at, idleMinutes: minutes, freedBytes };
  await updateWorkspaceStateAsync(path, (state) => {
    const shutdowns = { ...readDeviceIdleShutdowns(state) };
    for (const key of shutDown) shutdowns[key] = { at, idleMinutes: minutes, reason: DEVICE_METRO_IDLE_STOP_REASON };
    return {
      ...state,
      [IDLE_STAGE_KEY]: stage,
      ...(shutDown.length ? { [DEVICE_IDLE_SHUTDOWN_KEY]: shutdowns } : {}),
    };
  });
}

/**
 * The idle stage, in one pass under the workspace's native-run and metro-start locks after deciding again: the idle
 * stop (Metro stopped with its port and launch records kept, the owned devices shut down through teardown, their
 * collectors ended), then the workspace's regenerable build outputs, its in-tree build directories and its Metro
 * store deleted.
 */
async function enterIdleStage(
  path: string,
  project: ProjectRecord,
  config: Config,
  input: IdlePassInput,
): Promise<{ outcome: DaemonWorkspaceDecision['outcome']; detail: string; freedBytes?: number }> {
  const run = await withIdleWorkspace(
    path,
    async () => {
      try {
        return await withWorkspaceProcessLock(
          workspaceDir(path),
          'metro-start',
          async () => {
            const devices = await collectOwnedDeviceActivityAsync(
              { ...config, projects: { [path]: project } },
              input.sims ?? [],
              Date.now(),
            );
            const again = await decide(path, project, { ...input, devices }, true);
            if (!again.candidate.runs) return { outcome: 'kept' as const, detail: 'nothing of it runs any more' };
            if ('kept' in again.candidate) return { outcome: 'kept' as const, detail: again.candidate.kept };
            if (!again.decision?.stop)
              return { outcome: 'kept' as const, detail: again.decision?.reason ?? 'its activity cannot be read' };
            const minutes = again.candidate.minutes;
            const booted = new Set(again.candidate.booted.map((device) => `${device.kind}:${device.slot}`));
            const lines: string[] = [];
            const stopped = await runIdleStop({
              root: path,
              idleMinutes: minutes,
              report: (line) => lines.push(line),
              operation: input.operation,
            });
            if (!stopped.ok) return { outcome: 'failed' as const, detail: stopped.summary };
            const shutDown = Object.entries(stopped.outcomes.device).flatMap(([key, outcome]) => {
              const [kind, slot = 'default'] = key.split(':');
              return outcome?.status === 'shut-down' && booted.has(`${kind}:${slot}`) ? [key] : [];
            });
            const outputs = await idleOutputs(path, config);
            const freed = await deleteOutputs(outputs.paths);
            await recordStage(path, minutes, shutDown, freed);
            const idle = Math.floor(again.decision.idleMs / MINUTE_MS);
            const restore = revivable(path) ? 'stim revive' : 'stim ios or stim android';
            const msg = `no activity for ${idle} minutes (${thresholdWhy(input, minutes)}; last: ${again.decision.last.basis}): ${stopped.summary}; deleted ${formatBytes(freed)} of regenerable build outputs${outputs.kept.length ? `; ${outputs.kept.join('; ')}` : ''}. Run ${restore} to resume it.`;
            writeWorkspaceEvent(path, 'info', 'workspace_idle', msg, { freedBytes: freed, restore });
            return { outcome: 'idle' as const, detail: msg, freedBytes: freed };
          },
          {
            external: true,
            waitMs: 0,
            ownerPurpose: 'idle stage',
            signal: input.operation?.signal,
            declareSpawnsFor: input.operation,
          },
        );
      } catch (error) {
        if (workspaceProcessLockError(error))
          return { outcome: 'kept' as const, detail: 'a stim start holds its metro-start lock' };
        throw error;
      }
    },
    { purpose: 'idle stage', devServer: false, hosted: false, hostedMacos: false, operation: input.operation },
  );
  return run.ran ? run.value : { outcome: 'kept', detail: `in use: ${run.reasons.join('; ')}` };
}

/**
 * The activity pass: every registered workspace with something running whose last activity is older than its
 * `idle.minutes`, and that nothing keeps, goes into the idle stage.
 */
export async function runIdlePass(input: IdlePassInput): Promise<DaemonWorkspaceDecision[]> {
  const decisions: DaemonWorkspaceDecision[] = [];
  const config = input.config;
  if (!config) return decisions;
  for (const [path, project] of Object.entries(config.projects)) {
    let entry: DaemonWorkspaceDecision;
    try {
      const { candidate: found, decision } = await decide(path, project, input, false);
      if (!found.runs) continue;
      const last = decision?.last ? { basis: decision.last.basis, at: new Date(decision.last.at).toISOString() } : null;
      if (!decision) entry = { path, lastActivity: last, outcome: 'kept', detail: 'kept' in found ? found.kept : '' };
      else if (!decision.stop)
        entry = { path, lastActivity: last, outcome: decision.active ? 'active' : 'kept', detail: decision.reason };
      else if (!input.act) {
        entry = {
          path,
          lastActivity: last,
          outcome: 'would-idle',
          detail: `no activity for ${Math.floor(decision.idleMs / MINUTE_MS)} minutes; daemon.mode report acts on nothing`,
        };
      } else {
        const result = await enterIdleStage(path, project, config, input);
        entry = { path, lastActivity: last, ...result };
      }
    } catch (error) {
      entry = {
        path,
        lastActivity: null,
        outcome: 'failed',
        detail: error instanceof Error ? error.message : String(error),
      };
    }
    decisions.push(entry);
    if (entry.outcome === 'idle' || entry.outcome === 'would-idle' || entry.outcome === 'failed')
      input.log(
        entry.outcome === 'failed' ? 'warn' : 'info',
        `workspace_${entry.outcome.replace('-', '_')}`,
        `${path}: ${entry.detail}`,
        {
          workspace: path,
        },
      );
  }
  return decisions;
}
