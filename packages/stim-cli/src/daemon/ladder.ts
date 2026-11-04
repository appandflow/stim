import { existsSync, rmSync } from 'node:fs';
import { buildCacheRoot, metroCacheRoot, withDirLock, type StimContext } from '@stim-cli/core';
import {
  fingerprintMemoDir,
  fingerprintMemoLock,
  sharedCompilationCache,
  type DaemonLadderAction,
  type DaemonPressure,
  type MaintenanceAction,
  type PressureLevel,
} from '@stim-cli/core/state';
import { discoverCachesAsync, pruneCache, type CacheDescriptor } from '../cache/caches.ts';
import { deviceSweepIsScoped } from '../commands/gc/devices.ts';
import { canonicalPath } from '../commands/gc/paths.ts';
import type { OwnedDeviceActivity } from '../commands/gc/idle.ts';
import { ownedAvdDirectory } from '../devices/android.ts';
import { projectDeviceSlots } from '../devices/device-slots.ts';
import type { IosSimRecord } from '../devices/ios.ts';
import { readParked } from '../devices/sim-pool.ts';
import { restoreProblem } from '../workspace/lightened.ts';
import { formatBytes, measuredDirectorySizeAsync } from '../fs-util.ts';
import { executeAction, type ActContext } from '../maintenance/act.ts';
import { artifactWorktreesFor } from '../maintenance/artifacts.ts';
import { cacheBlocked } from '../maintenance/measure.ts';
import { cacheEntryProtectionFor } from '../maintenance/protect.ts';
import { resolveMaintenanceSettings, type MaintenanceSettings } from '../maintenance/settings.ts';
import { planRung6 } from '../maintenance/sweep.ts';
import type { Config, ProjectRecord } from '../workspace/config.ts';
import { runBootedParkedPass } from './booted-parked.ts';
import { clearDependency, rankDependencies, selectDependencies } from './dependencies.ts';
import { idleOutputs, PRESSURE_IDLE_MS, writeWorkspaceEvent, type IdlePassInput } from './idle.ts';
import {
  clearStoppedOutputs,
  dormantAfterMs,
  dormantCandidates,
  enterDormantStage,
  idleStageCandidates,
  stoppedOutputCandidates,
} from './stages.ts';

const MINUTE_MS = 60_000;
const GIB = 1024 ** 3;
const SIZE_TIMEOUT_MS = 120_000;
/** Under high pressure the dormant stage takes workspaces idle this long (ladder rung 4). */
const DORMANT_HIGH_IDLE_MS = 10 * MINUTE_MS;

type Cause = 'disk' | 'memory';

export interface LadderInput {
  config: Config;
  /** False in `daemon.mode report`: plan and log each action, act on nothing. */
  act: boolean;
  log: IdlePassInput['log'];
  devices: OwnedDeviceActivity[];
  /** Whether the tick's `simctl list` failed, so no workspace that owns a simulator is touched. */
  simsFailed: boolean;
  /** Measures disk and memory again and classifies them. */
  remeasure: () => Promise<DaemonPressure>;
  /** The first rung to run; a command with no daemon starts at 2, since rung 1 belongs to the activity pass. */
  fromRung?: number;
  /**
   * Runs every rung at this level whatever the machine measures, without stopping once the level clears: what
   * `stim gc --delete` runs, and what `stim gc` previews at each level.
   */
  force?: { level: 'high' | 'critical'; why: string; parkedOlderThanDays?: number };
  /** Measures what each action would free when it does not act, for `stim gc`'s preview. */
  measure?: boolean;
  /** The tick's `simctl list`, whose data path sizes the preview reports for simulators. */
  sims?: readonly IosSimRecord[] | null;
  /** The command running the ladder in its own process, whose environment and cancellation its reads use. */
  operation?: StimContext;
  /** The workspace of the command that runs the ladder, which no rung takes. */
  protectedRoot?: string;
}

interface RungContext extends LadderInput {
  rung: number;
  level: PressureLevel;
  pressure: DaemonPressure;
  settings: MaintenanceSettings;
  actions: DaemonLadderAction[];
  /** Measures again; true while the causes this rung relieves are still above normal. */
  stillShort: () => Promise<boolean>;
  why: string;
}

/** Logs one ladder action to `daemon.ndjson` and the workspace's `metro.ndjson`, and keeps it for the snapshot. */
function recordAction(
  context: Pick<RungContext, 'log' | 'actions' | 'force'>,
  action: DaemonLadderAction,
  reason: string,
): void {
  context.actions.push(action);
  const verb =
    action.outcome === 'would'
      ? 'would'
      : action.outcome === 'done'
        ? 'did'
        : action.outcome === 'kept'
          ? 'kept'
          : 'failed to';
  const msg = `rung ${action.rung}: ${verb} ${action.kind.replaceAll('-', ' ')} ${action.target} (${formatBytes(action.bytes)} freed): ${action.detail}; ${reason}${action.restore ? `; restore with ${action.restore}` : ''}`;
  const level = action.outcome === 'failed' ? 'warn' : 'info';
  const fields = {
    rung: action.rung,
    kind: action.kind,
    target: action.target,
    outcome: action.outcome,
    bytes: action.bytes,
    reason,
    ...(action.restore ? { restore: action.restore } : {}),
    ...(action.workspace ? { workspace: action.workspace } : {}),
  };
  context.log(level, 'pressure_action', msg, fields);
  if (action.workspace && action.outcome !== 'kept' && !(context.force && action.outcome === 'would'))
    try {
      writeWorkspaceEvent(action.workspace, level, 'pressure_action', msg, fields);
    } catch {}
}

/** The bytes of the regenerable build outputs the idle stage would delete in a workspace. */
export async function idleOutputBytes(path: string, config: Config): Promise<number> {
  return pathsBytes((await idleOutputs(path, config)).paths);
}

async function pathsBytes(paths: readonly string[]): Promise<number> {
  let total = 0;
  for (const path of paths) total += (await measuredDirectorySizeAsync(path, { timeoutMs: SIZE_TIMEOUT_MS })) ?? 0;
  return total;
}

/** The disk an owned simulator or AVD takes, from `simctl list`'s data path size or the AVD directory. */
async function deviceBytes(
  context: Pick<LadderInput, 'sims'>,
  platform: 'ios' | 'android',
  id: string,
): Promise<number> {
  if (platform === 'ios') return context.sims?.find((sim) => sim.udid === id)?.dataPathSize ?? 0;
  const dir = ownedAvdDirectory(id);
  return dir ? await pathsBytes([dir]) : 0;
}

/** The disk a workspace's owned simulators and emulators take. */
async function workspaceDeviceBytes(context: Pick<LadderInput, 'sims'>, project: ProjectRecord): Promise<number> {
  let total = 0;
  for (const { platforms } of projectDeviceSlots(project)) {
    if (platforms.ios?.owned && platforms.ios.deviceUdid)
      total += await deviceBytes(context, 'ios', platforms.ios.deviceUdid);
    if (platforms.android?.owned && platforms.android.avdName)
      total += await deviceBytes(context, 'android', platforms.android.avdName);
  }
  return total;
}

const actContext = (settings: MaintenanceSettings): ActContext => ({
  settings,
  protectedRoot: '',
  background: true,
});

async function run(
  context: RungContext,
  plan: MaintenanceAction,
  { restore, bytes }: { restore?: string; bytes?: () => Promise<number> } = {},
): Promise<void> {
  if (!context.act) {
    recordAction(
      context,
      {
        rung: context.rung,
        kind: plan.kind.replace(/^would-/, ''),
        target: plan.target,
        ...(plan.workspace ? { workspace: plan.workspace } : {}),
        outcome: 'would',
        bytes: context.measure && bytes ? await bytes() : plan.bytes,
        detail: wouldDetail(context),
        ...(restore ? { restore } : {}),
      },
      context.why,
    );
    return;
  }
  let outcome;
  try {
    outcome = await executeAction(plan, { ...actContext(context.settings), operation: context.operation });
  } catch (error) {
    outcome = { status: 'failed' as const, bytes: 0, detail: error instanceof Error ? error.message : String(error) };
  }
  recordAction(
    context,
    {
      rung: context.rung,
      kind: plan.kind.replace(/^would-/, ''),
      target: plan.target,
      ...(plan.workspace ? { workspace: plan.workspace } : {}),
      outcome: outcome.status,
      bytes: outcome.bytes,
      detail: outcome.detail,
      ...(restore && outcome.status === 'done' ? { restore } : {}),
    },
    context.why,
  );
}

function wouldDetail(context: Pick<RungContext, 'force'>): string {
  return context.force ? 'stim gc --delete would do this' : 'daemon.mode report acts on nothing';
}

/** Rung 0, before the idle stage: the parked simulators kept booted for a later adoption, which hold memory for nothing in use. */
async function bootedParkedRung(context: RungContext): Promise<void> {
  context.actions.push(
    ...(await runBootedParkedPass({
      sims: context.sims ?? null,
      memory: context.level === 'critical' ? 'critical' : 'warning',
      act: context.act,
      log: context.log,
      operation: context.operation,
      all: true,
    })),
  );
}

/** Rung 1's disk half: the regenerable outputs of workspaces with nothing running, idle 2 minutes or more. */
async function idleOutputsRung(context: RungContext): Promise<void> {
  for (const candidate of await stoppedOutputCandidates(context.config, context, PRESSURE_IDLE_MS)) {
    if (!(await context.stillShort())) return;
    const result = context.act
      ? await clearStoppedOutputs(candidate, context.config, PRESSURE_IDLE_MS, context.operation)
      : {
          outcome: 'would' as const,
          bytes: context.measure ? await idleOutputBytes(candidate.path, context.config) : 0,
          detail: wouldDetail(context),
        };
    if (!result) continue;
    recordAction(
      context,
      {
        rung: 1,
        kind: 'delete-build-outputs',
        target: candidate.path,
        workspace: candidate.path,
        ...result,
        ...(result.outcome === 'done'
          ? { restore: 'the next stim ios or stim android, from the build cache when nothing changed' }
          : {}),
      },
      `${context.why}; idle ${Math.floor(candidate.idleMs / MINUTE_MS)} minutes`,
    );
  }
}

/** Rung 2: parked devices, oldest first; at high until the level clears, at critical all of them. */
async function parkedRung(context: RungContext): Promise<void> {
  if (deviceSweepIsScoped(context.operation?.env)) return;
  const parked = [
    ...readParked('ios').map((record) => ({
      platform: 'ios' as const,
      id: record.udid,
      name: record.name,
      at: record.parkedAt,
    })),
    ...readParked('android').map((record) => ({
      platform: 'android' as const,
      id: record.name,
      name: record.name,
      at: record.parkedAt,
    })),
  ].toSorted((a, b) => String(a.at).localeCompare(String(b.at)));
  const days = context.force?.parkedOlderThanDays;
  const cutoff = days === undefined ? Infinity : Date.now() - days * 86_400_000;
  for (const device of parked.filter((entry) => !(Date.parse(String(entry.at)) > cutoff))) {
    if (context.level === 'high' && !(await context.stillShort())) return;
    await run(
      context,
      {
        kind: 'would-delete-parked-device',
        target: device.id,
        bytes: 0,
        reason: `parked device ${device.name}, parked ${device.at}`,
      },
      { bytes: () => deviceBytes(context, device.platform, device.id) },
    );
  }
}

function rootCache(name: string, dir: string, entriesDepth: number): CacheDescriptor {
  return { name, dir, prune: 'entries', entriesDepth, note: '' };
}

/** Evicts unprotected entries, least recently written first, until `evictBytes` are gone. */
async function trim(
  context: RungContext,
  cache: CacheDescriptor,
  evictBytes: number,
  recentDays: number,
): Promise<{ outcome: DaemonLadderAction['outcome']; bytes: number; detail: string }> {
  if (!context.act)
    return {
      outcome: 'would',
      bytes: !context.measure
        ? 0
        : Number.isFinite(evictBytes)
          ? evictBytes
          : ((await measuredDirectorySizeAsync(cache.dir, { timeoutMs: SIZE_TIMEOUT_MS })) ?? 0),
      detail: wouldDetail(context),
    };
  const result = pruneCache(cache, {
    olderThanDays: recentDays,
    byMtime: true,
    protect: await cacheEntryProtectionFor(context.config, context.operation),
    evictBytes,
  });
  if (result.skipped) return { outcome: 'kept', bytes: 0, detail: result.skipped };
  const kept = result.protectedEntries ? `; ${result.protectedEntries} protected entries kept` : '';
  if (result.failed)
    return { outcome: 'failed', bytes: result.bytes, detail: `${result.failed} entries failed${kept}` };
  return result.removed
    ? { outcome: 'done', bytes: result.bytes, detail: `${result.removed} entries${kept}` }
    : { outcome: 'kept', bytes: 0, detail: `no unprotected entry to evict${kept}` };
}

/**
 * Rung 3, the shared caches: at high, each trimmed least recently used first to half its cap (the compilation cache,
 * which can only be emptied whole, emptied once over half its cap); at critical, the Metro cache and the compilation
 * cache emptied, the build cache trimmed to its protected entries, and the fingerprint memo emptied.
 */
async function cachesRung(context: RungContext): Promise<void> {
  const critical = context.level === 'critical';
  const recentDays = critical ? 0 : context.settings.protectRecentHours / 24;
  const entries = [
    { cache: rootCache('Build cache', buildCacheRoot(), 2), capGb: context.settings.buildCacheMaxGb },
    { cache: rootCache('Metro transform caches', metroCacheRoot(), 3), capGb: context.settings.metroCacheMaxGb },
  ];
  for (const { cache, capGb } of entries) {
    if (!existsSync(cache.dir) || !(await context.stillShort())) continue;
    let evict = Infinity;
    if (!critical) {
      const bytes = await measuredDirectorySizeAsync(cache.dir, { timeoutMs: SIZE_TIMEOUT_MS });
      const target = (capGb * GIB) / 2;
      if (capGb === 0 || bytes === null || bytes <= target) continue;
      evict = bytes - target;
    }
    const result = await trim(context, cache, evict, recentDays);
    recordAction(
      context,
      { rung: 3, kind: critical ? 'empty-cache' : 'trim-cache', target: cache.dir, ...result },
      critical
        ? `${context.why}; ${cache.name === 'Build cache' ? 'trimmed to the entries a workspace, parked device or build still uses' : 'emptied except what a running dev server uses'}`
        : `${context.why}; trimmed to half of its ${capGb} GB cap`,
    );
  }
  const compilation = sharedCompilationCache();
  if (existsSync(compilation) && (await context.stillShort())) {
    const bytes = await measuredDirectorySizeAsync(compilation, { timeoutMs: SIZE_TIMEOUT_MS });
    const capGb = context.settings.swiftCompilationCacheMaxGb;
    if (bytes !== null && (critical || (capGb > 0 && bytes > (capGb * GIB) / 2))) {
      const blocked = cacheBlocked(
        { name: 'Swift compilation cache', dir: compilation, category: 'compilation-cache' },
        await discoverCachesAsync(),
      );
      if (blocked)
        recordAction(
          context,
          { rung: 3, kind: 'empty-cache', target: compilation, outcome: 'kept', bytes: 0, detail: blocked },
          context.why,
        );
      else
        await run(context, {
          kind: 'would-empty-cache',
          target: compilation,
          dir: compilation,
          bytes,
          reason: 'it can only be emptied whole',
        });
    }
  }
  const memo = fingerprintMemoDir();
  if (critical && existsSync(memo) && (await context.stillShort())) {
    const bytes = (await measuredDirectorySizeAsync(memo, { timeoutMs: SIZE_TIMEOUT_MS })) ?? 0;
    if (context.act) withDirLock(fingerprintMemoLock(), () => rmSync(memo, { recursive: true, force: true }));
    recordAction(
      context,
      {
        rung: 3,
        kind: 'empty-cache',
        target: memo,
        outcome: context.act ? 'done' : 'would',
        bytes: context.act || context.measure ? bytes : 0,
        detail: 'the next build fingerprints its tree in full',
      },
      context.why,
    );
  }
}

/** Rung 4: the dormant stage now, longest-idle first: at high for workspaces idle 10 minutes, at critical every idle one. */
async function dormantRung(context: RungContext): Promise<void> {
  if (dormantAfterMs(context.config) <= 0) return;
  const idleMs = context.level === 'critical' ? PRESSURE_IDLE_MS : DORMANT_HIGH_IDLE_MS;
  for (const candidate of await dormantCandidates(context.config, context, idleMs)) {
    if (!(await context.stillShort())) return;
    const result = context.act
      ? await enterDormantStage(candidate, context.config, idleMs, context.why, context.operation)
      : {
          outcome: 'would' as const,
          bytes: context.measure ? await workspaceDeviceBytes(context, candidate.project) : 0,
          detail: wouldDetail(context),
          deleted: [],
          restore: '',
        };
    recordAction(
      context,
      {
        rung: 4,
        kind: 'dormant-stage',
        target: candidate.path,
        workspace: candidate.path,
        outcome: result.outcome,
        bytes: result.bytes,
        detail: result.detail,
        ...(result.outcome === 'done' ? { restore: result.restore } : {}),
      },
      `${context.why}; idle ${Math.floor(candidate.idleMs / MINUTE_MS)} minutes`,
    );
  }
}

function canonicalOrNull(path: string): string | null {
  try {
    return canonicalPath(path);
  } catch {
    return null;
  }
}

/**
 * Rung 5, at critical only: node_modules and Pods of linked worktrees whose workspace in this Stim home is idle 2
 * minutes by the activity definition with nothing running, each recorded for `stim worktree warm`: those holding
 * REAL_BYTES_THRESHOLD or more private bytes, most first, then those of unknown size, longest-idle first. A
 * copy-on-write clone below the threshold is kept.
 */
async function dependenciesRung(context: RungContext): Promise<void> {
  if (context.level !== 'critical') return;
  const idle = await idleStageCandidates(context.config, context, PRESSURE_IDLE_MS);
  const protectedRoot = context.protectedRoot ? (canonicalOrNull(context.protectedRoot) ?? '') : '';
  const { take, kept } = selectDependencies(await rankDependencies(idle, protectedRoot, context.operation), 'take');
  for (const { dependency, detail } of kept)
    recordAction(
      context,
      {
        rung: 5,
        kind: 'delete-dependencies',
        target: dependency.candidate.path,
        workspace: dependency.workspace,
        outcome: 'kept',
        bytes: 0,
        detail,
      },
      context.why,
    );
  const worktrees = take.length ? await artifactWorktreesFor(context.operation) : [];
  const restoreCache: Parameters<typeof restoreProblem>[1] = new Map();
  for (const dependency of take) {
    if (!(await context.stillShort())) return;
    const why =
      dependency.privateBytes === null
        ? `${context.why}; its real size is unknown`
        : `${context.why}; ${formatBytes(dependency.privateBytes)} of it is its own`;
    const plan: MaintenanceAction = {
      kind: 'would-delete-dependencies',
      target: dependency.candidate.path,
      bytes: dependency.privateBytes ?? 0,
      reason: why,
      workspace: dependency.workspace,
    };
    if (!context.act) {
      const unrestorable = await restoreProblem(dependency.candidate, restoreCache, context.operation);
      if (unrestorable)
        recordAction(
          context,
          {
            rung: 5,
            kind: 'delete-dependencies',
            target: dependency.candidate.path,
            workspace: dependency.workspace,
            outcome: 'kept',
            bytes: 0,
            detail: unrestorable,
          },
          why,
        );
      else
        await run({ ...context, why }, plan, {
          restore: 'stim worktree warm',
          bytes: async () => dependency.privateBytes ?? (await pathsBytes([dependency.candidate.path])),
        });
      continue;
    }
    const result = await clearDependency(
      dependency,
      PRESSURE_IDLE_MS,
      protectedRoot,
      worktrees,
      why,
      context.operation,
    );
    recordAction(
      context,
      {
        rung: 5,
        kind: 'delete-dependencies',
        target: dependency.candidate.path,
        workspace: dependency.workspace,
        outcome: result.status,
        bytes: result.bytes,
        detail: result.detail,
        ...(result.status === 'done' ? { restore: 'stim worktree warm' } : {}),
      },
      why,
    );
  }
}

/**
 * Rung 6 now: idle Gradle and Kotlin daemons, and for disk the unpinned Gradle versions, TMPDIR leftovers and the
 * worktree trash. At normal the daily sweep runs the same plan.
 */
async function sweepRung(context: RungContext, causes: readonly Cause[]): Promise<void> {
  const plan = await planRung6(context.settings, { disk: causes.includes('disk'), operation: context.operation });
  for (const action of plan.actions) {
    if (!(await context.stillShort())) return;
    await run(context, action);
  }
}

const RUNGS: {
  rung: number;
  relieves: readonly Cause[];
  act: (context: RungContext, causes: Cause[]) => Promise<void>;
}[] = [
  { rung: 0, relieves: ['memory'], act: bootedParkedRung },
  { rung: 1, relieves: ['disk'], act: idleOutputsRung },
  { rung: 2, relieves: ['disk'], act: parkedRung },
  { rung: 3, relieves: ['disk'], act: cachesRung },
  { rung: 4, relieves: ['disk'], act: dormantRung },
  { rung: 5, relieves: ['disk'], act: dependenciesRung },
  { rung: 6, relieves: ['disk', 'memory'], act: sweepRung },
];

function causesOf(pressure: DaemonPressure, relieves: readonly Cause[]): Cause[] {
  return relieves.filter((cause) => pressure[cause] !== 'normal');
}

function levelOf(pressure: DaemonPressure, causes: readonly Cause[]): PressureLevel {
  return causes.some((cause) => pressure[cause] === 'critical') ? 'critical' : causes.length ? 'high' : 'normal';
}

/**
 * The pressure ladder after the activity pass, whose idle stage at 2 minutes is rung 1: rungs 1 to 6 top-down while
 * the level stays above normal, each measuring again before it acts and running only for the causes it relieves (a
 * memory level runs the Gradle daemons of rung 6; the devices of rung 1 are the activity pass's). Each rung skips
 * every workspace with a blocker and takes the longest-idle first. Returns the actions and the last measurement.
 */
export async function runLadder(
  input: LadderInput,
  pressure: DaemonPressure,
): Promise<{ actions: DaemonLadderAction[]; pressure: DaemonPressure }> {
  const actions: DaemonLadderAction[] = [];
  const settings = resolveMaintenanceSettings(input.config);
  const { force } = input;
  if (force) {
    for (const { rung, act } of RUNGS) {
      if (rung < (input.fromRung ?? 0)) continue;
      const context: RungContext = {
        ...input,
        rung,
        level: force.level,
        pressure,
        settings,
        actions,
        stillShort: async () => true,
        why: force.why,
      };
      try {
        await act(context, ['disk', 'memory']);
      } catch (error) {
        input.log(
          'warn',
          'pressure_rung_failed',
          `rung ${rung} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return { actions, pressure };
  }
  if (pressure.level === 'normal') return { actions, pressure };
  let current = pressure;
  for (const { rung, relieves, act } of RUNGS) {
    if (rung < (input.fromRung ?? 0)) continue;
    current = await input.remeasure();
    if (current.level === 'normal') break;
    const causes = causesOf(current, relieves);
    if (!causes.length) continue;
    const stillShort = async () => {
      current = await input.remeasure();
      return causesOf(current, relieves).length > 0;
    };
    const context: RungContext = {
      ...input,
      rung,
      level: levelOf(current, causes),
      pressure: current,
      settings,
      actions,
      stillShort,
      why: `pressure level ${current.level}: ${current.reasons.join('; ')}`,
    };
    try {
      await act(context, causes);
    } catch (error) {
      input.log(
        'warn',
        'pressure_rung_failed',
        `rung ${rung} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return { actions, pressure: current };
}
