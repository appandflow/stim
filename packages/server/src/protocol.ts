import type {
  BuildPlanPayload,
  HostedDeviceRequest,
  HostedDeviceSession,
  HostedAppOffer,
  HostedAppDelivery,
  NdjsonRecord,
  StatusPayload,
} from '@stim-cli/core/state';

export const PROTOCOL_VERSION = 1;

export const PROTOCOL_SCHEMA_FILE = 'protocol.schema.json';

/**
 * `read` serves state. `control` also runs {@link ACTIONS}; only the Mac grants it. `build` lets another Mac run
 * project code here to build for it; it never comes with `read` or `control`, and only the Mac approves it.
 * `device-host` permits a client's native app code in its own hosted sessions, and grants no other capability.
 */
export const CAPABILITIES = ['read', 'control', 'build', 'device-host'] as const;

export type Capability = (typeof CAPABILITIES)[number];

/**
 * What this server serves beyond protocol version 1's base, so a client can tell before it asks. `physical-ios` and
 * `physical-android` are `physical: true` on `frames.subscribe` for that platform's leased device, and for an
 * Android phone also on `control.begin`. An older server ignores `physical` on `frames.subscribe` and would stream
 * the slot's Stim-owned device instead. `notifications` is `notifications.list` and the `notification` event.
 */
export const FEATURES = ['physical-ios', 'physical-android', 'notifications'] as const;

export type Feature = (typeof FEATURES)[number];

export const METHODS = [
  'hello',
  'status.subscribe',
  'logs.query',
  'logs.subscribe',
  'stats.get',
  'settings.get',
  'frames.subscribe',
  'frames.keyframe',
  'frames.seek',
  'frames.live',
  'replay.range',
  'replay.keyframe',
  'recording.set',
  'build.plan',
  'machine.get',
  'machine.history',
  'machine.details',
  'unsubscribe',
  'action',
  'control.begin',
  'control.end',
  'input.touch',
  'input.text',
  'input.button',
  'input.rotate',
  'input.posture',
  'push.register',
  'push.unregister',
  'notifications.list',
  'build.offer',
  'build.sync',
  'build.start',
  'build.cancel',
  'build.artifact',
  'build.attach',
  'device-host.reserve',
  'device-host.attach',
  'device-host.stop',
  'device-host.app.offer',
  'device-host.app.chunk',
  'device-host.app.launch',
  'device-host.app.attach',
] as const;

/** The methods a connection with the `build` capability may call; they need `build`, not `read`. */
export const BUILD_METHODS = [
  'build.offer',
  'build.sync',
  'build.start',
  'build.cancel',
  'build.artifact',
  'build.attach',
] as const;

/** Methods restricted to explicitly approved device-host clients and their own sessions. */
export const DEVICE_HOST_METHODS = [
  'device-host.reserve',
  'device-host.attach',
  'device-host.stop',
  'device-host.app.offer',
  'device-host.app.chunk',
  'device-host.app.launch',
  'device-host.app.attach',
] as const;

export type Method = (typeof METHODS)[number];

export const PUSH_TOKEN_PATTERN = '^(Expo|Exponent)PushToken\\[[^\\]\\s]{1,256}\\]$';

/**
 * `unauthorized`, `pairing-expired` and `protocol-unsupported` refuse the client until it pairs again or
 * updates; `approval-pending` refuses a build client until the Mac approves it; clients retry the others.
 */
export const ERROR_CODES = [
  'unauthorized',
  'pairing-expired',
  'protocol-unsupported',
  'approval-pending',
  'identity-unavailable',
  'bad-request',
  'unknown-method',
  'already-authenticated',
  'unknown-subscription',
  'unknown-workspace',
  'limit-exceeded',
  'slow-client',
  'status-failed',
  'logs-failed',
  'stim-failed',
  'frames-failed',
  'forbidden',
  'unknown-action',
  'action-busy',
  'action-failed',
  'device-busy',
  'unknown-session',
  'no-recording',
  'build-refused',
  'build-busy',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export type RequestId = number | string;

/** Spends a single-use pairing token; the result carries the new device token. */
export interface PairingAuth {
  pairingToken: string;
  deviceName: string;
}

/** Presents the device token a previous pairing returned. */
export interface DeviceAuth {
  deviceToken: string;
}

/**
 * Asks, from another Mac on the tailnet, to build here. The result carries a device token with no
 * capabilities and `approval`; the token authenticates once the Mac approves the request.
 */
export interface BuildRequestAuth {
  request: 'build';
  deviceName: string;
}

/** Requests explicit device hosting approval; grants no read, control or build access. */
export interface DeviceHostRequestAuth {
  request: 'device-host';
  deviceName: string;
}

export interface HelloParams {
  protocol: number;
  client: { name: string; version: string };
  auth: PairingAuth | DeviceAuth | BuildRequestAuth | DeviceHostRequestAuth;
}

export interface HelloResult {
  protocol: number;
  /**
   * The Mac's name, this package's version, the version of the `stim` it runs, and the home directory of the
   * user it runs as, so clients can show paths under it as `~/...`.
   */
  server: { name: string; version: string; stim: string; home: string };
  capabilities: Capability[];
  features: Feature[];
  /** The actions this device may run: every one of {@link ACTIONS} with `control`, none without. */
  actions: ActionName[];
  /** The paired device this connection authenticated as, as `stim-server devices` lists it. */
  device: { id: string; name: string };
  /** Present only when the hello spent a pairing token or requested build or device-host access. The server keeps only its hash. */
  deviceToken?: string;
  /** Present only on a build or device-host request, which the server then closes; the request lapses at `expiresAt`. */
  approval?: { state: 'pending'; expiresAt: string };
}

export interface SubscribeResult {
  subscription: string;
}

export interface UnsubscribeParams {
  subscription: string;
}

export const LOG_SOURCES = ['metro', 'client', 'device', 'build', 'agent'] as const;

export type LogSource = (typeof LOG_SOURCES)[number];

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error', 'fatal'] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

export const MAX_LOG_TAIL = 5000;

/**
 * The Stim Desktop log viewer's filters, passed to `stim logs`. `workspace` is an environment `path` from a
 * status payload. Without `sources`, `errors` keeps the CLI's default error scope. `tail` defaults to
 * {@link MAX_LOG_TAIL}, which is also its maximum.
 */
export interface LogFilter {
  workspace: string;
  sources?: LogSource[];
  level?: LogLevel;
  slot?: string;
  grep?: string;
  errors?: boolean;
  tail?: number;
}

/** One record as `stim logs --json` prints it. */
export type LogRecord = NdjsonRecord;

export interface LogsQueryResult {
  records: LogRecord[];
}

/** Without `workspace`, stats and settings cover the machine only. */
export interface WorkspaceParams {
  workspace?: string;
}

/** `stim stats --json`. */
export type StatsResult = Record<string, unknown>;

/** `stim settings --json`; the CLI masks sensitive values. */
export type SettingsResult = Record<string, unknown>;

/** `web` is the workspace's Stim-owned Chrome page, from `stim web`; it has only the default slot. */
export const PLATFORMS = ['ios', 'android', 'web'] as const;

export type Platform = (typeof PLATFORMS)[number];

/** The platforms `build.plan` predicts builds for. */
export type BuildPlatform = Exclude<Platform, 'web'>;

/** `reload` also reaches the workspace's Stim-owned Chrome page. */
export const RELOAD_PLATFORMS = ['ios', 'android', 'web'] as const;

export type ReloadPlatform = (typeof RELOAD_PLATFORMS)[number];

export const FRAME_FPS = { default: 5, max: 30, video: 60 } as const;

export const FRAME_EDGE = { min: 240, default: 1280, max: 2048 } as const;

/**
 * A device `stim status` lists as owned by `workspace`, in `slot` (`default` when absent). Frames come only
 * from a booted simulator or a running emulator Stim created, or from the page of the workspace's running
 * Stim-owned Chrome (`web`, default slot only). With `physical`, frames come from the physical device the workspace
 * leases in `slot` instead, as `stim status` lists it under `deviceLeases`; an iPhone streams only over a USB
 * cable, and an Android phone over adb. `fps` caps how many frames a second this
 * subscription gets, and `maxEdge` asks for frames scaled to fit that many pixels; the server may send smaller
 * frames, and larger ones while another subscriber of the same device asks for more.
 */
export interface FrameTarget {
  workspace: string;
  platform: Platform;
  slot?: string;
  physical?: boolean;
  fps?: number;
  maxEdge?: number;
  /** The codecs this client decodes. The server picks one when it can encode video; see {@link FramesSubscribeResult}. */
  video?: VideoCodec[];
  /**
   * Starts the subscription replaying the footage recorded at `at`, as {@link FramesSeekParams} does, and needs
   * `video`. It needs no running device until `frames.live`, so a stopped workspace's footage can be replayed.
   */
  at?: number;
  rate?: FramesSeekParams['rate'];
}

export const VIDEO_CODECS = ['h264'] as const;

export type VideoCodec = (typeof VIDEO_CODECS)[number];

/**
 * With `video`, frames arrive as binary WebSocket messages, one H.264 access unit each; see {@link VideoPacket}.
 * A subscription whose device falls back to screenshots still sends JSON `frame` events.
 */
export interface FramesSubscribeResult extends SubscribeResult {
  video?: VideoCodec;
}

/** Asks for a keyframe on a video subscription, after the client lost its decoder state. */
export interface KeyframeParams {
  subscription: string;
}

/**
 * Plays recorded footage into a video subscription instead of the live screen: the frame at `at` (epoch
 * milliseconds on the Mac's clock) arrives at once, as the access units from the keyframe before it, then playback
 * goes on at `rate` times real time. A `rate` of 0 stays paused on that frame. Time where nothing was recorded is
 * skipped.
 */
export interface FramesSeekParams {
  subscription: string;
  at: number;
  rate: (typeof REPLAY_RATES)[number];
}

export const REPLAY_RATES = [0, 1, 2] as const;

/** `at` is the capture time of the frame shown, at or before the one asked for. */
export interface FramesSeekResult {
  at: number;
}

/** Returns a subscription that seeked to the live screen. */
export interface FramesLiveParams {
  subscription: string;
}

/** A device slot of a workspace, as `frames.subscribe` names it. */
export interface ReplayTarget {
  workspace: string;
  platform: Platform;
  slot?: string;
}

/** A time range with recorded footage, in epoch milliseconds on the Mac's clock. */
export interface ReplaySpan {
  start: number;
  end: number;
}

/** Kinds of timeline marker: an agent `action` on the device, an app or build `error`, and a `crash`. */
export const REPLAY_MARKER_KINDS = ['action', 'error', 'crash'] as const;

/**
 * Something that happened at `at`: an action has agent-device's or the web agent's `command`, such as `press`,
 * `fill`, `open` or `click`. `label` is one line of the log record.
 */
export interface ReplayMarker {
  at: number;
  kind: (typeof REPLAY_MARKER_KINDS)[number];
  command?: string;
  label: string;
}

/**
 * What can be replayed for a device slot. `enabled` is the workspace's `recording.enabled`; `recording` is true
 * while the server records the device now. `spans` are the recorded ranges, oldest first, and `markers` the agent
 * actions and errors from the start of the first span on.
 */
export interface ReplayRange {
  enabled: boolean;
  recording: boolean;
  spans: ReplaySpan[];
  markers: ReplayMarker[];
}

/** A device slot, as {@link ReplayTarget} names it, and a time in epoch milliseconds on the Mac's clock. */
export interface ReplayKeyframeParams extends ReplayTarget {
  at: number;
}

/**
 * The keyframe that starts the recorded segment of about 5 seconds `frames.seek` would show `at` from: the first
 * segment that ends at or after `at`, or the newest one. `start` and `end` are the segment's times, `at` the
 * keyframe's capture time, and `data` the base64 Annex-B access unit, which carries its SPS and PPS.
 */
export interface ReplayKeyframe {
  start: number;
  end: number;
  at: number;
  width: number;
  height: number;
  posture?: 'folded' | 'unfolded';
  data: string;
}

/** Turns `recording.enabled` on or off in the machine layer. Needs `control`. */
export interface RecordingSetParams {
  enabled: boolean;
}

/** `recordingsDeleted` lists the workspaces whose recordings turning recording off deleted. */
export interface RecordingSetResult {
  enabled: boolean;
  recordingsDeleted: string[];
}

/**
 * A replaying subscription reached the newest recorded frame, at `at`, and stays paused there; the client can
 * seek again or return to live with `frames.live`.
 */
export interface ReplayEndedEvent {
  event: 'replay-ended';
  subscription: string;
  at: number;
}

export const VIDEO_HEADER_VERSION = 1;

/** The keyframe bit of a {@link VideoPacket}'s flags. */
export const VIDEO_KEYFRAME = 1;

/** The flag bits of a {@link VideoPacket} that carry an iPhone Duo's posture, as `posture` on a `frame` event. */
export const VIDEO_FOLDED = 2;
export const VIDEO_UNFOLDED = 4;

/**
 * The layout of a binary video message, big-endian: u8 version ({@link VIDEO_HEADER_VERSION}), u8 flags
 * ({@link VIDEO_KEYFRAME}, and on an iPhone Duo {@link VIDEO_FOLDED} or {@link VIDEO_UNFOLDED}), u16 header length, u32 sequence number of the messages sent on this subscription, f64 capture time in milliseconds since the
 * epoch on the Mac's clock, u16 width, u16 height, u8 subscription id length N, N bytes of ASCII subscription
 * id. After the header comes one Annex-B H.264 access unit; a keyframe carries its SPS and PPS. The stream has
 * no B-frames, so each access unit is shown as it arrives.
 */
export interface VideoPacket {
  subscription: string;
  keyframe: boolean;
  sequence: number;
  capturedAt: number;
  width: number;
  height: number;
  posture?: 'folded' | 'unfolded';
  accessUnit: Uint8Array;
}

/** Each action runs one fixed `stim` command in the workspace. */
export const ACTIONS = ['reload', 'stop'] as const;

export type ActionName = (typeof ACTIONS)[number];

/**
 * `reload` runs `stim reload --json`, with `platform` when more than one platform is live; `stop` runs
 * `stim stop --json`. `workspace` is an environment `path` from a status payload. Needs `control`.
 */
export type ActionParams =
  | { action: 'reload'; workspace: string; platform?: ReloadPlatform }
  | { action: 'stop'; workspace: string };

/** `output` is the JSON the command printed. */
export interface ActionResult {
  action: ActionName;
  workspace: string;
  output: Record<string, unknown>;
}

/**
 * Starts a control session on the device `stim status` lists as owned by `workspace` in `slot`. Needs
 * `control`. Refused with `device-busy` while an agent, a device lock or another client drives the device,
 * unless `takeOver` is true. `physical` picks the physical device the workspace leases instead, and only while that
 * lease lasts: the server never takes or renews a physical device's lease, so `takeOver` cannot move one between
 * workspaces. A physical iPhone is view only, so it is refused.
 */
export interface ControlBeginParams {
  workspace: string;
  platform: Platform;
  slot?: string;
  physical?: boolean;
  takeOver?: boolean;
}

/**
 * `lease` is the `stim device lock` lease the server holds for the session, or null when it holds none, such
 * as after taking over a device another workspace leases, and always for a web page, which `stim device lock`
 * does not cover. For a physical device it is the workspace's own lease, which the session ends with. `postures` lists what `input.posture` accepts for
 * the device: `folded` and `unfolded` for an iPhone Duo, all three for an emulator with a hinge, and none
 * otherwise.
 */
export interface ControlBeginResult {
  session: string;
  platform: Platform;
  lease: { grantedAt: string | null; expiresAt: string } | null;
  postures: DevicePosture[];
}

export interface ControlEndParams {
  session: string;
}

export const TOUCH_PHASES = ['down', 'move', 'up'] as const;

export type TouchPhase = (typeof TOUCH_PHASES)[number];

/**
 * `x` and `y` are fractions of the upright screen, origin top-left; on a web page, of its viewport, where a
 * drag scrolls. `display` is 0 for the main display; without it, an iPhone Duo's touch goes to the panel its
 * frames show.
 */
export interface InputTouchParams {
  session: string;
  phase: TouchPhase;
  x: number;
  y: number;
  display?: number;
}

export const MAX_INPUT_TEXT = 256;

/** Printable ASCII, where `\n` presses Return, `\t` Tab and `\b` Delete. */
export interface InputTextParams {
  session: string;
  text: string;
}

/** `home` and `lock` on iOS and Android; `back` on Android and web, where it goes back in the page's history; `app-switch` on Android only. */
export const INPUT_BUTTONS = ['home', 'lock', 'back', 'app-switch'] as const;

export type InputButton = (typeof INPUT_BUTTONS)[number];

export interface InputButtonParams {
  session: string;
  button: InputButton;
}

/** `left` turns the device a quarter turn counterclockwise, `right` clockwise. */
export const ROTATE_DIRECTIONS = ['left', 'right'] as const;

export type RotateDirection = (typeof ROTATE_DIRECTIONS)[number];

export interface InputRotateParams {
  session: string;
  direction: RotateDirection;
}

export const DEVICE_POSTURES = ['folded', 'half-open', 'unfolded'] as const;

export type DevicePosture = (typeof DEVICE_POSTURES)[number];

/** Moves the hinge of a device whose `control.begin` result lists `posture`. */
export interface InputPostureParams {
  session: string;
  posture: DevicePosture;
}

/** Predicts the next `ios` or `android` build of `workspace` in `slot` (`default` when absent). */
export interface BuildPlanParams {
  workspace: string;
  platform: BuildPlatform;
  slot?: string;
}

/** `stim ios|android --plan --json`. It builds, boots and installs nothing, and writes no Stim state. */
export type BuildPlanResult = BuildPlanPayload;
/** A client's repository on a build machine: letters, digits, `.`, `_` and `-`, at most 80. */
export const BUILD_REPO_PATTERN = '^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$';

/** Asks a build machine what it can build, how busy it is, and how warm its copy of `repo` is. */
export interface BuildOfferParams {
  repo: string;
  /** sha256 of the repository's lockfile, compared with the one the machine last installed from. */
  lockfile?: string;
}

/** The toolchain a build must match exactly on both Macs. */
export interface BuildToolchain {
  stimBuild: string | null;
  arch: string;
  xcode: string | null;
  simulatorSdk: string | null;
  cocoapods: string | null;
  /** Simulator runtime identifiers that have an iPhone simulator to build for. */
  runtimes: string[];
  /** The major version of the JDK Gradle runs on there. */
  jdk: string | null;
  /** The NDK, build-tools and platform directories of its Android SDK; null without an SDK. */
  androidSdk: { ndk: string[]; buildTools: string[]; platforms: string[] } | null;
}

/**
 * How busy the build machine is. `running` counts offloaded builds and `max` is how many it runs at once.
 * `cpus`, `loadPerCore` (5-minute load average per CPU), `builds` (its own Stim native builds plus the offloaded
 * ones), `maxBuilds` (its `concurrency.maxBuilds`, 0 when unlimited) and `maxLoadPerCore` are absent from a
 * stim-server older than them. `declined` is why it would refuse a build now, null when it would take one.
 */
export interface BuildCapacity {
  running: number;
  max: number;
  diskFreeBytes: number | null;
  minDiskFreeBytes: number;
  cpus?: number;
  loadPerCore?: number;
  builds?: number;
  maxBuilds?: number;
  maxLoadPerCore?: number;
  declined?: string | null;
}

export interface BuildOfferResult {
  toolchain: BuildToolchain;
  capacity: BuildCapacity;
  warm: { checkout: boolean; dependencies: boolean; build: boolean };
}

/** One file of the client's checkout. A `link` blob holds the symlink's target. */
export interface BuildFile {
  path: string;
  kind: 'file' | 'exec' | 'link';
  size: number;
  sha256: string;
}

/**
 * One page of the manifest of `repo`, as `git ls-files -co --exclude-standard` lists it. Pages accumulate until
 * `done`; the next `build.sync` after that starts a new manifest.
 */
export interface BuildSyncParams {
  repo: string;
  files: BuildFile[];
  done: boolean;
}

/** The digests of this page the machine lacks; the client sends each as binary frames before `build.start`. */
export interface BuildSyncResult {
  missing: string[];
}

/** The Gradle choices of an Android build: `assemble<variant>`, one ABI, and the caches it compiles with. */
export interface BuildAndroidOptions {
  variant: string | null;
  abi: string | null;
  gradleBuildCache: boolean;
  pch: 'auto' | 'on' | 'off';
  compilerCache: 'ccache' | 'none';
}

/**
 * Builds the synced manifest of `repo`. The machine refuses unless its fingerprint equals `fingerprint`. iOS
 * needs `runtime`; Android needs `android`.
 */
export interface BuildStartParams {
  repo: string;
  project: string;
  platform: 'ios' | 'android';
  configuration: string | null;
  scheme: string | null;
  runtime: string | null;
  fingerprint: string;
  packageName: string | null;
  isExpo: boolean;
  optimizations: Record<string, unknown> | null;
  android?: BuildAndroidOptions | null;
  stimBuild: string;
}

export interface BuildJobParams {
  job: string;
}

/** A job taken over by a new connection: its outcome once it ended, else null and its progress follows. */
export interface BuildAttachResult {
  outcome: BuildJobOutcome | null;
}

/** Sent after the artifact's binary frames: the archive's name, size and sha256. */
export interface BuildArtifactResult {
  name: string;
  size: number;
  sha256: string;
}

export type BuildJobOutcome =
  | {
      ok: true;
      artifact: BuildArtifactResult;
      fingerprint: string;
      compilationCache: Record<string, unknown>;
      timings: Record<string, number>;
    }
  | { ok: false; code: string; message: string; timings?: Record<string, number> };

export type MemoryPressure = 'normal' | 'warning' | 'critical';

/** A volume that holds Stim workspaces, Stim home, or the simulators. */
export interface MachineVolume {
  /** `/`, or `/Volumes/<name>` for an external volume. */
  mount: string;
  /** What Stim keeps there: `Workspaces`, `Stim home`, `Simulators`. */
  holds: string[];
  /** Free space without purgeable space, which is what Stim's disk budget measures. */
  freeBytes: number;
  totalBytes: number;
}

/** Cheap machine usage, read in the server process without running `stim`. */
export interface MachineUsage {
  volumes: MachineVolume[];
  /**
   * `usedBytes` is the Mac's memory in use, as Activity Monitor's "Memory Used" counts it: app memory, wired and
   * compressed. `pressure` is the macOS memory pressure level. Both are null on other systems or when they cannot
   * be read.
   */
  memory: { totalBytes: number; usedBytes: number | null; pressure: MemoryPressure | null };
  load: { avg1: number; avg5: number; avg15: number; cpus: number };
  /**
   * `usage` is the Mac's overall CPU busy fraction (0..1), from the tick delta between this call and the
   * previous one. Null on the first call of a server process, since there is no previous sample yet.
   */
  cpu: { usage: number | null; cores: number };
  sampledAt: string;
}

/**
 * One `machine.history` sample. `at` is epoch milliseconds. `cpu` is the busy fraction (0..1) since the previous
 * sample. `memoryPressure` is 0 (normal), 1 (warning) or 2 (critical). `diskFreeBytes` is the free space of the
 * startup volume, `/`. A field is null when it could not be read.
 */
export interface UsageSample {
  at: number;
  cpu: number | null;
  memoryUsedBytes: number | null;
  memoryPressure: 0 | 1 | 2 | null;
  diskFreeBytes: number | null;
}

/** Returns only the samples taken after `sinceMs`, epoch milliseconds. */
export interface MachineHistoryParams {
  sinceMs?: number;
}

export interface MachineHistory {
  intervalMs: number;
  samples: UsageSample[];
}

/**
 * The Mac's disk and build detail: the payloads of the `stim gc --json` dry run and of `stim stats --json`, both run in
 * the home directory. A part is null when its command failed, and its `gcError` or `statsError` says why.
 * `measuredAt` is when the commands started. The server keeps one result for 60 seconds, shared by every connection.
 */
export interface MachineDetails {
  gc: Record<string, unknown> | null;
  gcError?: string;
  stats: Record<string, unknown> | null;
  statsError?: string;
  /**
   * `buildMachines` from `stim doctor --json --platform ios`; empty when `offload.machines` names none. The reply
   * never waits for doctor: `buildMachines` and `buildMachinesError` are the last result a background doctor run
   * settled, `buildMachinesAt` is when it settled, and `buildMachinesPending` is true while that result is stale
   * (or absent) and a refresh is running. A client that wants the refreshed result asks `machine.details` again.
   */
  buildMachines: BuildMachineReport[] | null;
  buildMachinesError?: string;
  buildMachinesAt?: string;
  buildMachinesPending?: boolean;
  /**
   * The builds this Mac ran for other Macs as a build machine, one entry per client, from the audit log. `today` is
   * this Mac's local calendar day. Absent from a server older than this field.
   */
  buildClients?: BuildClientSummary[];
  measuredAt: string;
}

export interface BuildClientSummary {
  id: string;
  name: string;
  builds: number;
  failed: number;
  buildMs: number;
  today: { builds: number; failed: number; buildMs: number };
  lastAt: string;
}

/** One `offload.machines` entry as `stim doctor --json` reports it; `guide facts doctor` defines the fields. */
export interface BuildMachineReport {
  machine: string;
  state: string;
  dnsName?: string;
  deviceId?: string;
  requestedAt?: string;
  offloadable?: boolean;
  reasons?: string[];
  problems?: { code: string; reason: string }[];
  capacity?: BuildMachineCapacity;
}

export interface BuildMachineCapacity {
  running?: number;
  max?: number;
  diskFreeBytes?: number | null;
  minDiskFreeBytes?: number;
  cpus?: number;
  loadPerCore?: number;
  builds?: number;
  maxBuilds?: number;
  maxLoadPerCore?: number;
  declined?: string | null;
}

/**
 * What stim-server can push, named like the phone's notification settings: work `started` (a workspace began
 * warming or an agent first drove its device), an agent that looks `stuck`, one that is `looping` on the same
 * failure, work `finished` (the agent stopped after a green build, or the workspace's pull request became ready for
 * review or merged), a `machine` in trouble, and a `control` conflict over a device this phone controls.
 */
export const PUSH_EVENTS = ['started', 'stuck', 'looping', 'finished', 'machine', 'control', 'attention'] as const;

export type PushEvent = (typeof PUSH_EVENTS)[number];

/** Events phones registered before `PUSH_EVENTS`: `disk` stands for `machine`, and the others no longer push. */
export const LEGACY_PUSH_EVENTS = ['build-failed', 'log-errors', 'disk', 'app-stopped', 'slow-build'] as const;

export type LegacyPushEvent = (typeof LEGACY_PUSH_EVENTS)[number];

/**
 * How a pushed event is delivered: `alert` with a banner and sound, `silent` to the notification list only (iOS
 * `interruptionLevel` `passive`, the Android `updates` channel). An event the device leaves out of `events` is off.
 */
export const NOTIFICATION_LEVELS = ['alert', 'silent'] as const;

export type NotificationLevel = (typeof NOTIFICATION_LEVELS)[number];

/**
 * When pushes stay silent, in minutes after midnight in the phone's IANA `timeZone`; an `end` before `start` spans
 * midnight. A problem that still holds when they end is pushed then; events during them are not.
 */
export interface QuietHours {
  start: number;
  end: number;
  timeZone: string;
}

/**
 * Asks the server to push this device's notifications through the Expo push service to `token`, an Expo push
 * token, for at least one event. Registering again replaces the previous registration. `ref` is echoed as
 * `data.ref` in every push, so the phone can tell which Mac sent it. `stuckMinutes` is how long a driven workspace
 * must show no activity to look stuck, 15 by default. `levels` sets each event's delivery; an event it leaves out
 * is silent. An older server ignores `levels`. `agentOnly` is accepted from older phones and ignored.
 */
export interface PushRegisterParams {
  token: string;
  events: (PushEvent | LegacyPushEvent)[];
  levels?: Partial<Record<PushEvent, NotificationLevel>>;
  agentOnly?: boolean;
  ref: string;
  stuckMinutes?: number;
  quietHours?: QuietHours;
}

/** Why the registered phones did not get a logged notification when it happened. */
export const NOTIFICATION_SUPPRESSIONS = ['muted', 'quiet-hours'] as const;

export type NotificationSuppression = (typeof NOTIFICATION_SUPPRESSIONS)[number];

/** What a logged notification opens, as its push's `data` does. */
export type NotificationTarget =
  | { kind: 'machine' }
  | { kind: 'workspace'; path: string }
  | { kind: 'device'; path: string; platform: Platform; slot: string }
  | { kind: 'build'; path: string; platform: BuildPlatform }
  | { kind: 'url'; path: string; url: string };

/**
 * One oversight notification the server generated, whether or not it was pushed. `seq` grows by one per entry in
 * a log; `id` names the workspace or machine and category, as a push's collapse id does, so a later episode shares
 * it. `suppressed` is set when no registered phone got it at `at`: `muted` when none wants its category,
 * `quiet-hours` when those that do were in quiet hours; a problem that still held when they ended was pushed then.
 */
export interface NotificationEntry {
  seq: number;
  at: string;
  id: string;
  category: PushEvent;
  title: string;
  body: string;
  /** The event's default delivery; a device's `levels` decide how its push was delivered. */
  quiet: boolean;
  target: NotificationTarget;
  suppressed?: NotificationSuppression;
}

/** Returns only the entries after `since`, a `cursor` an earlier list returned. */
export interface NotificationsListParams {
  since?: number;
}

/**
 * The server's notification history, newest first. `log` changes when the history starts over, so a cursor or
 * read state kept for another `log` no longer applies; `cursor` is the newest `seq`, 0 for an empty log.
 */
export interface NotificationsListResult {
  log: string;
  cursor: number;
  notifications: NotificationEntry[];
}

export interface Methods {
  'device-host.reserve': { params: HostedDeviceRequest; result: HostedDeviceSession };
  'device-host.attach': { params: { session: string } | { attempt: string }; result: HostedDeviceSession };
  'device-host.stop': { params: { session: string }; result: HostedDeviceSession };
  'device-host.app.offer': {
    params: HostedAppOffer;
    result: { delivery: HostedAppDelivery; missing: { sha256: string; size: number; offset: number }[] };
  };
  'device-host.app.chunk': {
    params: { session: string; attempt: string; sha256: string; offset: number; data: string };
    result: { offset: number };
  };
  'device-host.app.launch': { params: { session: string; attempt: string }; result: HostedAppDelivery };
  'device-host.app.attach': { params: { session: string; attempt: string }; result: HostedAppDelivery };
  hello: { params: HelloParams; result: HelloResult };
  'status.subscribe': { params?: Record<string, never>; result: SubscribeResult };
  'logs.query': { params: LogFilter; result: LogsQueryResult };
  'logs.subscribe': { params: LogFilter; result: SubscribeResult };
  'stats.get': { params?: WorkspaceParams; result: StatsResult };
  'settings.get': { params?: WorkspaceParams; result: SettingsResult };
  'frames.subscribe': { params: FrameTarget; result: FramesSubscribeResult };
  'frames.keyframe': { params: KeyframeParams; result: Record<string, never> };
  'frames.seek': { params: FramesSeekParams; result: FramesSeekResult };
  'frames.live': { params: FramesLiveParams; result: Record<string, never> };
  'replay.range': { params: ReplayTarget; result: ReplayRange };
  'replay.keyframe': { params: ReplayKeyframeParams; result: ReplayKeyframe };
  'recording.set': { params: RecordingSetParams; result: RecordingSetResult };
  'build.plan': { params: BuildPlanParams; result: BuildPlanResult };
  'machine.get': { params?: Record<string, never>; result: MachineUsage };
  'machine.history': { params?: MachineHistoryParams; result: MachineHistory };
  'machine.details': { params?: Record<string, never>; result: MachineDetails };
  unsubscribe: { params: UnsubscribeParams; result: Record<string, never> };
  action: { params: ActionParams; result: ActionResult };
  'control.begin': { params: ControlBeginParams; result: ControlBeginResult };
  'control.end': { params: ControlEndParams; result: Record<string, never> };
  'input.touch': { params: InputTouchParams; result: Record<string, never> };
  'input.text': { params: InputTextParams; result: Record<string, never> };
  'input.button': { params: InputButtonParams; result: Record<string, never> };
  'input.rotate': { params: InputRotateParams; result: Record<string, never> };
  'input.posture': { params: InputPostureParams; result: Record<string, never> };
  'push.register': { params: PushRegisterParams; result: Record<string, never> };
  'push.unregister': { params?: Record<string, never>; result: Record<string, never> };
  'notifications.list': { params?: NotificationsListParams; result: NotificationsListResult };
  'build.offer': { params: BuildOfferParams; result: BuildOfferResult };
  'build.sync': { params: BuildSyncParams; result: BuildSyncResult };
  'build.start': { params: BuildStartParams; result: BuildJobParams };
  'build.cancel': { params: BuildJobParams; result: Record<string, never> };
  'build.artifact': { params: BuildJobParams; result: BuildArtifactResult };
  'build.attach': { params: BuildJobParams; result: BuildAttachResult };
}

export type ClientRequest = {
  [M in Method]: { id: RequestId; method: M } & Pick<Methods[M], 'params'>;
}[Method];

export interface ProtocolError {
  code: ErrorCode;
  message: string;
}

export type ServerResponse =
  | { id: RequestId; result: Methods[Method]['result'] }
  | { id: RequestId | null; error: ProtocolError };

/** One CPU and memory series of {@link UsageHistory}: `cpuPercent` is ps %CPU, where 100 is one core. */
export interface UsageSeries {
  cpuPercent: (number | null)[];
  memoryMb: (number | null)[];
}

/** A simulator's or emulator's series; `id` is its UDID or AVD name, as its machine owner names it. */
export interface DeviceUsageSeries extends UsageSeries {
  kind: 'simulator' | 'emulator';
  id: string;
  workspace: string | null;
  slot?: string;
}

/**
 * The last 10 minutes of CPU and memory the server read from status payloads while a client was connected, in slots
 * of `intervalMs`, oldest first: point `i` of `n` is at `endAt - (n - 1 - i) * intervalMs`, null where no payload
 * fell in its slot. An environment's series sums every machine owner of that `workspace`, an environment `path`.
 */
export interface UsageHistory {
  intervalMs: number;
  endAt: number;
  environments: (UsageSeries & { workspace: string })[];
  devices: DeviceUsageSeries[];
}

/** A full status payload, as `stim status --watch --json` prints it, and the server's usage history, when it has one. */
export interface StatusEvent {
  event: 'status';
  subscription: string;
  payload: StatusPayload;
  usage?: UsageHistory;
  /** `grantedAt` of the device leases this server holds for phones; absent when it holds none. */
  ownLeases?: string[];
}

/**
 * Records for a `logs.subscribe` subscription: first the last `tail` matching records, then new ones as
 * they arrive.
 */
export interface LogsEvent {
  event: 'logs';
  subscription: string;
  records: LogRecord[];
}

/** A subscription ended because its source failed or the client fell behind; the client may resubscribe. */
export interface ErrorEvent {
  event: 'error';
  subscription: string;
  error: ProtocolError;
}

/** A frame of the device's screen, sent when the screen changed, at most `fps` times a second. */
export interface FrameEvent {
  event: 'frame';
  subscription: string;
  platform: Platform;
  slot: string;
  mime: 'image/jpeg';
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
 * client keeps showing its last frame. Followed by `delayed: false` once captures recover. `reason` says why
 * frames stopped when the server knows, such as a locked iPhone or one another app captures.
 */
export interface FrameDelayedEvent {
  event: 'frame-delayed';
  subscription: string;
  delayed: boolean;
  reason?: string;
}

export const CONTROL_END_REASONS = ['idle', 'taken-over', 'device-gone', 'forbidden', 'failed'] as const;

/**
 * The server ended a control session: no input for 5 minutes, another client took the device over, the device
 * stopped or changed owner, the device lost `control`, or input could not reach the device.
 */
export interface ControlEndedEvent {
  event: 'control-ended';
  session: string;
  reason: (typeof CONTROL_END_REASONS)[number];
  message: string;
}

/** A notification the server just logged, sent to each connection that sent `notifications.list`. */
export interface NotificationEvent {
  event: 'notification';
  log: string;
  notification: NotificationEntry;
}

/**
 * A build job's progress: a `phase` line, a build-log `record`, or, last, its `outcome`. The job ends with the
 * connection that started it.
 */
export interface BuildProgressEvent {
  event: 'build.progress';
  job: string;
  phase?: string;
  msg?: string;
  record?: Record<string, unknown>;
  outcome?: BuildJobOutcome;
}

export type ServerEvent =
  | BuildProgressEvent
  | NotificationEvent
  | StatusEvent
  | LogsEvent
  | FrameEvent
  | FrameDelayedEvent
  | ReplayEndedEvent
  | ErrorEvent
  | ControlEndedEvent;

export type ServerMessage = ServerResponse | ServerEvent;

type JsonSchema = Record<string, unknown>;

const requestId: JsonSchema = { type: ['integer', 'string'] };

const protocolError: JsonSchema = {
  type: 'object',
  required: ['code', 'message'],
  additionalProperties: false,
  properties: { code: { enum: [...ERROR_CODES] }, message: { type: 'string' } },
};

const buildRepo: JsonSchema = { type: 'string', pattern: BUILD_REPO_PATTERN };

const sha256: JsonSchema = { type: 'string', pattern: '^[0-9a-f]{64}$' };

const buildJob: JsonSchema = {
  type: 'object',
  required: ['job'],
  additionalProperties: false,
  properties: { job: { type: 'string' } },
};

function request(method: Method, params?: JsonSchema): JsonSchema {
  return {
    type: 'object',
    required: params ? ['id', 'method', 'params'] : ['id', 'method'],
    additionalProperties: false,
    properties: { id: requestId, method: { const: method }, params: params ?? { type: 'object', maxProperties: 0 } },
  };
}

function session(properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema {
  return {
    type: 'object',
    required: ['session', ...required],
    additionalProperties: false,
    properties: { session: { type: 'string' }, ...properties },
  };
}

function optionalParams(method: Method, params: JsonSchema): JsonSchema {
  return {
    type: 'object',
    required: ['id', 'method'],
    additionalProperties: false,
    properties: { id: requestId, method: { const: method }, params },
  };
}

/** The JSON Schema of every message on the wire, written to `dist/protocol.schema.json` at build time. */
export function protocolJsonSchema(): JsonSchema {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'Stim server protocol',
    description: `Messages exchanged over the stim-server WebSocket, protocol version ${PROTOCOL_VERSION}.`,
    'x-stim-protocol': PROTOCOL_VERSION,
    $defs: {
      ProtocolError: protocolError,
      HostedAppDelivery: {
        type: 'object',
        required: ['session', 'attempt', 'bundleId', 'mode', 'state', 'launched'],
        additionalProperties: false,
        properties: {
          session: { type: 'string' },
          attempt: { type: 'string' },
          bundleId: { type: 'string' },
          mode: { enum: ['development', 'release'] },
          state: { enum: ['receiving', 'installing', 'installed', 'unknown'] },
          launched: { enum: [true, 'unverified', null] },
          notice: { type: 'string' },
        },
      },
      HostedAppOfferResult: {
        type: 'object',
        required: ['delivery', 'missing'],
        additionalProperties: false,
        properties: {
          delivery: { $ref: '#/$defs/HostedAppDelivery' },
          missing: {
            type: 'array',
            items: {
              type: 'object',
              required: ['sha256', 'size', 'offset'],
              additionalProperties: false,
              properties: { sha256, size: { type: 'integer', minimum: 0 }, offset: { type: 'integer', minimum: 0 } },
            },
          },
        },
      },
      HostedAppChunkResult: {
        type: 'object',
        required: ['offset'],
        additionalProperties: false,
        properties: { offset: { type: 'integer', minimum: 0 } },
      },
      HostedDeviceSession: {
        type: 'object',
        required: ['id', 'client', 'workspace', 'slot', 'platform', 'attempt', 'state', 'device', 'createdAt'],
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          client: { type: 'string' },
          workspace: { type: 'string' },
          slot: { type: 'string' },
          platform: { enum: ['ios', 'android'] },
          attempt: { type: 'string' },
          deviceType: { type: 'string' },
          runtime: { type: 'string' },
          systemImage: { type: 'string' },
          deviceProfile: { type: 'string' },
          consolePort: { type: 'integer', minimum: 5554, maximum: 5584, multipleOf: 2 },
          state: { enum: ['preparing', 'ready', 'stopping', 'stopped', 'unknown'] },
          device: {
            anyOf: [
              { type: 'null' },
              {
                type: 'object',
                required: ['udid', 'name', 'deviceTypeId', 'runtimeId', 'deviceType', 'runtime', 'architecture'],
                additionalProperties: false,
                properties: {
                  udid: { type: 'string' },
                  name: { type: 'string' },
                  deviceTypeId: { type: 'string' },
                  runtimeId: { type: 'string' },
                  deviceType: { type: 'string' },
                  runtime: { type: 'string' },
                  architecture: { enum: ['arm64', 'x86_64'] },
                },
              },
              {
                type: 'object',
                required: ['avdName', 'serial', 'consolePort', 'systemImage', 'deviceProfile', 'architecture'],
                additionalProperties: false,
                properties: {
                  avdName: { type: 'string' },
                  serial: { type: 'string' },
                  consolePort: { type: 'integer', minimum: 5554, maximum: 5584, multipleOf: 2 },
                  systemImage: { type: 'string' },
                  deviceProfile: { type: 'string' },
                  architecture: { enum: ['arm64-v8a', 'x86_64'] },
                },
              },
            ],
          },
          createdAt: { type: 'string' },
          notice: { type: 'string' },
          appAttempt: { type: 'string' },
        },
      },
      HelloParams: {
        type: 'object',
        required: ['protocol', 'client', 'auth'],
        additionalProperties: false,
        properties: {
          protocol: { type: 'integer' },
          client: {
            type: 'object',
            required: ['name', 'version'],
            properties: { name: { type: 'string' }, version: { type: 'string' } },
          },
          auth: {
            oneOf: [
              {
                type: 'object',
                required: ['pairingToken', 'deviceName'],
                additionalProperties: false,
                properties: { pairingToken: { type: 'string' }, deviceName: { type: 'string', minLength: 1 } },
              },
              {
                type: 'object',
                required: ['deviceToken'],
                additionalProperties: false,
                properties: { deviceToken: { type: 'string' } },
              },
              {
                type: 'object',
                required: ['request', 'deviceName'],
                additionalProperties: false,
                properties: {
                  request: { enum: ['build', 'device-host'] },
                  deviceName: { type: 'string', minLength: 1 },
                },
              },
            ],
          },
        },
      },
      HelloResult: {
        type: 'object',
        required: ['protocol', 'server', 'capabilities', 'features', 'actions', 'device'],
        additionalProperties: false,
        properties: {
          protocol: { type: 'integer' },
          server: {
            type: 'object',
            required: ['name', 'version', 'stim', 'home'],
            additionalProperties: false,
            properties: {
              name: { type: 'string' },
              version: { type: 'string' },
              stim: { type: 'string' },
              home: { type: 'string' },
            },
          },
          capabilities: { type: 'array', items: { enum: [...CAPABILITIES] } },
          features: { type: 'array', items: { enum: [...FEATURES] } },
          actions: { type: 'array', items: { enum: [...ACTIONS] } },
          device: {
            type: 'object',
            required: ['id', 'name'],
            additionalProperties: false,
            properties: { id: { type: 'string' }, name: { type: 'string' } },
          },
          deviceToken: { type: 'string' },
          approval: {
            type: 'object',
            required: ['state', 'expiresAt'],
            additionalProperties: false,
            properties: { state: { const: 'pending' }, expiresAt: { type: 'string' } },
          },
        },
      },
      LogRecord: {
        type: 'object',
        description: 'One record as `stim logs --json` prints it.',
        properties: {
          ts: { type: 'number' },
          src: { type: 'string' },
          level: { type: 'string' },
          msg: { type: 'string' },
          context: {
            type: 'array',
            items: { type: 'string' },
            description: 'With `errors`: the code frame and stack lines Expo printed after this error.',
          },
        },
      },
      LogFilter: {
        type: 'object',
        required: ['workspace'],
        additionalProperties: false,
        properties: {
          workspace: { type: 'string', description: 'An environment path from a status payload.' },
          sources: { type: 'array', minItems: 1, items: { enum: [...LOG_SOURCES] } },
          level: { enum: [...LOG_LEVELS] },
          slot: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$' },
          grep: {
            type: 'string',
            pattern: '^[^\\u0000]*$',
            description: 'A regular expression matched against each message.',
          },
          errors: { type: 'boolean' },
          tail: { type: 'integer', minimum: 1, maximum: MAX_LOG_TAIL, default: MAX_LOG_TAIL },
        },
      },
      FrameTarget: {
        type: 'object',
        required: ['workspace', 'platform'],
        additionalProperties: false,
        properties: {
          workspace: { type: 'string', description: 'An environment path from a status payload.' },
          platform: { enum: [...PLATFORMS] },
          slot: { type: 'string', minLength: 1, default: 'default' },
          physical: { type: 'boolean', default: false },
          fps: {
            type: 'integer',
            minimum: 1,
            maximum: FRAME_FPS.video,
            default: FRAME_FPS.default,
            description: `At most ${FRAME_FPS.max} unless the result offers video.`,
          },
          maxEdge: {
            type: 'integer',
            minimum: FRAME_EDGE.min,
            maximum: FRAME_EDGE.max,
            default: FRAME_EDGE.default,
          },
          video: { type: 'array', items: { enum: [...VIDEO_CODECS] } },
          at: { type: 'number', description: 'Start replaying the footage recorded at this time; needs video.' },
          rate: { enum: [...REPLAY_RATES] },
        },
      },
      ActionParams: {
        oneOf: [
          {
            type: 'object',
            required: ['action', 'workspace'],
            additionalProperties: false,
            properties: {
              action: { const: 'reload' },
              workspace: { type: 'string', description: 'An environment path from a status payload.' },
              platform: { enum: [...RELOAD_PLATFORMS] },
            },
          },
          {
            type: 'object',
            required: ['action', 'workspace'],
            additionalProperties: false,
            properties: {
              action: { const: 'stop' },
              workspace: { type: 'string', description: 'An environment path from a status payload.' },
            },
          },
        ],
      },
      ActionResult: {
        type: 'object',
        required: ['action', 'workspace', 'output'],
        additionalProperties: false,
        properties: {
          action: { enum: [...ACTIONS] },
          workspace: { type: 'string' },
          output: { type: 'object', description: 'The JSON the command printed.' },
        },
      },
      ControlBeginParams: {
        type: 'object',
        required: ['workspace', 'platform'],
        additionalProperties: false,
        properties: {
          workspace: { type: 'string', description: 'An environment path from a status payload.' },
          platform: { enum: [...PLATFORMS] },
          slot: { type: 'string', minLength: 1, default: 'default' },
          physical: { type: 'boolean', default: false },
          takeOver: { type: 'boolean', default: false },
        },
      },
      ControlBeginResult: {
        type: 'object',
        required: ['session', 'platform', 'lease', 'postures'],
        additionalProperties: false,
        properties: {
          session: { type: 'string' },
          platform: { enum: [...PLATFORMS] },
          lease: {
            oneOf: [
              { type: 'null' },
              {
                type: 'object',
                required: ['grantedAt', 'expiresAt'],
                additionalProperties: false,
                properties: {
                  grantedAt: { type: ['string', 'null'], format: 'date-time' },
                  expiresAt: { type: 'string', format: 'date-time' },
                },
              },
            ],
          },
          postures: { type: 'array', items: { enum: [...DEVICE_POSTURES] }, uniqueItems: true },
        },
      },
      BuildPlanParams: {
        type: 'object',
        required: ['workspace', 'platform'],
        additionalProperties: false,
        properties: {
          workspace: { type: 'string', description: 'An environment path from a status payload.' },
          platform: { enum: ['ios', 'android'] },
          slot: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$', default: 'default' },
        },
      },
      WorkspaceParams: {
        type: 'object',
        additionalProperties: false,
        properties: { workspace: { type: 'string', description: 'An environment path from a status payload.' } },
      },
      UsageHistory: {
        type: 'object',
        required: ['intervalMs', 'endAt', 'environments', 'devices'],
        additionalProperties: false,
        properties: {
          intervalMs: { type: 'integer' },
          endAt: { type: 'integer' },
          environments: {
            type: 'array',
            items: {
              type: 'object',
              required: ['workspace', 'cpuPercent', 'memoryMb'],
              additionalProperties: false,
              properties: {
                workspace: { type: 'string' },
                cpuPercent: { type: 'array', items: { type: ['number', 'null'] } },
                memoryMb: { type: 'array', items: { type: ['number', 'null'] } },
              },
            },
          },
          devices: {
            type: 'array',
            items: {
              type: 'object',
              required: ['kind', 'id', 'workspace', 'cpuPercent', 'memoryMb'],
              additionalProperties: false,
              properties: {
                kind: { enum: ['simulator', 'emulator'] },
                id: { type: 'string' },
                workspace: { type: ['string', 'null'] },
                slot: { type: 'string' },
                cpuPercent: { type: 'array', items: { type: ['number', 'null'] } },
                memoryMb: { type: 'array', items: { type: ['number', 'null'] } },
              },
            },
          },
        },
      },
      NotificationEntry: {
        type: 'object',
        required: ['seq', 'at', 'id', 'category', 'title', 'body', 'quiet', 'target'],
        additionalProperties: false,
        properties: {
          seq: { type: 'integer', minimum: 1 },
          at: { type: 'string', format: 'date-time' },
          id: { type: 'string' },
          category: { enum: [...PUSH_EVENTS] },
          title: { type: 'string' },
          body: { type: 'string' },
          quiet: { type: 'boolean' },
          target: {
            type: 'object',
            required: ['kind'],
            properties: {
              kind: { enum: ['machine', 'workspace', 'device', 'build', 'url'] },
              path: { type: 'string' },
              platform: { enum: [...PLATFORMS] },
              slot: { type: 'string' },
              url: { type: 'string' },
            },
          },
          suppressed: { enum: [...NOTIFICATION_SUPPRESSIONS] },
        },
      },
      MachineDetails: {
        type: 'object',
        required: ['gc', 'stats', 'buildMachines', 'measuredAt'],
        additionalProperties: false,
        properties: {
          gc: { type: ['object', 'null'], description: 'The payload of the `stim gc --json` dry run.' },
          gcError: { type: 'string' },
          stats: { type: ['object', 'null'], description: 'The payload of `stim stats --json`.' },
          statsError: { type: 'string' },
          buildMachines: {
            type: ['array', 'null'],
            description: '`buildMachines` from `stim doctor --json --platform ios`.',
            items: { type: 'object' },
          },
          buildMachinesError: { type: 'string' },
          buildMachinesAt: { type: 'string' },
          buildMachinesPending: { type: 'boolean' },
          buildClients: {
            type: 'array',
            description: 'The builds this Mac ran for each client as a build machine, from the audit log.',
            items: {
              type: 'object',
              required: ['id', 'name', 'builds', 'failed', 'buildMs', 'today', 'lastAt'],
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                name: { type: 'string' },
                builds: { type: 'integer' },
                failed: { type: 'integer' },
                buildMs: { type: 'integer' },
                today: {
                  type: 'object',
                  required: ['builds', 'failed', 'buildMs'],
                  additionalProperties: false,
                  properties: {
                    builds: { type: 'integer' },
                    failed: { type: 'integer' },
                    buildMs: { type: 'integer' },
                  },
                },
                lastAt: { type: 'string' },
              },
            },
          },
          measuredAt: { type: 'string' },
        },
      },
      MachineHistory: {
        type: 'object',
        required: ['intervalMs', 'samples'],
        additionalProperties: false,
        properties: {
          intervalMs: { type: 'integer' },
          samples: {
            type: 'array',
            items: {
              type: 'object',
              required: ['at', 'cpu', 'memoryUsedBytes', 'memoryPressure', 'diskFreeBytes'],
              additionalProperties: false,
              properties: {
                at: { type: 'integer' },
                cpu: { type: ['number', 'null'] },
                memoryUsedBytes: { type: ['number', 'null'] },
                memoryPressure: { enum: [0, 1, 2, null] },
                diskFreeBytes: { type: ['number', 'null'] },
              },
            },
          },
        },
      },
      MachineUsage: {
        type: 'object',
        required: ['volumes', 'memory', 'load', 'cpu', 'sampledAt'],
        additionalProperties: false,
        properties: {
          volumes: {
            type: 'array',
            items: {
              type: 'object',
              required: ['mount', 'holds', 'freeBytes', 'totalBytes'],
              additionalProperties: false,
              properties: {
                mount: { type: 'string' },
                holds: { type: 'array', items: { type: 'string' } },
                freeBytes: { type: 'number' },
                totalBytes: { type: 'number' },
              },
            },
          },
          memory: {
            type: 'object',
            required: ['totalBytes', 'usedBytes', 'pressure'],
            additionalProperties: false,
            properties: {
              totalBytes: { type: 'number' },
              usedBytes: { type: ['number', 'null'] },
              pressure: { enum: ['normal', 'warning', 'critical', null] },
            },
          },
          load: {
            type: 'object',
            required: ['avg1', 'avg5', 'avg15', 'cpus'],
            additionalProperties: false,
            properties: {
              avg1: { type: 'number' },
              avg5: { type: 'number' },
              avg15: { type: 'number' },
              cpus: { type: 'integer' },
            },
          },
          cpu: {
            type: 'object',
            required: ['usage', 'cores'],
            additionalProperties: false,
            properties: {
              usage: { type: ['number', 'null'] },
              cores: { type: 'integer' },
            },
          },
          sampledAt: { type: 'string', format: 'date-time' },
        },
      },
      ClientRequest: {
        oneOf: [
          request('device-host.reserve', {
            type: 'object',
            required: ['workspace', 'slot', 'platform', 'attempt'],
            additionalProperties: false,
            properties: {
              workspace: { type: 'string', minLength: 1, maxLength: 4096 },
              slot: { type: 'string', pattern: '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$' },
              platform: { enum: ['ios', 'android'] },
              attempt: { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,128}$' },
              deviceType: { type: 'string', minLength: 1, maxLength: 256 },
              runtime: { type: 'string', minLength: 1, maxLength: 256 },
              systemImage: { type: 'string', minLength: 1, maxLength: 256 },
              deviceProfile: { type: 'string', minLength: 1, maxLength: 256 },
            },
            oneOf: [
              {
                properties: { platform: { const: 'ios' } },
                not: { anyOf: [{ required: ['systemImage'] }, { required: ['deviceProfile'] }] },
              },
              {
                properties: { platform: { const: 'android' } },
                not: { anyOf: [{ required: ['deviceType'] }, { required: ['runtime'] }] },
              },
            ],
          }),
          request('device-host.attach', {
            oneOf: [
              {
                type: 'object',
                required: ['session'],
                additionalProperties: false,
                properties: { session: { type: 'string' } },
              },
              {
                type: 'object',
                required: ['attempt'],
                additionalProperties: false,
                properties: { attempt: { type: 'string' } },
              },
            ],
          }),
          request('device-host.stop', session({})),
          request(
            'device-host.app.offer',
            session(
              {
                attempt: { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,128}$' },
                bundleId: { type: 'string' },
                mode: { enum: ['development', 'release'] },
                manifest: {
                  type: 'object',
                  required: ['sha256', 'size'],
                  additionalProperties: false,
                  properties: { sha256, size: { type: 'integer', minimum: 1, maximum: 8 * 1024 ** 2 } },
                },
              },
              ['attempt', 'bundleId', 'mode', 'manifest'],
            ),
          ),
          request(
            'device-host.app.chunk',
            session(
              {
                attempt: { type: 'string' },
                sha256,
                offset: { type: 'integer', minimum: 0 },
                data: { type: 'string', maxLength: 43692 },
              },
              ['attempt', 'sha256', 'offset', 'data'],
            ),
          ),
          request('device-host.app.launch', session({ attempt: { type: 'string' } }, ['attempt'])),
          request('device-host.app.attach', session({ attempt: { type: 'string' } }, ['attempt'])),
          request('hello', { $ref: '#/$defs/HelloParams' }),
          request('status.subscribe'),
          request('logs.query', { $ref: '#/$defs/LogFilter' }),
          request('logs.subscribe', { $ref: '#/$defs/LogFilter' }),
          request('frames.subscribe', { $ref: '#/$defs/FrameTarget' }),
          request('frames.keyframe', {
            type: 'object',
            required: ['subscription'],
            additionalProperties: false,
            properties: { subscription: { type: 'string' } },
          }),
          request('frames.seek', {
            type: 'object',
            required: ['subscription', 'at', 'rate'],
            additionalProperties: false,
            properties: {
              subscription: { type: 'string' },
              at: { type: 'number', description: 'Epoch milliseconds on the Mac clock.' },
              rate: { enum: [...REPLAY_RATES] },
            },
          }),
          request('frames.live', {
            type: 'object',
            required: ['subscription'],
            additionalProperties: false,
            properties: { subscription: { type: 'string' } },
          }),
          request('replay.range', {
            type: 'object',
            required: ['workspace', 'platform'],
            additionalProperties: false,
            properties: {
              workspace: { type: 'string' },
              platform: { enum: [...PLATFORMS] },
              slot: { type: 'string', minLength: 1 },
            },
          }),
          request('replay.keyframe', {
            type: 'object',
            required: ['workspace', 'platform', 'at'],
            additionalProperties: false,
            properties: {
              workspace: { type: 'string' },
              platform: { enum: [...PLATFORMS] },
              slot: { type: 'string', minLength: 1 },
              at: { type: 'number', description: 'Epoch milliseconds on the Mac clock.' },
            },
          }),
          request('recording.set', {
            type: 'object',
            required: ['enabled'],
            additionalProperties: false,
            properties: { enabled: { type: 'boolean' } },
          }),
          request('build.plan', { $ref: '#/$defs/BuildPlanParams' }),
          request('machine.get'),
          optionalParams('machine.history', {
            type: 'object',
            additionalProperties: false,
            properties: { sinceMs: { type: 'number' } },
          }),
          request('machine.details'),
          optionalParams('stats.get', { $ref: '#/$defs/WorkspaceParams' }),
          optionalParams('settings.get', { $ref: '#/$defs/WorkspaceParams' }),
          request('unsubscribe', {
            type: 'object',
            required: ['subscription'],
            additionalProperties: false,
            properties: { subscription: { type: 'string' } },
          }),
          request('action', { $ref: '#/$defs/ActionParams' }),
          request('control.begin', { $ref: '#/$defs/ControlBeginParams' }),
          request('control.end', session({})),
          request(
            'input.touch',
            session(
              {
                phase: { enum: [...TOUCH_PHASES] },
                x: { type: 'number', minimum: 0, maximum: 1 },
                y: { type: 'number', minimum: 0, maximum: 1 },
                display: { type: 'integer', minimum: 0, maximum: 3 },
              },
              ['phase', 'x', 'y'],
            ),
          ),
          request(
            'input.text',
            session(
              {
                text: { type: 'string', minLength: 1, maxLength: MAX_INPUT_TEXT, pattern: '^[\\x20-\\x7e\\n\\t\\b]+$' },
              },
              ['text'],
            ),
          ),
          request('input.button', session({ button: { enum: [...INPUT_BUTTONS] } }, ['button'])),
          request('input.rotate', session({ direction: { enum: [...ROTATE_DIRECTIONS] } }, ['direction'])),
          request('input.posture', session({ posture: { enum: [...DEVICE_POSTURES] } }, ['posture'])),
          request('push.register', {
            type: 'object',
            required: ['token', 'events', 'ref'],
            additionalProperties: false,
            properties: {
              token: { type: 'string', pattern: PUSH_TOKEN_PATTERN, description: 'An Expo push token.' },
              events: {
                type: 'array',
                minItems: 1,
                uniqueItems: true,
                items: { enum: [...PUSH_EVENTS, ...LEGACY_PUSH_EVENTS] },
              },
              levels: {
                type: 'object',
                additionalProperties: false,
                properties: Object.fromEntries(PUSH_EVENTS.map((event) => [event, { enum: [...NOTIFICATION_LEVELS] }])),
              },
              agentOnly: { type: 'boolean', default: false },
              ref: { type: 'string', minLength: 1, maxLength: 128 },
              stuckMinutes: { type: 'integer', minimum: 1, maximum: 240, default: 15 },
              quietHours: {
                type: 'object',
                required: ['start', 'end', 'timeZone'],
                additionalProperties: false,
                properties: {
                  start: { type: 'integer', minimum: 0, maximum: 1439 },
                  end: { type: 'integer', minimum: 0, maximum: 1439 },
                  timeZone: { type: 'string', minLength: 1, maxLength: 64, description: 'An IANA time zone.' },
                },
              },
            },
          }),
          request('push.unregister'),
          request('notifications.list', {
            type: 'object',
            additionalProperties: false,
            properties: { since: { type: 'integer', minimum: 0 } },
          }),
          request('build.offer', {
            type: 'object',
            required: ['repo'],
            additionalProperties: false,
            properties: { repo: buildRepo, lockfile: sha256 },
          }),
          request('build.sync', {
            type: 'object',
            required: ['repo', 'files', 'done'],
            additionalProperties: false,
            properties: {
              repo: buildRepo,
              files: {
                type: 'array',
                items: {
                  type: 'object',
                  required: ['path', 'kind', 'size', 'sha256'],
                  additionalProperties: false,
                  properties: {
                    path: { type: 'string', minLength: 1 },
                    kind: { enum: ['file', 'exec', 'link'] },
                    size: { type: 'integer', minimum: 0 },
                    sha256,
                  },
                },
              },
              done: { type: 'boolean' },
            },
          }),
          request('build.start', {
            type: 'object',
            required: [
              'repo',
              'project',
              'platform',
              'configuration',
              'scheme',
              'runtime',
              'fingerprint',
              'packageName',
              'isExpo',
              'optimizations',
              'stimBuild',
            ],
            additionalProperties: false,
            properties: {
              repo: buildRepo,
              project: { type: 'string', description: 'The app directory relative to the repository root.' },
              platform: { enum: ['ios', 'android'] },
              configuration: { type: ['string', 'null'] },
              scheme: { type: ['string', 'null'] },
              runtime: { type: ['string', 'null'], minLength: 1 },
              fingerprint: { type: 'string', minLength: 1 },
              packageName: { type: ['string', 'null'] },
              isExpo: { type: 'boolean' },
              optimizations: { type: ['object', 'null'] },
              android: {
                type: ['object', 'null'],
                required: ['variant', 'abi', 'gradleBuildCache', 'pch', 'compilerCache'],
                additionalProperties: false,
                properties: {
                  variant: { type: ['string', 'null'] },
                  abi: { type: ['string', 'null'] },
                  gradleBuildCache: { type: 'boolean' },
                  pch: { enum: ['auto', 'on', 'off'] },
                  compilerCache: { enum: ['ccache', 'none'] },
                },
              },
              stimBuild: { type: 'string', minLength: 1 },
            },
          }),
          request('build.cancel', buildJob),
          request('build.artifact', buildJob),
          request('build.attach', buildJob),
        ],
      },
      ServerResponse: {
        oneOf: [
          {
            type: 'object',
            required: ['id', 'result'],
            additionalProperties: false,
            properties: {
              id: requestId,
              result: {
                anyOf: [
                  { $ref: '#/$defs/HostedDeviceSession' },
                  { $ref: '#/$defs/HostedAppDelivery' },
                  { $ref: '#/$defs/HostedAppOfferResult' },
                  { $ref: '#/$defs/HostedAppChunkResult' },
                  { $ref: '#/$defs/HelloResult' },
                  { $ref: '#/$defs/ControlBeginResult' },
                  { $ref: '#/$defs/ActionResult' },
                  { $ref: '#/$defs/MachineUsage' },
                  { $ref: '#/$defs/MachineHistory' },
                  { $ref: '#/$defs/MachineDetails' },
                  {
                    type: 'object',
                    required: ['log', 'cursor', 'notifications'],
                    additionalProperties: false,
                    properties: {
                      log: { type: 'string' },
                      cursor: { type: 'integer' },
                      notifications: { type: 'array', items: { $ref: '#/$defs/NotificationEntry' } },
                    },
                  },
                  {
                    type: 'object',
                    required: ['at'],
                    additionalProperties: false,
                    properties: { at: { type: 'number' } },
                  },
                  {
                    type: 'object',
                    required: ['enabled', 'recording', 'spans', 'markers'],
                    additionalProperties: false,
                    properties: {
                      enabled: { type: 'boolean' },
                      recording: { type: 'boolean' },
                      spans: {
                        type: 'array',
                        items: {
                          type: 'object',
                          required: ['start', 'end'],
                          additionalProperties: false,
                          properties: { start: { type: 'number' }, end: { type: 'number' } },
                        },
                      },
                      markers: {
                        type: 'array',
                        items: {
                          type: 'object',
                          required: ['at', 'kind', 'label'],
                          additionalProperties: false,
                          properties: {
                            at: { type: 'number' },
                            kind: { enum: [...REPLAY_MARKER_KINDS] },
                            command: { type: 'string' },
                            label: { type: 'string' },
                          },
                        },
                      },
                    },
                  },
                  {
                    type: 'object',
                    required: ['start', 'end', 'at', 'width', 'height', 'data'],
                    additionalProperties: false,
                    properties: {
                      start: { type: 'number' },
                      end: { type: 'number' },
                      at: { type: 'number' },
                      width: { type: 'integer' },
                      height: { type: 'integer' },
                      posture: { enum: ['folded', 'unfolded'] },
                      data: {
                        type: 'string',
                        contentEncoding: 'base64',
                        description: 'One Annex-B H.264 access unit.',
                      },
                    },
                  },
                  {
                    type: 'object',
                    required: ['enabled', 'recordingsDeleted'],
                    additionalProperties: false,
                    properties: {
                      enabled: { type: 'boolean' },
                      recordingsDeleted: { type: 'array', items: { type: 'string' } },
                    },
                  },
                  {
                    type: 'object',
                    required: ['subscription'],
                    additionalProperties: false,
                    properties: { subscription: { type: 'string' }, video: { enum: [...VIDEO_CODECS] } },
                  },
                  {
                    type: 'object',
                    required: ['records'],
                    additionalProperties: false,
                    properties: { records: { type: 'array', items: { $ref: '#/$defs/LogRecord' } } },
                  },
                  {
                    type: 'object',
                    description:
                      'The payload of `stim stats --json`, `stim settings --json` or `stim ios|android --plan --json`, or {} for unsubscribe.',
                  },
                ],
              },
            },
          },
          {
            type: 'object',
            required: ['id', 'error'],
            additionalProperties: false,
            properties: { id: { type: ['integer', 'string', 'null'] }, error: { $ref: '#/$defs/ProtocolError' } },
          },
        ],
      },
      ServerEvent: {
        oneOf: [
          {
            type: 'object',
            required: ['event', 'job'],
            additionalProperties: false,
            properties: {
              event: { const: 'build.progress' },
              job: { type: 'string' },
              phase: { type: 'string' },
              msg: { type: 'string' },
              record: { type: 'object' },
              outcome: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } },
            },
          },
          {
            type: 'object',
            required: ['event', 'log', 'notification'],
            additionalProperties: false,
            properties: {
              event: { const: 'notification' },
              log: { type: 'string' },
              notification: { $ref: '#/$defs/NotificationEntry' },
            },
          },
          {
            type: 'object',
            required: ['event', 'subscription', 'payload'],
            additionalProperties: false,
            properties: {
              event: { const: 'status' },
              subscription: { type: 'string' },
              payload: { type: 'object', description: 'A full payload, as `stim status --watch --json` prints it.' },
              usage: { $ref: '#/$defs/UsageHistory' },
              ownLeases: { type: 'array', items: { type: 'string' } },
            },
          },
          {
            type: 'object',
            required: ['event', 'subscription', 'records'],
            additionalProperties: false,
            properties: {
              event: { const: 'logs' },
              subscription: { type: 'string' },
              records: { type: 'array', items: { $ref: '#/$defs/LogRecord' } },
            },
          },
          {
            type: 'object',
            required: ['event', 'subscription', 'platform', 'slot', 'mime', 'width', 'height', 'capturedAt', 'data'],
            additionalProperties: false,
            properties: {
              event: { const: 'frame' },
              subscription: { type: 'string' },
              platform: { enum: [...PLATFORMS] },
              slot: { type: 'string' },
              mime: { const: 'image/jpeg' },
              width: { type: 'integer' },
              height: { type: 'integer' },
              capturedAt: { type: 'string', format: 'date-time' },
              data: { type: 'string', contentEncoding: 'base64' },
              posture: { enum: ['folded', 'unfolded'] },
            },
          },
          {
            type: 'object',
            required: ['event', 'subscription', 'delayed'],
            additionalProperties: false,
            properties: {
              event: { const: 'frame-delayed' },
              subscription: { type: 'string' },
              delayed: { type: 'boolean' },
              reason: { type: 'string' },
            },
          },
          {
            type: 'object',
            required: ['event', 'subscription', 'at'],
            additionalProperties: false,
            properties: {
              event: { const: 'replay-ended' },
              subscription: { type: 'string' },
              at: { type: 'number' },
            },
          },
          {
            type: 'object',
            required: ['event', 'session', 'reason', 'message'],
            additionalProperties: false,
            properties: {
              event: { const: 'control-ended' },
              session: { type: 'string' },
              reason: { enum: [...CONTROL_END_REASONS] },
              message: { type: 'string' },
            },
          },
          {
            type: 'object',
            required: ['event', 'subscription', 'error'],
            additionalProperties: false,
            properties: {
              event: { const: 'error' },
              subscription: { type: 'string' },
              error: { $ref: '#/$defs/ProtocolError' },
            },
          },
        ],
      },
    },
    oneOf: [{ $ref: '#/$defs/ClientRequest' }, { $ref: '#/$defs/ServerResponse' }, { $ref: '#/$defs/ServerEvent' }],
  };
}
