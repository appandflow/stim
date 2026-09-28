/**
 * Stim server protocol v1, copied from `@stim-cli/server` (packages/server/src/protocol.ts) because this
 * npm app cannot import the pnpm workspace packages; see "Protocol types" in the README.
 * packages/server/__tests__/mobile-protocol.test.ts fails the root typecheck when the two drift apart.
 */

export const PROTOCOL_VERSION = 1;

export type Platform = 'ios' | 'android';

/** The platforms a device can stream and take input on: `web` is the workspace's Stim-owned Chrome page. */
export type DevicePlatform = Platform | 'web';

/** `reload` also reaches the workspace's Stim-owned Chrome page. */
export type ReloadPlatform = DevicePlatform;

/** The JSON a Stim Desktop pairing QR code encodes. */
export interface PairingPayload {
  v: 1;
  name: string;
  endpoint: string;
  pairingToken: string;
}

export interface SimState {
  name: string | null;
  udid: string;
  owned: boolean;
  state: string;
  activity?: DeviceActivity;
  app?: DeviceAppProcess;
  /** The simulator's data folder, once a status watcher has measured it. */
  disk?: DeviceDisk;
}

export interface DeviceDisk {
  bytes: number;
  measuredAt: string;
}

export interface AndroidState {
  name?: string;
  owned: boolean;
  physical: boolean;
  serial?: string | null;
  state?: 'detected' | 'not-detected' | 'missing' | 'unknown';
  deviceProfile?: string | null;
  activity?: DeviceActivity;
  app?: DeviceAppProcess;
  /** The emulator's AVD folder, once a status watcher has measured it. */
  disk?: DeviceDisk;
}

export interface DeviceAppProcess {
  id: string;
  state: 'running' | 'stopped' | 'unknown';
}

export interface DeviceActivity {
  state: 'driven' | 'active' | 'idle' | 'unknown';
  driver?: { tool: string; pid: number | null; since: string | null };
  lastActivityAt?: string;
  basis: string[];
}

export type BuildPhase = 'prepare' | 'cache-lookup' | 'wait' | 'prebuild' | 'pods' | 'compile' | 'install' | 'launch';

export interface BuildReport {
  platform: Platform;
  slot: string;
  state: 'running' | 'stale' | 'unknown';
  phase: BuildPhase;
  startedAt: string;
  phaseStartedAt: string;
  outcome: 'hit' | 'cold' | null;
  expectedMs: number | null;
  expectedPhaseMs: number | null;
  basis: number;
  /** Present once the build tool printed a recognized line. */
  detail?: BuildDetail;
  /** Present once the run knows why the cache missed. */
  missReason?: BuildMissReason;
}

/**
 * The build tool's step inside `phase`. `done` and `total` count `unit`s: xcodebuild targets that started work of
 * those in its dependency graph, or Gradle tasks reported so far with a null `total`. `line` is the latest
 * compile, link or task line.
 */
export interface BuildDetail {
  step: 'configure' | 'compile' | 'link' | 'resources' | 'script' | 'dex' | 'package' | 'sign' | null;
  unit: 'targets' | 'tasks' | null;
  done: number | null;
  total: number | null;
  line: string | null;
  updatedAt: string;
}

export type BuildCacheHit = 'local' | 'remote' | false;

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

/** Why a run compiled instead of installing a cached app; `changes` holds at most 20 of `changeCount`. */
export interface BuildMissReason {
  kind: 'changed' | 'no-baseline' | 'same-sources' | 'cache-skipped' | 'fingerprint-error' | 'prebuild-pending';
  summary: string;
  changes: BuildMissChange[];
  changeCount: number;
  baseline: { fingerprint: string; from: 'workspace' | 'project' } | null;
  rekeyedBy: string[];
}

/** `stim ios|android --plan --json`: what the next build would find, without building. */
export interface BuildPlan {
  platform: Platform;
  slot?: string;
  fingerprint: string;
  cacheKey: string | null;
  cacheHit: BuildCacheHit;
  provider: string | null;
  cacheSkipped: boolean;
  prebuild: 'none' | 'generate' | 'regenerate' | 'refuse' | null;
  outcome: 'hit' | 'cold' | null;
  expectedMs: number | null;
  basis: number;
  missReason?: BuildMissReason;
  refusal?: { code: string; message: string; remedy: string };
}

export interface BuildPlanParams {
  workspace: string;
  platform: Platform;
  slot?: string;
}

export interface RemoteDeviceState {
  platform: Platform | null;
  backend: 'eas';
  sessionId: string;
  state: 'claimed' | 'unclaimed' | 'unknown';
  startedAt: string | null;
  webPreviewUrl: string | null;
}

/** A physical phone or tablet the workspace leases. Stim uses it and never owns it. */
export interface PhysicalDeviceState {
  platform: Platform;
  slot: string;
  id: string;
  name: string | null;
  model: string | null;
  owned: false;
  physical: true;
  connection: 'connected' | 'disconnected' | 'unknown';
  lease: { holder: string; kind: 'declared' | 'run'; grantedAt: string | null; expiresAt: string };
}

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
  git?: WorktreeGit | null;
  /** Null when GitHub has no pull request for the branch and HEAD; absent when unknown. */
  pullRequest?: PullRequestFacts | null;
}

/** The branch's pull request as Stim last asked GitHub; `checks` counts the head commit's checks. */
export interface PullRequestFacts {
  number: number;
  url: string;
  title: string;
  state: 'open' | 'draft' | 'merged' | 'closed';
  checks: { passing: number; failing: number; pending: number } | null;
  reviewDecision: 'approved' | 'changes-requested' | 'review-required' | null;
  checkedAt: string;
}

/**
 * One thing in a workspace that needs the user, or with severity `info` a note that needs nothing; `remedy` is a
 * command to run from `workspace`.
 */
export interface StatusIssue {
  code: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  remedy: string;
  workspace: string;
  slot?: string;
}

/**
 * The workspace's Stim-owned Chrome; `cdpEndpoint` and `targetId` are null while it is not running. `page` is the
 * document it loaded last, absent from a `stim` that does not report it.
 */
export interface WebBrowserState {
  browser: 'chrome';
  version: string | null;
  running: boolean;
  pid: number | null;
  supervisorPid: number | null;
  url: string;
  headless: boolean;
  viewport: 'desktop' | 'phone';
  profile: string;
  cdpEndpoint: string | null;
  targetId?: string | null;
  page?: { url: string; state: 'loading' | 'loaded' | 'failed'; error?: string; route?: string } | null;
  activity?: DeviceActivity;
}

export interface EnvironmentState {
  path: string;
  labelOnly?: boolean;
  slots?: { slot: string; ios?: SimState | null; android?: AndroidState | null }[];
  live: boolean;
  /** Absent from a `stim` that does not report lifecycle phases. */
  phase?: 'warming' | 'ready' | 'live' | 'idle';
  /** When the warm started (`warming`) or finished (`ready`); null for `live` and `idle`. */
  phaseSince?: string | null;
  /** The step a `warming` workspace's warm is in. */
  warmStep?: 'refresh' | 'copy';
  /** Whether stim-server may record this workspace's screens for replay; absent from an older `stim`. */
  recording?: { enabled: boolean };
  memoryMb: number;
  /** How `memoryMb` was obtained; absent from a `stim` whose `memoryMb` is always the estimate. */
  memorySource?: 'footprint' | 'rss' | 'estimate';
  warnings: string[];
  /** Absent from a `stim` that reports only `warnings`. */
  issues?: StatusIssue[];
  ios?: SimState | null;
  android?: AndroidState | null;
  metro?: {
    port: number;
    running: boolean;
    pid: number | null;
    lastStop?: { reason: string; at?: string };
    /** Absent when the Metro log has no bundle request, and from a `stim` that does not report bundles. */
    bundle?: MetroBundle;
  } | null;
  web?: WebBrowserState | null;
  supervisor?: { pid: number | null; mode: string | null; startedAt: string | null; healthy: boolean } | null;
  logs?: { dir: string; errorsSinceMarker: number } | null;
  worktree?: WorktreeFacts | null;
  remoteDevices?: RemoteDeviceState[];
  /** Absent from a `stim` that does not report physical devices, and when the workspace leases none. */
  physicalDevices?: PhysicalDeviceState[];
  build?: BuildReport | null;
  lastBuilds?: { ios?: LastBuild; android?: LastBuild };
  /** Each platform's recent runs, newest first, at most 10 each. Absent from a `stim` without build history. */
  builds?: { ios?: BuildHistoryEntry[]; android?: BuildHistoryEntry[] };
  /** Disk use as a status watcher last measured it; absent until one has. */
  disk?: WorkspaceDisk;
  /** The coding-agent sessions working here, most recently active first; absent when none or from an older `stim`. */
  agents?: AgentSession[];
}

/**
 * A Claude Code or Codex session working in a workspace. `title` is the short name the tool keeps for the session.
 * `openUrl` opens it in the Mac's desktop app, so the phone does not use it.
 */
export interface AgentSession {
  tool: 'claude-code' | 'codex';
  sessionId: string;
  title?: string;
  cwd: string;
  startedAt?: string;
  lastActiveAt?: string;
  pid?: number;
  openUrl?: string;
}

/**
 * `percent` (0 to 100) is present only when Metro reported progress for the in-flight bundle. `last` is the newest
 * finished bundle request.
 */
export interface MetroBundle {
  bundling: boolean;
  platform?: Platform;
  startedAt?: string;
  percent?: number;
  last?: { platform: Platform; status: 'ok' | 'failed'; durationMs: number; finishedAt: string };
}

/**
 * `worktreeBytes` is the git worktree folder, node_modules included; `nodeModulesBytes` is part of it. `buildBytes`
 * is Stim's own folder for the workspace: derived data, Gradle outputs and logs.
 */
export interface WorkspaceDisk {
  worktreeBytes: number | null;
  nodeModulesBytes: number | null;
  buildBytes: number | null;
  measuredAt: string;
}

/**
 * CPU and memory series stim-server records from each status's machine owners, oldest first, point `i` at
 * `endAt - (n - 1 - i) * intervalMs`, null where no reading fell in a slot. A device `id` is the machine owner id:
 * the simulator's UDID or the AVD name.
 */
export interface StatusUsage {
  intervalMs: number;
  endAt: number;
  environments: { workspace: string; cpuPercent: (number | null)[]; memoryMb: (number | null)[] }[];
  devices: {
    kind: 'simulator' | 'emulator';
    id: string;
    workspace: string | null;
    slot?: string;
    cpuPercent: (number | null)[];
    memoryMb: (number | null)[];
  }[];
}

export type BuildResult = 'succeeded' | 'failed' | 'cancelled' | 'interrupted';

/**
 * One run in a workspace's build history. `configuration` is the iOS configuration or Android variant, null
 * when the run ended before resolving it. An interrupted run has null `durationMs` and `finishedAt`.
 */
export interface BuildHistoryEntry extends LastBuild {
  result: BuildResult;
  slot: string;
  configuration: string | null;
  cacheKey: string | null;
  phases: Partial<Record<BuildPhase, number>>;
}

/** A platform's most recent `ios` or `android` run in one workspace. */
export interface LastBuild {
  platform: Platform;
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

export interface BuildDiagnostic {
  file: string | null;
  line: number | null;
  column: number | null;
  message: string;
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

/** One `stim status --json` payload. */
export interface StatusPayload {
  environments: EnvironmentState[];
  capacity: { liveCount: number; committedMb: number; totalMemoryMb: number; overCapacity: boolean };
  deviceLeases: DeviceLeaseState[];
  unprovisionedWorktrees?: WorktreeFacts[];
  simctlAvailable: boolean;
  /** Null when nothing runs that status attributes; absent from a `stim` that predates it. */
  machine?: MachineUsageState | null;
}

export type MachineOwnerKind = 'simulator' | 'emulator' | 'metro' | 'build' | 'browser' | 'server' | 'shared';

/**
 * One thing using the Mac's CPU and memory, each process counted in exactly one owner. `slot` is absent for the
 * default slot. `id` is the simulator's UDID, the emulator's AVD name, Metro's port, the build's platform, or null.
 * `cpuPercent` is `ps` %CPU summed over its processes, where 100 is one core.
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

export interface MachineUsageState {
  memorySource: 'footprint' | 'rss';
  owners: MachineOwner[];
}

export type LogSource = 'metro' | 'client' | 'device' | 'build' | 'agent';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface StackFrame {
  file?: string;
  line?: number;
  column?: number;
  fn?: string;
}

/** One `stim logs --json` record. */
export interface LogRecord {
  ts: number;
  src: LogSource;
  level: LogLevel;
  msg: string;
  slot?: string;
  event?: string;
  stack?: StackFrame[];
  deviceId?: string;
  /** With `errors`: the code frame and stack lines Expo printed after this error. */
  context?: string[];
  [key: string]: unknown;
}

export interface LogFilter {
  workspace: string;
  sources?: LogSource[];
  level?: LogLevel;
  slot?: string;
  grep?: string;
  errors?: boolean;
  tail?: number;
}

export interface FrameTarget {
  workspace: string;
  platform: DevicePlatform;
  slot?: string;
  /** The physical device the workspace leases in `slot`, instead of its simulator or emulator. */
  physical?: boolean;
  /** Frames a second, 1 to 30; the server's default is 5. */
  fps?: number;
  /** Pixels on the longer edge, 240 to 2048; the server's default is 1280. */
  maxEdge?: number;
  /** The codecs the app decodes; a result with `video` sends binary H.264 messages instead of `frame` events. */
  video?: 'h264'[];
  /** Starts replaying the footage recorded at this time, epoch ms on the Mac; needs `video`. */
  at?: number;
  rate?: ReplayRate;
}

/** 0 pauses on the frame, 1 plays in real time, 2 twice as fast. */
export type ReplayRate = 0 | 1 | 2;

export interface ReplaySpan {
  start: number;
  end: number;
}

export interface ReplayMarker {
  at: number;
  kind: 'action' | 'error' | 'crash';
  command?: string;
  label: string;
}

export interface ReplayRange {
  enabled: boolean;
  recording: boolean;
  spans: ReplaySpan[];
  markers: ReplayMarker[];
}

/** A replaying subscription reached the newest recorded frame and stays paused there. */
export interface ReplayEndedEvent {
  event: 'replay-ended';
  subscription: string;
  at: number;
}

/** Needs `control`. The server refuses with `device-busy` while something else drives the device. */
export interface ControlBeginParams {
  workspace: string;
  platform: DevicePlatform;
  slot?: string;
  takeOver?: boolean;
  /** Controls the physical device the workspace leases in `slot`, while that lease lasts. */
  physical?: boolean;
}

/** `postures` lists what `input.posture` takes: none for a device without a hinge. */
export interface ControlBeginResult {
  session: string;
  platform: DevicePlatform;
  lease: { grantedAt: string | null; expiresAt: string } | null;
  postures: DevicePosture[];
}

export type TouchPhase = 'down' | 'move' | 'up';

export type InputButton = 'home' | 'lock' | 'back' | 'app-switch';

export type RotateDirection = 'left' | 'right';

export type DevicePosture = 'folded' | 'half-open' | 'unfolded';

export type ActionName = 'reload' | 'stop';

/** Runs one fixed `stim` command in the workspace; the server refuses it unless the device has `control`. */
export type ActionParams =
  | { action: 'reload'; workspace: string; platform?: ReloadPlatform }
  | { action: 'stop'; workspace: string };

export interface ActionResult {
  action: ActionName;
  workspace: string;
  /** The JSON the command printed. */
  output: Record<string, unknown>;
}

export type MemoryPressure = 'normal' | 'warning' | 'critical';

export interface MachineVolume {
  mount: string;
  holds: string[];
  freeBytes: number;
  totalBytes: number;
}

export interface MachineUsage {
  volumes: MachineVolume[];
  memory: { totalBytes: number; usedBytes: number | null; pressure: MemoryPressure | null };
  load: { avg1: number; avg5: number; avg15: number; cpus: number };
  /** Absent from a server older than the `cpu` field (#1253). */
  cpu?: { usage: number | null; cores: number };
  sampledAt: string;
}

/** `memoryPressure` is 0 (normal), 1 (warning) or 2 (critical); `diskFreeBytes` is the startup volume's. */
export interface UsageSample {
  at: number;
  cpu: number | null;
  memoryUsedBytes: number | null;
  memoryPressure: number | null;
  diskFreeBytes: number | null;
}

export interface MachineHistory {
  intervalMs: number;
  samples: UsageSample[];
}

export type ClientAuth = { deviceToken: string } | { pairingToken: string; deviceName: string };

/** What stim-server can push, the categories of `@/lib/oversight`. */
export type PushEvent = 'started' | 'stuck' | 'looping' | 'finished' | 'machine' | 'control';

/** How a pushed event is delivered: `alert` with a banner and sound, `silent` to the notification list only. */
export type NotificationLevel = 'alert' | 'silent';

/**
 * `ref` comes back as `data.ref` in every push, naming the Mac that sent it. `quietHours` are minutes after midnight
 * in the phone's IANA `timeZone`. Only a server whose hello lists the `notification-levels` feature takes `levels`.
 */
export interface PushRegisterParams {
  token: string;
  events: PushEvent[];
  levels?: Partial<Record<PushEvent, NotificationLevel>>;
  ref: string;
  stuckMinutes?: number;
  quietHours?: { start: number; end: number; timeZone: string };
}

/** Why the registered phones did not get a logged notification when it happened. */
export type NotificationSuppression = 'muted' | 'quiet-hours';

/** What a logged notification opens, as its push's `data` does. */
export type NotificationTarget =
  | { kind: 'machine' }
  | { kind: 'workspace'; path: string }
  | { kind: 'device'; path: string; platform: DevicePlatform; slot: string }
  | { kind: 'build'; path: string; platform: Platform }
  | { kind: 'url'; path: string; url: string };

/**
 * One oversight notification a Mac generated, pushed or not. `seq` grows by one per entry in a log; `id` names the
 * workspace or machine and category, so a later episode shares it.
 */
export interface NotificationEntry {
  seq: number;
  at: string;
  id: string;
  category: PushEvent;
  title: string;
  body: string;
  quiet: boolean;
  target: NotificationTarget;
  suppressed?: NotificationSuppression;
}

/** `log` changes when the Mac's history starts over; `cursor` is the newest `seq`. */
export interface NotificationsListResult {
  log: string;
  cursor: number;
  notifications: NotificationEntry[];
}

export interface Methods {
  hello: {
    params: { protocol: number; client: { name: string; version: string }; auth: ClientAuth };
    result: {
      protocol: number;
      /** `home` is absent from servers older than the `machine.get` method. */
      server: { name: string; version: string; stim: string; home?: string };
      capabilities: string[];
      /** What the server serves beyond the base protocol; absent from servers that predate it. */
      features?: string[];
      /** The actions this device may run; absent from servers that predate actions. */
      actions?: ActionName[];
      /** The paired device this connection authenticated as; absent from servers that predate it. */
      device?: { id: string; name: string };
      /** Returned once, when `auth` spent a pairing token. */
      deviceToken?: string;
    };
  };
  'status.subscribe': { params: Record<string, never>; result: { subscription: string } };
  'logs.query': { params: LogFilter; result: { records: LogRecord[] } };
  'logs.subscribe': { params: LogFilter; result: { subscription: string } };
  'stats.get': { params: { workspace?: string }; result: Record<string, unknown> };
  'settings.get': { params: { workspace?: string }; result: Record<string, unknown> };
  'frames.subscribe': { params: FrameTarget; result: { subscription: string; video?: 'h264' } };
  'frames.keyframe': { params: { subscription: string }; result: Record<string, never> };
  'frames.seek': { params: { subscription: string; at: number; rate: ReplayRate }; result: { at: number } };
  'frames.live': { params: { subscription: string }; result: Record<string, never> };
  'replay.range': { params: { workspace: string; platform: DevicePlatform; slot?: string }; result: ReplayRange };
  'recording.set': { params: { enabled: boolean }; result: { enabled: boolean; recordingsDeleted: string[] } };
  'build.plan': { params: BuildPlanParams; result: BuildPlan };
  'machine.get': { params: Record<string, never>; result: MachineUsage };
  'machine.history': { params: { sinceMs?: number }; result: MachineHistory };
  unsubscribe: { params: { subscription: string }; result: Record<string, never> };
  action: { params: ActionParams; result: ActionResult };
  'control.begin': { params: ControlBeginParams; result: ControlBeginResult };
  'control.end': { params: { session: string }; result: Record<string, never> };
  /** `x` and `y` are fractions of the upright screen, origin top-left. */
  'input.touch': {
    params: { session: string; phase: TouchPhase; x: number; y: number; display?: number };
    result: Record<string, never>;
  };
  /** Printable ASCII; `\n` presses Return, `\t` Tab and `\b` Delete. */
  'input.text': { params: { session: string; text: string }; result: Record<string, never> };
  'input.button': { params: { session: string; button: InputButton }; result: Record<string, never> };
  'input.rotate': { params: { session: string; direction: RotateDirection }; result: Record<string, never> };
  'input.posture': { params: { session: string; posture: DevicePosture }; result: Record<string, never> };
  'push.register': { params: PushRegisterParams; result: Record<string, never> };
  'push.unregister': { params?: Record<string, never>; result: Record<string, never> };
  'notifications.list': { params: { since?: number }; result: NotificationsListResult };
}

export type Method = keyof Methods;

export interface Request<M extends Method = Method> {
  id: number;
  method: M;
  params: Methods[M]['params'];
}

export interface ProtocolError {
  code: string;
  message: string;
}

export type Response<M extends Method = Method> =
  | { id: number; result: Methods[M]['result'] }
  | { id: number; error: ProtocolError };

export interface StatusEvent {
  event: 'status';
  subscription: string;
  payload: StatusPayload;
  /** Absent from a server that does not record usage history. */
  usage?: StatusUsage;
}

export interface LogsEvent {
  event: 'logs';
  subscription: string;
  records: LogRecord[];
}

export interface FrameEvent {
  event: 'frame';
  subscription: string;
  platform: DevicePlatform;
  slot: string;
  mime: 'image/jpeg' | 'image/png';
  width: number;
  height: number;
  capturedAt: string;
  /** Base64-encoded image bytes. */
  data: string;
  /**
   * An iPhone Duo's or Android foldable emulator's posture. A Duo reports the panel it lit: the cover when
   * folded, the inner panel when unfolded. An emulator with a hinge reports `folded` while it shows only its
   * outer display, and `unfolded` otherwise, including half open.
   */
  posture?: 'folded' | 'unfolded';
}

/**
 * Captures for a `frames.subscribe` subscription are slow or a timed-out capture is being retried; the
 * app keeps showing its last frame. Followed by `delayed: false` once captures recover.
 */
export interface FrameDelayedEvent {
  event: 'frame-delayed';
  subscription: string;
  delayed: boolean;
  /** Why frames stopped, such as a locked iPhone, when the server knows. */
  reason?: string;
}

export interface ErrorEvent {
  event: 'error';
  subscription?: string;
  error: ProtocolError;
}

/** The server ended a control session the app began. */
export interface ControlEndedEvent {
  event: 'control-ended';
  session: string;
  reason: 'idle' | 'taken-over' | 'device-gone' | 'forbidden' | 'failed';
  message: string;
}

/** A notification the Mac just logged, sent once the app has listed notifications on this connection. */
export interface NotificationEvent {
  event: 'notification';
  log: string;
  notification: NotificationEntry;
}

export type ServerEvent =
  | NotificationEvent
  | StatusEvent
  | LogsEvent
  | FrameEvent
  | FrameDelayedEvent
  | ReplayEndedEvent
  | ErrorEvent
  | ControlEndedEvent;

export type ServerMessage = Response | ServerEvent;
