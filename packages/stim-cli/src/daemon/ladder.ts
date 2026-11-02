import { existsSync, rmSync } from 'node:fs';
import { buildCacheRoot, metroCacheRoot, withDirLock } from '@stim-cli/core';
import {
  fingerprintMemoDir,
  fingerprintMemoLock,
  sharedCompilationCache,
  type DaemonLadderAction,
  type DaemonPressure,
  type MaintenanceAction,
  type PressureLevel,
} from '@stim-cli/core/state';
import { pruneCache, type CacheDescriptor } from '../cache/caches.ts';
import { deviceSweepIsScoped } from '../commands/gc/devices.ts';
import type { OwnedDeviceActivity } from '../commands/gc/idle.ts';
import { readParked } from '../devices/sim-pool.ts';
import { formatBytes, measuredDirectorySizeAsync } from '../fs-util.ts';
import { executeAction, type ActContext } from '../maintenance/act.ts';
import { artifactWorktrees, clearArtifact, collectArtifactsAsync } from '../maintenance/artifacts.ts';
import { cacheBlocked } from '../maintenance/measure.ts';
import { cacheEntryProtection, maintenancePinned } from '../maintenance/protect.ts';
import { resolveMaintenanceSettings, type MaintenanceSettings } from '../maintenance/settings.ts';
import { planRung6 } from '../maintenance/sweep.ts';
import type { Config } from '../workspace/config.ts';
import { PRESSURE_IDLE_MS, writeWorkspaceEvent, type IdlePassInput } from './idle.ts';
import {
  clearStoppedOutputs,
  dormantAfterMs,
  dormantCandidates,
  enterDormantStage,
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
function recordAction(context: Pick<RungContext, 'log' | 'actions'>, action: DaemonLadderAction, reason: string): void {
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
  if (action.workspace && action.outcome !== 'kept')
    try {
      writeWorkspaceEvent(action.workspace, level, 'pressure_action', msg, fields);
    } catch {}
}

const actContext = (settings: MaintenanceSettings): ActContext => ({
  settings,
  protectedRoot: '',
  background: true,
});

async function run(
  context: RungContext,
  plan: MaintenanceAction,
  { restore }: { restore?: string } = {},
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
        bytes: plan.bytes,
        detail: 'daemon.mode report acts on nothing',
        ...(restore ? { restore } : {}),
      },
      context.why,
    );
    return;
  }
  let outcome;
  try {
    outcome = await executeAction(plan, actContext(context.settings));
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

/** Rung 1's disk half: the regenerable outputs of workspaces with nothing running, idle 2 minutes or more. */
async function idleOutputsRung(context: RungContext): Promise<void> {
  for (const candidate of await stoppedOutputCandidates(context.config, context, PRESSURE_IDLE_MS)) {
    if (!(await context.stillShort())) return;
    const result = context.act
      ? await clearStoppedOutputs(candidate, context.config, PRESSURE_IDLE_MS)
      : { outcome: 'would' as const, bytes: 0, detail: 'daemon.mode report acts on nothing' };
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
  if (deviceSweepIsScoped()) return;
  const parked = [
    ...readParked('ios').map((record) => ({ id: record.udid, name: record.name, at: record.parkedAt })),
    ...readParked('android').map((record) => ({ id: record.name, name: record.name, at: record.parkedAt })),
  ].toSorted((a, b) => String(a.at).localeCompare(String(b.at)));
  for (const device of parked) {
    if (context.level === 'high' && !(await context.stillShort())) return;
    await run(context, {
      kind: 'would-delete-parked-device',
      target: device.id,
      bytes: 0,
      reason: `parked device ${device.name}, parked ${device.at}`,
    });
  }
}

function rootCache(name: string, dir: string, entriesDepth: number): CacheDescriptor {
  return { name, dir, prune: 'entries', entriesDepth, note: '' };
}

/** Evicts unprotected entries, least recently written first, until `evictBytes` are gone. */
function trim(
  context: RungContext,
  cache: CacheDescriptor,
  evictBytes: number,
  recentDays: number,
): { outcome: DaemonLadderAction['outcome']; bytes: number; detail: string } {
  if (!context.act) return { outcome: 'would', bytes: 0, detail: 'daemon.mode report acts on nothing' };
  const result = pruneCache(cache, {
    olderThanDays: recentDays,
    byMtime: true,
    protect: cacheEntryProtection(context.config),
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
    const result = trim(context, cache, evict, recentDays);
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
      const blocked = cacheBlocked({
        name: 'Swift compilation cache',
        dir: compilation,
        category: 'compilation-cache',
      });
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
        bytes: context.act ? bytes : 0,
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
      ? await enterDormantStage(candidate, context.config, idleMs, context.why)
      : { outcome: 'would' as const, bytes: 0, detail: 'daemon.mode report acts on nothing', deleted: [] };
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
        ...(result.outcome === 'done' ? { restore: 'stim ios or stim android' } : {}),
      },
      `${context.why}; idle ${Math.floor(candidate.idleMs / MINUTE_MS)} minutes`,
    );
  }
}

/** Rung 5, at critical only: node_modules and Pods of idle linked worktrees, each recorded for `stim worktree warm`. */
async function dependenciesRung(context: RungContext): Promise<void> {
  if (context.level !== 'critical') return;
  const options = { now: Date.now(), windowMs: PRESSURE_IDLE_MS, protectedRoot: '', pinned: maintenancePinned };
  const found = await collectArtifactsAsync('dependencies', options, new AbortController().signal);
  const worktrees = artifactWorktrees();
  for (const candidate of found.candidates) {
    if (!(await context.stillShort())) return;
    const workspace = candidate.keys[0];
    const plan: MaintenanceAction = {
      kind: 'would-delete-dependencies',
      target: candidate.path,
      bytes: 0,
      reason: context.why,
      ...(workspace ? { workspace } : {}),
    };
    if (!context.act) {
      await run(context, plan, { restore: 'stim worktree warm' });
      continue;
    }
    let result;
    try {
      result = await clearArtifact(plan, 'dependencies', { ...options, worktrees, requireRestorable: true });
    } catch (error) {
      result = { status: 'failed' as const, bytes: 0, detail: error instanceof Error ? error.message : String(error) };
    }
    recordAction(
      context,
      {
        rung: 5,
        kind: 'delete-dependencies',
        target: candidate.path,
        ...(workspace ? { workspace } : {}),
        outcome: result.status,
        bytes: result.bytes,
        detail: result.detail,
        ...(result.status === 'done' ? { restore: 'stim worktree warm' } : {}),
      },
      context.why,
    );
  }
}

/**
 * Rung 6 now: idle Gradle and Kotlin daemons, and for disk the unpinned Gradle versions, TMPDIR leftovers and the
 * worktree trash. At normal the daily sweep runs the same plan.
 */
async function sweepRung(context: RungContext, causes: readonly Cause[]): Promise<void> {
  const plan = await planRung6(context.settings, { disk: causes.includes('disk') });
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
  if (pressure.level === 'normal') return { actions, pressure };
  const settings = resolveMaintenanceSettings(input.config);
  let current = pressure;
  for (const { rung, relieves, act } of RUNGS) {
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
