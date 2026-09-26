import type { WebViewport } from './settings-registry.ts';
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
  /** The first compiler diagnostics of a failed build, when the build tool reported any. */
  diagnostics?: BuildDiagnostic[];
}

/** How a recorded build ended. `interrupted` is a run whose process ended without recording a result. */
export const BUILD_RESULTS = ['succeeded', 'failed', 'cancelled', 'interrupted'] as const;

export type BuildResult = (typeof BUILD_RESULTS)[number];

/**
 * One run in a workspace's recent build history. `configuration` is the iOS configuration or the Android
 * variant the run built, `Debug` or `debug` by default, and null when the run ended before resolving it.
 * `phases` holds the milliseconds spent in each phase the run entered. An interrupted run has null
 * `durationMs` and `finishedAt`, no cache facts, and 0 for the phase it stopped in.
 */
export interface BuildHistoryEntry extends LastBuildReport {
  result: BuildResult;
  slot: string;
  configuration: string | null;
  cacheKey: string | null;
  phases: Partial<Record<BuildPhase, number>>;
}

/** One compiler error from a failed build: where it is, when the tool said, and its message. */
export interface BuildDiagnostic {
  file: string | null;
  line: number | null;
  column: number | null;
  message: string;
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
  'browser-unverified',
  'browser-orphaned',
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

/**
 * The workspace's Stim-owned Chrome. `pid` is Chrome's process and `supervisorPid` the Stim process that holds
 * its DevTools session. `cdpEndpoint` is the loopback DevTools HTTP endpoint agents can attach to, null when the
 * browser is not running. `profile` is the Stim-owned user data directory.
 */
export interface WebBrowserState {
  browser: 'chrome';
  version: string | null;
  running: boolean;
  pid: number | null;
  supervisorPid: number | null;
  url: string;
  headless: boolean;
  viewport: WebViewport;
  profile: string;
  cdpEndpoint: string | null;
}

export interface EnvironmentState {
  slots?: { slot: string; ios: EnvironmentState['ios']; android: EnvironmentState['android'] }[];
  path: string;
  live: boolean;
  /**
   * A fixed estimate, not a measurement: a set amount per booted simulator, detected emulator, running Metro and
   * running Chrome. `capacity.committedMb` sums it. What the workspace's processes use now is in `machine`.
   */
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
  web?: WebBrowserState | null;
  supervisor?: { pid: number | null; mode: string | null; startedAt: string | null; healthy: boolean } | null;
  logs?: { dir: string; errorsSinceMarker: number } | null;
  worktree?: WorktreeFacts | null;
  remoteDevices?: RemoteDeviceState[];
  build?: BuildReport | null;
  lastBuilds?: Partial<Record<StatsPlatform, LastBuildReport>>;
  /** Each platform's recent runs, newest first, at most `BUILD_HISTORY_LIMIT` each. */
  builds?: Partial<Record<StatsPlatform, BuildHistoryEntry[]>>;
}

/** `committedMb` sums the environments' estimated `memoryMb`; `overCapacity` is that sum over 60% of `totalMemoryMb`. */
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

/** Every kind of process owner the status machine section reports. */
export const MACHINE_OWNER_KINDS = ['simulator', 'emulator', 'metro', 'build', 'browser', 'server', 'shared'] as const;

export type MachineOwnerKind = (typeof MACHINE_OWNER_KINDS)[number];

/**
 * One thing using this Mac's CPU and memory now. Each process is counted in exactly one owner: the one whose root
 * process is its nearest ancestor. `workspace` and `slot` (absent for the default slot) name the workspace a
 * simulator, emulator, Metro, build or Chrome belongs to; a device no workspace records has a null workspace, and
 * machine-wide processes are `shared`. `id` is the simulator's UDID, the emulator's AVD name, Metro's port as text,
 * the build's platform, or null. `owned` is true only for what Stim started and stops: a workspace's owned device,
 * Metro, build or Chrome. `cpuPercent` is `ps` %CPU summed over the owner's processes, where 100 is one core.
 * `residentMb` sums their resident set sizes; pages shared between processes count once per process, so a
 * simulator, whose processes all map the runtime's shared libraries, reports well above its physical footprint.
 */
export interface MachineOwner {
  kind: MachineOwnerKind;
  name: string;
  workspace: string | null;
  slot?: string;
  id: string | null;
  owned: boolean;
  cpuPercent: number;
  residentMb: number;
  processes: number;
}

/** Where this machine's CPU and resident memory go, from one pass over the host process table. */
export interface MachineUsageState {
  owners: MachineOwner[];
}

/** The payload `stim status --json` prints, and `status --watch --json` prints on each change. */
export interface StatusPayload {
  environments: (EnvironmentState & { labelOnly?: true })[];
  capacity: StatusCapacity;
  deviceLeases: DeviceLeaseState[];
  unprovisionedWorktrees: WorktreeFacts[];
  simctlAvailable: boolean;
  /** Null when nothing runs that status attributes, so it read no process table, or when the table was unreadable. */
  machine: MachineUsageState | null;
}
