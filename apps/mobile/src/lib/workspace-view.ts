import { plural, t } from '@lingui/core/macro';

import type { Tone } from '@/design/tone';
import { formatBytes, formatDuration, formatMemoryMb, formatSize } from '@/intl/format';
import { clockDuration, gitBadges, machineName, steadyFraction } from '@/lib/format';
import type { PlanState } from '@/lib/plan-checks';
import { platformName, runningBuild, type DeviceRef } from '@/lib/workspaces';
import type {
  BuildHistoryEntry,
  BuildPhase,
  BuildReport,
  DeviceActivity,
  DevicePlatform,
  EnvironmentState,
  GitChipFacts,
  LastBuild,
  MachineOwner,
  MachineUsageState,
  Platform,
  PullRequestFacts,
  StageFacts,
  StatusUsage,
  WorktreeFacts,
  WorktreeGit,
} from '@/protocol/types';

export type StageTone = Extract<Tone, 'success' | 'brand' | 'error' | 'warning' | 'tertiary'>;

export interface WorkspaceStage {
  kind: 'running' | 'building' | 'build-failed' | 'warming' | 'ready' | 'stopped' | 'unknown';
  label: string;
  tone: StageTone;
  subtitle: string | null;
}

const ago = (now: number, iso: string | null | undefined): string | null => {
  const at = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(at) ? formatDuration(Math.max(0, now - at)) : null;
};

function latestBuild(env: EnvironmentState): LastBuild | null {
  const builds = [env.lastBuilds?.ios, env.lastBuilds?.android].filter((b): b is LastBuild => Boolean(b));
  return builds.reduce<LastBuild | null>(
    (latest, b) => (latest === null || Date.parse(b.startedAt) > Date.parse(latest.startedAt) ? b : latest),
    null,
  );
}

/** The app presence `stim` reports on the device, or for an older `stim` the same rule run here. */
export function appPresence(env: EnvironmentState, device: DeviceRef): 'none' | 'closed' | null {
  if (!env.stage) return localAppPresence(env, device);
  return device.physical || device.platform === 'web' || device.platform === 'macos'
    ? null
    : device.presence === 'none' || device.presence === 'closed'
      ? device.presence
      : null;
}

/**
 * Status reports `app` whenever it knows the bundle id, and a process that is not running cannot tell a closed app
 * from one never installed. A device counts as having no app only when its platform never built successfully here
 * and the latest build failed.
 */
function localAppPresence(env: EnvironmentState, device: DeviceRef): 'none' | 'closed' | null {
  if (
    !device.running ||
    device.platform === 'web' ||
    device.platform === 'macos' ||
    device.physical ||
    device.app?.state === 'running'
  )
    return null;
  const last = env.lastBuilds?.[device.platform];
  const everBuilt = env.builds?.[device.platform]?.some((entry) => entry.result === 'succeeded') ?? true;
  if (last?.status === 'failed' && !everBuilt) return 'none';
  return device.app?.state === 'stopped' ? 'closed' : null;
}

function stageFacts(
  kind: StageFacts['kind'],
  since: string | null | undefined,
  platform: StageFacts['platform'] = null,
) {
  return { kind, since: since ?? null, platform, closedApps: [] } satisfies StageFacts;
}

/** The stage `stim` decided, for an older `stim` the same rule run here. */
export function localStageFacts(env: EnvironmentState, devices: DeviceRef[]): StageFacts {
  if (env.macos?.build.state === 'running') return stageFacts('building', env.macos.build.startedAt, 'macos');
  if (env.macos?.build.state === 'failed')
    return stageFacts('build-failed', env.macos.build.finishedAt ?? env.macos.build.startedAt, 'macos');
  if (env.macos?.state === 'running' || env.macos?.state === 'orphaned')
    return stageFacts('running', env.macos.build.finishedAt ?? env.macos.build.startedAt, 'macos');
  const build = runningBuild(env);
  if (build) return stageFacts('building', build.startedAt, build.platform);
  if (!env.live && env.phase === 'warming') return stageFacts('warming', env.phaseSince);
  if (!env.live && env.phase === 'ready') return stageFacts('ready', env.phaseSince);
  const latest = latestBuild(env);
  if (latest?.status === 'failed') {
    return stageFacts('build-failed', latest.finishedAt ?? latest.startedAt, latest.platform);
  }
  if (env.live || (env.remoteDevices?.length ?? 0) > 0) {
    const closedApps = devices
      .filter((d): d is DeviceRef & { platform: Platform } => localAppPresence(env, d) === 'closed')
      .map((d) => ({ platform: d.platform, slot: d.slot }));
    return { ...stageFacts('running', env.supervisor?.startedAt), closedApps };
  }
  return stageFacts('stopped', env.metro?.lastStop?.at);
}

/**
 * The stage line, git chip, phase steps and bundle and agent lines here have Stim Desktop twins in
 * `WorkspaceView.swift`; both replay apps/desktop/Tests/StimKitTests/Fixtures/workspace-view-vectors.json.
 */
export function workspaceStage(env: EnvironmentState, devices: DeviceRef[], now: number): WorkspaceStage {
  const facts = env.stage ?? localStageFacts(env, devices);
  const since = ago(now, facts.since);
  const platform = facts.platform === 'macos' ? 'macOS' : facts.platform ? platformName(facts.platform) : '';
  switch (facts.kind) {
    case 'building':
      return {
        kind: 'building',
        label: t`Building`,
        tone: 'brand',
        subtitle: since ? t`${platform} \u00B7 started ${since} ago` : platform,
      };
    case 'warming': {
      const step =
        env.warmStep === 'copy'
          ? t`copying ignored files`
          : env.warmStep === undefined || env.warmStep === 'refresh'
            ? t`installing dependencies`
            : t`Unknown`;
      return {
        kind: 'warming',
        label: t`Warming`,
        tone: 'warning',
        subtitle: since ? t`${step} \u00B7 ${since}` : step,
      };
    }
    case 'ready':
      return { kind: 'ready', label: t`Ready`, tone: 'success', subtitle: since ? t`warmed ${since} ago` : null };
    case 'build-failed':
      return {
        kind: 'build-failed',
        label: t`Build failed`,
        tone: 'error',
        subtitle: since ? t`${platform} \u00B7 ${since} ago` : platform,
      };
    case 'running': {
      const errors = env.logs?.errorsSinceMarker ?? 0;
      const problems = [
        errors > 0 ? plural(errors, { one: '# error', other: '# errors' }) : null,
        ...facts.closedApps
          .filter((app) => app.platform === 'ios' || app.platform === 'android')
          .map((app) => {
            const platform = platformName(app.platform);
            return t`${platform} app closed`;
          }),
      ].filter((p): p is string => p !== null);
      const up = since;
      return {
        kind: 'running',
        label: t`Running`,
        tone: problems.length ? 'error' : 'success',
        subtitle: [up ? t`up ${up}` : null, ...problems].filter(Boolean).join(' \u00B7 ') || null,
      };
    }
    case 'stopped': {
      const stopped = since;
      return { kind: 'stopped', label: t`Stopped`, tone: 'tertiary', subtitle: stopped ? t`${stopped} ago` : null };
    }
    default:
      return { kind: 'unknown', label: t`Unknown`, tone: 'tertiary', subtitle: null };
  }
}

/** `ps` CPU, where 100 is one core, so a busy workspace reads above 100%. */
export function formatCpu(percent: number): string {
  return `${Math.round(percent)}%`;
}

export interface Usage {
  cpuPercent: number | null;
  memoryMb: number | null;
  diskBytes: number | null;
}

/** The measured resources of a workspace, in CPU, memory, disk order; a resource not measured is left out. */
export const usageParts = (usage: Usage) =>
  [
    usage.cpuPercent === null ? null : { kind: 'cpu' as const, value: formatCpu(usage.cpuPercent), label: t`CPU` },
    usage.memoryMb === null
      ? null
      : { kind: 'memory' as const, value: formatMemoryMb(usage.memoryMb), label: t`memory` },
    usage.diskBytes === null ? null : { kind: 'disk' as const, value: formatBytes(usage.diskBytes), label: t`disk` },
  ].filter((part) => part !== null);

export const usageLabel = (usage: Usage) =>
  usageParts(usage)
    .map(({ label, value }) => `${label} ${value}`)
    .join(', ');

const ownersOf = (machine: MachineUsageState | null | undefined, path: string) =>
  machine?.owners.filter((owner) => owner.workspace === path) ?? [];

export function workspaceUsage(env: EnvironmentState, machine: MachineUsageState | null | undefined): Usage {
  const owners = ownersOf(machine, env.path);
  return {
    cpuPercent: owners.length ? owners.reduce((sum, owner) => sum + owner.cpuPercent, 0) : null,
    memoryMb: owners.length
      ? owners.reduce((sum, owner) => sum + (owner.memoryMb ?? owner.residentMb), 0)
      : env.memoryMb > 0
        ? env.memoryMb
        : null,
    diskBytes: workspaceDiskBytes(env),
  };
}

function workspaceDiskBytes(env: EnvironmentState): number | null {
  const disk = env.disk;
  if (!disk || (disk.worktreeBytes === null && disk.buildBytes === null)) return null;
  return (disk.worktreeBytes ?? 0) + (disk.buildBytes ?? 0);
}

export interface DiskPart {
  kind: 'nodeModules' | 'worktree' | 'build';
  label: string;
  bytes: number;
}

export function diskParts(env: EnvironmentState): DiskPart[] | null {
  const disk = env.disk;
  if (!disk) return null;
  const parts: Omit<DiskPart, 'label'>[] = [];
  const { worktreeBytes, nodeModulesBytes, buildBytes } = disk;
  if (worktreeBytes !== null) {
    if (nodeModulesBytes !== null && nodeModulesBytes > 0 && nodeModulesBytes <= worktreeBytes) {
      parts.push({ kind: 'nodeModules', bytes: nodeModulesBytes });
      if (worktreeBytes > nodeModulesBytes) parts.push({ kind: 'worktree', bytes: worktreeBytes - nodeModulesBytes });
    } else {
      parts.push({ kind: 'worktree', bytes: worktreeBytes });
    }
  }
  if (buildBytes !== null && buildBytes > 0) parts.push({ kind: 'build', bytes: buildBytes });
  const splitOut = parts.some((part) => part.kind === 'nodeModules');
  const labels = {
    nodeModules: 'node_modules',
    worktree: splitOut ? t`Rest of worktree` : t`Worktree`,
    build: t`Build output`,
  };
  return parts.length ? parts.map((part) => ({ ...part, label: labels[part.kind] })) : null;
}

export function diskPartsLabel(parts: DiskPart[]): string {
  return parts.map((part) => `${part.label} ${formatSize(part.bytes)}`).join(', ');
}

const DEVICE_KIND: Record<DeviceRef['platform'], MachineOwner['kind']> = {
  ios: 'simulator',
  android: 'emulator',
  web: 'browser',
  macos: 'macos',
};

/**
 * The owner that holds a device's processes. The emulator owner's id is its AVD name, not the serial a device
 * carries, so devices match on workspace, slot and kind. A physical device runs no process on the Mac.
 */
function deviceOwner(
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
  return {
    cpuPercent: owner?.cpuPercent ?? null,
    memoryMb: owner ? (owner.memoryMb ?? owner.residentMb) : null,
    diskBytes: diskBytes ?? null,
  };
}

export interface ProcessRow {
  key: string;
  label: string;
  cpuPercent: number;
  memoryMb: number;
}

const OWNER_ORDER: MachineOwner['kind'][] = ['simulator', 'emulator', 'browser', 'metro', 'build'];

function withSlot(label: string, slot: string | null): string {
  return slot ? t`${label} \u00B7 ${slot}` : label;
}

function ownerLabel(owner: MachineOwner, devices: DeviceRef[]): string {
  const slot = owner.slot && owner.slot !== 'default' ? owner.slot : null;
  switch (owner.kind) {
    case 'simulator': {
      const device = devices.find((d) => d.platform === 'ios' && d.slot === (owner.slot ?? 'default'));
      const name = device ? deviceTitle(device).name : 'iOS';
      return withSlot(t`${name} simulator`, slot);
    }
    case 'emulator':
      return withSlot(t`Android emulator`, slot);
    case 'browser':
      return t`Chrome (web)`;
    case 'metro':
      return t`Metro`;
    case 'build': {
      if (owner.id !== 'ios' && owner.id !== 'android') return withSlot(t`Build`, slot);
      const platform = platformName(owner.id);
      return withSlot(t`${platform} build`, slot);
    }
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
      memoryMb: owner.memoryMb ?? owner.residentMb,
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
  if (device.platform === 'macos') return { name: device.name, detail: 'macOS' };
  if (device.platform === 'web') return { name: t`Web`, detail: join(device.name, slot) };
  if (device.platform === 'android') {
    return {
      name: device.physical ? device.name : t`Android`,
      detail: join(device.physical ? t`USB` : t`Emulator`, slot),
    };
  }
  if (device.physical)
    return { name: device.name, detail: join(device.name !== device.model ? device.model : null, slot) };
  const runtime = /^(.*\S)\s+(\d+(?:\.\d+)*)$/.exec(device.model);
  if (runtime) {
    const version = runtime[2]!;
    return { name: runtime[1]!, detail: join(t`iOS ${version}`, slot) };
  }
  return device.model === t`iOS Simulator`
    ? { name: device.name, detail: join(t`Simulator`, slot) }
    : { name: device.model, detail: join(t`Simulator`, slot) };
}

export interface BuildLine {
  platform: Platform;
  main: string;
  sub: string | null;
  tone: 'default' | 'error' | 'secondary';
  spoken: string;
}

function fallbackText(machine: string, detail: string): string {
  if (/^busy\b/.test(detail)) return t`${machine} busy`;
  if (/^no less loaded\b/.test(detail)) return t`${machine} no less loaded`;
  if (/^capacity unknown\b/.test(detail)) return t`${machine} too old`;
  if (detail.startsWith('Stim build ')) return t`${machine} on another Stim build`;
  if (/^(CPU|Xcode|simulator SDK|CocoaPods|JDK) /.test(detail)) return t`${machine} toolchain differs`;
  if (/^no (iPhone simulator|Android SDK|NDK|build-tools|platform) /.test(detail)) return t`${machine} missing SDK`;
  if (/ GB free, needs /.test(detail)) return t`${machine} low on disk`;
  return t`${machine} failed`;
}

export interface FallbackLine {
  text: string;
  reason: string;
}

/**
 * A short line for a run that considered offloading and built here, such as "janics-mac-mini busy -> built here",
 * from the first machine `offloadFallback` names; `reason` is the whole of it.
 */
export function fallbackLine(build: Pick<LastBuild, 'offloadFallback'>): FallbackLine | null {
  const reason = build.offloadFallback;
  if (!reason) return null;
  const match = /^([A-Za-z0-9][A-Za-z0-9.-]*(?::\d{1,5})?): (.+)$/.exec(reason);
  const what = match ? fallbackText(machineName(match[1]!), match[2]!) : t`offload skipped`;
  return { text: t`${what} \u2192 built here`, reason };
}

export function buildLine(platform: Platform, last: LastBuild | undefined, plan: PlanState | undefined): BuildLine {
  const name = platformName(platform);
  const line = (main: string, sub: string | null, tone: BuildLine['tone'], spoken: string): BuildLine => ({
    platform,
    main,
    sub,
    tone,
    spoken,
  });
  if (last) {
    if (last.status === 'failed') return line(t`Failed`, null, 'error', t`${name} last build failed`);
    if (last.status !== 'ok' || (last.cacheHit !== false && last.cacheHit !== 'local' && last.cacheHit !== 'remote'))
      return line(t`Unknown`, null, 'secondary', t`Unknown`);
    let cache = t`cold`;
    if (last.cacheHit) cache = t`hit`;
    else if (last.offloadedTo) {
      const machine = machineName(last.offloadedTo);
      cache = t`on ${machine}`;
    }
    if (last.durationMs === null) return line('\u2014', cache, 'default', t`${name} last build ${cache}`);
    const took = clockDuration(last.durationMs);
    return line(took, cache, 'default', t`${name} last build ${took}, ${cache}`);
  }
  if (plan?.kind === 'done' && !plan.plan.refusal) {
    if (plan.plan.cacheHit !== false && plan.plan.cacheHit !== 'local' && plan.plan.cacheHit !== 'remote')
      return line(t`Unknown`, null, 'secondary', t`Unknown`);
    const cache = plan.plan.cacheHit ? t`hit` : t`cold`;
    if (plan.plan.expectedMs === null) {
      return line('\u2014', t`est. ${cache}`, 'secondary', t`${name} next build ${cache}`);
    }
    const took = clockDuration(plan.plan.expectedMs);
    return line(`~${took}`, t`est.`, 'secondary', t`${name} next build about ${took}, ${cache}`);
  }
  if (plan?.kind === 'checking') {
    return line(t`Checking\u2026`, null, 'secondary', t`${name} checking the next build`);
  }
  return line(t`No build`, null, 'secondary', t`${name} no build`);
}

function usedPlatforms(env: EnvironmentState): Platform[] {
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

export function supportedPlatforms(env: EnvironmentState): DevicePlatform[] {
  const used: DevicePlatform[] = [
    ...usedPlatforms(env),
    ...(env.macos ? ['macos' as const] : []),
    ...(env.web ? ['web' as const] : []),
  ];
  const detected = env.platforms ?? (used.length ? [] : ['ios', 'android']);
  return (['ios', 'android', 'macos', 'web'] as const).filter(
    (platform) => detected.includes(platform) || used.includes(platform),
  );
}

export const PHASE_ORDER: readonly BuildPhase[] = [
  'prepare',
  'cache-lookup',
  'wait',
  'prebuild',
  'pods',
  'compile',
  'device',
  'install',
  'launch',
];

export function phaseName(phase: BuildPhase): string {
  switch (phase) {
    case 'prepare':
      return t`Prepare`;
    case 'cache-lookup':
      return t`Cache lookup`;
    case 'wait':
      return t`Wait`;
    case 'prebuild':
      return t`Prebuild`;
    case 'pods':
      return t`Pods`;
    case 'compile':
      return t`Compile`;
    case 'device':
      return t`Device`;
    case 'install':
      return t`Install`;
    case 'launch':
      return t`Launch`;
    default:
      return t`Unknown`;
  }
}

export interface PhaseStep {
  phase: BuildPhase;
  state: 'done' | 'current' | 'pending';
  elapsedMs: number | null;
  expectedMs: number | null;
  fraction: number | null;
}

function referenceRun(build: BuildReport, history: readonly BuildHistoryEntry[]): BuildHistoryEntry | null {
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

/**
 * Each phase's expected duration: the CLI's plan when it sends one, else the workspace's latest comparable run, which
 * is all an older stim offers.
 */
function plannedDurations(
  build: BuildReport,
  history: readonly BuildHistoryEntry[],
): Partial<Record<BuildPhase, number>> {
  if (build.plannedPhases) return Object.fromEntries(build.plannedPhases.map((p) => [p.phase, p.expectedMs]));
  return referenceRun(build, history)?.phases ?? {};
}

/** The build tool's own counts, which only describe `compile`; an older stim also sends them in later phases. */
function compileDetail(build: BuildReport): BuildReport['detail'] {
  return build.phase === 'compile' ? build.detail : undefined;
}

export function phaseSteps(build: BuildReport, history: readonly BuildHistoryEntry[], now: number): PhaseStep[] {
  const reference = plannedDurations(build, history);
  const currentIndex = PHASE_ORDER.indexOf(build.phase);
  const phases = PHASE_ORDER.filter((phase, i) => i === currentIndex || reference[phase] !== undefined);
  const phaseStart = Date.parse(build.phaseStartedAt);
  const inPhase = Number.isFinite(phaseStart) ? Math.max(0, now - phaseStart) : null;
  if (currentIndex < 0)
    return [{ phase: 'unknown', state: 'current', elapsedMs: inPhase, expectedMs: null, fraction: null }];
  return phases.map((phase) => {
    const i = PHASE_ORDER.indexOf(phase);
    const expectedMs =
      phase === build.phase ? (build.expectedPhaseMs ?? reference[phase] ?? null) : (reference[phase] ?? null);
    if (i < currentIndex) return { phase, state: 'done', elapsedMs: null, expectedMs, fraction: 1 };
    if (i > currentIndex) return { phase, state: 'pending', elapsedMs: null, expectedMs, fraction: 0 };
    const { done, total } = compileDetail(build) ?? {};
    const counted = typeof done === 'number' && typeof total === 'number' && total > 0 ? done / total : null;
    const timed = expectedMs && inPhase !== null ? inPhase / expectedMs : null;
    const fraction = counted === null && timed === null ? null : Math.min(0.95, Math.max(counted ?? 0, timed ?? 0));
    return { phase, state: 'current', elapsedMs: inPhase, expectedMs, fraction };
  });
}

function stepName(step: NonNullable<NonNullable<BuildReport['detail']>['step']>): string {
  switch (step) {
    case 'configure':
      return t`Configuring`;
    case 'compile':
      return t`Compiling`;
    case 'link':
      return t`Linking`;
    case 'resources':
      return t`Copying resources`;
    case 'script':
      return t`Running scripts`;
    case 'dex':
      return t`Dexing`;
    case 'package':
      return t`Packaging`;
    case 'sign':
      return t`Signing`;
    default:
      return t`Unknown`;
  }
}

const BAR_GROUP: Record<BuildPhase, BuildPhase> = {
  prepare: 'prepare',
  'cache-lookup': 'prepare',
  wait: 'prepare',
  prebuild: 'prebuild',
  pods: 'pods',
  compile: 'compile',
  device: 'device',
  install: 'install',
  launch: 'install',
};

export function barSteps(steps: PhaseStep[]): PhaseStep[] {
  const groups: PhaseStep[] = [];
  for (const step of steps) {
    const phase = Object.hasOwn(BAR_GROUP, step.phase)
      ? BAR_GROUP[step.phase]
      : step.state === 'current'
        ? 'unknown'
        : undefined;
    if (!phase) continue;
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

/** Each bar segment's share of the bar: its expected duration, at least 18% of the total so a short phase stays visible. */
export function segmentWeights(steps: readonly PhaseStep[]): number[] {
  const total = steps.reduce((sum, step) => sum + (step.expectedMs ?? 0), 0);
  if (total <= 0) return steps.map(() => 1);
  return steps.map((step) => Math.max(step.expectedMs ?? 0, total * 0.18));
}

/**
 * How full each bar segment is drawn for the build `key` names. The bar as a whole never moves backwards, even when
 * the CLI revises its plan once the run knows its outcome: segments fill left to right up to the most the bar
 * showed, but the current segment stops short of full, and a pending one stays empty.
 */
export function barFills(steps: readonly PhaseStep[], key: string): number[] {
  if (!steps.length) return [];
  const weights = segmentWeights(steps);
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const own = steps.map((step) => (step.state === 'current' ? (step.fraction ?? 0.1) : (step.fraction ?? 0)));
  const reached = own.reduce((sum, fill, i) => sum + fill * weights[i]!, 0) / total;
  const current = steps.findIndex((step) => step.state === 'current');
  const ceiling =
    current < 0
      ? steps.reduce((sum, step, i) => sum + (step.state === 'done' ? weights[i]! : 0), 0) / total
      : (weights.slice(0, current).reduce((sum, weight) => sum + weight, 0) + 0.95 * weights[current]!) / total;
  let left = Math.min(steadyFraction(`${key}|bar`, reached), Math.max(reached, ceiling)) * total;
  return weights.map((weight) => {
    const fill = Math.min(1, Math.max(0, left / weight));
    left -= fill * weight;
    return fill;
  });
}

/** Whether a phase bar or checklist names its phases: only with more than one, since the stage line names a lone phase. */
export const namesPhases = (steps: readonly PhaseStep[]) => steps.length > 1;

function remotePhaseName(phase: string): string | null {
  switch (phase) {
    case 'sync':
      return t`Sync`;
    case 'deps':
      return t`Dependencies`;
    case 'prebuild':
      return t`Prebuild`;
    case 'pods':
      return t`Pods`;
    case 'build':
      return t`Compile`;
    case 'fetch':
      return t`Download`;
    default:
      return null;
  }
}

export interface RemoteBuild {
  host: string;
  phase: string;
  phaseElapsedMs: number | null;
}

/** The build machine a running build was offloaded to, and the step it runs there; null for a local build. */
export function remoteBuild(build: BuildReport, now: number): RemoteBuild | null {
  const placement = build.placement;
  if (!placement || typeof placement === 'string') return null;
  const started = Date.parse(placement.phaseStartedAt);
  return {
    host: machineName(placement.host),
    phase: remotePhaseName(placement.phase) ?? placement.phase.charAt(0).toUpperCase() + placement.phase.slice(1),
    phaseElapsedMs: Number.isFinite(started) ? Math.max(0, now - started) : null,
  };
}

export function currentPhaseLabel(build: BuildReport): { phase: string; counts: string | null } {
  const detail = compileDetail(build);
  const remote = remoteBuild(build, 0);
  const phase = detail?.step ? stepName(detail.step) : (remote?.phase ?? phaseName(build.phase));
  if ((detail?.unit !== 'tasks' && detail?.unit !== 'targets') || typeof detail.done !== 'number')
    return { phase, counts: null };
  const { done, unit, total } = detail;
  return {
    phase,
    counts: typeof total === 'number' ? t`${done} of ${total} ${unit}` : `${done} ${unit}`,
  };
}

export function otherPlatformLine(env: EnvironmentState, building: string, now: number): string | null {
  if (building !== 'ios' && building !== 'android') return null;
  const other: Platform = building === 'ios' ? 'android' : 'ios';
  if (!usedPlatforms(env).includes(other)) return null;
  const last = env.lastBuilds?.[other];
  const name = platformName(other);
  if (!last) return t`${name} \u00B7 no build recorded`;
  const since = ago(now, last.finishedAt ?? last.startedAt);
  if (last.status === 'failed') {
    return since ? t`${name} \u00B7 last build failed, ${since} ago` : t`${name} \u00B7 last build failed`;
  }
  if (last.status !== 'ok') return t`${name} \u00B7 Unknown`;
  const took = last.durationMs === null ? null : clockDuration(last.durationMs);
  const list = [took, since ? t`${since} ago` : null].filter(Boolean).join(', ');
  return t`${name} \u00B7 last build ${list}`;
}

export interface BundleLine {
  text: string;
  tone: 'default' | 'error' | 'tertiary';
}

export function bundleLine(env: EnvironmentState, now: number, reportsBundles: boolean): BundleLine | null {
  const metro = env.metro;
  if (!metro) return null;
  const bundle = metro.bundle;
  if (!bundle) return reportsBundles && metro.running ? { text: t`Not bundled yet`, tone: 'tertiary' } : null;
  if (bundle.bundling) {
    if (typeof bundle.percent !== 'number') return { text: t`Bundling`, tone: 'default' };
    const percent = Math.round(bundle.percent);
    return { text: t`Bundling \u00B7 ${percent}%`, tone: 'default' };
  }
  const last = bundle.last;
  if (!last) return null;
  if (last.status !== 'ok' && last.status !== 'failed') return null;
  if (last.status === 'failed') {
    const finished = Date.parse(last.finishedAt);
    const since = Number.isFinite(finished) ? formatDuration(now - finished, { seconds: true }) : null;
    return { text: since ? t`Bundle failed \u00B7 ${since} ago` : t`Bundle failed`, tone: 'error' };
  }
  const seconds = (last.durationMs / 1000).toFixed(1);
  const finished = Date.parse(last.finishedAt);
  const since = Number.isFinite(finished) ? formatDuration(now - finished, { seconds: true }) : null;
  return { text: since ? t`Bundled in ${seconds}s \u00B7 ${since} ago` : t`Bundled in ${seconds}s`, tone: 'tertiary' };
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
  let lastText: string | null = null;
  if (last) {
    const { msg } = last;
    const elapsed = formatDuration(now - last.ts, { seconds: true });
    lastText = t`${msg} \u00B7 ${elapsed} ago`;
  }
  if (activity?.state === 'driven') {
    return { tool: activity.driver?.tool ?? t`Agent`, text: lastText ?? t`no action yet` };
  }
  const idleSince = last?.ts ?? (activity?.lastActivityAt ? Date.parse(activity.lastActivityAt) : NaN);
  const idle = Number.isFinite(idleSince) ? formatDuration(Math.max(0, now - idleSince)) : null;
  return { tool: null, text: idle === null ? t`nothing yet` : t`idle ${idle}` };
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

export type ChipTone = Extract<Tone, 'default' | 'secondary' | 'tertiary' | 'success' | 'warning' | 'error' | 'brand'>;

export type CiState = 'passing' | 'failing' | 'pending';

export interface GitChip {
  parts: { text: string; tone: ChipTone }[];
  pr: { text: string; tone: ChipTone; ci: CiState | null } | null;
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

function ciState(checks: PullRequestFacts['checks']): CiState | null {
  if (!checks) return null;
  if (checks.failing > 0) return 'failing';
  if (checks.pending > 0) return 'pending';
  return checks.passing > 0 ? 'passing' : null;
}

function prText(number: number): string {
  return t`PR #${number}`;
}

function pullRequestLabel(number: number, state: PullRequestFacts['state']): string {
  switch (state) {
    case 'open':
      return t`Pull request ${number}, open`;
    case 'draft':
      return t`Pull request ${number}, draft`;
    case 'merged':
      return t`Pull request ${number}, merged`;
    case 'closed':
      return t`Pull request ${number}, closed`;
    default:
      return prText(number);
  }
}

function checksLabel(ci: CiState): string {
  switch (ci) {
    case 'passing':
      return t`checks passing`;
    case 'failing':
      return t`checks failing`;
    case 'pending':
      return t`checks pending`;
  }
}

/** The chip `stim` reports, for an older `stim` the same rule run here. */
export function localGitChipFacts(git: WorktreeGit, pull: PullRequestFacts | null | undefined): GitChipFacts {
  const parts: GitChipFacts['parts'] = [];
  const ahead = git.ahead ?? 0;
  const behind = git.behind ?? 0;
  if (ahead || behind) parts.push({ kind: 'arrows', ahead, behind });
  const uncommitted = git.changed + git.untracked;
  if (uncommitted) parts.push({ kind: 'changed', count: uncommitted });
  if (git.mergedInto !== null) {
    if (pull?.state !== 'merged') parts.push({ kind: 'merged', into: git.mergedInto });
  } else if (git.upstream === null) {
    parts.push({ kind: 'no-upstream' });
  }
  return { parts, ci: pull ? ciState(pull.checks) : null };
}

function chipPart(part: GitChipFacts['parts'][number]): GitChip['parts'][number] | null {
  switch (part.kind) {
    case 'arrows': {
      const arrows = [part.ahead ? `\u2191${part.ahead}` : '', part.behind ? `\u2193${part.behind}` : '']
        .filter(Boolean)
        .join(' ');
      return arrows ? { text: arrows, tone: 'default' } : null;
    }
    case 'changed': {
      if (part.count === undefined) return null;
      const uncommitted = part.count;
      return { text: t`${uncommitted} changed`, tone: 'secondary' };
    }
    case 'merged': {
      if (part.into === undefined) return null;
      const mergedInto = part.into;
      return { text: t`merged into ${mergedInto}`, tone: 'brand' };
    }
    case 'no-upstream':
      return { text: t`no upstream`, tone: 'tertiary' };
    default:
      return null;
  }
}

export function gitChip(worktree: WorktreeFacts | null | undefined): GitChip | null {
  const git = worktree?.git;
  if (!git) return null;
  const badges = gitBadges(git);
  const pull = worktree.pullRequest;
  const facts = worktree.gitChip ?? localGitChipFacts(git, pull);
  const parts = facts.parts.map(chipPart).filter((part) => part !== null);
  const ci = pull && (facts.ci === 'passing' || facts.ci === 'failing' || facts.ci === 'pending') ? facts.ci : null;
  const label = [
    pull ? pullRequestLabel(pull.number, pull.state) : t`Branch`,
    ci ? checksLabel(ci) : null,
    badges?.label,
    facts.parts.some((part) => part.kind === 'no-upstream') ? t`no upstream` : null,
    !pull && parts.length === 0 ? t`up to date` : null,
  ]
    .filter(Boolean)
    .join(', ');
  return {
    parts,
    pr: pull
      ? { text: prText(pull.number), tone: Object.hasOwn(PR_TONE, pull.state) ? PR_TONE[pull.state]! : 'tertiary', ci }
      : null,
    label,
  };
}

export function checksSummary(checks: PullRequestFacts['checks']): string | null {
  if (!checks) return null;
  const { failing, pending, passing } = checks;
  const parts = [
    failing ? t`${failing} failing` : null,
    pending ? t`${pending} pending` : null,
    passing ? t`${passing} passing` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : t`No checks`;
}
