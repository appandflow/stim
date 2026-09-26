import type { IdleStopRecord } from './workspace-state.ts';
export type StatsPlatform = 'ios' | 'android';

export type RunOutcomeKind = 'hit' | 'cold';

export const BUILD_PHASES = [
  'prepare',
  'cache-lookup',
  'wait',
  'prebuild',
  'pods',
  'compile',
  'install',
  'launch',
] as const;

export type BuildPhase = (typeof BUILD_PHASES)[number];

export type ActiveBuildState = 'running' | 'stale' | 'unknown';

export interface BuildReport {
  platform: StatsPlatform;
  slot: string;
  state: ActiveBuildState;
  phase: BuildPhase;
  startedAt: string;
  phaseStartedAt: string;
  outcome: RunOutcomeKind | null;
  expectedMs: number | null;
  expectedPhaseMs: number | null;
  basis: number;
}

/** Where a build's app came from: a cache tier, or `false` when it compiled or failed before one was found. */
export type BuildCacheHit = 'local' | 'remote' | false;

/** A platform's most recent `ios` or `android` run in one workspace. */
export interface LastBuildReport {
  platform: StatsPlatform;
  status: 'ok' | 'failed';
  cacheHit: BuildCacheHit;
  cacheSkipped: boolean;
  durationMs: number | null;
  fingerprint: string | null;
  startedAt: string;
  finishedAt: string | null;
  errorCode?: string;
  missReason?: BuildMissReason;
}

/** What kind of native input a changed fingerprint source is. */
export type BuildMissCategory =
  | 'native-dependency'
  | 'config-plugin'
  | 'app-config'
  | 'app-asset'
  | 'package'
  | 'native-dir'
  | 'autolinking'
  | 'package-scripts'
  | 'file'
  | 'other';

export interface BuildMissChange {
  source: string;
  change: 'added' | 'removed' | 'changed';
  category: BuildMissCategory;
}

/**
 * Why a run compiled instead of installing a cached app. `changes` holds at most 20 entries,
 * ordered by importance; `changeCount` is the full number of changed fingerprint sources.
 * Only a plan reports `prebuild-pending`: the run would prebuild before compiling, so the changes
 * compare the fingerprint before that prebuild.
 */
export interface BuildMissReason {
  kind: 'changed' | 'no-baseline' | 'same-sources' | 'cache-skipped' | 'fingerprint-error' | 'prebuild-pending';
  summary: string;
  changes: BuildMissChange[];
  changeCount: number;
  /** `cacheKey` is kept in workspace state so a later miss can find this baseline; status omits it. */
  baseline: { fingerprint: string; cacheKey?: string; from: 'workspace' | 'project' } | null;
  rekeyedBy: string[];
}

/** The payload `stim ios --plan --json` and `stim android --plan --json` print. */
export interface BuildPlanPayload {
  platform: StatsPlatform;
  slot?: string;
  fingerprint: string;
  cacheKey: string | null;
  cacheHit: BuildCacheHit;
  provider: string | null;
  cacheSkipped: boolean;
  prebuild: 'none' | 'generate' | 'regenerate' | 'refuse' | null;
  outcome: RunOutcomeKind | null;
  expectedMs: number | null;
  basis: number;
  /** On a predicted miss with cache reads on, why the cache has no app; `baseline` omits `cacheKey`. */
  missReason?: BuildMissReason;
  refusal?: { code: string; message: string; remedy: string };
}

type ActivityState = 'driven' | 'active' | 'idle' | 'unknown';

export interface ActivityDriver {
  tool: string;
  pid: number | null;
  since: string | null;
}

export interface DeviceActivity {
  state: ActivityState;
  driver?: ActivityDriver;
  lastActivityAt?: string;
  basis: string[];
}

/** Every state a device's app process can report. */
export const APP_PROCESS_STATES = ['running', 'stopped', 'unknown'] as const;

/**
 * Whether the workspace's app process is alive on a device now. This is current process state, not launch evidence:
 * `launched` in an `ios` or `android` result stays the record of one launch. `id` is the bundle identifier or
 * package that was checked; `state` is "unknown" when the process listing could not be read.
 */
export interface DeviceAppProcess {
  id: string;
  state: (typeof APP_PROCESS_STATES)[number];
}

/**
 * A linked worktree's `git status`. `changed` counts tracked paths with staged or unstaged changes, including
 * conflicts; `untracked` counts untracked entries as `git status` lists them, so an untracked directory counts once.
 * `ahead` and `behind` compare HEAD with `upstream`, and are null when there is no upstream or it no longer exists.
 * `mergedInto` names the default branch (`origin/main`) when `gc` would consider the branch merged into it, judged
 * from local refs without fetching.
 */
export interface WorktreeGit {
  changed: number;
  untracked: number;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  mergedInto: string | null;
}

export interface WorktreeFacts {
  path: string;
  branch?: string;
  repository?: string;
  /** Null when git could not be read in time, or the worktree is in a folder status does not open. */
  git?: WorktreeGit | null;
}

export interface AndroidRuntimeFacts {
  serial: string | null;
  state: 'detected' | 'not-detected' | 'missing' | 'unknown';
  error?: string;
}

export interface RemoteDeviceState {
  platform: 'ios' | 'android' | null;
  backend: 'eas';
  sessionId: string;
  state: 'claimed' | 'unclaimed' | 'unknown';
  startedAt: string | null;
  webPreviewUrl: string | null;
}

/** Every code a status issue can carry. */
export const STATUS_ISSUE_CODES = [
  'port-not-ours',
  'sim-missing',
  'sim-without-metro',
  'avd-serial-changed',
  'avd-missing',
  'avd-not-detected',
  'avd-unchecked',
  'supervisor-unverified',
] as const;

export type StatusIssueCode = (typeof STATUS_ISSUE_CODES)[number];

/**
 * One thing in a workspace that needs the user. `remedy` is a command to run from `workspace`; `slot` is absent
 * for the default device slot. `warnings` carries the same issues as text.
 */
export interface StatusIssue {
  code: StatusIssueCode;
  severity: 'error' | 'warning';
  message: string;
  remedy: string;
  workspace: string;
  slot?: string;
}

export interface EnvironmentState {
  slots?: { slot: string; ios: EnvironmentState['ios']; android: EnvironmentState['android'] }[];
  path: string;
  live: boolean;
  memoryMb: number;
  warnings: string[];
  issues: StatusIssue[];
  ios?: {
    name: string | null;
    udid: string;
    owned: boolean;
    state: string;
    activity?: DeviceActivity;
    app?: DeviceAppProcess;
  } | null;
  android?: {
    name: string | undefined;
    owned: boolean;
    physical: boolean;
    serial?: string | null;
    state?: AndroidRuntimeFacts['state'];
    deviceProfile?: string | null;
    activity?: DeviceActivity;
    app?: DeviceAppProcess;
  } | null;
  metro?: { port: number; running: boolean; pid: number | null; idleStop?: IdleStopRecord } | null;
  supervisor?: { pid: number | null; mode: string | null; startedAt: string | null; healthy: boolean } | null;
  logs?: { dir: string; errorsSinceMarker: number } | null;
  worktree?: WorktreeFacts | null;
  remoteDevices?: RemoteDeviceState[];
  build?: BuildReport | null;
  lastBuilds?: Partial<Record<StatsPlatform, LastBuildReport>>;
}

export interface StatusCapacity {
  liveCount: number;
  committedMb: number;
  totalMemoryMb: number;
  overCapacity: boolean;
}

export interface DeviceLeaseState {
  slot?: string;
  path: string;
  platform: string;
  id: string | null;
  deviceName: string | null;
  holder: string | null;
  grantedAt: string | null;
  expiresAt: string | null;
  mine: boolean;
  expired: boolean;
  parsed: boolean;
}

/** The payload `stim status --json` prints, and `status --watch --json` prints on each change. */
export interface StatusPayload {
  environments: (EnvironmentState & { labelOnly?: true })[];
  capacity: StatusCapacity;
  deviceLeases: DeviceLeaseState[];
  unprovisionedWorktrees: WorktreeFacts[];
  simctlAvailable: boolean;
}
