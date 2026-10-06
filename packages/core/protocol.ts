import type {
  BuildPlanPayload,
  HostedDeviceRequest,
  HostedDeviceOfferRequest,
  HostedDeviceOffer,
  HostedDeviceSession,
  HostedAppOffer,
  HostedAppDelivery,
  HostedAppLaunch,
  HostedLogsCursor,
  HostedLogsPage,
  NdjsonRecord,
  StatusPayload,
} from './state/index.ts';

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
 * `macos-hosted` relays `frames.subscribe` and control for a workspace whose macOS app
 * `stim macos --remote` placed on another Mac.
 * `macos-windows` is the `macos-windows` event on a macOS `frames.subscribe`, naming the window capture follows
 * and the app's other windows.
 * `hosted-congestion` is `device-host.frames.congested`, which lowers the bitrate of a hosted video subscription
 * whose client is behind.
 * `macos-window-select` is `input.window`, which pins the view to a macOS app window named by `macos-windows`,
 * bringing it to the front, or with null resumes following the front window.
 * `server-update` is `server.update.status`, `server.update.start` and `server.update.chunk`.
 */
export const FEATURES = [
  'physical-ios',
  'physical-android',
  'notifications',
  'macos-window',
  'macos-windows',
  'macos-window-select',
  'macos-window-control',
  'macos-keyboard-extended',
  'device-frames',
  'macos-hosted',
  'duo-frames',
  'workspace-diff',
  'hosted-congestion',
  'server-update',
] as const;

export type Feature = (typeof FEATURES)[number];

export const METHODS = [
  'hello',
  'route.setup',
  'status.subscribe',
  'logs.query',
  'logs.subscribe',
  'stats.get',
  'settings.get',
  'workspace.files',
  'workspace.diff',
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
  'input.simulator',
  'input.scroll',
  'input.key',
  'input.window',
  'push.register',
  'push.unregister',
  'notifications.list',
  'build.offer',
  'build.sync',
  'build.start',
  'build.cancel',
  'build.artifact',
  'build.attach',
  'device-host.offer',
  'device-host.reserve',
  'device-host.attach',
  'device-host.stop',
  'device-host.app.offer',
  'device-host.app.chunk',
  'device-host.app.handoff',
  'device-host.app.launch',
  'device-host.app.attach',
  'device-host.logs.query',
  'device-host.metro.open',
  'device-host.metro.close',
  'device-host.frames.subscribe',
  'device-host.frames.keyframe',
  'device-host.frames.congested',
  'device-host.unsubscribe',
  'device-host.control.begin',
  'device-host.control.end',
  'device-host.input.touch',
  'device-host.input.text',
  'device-host.input.scroll',
  'device-host.input.key',
  'device-host.input.button',
  'device-host.input.rotate',
  'device-host.input.posture',
  'device-host.input.window',
  'server.update.status',
  'server.update.start',
  'server.update.chunk',
  'machines.update.start',
  'machines.update.status',
] as const;

/**
 * The methods that update this server's `stim-server service`. A Mac this one approved for `build` or
 * `device-host` may call them; they need neither `read` nor `control`.
 */
export const SERVER_UPDATE_METHODS = ['server.update.status', 'server.update.start', 'server.update.chunk'] as const;

/** The methods a connection with the `build` capability may call; they need `build`, not `read`. */
export const BUILD_METHODS = [
  'build.offer',
  'build.sync',
  'build.start',
  'build.cancel',
  'build.artifact',
  'build.attach',
] as const;

/** Methods restricted to explicitly approved device-host clients. */
export const DEVICE_HOST_METHODS = [
  'device-host.offer',
  'device-host.reserve',
  'device-host.attach',
  'device-host.stop',
  'device-host.app.offer',
  'device-host.app.chunk',
  'device-host.app.handoff',
  'device-host.app.launch',
  'device-host.app.attach',
  'device-host.logs.query',
  'device-host.metro.open',
  'device-host.metro.close',
  'device-host.frames.subscribe',
  'device-host.frames.keyframe',
  'device-host.frames.congested',
  'device-host.unsubscribe',
  'device-host.control.begin',
  'device-host.control.end',
  'device-host.input.touch',
  'device-host.input.text',
  'device-host.input.scroll',
  'device-host.input.key',
  'device-host.input.button',
  'device-host.input.rotate',
  'device-host.input.posture',
  'device-host.input.window',
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
  /** Present when the server runs under Stim Host: the grants macOS gives that app, or null if unavailable. */
  host?: { name: string; screenRecording: boolean; accessibility: boolean } | null;
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

export const LOG_SOURCES = ['metro', 'client', 'device', 'build', 'agent', 'maintenance'] as const;

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
export const PLATFORMS = ['ios', 'android', 'web', 'macos'] as const;

export type Platform = (typeof PLATFORMS)[number];

/** The platforms `build.plan` predicts builds for. */
export type BuildPlatform = Extract<Platform, 'ios' | 'android'>;
export type ControlPlatform = Platform;

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
  /** Requests installed ordinary-device artwork for this live subscription. */
  deviceFrame?: boolean;
  /** Requests a composed Duo image carrying the pose used to map its input. */
  duoFrame?: boolean;
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

/** Bit 5 marks clockwise artwork quarter-turns in bits 3-4; absent on recordings and unsupported sources. */
export const VIDEO_ARTWORK = 32;

/**
 * The layout of a binary video message, big-endian: u8 version ({@link VIDEO_HEADER_VERSION}), u8 flags
 * ({@link VIDEO_KEYFRAME}, posture bits and {@link VIDEO_ARTWORK}), u16 header length, u32 sequence number of the messages sent on this subscription, f64 capture time in milliseconds since the
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
  artworkTurns?: number;
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
  platform: ControlPlatform;
  slot?: string;
  physical?: boolean;
  takeOver?: boolean;
}

/**
 * `lease` is the `stim device lock` lease the server holds for the session, or null when it holds none, such
 * as after taking over a device another workspace leases, and always for a web page or native macOS app, which `stim device lock`
 * does not cover. For a physical device it is the workspace's own lease, which the session ends with. `postures` lists what `input.posture` accepts for
 * the device: `folded` and `unfolded` for an iPhone Duo, all three for an emulator with a hinge, and none
 * otherwise.
 */
export interface ControlBeginResult {
  session: string;
  platform: Platform;
  lease: { grantedAt: string | null; expiresAt: string } | null;
  postures: DevicePosture[];
  simulator?: SimulatorOptions;
}

/** Available simulator controls and the current guest animation setting; null means unsupported. */
export interface SimulatorOptions {
  canShake: boolean;
  slowAnimations: boolean | null;
}

export type SimulatorCommand = { action: 'read' | 'shake' } | { action: 'slow-animations'; enabled: boolean };

export type InputSimulatorParams = SimulatorCommand & { session: string };

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
  /** The revision of the composed Duo image actually displayed by the client. */
  duoRevision?: string;
}

/** Native macOS pixel scrolling at a normalized point of the captured window. Deltas are capped at 1000 pixels. */
export interface InputScrollParams {
  session: string;
  x: number;
  y: number;
  deltaX: number;
  deltaY: number;
}

export const INPUT_KEYS = [
  'escape',
  'tab',
  'return',
  'backspace',
  'left',
  'right',
  'up',
  'down',
  'a',
  'b',
  'c',
  'd',
  'e',
  'f',
  'g',
  'h',
  'i',
  'j',
  'k',
  'l',
  'm',
  'n',
  'o',
  'p',
  'q',
  'r',
  's',
  't',
  'u',
  'v',
  'w',
  'x',
  'y',
  'z',
  '0',
  '1',
  '2',
  '3',
  '4',
  '5',
  '6',
  '7',
  '8',
  '9',
] as const;
export type InputKey = (typeof INPUT_KEYS)[number];
export const KEY_MODIFIERS = ['command', 'shift', 'option', 'control'] as const;
export type KeyModifier = (typeof KEY_MODIFIERS)[number];

/** Pins an owned macOS app window by id, or resumes following its front window with null. */
export interface InputWindowParams {
  session: string;
  window: number | null;
}

/** A fixed native macOS key and optional modifiers, sent only to the captured owned app window. */
export interface InputKeyParams {
  session: string;
  key: InputKey;
  modifiers?: KeyModifier[];
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
  macosSdk: string | null;
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
 * needs `runtime`; Android needs `android`; macOS needs `macos` and uses the manifest digest as its fingerprint.
 */
export interface BuildStartParams {
  repo: string;
  project: string;
  platform: 'ios' | 'android' | 'macos';
  configuration?: string | null;
  scheme?: string | null;
  runtime?: string | null;
  fingerprint: string;
  packageName?: string | null;
  isExpo?: boolean;
  optimizations?: Record<string, unknown> | null;
  android?: BuildAndroidOptions | null;
  macos?: {
    product: string;
    infoPlist: string;
    bundleId: string;
    resources?: Record<string, string>;
    assetCatalog?: string | null;
  } | null;
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
  /**
   * For a macOS job, a single-use token for the staged bundle this Mac keeps for a while, which a hosted session of a
   * device-host client on the same tailnet node can take with `device-host.app.handoff`.
   */
  handoff?: string;
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

export interface WorkspaceFile {
  path: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  status: string;
}

export interface WorkspaceFiles {
  files: WorkspaceFile[];
  truncated: boolean;
}

export interface WorkspacePatch {
  section: 'staged' | 'unstaged' | 'untracked';
  kind: 'text' | 'binary' | 'too-large' | 'unavailable';
  text: string;
}

export interface WorkspaceDiff {
  path: string;
  patches: WorkspacePatch[];
}

/** A `.tgz` package of a client-supplied stim-server build: its file name, size in bytes and sha256. */
export interface ServerUpdatePackage {
  name: string;
  size: number;
  sha256: string;
}

/**
 * What `server.update.start` installs: an exact stim-server `release` from the public npm registry, or the
 * `packages` of a client's own build, which the Mac takes only while its `server.acceptClientBuilds` is true.
 */
export type ServerUpdateStartParams = { release: string } | { packages: ServerUpdatePackage[] };

/**
 * An update this server runs. `uploading` waits for the rest of the packages; `installing` runs
 * `stim-server service update`, whose last `log` lines say how far it got. The connection closes when the job
 * restarts; the new server's `hello` and `server.update.status` then tell how it ended.
 */
export interface ServerUpdateProgress {
  id: string;
  by: { id: string; name: string };
  target: string;
  state: 'uploading' | 'installing';
  startedAt: string;
  missing: { name: string; offset: number }[];
  log: string[];
}

export interface ServerUpdateOutcome {
  at: string;
  target: string;
  ok: boolean;
  message: string;
}

/**
 * Whether this server can update itself, and how. `service` is the `stim-server service` label it runs under, or
 * null when it does not run as a service and so cannot update itself. `last` is how the last `service update`
 * of that label ended, whoever ran it.
 */
export interface ServerUpdateStatus {
  server: { version: string; stimBuild: string | null };
  service: string | null;
  acceptsClientBuilds: boolean;
  running: ServerUpdateProgress | null;
  last: ServerUpdateOutcome | null;
}

/**
 * Where an update this Mac asked `machine` for stands: the host's own `server.update.status`, or why it could not be
 * read (`unreachable`, also while the host restarts), and how much of this Mac's build it has sent.
 */
export interface MachineUpdateStatus {
  remote: ServerUpdateStatus | null;
  unreachable: string | null;
  upload: { sent: number; total: number; error: string | null } | null;
}

export interface Methods {
  'machines.update.start': { params: { machine: string }; result: ServerUpdateProgress };
  'machines.update.status': { params: { machine: string }; result: MachineUpdateStatus };
  'server.update.status': { params?: Record<string, never>; result: ServerUpdateStatus };
  'server.update.start': { params: ServerUpdateStartParams; result: ServerUpdateProgress };
  'server.update.chunk': {
    params: { id: string; name: string; offset: number; data: string };
    result: ServerUpdateProgress;
  };
  'workspace.files': { params: { workspace: string; group: 'changed' | 'untracked' }; result: WorkspaceFiles };
  'workspace.diff': { params: { workspace: string; path: string }; result: WorkspaceDiff };
  'device-host.offer': { params: HostedDeviceOfferRequest; result: HostedDeviceOffer };
  'route.setup': { params?: Record<string, never>; result: ServeRoute };
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
  'device-host.app.handoff': {
    params: { session: string; attempt: string; build: { handoff: string; sha256: string } };
    result: { files: number; bytes: number };
  };
  'device-host.app.launch': { params: { session: string; attempt: string }; result: HostedAppLaunch };
  'device-host.app.attach': { params: { session: string; attempt: string }; result: HostedAppLaunch };
  'device-host.logs.query': { params: { session: string; cursor?: HostedLogsCursor }; result: HostedLogsPage };
  'device-host.metro.open': {
    params: { session: string; gatewayPort: number; secret: string };
    result: { port: number };
  };
  'device-host.metro.close': { params: { session: string }; result: { port: null } };
  'device-host.frames.subscribe': {
    params: { session: string; fps?: number; maxEdge?: number; video?: string[] };
    result: FramesSubscribeResult;
  };
  'device-host.frames.keyframe': Methods['frames.keyframe'];
  'device-host.frames.congested': Methods['frames.keyframe'];
  'device-host.unsubscribe': Methods['unsubscribe'];
  'device-host.control.begin': { params: { session: string; takeOver?: boolean }; result: ControlBeginResult };
  'device-host.control.end': Methods['control.end'];
  'device-host.input.touch': Methods['input.touch'];
  'device-host.input.text': Methods['input.text'];
  'device-host.input.scroll': Methods['input.scroll'];
  'device-host.input.key': Methods['input.key'];
  'device-host.input.button': Methods['input.button'];
  'device-host.input.rotate': Methods['input.rotate'];
  'device-host.input.posture': Methods['input.posture'];
  'device-host.input.window': Methods['input.window'];
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
  'input.simulator': { params: InputSimulatorParams; result: SimulatorOptions };
  'input.scroll': { params: InputScrollParams; result: Record<string, never> };
  'input.key': { params: InputKeyParams; result: Record<string, never> };
  'input.window': { params: InputWindowParams; result: Record<string, never> };
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
/** Installed device artwork rasterized on the Mac; layers contain PNG bytes, never a local path. */
export interface DeviceFrameArtwork {
  width: number;
  height: number;
  aperture: { x: number; y: number; width: number; height: number };
  cornerRadius: number;
  quarterTurns: number;
  background: string;
  foreground: string;
}

export interface DeviceFrameEvent {
  event: 'device-frame';
  subscription: string;
  artwork: DeviceFrameArtwork | null;
}

export interface MacosWindow {
  id: number;
  title: string;
  frame: { x: number; y: number; width: number; height: number };
}

/**
 * Sent after subscribing and when the captured window, window list or pin mode changes. `pinned` is true while
 * `input.window` pins the view to `current`, and false while following the front window.
 */
export interface MacosWindowsEvent {
  event: 'macos-windows';
  subscription: string;
  current: MacosWindow | null;
  windows: MacosWindow[];
  pinned: boolean;
}

export interface DuoFramePose {
  revision: string;
  screenID: number;
  angle: number;
  orientation: number;
}

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
  /** Clockwise artwork rotation captured with this frame. */
  artworkTurns?: number;
  duo?: DuoFramePose;
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
  | DeviceFrameEvent
  | MacosWindowsEvent
  | FrameDelayedEvent
  | ReplayEndedEvent
  | ErrorEvent
  | ControlEndedEvent;

export type ServerMessage = ServerResponse | ServerEvent;

export type ServeRoute =
  | { state: 'routed'; port: number }
  | { state: 'funneled'; ports: number[]; port: number }
  | { state: 'missing'; port: number }
  | { state: 'unknown'; reason: string; port: number };
