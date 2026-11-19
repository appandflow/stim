import { isClaimUnavailable } from '@stim-cli/core/ownership-claim';
import { existsSync, rmSync } from 'node:fs';
import { join, sep } from 'node:path';
import { buildCacheRoot, configDir, isScopedHome, metroCacheRoot, withDirLock, type StimContext } from '@stim-cli/core';
import {
  fingerprintIndexDir,
  fingerprintIndexLock,
  sharedCompilationCache,
  type DaemonLadderAction,
  type DaemonPressure,
  type MaintenanceAction,
  type PressureLevel,
} from '@stim-cli/core/state';
import { discoverCachesAsync, pruneCache, type CacheDescriptor } from '../cache/caches.ts';
import { deviceSweepIsScoped, SCOPED_PARKED_KEEP } from '../commands/gc/devices.ts';
import { readCreatedDevices } from '../devices/created-devices.ts';
import { canonicalPath } from '../commands/gc/paths.ts';
import type { OwnedDeviceActivity } from '../commands/gc/idle.ts';
import { ownedAvdDirectory } from '../devices/android.ts';
import { projectDeviceSlots } from '../devices/device-slots.ts';
import type { IosSimRecord } from '../devices/ios.ts';
import { readParked } from '../devices/sim-pool.ts';
import { restoreProblem } from '../workspace/lightened.ts';
import { workspaceDir } from '../workspace/paths.ts';
import { freshLaunchers, launchingOf, type Launching } from '../workspace/launchers.ts';
import { formatBytes, measuredDirectorySizeAsync } from '../fs-util.ts';
import { describeSizeFailure, lastSizeFailure } from '../size-failures.ts';
import { timedStep } from './step-timing.ts';
import { forgetGitReads } from '../workspace/git-reads.ts';
import { executeAction, type ActContext, type ActionOutcome } from '../stimd/passes/act.ts';
import { artifactWorktreesFor } from '../stimd/passes/artifacts.ts';
import { cacheBlocked } from '../stimd/passes/measure.ts';
import { cacheEntryProtectionFor, maintenancePinned, maintenancePinnedReader } from '../stimd/passes/protect.ts';
import { executedActionName } from '../maintenance-kind.ts';
import { measuredDiskLevel, planCargoTargetsAtPressure } from '../stimd/passes/cargo-target.ts';
import { resolveMaintenanceSettings, type MaintenanceSettings } from '../stimd/passes/settings.ts';
import { planRung6, planWorktrees } from '../stimd/passes/sweep.ts';
import { planHistory } from '../stimd/passes/records.ts';
import { planCacheEmptying } from '../commands/gc/caches.ts';
import { isInsideWorkspaces } from '../commands/gc/workspaces.ts';
import { DEFAULT_WORKTREE_IDLE_DAYS, type WorktreeSweep } from '../commands/gc/worktrees.ts';
import { causesOf, dormantAction, rungDecision, rungsFrom, type Cause, type Rung } from '../policy/pressure.ts';
import { loadConfig, type Config, type ProjectRecord } from '../workspace/config.ts';
import { runBootedParkedPass } from './booted-parked.ts';
import { measureDisk } from './measure.ts';
import { diskThresholds, shortVolumeDevices } from './pressure.ts';
import { collectInventory } from '../commands/gc/inventory.ts';
import {
  cleanToolCache,
  onShortVolume,
  reportedBytes,
  reportedCaches,
  surveyToolCaches,
} from '../stimd/passes/unowned.ts';
import {
  clearDependency,
  clearSourceCheckouts,
  rankDependencies,
  rankSourceDependencies,
  sampleLinks,
  wouldDelete,
  selectDependencies,
  SOURCE_RESTORE,
} from './dependencies.ts';
import {
  idleOutputs,
  PRESSURE_IDLE_MS,
  serverPid,
  stopServerForDeletion,
  storeSharer,
  writeWorkspaceEvent,
  type IdlePassInput,
} from './idle.ts';
import { metroStoreRoot } from '../stimd/metro/metro-store.ts';
import {
  clearServerStore,
  clearStoppedOutputs,
  deleteRunningDevices,
  deviceDataDirs,
  dormantAfterMs,
  dormantCandidates,
  idleStageCandidates,
  stoppedOutputCandidates,
  stillIdleUnderClaim,
  stoppedOutputs,
  type StageCandidate,
} from './stages.ts';

const MINUTE_MS = 60_000;
const GIB = 1024 ** 3;
const SIZE_TIMEOUT_MS = 120_000;
/** Under high pressure the dormant stage takes workspaces idle this long (ladder rung 4). */
const DORMANT_HIGH_IDLE_MS = 10 * MINUTE_MS;
const DEPENDENCIES_HIGH_IDLE_MS = 60 * MINUTE_MS;
const UNOWNED_EVERY_MS = 60 * MINUTE_MS;
let unownedRunAt = -Infinity;

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
   * `stim gc` runs at high or critical, and what `stim gc --dry-run` previews.
   */
  force?: { level: 'high' | 'critical'; why: string; measured?: boolean };
  /** The last rung to run; an in-process command ladder stops before rung 9, whose Gradle caches its own build reads. */
  lastRung?: number;
  /** Measures what each action would free when it does not act, for `stim gc --dry-run`. */
  measure?: boolean;
  /** The tick's `simctl list`, whose data path sizes the preview reports for simulators. */
  sims?: readonly IosSimRecord[] | null;
  /** The command running the ladder in its own process, whose environment and cancellation its reads use. */
  operation?: StimContext;
  /** The workspace of the command that runs the ladder, which no rung takes. */
  protectedRoot?: string;
  /** Aborts at a build's headroom deadline; a Cargo target trim in flight stops between units. */
  stop?: AbortSignal;
  /** The device id of the one volume a build's headroom run frees; without it, the volumes under `disk.minFreeGb`. */
  volume?: number;
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
  /** The devices of the volumes a disk rung frees, measured at the rung's start; null treats every volume as short. */
  short: ReadonlySet<number> | null;
}

/** Logs one ladder action to `daemon.ndjson` and the workspace's `metro.ndjson`, and keeps it for the snapshot. */
function recordAction(
  context: Pick<RungContext, 'log' | 'actions' | 'force' | 'operation'>,
  action: DaemonLadderAction,
  reason: string,
  unsized?: true,
): void {
  context.actions.push(action);
  if (action.outcome === 'done' || action.outcome === 'failed') forgetGitReads(context.operation);
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
    ...(unsized ? { unsized } : {}),
  };
  context.log(level, 'pressure_action', msg, fields);
  if (action.workspace && action.outcome !== 'kept' && !(context.force && action.outcome === 'would'))
    try {
      writeWorkspaceEvent(action.workspace, level, 'pressure_action', msg, fields);
    } catch {}
}

/** The bytes of the regenerable build outputs the idle stage would delete in a workspace. */
export async function idleOutputBytes(path: string, config: Config, launching: Launching): Promise<number> {
  return pathsBytes((await idleOutputs(path, config, launching)).paths);
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
  {
    restore,
    bytes,
    worktreeSweep,
  }: { restore?: string; bytes?: () => Promise<number>; worktreeSweep?: WorktreeSweep } = {},
): Promise<void> {
  if (!context.act) {
    recordAction(
      context,
      {
        rung: context.rung,
        kind: executedActionName(plan),
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
  context.operation?.signal.throwIfAborted();
  let outcome: ActionOutcome;
  try {
    outcome = await executeAction(plan, {
      ...actContext(context.settings),
      protectedRoot: context.protectedRoot ? (canonicalOrNull(context.protectedRoot) ?? '') : '',
      operation: context.operation,
      ...(context.stop ? { stop: context.stop } : {}),
      ...(worktreeSweep ? { worktreeSweep } : {}),
      ...(context.short ? { deletable: deletable(context) } : {}),
    });
  } catch (error) {
    if (isClaimUnavailable(error)) throw error;
    context.operation?.signal.throwIfAborted();
    outcome = { status: 'failed' as const, bytes: 0, detail: error instanceof Error ? error.message : String(error) };
  }
  const restored = outcome.status === 'done' ? (outcome.restore ?? restore) : undefined;
  recordAction(
    context,
    {
      rung: context.rung,
      kind: executedActionName(plan),
      target: plan.target,
      ...(plan.workspace ? { workspace: plan.workspace } : {}),
      outcome: outcome.status,
      bytes: outcome.bytes,
      detail: outcome.detail,
      ...(restored ? { restore: restored } : {}),
    },
    context.why,
  );
}

function wouldDetail(context: Pick<RungContext, 'force'>): string {
  return context.force ? 'stim gc would do this' : 'daemon.mode report acts on nothing';
}

/** Whether every path a step would delete, and at least one, lies on a volume this rung frees. */
function onShort(context: Pick<RungContext, 'short'>, paths: readonly string[]): boolean {
  return context.short === null || (paths.length > 0 && paths.every((path) => onShortVolume([path], context.short)));
}

function deletable(context: Pick<RungContext, 'short'>): ((path: string) => boolean) | undefined {
  return context.short === null ? undefined : (path) => onShort(context, [path]);
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

/**
 * Rung 1's disk half: the regenerable outputs of workspaces idle 2 minutes or more, whether or not their dev server or
 * an owned device runs, which keep running.
 */
async function idleOutputsRung(context: RungContext): Promise<void> {
  const level = context.level === 'critical' ? 'critical' : 'high';
  // @ref LLP 0001#the-2-minute-idle-stop-is-for-memory -- outputs go without stopping what runs
  for (const candidate of await stoppedOutputCandidates(context.config, context, PRESSURE_IDLE_MS, level)) {
    if (!(await context.stillShort())) return;
    let result: Awaited<ReturnType<typeof clearStoppedOutputs>>;
    if (context.act)
      result = await clearStoppedOutputs(
        candidate,
        context.config,
        PRESSURE_IDLE_MS,
        context.operation,
        deletable(context),
        { reading: context, level },
      );
    else {
      const outputs = await stoppedOutputs(
        candidate,
        context.config,
        launchingOf(
          candidate.checkout,
          () => freshLaunchers(context.operation, context.operation?.signal)(),
          context.operation,
          context.operation?.signal,
        ),
        context.operation,
        deletable(context),
      );
      const paths = 'paths' in outputs ? outputs.paths : [];
      result = paths.length
        ? { outcome: 'would', bytes: context.measure ? await pathsBytes(paths) : 0, detail: wouldDetail(context) }
        : null;
    }
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
  const ledger = deviceSweepIsScoped(context.operation?.env) ? readCreatedDevices() : null;
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
  for (const device of parked) {
    if (!onShort(context, deviceDataDirs(context.sims, device.platform, device.id))) continue;
    if (context.level === 'high' && !(await context.stillShort())) return;
    if (ledger && !ledger[device.platform].has(device.id)) {
      recordAction(
        context,
        {
          rung: 2,
          kind: 'delete-parked-device',
          target: device.id,
          outcome: 'kept',
          bytes: 0,
          detail: SCOPED_PARKED_KEEP,
        },
        context.why,
      );
      continue;
    }
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
  const result = await pruneCache(cache, {
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

const CARGO_TRIM_RETRY_MS = 10 * 60_000;
const cargoTrimmedAt = new Map<string, number>();

async function cargoTargetsStep(context: RungContext): Promise<void> {
  // @ref LLP 0001#pressure-acts-without-waiting-for-measurement-or-load -- the trim needs no size scan or load gate
  if (context.force) return;
  const now = Date.now();
  const key = `${configDir()}\0${context.level}`;
  const last = cargoTrimmedAt.get(key);
  if (last !== undefined && last <= now && now - last < CARGO_TRIM_RETRY_MS) return;
  if (!(await context.stillShort())) return;
  const protectedRoot = context.protectedRoot ? (canonicalOrNull(context.protectedRoot) ?? '') : '';
  const plan = await planCargoTargetsAtPressure({
    settings: context.settings,
    pinned: maintenancePinnedReader(context.operation),
    now,
    signal: context.operation?.signal,
    ...(context.operation ? { operation: context.operation } : {}),
    ...(context.volume === undefined
      ? {}
      : {
          diskLevel: async (dir: string, signal?: AbortSignal) => {
            const measured = await measuredDiskLevel(dir, signal);
            return measured === 'normal' ? context.level : measured;
          },
        }),
  });
  for (const action of plan.actions) {
    const workspace = action.workspace ? canonicalOrNull(action.workspace) : null;
    if (protectedRoot && (workspace === protectedRoot || action.target.startsWith(`${protectedRoot}${sep}`))) continue;
    if (!onShort(context, [action.target])) continue;
    if (!(await context.stillShort())) return;
    await run(context, action);
  }
  cargoTrimmedAt.set(key, now);
}

function unsizedDetail(dir: string): string {
  const failure = lastSizeFailure(dir);
  return `its size walk ${failure ? describeSizeFailure(failure) : 'failed'}, so it was left alone`;
}

/**
 * Rung 3, the shared caches: at high, each trimmed least recently used first to half its cap (the compilation cache,
 * which can only be emptied whole, emptied once over half its cap); at critical, the Metro cache and the compilation
 * cache emptied, the build cache trimmed to its protected entries, the fingerprint index and memo emptied, and every
 * other registered cache emptied whole except those `emptyRegisteredCaches` keeps.
 */
async function cachesRung(context: RungContext): Promise<void> {
  await cargoTargetsStep(context);
  const critical = context.level === 'critical';
  const recentDays = critical ? 0 : context.settings.protectRecentHours / 24;
  const entries = [
    { cache: rootCache('Build cache', buildCacheRoot(), 2), capGb: context.settings.buildCacheMaxGb },
    { cache: rootCache('Metro transform caches', metroCacheRoot(), 3), capGb: context.settings.metroCacheMaxGb },
  ];
  for (const { cache, capGb } of entries) {
    if (!existsSync(cache.dir) || !onShort(context, [cache.dir]) || !(await context.stillShort())) continue;
    let evict = Infinity;
    if (!critical) {
      if (capGb === 0) continue;
      const bytes = await measuredDirectorySizeAsync(cache.dir, { timeoutMs: SIZE_TIMEOUT_MS });
      const target = (capGb * GIB) / 2;
      if (bytes === null) {
        recordAction(
          context,
          {
            rung: 3,
            kind: 'trim-cache',
            target: cache.dir,
            outcome: 'kept',
            bytes: 0,
            detail: unsizedDetail(cache.dir),
          },
          context.why,
          true,
        );
        continue;
      }
      if (bytes <= target) continue;
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
  if (existsSync(compilation) && onShort(context, [compilation]) && (await context.stillShort())) {
    const bytes = await measuredDirectorySizeAsync(compilation, { timeoutMs: SIZE_TIMEOUT_MS });
    const capGb = context.settings.swiftCompilationCacheMaxGb;
    if (bytes === null) {
      if (critical || capGb > 0)
        recordAction(
          context,
          {
            rung: 3,
            kind: 'empty-cache',
            target: compilation,
            outcome: 'kept',
            bytes: 0,
            detail: unsizedDetail(compilation),
          },
          context.why,
          true,
        );
    } else if (critical || (capGb > 0 && bytes > (capGb * GIB) / 2)) {
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
  if (critical) await emptyRegisteredCaches(context, [buildCacheRoot(), metroCacheRoot(), compilation]);
  for (const [directory, lock] of [
    [fingerprintIndexDir(), fingerprintIndexLock()],
    [join(configDir(), 'fingerprint-memo'), join(configDir(), 'fingerprint-memo.lock')],
  ] as const) {
    if (!critical || !existsSync(directory) || !onShort(context, [directory]) || !(await context.stillShort()))
      continue;
    const bytes = (await measuredDirectorySizeAsync(directory, { timeoutMs: SIZE_TIMEOUT_MS })) ?? 0;
    if (context.act) withDirLock(lock, () => rmSync(directory, { recursive: true, force: true }));
    recordAction(
      context,
      {
        rung: 3,
        kind: 'empty-cache',
        target: directory,
        outcome: context.act ? 'done' : 'would',
        bytes: context.act || context.measure ? bytes : 0,
        detail: 'the next build fingerprints its tree in full',
      },
      context.why,
    );
  }
}

/**
 * At critical, every other shared cache Stim registered emptied whole, as its own action: ccache, the macOS artifact
 * cache and the React Native and Android caches. A report-only cache, one outside a scoped home, one Stim does not own
 * and one inside a workspace stay; an atomic cache a build holds is kept when it runs.
 */
async function emptyRegisteredCaches(context: RungContext, handled: readonly string[]): Promise<void> {
  const roots = handled.map(canonicalOrNull).filter((root): root is string => root !== null);
  const inside = (dir: string) => {
    const path = canonicalOrNull(dir);
    return (
      path !== null &&
      roots.some((root) => path === root || path.startsWith(`${root}${sep}`) || root.startsWith(`${path}${sep}`))
    );
  };
  const caches = planCacheEmptying(
    (await discoverCachesAsync(context.operation?.env, context.operation?.cwd)).filter(
      (cache) => !inside(cache.dir) && !isInsideWorkspaces(cache.dir) && onShort(context, [cache.dir]),
    ),
    true,
    context.operation?.env,
  );
  for (const cache of caches) {
    if (!(await context.stillShort())) return;
    if (!cache.willEmpty) {
      if (cache.prune !== 'report-only')
        recordAction(
          context,
          {
            rung: 3,
            kind: 'empty-cache',
            target: cache.dir,
            outcome: 'kept',
            bytes: 0,
            detail: cache.emptySkipped ?? 'kept',
          },
          context.why,
        );
      continue;
    }
    await run(
      context,
      {
        kind: 'would-empty-cache',
        target: cache.dir,
        dir: cache.dir,
        bytes: 0,
        reason: `${cache.name}, emptied whole at critical`,
      },
      { bytes: async () => (await measuredDirectorySizeAsync(cache.dir, { timeoutMs: SIZE_TIMEOUT_MS })) ?? 0 },
    );
  }
}

/**
 * Rung 4: the dormant stage now, longest-idle first: at high for workspaces idle 10 minutes, at critical every idle one.
 * At critical a workspace whose dev server or owned device runs loses only its owned devices on a volume under
 * pressure, each shut down to be deleted, and its dev server keeps running.
 */
async function dormantRung(context: RungContext): Promise<void> {
  if (dormantAfterMs(context.config) <= 0) return;
  const critical = context.level === 'critical';
  const idleMs = critical ? PRESSURE_IDLE_MS : DORMANT_HIGH_IDLE_MS;
  for (const candidate of await dormantCandidates(context.config, context, idleMs, critical ? 'critical' : undefined)) {
    const devices: string[][] = candidate.running ? [] : [[workspaceDir(candidate.path)]];
    for (const { platforms } of projectDeviceSlots(candidate.project)) {
      if (platforms.ios?.owned && platforms.ios.deviceUdid)
        devices.push(deviceDataDirs(context.sims, 'ios', platforms.ios.deviceUdid));
      if (platforms.android?.owned && platforms.android.avdName)
        devices.push(deviceDataDirs(context.sims, 'android', platforms.android.avdName));
    }
    if (!devices.some((dirs) => onShort(context, dirs))) continue;
    if (!(await context.stillShort())) return;
    if (candidate.running) {
      // @ref LLP 0001#at-critical-a-deletion-stops-only-what-it-needs -- the device is shut down to be deleted
      const result = context.act
        ? await deleteRunningDevices(candidate, context, deletable(context))
        : {
            outcome: 'would' as const,
            bytes: context.measure ? await workspaceDeviceBytes(context, candidate.project) : 0,
            detail: wouldDetail(context),
            restore: 'the next stim ios or stim android',
          };
      recordAction(
        context,
        { rung: 4, kind: 'delete-devices', target: candidate.path, workspace: candidate.path, ...result },
        `${context.why}; idle ${Math.floor(candidate.idleMs / MINUTE_MS)} minutes`,
      );
      continue;
    }
    await run(
      { ...context, why: `${context.why}; idle ${Math.floor(candidate.idleMs / MINUTE_MS)} minutes` },
      dormantAction(candidate.path, idleMs, context.why),
      { bytes: () => workspaceDeviceBytes(context, candidate.project) },
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
 * Rung 5: node_modules and Pods of linked worktrees whose workspace in this Stim home is idle 1 hour at high and 2
 * minutes at critical by the activity definition with nothing running, each recorded for `stim worktree warm`: those holding
 * REAL_BYTES_THRESHOLD or more private bytes, most first, then those of unknown size, longest-idle first. A
 * copy-on-write clone below the threshold is kept, and so is a tree of unknown size whose sample found mostly hard
 * links, which at critical goes last instead.
 */
async function dependenciesRung(context: RungContext): Promise<void> {
  const critical = context.level === 'critical';
  const idleMs = critical ? PRESSURE_IDLE_MS : DEPENDENCIES_HIGH_IDLE_MS;
  const idle = await idleStageCandidates(context.config, context, idleMs, critical ? { running: 'critical' } : {});
  const running = new Map(
    idle.flatMap((candidate) => {
      const key = candidate.running ? canonicalOrNull(candidate.path) : null;
      return key ? [[key, candidate] as const] : [];
    }),
  );
  // @ref LLP 0001#at-critical-a-deletion-stops-only-what-it-needs -- Metro stops only for its store or dependencies
  for (const candidate of running.values()) await serverStoreStep(context, candidate);
  const serving = new Map(
    [...running.values()].flatMap((candidate) => {
      const pid = serverPid(candidate.path, candidate.project);
      return pid === null ? [] : [[candidate.path, pid] as const];
    }),
  );
  const protectedRoot = context.protectedRoot ? (canonicalOrNull(context.protectedRoot) ?? '') : '';
  const ranked = (
    await timedStep(
      context.log,
      'rank_dependencies',
      () => rankDependencies(idle, protectedRoot, context.operation, false, context.log, serving),
      { signal: context.operation?.signal, items: (found) => found?.length },
    )
  ).filter((dependency) => onShort(context, [dependency.candidate.path]));
  await sampleLinks(ranked, context.operation?.signal);
  const { take, kept } = selectDependencies(ranked, 'take', context.level === 'critical' ? 'last' : 'keep');
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
    const owner = running.get(canonicalOrNull(dependency.workspace) ?? '');
    const pid = owner
      ? (serverPid(owner.path, loadConfig()?.projects[owner.path] ?? owner.project) ?? undefined)
      : undefined;
    const restore = pid === undefined ? 'stim worktree warm' : 'stim worktree warm, then stim revive';
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
      const result: { status: 'kept' | 'would'; bytes: number; detail: string } = unrestorable
        ? { status: 'kept', bytes: 0, detail: unrestorable }
        : await wouldDelete(
            dependency,
            context.level,
            pid === undefined ? wouldDetail(context) : `${wouldDetail(context)}; its dev server would be stopped`,
            context.operation,
            context.measure ? (dependency.privateBytes ?? (await pathsBytes([dependency.candidate.path]))) : plan.bytes,
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
          ...(result.status === 'would' ? { restore } : {}),
        },
        why,
      );
      continue;
    }
    const result = await clearDependency(
      dependency,
      idleMs,
      protectedRoot,
      worktrees,
      why,
      context.operation,
      true,
      context.level,
      owner
        ? {
            recheck: () => stillIdleUnderClaim(owner, idleMs, context, 'critical'),
            ...(pid === undefined
              ? {}
              : {
                  server: {
                    workspace: owner.path,
                    pid,
                    stop: () => stopServerForDeletion(owner.path, context.operation),
                  },
                }),
          }
        : undefined,
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
        ...(result.status === 'done' ? { restore } : {}),
      },
      why,
    );
  }
}

/** Rung 5's first step at critical: a serving workspace's Metro store, for which its dev server stops. */
async function serverStoreStep(context: RungContext, candidate: StageCandidate): Promise<void> {
  const store = metroStoreRoot(candidate.path);
  if (
    !existsSync(store) ||
    !onShort(context, [store]) ||
    serverPid(candidate.path, candidate.project) === null ||
    storeSharer(candidate.path, context.config) ||
    !(await context.stillShort())
  )
    return;
  const result = context.act
    ? await clearServerStore(candidate, context.config, context, deletable(context))
    : {
        outcome: 'would' as const,
        bytes: context.measure ? await pathsBytes([store]) : 0,
        detail: `${wouldDetail(context)}; its dev server would be stopped for its Metro store ${store}`,
        restore: 'stim revive',
      };
  if (!result) return;
  recordAction(
    context,
    { rung: 5, kind: 'delete-build-outputs', target: candidate.path, workspace: candidate.path, ...result },
    `${context.why}; idle ${Math.floor(candidate.idleMs / MINUTE_MS)} minutes`,
  );
}

/**
 * Rung 6 now: idle Gradle and Kotlin daemons, an unused watchman over its threshold, and for disk the unpinned Gradle versions, TMPDIR leftovers and the
 * worktree trash. At normal the daily sweep runs the same plan.
 */
async function sweepRung(context: RungContext, causes: readonly Cause[]): Promise<void> {
  const plan = await timedStep(
    context.log,
    'plan_rung6',
    () =>
      planRung6(context.settings, {
        disk: causes.includes('disk'),
        memory: causes.includes('memory'),
        everyGradleVersion: context.level === 'critical',
        operation: context.operation,
      }),
    { signal: context.operation?.signal, items: (planned) => planned?.actions.length },
  );
  for (const action of plan.actions) {
    const memory = action.kind === 'would-stop-gradle-daemons' || action.kind === 'would-stop-watchman';
    if (!memory && !onShort(context, [action.dir ?? action.target])) continue;
    if (!(await context.stillShort())) return;
    await run(context, action);
  }
}

/**
 * Rung 7, finished worktrees, only while `maintenance.removeFinishedWorktrees` is on: at high, the clean ones whose
 * branch is merged or whose pull request ended, after `gc.worktreeGraceMinutes`; at critical without the grace period,
 * and, while `maintenance.removeIdleWorktrees` is on, clean, pushed ones no Stim command used for 7 days. Every other keep rule of the worktree check holds: in
 * use, leased, locked, pinned, unpushed, or not provably merged. The stim-daemon's own ladder reads the pull request
 * lookups the worktree check cached; `stim gc` looks them up again.
 */
async function worktreesRung(context: RungContext): Promise<void> {
  if (!context.settings.removeFinishedWorktrees) return;
  const protectedRoot = context.protectedRoot ? (canonicalOrNull(context.protectedRoot) ?? '') : '';
  const pins = new Map<string, boolean>();
  const planned = await timedStep(
    context.log,
    'plan_worktrees',
    () =>
      planWorktrees({
        protectedRoot,
        pinned: (workspace) => {
          let value = pins.get(workspace);
          if (value === undefined) pins.set(workspace, (value = maintenancePinned(workspace)));
          return value;
        },
        now: Date.now(),
        ...(context.level === 'critical' ? { graceMs: 0 } : {}),
        refresh: context.act && Boolean(context.force),
        idleDays:
          context.level === 'critical' && context.settings.removeIdleWorktrees ? DEFAULT_WORKTREE_IDLE_DAYS : null,
        operation: context.operation,
      }),
    { signal: context.operation?.signal, items: (result) => result?.sweep.worktrees.length },
  );
  const clean = planned.sweep.worktrees.filter((worktree) => !worktree.dirty);
  const sweep = { ...planned.sweep, worktrees: clean };
  for (const worktree of planned.sweep.worktrees)
    if (worktree.dirty)
      recordAction(
        context,
        {
          rung: 7,
          kind: 'remove-worktree',
          target: worktree.path,
          outcome: 'kept',
          bytes: 0,
          detail: 'it has uncommitted changes; the worktree check archives and removes it after its grace period',
        },
        context.why,
      );
  for (const action of planned.actions) {
    if (action.kind !== 'would-remove-worktree' || !clean.some((worktree) => worktree.path === action.target)) continue;
    if (!onShort(context, [action.target])) continue;
    if (!(await context.stillShort())) return;
    await run({ ...context, why: `${context.why}; ${action.reason}` }, action, { worktreeSweep: sweep });
  }
}

/**
 * Rung 8's first step, at critical only: the node_modules and Pods of source checkouts idle 2 minutes, longest-idle
 * first, only on a volume still under the critical level and after rungs 5 and 7 took every linked worktree's
 * dependencies and finished worktrees. A source checkout is what `stim worktree warm` copies from, so it goes last of the
 * dependencies, and before the history and tool caches because one reinstall costs less than they do.
 */
async function sourceDependenciesStep(context: RungContext): Promise<void> {
  const keeps = new Map<string, string>();
  const idle = await idleStageCandidates(context.config, context, PRESSURE_IDLE_MS, {
    full: true,
    onKept: (path, reason) => keeps.set(canonicalOrNull(path) ?? path, reason),
  });
  const protectedRoot = context.protectedRoot ? (canonicalOrNull(context.protectedRoot) ?? '') : '';
  const { ranked, kept } = await timedStep(
    context.log,
    'rank_source_dependencies',
    () =>
      rankSourceDependencies(
        idle,
        keeps,
        protectedRoot,
        {
          level: 'critical',
          dormantMs: 0,
          criticalIdleMs: PRESSURE_IDLE_MS,
          thresholdMs: PRESSURE_IDLE_MS,
          setting: 'the pressure idle threshold',
        },
        context.operation,
        context.log,
      ),
    {
      signal: context.operation?.signal,
      items: (found) => (found ? found.ranked.length + found.kept.length : undefined),
    },
  );
  if (!context.act || context.force)
    for (const entry of kept)
      recordAction(
        context,
        {
          rung: 8,
          kind: 'delete-dependencies',
          target: entry.target,
          ...(entry.workspace ? { workspace: entry.workspace } : {}),
          outcome: 'kept',
          bytes: 0,
          detail: entry.reason,
        },
        context.why,
      );
  await sampleLinks(ranked, context.operation?.signal);
  const { take, kept: small } = selectDependencies(ranked, 'take', 'last');
  if (!context.act || context.force)
    for (const { dependency, detail } of small)
      recordAction(
        context,
        {
          rung: 8,
          kind: 'delete-dependencies',
          target: dependency.candidate.path,
          workspace: dependency.workspace,
          outcome: 'kept',
          bytes: 0,
          detail,
        },
        context.why,
      );
  if (!take.length) return;
  const critical = context.force && !context.force.measured ? null : await shortDevices(context, 'critical');
  if (critical?.size === 0) return;
  const worktrees = await artifactWorktreesFor(context.operation);
  const due: typeof take = [];
  for (const dependency of take) {
    if (!onShortVolume([dependency.candidate.path], critical)) continue;
    if (!(await context.stillShort())) break;
    due.push(dependency);
  }
  const why = `${context.why}; the source checkout's dependencies go last`;
  const results = context.act
    ? await clearSourceCheckouts(
        due,
        PRESSURE_IDLE_MS,
        protectedRoot,
        worktrees,
        context.operation,
        'the pressure idle threshold',
        'critical',
      )
    : new Map();
  for (const dependency of due) {
    const plan: MaintenanceAction = {
      kind: 'would-delete-dependencies',
      target: dependency.candidate.path,
      bytes: dependency.privateBytes ?? 0,
      reason: why,
      workspace: dependency.workspace,
    };
    const result = context.act
      ? (results.get(dependency) ?? { status: 'kept' as const, bytes: 0, detail: 'it was not processed' })
      : await wouldDelete(
          dependency,
          'critical',
          wouldDetail(context),
          context.operation,
          context.measure ? (dependency.privateBytes ?? (await pathsBytes([dependency.candidate.path]))) : plan.bytes,
        );
    recordAction(
      context,
      {
        rung: 8,
        kind: 'delete-dependencies',
        target: dependency.candidate.path,
        workspace: dependency.workspace,
        outcome: result.status,
        bytes: result.bytes,
        detail: result.detail,
        ...(result.status === 'done' ? { restore: SOURCE_RESTORE } : {}),
      },
      why,
    );
  }
}

/** Rung 8, at critical only: a source checkout's dependencies, then every device recording not being written, and the logs, recordings and agent actions of every archive. */
async function historyRung(context: RungContext): Promise<void> {
  if (context.level !== 'critical') return;
  await sourceDependenciesStep(context);
  const critical = context.force && !context.force.measured ? null : await shortDevices(context, 'critical');
  if (!onShortVolume([configDir()], critical)) return;
  const history = await timedStep(context.log, 'plan_history', () => planHistory(context.operation), {
    signal: context.operation?.signal,
    items: (planned) => planned?.length,
  });
  for (const action of history) {
    if (!(await context.stillShort())) return;
    await run(context, action);
  }
}

/**
 * Rung 9, the last: the caches of tools Stim does not own, each emptied through the tool's own command while no
 * process of that tool runs, with its size before and after; Android NDKs, unused system images and Exact's cache are
 * only reported with the command a person runs. Only at critical, after the rungs above, and never from a home STIM_HOME
 * scopes, since those caches are machine-wide. It acts only on a cache whose volume is under the critical level when
 * measured again after the rungs above: the stim-daemon's ladder at most hourly, a `stim gc` at the measured level each
 * time. `stim gc --pressure critical` treats every volume as short.
 */
async function unownedRung(context: RungContext): Promise<void> {
  // @ref LLP 0003#rung-9-runs-only-at-critical -- at high it would wipe tool caches on every pass
  if (context.level !== 'critical' || isScopedHome(context.operation?.env ?? process.env)) return;
  if (!context.force && Date.now() - unownedRunAt < UNOWNED_EVERY_MS) return;
  const critical = context.force && !context.force.measured ? null : await shortDevices(context, 'critical');
  if (critical?.size === 0) return;
  if (!context.force) unownedRunAt = Date.now();
  for (const plan of await surveyToolCaches(context.operation)) {
    // @ref LLP 0003#only-on-the-short-volume -- a full external disk must not empty another volume
    const result = onShortVolume(plan.cache.paths, critical)
      ? await cleanToolCache(plan, context.act, context.operation)
      : {
          outcome: 'kept' as const,
          before: plan.bytes,
          after: plan.bytes,
          detail: 'its volume is not under the critical level',
        };
    const freed =
      result.before !== null && result.after !== null
        ? Math.max(0, result.before - result.after)
        : result.outcome === 'would'
          ? (result.before ?? 0)
          : 0;
    recordAction(
      context,
      {
        rung: 9,
        kind: 'clean-tool-cache',
        target: `${plan.cache.label} (${plan.cache.paths.join(', ')})`,
        outcome: result.outcome,
        bytes: result.outcome === 'kept' ? 0 : freed,
        detail:
          result.outcome === 'kept' && result.before !== null
            ? `${formatBytes(result.before)} kept: ${result.detail}`
            : result.detail,
      },
      context.why,
    );
  }
  const env = context.operation?.env ?? process.env;
  const reported = reportedCaches(env);
  const inventory = await collectInventory(context.config, [], env, context.operation).catch(() => null);
  for (const image of inventory?.systemImages.filter((entry) => entry.avdCount === 0) ?? [])
    reported.push({
      label: `Android system image ${image.package}, used by no AVD`,
      path: image.directory,
      command: image.command,
    });
  for (const entry of reported) {
    const bytes = await reportedBytes(entry.path, context.operation?.signal);
    recordAction(
      context,
      {
        rung: 9,
        kind: 'report-tool-cache',
        target: `${entry.label} (${entry.path})`,
        outcome: 'kept',
        bytes: 0,
        detail: `${bytes === null ? 'size unknown' : formatBytes(bytes)}; Stim only reports it: ${entry.command}`,
      },
      context.why,
    );
  }
}

/** The device ids of the volumes Stim uses whose free disk is under `level`, measured now, per device. */
async function shortDevices(
  context: Pick<LadderInput, 'config' | 'operation'>,
  level: 'high' | 'critical',
): Promise<Set<number>> {
  const { thresholds } = diskThresholds(context.config, context.operation?.env);
  return shortVolumeDevices(await measureDisk(context.config, context.operation?.signal), thresholds, level);
}

const RUNG_ACTS: Record<Rung, (context: RungContext, causes: Cause[]) => Promise<void>> = {
  0: bootedParkedRung,
  1: idleOutputsRung,
  2: parkedRung,
  3: cachesRung,
  4: dormantRung,
  5: dependenciesRung,
  6: sweepRung,
  7: worktreesRung,
  8: historyRung,
  9: unownedRung,
};

/**
 * The pressure ladder after the activity pass, whose idle stage at 2 minutes under memory pressure is rung 1: rungs 1
 * to 8 top-down while the level stays above normal, each measuring again before it acts and running only for the
 * causes it relieves (a memory level runs the Gradle daemons of rung 6; the devices of rung 1 are the activity pass's). Each rung skips
 * every workspace with a blocker and takes the longest-idle first. Returns the actions and the last measurement.
 */
export async function runLadder(
  input: LadderInput,
  pressure: DaemonPressure,
): Promise<{ actions: DaemonLadderAction[]; pressure: DaemonPressure }> {
  const actions: DaemonLadderAction[] = [];
  const settings = resolveMaintenanceSettings(input.config);
  const { force } = input;
  if (input.act) forgetGitReads(input.operation);
  const runRung = async (rung: Rung, context: RungContext, causes: Cause[]) => {
    const before = actions.length;
    try {
      await timedStep(input.log, 'rung', () => RUNG_ACTS[rung](context, causes), {
        signal: input.operation?.signal,
        fields: { rung, pressureLevel: context.level },
        items: () => actions.length - before,
      });
    } catch (error) {
      if (isClaimUnavailable(error)) throw error;
      input.operation?.signal.throwIfAborted();
      const message = error instanceof Error ? error.message : String(error);
      input.log('warn', 'pressure_rung_failed', `rung ${rung} failed: ${message}`);
      actions.push({
        rung,
        kind: 'rung',
        target: `rung ${rung}`,
        outcome: 'failed',
        bytes: 0,
        detail: message,
      });
    }
  };
  if (force) {
    for (const { rung } of rungsFrom(input.fromRung).filter((entry) => entry.rung <= (input.lastRung ?? 9))) {
      const context: RungContext = {
        ...input,
        rung,
        level: force.level,
        pressure,
        settings,
        actions,
        stillShort: async () => true,
        why: force.why,
        short: force.measured ? await shortDevices(input, 'high') : null,
      };
      await runRung(rung, context, ['disk', 'memory']);
    }
    return { actions, pressure };
  }
  if (pressure.level === 'normal') return { actions, pressure };
  let current = pressure;
  for (const { rung, relieves } of rungsFrom(input.fromRung).filter((entry) => entry.rung <= (input.lastRung ?? 9))) {
    current = await input.remeasure();
    const decision = rungDecision(current, relieves);
    if (decision === 'stop') break;
    if (decision === 'skip') continue;
    const stillShort = async () => {
      current = await input.remeasure();
      return causesOf(current, relieves).length > 0;
    };
    const context: RungContext = {
      ...input,
      rung,
      level: decision.level,
      pressure: current,
      settings,
      actions,
      stillShort,
      why: `pressure level ${current.level}: ${current.reasons.join('; ')}`,
      // @ref LLP 0001#each-rung-frees-only-the-volumes-under-pressure -- a healthy volume gains nothing
      short: input.volume === undefined ? await shortDevices(input, 'high') : new Set([input.volume]),
    };
    await runRung(rung, context, decision.causes);
  }
  return { actions, pressure: current };
}
