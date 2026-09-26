import { sep } from 'path';
import { parseDeviceSlotKey, projectDeviceSlots } from './devices/device-slots.ts';
import { clockTime, formatElapsed, formatLongDuration, plural } from './command-output.ts';
import type { ProjectRecord } from './workspace/config.ts';
import type { LeaseFileEntry } from './engine/device-lease.ts';
import type { RemoteSessionRecord } from './supervisor/state.ts';
import type {
  AndroidRuntimeFacts,
  BuildReport,
  DeviceActivity,
  DeviceLeaseState,
  EnvironmentState,
  IdleStopRecord,
  RemoteDeviceState,
  StatusCapacity,
  StatusIssue,
  StatusIssueCode,
  WorktreeFacts,
  WorktreeGit,
} from '@stim-cli/core/state';

export type {
  AndroidRuntimeFacts,
  DeviceLeaseState,
  EnvironmentState,
  RemoteDeviceState,
  WorktreeFacts,
} from '@stim-cli/core/state';

const IOS_SIM_MB = 1500;
const ANDROID_EMULATOR_MB = 2500;
const METRO_MB = 700;

export interface SimFacts {
  udid?: string;
  name?: string;
  state?: string;
}

export interface MetroFacts {
  missing?: true;
  metro?: { pid: number } | null;
  notOurs?: string;
}

interface SupervisorFacts {
  pid?: number | null;
  mode?: string | null;
  startedAt?: string | null;
  status: 'ours' | 'stale' | 'unverified';
  reason?: string;
  healthy?: boolean;
}

interface LogsFacts {
  dir: string;
  errorsSinceMarker?: number;
}

export function remoteDeviceState(
  record: RemoteSessionRecord | null,
  ledger: { claims: ReadonlyMap<string, { workspaceRoot: string }>; safe: boolean },
  root: string,
): RemoteDeviceState | null {
  if (!record) return null;
  const claim = ledger.claims.get(record.sessionId);
  return {
    platform: record.platform,
    backend: 'eas',
    sessionId: record.sessionId,
    state: !ledger.safe ? 'unknown' : claim?.workspaceRoot === root ? 'claimed' : 'unclaimed',
    startedAt: record.startedAt,
    webPreviewUrl: record.webPreviewUrl,
  };
}

export interface DiskInfo {
  availableMb: number;
  totalMb: number;
}

export interface VolumeInfo {
  volume: string;
  disk: DiskInfo | null;
}

export interface PoolFacts {
  platform: 'ios' | 'android';
  parked: number;
  max: number;
}

export function poolLine({ platform, parked, max }: PoolFacts): string | null {
  if (parked <= 0) return null;
  const what = plural(parked, `parked ${platform === 'ios' ? 'iOS simulator' : 'Android emulator'}`);
  return max > 0 ? `pool: ${what} (max ${max})` : `pool: ${what} (parking off; gc --delete removes them)`;
}

export const RECENT_LAUNCH_MS: number = 30 * 60 * 1000;

/**
 * The `platform:slot` devices a workspace is using right now: a running build, an unexpired lease it holds, or a
 * launch recorded in the last RECENT_LAUNCH_MS.
 */
export function devicesInUse({
  build,
  leases,
  launches,
  now,
}: {
  build?: BuildReport | null;
  leases: readonly DeviceLeaseState[];
  launches: Readonly<Record<string, { launchedAt: string }>>;
  now: number;
}): Set<string> {
  const keys = new Set<string>();
  if (build?.state === 'running') keys.add(`${build.platform}:${build.slot}`);
  for (const lease of leases) {
    if (lease.mine && !lease.expired) keys.add(`${lease.platform}:${lease.slot ?? 'default'}`);
  }
  for (const [key, launch] of Object.entries(launches)) {
    const device = parseDeviceSlotKey(key);
    const at = Date.parse(launch.launchedAt);
    if (device && now - at < RECENT_LAUNCH_MS) keys.add(`${device.platform}:${device.slot}`);
  }
  return keys;
}

export function environmentState(
  project: ProjectRecord & { __path: string },
  {
    simsByUdid = {},
    metro = null,
    worktrees = [],
    simsAvailable = true,
    androidRuntime = null,
    androidRuntimes = {},
    supervisor = null,
    logs = null,
    remote = null,
    idleStop = null,
    inUse = new Set(),
    slot = 'default',
    workspaceRunning = false,
  }: {
    simsByUdid?: Record<string, SimFacts>;
    metro?: MetroFacts | null;
    worktrees?: WorktreeFacts[];
    simsAvailable?: boolean;
    androidRuntime?: AndroidRuntimeFacts | null;
    androidRuntimes?: Record<string, AndroidRuntimeFacts | null>;
    supervisor?: SupervisorFacts | null;
    logs?: LogsFacts | null;
    remote?: RemoteDeviceState | null;
    idleStop?: IdleStopRecord | null;
    inUse?: ReadonlySet<string>;
    slot?: string;
    workspaceRunning?: boolean;
  } = {},
): EnvironmentState {
  const ios = project.platforms?.ios;
  const android = project.platforms?.android;
  const sim = ios ? simsByUdid[ios.deviceUdid as string] : null;

  const simBooted = Boolean(sim && sim.state === 'Booted');
  const metroRunning = Boolean(metro?.metro);
  const androidDetected = androidRuntime ? Boolean(androidRuntime.serial) : Boolean(android?.serial);
  let live = simBooted || metroRunning || androidDetected || Boolean(remote);

  let memoryMb = 0;
  if (simBooted) memoryMb += IOS_SIM_MB;
  if (androidDetected) memoryMb += ANDROID_EMULATOR_MB;
  if (metroRunning) memoryMb += METRO_MB;

  const running = workspaceRunning || metroRunning || supervisor?.status === 'ours';
  const issues: StatusIssue[] = [];
  const add = (code: StatusIssueCode, message: string, remedy: string, severity: StatusIssue['severity'] = 'warning') =>
    issues.push({
      code,
      severity,
      message,
      remedy,
      workspace: project.__path,
      ...(slot === 'default' ? {} : { slot }),
    });
  const slotFlag = slot === 'default' ? '' : ` --slot ${slot}`;
  if (metro?.notOurs && slot === 'default') {
    add('port-not-ours', `port ${project.metroPort}: ${metro.notOurs}`, 'stim guide errors teardown', 'error');
  }
  if (ios && !sim && simsAvailable) {
    add('sim-missing', `recorded sim ${ios.deviceUdid} no longer exists`, `stim ios${slotFlag}`);
  }
  if (simBooted && project.metroPort && !metroRunning) {
    add('sim-without-metro', 'simulator is booted with no Metro serving it', 'stim start');
  }
  if (androidRuntime && android?.avdName) {
    for (const [code, message] of androidIssues(android, androidRuntime, running || inUse.has(`android:${slot}`))) {
      add(code, message, code === 'avd-unchecked' ? 'stim doctor' : `stim android${slotFlag}`);
    }
  }
  if (supervisor?.status === 'unverified') {
    add(
      'supervisor-unverified',
      `supervisor pid ${supervisor.pid} could not be verified${supervisor.reason ? `: ${supervisor.reason}` : ''}`,
      'stim guide errors teardown',
      'error',
    );
  }

  const slots: NonNullable<EnvironmentState['slots']> = [];
  for (const { slot: name, platforms } of projectDeviceSlots(project).slice(1)) {
    const deviceState = environmentState(
      { ...project, platforms, deviceSlots: undefined },
      {
        simsByUdid,
        simsAvailable,
        metro,
        androidRuntime: androidRuntimes[name],
        inUse,
        slot: name,
        workspaceRunning: running,
      },
    );
    slots.push({ slot: name, ios: deviceState.ios, android: deviceState.android });
    memoryMb += deviceState.memoryMb - (metroRunning ? METRO_MB : 0);
    live ||= deviceState.live;
    issues.push(...deviceState.issues);
  }

  return {
    path: project.__path,
    ...(slots.length ? { slots } : {}),
    live,
    memoryMb,
    warnings: issues.map(issueText),
    issues,
    ios: ios
      ? {
          name: sim?.name ?? null,
          udid: ios.deviceUdid as string,
          owned: Boolean(ios.owned),
          state: sim?.state ?? (simsAvailable ? 'missing' : 'unknown'),
        }
      : null,
    android: android
      ? {
          name: android.avdName ?? android.serial,
          owned: Boolean(android.owned),
          physical: Boolean(android.serial && !android.avdName),
          ...(androidRuntime ? { serial: androidRuntime.serial, state: androidRuntime.state } : {}),
        }
      : null,
    metro: project.metroPort
      ? {
          port: project.metroPort,
          running: metroRunning,
          pid: metro?.metro?.pid ?? null,
          ...(idleStop && !metroRunning ? { idleStop } : {}),
        }
      : null,
    supervisor:
      supervisor && supervisor.status !== 'stale'
        ? {
            pid: supervisor.pid ?? null,
            mode: supervisor.mode ?? null,
            startedAt: supervisor.startedAt ?? null,
            healthy: Boolean(supervisor.healthy),
          }
        : null,
    logs: logs ? { dir: logs.dir, errorsSinceMarker: logs.errorsSinceMarker ?? 0 } : null,
    worktree: enclosingWorktree(worktrees, project.__path),
    remoteDevices: remote ? [remote] : [],
  };
}

function androidIssues(
  android: NonNullable<NonNullable<ProjectRecord['platforms']>['android']>,
  runtime: AndroidRuntimeFacts,
  expected: boolean,
): [StatusIssueCode, string][] {
  const issues: [StatusIssueCode, string][] = [];
  const recordedSerial = android.consolePort ? `emulator-${android.consolePort}` : android.serial;
  if (runtime.serial && recordedSerial && runtime.serial !== recordedSerial) {
    issues.push([
      'avd-serial-changed',
      `owned AVD ${android.avdName} changed serial (${recordedSerial} -> ${runtime.serial}), so Metro forwarding is lost; after the remedy, reopen agent-device on ${runtime.serial}`,
    ]);
  }
  if (runtime.state === 'missing') issues.push(['avd-missing', `recorded AVD ${android.avdName} no longer exists`]);
  if (runtime.state === 'not-detected' && expected) {
    issues.push(['avd-not-detected', `owned AVD ${android.avdName} is not detected by adb`]);
  }
  if (runtime.error) {
    issues.push(['avd-unchecked', `could not check owned AVD ${android.avdName}: ${runtime.error}`]);
  }
  return issues;
}

function issueText(issue: StatusIssue): string {
  return `${issue.slot ? `${issue.slot}: ` : ''}${issue.message}; run \`${issue.remedy}\``;
}

export function activityLabel(activity: DeviceActivity | undefined, now: number): string | null {
  if (!activity) return null;
  if (activity.state === 'driven') {
    const since = Date.parse(activity.driver?.since ?? '');
    const duration = Number.isFinite(since) ? ` for ${formatLongDuration(Math.max(0, now - since))}` : '';
    return `driven by ${activity.driver?.tool ?? 'an unknown tool'}${duration}`;
  }
  if (activity.state === 'unknown') return `activity unknown (${activity.basis.join(', ')})`;
  if (activity.state === 'active') return 'active';
  const last = Date.parse(activity.lastActivityAt ?? '');
  return Number.isFinite(last) ? `idle ${formatLongDuration(Math.max(0, now - last))}` : 'idle (no recorded activity)';
}

export function remoteDeviceLine(remote: RemoteDeviceState): string {
  const claim = remote.state === 'claimed' ? '' : ` (${remote.state})`;
  const watch = remote.webPreviewUrl ? ` -- watch: ${remote.webPreviewUrl}` : '';
  return `remote ${remote.platform ?? '?'}: EAS session ${remote.sessionId} billable${claim}${watch}`;
}

export function capacity(states: EnvironmentState[], totalMemoryMb: number): StatusCapacity {
  const committedMb = states.reduce((n: number, s) => n + s.memoryMb, 0);
  const liveCount = states.filter((s) => s.live).length;
  return {
    liveCount,
    committedMb,
    totalMemoryMb,
    overCapacity: Boolean(totalMemoryMb && committedMb > totalMemoryMb * 0.6),
  };
}

export function parseDfFree(output: unknown): DiskInfo | null {
  const lines = String(output || '')
    .trim()
    .split('\n');
  if (lines.length < 2) return null;
  const lastLine = lines[lines.length - 1];
  if (lastLine === undefined) return null;
  const m = /\s(\d+)\s+(\d+)\s+(\d+)\s+(\d+)%/.exec(lastLine);
  if (!m) return null;
  const totalKb = Number(m[1]);
  const availableKb = Number(m[3]);
  if (!Number.isFinite(totalKb) || !Number.isFinite(availableKb) || totalKb <= 0) return null;
  return { availableMb: Math.round(availableKb / 1024), totalMb: Math.round(totalKb / 1024) };
}

export function diskIsTight(disk: DiskInfo | null | undefined): boolean {
  return Boolean(disk && disk.availableMb < 25 * 1024);
}

export function formatSpace(mb: number): string {
  if (!Number.isFinite(mb)) return '?';
  if (mb >= 1024 * 1024) return `${(mb / (1024 * 1024)).toFixed(1)} TB`;
  if (mb >= 1024) return `${Math.round(mb / 1024)} GB`;
  return `${Math.round(mb)} MB`;
}

export function diskLine(volumes: VolumeInfo[] | null | undefined): string | null {
  const usable = (volumes || []).filter((v): v is VolumeInfo & { disk: DiskInfo } => Boolean(v && v.disk));
  if (usable.length === 0) return null;
  if (usable.length === 1) {
    const first = usable[0];
    if (!first) return null;
    const { disk } = first;
    return `${formatSpace(disk.availableMb)} free of ${formatSpace(disk.totalMb)} on disk.`;
  }
  return `${usable.map((v) => `${formatSpace(v.disk.availableMb)} free on ${v.volume}`).join(', ')}.`;
}

export function tightVolumes(volumes: VolumeInfo[] | null | undefined): VolumeInfo[] {
  return (volumes || []).filter((v) => v && diskIsTight(v.disk));
}

function contains(dir: string, path: string): boolean {
  return path === dir || path.startsWith(dir.endsWith(sep) ? dir : dir + sep);
}

function enclosingWorktree(worktrees: WorktreeFacts[], path: string): WorktreeFacts | null {
  return worktrees.filter((w) => contains(w.path, path)).toSorted((a, b) => b.path.length - a.path.length)[0] ?? null;
}

/** One line for a worktree's git summary, such as `2 changed, 1 untracked, ahead 3, merged into origin/main`. */
export function gitSummaryText(git: WorktreeGit): string {
  const parts = [
    git.changed ? `${git.changed} changed` : '',
    git.untracked ? `${git.untracked} untracked` : '',
    git.ahead ? `ahead ${git.ahead}` : '',
    git.behind ? `behind ${git.behind}` : '',
    git.mergedInto ? `merged into ${git.mergedInto}` : '',
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : 'clean';
}

export function unprovisionedWorktrees(worktrees: WorktreeFacts[], projectPaths: string[]): WorktreeFacts[] {
  return worktrees.filter((w) => !projectPaths.some((p) => contains(w.path, p)));
}

export function deviceLeaseStates(
  entries: readonly LeaseFileEntry[],
  { root, now }: { root: string | null; now: number },
): DeviceLeaseState[] {
  return entries.map((entry) => {
    const lease = entry.lease;
    return {
      path: entry.path,
      platform: entry.platform,
      ...(lease?.slot ? { slot: lease.slot } : {}),
      id: entry.id,
      deviceName: lease?.deviceName ?? null,
      holder: lease?.holder ?? null,
      grantedAt: lease?.grantedAt ?? null,
      expiresAt: lease?.expiresAt ?? null,
      mine: Boolean(lease && root && lease.holder === root),
      expired: Boolean(lease && Date.parse(lease.expiresAt) <= now),
      parsed: Boolean(lease),
    };
  });
}

export function deviceLeaseLines(states: readonly DeviceLeaseState[], now: number): string[] {
  if (states.length === 0) return [];
  const lines = [`Device leases (${states.length}):`];
  for (const state of states) {
    const device = `${state.platform}${state.slot ? ` [${state.slot}]` : ''} ${state.id ?? state.path}${state.deviceName ? ` (${state.deviceName})` : ''}`;
    if (!state.parsed || state.expiresAt === null) {
      lines.push(`  ${device} -- unreadable lease file, so nothing may take the device: ${state.path}`);
      continue;
    }
    const when = clockTime(state.expiresAt);
    const remaining = Date.parse(state.expiresAt) - now;
    const expiry = state.expired ? `expired at ${when}` : `until ${when} (${formatElapsed(remaining)} left)`;
    lines.push(`  ${device} -- ${state.holder} ${expiry}${state.mine ? ' [this workspace]' : ''}`);
  }
  return lines;
}
