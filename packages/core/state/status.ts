import type { HostedIosStatus } from './hosted-ios.ts';
import type { ArchivedWorkspace, ArchivedUsage } from './archive.ts';
import type { MacosAppState } from './macos.ts';
import type { TunnelMode, WebViewport } from './settings-registry.ts';
import type { DeviceIdleShutdownRecord, IdleStopRecord, MetroLastStop } from './workspace-state.ts';
export type StatsPlatform = 'ios' | 'android';

export type RunOutcomeKind = 'hit' | 'cold';

export const BUILD_PHASES = [
  'prepare',
  'cache-lookup',
  'wait',
  'prebuild',
  'pods',
  'compile',
  'device',
  'install',
  'launch',
] as const;

export type BuildPhase = (typeof BUILD_PHASES)[number];

export type ActiveBuildState = 'running' | 'stale' | 'unknown';

/**
 * Where a running build compiles: `local`, or the build machine it was offloaded to, with the phase it is in there
 * (`sync`, `deps`, `prebuild`, `pods`, `build` or `fetch`) and when the offload and that phase started.
 */
export type BuildPlacement = 'local' | { host: string; phase: string; startedAt: string; phaseStartedAt: string };

export interface BuildReport {
  platform: StatsPlatform;
  slot: string;
  state: ActiveBuildState;
  phase: BuildPhase;
  startedAt: string;
  phaseStartedAt: string;
  outcome: RunOutcomeKind | null;
  /** Whether `outcome` is this run's own; before its cache lookup resolves it is the project's latest outcome. */
  outcomeKnown: boolean;
  /** The resolved lookup result; absent before resolution and when the run skips cache lookup. */
  cacheLookupOutcome?: 'hit' | 'miss';
  expectedMs: number | null;
  expectedPhaseMs: number | null;
  basis: number;
  /**
   * The phases a run like this one goes through, in order, with each one's median in milliseconds, from the same
   * runs as `expectedMs`; null without comparable runs. The current phase can be one the plan does not list.
   */
  plannedPhases: PlannedPhase[] | null;
  /** Why the run's cache lookup missed, once the run knows; `baseline` omits `cacheKey`. */
  missReason?: BuildMissReason;
  /**
   * True while `missReason` is the miss of the key the run looked up first and the run will prebuild or install pods,
   * then look the key up again. A hit on the second lookup removes `missReason` and sets `outcome` to `hit`.
   */
  missProvisional?: true;
  /** What the native build tool is doing now, once it printed a line Stim recognizes. */
  detail?: BuildDetail;
  placement: BuildPlacement;
  /** While `phase` is `wait`: the workspace whose build of the same artifact this run waits on, when it is known. */
  waitingOn?: { path: string };
}

/** One phase a running build is expected to go through, and its median duration in comparable runs. */
export interface PlannedPhase {
  phase: BuildPhase;
  expectedMs: number;
}

/** The native build tool's step inside a build's `compile` phase. */
export const NATIVE_BUILD_STEPS = [
  'configure',
  'compile',
  'link',
  'resources',
  'script',
  'dex',
  'package',
  'sign',
] as const;

export type NativeBuildStep = (typeof NATIVE_BUILD_STEPS)[number];

/**
 * A running build's progress as its tool reports it. `unit` is `targets` for xcodebuild and `tasks` for Gradle.
 * xcodebuild's `done` counts targets it finished and `total` the targets in its dependency graph, which includes
 * targets with nothing to do; Gradle's `done` counts the tasks it reported, with a null `total`. They are counts, not
 * a completion fraction. `status` reports the detail only during the `compile` phase. `line` is
 * the latest compile, link or task line with paths shortened to file names.
 */
export interface BuildDetail {
  step: NativeBuildStep | null;
  unit: 'targets' | 'tasks' | null;
  done: number | null;
  total: number | null;
  line: string | null;
  updatedAt: string;
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
  /** The selected auto, local, or configured machine entry; present on new build records, including cache hits. */
  buildMachine?: string;
  /** Where compilation ran: here or a machine name; absent when no build ran. */
  builtOn?: string;
  /** The build machine that compiled the app when the build was offloaded. */
  offloadedTo?: string;
  /** Why the run built here after it considered offloading; absent when it offloaded or never considered it. */
  offloadFallback?: string;
  /** The first compiler diagnostics of a failed build, when the build tool reported any. */
  diagnostics?: BuildDiagnostic[];
  /** Present on a failed run: what failed, from `buildCause`. */
  cause?: BuildCause;
}

/**
 * A failed run's cause: the first diagnostic with a file and a line, keyed `file:line`, else the run's error code
 * (or `failed`), with null `file` and `line`. Consecutive failures with the same `key` failed the same way.
 */
export interface BuildCause {
  key: string;
  file: string | null;
  line: number | null;
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

/** The kinds of evidence that date a device's last activity, in the order `recent` lists them. */
export const ACTIVITY_RECENCY_BASES = [
  'agent-action',
  'device-log',
  'metro-bundle',
  'workspace-use',
  'supervisor-start',
  'page-log',
  'viewer',
] as const;

export type ActivityRecencyBasis = (typeof ACTIVITY_RECENCY_BASES)[number];

export interface DeviceActivity {
  state: ActivityState;
  driver?: ActivityDriver;
  lastActivityAt?: string;
  /** The newest time of each kind of evidence behind `lastActivityAt`, so a reader can leave out app log chatter. */
  recent?: Partial<Record<ActivityRecencyBasis, string>>;
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

/**
 * The GitHub pull request of a worktree's branch and HEAD, as `status --watch` last looked it up through `gh`.
 * `state` is `draft` for an open draft. `checks` counts the head commit's check runs and commit statuses, null when it
 * has none. `checkedAt` is when Stim last asked GitHub.
 */
export interface WorktreePullRequest {
  number: number;
  url: string;
  title: string;
  state: 'open' | 'draft' | 'merged' | 'closed';
  checks: { passing: number; failing: number; pending: number } | null;
  reviewDecision: 'approved' | 'changes-requested' | 'review-required' | null;
  checkedAt: string;
}

export interface WorktreeFacts {
  path: string;
  branch?: string;
  repository?: string;
  /** Null when git could not be read in time, or the worktree is in a folder status does not open. */
  git?: WorktreeGit | null;
  /** Null when GitHub has no pull request for the branch; absent when unknown, such as without `gh`. */
  pullRequest?: WorktreePullRequest | null;
  /** Present with `git`: what the worktree's git chip shows, from `gitChip`. */
  gitChip?: GitChip;
}

/** Every coding-agent tool whose sessions status can attribute to an environment. */
export const AGENT_TOOLS = ['claude-code', 'codex'] as const;

export type AgentTool = (typeof AGENT_TOOLS)[number];

/**
 * A coding-agent session working in an environment: one whose working directory `cwd` is the environment's path,
 * inside it, or its git worktree root, or one that ran a Stim command in it. `title` is the short name the tool keeps
 * for the session, never its conversation. `lastActiveAt` is the tool's own last update, or the Stim command's time
 * when that is newer. `openUrl` opens the session in the tool's desktop app when that app is installed on this Mac.
 * `webUrl` opens a Claude Code session with Remote Control connected on claude.ai/code or in the Claude mobile app.
 */
export interface AgentSession {
  tool: AgentTool;
  sessionId: string;
  title?: string;
  cwd: string;
  startedAt?: string;
  lastActiveAt?: string;
  pid?: number;
  openUrl?: string;
  webUrl?: string;
}

/**
 * An agent session that stopped running in an environment, with the details Stim last found while it ran. `endedAt`
 * is the last time a status watcher found it running.
 */
export interface EndedAgentSession extends Omit<AgentSession, 'pid'> {
  endedAt: string;
}

export interface AndroidRuntimeFacts {
  serial: string | null;
  state: 'detected' | 'not-detected' | 'missing' | 'unknown';
  error?: string;
}

/** Every connection state a physical device can report. */
export const PHYSICAL_DEVICE_CONNECTIONS = ['connected', 'disconnected', 'unknown'] as const;

export type PhysicalDeviceConnection = (typeof PHYSICAL_DEVICE_CONNECTIONS)[number];

/**
 * A physical iPhone, iPad or Android phone the workspace holds an unexpired lease on, from `ios --device`,
 * `android --device` or `device lock`. Stim uses it and never owns it, so `owned` is always false. `id` is the
 * UDID or adb serial. `name` is the device's own name, falling back to the name the lease recorded; `model` is the
 * marketing name devicectl reports, null when it could not be read, or the Android model the lease recorded.
 * `connection` is `connected` when devicectl can reach the phone or adb lists it as `device`, `disconnected` when
 * the tool answered without it, and `unknown` when the tool could not be read in time. `lease.holder` is the
 * workspace path that holds it.
 */
export interface PhysicalDeviceState {
  platform: StatsPlatform;
  slot: string;
  id: string;
  name: string | null;
  model: string | null;
  owned: false;
  physical: true;
  connection: PhysicalDeviceConnection;
  lease: { holder: string; kind: 'declared' | 'run'; grantedAt: string | null; expiresAt: string };
}

export interface RemoteDeviceState {
  platform: 'ios' | 'android' | null;
  backend: 'eas';
  sessionId: string;
  state: 'claimed' | 'unclaimed' | 'unknown';
  startedAt: string | null;
  webPreviewUrl: string | null;
}

/**
 * One part of a worktree's git chip, in display order: commits ahead of and behind the upstream, uncommitted files
 * (changed plus untracked), the base branch the branch is merged into (left out when its pull request is merged,
 * whose own mark says so), and a branch with no upstream that is not merged.
 */
export type GitChipPart =
  | { kind: 'arrows'; ahead: number; behind: number }
  | { kind: 'changed'; count: number }
  | { kind: 'merged'; into: string }
  | { kind: 'no-upstream' };

/** A pull request's checks at a glance: any failing, else any pending, else any passing; null without checks. */
export type ChecksState = 'passing' | 'failing' | 'pending' | null;

export interface GitChip {
  parts: GitChipPart[];
  ci: ChecksState;
}

/**
 * Whether a running owned simulator or emulator lacks the workspace's app: `none` when its platform never built
 * successfully here and the latest build failed, `closed` when status saw no app process, else null.
 */
export type AppPresence = 'none' | 'closed' | null;

export const WORKSPACE_STAGE_KINDS = ['building', 'warming', 'ready', 'build-failed', 'running', 'stopped'] as const;

/**
 * Where a workspace is, first match wins: `building` while a build runs, `warming` and `ready` from `phase` when
 * nothing is live, `build-failed` when the newest run of either platform failed, `running` when it is live or holds
 * a remote device, else `stopped`. `since` is when that began: the build's start, the warm phase's time, the failed
 * run's end (else start), the supervisor's start, or Metro's last stop. `platform` names the build for `building`
 * and `build-failed`. `closedApps` lists, for `running`, the devices whose `appPresence` is `closed`.
 */
export interface WorkspaceStage {
  kind: (typeof WORKSPACE_STAGE_KINDS)[number];
  since: string | null;
  platform: StatsPlatform | 'macos' | null;
  closedApps: { platform: StatsPlatform; slot: string }[];
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
  'android-reverse-missing',
  'supervisor-unverified',
  'browser-unverified',
  'browser-orphaned',
] as const;

export type StatusIssueCode = (typeof STATUS_ISSUE_CODES)[number];

/**
 * One thing in a workspace that needs the user, or with severity `info` a note that needs nothing. `remedy` is a
 * command to run from `workspace`; `slot` is absent for the default device slot. `warnings` carries the `error` and
 * `warning` issues as text.
 *
 * Severity:
 * - `error`: Stim cannot verify or safely act on something; a person resolves it, following the teardown guide.
 * - `warning`: something is broken now and needs someone to act, such as an app that cannot reach Metro, a held
 *   port or a device that vanished while expected.
 * - `info`: a fact the next normal Stim command handles by itself, so it needs no action.
 *
 * The phone app and Stim Desktop show `error` and `warning` and hide `info`; plain `stim status` prints `info` as a
 * dim note with no remedy.
 */
export interface StatusIssue {
  code: StatusIssueCode;
  severity: 'error' | 'warning' | 'info';
  message: string;
  remedy: string;
  workspace: string;
  slot?: string;
}

/** Every state the owned page's latest load can report. */
export const WEB_PAGE_STATES = ['loading', 'loaded', 'failed'] as const;

/**
 * The owned page's latest load, from the page-load marker in the workspace's web log: `url` is the document it
 * loaded, `state` is `failed` when that document did not load or the page crashed, with the log message as
 * `error`. `route`, present only when an in-app route change (history API or fragment) moved the page off `url`
 * since the load, is the URL it shows now.
 */
export interface WebPageState {
  url: string;
  state: (typeof WEB_PAGE_STATES)[number];
  error?: string;
  route?: string;
}

/**
 * The workspace's Stim-owned Chrome. `pid` is Chrome's process and `supervisorPid` the Stim process that holds
 * its DevTools session. `cdpEndpoint` is the loopback DevTools HTTP endpoint agents can attach to, and `targetId`
 * the DevTools target of the owned page; both are null when the browser is not running. `profile` is the
 * Stim-owned user data directory. `page` is null before the page's first load. `activity` names DevTools clients
 * other than Stim's as drivers.
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
  targetId: string | null;
  page?: WebPageState | null;
  activity?: DeviceActivity;
}

/** The steps of `stim worktree warm`: `refresh` fast-forwards and installs in the source checkout, `copy` carries ignored entries. */
export type WarmStep = 'refresh' | 'copy';

/**
 * Where a workspace is in its lifecycle: `warming` while `stim worktree warm` runs in it, `ready` after a warm
 * succeeded and before any `start`, `ios`, `android`, `web` or `reload` there, for at most two hours; `live` when
 * anything it owns runs, else `idle`.
 */
export const WORKSPACE_PHASES = ['warming', 'ready', 'live', 'idle'] as const;

export type WorkspacePhase = (typeof WORKSPACE_PHASES)[number];

/** A folder's size on disk as `status --watch` last measured it. */
export interface DiskMeasure {
  bytes: number;
  measuredAt: string;
}

/**
 * An environment's disk use as `status --watch` last measured it. `worktreeBytes` is the git worktree folder, or the
 * workspace folder outside one, node_modules included. `nodeModulesBytes` is node_modules at the worktree root and,
 * when different, at the workspace path, and is part of `worktreeBytes`. `buildBytes` is Stim's own folder for the
 * workspace: Xcode derived data, Gradle outputs and logs. A figure is null until it was measured; `measuredAt` is the
 * oldest measurement.
 */
export interface EnvironmentDisk {
  worktreeBytes: number | null;
  nodeModulesBytes: number | null;
  buildBytes: number | null;
  measuredAt: string;
}

/**
 * A Metro bundle request: `bundling` while one is in flight on the workspace's Metro, with its `platform`,
 * `startedAt` and, when Metro reported progress for it, `percent` (0-100). `last` is the newest finished request,
 * `durationMs` from request to response end.
 */
export interface MetroBundleState {
  bundling: boolean;
  platform?: StatsPlatform;
  startedAt?: string;
  percent?: number;
  last?: { platform: StatsPlatform; status: 'ok' | 'failed'; durationMs: number; finishedAt: string };
}

export interface SimulatorState {
  host?: HostedIosStatus;
  name: string | null;
  udid: string;
  owned: boolean;
  state: string;
  activity?: DeviceActivity;
  app?: DeviceAppProcess;
  appPresence?: AppPresence;
  /** The simulator's data folder, for an owned simulator once measured. */
  disk?: DiskMeasure;
  /** Present while the device is not booted after the supervisor shut it down for `devices.idleShutdownMinutes`. */
  idleShutdown?: DeviceIdleShutdownRecord;
}

export interface AndroidDeviceState {
  name: string | undefined;
  owned: boolean;
  physical: boolean;
  serial?: string | null;
  state?: AndroidRuntimeFacts['state'];
  deviceProfile?: string | null;
  activity?: DeviceActivity;
  app?: DeviceAppProcess;
  appPresence?: AppPresence;
  /** The AVD's folder, for an owned emulator once measured. */
  disk?: DiskMeasure;
  /** Present while the emulator is not running after the supervisor shut it down for `devices.idleShutdownMinutes`. */
  idleShutdown?: DeviceIdleShutdownRecord;
}

export interface EnvironmentState {
  slots?: { slot: string; ios: SimulatorState | null | undefined; android: AndroidDeviceState | null | undefined }[];
  path: string;
  /** Statically detected app platforms; always set by status, empty when none are detected. */
  platforms?: string[];
  live: boolean;
  phase?: WorkspacePhase;
  /** When the warm started (`warming`) or finished (`ready`); null for `live` and `idle`. */
  phaseSince?: string | null;
  /** Whether stim-server may record this workspace's device screens, from `recording.enabled`. */
  recording?: { enabled: boolean };
  /** Where the workspace is, from `workspaceStage`; `stim status --json` always sets it. */
  stage?: WorkspaceStage;
  /** The step a `warming` workspace's warm is in; absent in every other phase. */
  warmStep?: WarmStep;
  /**
   * The memory this workspace's processes use, as `memorySource` says: the sum of its `machine` owners' `memoryMb`
   * when status read their footprints, or else a fixed estimate per booted simulator, detected emulator, running
   * Metro and running Chrome. `capacity.committedMb` sums it.
   */
  memoryMb: number;
  /** How `memoryMb` was obtained; absent from payloads written before it existed, which carry the estimate. */
  memorySource?: Exclude<MemorySource, 'rss'>;
  warnings: string[];
  issues: StatusIssue[];
  ios?: SimulatorState | null;
  android?: AndroidDeviceState | null;
  metro?: {
    port: number;
    running: boolean;
    pid: number | null;
    tunnel?: { provider: Exclude<TunnelMode, 'auto' | 'off' | 'expo'>; url: string };
    idleStop?: IdleStopRecord;
    lastStop?: MetroLastStop;
    /** The other process that answers Metro on `port`; `cwd` is null when its directory could not be read. */
    heldBy?: { pid: number; cwd: string | null };
    /** Absent when the Metro log holds no bundle request. */
    bundle?: MetroBundleState;
  } | null;
  web?: WebBrowserState | null;
  macos?: MacosAppState | null;
  supervisor?: { pid: number | null; mode: string | null; startedAt: string | null; healthy: boolean } | null;
  logs?: { dir: string; errorsSinceMarker: number } | null;
  agentDevice?: { stateDir: string };
  worktree?: WorktreeFacts | null;
  remoteDevices?: RemoteDeviceState[];
  /** The physical devices this workspace leases, in every slot; absent when it leases none. */
  physicalDevices?: PhysicalDeviceState[];
  build?: BuildReport | null;
  lastBuilds?: Partial<Record<StatsPlatform, LastBuildReport>>;
  /** Each platform's recent runs, newest first, at most `BUILD_HISTORY_LIMIT` each. */
  builds?: Partial<Record<StatsPlatform, BuildHistoryEntry[]>>;
  disk?: EnvironmentDisk;
  /** The coding-agent sessions working in the environment, most recently active first; absent when none. */
  agents?: AgentSession[];
  /** The agent sessions that stopped running here in the last 3 days, most recently ended first; absent when none. */
  endedAgents?: EndedAgentSession[];
}

/** `committedMb` sums the environments' `memoryMb`; `overCapacity` is that sum over 60% of `totalMemoryMb`. */
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

/**
 * Where a memory figure comes from. `footprint` is each process's physical footprint, which Activity Monitor's Memory
 * column shows. `rss` sums resident set sizes, which count pages shared between processes once per process, so a
 * simulator reports well above its footprint; the machine owners fall back to it when the footprint helper cannot be
 * built. `estimate` is a fixed amount per running thing, which an environment reports whenever it has no footprint.
 */
export const MEMORY_SOURCES = ['footprint', 'rss', 'estimate'] as const;

export type MemorySource = (typeof MEMORY_SOURCES)[number];

/** Every kind of process owner the status machine section reports. */
export const MACHINE_OWNER_KINDS = [
  'simulator',
  'emulator',
  'metro',
  'build',
  'browser',
  'macos',
  'server',
  'shared',
] as const;

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
 * `memoryMb` sums their physical footprints when `MachineUsageState.memorySource` is `footprint`, taking the resident
 * size of a process the footprint helper could not read, and equals `residentMb` when it is `rss`.
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
  memoryMb: number;
  processes: number;
}

/** Where this machine's CPU and memory go, from one pass over the host process table. */
export interface MachineUsageState {
  memorySource: Exclude<MemorySource, 'estimate'>;
  owners: MachineOwner[];
}

/** The payload `stim status --json` prints, and `status --watch --json` prints on each change. */
export interface StatusPayload {
  archived?: ArchivedWorkspace[];
  archivedUsage?: ArchivedUsage;
  environments: (EnvironmentState & { labelOnly?: true })[];
  capacity: StatusCapacity;
  deviceLeases: DeviceLeaseState[];
  unprovisionedWorktrees: WorktreeFacts[];
  simctlAvailable: boolean;
  /** Null when nothing runs that status attributes, so it read no process table, or when the table was unreadable. */
  machine: MachineUsageState | null;
}
