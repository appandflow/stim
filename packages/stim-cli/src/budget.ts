import { existsSync, statfsSync, statSync } from 'node:fs';
import { homedir, platform, totalmem } from 'node:os';
import { dirname, join, sep } from 'node:path';
import chalk from 'chalk';
import { phaseLine } from './command-output.ts';
import { formatBytes, measuredDirectorySize, volumeRootFor } from './fs-util.ts';
import { capacity, environmentState, formatSpace, type AndroidRuntimeFacts } from './status.ts';
import { discoverCaches } from './cache/caches.ts';
import { planCacheEmptying, trimCaches } from './commands/gc/caches.ts';
import { deviceSweepIsScoped } from './commands/gc/devices.ts';
import {
  collectIdleDevices,
  collectOwnedDeviceActivity,
  idleShutdownCandidates,
  shutDownIdleDevices,
  workspaceBuildInProgress,
  type IdleDevice,
} from './commands/gc/idle.ts';
import { canonicalPath } from './commands/gc/paths.ts';
import type { Finding } from './diagnostics/doctor.ts';
import { clearWorkspaceOutputs, collectWorkspaceOutputs } from './commands/gc/workspaces.ts';
import { workspaceActivity } from './devices/activity.ts';
import { ownedAvdSerialResolver } from './devices/android.ts';
import { projectDeviceSlots } from './devices/device-slots.ts';
import { listAllIosSims, type IosSimRecord } from './devices/ios.ts';
import { stopOwnedMetro, type OwnedMetroStop } from './supervisor/cache-reset.ts';
import { withWorkspaceProcessLock, workspaceProcessLockError } from './engine/workspace-process-lock.ts';
import { resolveSupervisorTarget } from './supervisor/ownership.ts';
import { getConfigDir, loadConfig, type Config, type ProjectRecord } from './workspace/config.ts';
import { withIdleWorkspace } from './workspace/in-use.ts';
import { sharedBuildCache, workspaceDir } from './workspace/paths.ts';
import { settingDefinition, settingValueError } from '@stim-cli/core/state';
import { readWorkspaceState } from './workspace/workspace-state.ts';

const MB = 1024 * 1024;
const GB_IN_MB = 1024;
const COMMITTED_MEMORY_SHARE = 0.6;
const STALE_CACHE_DAYS = 14;
const DEVICE_LIST_TIMEOUT_MS = 10_000;
const USAGE_TIMEOUT_MS = 10_000;

const BUDGET_SETTING_REMEDY =
  'Fix the value with `stim settings set <key> <value>`, or unset the environment variable. Run `stim guide settings` for the budget keys.';

export interface Budget {
  minFreeDiskMb: number;
  hardFloorDiskMb: number;
  maxCommittedMemoryMb: number;
  maxLiveWorkspaces: number;
}

function valueAt(source: unknown, key: string): unknown {
  let node = source;
  for (const part of key.split('.')) {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return node;
}

export function machineNumber(
  key: string,
  config: Config | null,
  env: NodeJS.ProcessEnv,
): { value: number | undefined; error: string | null } {
  const setting = settingDefinition(key)!;
  const fromEnv = setting.env ? env[setting.env] : undefined;
  if (fromEnv !== undefined && fromEnv !== '') {
    const value = fromEnv.trim() === '' ? Number.NaN : Number(fromEnv);
    const problem = settingValueError(setting, value);
    return problem
      ? { value: undefined, error: `Invalid ${setting.env} value ${JSON.stringify(fromEnv)}. Expected ${problem}.` }
      : { value, error: null };
  }
  if (env.STIM_HOME && setting.scopedHomeValue !== undefined) return { value: setting.scopedHomeValue, error: null };
  const raw = valueAt(config, key);
  if (raw === undefined)
    return { value: typeof setting.default === 'number' ? setting.default : undefined, error: null };
  const problem = settingValueError(setting, raw);
  return problem
    ? { value: undefined, error: `Invalid ${key} value ${JSON.stringify(raw)}. Expected ${problem}.` }
    : { value: raw as number, error: null };
}

export function resolveBudget({
  config = loadConfig(),
  env = process.env,
  totalMemoryMb = totalmem() / MB,
}: { config?: Config | null; env?: NodeJS.ProcessEnv; totalMemoryMb?: number } = {}): {
  budget: Budget;
  error: string | null;
} {
  const minFree = machineNumber('budget.minFreeDiskGb', config, env);
  const hardFloor = machineNumber('budget.hardFloorDiskGb', config, env);
  const memory = machineNumber('budget.maxCommittedMemoryGb', config, env);
  const live = machineNumber('budget.maxLiveWorkspaces', config, env);
  return {
    budget: {
      minFreeDiskMb: (minFree.value ?? 0) * GB_IN_MB,
      hardFloorDiskMb: (hardFloor.value ?? 0) * GB_IN_MB,
      maxCommittedMemoryMb:
        memory.value === undefined ? Math.round(totalMemoryMb * COMMITTED_MEMORY_SHARE) : memory.value * GB_IN_MB,
      maxLiveWorkspaces: live.value ?? 0,
    },
    error: minFree.error ?? hardFloor.error ?? memory.error ?? live.error,
  };
}

interface VolumeSpace {
  volume: string;
  freeMb: number;
}

function existingAncestor(path: string): string {
  let current = path;
  while (!existsSync(current) && dirname(current) !== current) current = dirname(current);
  return current;
}

function readVolumeSpace(paths: readonly string[]): VolumeSpace[] {
  const seen = new Set<number>();
  const volumes: VolumeSpace[] = [];
  for (const path of paths) {
    try {
      const existing = existingAncestor(path);
      const device = statSync(existing).dev;
      if (seen.has(device)) continue;
      seen.add(device);
      const fs = statfsSync(existing);
      volumes.push({ volume: volumeRootFor(path), freeMb: (fs.bavail * fs.bsize) / MB });
    } catch {}
  }
  return volumes;
}

interface MemoryUse {
  committedMb: number;
  liveWorkspaces: number;
}

function estimateMemoryUse({
  config,
  sims,
  androidSerial,
  supervisorRunning,
}: {
  config: Config | null;
  sims: readonly IosSimRecord[] | null;
  androidSerial: (avdName: string) => string | null;
  supervisorRunning: (path: string, project: ProjectRecord) => number | null;
}): MemoryUse {
  const simsByUdid = Object.fromEntries((sims ?? []).map((sim) => [sim.udid, sim]));
  const runtime = (avdName: string | undefined): AndroidRuntimeFacts | null => {
    if (!avdName) return null;
    const serial = androidSerial(avdName);
    return { serial, state: serial ? 'detected' : 'not-detected' };
  };
  const states = Object.entries(config?.projects ?? {}).map(([path, project]) => {
    const pid = supervisorRunning(path, project);
    const slots = projectDeviceSlots(project);
    return environmentState(
      { ...project, __path: path },
      {
        simsByUdid,
        simsAvailable: sims !== null,
        metro: pid === null ? { missing: true } : { metro: { pid } },
        androidRuntime: project.platforms?.android?.owned ? runtime(project.platforms.android.avdName) : null,
        androidRuntimes: Object.fromEntries(
          slots
            .slice(1)
            .map(({ slot, platforms }) => [slot, platforms.android?.owned ? runtime(platforms.android.avdName) : null]),
        ),
      },
    );
  });
  const { committedMb, liveCount } = capacity(states, 0);
  return { committedMb, liveWorkspaces: liveCount };
}

function listSims(): IosSimRecord[] | null {
  try {
    return listAllIosSims({ timeoutMs: DEVICE_LIST_TIMEOUT_MS });
  } catch {
    return null;
  }
}

function runningSupervisorPid(path: string, project: ProjectRecord): number | null {
  const target = resolveSupervisorTarget({
    state: readWorkspaceState(path)?.supervisor,
    record: project.supervisor,
    reservedPort: project.metroPort,
  });
  return target.status === 'ours' ? (target.pid ?? null) : null;
}

function readMemoryUse(): MemoryUse {
  const resolve = ownedAvdSerialResolver({ timeoutMs: 5000 });
  return estimateMemoryUse({
    config: loadConfig(),
    sims: listSims(),
    androidSerial: (avdName) => {
      try {
        return resolve(avdName).serial ?? null;
      } catch {
        return null;
      }
    },
    supervisorRunning: runningSupervisorPid,
  });
}

interface BudgetMeasure {
  volumes: VolumeSpace[];
  memory: MemoryUse | null;
}

interface BudgetShortfalls {
  disk: VolumeSpace[];
  hardFloor: VolumeSpace[];
  memory: boolean;
  workspaces: boolean;
}

function budgetShortfalls(budget: Budget, measure: BudgetMeasure): BudgetShortfalls {
  const floor = Math.max(budget.minFreeDiskMb, budget.hardFloorDiskMb);
  return {
    disk: floor > 0 ? measure.volumes.filter((v) => v.freeMb < floor) : [],
    hardFloor: budget.hardFloorDiskMb > 0 ? measure.volumes.filter((v) => v.freeMb < budget.hardFloorDiskMb) : [],
    memory: Boolean(
      budget.maxCommittedMemoryMb > 0 && measure.memory && measure.memory.committedMb > budget.maxCommittedMemoryMb,
    ),
    workspaces: Boolean(
      budget.maxLiveWorkspaces > 0 && measure.memory && measure.memory.liveWorkspaces > budget.maxLiveWorkspaces,
    ),
  };
}

export type ReclaimStepName = 'idle-devices' | 'idle-dev-servers' | 'workspace-outputs' | 'stale-cache-entries';

const DISK_ONLY: readonly ReclaimStepName[] = ['workspace-outputs', 'stale-cache-entries'];

function reclaimPlan(short: BudgetShortfalls): ReclaimStepName[] {
  const disk = short.disk.length > 0;
  return [
    ...(disk || short.memory || short.workspaces ? (['idle-devices', 'idle-dev-servers'] as const) : []),
    ...(disk ? DISK_ONLY : []),
  ];
}

function overBudget(short: BudgetShortfalls): boolean {
  return short.disk.length > 0 || short.memory || short.workspaces;
}

export interface ReclaimedStep {
  step: ReclaimStepName;
  targets: string[];
  failures: number;
  freedMb?: number;
}

interface StepContext {
  root: string;
  dryRun: boolean;
  note: (line: string) => void;
  now: number;
  diskRecovered: () => boolean;
}

type StepResult = Omit<ReclaimedStep, 'step' | 'freedMb'>;

function isOtherWorkspace(root: string): (path: string) => boolean {
  const self = canonicalPath(root);
  return (path) => canonicalPath(path) !== self;
}

function deviceLabel(device: IdleDevice): string {
  return `${device.kind} ${device.name} in ${device.project}`;
}

function reclaimIdleDevices({ root, dryRun, note, now }: StepContext): StepResult {
  if (deviceSweepIsScoped()) {
    note(chalk.dim(phaseLine('budget', 'idle devices left alone: STIM_HOME scopes this config, devices are global')));
    return { targets: [], failures: 0 };
  }
  const other = isOtherWorkspace(root);
  const collect = (at: number) =>
    idleShutdownCandidates(
      collectIdleDevices(loadConfig(), listSims() ?? [], [], at).filter((device) => other(device.project)),
      0,
    );
  const idle = collect(now);
  if (dryRun || idle.length === 0) return { targets: idle.map(deviceLabel), failures: 0 };
  const { failures, shutDown } = shutDownIdleDevices(idle, 0, () => collect(Date.now()));
  return { targets: shutDown.map(deviceLabel), failures };
}

function idleSince(path: string, now: number): number | null {
  const activity = workspaceActivity(path, now);
  const at = Date.parse(activity.lastActivityAt ?? '');
  return activity.state === 'idle' && Number.isFinite(at) ? at : null;
}

async function reclaimIdleDevServers({ root, dryRun, note, now }: StepContext): Promise<StepResult> {
  const config = loadConfig();
  const other = isOtherWorkspace(root);
  const serving = Object.entries(config?.projects ?? {}).flatMap(([path, project]) => {
    const pid = other(path) ? runningSupervisorPid(path, project) : null;
    return pid !== null && !workspaceBuildInProgress(path) && idleSince(path, now) !== null ? [{ path, pid }] : [];
  });
  if (serving.length === 0) return { targets: [], failures: 0 };
  const sims = listSims();
  if (sims === null) {
    note(chalk.dim(phaseLine('budget', 'dev servers left alone: simulators could not be listed to prove them idle')));
    return { targets: [], failures: 0 };
  }
  const busy = new Set(
    collectOwnedDeviceActivity(config, sims, now)
      .filter((device) => device.activity.state !== 'idle')
      .map((device) => device.project),
  );
  const idle = serving.filter(({ path }) => !busy.has(path));
  if (dryRun) return { targets: idle.map(({ path }) => path), failures: 0 };
  const targets: string[] = [];
  let failures = 0;
  const stillIdle = (path: string, pid: number) => {
    const project = loadConfig()?.projects?.[path];
    return Boolean(
      project &&
      runningSupervisorPid(path, project) === pid &&
      !workspaceBuildInProgress(path) &&
      idleSince(path, Date.now()) !== null,
    );
  };
  for (const { path, pid } of idle) {
    let run;
    try {
      run = await withIdleWorkspace(
        path,
        async (): Promise<OwnedMetroStop | 'busy' | 'starting'> => {
          try {
            return await withWorkspaceProcessLock(
              workspaceDir(path),
              'metro-start',
              async () => (stillIdle(path, pid) ? stopOwnedMetro(path) : 'busy'),
              { external: true, waitMs: 0, ownerPurpose: 'budget reclaim' },
            );
          } catch (error) {
            if (workspaceProcessLockError(error)) return 'starting';
            throw error;
          }
        },
        { purpose: 'budget reclaim', supervisor: false },
      );
    } catch (error) {
      failures++;
      note(chalk.red(`Could not stop the dev server of ${path}: ${(error as Error)?.message || error}`));
      continue;
    }
    if (!run.ran) {
      note(chalk.yellow(`Kept the dev server of ${path}: ${run.reasons.join('; ')}`));
      continue;
    }
    const stopped = run.value;
    if (stopped === 'busy' || stopped === 'starting') {
      const why = stopped === 'busy' ? 'it is no longer idle' : 'a stim start holds its metro-start lock';
      note(chalk.dim(`Kept the dev server of ${path}: ${why}`));
    } else if (stopped.status === 'stopped') {
      targets.push(path);
      note(chalk.green(`Stopped the idle dev server of ${path}`));
    } else if ('reason' in stopped) {
      if (stopped.status === 'stuck') failures++;
      note(chalk.yellow(`Kept the dev server of ${path}: ${stopped.reason}`));
    }
  }
  return { targets, failures };
}

async function reclaimWorkspaceOutputs({ root, dryRun, now, diskRecovered }: StepContext): Promise<StepResult> {
  const other = isOtherWorkspace(root);
  const report = collectWorkspaceOutputs({ olderThan: null, now, measure: false });
  const clearable = report.workspaces
    .flatMap((entry) => {
      const project = entry.projectRoot;
      const since = project !== null && entry.willClear && other(project) ? idleSince(project, now) : null;
      return since === null ? [] : [{ entry, since }];
    })
    .toSorted((a, b) => a.since - b.since)
    .map(({ entry }) => entry);
  if (dryRun) return { targets: clearable.map((entry) => entry.projectRoot!), failures: 0 };
  const targets: string[] = [];
  let failures = 0;
  for (const entry of clearable) {
    const result = await clearWorkspaceOutputs({ ...report, workspaces: [entry] }, { olderThan: null, now });
    failures += result.failures;
    targets.push(...result.cleared);
    if (diskRecovered()) break;
  }
  return { targets, failures };
}

function cacheLabel(cache: { name: string; dir: string }): string {
  return `${cache.name} ${cache.dir}`;
}

function reclaimStaleCacheEntries({ dryRun }: StepContext): StepResult {
  const caches = planCacheEmptying(discoverCaches(), false).filter(
    (cache) => cache.prune !== 'report-only' && cache.prune !== 'atomic' && !cache.machineGlobal,
  );
  if (dryRun) return { targets: caches.map(cacheLabel), failures: 0 };
  return { targets: trimCaches(caches, STALE_CACHE_DAYS).map(cacheLabel), failures: 0 };
}

const STEPS: Record<ReclaimStepName, (context: StepContext) => StepResult | Promise<StepResult>> = {
  'idle-devices': reclaimIdleDevices,
  'idle-dev-servers': reclaimIdleDevServers,
  'workspace-outputs': reclaimWorkspaceOutputs,
  'stale-cache-entries': reclaimStaleCacheEntries,
};

const STEP_ACTIONS: Record<ReclaimStepName, string> = {
  'idle-devices': 'shut down idle owned devices',
  'idle-dev-servers': 'stop idle dev servers',
  'workspace-outputs': 'clear build outputs of idle workspaces',
  'stale-cache-entries': `trim cache entries unused for ${STALE_CACHE_DAYS} days`,
};

async function runStep(step: ReclaimStepName, context: StepContext): Promise<StepResult> {
  const log = console.log;
  const exitCode = process.exitCode;
  console.log = console.error;
  try {
    const result = await STEPS[step](context);
    return process.exitCode === exitCode ? result : { ...result, failures: result.failures + 1 };
  } catch (error) {
    context.note(chalk.red(phaseLine('budget', `${STEP_ACTIONS[step]} failed: ${(error as Error)?.message || error}`)));
    return { targets: [], failures: 1 };
  } finally {
    console.log = log;
    process.exitCode = exitCode;
  }
}

export interface BudgetDeps {
  volumes: (paths: readonly string[]) => VolumeSpace[];
  memory: () => MemoryUse;
  step: (step: ReclaimStepName, context: StepContext) => Promise<StepResult>;
  usage: () => string[];
  now: () => number;
}

function spaceUsers(): string[] {
  const home = homedir();
  const candidates: [string, string][] = [
    ['Stim state', getConfigDir()],
    ['shared build cache', sharedBuildCache()],
    ...(platform() === 'darwin'
      ? ([
          ['simulators', join(home, 'Library', 'Developer', 'CoreSimulator', 'Devices')],
          ['Xcode DerivedData', join(home, 'Library', 'Developer', 'Xcode', 'DerivedData')],
        ] as [string, string][])
      : []),
    ['Android emulators', join(home, '.android', 'avd')],
  ];
  const measured = new Set<string>();
  const users: { label: string; bytes: number }[] = [];
  for (const [label, path] of candidates) {
    const canonical = canonicalPath(path);
    if (measured.has(canonical) || [...measured].some((dir) => canonical.startsWith(`${dir}${sep}`))) continue;
    measured.add(canonical);
    if (!existsSync(path)) continue;
    const bytes = measuredDirectorySize(path, { timeoutMs: USAGE_TIMEOUT_MS });
    if (bytes) users.push({ label: `${label} ${path}`, bytes });
  }
  return users.toSorted((a, b) => b.bytes - a.bytes).map(({ label, bytes }) => `${label}: ${formatBytes(bytes)}`);
}

const DEFAULT_DEPS: BudgetDeps = {
  volumes: readVolumeSpace,
  memory: readMemoryUse,
  step: runStep,
  usage: spaceUsers,
  now: Date.now,
};

export interface BudgetRefusal {
  code: string;
  message: string;
  remedy: string;
}

export type BudgetOutcome =
  | { status: 'ok'; reclaimed: ReclaimedStep[]; budget: Budget; measure: BudgetMeasure; short: BudgetShortfalls }
  | { status: 'refused'; reclaimed: ReclaimedStep[]; refusal: BudgetRefusal };

const LOW_DISK_REMEDY =
  'Run `stim gc` to see what else Stim can reclaim, then `stim gc --delete` (add `--cache all` to empty the shared caches, or `--worktrees` to remove finished worktrees). Free space outside Stim from the largest uses listed, or lower budget.hardFloorDiskGb.';

function describeShortfall(budget: Budget, measure: BudgetMeasure, short: BudgetShortfalls): string[] {
  const floor = Math.max(budget.minFreeDiskMb, budget.hardFloorDiskMb);
  return [
    ...short.disk.map((v) => `${formatSpace(v.freeMb)} free on ${v.volume}, below the ${formatSpace(floor)} floor`),
    ...(short.memory && measure.memory
      ? [
          `roughly ${formatSpace(measure.memory.committedMb)} of memory committed, over the ${formatSpace(budget.maxCommittedMemoryMb)} budget`,
        ]
      : []),
    ...(short.workspaces && measure.memory
      ? [`${measure.memory.liveWorkspaces} live workspaces, over the limit of ${budget.maxLiveWorkspaces}`]
      : []),
  ];
}

export async function enforceBudget(
  {
    root,
    note,
    dryRun = false,
    budget: resolved,
  }: { root: string; note: (line: string) => void; dryRun?: boolean; budget?: Budget },
  overrides: Partial<BudgetDeps> = {},
): Promise<BudgetOutcome | { status: 'invalid'; refusal: BudgetRefusal }> {
  const deps = { ...DEFAULT_DEPS, ...overrides };
  let budget = resolved;
  if (!budget) {
    const read = resolveBudget();
    if (read.error)
      return {
        status: 'invalid',
        refusal: { code: 'STIM_BAD_ARG', message: read.error, remedy: BUDGET_SETTING_REMEDY },
      };
    budget = read.budget;
  }
  const paths = [root, getConfigDir()];
  const measureNow = (): BudgetMeasure => ({
    volumes: budget.minFreeDiskMb > 0 || budget.hardFloorDiskMb > 0 ? deps.volumes(paths) : [],
    memory: budget.maxCommittedMemoryMb > 0 || budget.maxLiveWorkspaces > 0 ? deps.memory() : null,
  });
  let measure = measureNow();
  let short = budgetShortfalls(budget, measure);
  const reclaimed: ReclaimedStep[] = [];
  const plan = reclaimPlan(short);
  if (plan.length) {
    note(
      chalk.yellow(
        phaseLine(
          'budget',
          `${describeShortfall(budget, measure, short).join('; ')}; ${dryRun ? 'would reclaim' : 'reclaiming'}`,
        ),
      ),
    );
  }
  for (const step of plan) {
    if (!dryRun && (!overBudget(short) || (DISK_ONLY.includes(step) && short.disk.length === 0))) break;
    const freeBefore = measure.volumes.reduce((sum, v) => sum + v.freeMb, 0);
    const result = await deps.step(step, {
      root,
      dryRun,
      note,
      now: deps.now(),
      diskRecovered: () => budgetShortfalls(budget, { volumes: deps.volumes(paths), memory: null }).disk.length === 0,
    });
    if (!dryRun) {
      measure = measureNow();
      short = budgetShortfalls(budget, measure);
    }
    if (result.targets.length === 0 && result.failures === 0) continue;
    const freedMb = Math.max(0, Math.round(measure.volumes.reduce((sum, v) => sum + v.freeMb, 0) - freeBefore));
    reclaimed.push({ step, ...result, ...(dryRun ? {} : { freedMb }) });
    const outcome = dryRun
      ? result.targets.join(', ')
      : `${result.targets.length}${result.failures ? `, ${result.failures} failed` : ''} (${formatSpace(freedMb)} freed)`;
    note(chalk.dim(phaseLine('budget', `${STEP_ACTIONS[step]}: ${outcome}`)));
  }
  if (!dryRun && short.hardFloor.length) {
    const tight = short.hardFloor.map((v) => `${formatSpace(v.freeMb)} on ${v.volume}`).join(' and ');
    const users = deps.usage();
    return {
      status: 'refused',
      reclaimed,
      refusal: {
        code: 'STIM_LOW_DISK',
        message:
          `Only ${tight} is free, below the ${formatSpace(budget.hardFloorDiskMb)} hard floor (budget.hardFloorDiskGb)` +
          `${reclaimed.length ? ' after reclaiming what Stim safely could' : ''}, so this run could fill the disk.` +
          (users.length ? ` Largest uses: ${users.join('; ')}.` : ''),
        remedy: LOW_DISK_REMEDY,
      },
    };
  }
  if (!dryRun && overBudget(short)) {
    note(
      chalk.yellow(phaseLine('budget', `still over budget: ${describeShortfall(budget, measure, short).join('; ')}`)),
    );
  }
  return { status: 'ok', reclaimed, budget, measure, short };
}

export async function budgetGate(
  args: { root: string; note: (line: string) => void },
  overrides: Partial<BudgetDeps> = {},
): Promise<{ reclaimed: ReclaimedStep[]; refusal: BudgetRefusal | null }> {
  const outcome = await enforceBudget(args, overrides);
  return {
    reclaimed: 'reclaimed' in outcome ? outcome.reclaimed : [],
    refusal: outcome.status === 'ok' ? null : outcome.refusal,
  };
}

export interface BudgetReport {
  budget: {
    minFreeDiskGb: number;
    hardFloorDiskGb: number;
    maxCommittedMemoryGb: number;
    maxLiveWorkspaces: number;
  };
  volumes: { volume: string; freeGb: number }[];
  memory: { committedGb: number; liveWorkspaces: number } | null;
  plan: ReclaimedStep[];
}

const gb = (mb: number) => Math.round((mb / GB_IN_MB) * 10) / 10;

function budgetFindings(
  budget: Budget,
  measure: BudgetMeasure,
  short: BudgetShortfalls,
  plan: readonly ReclaimedStep[],
): Finding[] {
  const findings: Finding[] = [];
  const steps = plan.length
    ? plan.map((entry) => `${STEP_ACTIONS[entry.step]} (${entry.targets.join(', ')})`).join('; then ')
    : 'nothing Stim can reclaim on its own right now';
  if (short.disk.length) {
    const refuses = short.hardFloor.length
      ? ` Below ${formatSpace(budget.hardFloorDiskMb)} it refuses with STIM_LOW_DISK when reclaiming does not free enough.`
      : '';
    findings.push({
      level: 'cost',
      title: 'Free disk is below the Stim budget',
      detail: `${describeShortfall(budget, measure, { ...short, memory: false, workspaces: false }).join('; ')}. The next ios, android or start will first ${steps}.${refuses}`,
      fix: 'Run `stim gc` to see what Stim can reclaim, then `stim gc --delete`. Free space outside Stim, or lower budget.minFreeDiskGb.',
    });
  }
  if (short.memory || short.workspaces) {
    findings.push({
      level: 'note',
      title: 'Live environments are over the memory budget',
      detail: `${describeShortfall(budget, measure, { ...short, disk: [] }).join('; ')}. The next ios, android or start shuts down idle owned devices and stops idle dev servers in other workspaces first.`,
      fix: 'Run `stim status` to see what is live, and `stim stop` in workspaces you own that you no longer need.',
    });
  }
  return findings;
}

export async function inspectBudget(
  root: string,
  deps: Partial<BudgetDeps> = {},
): Promise<{ report: BudgetReport | null; findings: Finding[] }> {
  const read = resolveBudget();
  if (read.error) {
    return {
      report: null,
      findings: [
        { level: 'cost', title: 'A budget setting is invalid', detail: read.error, fix: BUDGET_SETTING_REMEDY },
      ],
    };
  }
  const outcome = await enforceBudget({ root, note: () => {}, dryRun: true, budget: read.budget }, deps);
  if (outcome.status !== 'ok') return { report: null, findings: [] };
  const { budget, measure, short, reclaimed } = outcome;
  return {
    report: {
      budget: {
        minFreeDiskGb: gb(budget.minFreeDiskMb),
        hardFloorDiskGb: gb(budget.hardFloorDiskMb),
        maxCommittedMemoryGb: gb(budget.maxCommittedMemoryMb),
        maxLiveWorkspaces: budget.maxLiveWorkspaces,
      },
      volumes: measure.volumes.map((v) => ({ volume: v.volume, freeGb: gb(v.freeMb) })),
      memory: measure.memory
        ? { committedGb: gb(measure.memory.committedMb), liveWorkspaces: measure.memory.liveWorkspaces }
        : null,
      plan: reclaimed,
    },
    findings: budgetFindings(budget, measure, short, reclaimed),
  };
}

export function budgetLine(report: BudgetReport): string {
  const { budget } = report;
  const disk = report.volumes.length
    ? `${report.volumes.map((v) => `${v.freeGb} GB free on ${v.volume}`).join(', ')} (reclaims below ${Math.max(budget.minFreeDiskGb, budget.hardFloorDiskGb)} GB, ${budget.hardFloorDiskGb ? `refuses below ${budget.hardFloorDiskGb} GB` : 'never refuses'})`
    : 'disk budget off';
  const memory = report.memory
    ? `roughly ${report.memory.committedGb} GB of a ${budget.maxCommittedMemoryGb} GB memory budget committed`
    : 'memory budget off';
  return `${disk}; ${memory}`;
}
