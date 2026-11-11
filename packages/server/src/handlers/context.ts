import {
  readMacosRecord,
  hostedIosPlacements,
  readWorkspaceState,
  hostedAndroidPlacements,
  type DeviceHostLimits,
  loadConfig,
  type StatusViews,
  type StatusPayload,
  type HostedAndroidPlacement,
  type HostedIosPlacement,
  type HostedMacosPlacement,
} from '@stim-cli/core/state';
import type { DesktopBootstrap } from '../desktop-bootstrap.ts';
import type { SetupDeps } from '../setup.ts';
import type { KeepAwakeOptions } from '../keep-awake.ts';
import type { Transport } from '@stim-cli/transport';
import type { TailscaleState, TailscaleMonitor } from '@stim-cli/transport-tailscale';
import type { Tailnet } from '../tailnet-helper.ts';
import type { RequestLog, RequestTracker } from '../request-log.ts';
import type { LogLimits } from '../logs.ts';
import { type CommandLimits, Pending } from '../stim-command.ts';
import { type FrameLimits, FramePool } from '../frames.ts';
import { type RecordLimits, Recorder } from '../recorder.ts';
import { type PushLimits, type PushNotifierOptions, PushNotifier } from '../push.ts';
import type { BuildLimits, BuildWorkerRoot } from '../build.ts';
import type { OffloadJobs } from '../offload-jobs.ts';
import { type HostedRelayOptions, HostedRelay } from '../hosted-relay.ts';
import type { WebSocket } from 'ws';
import { NoiseSocket } from '@stim-cli/core/noise-session';
import { StimError } from 'stim';
import { type AuditRecord, appendAudit } from '../actions.ts';
import type {
  ServerMessage,
  ErrorCode,
  FramesSeekParams,
  HelloHost,
  ProtocolError,
  RequestId,
  VideoCodec,
  Methods,
} from '../protocol.ts';
import { existsSync } from 'node:fs';
import { StatusFeed } from '../status-feed.ts';
import type { JsonObject } from '../feed.ts';
import type { StartupState } from '../startup.ts';
import type { Registries, PairedDevice } from '../registry.ts';
import { DesktopReports } from '../desktop-reports.ts';
import { UsageSampler } from '../machine.ts';
import { UsageRecorder } from '../usage-history.ts';
import { type Controller, ControlHub } from '../control.ts';
import { HostedPresence } from '../hosted-presence.ts';
import { HostedAgentHost } from '../agent-driver.ts';
import { DeviceHost } from '../device-host.ts';
import type { Duplex } from 'node:stream';
import type { Server, IncomingMessage, ServerResponse } from 'node:http';
import { PresenceHub } from '../presence.ts';
import { LocalAgentPresence } from '../local-agent-presence.ts';
import { HostedViews } from '../hosted-view.ts';
import { ShareHub } from '../share.ts';
import { MachineUpdates } from '../machine-update.ts';
import { EngineUpdates } from '../server-update.ts';
import { HostedPresenceBridge } from '../hosted-presence-bridge.ts';
import type { ServeRoute, DesktopPlanRefusal } from '@stim-cli/core/protocol';
import type { DesktopSetup } from '../desktop-setup.ts';
import type { MetroLink } from '@stim-cli/core';

export const INPUT_METHODS = [
  'input.touch',
  'input.text',
  'input.button',
  'input.rotate',
  'input.posture',
  'input.simulator',
  'input.scroll',
  'input.key',
  'input.window',
  'input.clipboard.set',
  'input.clipboard.get',
] as const;

export function viewHostedPlacement(
  dir: string,
  platform: string,
  slot: string | undefined,
  physical: unknown,
): HostedMacosPlacement | HostedIosPlacement | HostedAndroidPlacement | undefined {
  return (platform === 'ios' || platform === 'android') && physical === true
    ? undefined
    : hostedPlacement(dir, platform, slot);
}

function hostedPlacement(dir: string, platform: string, slot = 'default') {
  if (platform === 'macos') return readMacosRecord(dir)?.host;
  if (platform === 'ios') return hostedIosPlacements(readWorkspaceState(dir))[slot];
  if (platform === 'android') return hostedAndroidPlacements(readWorkspaceState(dir))[slot];
  return undefined;
}

export interface ServerOptions {
  /** Refuses offloaded jobs when the serving stimd is bound to a command. */
  attached?: boolean;
  /** The key in stimd's `run/desktop.key` that admits a local connection to the Desktop-only methods. */
  desktopBootstrap?: DesktopBootstrap;
  /** Asks stimd to check for a newer engine, as when a phone needs a newer one. */
  requestUpdate?: (why: string) => void;
  /** Who asked for this server, as `hello` reports it in `host.owner`; `service` with a service label, else `cli`. */
  owner?: 'desktop';
  /** What `stim setup` runs with when Stim Desktop approves a request here; `defaultSetupDeps` by default. */
  setupDeps?: () => SetupDeps;
  host?: { executable: string; name: string };
  /** The name clients show for this machine, or how to read it when the first client asks. */
  name: string | (() => Promise<string>);
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
  /** The tailnet loaded on demand; when set, `tailscale`, `tailscaleState` and `tailscaleMonitor` are not read. */
  tailnet?: Tailnet;
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
    /** How an `engine.update` starts its detached `engine-select`; the service manager's way by default. */
    detached?: (node: string, args: string[]) => { file: string; args: string[] };
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

export interface AgentLink {
  client: string;
  session: string;
  busy: number;
}

export interface RequestLimits {
  connection: number;
  device: number;
}

export const AUDIT_FIELD_CHARS = 256;

export function readFailure(cause: unknown): string {
  if (!(cause instanceof StimError)) return cause instanceof Error ? cause.message : String(cause);
  return `${cause.code}: ${cause.message}${cause.remedy ? ` ${cause.remedy}` : ''}`;
}

export function auditSafely(record: AuditRecord): void {
  try {
    appendAudit(record);
  } catch (cause) {
    console.error(`stim-server: could not append to the action log: ${(cause as Error).message}`);
  }
}

export const trackers: WeakMap<ServerSocket, RequestTracker> = new WeakMap<ServerSocket, RequestTracker>();

export function send(socket: ServerSocket, message: ServerMessage | string): void {
  if (typeof message !== 'string') trackers.get(socket)?.reply(message);
  if (socket.readyState === socket.OPEN) socket.send(typeof message === 'string' ? message : JSON.stringify(message));
}

type ResolvedWorkspace = { dir: string } | { code: ErrorCode; message: string };

export function registeredWorkspace(workspace: unknown): ResolvedWorkspace {
  if (typeof workspace !== 'string') {
    return { code: 'bad-request', message: 'params.workspace must be an environment path from a status payload.' };
  }
  let projects: Record<string, unknown>;
  try {
    projects = loadConfig()?.projects ?? {};
  } catch (cause) {
    return { code: 'stim-failed', message: (cause as Error).message };
  }
  const dir = Object.keys(projects).find((path) => path === workspace);
  if (dir === undefined)
    return { code: 'unknown-workspace', message: `${workspace} is not a Stim workspace on this machine.` };
  if (!existsSync(dir)) {
    return { code: 'unknown-workspace', message: `${dir} is registered but no longer exists on this machine.` };
  }
  return { dir };
}

export interface Replayable {
  seek: (at: number, rate: FramesSeekParams['rate']) => number | null;
  /** Returns why the subscription cannot go live, or null once it is live. */
  live: () => string | null;
}

/** The state the handlers of one connection share: the closure variables of `startServer` and `connection`. */
export interface ConnectionContext {
  readonly options: ServerOptions;
  readonly tailnet: Tailnet;
  readonly serverName: () => Promise<string>;
  homeId: string | undefined;
  readonly hostHealth: () => Promise<HelloHost['app'] | undefined>;
  readonly statusFeed: StatusFeed;
  readonly viewsOf: (payload: JsonObject) => StatusViews;
  readonly currentStatus: () => Promise<{ payload: StatusPayload } | { failed: string }>;
  readonly hostsDevices: boolean;
  readonly frameHelper: () => string | null;
  nativeViewerOpened: boolean;
  readonly frames: FramePool;
  recorder: Recorder | null;
  startup: StartupState;
  readonly readApprovals: () => Registries | null;
  readonly approved: () => Registries;
  readonly buildAllowed: (session: Pick<PairedDevice, 'id'>) => boolean;
  readonly running: Set<() => Promise<void>>;
  readonly cancelling: Pending;
  readonly logLimits: LogLimits;
  readonly commandLimits: CommandLimits;
  readonly actionLimits: CommandLimits;
  readonly busyWorkspaces: Set<string>;
  readonly retainedLifecycles: Set<() => void>;
  readonly planQueues: Map<string, Promise<void>>;
  readonly desktopReports: DesktopReports;
  recordingTurn: Promise<void>;
  closing: boolean;
  readonly sessions: Map<ServerSocket, PairedDevice>;
  readonly sampler: UsageSampler;
  readonly usage: UsageRecorder;
  readonly recordUsage: () => () => void;
  readonly controllers: Map<ServerSocket, Controller>;
  readonly controlLimits: ControlLimits;
  readonly adbEmulators: boolean;
  readonly hostedPresence: HostedPresence;
  readonly agentDrivers: HostedAgentHost;
  readonly hostedDevices: DeviceHost;
  readonly agentLinks: WeakMap<object, AgentLink>;
  readonly agentStreams: Map<string, Set<Duplex>>;
  readonly agentHttp: Server<typeof IncomingMessage, typeof ServerResponse>;
  readonly builds: BuildWorkerRoot;
  readonly jobs: OffloadJobs;
  readonly presence: PresenceHub;
  readonly localAgents: LocalAgentPresence;
  readonly control: ControlHub;
  readonly hostedViews: HostedViews;
  readonly shares: ShareHub;
  readonly machineUpdates: MachineUpdates;
  readonly updates: EngineUpdates;
  readonly push: PushNotifier;
  readonly desktopSessions: Set<ServerSocket>;
  readonly hostedBridge: HostedPresenceBridge;
  settingUpRoute: Promise<ServeRoute> | null;
  readonly socket: ServerSocket;
  readonly local: boolean;
  readonly clientKey: string | null;
  readonly keyless: boolean;
  readonly subscriptions: Map<string, () => void | Promise<void | ProtocolError>>;
  readonly setupRuns: Map<string, DesktopSetup>;
  readonly keyframes: Map<string, () => void>;
  readonly congestion: Map<string, () => void>;
  readonly replays: Map<string, Replayable>;
  keyframeReads: number;
  readonly holdSlot: (cancel: () => Promise<void>) => void;
  readonly releaseSlot: (cancel: () => Promise<void>) => void;
  readonly slotsFull: (needed?: number) => boolean;
  readonly slotsMessage: (needed?: number) => string;
  readonly planRequests: Map<string, { cancel: () => Promise<void>; refusal: () => DesktopPlanRefusal | undefined }>;
  readonly persistentActions: Set<() => Promise<void>>;
  device: PairedDevice | null;
  desktopChallenge: { nonce: string; proof: string } | null;
  readonly tracker: RequestTracker;
  runId: string | null;
  metroLink: MetroLink | null;
  metroStream: Duplex | null;
  metroPing: NodeJS.Timeout | undefined;
  clientPing: NodeJS.Timeout | undefined;
  readonly relay: HostedRelay;
  readonly refuse: (id: RequestId | null, code: ErrorCode, message: string, closeCode: number) => void;
  readonly timer: NodeJS.Timeout;
  readonly error: (id: RequestId, code: ErrorCode, message: string) => void;
  readonly canControl: (session: Pick<PairedDevice, 'id'>) => boolean;
  readonly inputs: { tokens: number; at: number };
  readonly characters: { tokens: number; at: number };
  readonly shapeChanges: { tokens: number; at: number };
  readonly controller: (session: Pick<PairedDevice, 'id' | 'name'>) => Controller;
  readonly workspaceDir: (id: RequestId, workspace: unknown, required: boolean) => string | null;
  readonly readDir: (id: RequestId, target: { workspace?: string; archive?: string }) => string | null;
  readonly openSubscription: (id: RequestId, result?: { video?: VideoCodec }) => string | null;
  readonly inProcessRead: <
    M extends
      | 'settings.get'
      | 'stats.get'
      | 'logs.query'
      | 'desktop.reports.get'
      | 'desktop.settings.get'
      | 'desktop.doctor.run'
      | 'build.plan'
      | 'desktop.plan.get',
  >(
    id: RequestId,
    label: string,
    read: (signal: AbortSignal) => Promise<Methods[M]['result']>,
    timeoutMs?: number,
    turn?: Promise<void> | null,
    report?: boolean,
  ) => { done: Promise<void>; cancel: () => Promise<void> } | null;
  readonly unsubscribeRequest: (id: RequestId, name: unknown) => Promise<void>;
  readonly addresses: { host: string; port: number }[];
}
