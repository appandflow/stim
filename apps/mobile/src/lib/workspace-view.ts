import { clockDuration, gitBadges, shortDuration } from '@/lib/format';
import { formatBytes } from '@/lib/home';
import type { PlanState } from '@/lib/plan-checks';
import { platformName, runningBuild, type DeviceRef } from '@/lib/workspaces';
import type {
  BuildHistoryEntry,
  BuildPhase,
  BuildReport,
  DeviceActivity,
  EnvironmentState,
  LastBuild,
  MachineOwner,
  MachineUsageState,
  Platform,
  PullRequestFacts,
  StatusUsage,
  WorktreeFacts,
} from '@/protocol/types';

export type StageTone = 'success' | 'brand' | 'error' | 'warning' | 'tertiary';

export interface WorkspaceStage {
  label: 'Running' | 'Building' | 'Build failed' | 'Warming' | 'Ready' | 'Stopped';
  tone: StageTone;
  subtitle: string | null;
}

const ago = (now: number, iso: string | null | undefined): string | null => {
  const at = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(at) ? shortDuration(Math.max(0, now - at)) : null;
};

function latestBuild(env: EnvironmentState): LastBuild | null {
  const builds = [env.lastBuilds?.ios, env.lastBuilds?.android].filter((b): b is LastBuild => Boolean(b));
  return builds.reduce<LastBuild | null>(
    (latest, b) => (latest === null || Date.parse(b.startedAt) > Date.parse(latest.startedAt) ? b : latest),
    null,
  );
}

/**
 * Status reports `app` whenever it knows the bundle id, and a process that is not running cannot tell a closed app
 * from one never installed. A device counts as having no app only when its platform never built successfully here
 * and the latest build failed.
 */
export function appPresence(env: EnvironmentState, device: DeviceRef): 'none' | 'closed' | null {
  if (!device.running || device.platform === 'web' || device.physical || device.app?.state === 'running') return null;
  const last = env.lastBuilds?.[device.platform];
  const everBuilt = env.builds?.[device.platform]?.some((entry) => entry.result === 'succeeded') ?? true;
  if (last?.status === 'failed' && !everBuilt) return 'none';
  return device.app?.state === 'stopped' ? 'closed' : null;
}

export function closedApps(env: EnvironmentState, devices: DeviceRef[]): DeviceRef[] {
  return devices.filter((d) => appPresence(env, d) === 'closed');
}

export function workspaceStage(env: EnvironmentState, devices: DeviceRef[], now: number): WorkspaceStage {
  const build = runningBuild(env);
  if (build) {
    const since = ago(now, build.startedAt);
    return {
      label: 'Building',
      tone: 'brand',
      subtitle: `${platformName(build.platform)}${since ? ` \u00B7 started ${since} ago` : ''}`,
    };
  }
  if (!env.live && env.phase === 'warming') {
    const step = env.warmStep === 'copy' ? 'copying ignored files' : 'installing dependencies';
    const since = ago(now, env.phaseSince);
    return { label: 'Warming', tone: 'warning', subtitle: since ? `${step} \u00B7 ${since}` : step };
  }
  if (!env.live && env.phase === 'ready') {
    const since = ago(now, env.phaseSince);
    return { label: 'Ready', tone: 'success', subtitle: since ? `warmed ${since} ago` : null };
  }
  const latest = latestBuild(env);
  if (latest?.status === 'failed') {
    const since = ago(now, latest.finishedAt ?? latest.startedAt);
    return {
      label: 'Build failed',
      tone: 'error',
      subtitle: `${platformName(latest.platform)}${since ? ` \u00B7 ${since} ago` : ''}`,
    };
  }
  if (env.live || (env.remoteDevices?.length ?? 0) > 0) {
    const errors = env.logs?.errorsSinceMarker ?? 0;
    const problems = [
      errors > 0 ? (errors === 1 ? '1 error' : `${errors} errors`) : null,
      ...closedApps(env, devices).map((d) => `${platformName(d.platform)} app closed`),
    ].filter((p): p is string => p !== null);
    const up = ago(now, env.supervisor?.startedAt);
    return {
      label: 'Running',
      tone: problems.length ? 'error' : 'success',
      subtitle: [up ? `up ${up}` : null, ...problems].filter(Boolean).join(' \u00B7 ') || null,
    };
  }
  const stopped = ago(now, env.metro?.lastStop?.at);
  return { label: 'Stopped', tone: 'tertiary', subtitle: stopped ? `${stopped} ago` : null };
}

/** `ps` CPU, where 100 is one core, so a busy workspace reads above 100%. */
export function formatCpu(percent: number): string {
  return `${Math.round(percent)}%`;
}

export function formatMemoryMb(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

export interface Usage {
  cpuPercent: number | null;
  memoryMb: number | null;
  diskBytes: number | null;
}

const ownersOf = (machine: MachineUsageState | null | undefined, path: string) =>
  machine?.owners.filter((owner) => owner.workspace === path) ?? [];

export function workspaceUsage(env: EnvironmentState, machine: MachineUsageState | null | undefined): Usage {
  const owners = ownersOf(machine, env.path);
  return {
    cpuPercent: owners.length ? owners.reduce((sum, owner) => sum + owner.cpuPercent, 0) : null,
    memoryMb: owners.length
      ? owners.reduce((sum, owner) => sum + owner.memoryMb, 0)
      : env.memoryMb > 0
        ? env.memoryMb
        : null,
    diskBytes: workspaceDiskBytes(env),
  };
}

export function workspaceDiskBytes(env: EnvironmentState): number | null {
  const disk = env.disk;
  if (!disk || (disk.worktreeBytes === null && disk.buildBytes === null)) return null;
  return (disk.worktreeBytes ?? 0) + (disk.buildBytes ?? 0);
}

export function diskBreakdown(env: EnvironmentState): string | null {
  const disk = env.disk;
  if (!disk) return null;
  const parts = [
    disk.worktreeBytes === null ? null : `worktree ${formatBytes(disk.worktreeBytes)}`,
    disk.nodeModulesBytes === null ? null : `node_modules ${formatBytes(disk.nodeModulesBytes)} of it`,
    disk.buildBytes === null ? null : `build output ${formatBytes(disk.buildBytes)}`,
  ].filter(Boolean);
  return parts.length ? `Disk: ${parts.join(', ')}.` : null;
}

const DEVICE_KIND: Record<DeviceRef['platform'], MachineOwner['kind']> = {
  ios: 'simulator',
  android: 'emulator',
  web: 'browser',
};

/**
 * The owner that holds a device's processes. The emulator owner's id is its AVD name, not the serial a device
 * carries, so devices match on workspace, slot and kind. A physical device runs no process on the Mac.
 */
export function deviceOwner(
  device: Pick<DeviceRef, 'platform' | 'slot'> & { physical?: boolean },
  path: string,
  machine: MachineUsageState | null | undefined,
): MachineOwner | null {
  if (device.physical) return null;
  return (
    ownersOf(machine, path).find(
      (owner) => owner.kind === DEVICE_KIND[device.platform] && (owner.slot ?? 'default') === device.slot,
    ) ?? null
  );
}

export function deviceUsage(
  device: DeviceRef,
  path: string,
  machine: MachineUsageState | null | undefined,
  diskBytes: number | null | undefined,
): Usage | null {
  const owner = deviceOwner(device, path, machine);
  if (!owner && diskBytes == null) return null;
  return { cpuPercent: owner?.cpuPercent ?? null, memoryMb: owner?.memoryMb ?? null, diskBytes: diskBytes ?? null };
}

export interface ProcessRow {
  key: string;
  label: string;
  cpuPercent: number;
  memoryMb: number;
}

const OWNER_ORDER: MachineOwner['kind'][] = ['simulator', 'emulator', 'browser', 'metro', 'build'];

function ownerLabel(owner: MachineOwner, devices: DeviceRef[]): string {
  const slot = owner.slot && owner.slot !== 'default' ? ` \u00B7 ${owner.slot}` : '';
  switch (owner.kind) {
    case 'simulator': {
      const device = devices.find((d) => d.platform === 'ios' && d.slot === (owner.slot ?? 'default'));
      return `${device ? deviceTitle(device).name : 'iOS'} simulator${slot}`;
    }
    case 'emulator':
      return `Android emulator${slot}`;
    case 'browser':
      return 'Chrome (web)';
    case 'metro':
      return 'Metro';
    case 'build':
      return `${owner.id === 'ios' || owner.id === 'android' ? `${platformName(owner.id)} build` : 'Build'}${slot}`;
    default:
      return owner.name;
  }
}

export function processRows(
  env: EnvironmentState,
  devices: DeviceRef[],
  machine: MachineUsageState | null | undefined,
): ProcessRow[] {
  return ownersOf(machine, env.path)
    .map((owner) => ({ owner, rank: OWNER_ORDER.indexOf(owner.kind) }))
    .sort((a, b) => (a.rank < 0 ? 99 : a.rank) - (b.rank < 0 ? 99 : b.rank))
    .map(({ owner }) => ({
      key: `${owner.kind}:${owner.slot ?? ''}:${owner.id ?? owner.name}`,
      label: ownerLabel(owner, devices),
      cpuPercent: owner.cpuPercent,
      memoryMb: owner.memoryMb,
    }));
}

export interface DeviceTitle {
  name: string;
  detail: string;
}

/**
 * An owned simulator is named `stim-<label> (<model> <runtime>)`, so its model reads "iPhone 17 Pro 26.2": the
 * card shows "iPhone 17 Pro" and "iOS 26.2".
 */
export function deviceTitle(device: DeviceRef): DeviceTitle {
  const slot = device.slot === 'default' ? null : device.slot;
  const join = (...parts: (string | null)[]) => parts.filter(Boolean).join(' \u00B7 ');
  if (device.platform === 'web') return { name: 'Web', detail: join(device.name, slot) };
  if (device.platform === 'android') {
    return {
      name: device.physical ? device.name : 'Android',
      detail: join(device.physical ? 'USB' : 'Emulator', slot),
    };
  }
  if (device.physical)
    return { name: device.name, detail: join(device.name !== device.model ? device.model : null, slot) };
  const runtime = /^(.*\S)\s+(\d+(?:\.\d+)*)$/.exec(device.model);
  if (runtime) return { name: runtime[1]!, detail: join(`iOS ${runtime[2]}`, slot) };
  return device.model === 'iOS Simulator'
    ? { name: device.name, detail: join('Simulator', slot) }
    : { name: device.model, detail: join('Simulator', slot) };
}

export interface BuildLine {
  platform: Platform;
  main: string;
  sub: string | null;
  tone: 'default' | 'error' | 'secondary';
}

export function buildLine(platform: Platform, last: LastBuild | undefined, plan: PlanState | undefined): BuildLine {
  if (last) {
    if (last.status === 'failed') return { platform, main: 'Failed', sub: null, tone: 'error' };
    return {
      platform,
      main: last.durationMs === null ? '\u2014' : clockDuration(last.durationMs),
      sub: last.cacheHit ? 'hit' : 'cold',
      tone: 'default',
    };
  }
  if (plan?.kind === 'done' && !plan.plan.refusal) {
    return {
      platform,
      main: plan.plan.expectedMs === null ? '\u2014' : `~${clockDuration(plan.plan.expectedMs)}`,
      sub: plan.plan.cacheHit ? 'hit' : 'cold',
      tone: 'secondary',
    };
  }
  if (plan?.kind === 'checking') return { platform, main: 'Checking\u2026', sub: null, tone: 'secondary' };
  return { platform, main: 'No build', sub: null, tone: 'secondary' };
}

export function usedPlatforms(env: EnvironmentState): Platform[] {
  const build = runningBuild(env);
  return (['ios', 'android'] as const).filter(
    (platform) =>
      build?.platform === platform ||
      env.lastBuilds?.[platform] ||
      env[platform] ||
      env.slots?.some((slot) => slot[platform]) ||
      env.remoteDevices?.some((remote) => remote.platform === platform),
  );
}

export const PHASE_ORDER: readonly BuildPhase[] = [
  'prepare',
  'cache-lookup',
  'wait',
  'prebuild',
  'pods',
  'compile',
  'install',
  'launch',
];

const PHASE_NAMES: Record<BuildPhase, string> = {
  prepare: 'Prepare',
  'cache-lookup': 'Cache lookup',
  wait: 'Wait',
  prebuild: 'Prebuild',
  pods: 'Pods',
  compile: 'Compile',
  install: 'Install',
  launch: 'Launch',
};

export const phaseName = (phase: BuildPhase) => PHASE_NAMES[phase];

export interface PhaseStep {
  phase: BuildPhase;
  state: 'done' | 'current' | 'pending';
  elapsedMs: number | null;
  expectedMs: number | null;
  fraction: number | null;
}

export function referenceRun(build: BuildReport, history: readonly BuildHistoryEntry[]): BuildHistoryEntry | null {
  const hit = build.outcome === 'hit';
  return (
    history.find(
      (entry) =>
        entry.result === 'succeeded' &&
        entry.slot === build.slot &&
        (build.outcome === null || Boolean(entry.cacheHit) === hit),
    ) ?? null
  );
}

export function phaseSteps(build: BuildReport, history: readonly BuildHistoryEntry[], now: number): PhaseStep[] {
  const reference = referenceRun(build, history)?.phases ?? {};
  const currentIndex = PHASE_ORDER.indexOf(build.phase);
  const phases = PHASE_ORDER.filter((phase, i) => i === currentIndex || reference[phase] !== undefined);
  const phaseStart = Date.parse(build.phaseStartedAt);
  const inPhase = Number.isFinite(phaseStart) ? Math.max(0, now - phaseStart) : null;
  return phases.map((phase) => {
    const i = PHASE_ORDER.indexOf(phase);
    const expectedMs =
      phase === build.phase ? (build.expectedPhaseMs ?? reference[phase] ?? null) : (reference[phase] ?? null);
    if (i < currentIndex) return { phase, state: 'done', elapsedMs: null, expectedMs, fraction: 1 };
    if (i > currentIndex) return { phase, state: 'pending', elapsedMs: null, expectedMs, fraction: 0 };
    const { done, total } = build.detail ?? {};
    const fraction =
      typeof done === 'number' && typeof total === 'number' && total > 0
        ? Math.min(1, done / total)
        : expectedMs && inPhase !== null
          ? Math.min(0.95, inPhase / expectedMs)
          : null;
    return { phase, state: 'current', elapsedMs: inPhase, expectedMs, fraction };
  });
}

const STEP_NAMES: Record<NonNullable<NonNullable<BuildReport['detail']>['step']>, string> = {
  configure: 'Configuring',
  compile: 'Compiling',
  link: 'Linking',
  resources: 'Copying resources',
  script: 'Running scripts',
  dex: 'Dexing',
  package: 'Packaging',
  sign: 'Signing',
};

const BAR_GROUP: Record<BuildPhase, BuildPhase> = {
  prepare: 'prepare',
  'cache-lookup': 'prepare',
  wait: 'prepare',
  prebuild: 'prebuild',
  pods: 'pods',
  compile: 'compile',
  install: 'install',
  launch: 'install',
};

export function barSteps(steps: PhaseStep[]): PhaseStep[] {
  const groups: PhaseStep[] = [];
  for (const step of steps) {
    const phase = BAR_GROUP[step.phase];
    const group = groups.find((g) => g.phase === phase);
    if (!group) {
      groups.push({ ...step, phase });
      continue;
    }
    const expected = (group.expectedMs ?? 0) + (step.expectedMs ?? 0);
    const doneMs =
      (group.state === 'done' ? (group.expectedMs ?? 0) : 0) + (step.state === 'done' ? (step.expectedMs ?? 0) : 0);
    const currentMs =
      step.state === 'current'
        ? (step.fraction ?? 0) * (step.expectedMs ?? 0)
        : group.state === 'current'
          ? (group.fraction ?? 0) * (group.expectedMs ?? 0)
          : 0;
    const state = group.state === step.state ? step.state : 'current';
    groups[groups.length - 1] = {
      phase,
      state,
      elapsedMs: null,
      expectedMs: expected || null,
      fraction:
        state === 'done'
          ? 1
          : state === 'pending'
            ? 0
            : expected
              ? Math.min(0.95, (doneMs + currentMs) / expected)
              : (step.fraction ?? group.fraction),
    };
  }
  return groups;
}

export function currentPhaseLabel(build: BuildReport): { phase: string; counts: string | null } {
  const detail = build.detail;
  const phase = detail?.step ? STEP_NAMES[detail.step] : phaseName(build.phase);
  if (!detail?.unit || typeof detail.done !== 'number') return { phase, counts: null };
  return {
    phase,
    counts:
      typeof detail.total === 'number'
        ? `${detail.done} of ${detail.total} ${detail.unit}`
        : `${detail.done} ${detail.unit}`,
  };
}

export function otherPlatformLine(env: EnvironmentState, building: Platform, now: number): string | null {
  const other: Platform = building === 'ios' ? 'android' : 'ios';
  if (!usedPlatforms(env).includes(other)) return null;
  const last = env.lastBuilds?.[other];
  if (!last) return `${platformName(other)} \u00B7 no build recorded`;
  if (last.status === 'failed') {
    const since = ago(now, last.finishedAt ?? last.startedAt);
    return `${platformName(other)} \u00B7 last build failed${since ? `, ${since} ago` : ''}`;
  }
  const since = ago(now, last.finishedAt ?? last.startedAt);
  const took = last.durationMs === null ? null : clockDuration(last.durationMs);
  return `${platformName(other)} \u00B7 last build ${[took, since ? `${since} ago` : null].filter(Boolean).join(', ')}`;
}

export interface BundleLine {
  text: string;
  tone: 'default' | 'error' | 'tertiary';
}

export function bundleLine(env: EnvironmentState, now: number, reportsBundles: boolean): BundleLine | null {
  const metro = env.metro;
  if (!metro) return null;
  const bundle = metro.bundle;
  if (!bundle) return reportsBundles && metro.running ? { text: 'Not bundled yet', tone: 'tertiary' } : null;
  if (bundle.bundling) {
    const pct = typeof bundle.percent === 'number' ? ` \u00B7 ${Math.round(bundle.percent)}%` : '';
    return { text: `Bundling${pct}`, tone: 'default' };
  }
  const last = bundle.last;
  if (!last) return null;
  const finished = Date.parse(last.finishedAt);
  const since = Number.isFinite(finished) ? sinceLabel(now - finished) : null;
  const when = since ? ` \u00B7 ${since} ago` : '';
  if (last.status === 'failed') return { text: `Bundle failed${when}`, tone: 'error' };
  return { text: `Bundled in ${(last.durationMs / 1000).toFixed(1)}s${when}`, tone: 'tertiary' };
}

export type MetroHealth = 'healthy' | 'unhealthy' | 'stopped';

export function metroHealth(env: EnvironmentState): MetroHealth | null {
  if (!env.metro) return null;
  if (!env.metro.running) return 'stopped';
  return env.supervisor?.healthy === false ? 'unhealthy' : 'healthy';
}

export interface AgentRow {
  tool: string | null;
  text: string;
}

export function agentRow(
  activity: DeviceActivity | undefined,
  last: { ts: number; msg: string } | null,
  now: number,
): AgentRow {
  const lastText = last ? `${last.msg} \u00B7 ${sinceLabel(now - last.ts)} ago` : null;
  if (activity?.state === 'driven') {
    return { tool: activity.driver?.tool ?? 'Agent', text: lastText ?? 'no action yet' };
  }
  const idleSince = last?.ts ?? (activity?.lastActivityAt ? Date.parse(activity.lastActivityAt) : NaN);
  return {
    tool: null,
    text: Number.isFinite(idleSince) ? `idle ${shortDuration(Math.max(0, now - idleSince))}` : 'nothing yet',
  };
}

export function sparkline(values: readonly (number | null)[]): (number | null)[] {
  const top = Math.max(0, ...values.map((v) => v ?? 0));
  return values.map((v) => (v === null ? null : top > 0 ? Math.max(0, v) / top : 0));
}

export interface WorkspaceSeries {
  cpuPercent: (number | null)[];
  memoryMb: (number | null)[];
  minutes: number;
  peakCpuPercent: number | null;
  memoryChangeMb: number | null;
}

export function workspaceSeries(usage: StatusUsage | null | undefined, path: string): WorkspaceSeries | null {
  const series = usage?.environments.find((entry) => entry.workspace === path);
  if (!usage || !series) return null;
  const cpu = series.cpuPercent.filter((v): v is number => v !== null);
  const memory = series.memoryMb.filter((v): v is number => v !== null);
  if (cpu.length === 0 && memory.length === 0) return null;
  return {
    cpuPercent: series.cpuPercent,
    memoryMb: series.memoryMb,
    minutes: Math.round((Math.max(series.cpuPercent.length, series.memoryMb.length) * usage.intervalMs) / 60_000),
    peakCpuPercent: cpu.length ? Math.max(...cpu) : null,
    memoryChangeMb: memory.length > 1 ? memory.at(-1)! - memory[0]! : null,
  };
}

export function sinceLabel(ms: number): string {
  const clamped = Math.max(0, ms);
  return clamped < 60_000 ? `${Math.floor(clamped / 1000)}s` : shortDuration(clamped);
}

export type ChipTone = 'default' | 'secondary' | 'tertiary' | 'success' | 'warning' | 'error' | 'brand';

export interface GitChip {
  parts: { text: string; tone: ChipTone }[];
  clean: boolean;
  pr: { text: string; tone: ChipTone; checks: ChipTone | null } | null;
  label: string;
}

const PR_TONE: Record<PullRequestFacts['state'], ChipTone> = {
  open: 'success',
  draft: 'tertiary',
  merged: 'brand',
  closed: 'error',
};

export function checksTone(checks: PullRequestFacts['checks']): ChipTone | null {
  if (!checks) return null;
  if (checks.failing > 0) return 'error';
  if (checks.pending > 0) return 'warning';
  return checks.passing > 0 ? 'success' : null;
}

export function gitChip(worktree: WorktreeFacts | null | undefined): GitChip | null {
  const git = worktree?.git;
  if (!git) return null;
  const badges = gitBadges(git);
  const parts: GitChip['parts'] = [];
  if (badges?.arrows) parts.push({ text: badges.arrows, tone: 'default' });
  if (badges?.uncommitted) parts.push({ text: `${badges.uncommitted} changed`, tone: 'secondary' });
  if (badges?.merged) parts.push({ text: `merged into ${git.mergedInto}`, tone: 'brand' });
  else if (git.upstream === null) parts.push({ text: 'no upstream', tone: 'tertiary' });
  const clean = parts.length === 0;
  const pull = worktree.pullRequest;
  const pr = pull ? { text: `PR #${pull.number}`, tone: PR_TONE[pull.state], checks: checksTone(pull.checks) } : null;
  const label = [
    badges?.label,
    !badges?.merged && git.upstream === null ? 'no upstream' : null,
    clean ? 'clean' : null,
    pull ? `pull request ${pull.number}, ${pull.state}` : null,
  ]
    .filter(Boolean)
    .join(', ');
  return { parts, clean, pr, label };
}

export function checksSummary(checks: PullRequestFacts['checks']): string | null {
  if (!checks) return null;
  const parts = [
    checks.failing ? `${checks.failing} failing` : null,
    checks.pending ? `${checks.pending} pending` : null,
    checks.passing ? `${checks.passing} passing` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : 'No checks';
}
