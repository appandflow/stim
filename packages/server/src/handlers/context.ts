import type { DesktopBootstrap } from '../desktop-bootstrap.ts';
import type { SetupDeps } from '../setup.ts';
import type { KeepAwakeOptions } from '../keep-awake.ts';
import type { Transport } from '@stim-cli/transport';
import type { TailscaleState, TailscaleMonitor } from '@stim-cli/transport-tailscale';
import type { RequestLog, RequestTracker } from '../request-log.ts';
import type { LogLimits } from '../logs.ts';
import type { CommandLimits } from '../stim-command.ts';
import type { FrameLimits } from '../frames.ts';
import type { RecordLimits } from '../recorder.ts';
import type { PushLimits, PushNotifierOptions } from '../push.ts';
import type { BuildLimits } from '../build.ts';
import type { DeviceHostLimits, StatusViews, StatusPayload } from '@stim-cli/core/state';
import type { HostedRelayOptions } from '../hosted-relay.ts';
import type { WebSocket } from 'ws';
import { NoiseSocket } from '@stim-cli/core/noise-session';
import type { ServerMessage, HelloHost, ProtocolError, RequestId, ErrorCode, VideoCodec } from '../protocol.ts';
import { StatusFeed } from '../status-feed.ts';
import type { JsonObject } from '../feed.ts';
import type { StartupState } from '../startup.ts';
import type { Registries, PairedDevice } from '../registry.ts';
import { UsageSampler } from '../machine.ts';
import { UsageRecorder } from '../usage-history.ts';
import { DeviceHost } from '../device-host.ts';
import { ControlHub } from '../control.ts';

export interface ServerOptions {
  /** Private bootstrap received from the Desktop parent; never a persisted pairing capability. */
  desktopBootstrap?: DesktopBootstrap;
  /** What `stim setup` runs with when Stim Desktop approves a request here; `defaultSetupDeps` by default. */
  setupDeps?: () => SetupDeps;
  host?: { executable: string; name: string };
  name: string;
  hosts: string[];
  /**
   * Listens on `hosts` alone, never on a Tailscale address, and refuses every request that names a remote peer,
   * such as one forwarded by `tailscale serve` to a loopback port, so only this machine's own connections are served.
   */
  loopbackOnly?: boolean;
  /**
   * Holds a macOS power assertion that prevents idle system sleep on AC power while `setting` is true and the server
   * listens on an address its transports added to `hosts`. Without it the server holds none.
   */
  keepAwake?: KeepAwakeOptions;
  /** Whether this machine can host simulators and apps for other machines; only a Mac can. Defaults to running on macOS. */
  hostsDevices?: boolean;
  port: number;
  /**
   * Set for a server `stim share` started: `idle` runs once its last share has ended, or when no share starts within
   * `graceMs` (two minutes by default) of the server being ready.
   */
  shareServer?: { idle: () => void; graceMs?: number };
  /** The Unix socket for this machine's own user; defaults to core's serverLocalSocket(), null for none. */
  localSocket?: string | null;
  stimCli: string;
  stimVersion: string;
  serverVersion: string;
  env: NodeJS.ProcessEnv;
  /** The environment now, for builds run for other machines to see tools installed since `env` was built. */
  currentEnv?: () => NodeJS.ProcessEnv;
  /**
   * The transports that carry phones and other machines to this server. Without them, the server uses a Tailscale
   * transport built from `tailscale`, `tailscaleState` and `tailscaleMonitor`. The server listens on each
   * transport's bind addresses while it reports them.
   */
  transports?: Transport[];
  tailscale?: string | null;
  tailscaleState?: TailscaleState;
  /**
   * Keeps the Tailscale state current after start. Without it, `tailscale` and `tailscaleState` stay as
   * given. While Tailscale runs the server listens on its addresses, and it closes them when Tailscale stops.
   */
  tailscaleMonitor?: TailscaleMonitor;
  /** How long to wait before listening again on a Tailscale address that failed; tests shorten it. */
  listenRetryMs?: number;
  /**
   * How long the startup read of the Stim home directories may take, and how long to wait before reading them
   * again after it failed; tests shorten them.
   */
  startupProbeMs?: number;
  startupRetryMs?: number;
  authTimeoutMs?: number;
  maxAuthFailures?: number;
  failureWindowMs?: number;
  /** Unauthenticated connections each network listener holds at once, overall and per source address. */
  pendingConnections?: { max: number; perPeer: number };
  /** First contacts naming an unknown secret that one address may make per failure window. */
  maxUnknownSecrets?: number;
  /** How long a connection to a network address has to send its request headers. */
  headersTimeoutMs?: number;
  requestLog?: RequestLog;
  logLimits?: Partial<LogLimits>;
  commandLimits?: Partial<CommandLimits>;
  actionLimits?: Partial<CommandLimits>;
  /** How many requests one connection, and one tailnet device across its connections, run at a time. */
  requestLimits?: Partial<RequestLimits>;
  frameLimits?: Partial<FrameLimits>;
  /** False runs no recorder; true by default. The limits say how much footage it keeps. */
  record?: boolean;
  recordLimits?: Partial<RecordLimits>;
  /**
   * The `stim-frames` helper to stream frames with, or null for screenshots only. Without it, the server builds
   * one at startup, and devices subscribed before the build finishes get screenshots.
   */
  frameHelper?: string | null;
  /** The Duo fold/angle helper. Without it, the server builds one on the first fold or composed viewer. */
  foldHelper?: string;
  controlLimits?: Partial<ControlLimits>;
  /** False runs the notification rules only while a phone is registered for pushes; true by default. */
  history?: boolean;
  /**
   * False reads status only while something listens to it; true by default, which starts the status watch when the
   * server becomes ready so the first client gets a payload at once.
   */
  statusAtBoot?: boolean;
  /** The Expo push API base URL; tests point it at a local server. */
  pushEndpoint?: string;
  pushLimits?: Partial<PushLimits>;
  /** How many offloaded builds run, and for how long; tests shorten them. */
  buildLimits?: Partial<BuildLimits>;
  deviceHostLimits?: Partial<DeviceHostLimits>;
  /** How often a device-host client connection is pinged, and how long it may stay silent before it is dropped. */
  clientHeartbeat?: { pingMs: number; silentMs: number };
  /** How often hosted sessions are checked for a client that is gone. */
  hostedIdleSweepMs?: number;
  hostedRelay?: HostedRelayOptions;
  service?: {
    label: string | null;
    node: string;
    script: string;
    runsAsService?: (label: string, port: number) => Promise<boolean>;
  };
  /** Looks up the worktrees' pull requests; tests replace GitHub. */
  pullRequests?: PushNotifierOptions['pullRequests'];
}

export interface ControlLimits {
  idleMs: number;
  renewMs: number;
  leaseFor: string;
  inputPerSecond: number;
  textCharsPerSecond: number;
  shapeChangesPerSecond: number;
  /** `sim-fold` waits up to 20 seconds for SpringBoard to finish the fold; Stim Desktop stops it after 40. */
  foldTimeoutMs: number;
}

export type ServerSocket = WebSocket | NoiseSocket;

export interface RequestLimits {
  connection: number;
  device: number;
}

export const trackers: WeakMap<ServerSocket, RequestTracker> = new WeakMap<ServerSocket, RequestTracker>();

export function send(socket: ServerSocket, message: ServerMessage | string): void {
  if (typeof message !== 'string') trackers.get(socket)?.reply(message);
  if (socket.readyState === socket.OPEN) socket.send(typeof message === 'string' ? message : JSON.stringify(message));
}

/** The state the handlers of one connection share: the closure variables of `startServer` and `connection`. */
export interface ConnectionContext {
  readonly options: ServerOptions;
  homeId: string | undefined;
  readonly hostHealth: () => Promise<HelloHost['app'] | undefined>;
  readonly statusFeed: StatusFeed;
  readonly viewsOf: (payload: JsonObject) => StatusViews;
  readonly currentStatus: () => Promise<{ payload: StatusPayload } | { failed: string }>;
  readonly hostsDevices: boolean;
  startup: StartupState;
  readonly readApprovals: () => Registries | null;
  readonly sessions: Map<ServerSocket, PairedDevice>;
  readonly sampler: UsageSampler;
  readonly usage: UsageRecorder;
  readonly recordUsage: () => () => void;
  readonly hostedDevices: DeviceHost;
  readonly control: ControlHub;
  readonly socket: ServerSocket;
  readonly local: boolean;
  readonly clientKey: string | null;
  readonly subscriptions: Map<string, () => void | Promise<void | ProtocolError>>;
  device: PairedDevice | null;
  desktopChallenge: { nonce: string; proof: string } | null;
  readonly tracker: RequestTracker;
  runId: string | null;
  clientPing: NodeJS.Timeout | undefined;
  readonly refuse: (id: RequestId | null, code: ErrorCode, message: string, closeCode: number) => void;
  readonly timer: NodeJS.Timeout;
  readonly error: (id: RequestId, code: ErrorCode, message: string) => void;
  readonly openSubscription: (id: RequestId, result?: { video?: VideoCodec }) => string | null;
  readonly addresses: { host: string; port: number }[];
}
