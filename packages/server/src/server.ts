import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync, rmSync, watch, type FSWatcher } from 'node:fs';
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { connect as connectSocket, isIP, type AddressInfo, type Socket } from 'node:net';
import { dirname, isAbsolute, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { WebSocketServer, type WebSocket } from 'ws';
import { configDir } from '@stim-cli/core';
import {
  archiveDir,
  serverLocalSocket,
  deviceHostArea,
  readArchive,
  readArchiveState,
  readBuildHistory,
  readSetupJournal,
  isJournalExpired,
  queryJsonLogs,
  isJsonObject,
  SETTING_SCOPES,
  settingsJsonSchema,
  settingDefinition,
  listSegments,
  listRecordedDevices,
  loadConfig,
  readMacosRecord,
  readWorkspaceState,
  hostedIosPlacements,
  hostedAndroidPlacements,
  RECORDING_PLATFORMS,
  stimBuildDigest,
  validRunId,
  type RecordingPlatform,
  type NdjsonRecord,
  type StatusPayload,
  type DeviceHostLimits,
  archivedUsage,
  KeyedEntities,
  statusViews,
  type ArchivedWorkspace,
  type StatusViews,
  type WorkspaceSummary,
  type WorktreeRow,
} from '@stim-cli/core/state';
import { createRequestLog, type RequestLog, type RequestTracker } from './request-log.ts';
import type { DesktopBootstrap } from './desktop-bootstrap.ts';
import { actionOutcome, appendAudit, loadAudit, parseAction, type AuditRecord } from './actions.ts';
import { parsePlatformRun } from './platform-run.ts';
import { parsePlatformBuild } from './platform-build.ts';
import { agentActionReaders, configuredAgentDriver, stoppingAgentDriver } from './agent-drivers.ts';
import { HostedAgentHost } from './agent-driver.ts';
import { DeviceHost } from './device-host.ts';
import { HostedViews } from './hosted-view.ts';
import { HostConnections, HostedRelay, type HostedRelayOptions } from './hosted-relay.ts';
import { LatestFrames, FRAME_RETRY_MS } from './frame-delivery.ts';
import { BuildHost, type BuildLimits, type BuildSession } from './build.ts';
import { ControlHub, parseControlBegin, parseInput, SLOT_NAME, type Controller } from './control.ts';
import { Recorder, type RecordLimits } from './recorder.ts';
import { pruneSetupJournals, setupJournalForClient } from './setup-journal.ts';
import {
  probeDirectories,
  STARTUP_PROBE_MS,
  STARTUP_RETRY_MS,
  type StartupCause,
  type StartupState,
} from './startup.ts';
import {
  claimRemoveCommand,
  exclusiveClaimDir,
  readClaimSet,
  releaseClaim,
  sharedClaimDir,
  tryAcquireClaim,
} from '@stim-cli/core/ownership-claim';
import { Player, recordedSpans, recordingDir, segmentKeyframe, timelineMarkers } from './replay.ts';
import { FeedPool, type JsonObject } from './feed.ts';
import { StatusFeed } from './status-feed.ts';
import { buildFoldHelper, buildFrameHelper, type FrameHint } from './frame-helper.ts';
import {
  DEFAULT_FRAME_LIMITS,
  deviceKey,
  FramePool,
  ownedDevice,
  type Device,
  type Frame,
  type FrameLimits,
} from './frames.ts';
import { archivedLogs, archivedTimeline, LogBatcher, parseLogFilter, readTargetError, type LogLimits } from './logs.ts';
import { readDiskVolumes, readMachineUsage, readMemoryPressure, UsageSampler } from './machine.ts';
import {
  BuildMachinesCache,
  doctorWorkspace,
  loadMachineDetails,
  MachineDetailsCache,
  type DetailsRead,
  type DoctorTarget,
} from './machine-details.ts';
import { UsageRecorder } from './usage-history.ts';
import { DesktopReports } from './desktop-reports.ts';
import {
  ACTIONS,
  BUILD_METHODS,
  DEVICE_HOST_METHODS,
  FEATURES,
  MAX_INPUT_TEXT,
  FRAME_EDGE,
  FRAME_FPS,
  LEGACY_PUSH_EVENTS,
  NOTIFICATION_LEVELS,
  PLATFORMS,
  PROTOCOL_VERSION,
  PUSH_EVENTS,
  PUSH_TOKEN_PATTERN,
  REPLAY_RATES,
  RELOAD_PLATFORMS,
  SERVER_UPDATE_METHODS,
  ARCHIVED_PAGE_LIMIT,
  type DesktopReportTarget,
  type ArchiveDetailResult,
  type DeviceFrameArtwork,
  type MacosWindow,
  type FramesSeekParams,
  type ErrorCode,
  type ProtocolError,
  type FrameTarget,
  type HelloResult,
  type Platform,
  type PlatformRunOptions,
  type PlatformBuildOptions,
  type Methods,
  type RequestId,
  type ServerMessage,
  type VideoCodec,
} from './protocol.ts';
import {
  createStim,
  StimError,
  type StimLogsOptions,
  type StimProgress,
  type StimPlanOptions,
  type StimReloadOptions,
  type StimStartOptions,
  type StimGcMutationOptions,
  type StimWorktreeRemoveOptions,
  type StimWorktreeWarmOptions,
  type StimClient,
  type StimStopOptions,
} from 'stim';
import { worktreePullRequests } from 'stim/pull-requests';
import { DEFAULT_STUCK_MINUTES } from '@stim-cli/core/oversight';
import { NotificationLog, notificationLogFile, publicEntry } from './notification-log.ts';
import { EXPO_PUSH_API, PushNotifier, type PushLimits, type PushNotifierOptions } from './push.ts';
import {
  buildClientsReadable,
  dropPushToken,
  parseLevels,
  parseQuietHours,
  pushEvents,
  readBuildClients,
  readDeviceHostClients,
  readDevices,
  recordsForKey,
  secretPsk,
  serverIdentity,
  setDevicePush,
  serverDir,
  spendSecret,
  touchDevice,
  type KeyRecords,
  type PairedDevice,
  validStuckMinutes,
} from './registry.ts';
import {
  acceptNoise,
  decodeSecret,
  HandshakeRefusal,
  CLOSE_REFUSED,
  MAX_CLIENT_MESSAGE_BYTES,
  MAX_FIRST_MESSAGE_BYTES,
  MODE_FIRST_CONTACT,
  NoiseSocket,
  TRANSPORT_OVERHEAD_BYTES,
} from '@stim-cli/core/noise-session';
import { readWorkspaceDiff } from './workspace-diff.ts';
import { ServerUpdates } from './server-update.ts';
import { MachineUpdates } from './machine-update.ts';
import { Pending, runStim, STDERR_TAIL, type CommandLimits, type CommandOutcome } from './stim-command.ts';
import { readHostPermissions } from './stim-host.ts';
import type { Transport, TransportIdentity } from '@stim-cli/transport';
import {
  isTailscaleTransport,
  tailscaleTransport,
  type TailscaleMonitor,
  type TailscaleState,
  type TailscaleTransport,
} from '@stim-cli/transport-tailscale';
import type { DesktopPlanRefusal, ServeRoute } from '@stim-cli/core/protocol';
import { DEFAULT_VIDEO_LIMITS, videoPacket, VideoGate, type AccessUnit } from './video.ts';
import { DeviceViewers } from './viewers.ts';

const INPUT_METHODS = [
  'input.touch',
  'input.text',
  'input.button',
  'input.rotate',
  'input.posture',
  'input.simulator',
  'input.scroll',
  'input.key',
  'input.window',
] as const;

function viewHostedPlacement(dir: string, platform: string, slot: string | undefined, physical: unknown) {
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
  /** Private bootstrap received from the Desktop parent; never a persisted pairing capability. */
  desktopBootstrap?: DesktopBootstrap;
  host?: { executable: string; name: string };
  name: string;
  hosts: string[];
  /**
   * Listens on `hosts` alone, never on a Tailscale address, and refuses every request that names a remote peer,
   * such as one forwarded by `tailscale serve` to a loopback port, so only this machine's own connections are served.
   */
  loopbackOnly?: boolean;
  /** Whether this machine can host simulators and apps for other machines; only a Mac can. Defaults to running on macOS. */
  hostsDevices?: boolean;
  port: number;
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
  /** Unauthenticated connections to a network address the server holds at once, overall and per source address. */
  pendingConnections?: { max: number; perPeer: number };
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
  /** The `sim-fold` helper that folds an iPhone Duo. Without it, the server builds one on the first fold. */
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

interface ControlLimits {
  idleMs: number;
  renewMs: number;
  leaseFor: string;
  inputPerSecond: number;
  textCharsPerSecond: number;
  shapeChangesPerSecond: number;
  /** `sim-fold` waits up to 20 seconds for SpringBoard to finish the fold; Stim Desktop stops it after 40. */
  foldTimeoutMs: number;
}

interface ServerHealth {
  host?: HelloResult['host'];
  startup: StartupState;
  server: 'stim-server';
  name: string;
  version: string;
  stim: string;
  /** The digest of the `stim` build this server runs, which offload compares between machines. */
  stimBuild: string | null;
  protocol: number;
  stimHome: string;
  /** The work a restart would cut off: offloaded builds and hosted sessions running now. */
  busy: { builds: number; hostedSessions: number };
  tailscale: { state: TailscaleState['state']; dnsName?: string | null; backendState?: string; reason?: string };
  route?: ServeRoute;
  nativeViewerOpened: boolean;
  /** Present and true when the server serves this machine only, so a paired phone or another machine cannot connect. */
  loopbackOnly?: true;
  /** The local network addresses the server listens on now, from `server.lanAddresses`; absent when there are none. */
  lan?: { addresses: string[]; port: number };
}

function healthTailscale(tailscale: TailscaleState): ServerHealth['tailscale'] {
  if (tailscale.state === 'running') return { state: 'running', dnsName: tailscale.dnsName };
  if (tailscale.state === 'not-running') return { state: 'not-running', backendState: tailscale.backendState };
  return { state: 'unavailable', reason: tailscale.reason };
}

/** Only a request made to this machine's loopback name, so a DNS-rebound web page cannot read the health payload. */
function localHealthRequest(request: IncomingMessage): boolean {
  const host = request.headers.host?.replace(/:\d+$/, '');
  return (
    request.method === 'GET' &&
    request.url === '/health' &&
    (host === '127.0.0.1' || host === 'localhost') &&
    peerAddress(request) === null
  );
}

export interface RunningServer {
  addresses: { host: string; port: number }[];
  /** The Unix socket this machine's own user connects on without Noise, or null when there is none. */
  localSocket: string | null;
  /** Settles once the first read of the Stim home finished: `ready`, or `degraded` while a read does not return. */
  ready: Promise<StartupState>;
  close: () => Promise<void>;
}

const CLOSE_BAD_REQUEST = 4400;
const LOCAL_DEVICE_ID = 'local';
const LOCAL_SOCKET_CLAIM_TRIES = 50;
/** A connection on the Unix socket: this server's own user, such as Stim Desktop, with every local capability. */
const LOCAL_DEVICE: PairedDevice = {
  id: LOCAL_DEVICE_ID,
  name: 'Stim Desktop',
  publicKey: '',
  pairedAt: new Date(0).toISOString(),
  lastSeenAt: null,
  capabilities: ['read', 'control'],
};

type ServerSocket = WebSocket | NoiseSocket;
const CLOSE_AUTH_TIMEOUT = 4408;
const CLOSE_ABNORMAL = 1006;
const MAX_PAYLOAD = 64 * 1024;
const MAX_SUBSCRIPTIONS = 32;

const archiveCursor = (archive: ArchivedWorkspace) => `${archive.removedAt}|${archive.id}`;

function lastCursor(page: readonly ArchivedWorkspace[]): string | null {
  const last = page.at(-1);
  return last ? archiveCursor(last) : null;
}
const STATUS_READ_WAIT_MS = 30_000;
interface RequestLimits {
  connection: number;
  device: number;
}
const REQUEST_LIMITS: RequestLimits = { connection: 32, device: 16 };
const MAX_REPORT_WAITS = 16;
const MAX_RETAINED_PLANS = 4;

function isWorkspaceChangeMethod(method: string): method is 'workspace.files' | 'workspace.diff' {
  return method === 'workspace.files' || method === 'workspace.diff';
}
const MAX_KEYFRAME_READS = 8;
const LOG_LIMITS: LogLimits = { maxBufferedBytes: 4 * 1024 * 1024, maxPendingRecords: 20_000 };
const HELPER_RETRY_MS = 5 * 60_000;
/**
 * Test switch: set to 1, a `physical` target may resolve to an emulator its workspace leases with `stim device
 * lock`, which then streams and takes input over adb as a phone does. It exists to exercise the physical-device
 * path without a phone.
 */
const ADB_EMULATORS_SWITCH = 'STIM_SERVER_TEST_ADB_EMULATORS';
const CONTROL_LIMITS: ControlLimits = {
  idleMs: 5 * 60_000,
  renewMs: 60_000,
  leaseFor: '2m',
  inputPerSecond: 120,
  textCharsPerSecond: 40,
  shapeChangesPerSecond: 2,
  foldTimeoutMs: 40_000,
};
const LOCK_LIMITS: CommandLimits = { timeoutMs: 30_000, maxOutputBytes: 64 * 1024 };
const pushToken = new RegExp(PUSH_TOKEN_PATTERN);

const HEALTH_ROUTE_TIMEOUT_MS = 1000;
const LISTEN_RETRY_MS = 5000;
const COMMAND_LIMITS: CommandLimits = { timeoutMs: 60_000, maxOutputBytes: 32 * 1024 * 1024 };
const PLAN_TIMEOUT_MS = 150_000;
const DETAILS_TIMEOUT_MS = 150_000;
const AUDIT_FIELD_CHARS = 256;
const ACTION_LIMITS: CommandLimits = { timeoutMs: 120_000, maxOutputBytes: 1024 * 1024 };

function readFailure(cause: unknown): string {
  if (!(cause instanceof StimError)) return cause instanceof Error ? cause.message : String(cause);
  return `${cause.code}: ${cause.message}${cause.remedy ? ` ${cause.remedy}` : ''}`;
}

type StopOutcome =
  | { ok: true; stdout: string; summary: string }
  | (Extract<CommandOutcome, { ok: false }> & { code?: string });

function stopAction(
  cwd: string,
  env: NodeJS.ProcessEnv,
  limits: CommandLimits,
  options: Pick<StimStopOptions, 'slot' | 'beforeStop'> & { onProgress?: (progress: StimProgress) => void } = {},
) {
  let root = realpathSync(cwd);
  if (!lstatSync(root).isDirectory()) throw new Error('The workspace is not a directory.');
  let stderr = '';
  const client = createStim({
    projectRoot: root,
    env,
    onProgress: ({ stream, message }) => {
      if (stream === 'stderr') stderr = (stderr + message).slice(-STDERR_TAIL);
      options.onProgress?.({ stream, message });
    },
  });
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<StopOutcome>((resolve) => {
    timer = setTimeout(() => {
      resolve({ ok: false, message: `stim stop did not finish within ${limits.timeoutMs / 1000} s.` });
      abort.abort();
    }, limits.timeoutMs);
  });
  const drained: Promise<StopOutcome> = Promise.resolve()
    .then(() =>
      client.stop({
        slot: options.slot,
        signal: abort.signal,
        beforeStop: (workspace) => {
          options.beforeStop?.(workspace);
          root = workspace;
        },
      }),
    )
    .then(
      (result): StopOutcome => {
        const stdout = JSON.stringify({ root, ok: result.ok, ...result.outcomes });
        if (Buffer.byteLength(stdout) > limits.maxOutputBytes)
          return { ok: false, message: `stim stop printed more than ${limits.maxOutputBytes} bytes.` };
        return result.ok
          ? { ok: true, stdout, summary: result.summary }
          : { ok: false, stdout, message: `${result.summary}${stderr.trim() ? `\n${stderr.trim()}` : ''}` };
      },
      (cause: unknown): StopOutcome => ({
        ok: false,
        message: readFailure(cause),
        ...(cause instanceof StimError ? { code: cause.code } : {}),
      }),
    )
    .finally(() => clearTimeout(timer));
  return {
    outcome: Promise.race([drained, deadline]),
    drained,
    cancel: async () => {
      abort.abort();
      await drained;
    },
  };
}

type ReloadOutcome = StopOutcome & { code?: string; unresolved?: boolean };

function reloadAction(
  cwd: string,
  env: NodeJS.ProcessEnv,
  limits: CommandLimits,
  options: Pick<StimReloadOptions, 'platform' | 'beforeReload'> & {
    onProgress?: (progress: StimProgress) => void;
  } = {},
) {
  const abort = new AbortController();
  let bytes = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<ReloadOutcome>((resolve) => {
    timer = setTimeout(() => {
      resolve({
        ok: false,
        code: 'STIM_RELOAD_TIMEOUT',
        message: `stim reload did not finish within ${limits.timeoutMs / 1000} s.`,
      });
      abort.abort();
    }, limits.timeoutMs);
  });
  const drained: Promise<ReloadOutcome> = Promise.resolve()
    .then(() =>
      createStim({
        projectRoot: cwd,
        env,
        onProgress: (progress) => {
          bytes += Buffer.byteLength(progress.message);
          if (bytes > limits.maxOutputBytes)
            throw new StimError({
              code: 'STIM_OUTPUT_LIMIT',
              message: `stim reload printed more than ${limits.maxOutputBytes} bytes.`,
            });
          options.onProgress?.(progress);
        },
      }).reload({ platform: options.platform, signal: abort.signal, beforeReload: options.beforeReload }),
    )
    .then(
      (result): ReloadOutcome => {
        const shared =
          result.strategy === 'metro-broadcast'
            ? ' The request was broadcast to all connected Metro clients.'
            : result.targets && result.targets > 1
              ? ` The request addressed ${result.targets} matching devices.`
              : '';
        return {
          ok: true,
          stdout: JSON.stringify(result),
          summary: `Reload requested for ${result.appId} via ${result.strategy}.${shared} Completion is not observed; verify the expected UI and run stim logs --errors.`,
        };
      },
      (cause: unknown): ReloadOutcome => ({
        ok: false,
        message: readFailure(cause),
        ...(cause instanceof StimError
          ? {
              code: cause.code,
              stdout: JSON.stringify({ code: cause.code, message: cause.message, remedy: cause.remedy }),
              unresolved: cause.code === 'STIM_CLAIM_UNAVAILABLE',
            }
          : {}),
      }),
    )
    .then((outcome): ReloadOutcome =>
      bytes + Buffer.byteLength(outcome.stdout ?? '') > limits.maxOutputBytes
        ? {
            ok: false,
            code: 'STIM_OUTPUT_LIMIT',
            unresolved: outcome.unresolved,
            message: `stim reload printed more than ${limits.maxOutputBytes} bytes.`,
          }
        : outcome,
    )
    .finally(() => clearTimeout(timer));
  return {
    outcome: Promise.race([drained, deadline]),
    drained,
    cancel: async () => {
      abort.abort();
      await drained;
    },
  };
}

type StartOutcome = StopOutcome & { code?: string; unresolved?: boolean; retainedClaimRoots?: string[] };

function lifecycleAction(
  cwd: string,
  env: NodeJS.ProcessEnv,
  limits: CommandLimits,
  label: string,
  timeoutCode: string,
  execute: (client: StimClient, signal: AbortSignal) => Promise<StopOutcome>,
  onProgress?: (progress: StimProgress) => void,
) {
  const abort = new AbortController();
  let bytes = 0;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    abort.abort();
  }, limits.timeoutMs);
  const drained: Promise<StartOutcome> = Promise.resolve()
    .then(() =>
      execute(
        createStim({
          projectRoot: cwd,
          env,
          onProgress: (progress) => {
            bytes += Buffer.byteLength(progress.message);
            if (bytes > limits.maxOutputBytes)
              throw new StimError({
                code: 'STIM_OUTPUT_LIMIT',
                message: `${label} printed more than ${limits.maxOutputBytes} bytes.`,
              });
            onProgress?.(progress);
          },
        }),
        abort.signal,
      ),
    )
    .then(
      (result): StartOutcome => result,
      (cause: unknown): StartOutcome => {
        const details = cause instanceof StimError && isJsonObject(cause.details) ? cause.details.cause : undefined;
        return {
          ok: false,
          message: readFailure(cause),
          ...(cause instanceof StimError
            ? {
                code: cause.code,
                stdout: JSON.stringify({ code: cause.code, message: cause.message, remedy: cause.remedy }),
                unresolved: cause.code === 'STIM_CLAIM_UNAVAILABLE',
                ...(isJsonObject(details) &&
                Array.isArray(details.retainedClaimRoots) &&
                details.retainedClaimRoots.every((root) => typeof root === 'string' && isAbsolute(root))
                  ? { retainedClaimRoots: details.retainedClaimRoots }
                  : {}),
              }
            : {}),
        };
      },
    )
    .then((outcome): StartOutcome =>
      !outcome.unresolved && bytes + Buffer.byteLength(outcome.stdout ?? '') > limits.maxOutputBytes
        ? {
            ok: false,
            code: 'STIM_OUTPUT_LIMIT',
            unresolved: outcome.unresolved,
            retainedClaimRoots: outcome.retainedClaimRoots,
            message: `${label} printed more than ${limits.maxOutputBytes} bytes.`,
          }
        : outcome,
    )
    .then((outcome): StartOutcome =>
      timedOut && !outcome.unresolved
        ? {
            ok: false,
            code: timeoutCode,
            message: `${label} did not finish within ${limits.timeoutMs / 1000} s.`,
          }
        : outcome,
    )
    .finally(() => clearTimeout(timer));
  return {
    outcome: drained,
    drained,
    cancel: async () => {
      abort.abort();
      return await drained;
    },
  };
}

function startAction(
  cwd: string,
  env: NodeJS.ProcessEnv,
  limits: CommandLimits,
  options: Pick<StimStartOptions, 'remote' | 'resetCache' | 'waitSeconds' | 'beforeStart'> & {
    onProgress?: (progress: StimProgress) => void;
  } = {},
) {
  return lifecycleAction(
    cwd,
    env,
    limits,
    'stim start',
    'STIM_METRO_TIMEOUT',
    async (client, signal) => {
      const result = await client.start({
        remote: options.remote,
        resetCache: options.resetCache,
        waitSeconds: options.waitSeconds,
        beforeStart: options.beforeStart,
        signal,
      });
      return {
        ok: true,
        stdout: JSON.stringify(result),
        summary: `Dev server ${result.alreadyRunning ? 'already running' : 'ready'} on port ${result.port}.`,
      };
    },
    options.onProgress,
  );
}

function platformRunAction(
  cwd: string,
  env: NodeJS.ProcessEnv,
  limits: CommandLimits,
  options: PlatformRunOptions,
  onProgress: (progress: StimProgress) => void,
) {
  return lifecycleAction(
    cwd,
    env,
    limits,
    `stim ${options.platform}`,
    'STIM_RUN_FAILED',
    async (client, signal) => {
      const result = await client.run({ ...options, signal });
      const summary =
        result.platform === 'web'
          ? `${result.facts.url} ${result.facts.launched === true ? 'loaded' : result.facts.launched}. ${
              result.facts.running
                ? 'Logs: stim logs --errors.'
                : 'The owned Chrome is no longer running. Run stim logs --errors, then stim web again.'
            }`
          : `${options.platform} run completed.`;
      return { ok: true, stdout: JSON.stringify(result), summary };
    },
    onProgress,
  );
}

function platformBuildAction(
  cwd: string,
  env: NodeJS.ProcessEnv,
  limits: CommandLimits,
  options: PlatformBuildOptions,
  onProgress: (progress: StimProgress) => void,
) {
  return lifecycleAction(
    cwd,
    env,
    limits,
    `${options.platform} build`,
    'STIM_BUILD_FAILED',
    async (client, signal) => {
      const result = await client.build({ ...options, signal });
      return { ok: true, stdout: JSON.stringify(result), summary: `${options.platform} build completed.` };
    },
    onProgress,
  );
}

function gcAction(
  cwd: string,
  env: NodeJS.ProcessEnv,
  limits: CommandLimits,
  options: Omit<StimGcMutationOptions, 'signal'>,
  onProgress: (progress: StimProgress) => void,
) {
  return lifecycleAction(
    cwd,
    env,
    limits,
    'stim gc',
    'STIM_GC_TIMEOUT',
    async (client, signal) => {
      const { report, exitCode } = await client.collectGarbage({ ...options, signal });
      const stdout = JSON.stringify(report);
      return exitCode === 0
        ? { ok: true, stdout, summary: 'Garbage collection completed.' }
        : { ok: false, stdout, code: 'STIM_GC_FAILED', message: 'Garbage collection reported failures.' };
    },
    onProgress,
  );
}

function machineAccessAction(
  cwd: string,
  env: NodeJS.ProcessEnv,
  limits: CommandLimits,
  ticket: string | undefined,
  onProgress: (progress: StimProgress) => void,
) {
  return lifecycleAction(
    cwd,
    env,
    limits,
    'Machine access request',
    'STIM_REPORT_TIMEOUT',
    async (client, signal) => ({
      ok: true,
      stdout: JSON.stringify(await client.requestMachineAccess({ ticket, signal })),
      summary: 'Machine access report completed.',
    }),
    onProgress,
  );
}

function worktreeWarmAction(
  cwd: string,
  env: NodeJS.ProcessEnv,
  limits: CommandLimits,
  options: Omit<StimWorktreeWarmOptions, 'signal'>,
  onProgress: (progress: StimProgress) => void,
) {
  return lifecycleAction(
    cwd,
    env,
    limits,
    'stim worktree warm',
    'STIM_WORKTREE_WARM_TIMEOUT',
    async (client, signal) => {
      const result = await client.warmWorktree({ ...options, signal });
      const stdout = JSON.stringify(result);
      return result.exitCode === 0
        ? { ok: true, stdout, summary: 'Worktree warming completed.' }
        : { ok: false, stdout, code: 'STIM_WORKTREE_WARM_FAILED', message: 'Worktree warming reported failures.' };
    },
    onProgress,
  );
}

function worktreeRemoveAction(
  cwd: string,
  env: NodeJS.ProcessEnv,
  limits: CommandLimits,
  options: Omit<StimWorktreeRemoveOptions, 'signal'>,
  onProgress: (progress: StimProgress) => void,
) {
  return lifecycleAction(
    cwd,
    env,
    limits,
    'stim worktree remove',
    'STIM_WORKTREE_REMOVE_TIMEOUT',
    async (client, signal) => {
      const result = await client.removeWorktree({ ...options, signal });
      const stdout = JSON.stringify(result);
      return result.exitCode === 0
        ? { ok: true, stdout, summary: 'Worktree cleanup completed.' }
        : { ok: false, stdout, code: 'STIM_WORKTREE_REMOVE_FAILED', message: 'Worktree cleanup reported failures.' };
    },
    onProgress,
  );
}

function isLoopback(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

/**
 * The tailnet address of the peer. `tailscale serve` proxies from loopback and names the peer in
 * X-Forwarded-For; a loopback connection without that header comes from this machine.
 */
function peerAddress(request: IncomingMessage): string | null {
  const remote = request.socket.remoteAddress;
  if (!isLoopback(remote)) return remote ?? null;
  const forwarded = request.headers['x-forwarded-for'];
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim();
  return first || null;
}

function peerLabel(identity: TransportIdentity | null): string | null {
  return identity ? `${identity.name || identity.id}${identity.user ? ` (${identity.user})` : ''}` : null;
}

const NO_TAILSCALE: TailscaleState = { state: 'unavailable', reason: 'the tailscale command was not found' };

function serverTransports(options: ServerOptions): { transports: Transport[]; tailscale: TailscaleTransport } {
  const given = options.transports?.find(isTailscaleTransport);
  const tailscale =
    given ??
    tailscaleTransport({
      env: options.env,
      snapshot: { binary: options.tailscale ?? null, state: options.tailscaleState ?? NO_TAILSCALE },
      monitor: options.tailscaleMonitor ?? null,
    });
  return { transports: options.transports ?? [tailscale], tailscale };
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * How a connection reached the server: from this machine on loopback, from a tailnet peer through `tailscale serve`
 * (loopback with `X-Forwarded-For`), or straight to one of the server's own network addresses.
 */
type Arrival = 'local' | 'proxied' | 'direct';

function arrival(request: IncomingMessage): Arrival {
  if (!isLoopback(request.socket.remoteAddress)) return 'direct';
  return peerAddress(request) === null ? 'local' : 'proxied';
}

/**
 * Whether a WebSocket upgrade comes from a web page. Browsers send `Sec-Fetch-Site` and the page's own `Origin`.
 * React Native derives `Origin` from the ws URL, so an app's `Origin` names the requested host: over `http:` on loopback
 * and on a local network address, and `https:` through `tailscale serve`. A DNS-rebound page names a host name, so on
 * loopback the host must be a loopback name and on a network address an IP literal. SocketRocket omits the brackets of
 * an IPv6 origin, so an iOS app on `ws://[::1]` is refused.
 */
export function upgradeFromWebPage(headers: IncomingHttpHeaders, via: Arrival): boolean {
  if (headers['sec-fetch-site'] !== undefined) return true;
  if (headers.origin === undefined) return false;
  const scheme = via === 'proxied' ? 'https:' : 'http:';
  try {
    const own = new URL(`${scheme}//${headers.host ?? ''}`);
    if (new URL(headers.origin).origin !== own.origin) return true;
    if (via === 'local') return !LOOPBACK_HOSTS.has(own.hostname);
    return via === 'direct' && isIP(own.hostname.replace(/^\[|\]$/g, '')) === 0;
  } catch {
    return true;
  }
}

const MAX_PENDING_CONNECTIONS = 64;
const MAX_PENDING_PER_PEER = 16;
const HEADERS_TIMEOUT_MS = 10_000;

/** How many peers a failure limiter remembers; past it, the peer seen longest ago is forgotten first. */
const MAX_LIMITED_PEERS = 4096;

class FailureLimiter {
  private readonly failures = new Map<string, number[]>();
  private readonly max: number;
  private readonly windowMs: number;

  constructor(max: number, windowMs: number) {
    this.max = max;
    this.windowMs = windowMs;
  }

  private recent(key: string, now: number): number[] {
    const kept = (this.failures.get(key) ?? []).filter((at) => now - at < this.windowMs);
    if (kept.length) this.failures.set(key, kept);
    else this.failures.delete(key);
    return kept;
  }

  blocked(key: string, now: number = Date.now()): boolean {
    return this.recent(key, now).length >= this.max;
  }

  record(key: string, now: number = Date.now()): void {
    const kept = this.recent(key, now);
    this.failures.delete(key);
    const oldest = this.failures.keys().next();
    if (this.failures.size >= MAX_LIMITED_PEERS && !oldest.done) this.failures.delete(oldest.value);
    this.failures.set(key, [...kept, now]);
  }
}

/**
 * Connections to a network address that have not authenticated yet, bounded overall and per source address, so a peer
 * on the local network cannot hold the server's sockets open without a key. Loopback connections, which include every
 * `tailscale serve` peer, are not counted.
 */
class PendingConnections {
  private readonly peers = new Map<Socket, string>();
  private readonly counts = new Map<string, number>();
  private readonly max: number;
  private readonly perPeer: number;

  constructor(max: number, perPeer: number) {
    this.max = max;
    this.perPeer = perPeer;
  }

  admit(socket: Socket): boolean {
    const peer = socket.remoteAddress ?? '';
    const count = this.counts.get(peer) ?? 0;
    if (this.peers.size >= this.max || count >= this.perPeer) return false;
    this.peers.set(socket, peer);
    this.counts.set(peer, count + 1);
    socket.once('close', () => this.settle(socket));
    return true;
  }

  /** The socket authenticated, or closed: it no longer counts. */
  settle(socket: Socket): void {
    const peer = this.peers.get(socket);
    if (peer === undefined) return;
    this.peers.delete(socket);
    const left = (this.counts.get(peer) ?? 1) - 1;
    if (left > 0) this.counts.set(peer, left);
    else this.counts.delete(peer);
  }
}

function auditSafely(record: AuditRecord): void {
  try {
    appendAudit(record);
  } catch (cause) {
    console.error(`stim-server: could not append to the action log: ${(cause as Error).message}`);
  }
}

function take(bucket: { tokens: number; at: number }, cost: number, perSecond: number, capacity: number): boolean {
  const now = Date.now();
  bucket.tokens = Math.min(capacity, bucket.tokens + ((now - bucket.at) / 1000) * perSecond);
  bucket.at = now;
  if (bucket.tokens < cost) return false;
  bucket.tokens -= cost;
  return true;
}

const trackers = new WeakMap<ServerSocket, RequestTracker>();

function send(socket: ServerSocket, message: ServerMessage | string): void {
  if (typeof message !== 'string') trackers.get(socket)?.reply(message);
  if (socket.readyState === socket.OPEN) socket.send(typeof message === 'string' ? message : JSON.stringify(message));
}

function buildAllowed(session: PairedDevice): boolean {
  return Boolean(
    readBuildClients()
      .find((entry) => entry.id === session.id)
      ?.capabilities.includes('build'),
  );
}

function requestId(value: unknown): RequestId | null {
  return typeof value === 'number' || typeof value === 'string' ? value : null;
}

function validPlanRequest(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

type ResolvedWorkspace = { dir: string } | { code: ErrorCode; message: string };

function registeredWorkspace(workspace: unknown): ResolvedWorkspace {
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

interface Replayable {
  seek: (at: number, rate: FramesSeekParams['rate']) => number | null;
  /** Returns why the subscription cannot go live, or null once it is live. */
  live: () => string | null;
}

/** `at` and `rate` of a seek, null when neither is given, or why they are refused. */
function parseReplay(at: unknown, rate: unknown): { at: number; rate: FramesSeekParams['rate'] } | string | null {
  if (at === undefined && rate === undefined) return null;
  if (typeof at !== 'number' || !Number.isFinite(at)) return 'at must be epoch milliseconds.';
  const parsed = rate === undefined ? 0 : rate;
  if (!REPLAY_RATES.includes(parsed as FramesSeekParams['rate'])) {
    return `rate must be one of ${REPLAY_RATES.join(', ')}.`;
  }
  return { at, rate: parsed as FramesSeekParams['rate'] };
}

function frameTargetError(target: JsonObject, hosted: boolean): string | null {
  const error = readTargetError(target);
  if (error) return error;
  const { archive, platform, slot, physical, at, deviceFrame, duoFrame } = target;
  if (archive !== undefined && (at === undefined || physical)) {
    return 'Archived frames require params.at and cannot be physical.';
  }
  if (!PLATFORMS.includes(platform as Platform)) {
    return 'frames.subscribe needs params.workspace or params.archive and params.platform (ios, android, web or macos).';
  }
  if (slot !== undefined && (typeof slot !== 'string' || !SLOT_NAME.test(slot))) {
    return 'slot must be 1-64 letters, digits, underscores or hyphens.';
  }
  if (physical !== undefined && typeof physical !== 'boolean') return 'physical must be true or false.';
  if (deviceFrame !== undefined && typeof deviceFrame !== 'boolean') return 'deviceFrame must be true or false.';
  if (
    duoFrame !== undefined &&
    (typeof duoFrame !== 'boolean' || (duoFrame && (platform !== 'ios' || physical || hosted)))
  ) {
    return 'duoFrame needs a local owned iOS simulator.';
  }
  return null;
}

function hasFootage(dir: string, closedOnly = false): boolean {
  return listSegments(dir, closedOnly).length > 0;
}

function doctorTarget(): DoctorTarget {
  try {
    return doctorWorkspace(loadConfig(), existsSync);
  } catch (cause) {
    return { error: (cause as Error).message };
  }
}

const closeListener = ({ server, sockets }: { server: Server; sockets: Set<Socket> }) =>
  new Promise((resolve) => {
    server.close(resolve);
    for (const socket of sockets) socket.destroy();
  });

function pruneSetup(): void {
  try {
    pruneSetupJournals();
  } catch (error) {
    console.error(`stim-server: could not prune setup journals: ${(error as Error).message}`);
  }
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return true;
  }
}

export async function startServer(options: ServerOptions): Promise<RunningServer> {
  const { transports, tailscale } = serverTransports(options);
  /** The tailnet node a transport reports for a peer, or null when none identifies it. */
  async function peerNode(request: IncomingMessage, address: string): Promise<string | null> {
    for (const transport of transports) {
      const identity = await transport.identify?.({ address, request }).catch(() => null);
      if (identity) return identity.id;
    }
    return null;
  }
  /**
   * The tailnet node each device-host client's latest authenticated connection came from. Its agent grant's bearer
   * token goes to a host name the client resolves, so the agent route also requires this node: a node that took the
   * name over cannot replay the token. It adds to the token; it never authenticates on its own.
   */
  const agentNodes = new Map<string, string>();
  /** Names a peer for people to read; never decides who a client is. */
  async function describePeer(request: IncomingMessage, address: string): Promise<string> {
    for (const transport of transports) {
      const label = peerLabel((await transport.identify?.({ address, request }).catch(() => null)) ?? null);
      if (label) return label;
    }
    return address;
  }
  let homeId: string | undefined;
  let hostProbe: Promise<HelloResult['host']> | undefined;
  let hostExpires = 0;
  const hostHealth = (): Promise<HelloResult['host']> => {
    if (!options.host) return Promise.resolve(undefined);
    if (!hostProbe || Date.now() >= hostExpires) {
      hostExpires = Infinity;
      hostProbe = readHostPermissions(options.host.executable).then((permissions) => {
        hostExpires = Date.now() + 5000;
        return permissions ? { name: options.host!.name, ...permissions } : null;
      });
    }
    return hostProbe;
  };
  const requestLog = options.requestLog ?? createRequestLog();
  const limiter = new FailureLimiter(options.maxAuthFailures ?? 5, options.failureWindowMs ?? 60_000);
  const authTimeoutMs = options.authTimeoutMs ?? 5000;
  const unauthenticated = new PendingConnections(
    options.pendingConnections?.max ?? MAX_PENDING_CONNECTIONS,
    options.pendingConnections?.perPeer ?? MAX_PENDING_PER_PEER,
  );
  const feeds = new FeedPool(options.stimCli, options.env);
  const statusFeed = new StatusFeed({
    worker: join(dirname(options.stimCli), 'status-worker.mjs'),
    env: options.env,
    cwd: homedir(),
  });
  const statusViewsCache = new WeakMap<JsonObject, StatusViews>();
  const viewsOf = (payload: JsonObject): StatusViews => {
    let views = statusViewsCache.get(payload);
    if (!views) {
      views = statusViews(payload as unknown as StatusPayload);
      statusViewsCache.set(payload, views);
    }
    return views;
  };
  const currentStatus = (): Promise<{ payload: StatusPayload } | { failed: string }> =>
    new Promise((resolve) => {
      let done = false;
      let unsubscribe: (() => void) | null = null;
      const finish = (answer: { payload: StatusPayload } | { failed: string }) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        unsubscribe?.();
        resolve(answer);
      };
      const timer = setTimeout(() => finish({ failed: 'stim status did not report in time.' }), STATUS_READ_WAIT_MS);
      unsubscribe = statusFeed.subscribe({
        item: (payload) => finish({ payload: payload as unknown as StatusPayload }),
        failed: (message) => finish({ failed: message }),
      });
      if (done) unsubscribe();
    });
  const frameLimits: FrameLimits = { ...DEFAULT_FRAME_LIMITS, ...options.frameLimits };
  let helperPath = options.frameHelper ?? null;
  let helperBuilding = false;
  let helperRetryAt = 0;
  const helperAbort = new AbortController();
  const buildHelper = () => {
    helperBuilding = true;
    void (async () => {
      try {
        helperPath = await buildFrameHelper(options.env, helperAbort.signal);
      } catch (cause) {
        helperRetryAt = Date.now() + HELPER_RETRY_MS;
        if (!helperAbort.signal.aborted) {
          console.error(`stim-server: frames come from screenshots: ${(cause as Error).message}`);
        }
      } finally {
        helperBuilding = false;
      }
    })();
  };
  const frameHelper = () => {
    if (options.frameHelper === undefined && !helperPath && !helperBuilding && Date.now() >= helperRetryAt) {
      buildHelper();
    }
    return helperPath;
  };
  let nativeViewerOpened = false;
  const helperEnv = options.host ? { ...options.env, STIM_CAPTURE_HOST: options.host.name } : options.env;
  const frames = new FramePool(helperEnv, frameLimits, frameHelper, new DeviceViewers());
  let recorder: Recorder | null = null;
  let startup: StartupState = { state: 'pending' };
  let startupProbe: ReturnType<typeof probeDirectories> | null = null;
  let startupRetry: NodeJS.Timeout | null = null;
  let setupPruneTimer: NodeJS.Timeout | null = null;
  let foldBuild: Promise<string> | null = null;
  const foldHelper = () => {
    if (options.foldHelper !== undefined) return Promise.resolve(options.foldHelper);
    foldBuild ??= buildFoldHelper(options.env, helperAbort.signal).catch((cause: Error) => {
      foldBuild = null;
      throw new Error(`sim-fold could not be built: ${cause.message}`);
    });
    return foldBuild;
  };
  const running = new Set<() => Promise<void>>();
  const peerCommands = new Map<string, number>();
  const requestLimits: RequestLimits = { ...REQUEST_LIMITS, ...options.requestLimits };
  const cancelling = new Pending();
  const logLimits: LogLimits = { ...LOG_LIMITS, ...options.logLimits };
  const commandLimits: CommandLimits = { ...COMMAND_LIMITS, ...options.commandLimits };
  const actionLimits: CommandLimits = { ...ACTION_LIMITS, ...options.actionLimits };
  const busyWorkspaces = new Set<string>();
  const retainedLifecycles = new Set<() => void>();
  const planQueues = new Map<string, Promise<void>>();
  const readDetailsReport = (
    method: 'stats' | 'gc' | 'doctor',
    cwd = homedir(),
    platform?: 'ios' | 'android',
    signal?: AbortSignal,
  ): Promise<DetailsRead> => {
    const abort = new AbortController();
    if (signal?.aborted) abort.abort();
    else signal?.addEventListener('abort', () => abort.abort(), { once: true });
    const timeoutMs = options.commandLimits?.timeoutMs ?? DETAILS_TIMEOUT_MS;
    let task: Promise<DetailsRead>;
    const cancel = async () => {
      abort.abort();
      await task;
    };
    const deadline = setTimeout(() => abort.abort(), timeoutMs);
    task = Promise.resolve()
      .then(async () => {
        const stim = createStim({ projectRoot: cwd, env: options.env });
        if (method === 'doctor') return await stim.doctor({ signal: abort.signal, platform });
        return method === 'gc'
          ? await stim.gc({ signal: abort.signal, measureBuildState: false })
          : await stim.stats({ signal: abort.signal });
      })
      .then(
        (report): DetailsRead => {
          if (method !== 'stats' && Buffer.byteLength(JSON.stringify(report)) > commandLimits.maxOutputBytes)
            return { ok: false, message: `stim ${method} printed more than ${commandLimits.maxOutputBytes} bytes.` };
          return { ok: true, report: { ...report } };
        },
        (cause: unknown): DetailsRead => ({
          ok: false,
          message:
            abort.signal.aborted && !(cause instanceof StimError && cause.code === 'STIM_CLAIM_UNAVAILABLE')
              ? `stim ${method} did not finish within ${timeoutMs / 1000} s.`
              : readFailure(cause),
        }),
      )
      .finally(() => {
        clearTimeout(deadline);
        running.delete(cancel);
      });
    running.add(cancel);
    return task;
  };
  const desktopReports = new DesktopReports((target, signal) =>
    readDetailsReport(
      target.report,
      target.report === 'doctor' ? target.cwd : undefined,
      target.report === 'doctor' ? target.platform : undefined,
      signal,
    ),
  );
  const machineDetails = new MachineDetailsCache(() =>
    loadMachineDetails(
      () => readDetailsReport('gc'),
      loadAudit,
      () => readDetailsReport('stats'),
    ),
  );
  const buildMachines = new BuildMachinesCache();
  let recordingTurn: Promise<void> = Promise.resolve();
  let closing = false;
  const sessions = new Map<ServerSocket, PairedDevice>();
  const listeners = new Set<ServerSocket>();
  const sampler = new UsageSampler();
  const usage = new UsageRecorder();
  let recorders = 0;
  let stopRecording: (() => void) | null = null;
  const recordUsage = (): (() => void) => {
    recorders += 1;
    stopRecording ??= statusFeed.subscribe({
      item: (payload) => usage.record(payload as unknown as StatusPayload),
      failed: () => {
        stopRecording = null;
      },
    });
    let released = false;
    return () => {
      if (released) return;
      released = true;
      recorders -= 1;
      if (recorders > 0) return;
      stopRecording?.();
      stopRecording = null;
      usage.pause();
    };
  };
  const controllers = new Map<ServerSocket, Controller>();
  const controlLimits: ControlLimits = { ...CONTROL_LIMITS, ...options.controlLimits };
  const adbEmulators = options.env[ADB_EMULATORS_SWITCH] === '1';
  const agentDrivers = new HostedAgentHost({
    resolve: () => configuredAgentDriver(loadConfig()?.hosting?.agentDriver, options.env, serverDir()),
    resolveDevice: (app, stopping) =>
      (stopping ? stoppingAgentDriver : configuredAgentDriver)(
        loadConfig()?.hosting?.agentDriver,
        options.env,
        deviceHostArea(app.session),
        app,
      ),
    approved: (client, node) =>
      node !== null &&
      agentNodes.get(client) === node &&
      readDeviceHostClients().some((entry) => entry.id === client && entry.capabilities.includes('device-host')),
  });
  const hostedDevices = new DeviceHost({
    worker: join(dirname(options.stimCli), 'device-host-worker.mjs'),
    env: options.env,
    agents: agentDrivers,
    limits: options.deviceHostLimits,
    allowed: (client) =>
      readDeviceHostClients().some((entry) => entry.id === client && entry.capabilities.includes('device-host')),
    builtBundle: (client, handoff, sha256) => {
      const host = readDeviceHostClients().find(
        (entry) => entry.id === client && entry.capabilities.includes('device-host'),
      )?.publicKey;
      return builds.takeBundle(handoff, sha256, (builder) => {
        const build = readBuildClients().find(
          (entry) => entry.id === builder && entry.capabilities.includes('build'),
        )?.publicKey;
        return host !== undefined && host === build;
      });
    },
  });
  const agentLimiter = new FailureLimiter(30, options.failureWindowMs ?? 60_000);
  async function answerAgent(request: IncomingMessage, response: ServerResponse, session: string): Promise<void> {
    const peer = peerAddress(request) ?? 'local';
    const refuse = (status: number, text: string) =>
      void response.writeHead(status, { 'content-type': 'text/plain' }).end(`${text}\n`);
    if (request.headers.origin !== undefined || request.headers['sec-fetch-site'] !== undefined)
      return refuse(403, 'Forbidden.');
    if (agentLimiter.blocked(peer)) return refuse(429, 'Too many attempts. Try again in a minute.');
    const bearer = /^bearer (.+)$/i.exec(request.headers.authorization ?? '')?.[1];
    const header = request.headers['x-agent-device-token'];
    const token = bearer ?? (typeof header === 'string' ? header : null);
    const node = peer === 'local' ? null : await peerNode(request, peer);
    if (agentDrivers.forward(session, token, request, response, node) === 'forbidden') agentLimiter.record(peer);
  }
  const setupLimiter = new FailureLimiter(30, options.failureWindowMs ?? 60_000);
  /** The journal holds no secret, so it is served to whoever names it; failures are rate limited by peer. */
  function answerSetup(request: IncomingMessage, response: ServerResponse): void {
    const refuse = (status = 404, text = 'Not found.') =>
      void response.writeHead(status, { 'content-type': 'text/plain', 'cache-control': 'no-store' }).end(`${text}\n`);
    const peer = peerAddress(request) ?? 'local';
    const match = /^\/setup\/([a-f0-9]{64})$/.exec(request.url ?? '');
    if (
      request.method !== 'GET' ||
      !match ||
      match[0] !== request.url ||
      request.headers.origin !== undefined ||
      request.headers['sec-fetch-site'] !== undefined
    )
      return refuse();
    if (startup.state !== 'ready') return refuse(503, 'stim-server is not ready.');
    if (setupLimiter.blocked(peer)) return refuse(429, 'Too many attempts. Try again in a minute.');
    const journal = readSetupJournal(match[1]!);
    if (!journal || isJournalExpired(journal)) {
      setupLimiter.record(peer);
      return refuse();
    }
    response
      .writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      .end(JSON.stringify(setupJournalForClient(journal)));
  }
  const builds = new BuildHost({
    worker: join(dirname(options.stimCli), 'offload-worker.mjs'),
    env: options.env,
    currentEnv: options.currentEnv,
    limits: options.buildLimits,
    ready: () => startup.state === 'ready',
    finished: ({ client, repo, ok, error, durationMs }) =>
      auditSafely({
        at: new Date().toISOString(),
        device: { id: client, name: readBuildClients().find((each) => each.id === client)?.name ?? client },
        action: 'build',
        workspace: repo,
        ok,
        ...(error ? { error } : {}),
        durationMs,
      }),
    allowed: (client) => readBuildClients().some((each) => each.id === client && each.capabilities.includes('build')),
  });
  const control = new ControlHub({
    env: options.env,
    stimCli: options.stimCli,
    frames,
    subscribeStatus: (listener) => statusFeed.subscribe(listener),
    audit: auditSafely,
    lockLimits: LOCK_LIMITS,
    idleMs: controlLimits.idleMs,
    renewMs: controlLimits.renewMs,
    leaseFor: controlLimits.leaseFor,
    foldHelper,
    frameHelper,
    foldTimeoutMs: controlLimits.foldTimeoutMs,
    conflict: (deviceId, conflict) => push.control(deviceId, conflict),
    adbEmulators,
  });
  const hostedViews = new HostedViews(hostedDevices, control, helperEnv, frameHelper);
  const ownStimBuild = stimBuildDigest(dirname(options.stimCli));
  const machineUpdates = new MachineUpdates({
    version: options.serverVersion,
    serverDir: dirname(dirname(options.service?.script || fileURLToPath(import.meta.url))),
    status: () => tailscale.rawStatus(),
    endpoint: options.hostedRelay?.endpoint,
  });
  const updates = new ServerUpdates({
    label: options.service?.label ?? null,
    port: options.port,
    build: { version: options.serverVersion, stimBuild: ownStimBuild },
    node: options.service?.node ?? process.execPath,
    script: options.service?.script ?? '',
    env: process.env,
    runsAsService: options.service?.runsAsService,
    acceptsClientBuilds: () => loadConfig()?.server?.acceptClientBuilds === true,
    drain: (reason) => {
      builds.drain(reason);
      hostedDevices.drain(reason);
    },
    audit: ({ by, target, phase, ok, message }) =>
      auditSafely({
        at: new Date().toISOString(),
        device: by,
        action: `server.update.${phase}`,
        workspace: target,
        ok,
        ...(ok ? {} : { error: { code: 'action-failed', message: message.slice(0, AUDIT_FIELD_CHARS) } }),
      }),
  });
  let serverKey: ReturnType<typeof serverIdentity> | null = null;
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: Math.max(MAX_FIRST_MESSAGE_BYTES, MAX_CLIENT_MESSAGE_BYTES + TRANSPORT_OVERHEAD_BYTES),
  });
  const localWss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });
  const notificationLog = new NotificationLog(notificationLogFile(serverDir()));
  const push = new PushNotifier({
    name: options.name,
    endpoint: options.pushEndpoint ?? EXPO_PUSH_API,
    subscribeStatus: (listener) => statusFeed.subscribe(listener),
    readVolumes: readDiskVolumes,
    readPressure: readMemoryPressure,
    pullRequests: options.pullRequests ?? ((worktrees) => worktreePullRequests()(worktrees)),
    ownLeases: () => control.ownLeaseTimes(),
    devices: readDevices,
    dropToken: dropPushToken,
    log: notificationLog,
    whilePaired: options.history ?? true,
    logged: (entries) => {
      for (const socket of listeners) {
        const device = sessions.get(socket);
        for (const entry of entries) {
          if (!device || (entry.device !== undefined && entry.device !== device.id)) continue;
          send(socket, { event: 'notification', log: notificationLog.id, notification: publicEntry(entry) });
        }
      }
    },
    limits: options.pushLimits,
  });

  const relays = new Map<ServerSocket, HostedRelay>();
  /** Local-socket connections that proved the private bootstrap key of the bundled Desktop that started this server. */
  const desktopSessions = new Set<ServerSocket>();
  const hostConnections = new HostConnections(
    {
      ...(options.hostedRelay ?? { status: () => tailscale.rawStatus() }),
      log: requestLog.host,
    },
    options.serverVersion,
  );
  let revocationCheck: NodeJS.Timeout | null = null;
  let checkedRegistry: string | null = null;
  const checkRevocations = () => {
    const devices = [...readDevices(), ...readBuildClients(), ...readDeviceHostClients()];
    const registry = JSON.stringify(devices);
    if (registry === checkedRegistry) return;
    checkedRegistry = registry;
    const paired = new Map(devices.map((device) => [device.id, device]));
    push.refresh();
    for (const [socket, device] of sessions) {
      if (device.id !== LOCAL_DEVICE_ID && !paired.has(device.id)) socket.close(CLOSE_REFUSED, 'unauthorized');
    }
    hostedDevices.revoke();
    builds.abandonDetached(
      (client) => paired.get(client)?.capabilities.includes('build') ?? false,
      buildClientsReadable(),
    );
    void builds.sweepDaemons();
    for (const [socket, controller] of controllers) {
      if (controller.device.id === LOCAL_DEVICE_ID) continue;
      const capabilities = paired.get(controller.device.id)?.capabilities;
      if (!capabilities?.includes('control') && !capabilities?.includes('device-host')) {
        control.endFor(controller, 'forbidden', 'This device can no longer control devices.');
        relays.get(socket)?.endControls();
        controllers.delete(socket);
      }
    }
  };
  let watcher: FSWatcher | null = null;
  let revocationPoll: NodeJS.Timeout | null = null;
  let retireOnce: Promise<void> | undefined;
  const becomeReady = () => {
    mkdirSync(serverDir(), { recursive: true, mode: 0o700 });
    watcher ??= watch(serverDir(), () => {
      revocationCheck ??= setTimeout(() => {
        revocationCheck = null;
        checkRevocations();
      }, 50);
    });
    // Node's macOS watcher can miss changes before it is ready: https://github.com/nodejs/node/issues/52601.
    revocationPoll ??= setInterval(checkRevocations, 1000).unref();
    push.refresh();
    retireOnce ??= hostedDevices.reconcileStopped().catch((error: unknown) => {
      process.stderr.write(`Hosted device retirement failed: ${(error as Error).message}\n`);
    });
    if (options.frameHelper === undefined && !helperPath && !helperBuilding) buildHelper();
    if (options.statusAtBoot !== false) statusFeed.hold();
    if (options.record !== false) {
      recorder ??= new Recorder({
        frames,
        subscribeStatus: (listener) => statusFeed.subscribe(listener),
        limits: options.recordLimits,
      });
    }
  };

  let settingUpRoute: Promise<ServeRoute> | null = null;

  /**
   * One client connection. `local` is the Unix socket, where the kernel admits only this server's own user; every
   * other connection authenticated with Noise as `clientKey`, whose records `hello` reads again so a revocation that
   * lands after the handshake still counts.
   */
  function connection(socket: ServerSocket, peer: string | null, local: boolean, clientKey: string | null): void {
    const limitKey = peer ?? 'local';
    const subscriptions = new Map<string, () => void | Promise<void | ProtocolError>>();
    const keyframes = new Map<string, () => void>();
    const congestion = new Map<string, () => void>();
    const replays = new Map<string, Replayable>();
    let keyframeReads = 0;
    const commands = new Set<() => Promise<void>>();
    const reportWaits = new Set<() => Promise<void>>();
    const holdSlot = (cancel: () => Promise<void>) => {
      commands.add(cancel);
      if (peer !== null) peerCommands.set(peer, (peerCommands.get(peer) ?? 0) + 1);
    };
    const releaseSlot = (cancel: () => Promise<void>) => {
      if (!commands.delete(cancel) || peer === null) return;
      const left = (peerCommands.get(peer) ?? 1) - 1;
      if (left > 0) peerCommands.set(peer, left);
      else peerCommands.delete(peer);
    };
    const slotsFull = (needed = 1) =>
      commands.size + needed > requestLimits.connection ||
      (peer !== null && (peerCommands.get(peer) ?? 0) + needed > requestLimits.device);
    const slotsMessage = (needed = 1) =>
      peer !== null && commands.size + needed <= requestLimits.connection
        ? `A remote device can run ${requestLimits.device} requests at a time.`
        : `A connection can run ${requestLimits.connection} requests at a time.`;
    const planRequests = new Map<
      string,
      { cancel: () => Promise<void>; refusal: () => DesktopPlanRefusal | undefined }
    >();
    const persistentActions = new Set<() => Promise<void>>();
    let nextSubscription = 1;
    let device: PairedDevice | null = null;
    let desktopChallenge: { nonce: string; proof: string } | null = null;
    const tracker = requestLog.track();
    trackers.set(socket, tracker);
    let runId: string | null = null;
    let buildSession: BuildSession | null = null;
    let queue = Promise.resolve();
    let archiveReads = Promise.resolve();
    const relay = new HostedRelay(
      hostConnections,
      (message) => {
        if (Buffer.isBuffer(message)) {
          if (socket.readyState === socket.OPEN) socket.send(message);
        } else send(socket, message);
      },
      () => socket.bufferedAmount,
      openSubscription,
      (subscription) => subscriptions.delete(subscription),
      auditSafely,
    );
    relays.set(socket, relay);

    const refuse = (id: RequestId | null, code: ErrorCode, message: string, closeCode: number) => {
      if (!device) limiter.record(limitKey);
      send(socket, { id, error: { code, message } });
      socket.close(closeCode, code);
    };
    const timer = setTimeout(() => {
      limiter.record(limitKey);
      socket.close(CLOSE_AUTH_TIMEOUT, 'authentication timeout');
    }, authTimeoutMs);

    async function hello(id: RequestId, params: unknown): Promise<void> {
      if (device)
        return send(socket, { id, error: { code: 'already-authenticated', message: 'hello was already accepted.' } });
      if (!isJsonObject(params) || !isJsonObject(params.client)) {
        return refuse(id, 'bad-request', 'hello needs params.client.', CLOSE_BAD_REQUEST);
      }
      const access = params.access;
      if (access !== undefined && access !== 'build' && access !== 'device-host') {
        return refuse(id, 'bad-request', 'params.access is build or device-host.', CLOSE_BAD_REQUEST);
      }
      if (access === 'device-host' && !(options.hostsDevices ?? process.platform === 'darwin')) {
        return refuse(
          id,
          'forbidden',
          'Hosting simulators needs a Mac. This machine takes build requests only.',
          CLOSE_REFUSED,
        );
      }
      clearTimeout(timer);
      runId = validRunId(params.client.runId);
      tracker.identify({ id: null, runId });
      const probing = hostHealth();
      const name = typeof params.client.name === 'string' ? params.client.name.slice(0, 64) : 'Stim Desktop';
      const keyRecords = clientKey === null ? {} : recordsForKey(clientKey);
      const chosen = local ? { ...LOCAL_DEVICE, name } : access === undefined ? keyRecords.device : keyRecords[access];
      if (!chosen) {
        return refuse(
          id,
          access === undefined ? 'unauthorized' : 'forbidden',
          access === undefined
            ? 'This machine has no pairing for this client. Pair again.'
            : `This machine has not approved this client for ${access}. Approve it with \`stim-server setup\` there.`,
          CLOSE_REFUSED,
        );
      }
      device = chosen;
      if (!local) touchDevice(device.id);
      if (local && params.desktopBootstrap === true) desktopChallenge = options.desktopBootstrap?.challenge() ?? null;
      tracker.identify({ id: device.id, runId });
      sessions.set(socket, device);
      sampler.start();
      const probeWaited = Date.now();
      const host = options.host ? await probing : undefined;
      if (options.host) tracker.step(id, 'probe', Date.now() - probeWaited);
      const result: HelloResult = {
        protocol: PROTOCOL_VERSION,
        server: {
          name: options.name,
          version: options.serverVersion,
          stim: options.stimVersion,
          home: homedir(),
          id: homeId,
          ...(local && addresses[0] ? { port: addresses[0].port } : {}),
        },
        ...(options.host ? { host } : {}),
        capabilities: device.capabilities,
        features: FEATURES.filter(
          (feature) =>
            (![
              'desktop-settings-write',
              'desktop-reload',
              'desktop-start',
              'desktop-run',
              'desktop-build',
              'desktop-gc',
              'desktop-worktree-remove',
              'desktop-worktree-warm',
              'desktop-machine-access',
              'desktop-plan',
            ].includes(feature) ||
              options.desktopBootstrap !== undefined) &&
            (local ||
              ![
                'desktop-plan',
                'desktop-reports',
                'desktop-report-platform',
                'desktop-report-invalidate-target',
                'desktop-settings',
                'desktop-settings-schema',
                'desktop-settings-write',
                'desktop-full-logs',
                'desktop-doctor-run',
                'desktop-stop',
                'desktop-reload',
                'desktop-start',
                'desktop-run',
                'desktop-build',
                'desktop-gc',
                'desktop-worktree-remove',
                'desktop-worktree-warm',
                'desktop-machine-access',
              ].includes(feature)),
        ),
        actions: device.capabilities.includes('control') ? [...ACTIONS] : [],
        device: { id: device.id, name: device.name },
        ...(desktopChallenge ? { desktopBootstrap: desktopChallenge } : {}),
      };
      send(socket, { id, result });
    }

    function error(id: RequestId, code: ErrorCode, message: string): void {
      send(socket, { id, error: { code, message } });
    }

    /** Control is re-read from the record each time, so a revoked grant stops at once; the local socket always has it. */
    const canControl = (session: Pick<PairedDevice, 'id'>) =>
      local || readDevices().some((entry) => entry.id === session.id && entry.capabilities.includes('control'));

    const inputs = { tokens: controlLimits.inputPerSecond, at: Date.now() };
    const characters = { tokens: MAX_INPUT_TEXT, at: Date.now() };
    const shapeChanges = { tokens: controlLimits.shapeChangesPerSecond, at: Date.now() };

    function controller(session: Pick<PairedDevice, 'id' | 'name'>): Controller {
      let found = controllers.get(socket);
      if (!found) {
        found = { device: session, send: (message) => send(socket, message) };
        controllers.set(socket, found);
      }
      return found;
    }

    async function beginControl(id: RequestId, params: unknown, session: PairedDevice): Promise<void> {
      const raw = isJsonObject(params) ? params : {};
      const clip = (value: unknown) => (typeof value === 'string' ? value.slice(0, AUDIT_FIELD_CHARS) : null);
      const refuseControl = (code: ErrorCode, message: string) => {
        auditSafely({
          at: new Date().toISOString(),
          device: { id: session.id, name: session.name },
          action: raw.takeOver === true ? 'control.take-over' : 'control.begin',
          workspace: clip(raw.workspace),
          ...(typeof raw.platform === 'string' ? { platform: clip(raw.platform)! } : {}),
          ...(raw.platform === 'ios' || raw.platform === 'android'
            ? { slot: typeof raw.slot === 'string' ? clip(raw.slot)! : 'default' }
            : {}),
          ok: false,
          error: { code, message: clip(message)! },
        });
        error(id, code, message);
      };
      if (!canControl(session)) {
        return refuseControl(
          'forbidden',
          `This device can only read. On the machine, run \`stim-server devices grant ${session.id} --control\` to let it control devices.`,
        );
      }
      const parsed = parseControlBegin(params);
      if ('code' in parsed) return refuseControl(parsed.code, parsed.message);
      const resolved = registeredWorkspace(parsed.value.workspace);
      if ('code' in resolved) return refuseControl(resolved.code, resolved.message);
      const host = viewHostedPlacement(resolved.dir, parsed.value.platform, parsed.value.slot, parsed.value.physical);
      const owner = controller(session);
      if (host) {
        if (
          parsed.value.physical ||
          (parsed.value.platform === 'macos' && parsed.value.slot !== undefined && parsed.value.slot !== 'default')
        ) {
          return refuseControl(
            'bad-request',
            parsed.value.platform === 'ios'
              ? 'Hosted iOS control requires a non-physical target.'
              : parsed.value.platform === 'android'
                ? 'Hosted Android control requires a non-physical target.'
                : 'Hosted macOS control requires the default, non-physical target.',
          );
        }
        return relay.begin(
          id,
          host,
          parsed.value.takeOver === true,
          () => socket.readyState === socket.OPEN && controllers.get(socket) === owner && canControl(session),
          {
            workspace: resolved.dir,
            device: { id: session.id, name: session.name },
            platform: parsed.value.platform as 'ios' | 'android' | 'macos',
            slot: parsed.value.slot,
          },
        );
      }
      const outcome = await control.begin(
        owner,
        { ...parsed.value, workspace: resolved.dir },
        resolved.dir,
        () => socket.readyState === socket.OPEN && controllers.get(socket) === owner && canControl(session),
      );
      if ('code' in outcome) return refuseControl(outcome.code, outcome.message);
      send(socket, { id, result: outcome });
    }

    async function input(
      id: RequestId,
      method: (typeof INPUT_METHODS)[number],
      params: unknown,
      session: Pick<PairedDevice, 'id' | 'name'>,
    ): Promise<void> {
      const owner = controller(session);
      const parsed = parseInput(method, params, (name) => relay.targetOf(name) ?? control.targetOf(owner, name));
      if ('code' in parsed) return error(id, parsed.code, parsed.message);
      if (!take(inputs, 1, controlLimits.inputPerSecond, controlLimits.inputPerSecond)) {
        return error(id, 'limit-exceeded', `A connection can send ${controlLimits.inputPerSecond} inputs a second.`);
      }
      const { command: sent } = parsed.value;
      if (
        sent.input === 'text' &&
        !take(characters, sent.text.length, controlLimits.textCharsPerSecond, MAX_INPUT_TEXT)
      ) {
        return error(
          id,
          'limit-exceeded',
          `A connection can type ${controlLimits.textCharsPerSecond} characters a second. Send the rest shortly.`,
        );
      }
      const { shapeChangesPerSecond } = controlLimits;
      if (
        (sent.input === 'rotate' || sent.input === 'posture' || sent.input === 'simulator') &&
        !take(shapeChanges, 1, shapeChangesPerSecond, shapeChangesPerSecond)
      ) {
        return error(id, 'limit-exceeded', `A connection can rotate or fold ${shapeChangesPerSecond} times a second.`);
      }
      if (relay.control(id, method, params)) return;
      const refused = await control.input(owner, parsed.value.session, parsed.value.command);
      if (refused && 'code' in refused) return error(id, refused.code, refused.message);
      send(socket, { id, result: refused ?? {} });
    }

    function workspaceDir(id: RequestId, workspace: unknown, required: boolean): string | null {
      if (workspace === undefined && !required) return homedir();
      const resolved = registeredWorkspace(workspace);
      if ('code' in resolved) {
        error(id, resolved.code, resolved.message);
        return null;
      }
      return resolved.dir;
    }

    function readDir(id: RequestId, target: { workspace?: string; archive?: string }): string | null {
      if (target.archive === undefined) return workspaceDir(id, target.workspace, true);
      if (!readArchive(target.archive)) {
        error(id, 'unknown-workspace', `Archive ${target.archive} is not a Stim archive on this machine.`);
        return null;
      }
      return archiveDir(target.archive);
    }

    function openSubscription(id: RequestId, result: { video?: VideoCodec } = {}): string | null {
      if (subscriptions.size >= MAX_SUBSCRIPTIONS) {
        error(id, 'limit-exceeded', `A connection can hold ${MAX_SUBSCRIPTIONS} subscriptions.`);
        return null;
      }
      const subscription = `s${nextSubscription++}`;
      send(socket, { id, result: { subscription, ...result } });
      return subscription;
    }

    function subscribeStatus(id: RequestId): void {
      const subscription = openSubscription(id);
      if (!subscription) return;
      const envelope = `{"event":"status","subscription":${JSON.stringify(subscription)},"payload":`;
      const stopUsage = recordUsage();
      const unsubscribe = statusFeed.subscribe({
        item: (_payload, text) => {
          const history = usage.history();
          const leases = control.ownLeaseTimes();
          send(
            socket,
            `${envelope}${text}${history ? `,"usage":${JSON.stringify(history)}` : ''}${
              leases.length ? `,"ownLeases":${JSON.stringify(leases)}` : ''
            }}`,
          );
        },
        failed: (message) => {
          stopUsage();
          subscriptions.delete(subscription);
          send(socket, { event: 'error', subscription, error: { code: 'status-failed', message } });
        },
      });
      subscriptions.set(subscription, () => {
        stopUsage();
        unsubscribe();
      });
    }

    function subscribeWorkspaces(id: RequestId): void {
      const subscription = openSubscription(id);
      if (!subscription) return;
      const workspaces = new KeyedEntities<WorkspaceSummary>((workspace) => workspace.path);
      const worktrees = new KeyedEntities<WorktreeRow>((worktree) => worktree.path);
      let archived: string | null = null;
      let seq = 0;
      const unsubscribe = statusFeed.subscribe({
        item: (payload) => {
          const views = viewsOf(payload);
          const archivedText = JSON.stringify(views.archived);
          if (archived === null) {
            workspaces.reset(views.workspaces);
            worktrees.reset(views.worktrees);
            archived = archivedText;
            const { workspaces: summaries, worktrees: rows, archived: summary } = views;
            return send(socket, {
              event: 'workspaces',
              subscription,
              seq: seq++,
              snapshot: { workspaces: summaries, worktrees: rows, archived: summary },
            });
          }
          const changedWorkspaces = workspaces.next(views.workspaces);
          const changedWorktrees = worktrees.next(views.worktrees);
          const archivedChanged = archivedText !== archived;
          archived = archivedText;
          if (!changedWorkspaces && !changedWorktrees && !archivedChanged) return;
          send(socket, {
            event: 'workspaces',
            subscription,
            seq: seq++,
            ...(changedWorkspaces ? { workspaces: changedWorkspaces } : {}),
            ...(changedWorktrees ? { worktrees: changedWorktrees } : {}),
            ...(archivedChanged ? { archived: views.archived } : {}),
          });
        },
        failed: (message) => {
          subscriptions.delete(subscription);
          send(socket, { event: 'error', subscription, error: { code: 'status-failed', message } });
        },
      });
      subscriptions.set(subscription, unsubscribe);
    }

    function subscribeWorkspace(id: RequestId, params: unknown): void {
      const workspace = isJsonObject(params) ? params.workspace : undefined;
      if (typeof workspace !== 'string' || !workspace)
        return error(id, 'bad-request', 'params.workspace must be a workspace path from the workspace list.');
      const subscription = openSubscription(id);
      if (!subscription) return;
      let last: string | null = null;
      let seq = 0;
      const unsubscribe = statusFeed.subscribe({
        item: (payload) => {
          const environment = viewsOf(payload).details.get(workspace) ?? null;
          const text = JSON.stringify(environment);
          if (text === last) return;
          last = text;
          send(socket, { event: 'workspace', subscription, seq: seq++, environment });
        },
        failed: (message) => {
          subscriptions.delete(subscription);
          send(socket, { event: 'error', subscription, error: { code: 'status-failed', message } });
        },
      });
      subscriptions.set(subscription, unsubscribe);
    }

    function subscribeMachine(id: RequestId): void {
      const subscription = openSubscription(id);
      if (!subscription) return;
      const stopUsage = recordUsage();
      let last: string | null = null;
      let seq = 0;
      const unsubscribe = statusFeed.subscribe({
        item: (payload) => {
          const history = usage.history();
          const leases = control.ownLeaseTimes();
          const event = {
            machine: viewsOf(payload).machine,
            ...(history ? { usage: history } : {}),
            ...(leases.length ? { ownLeases: leases } : {}),
          };
          const text = JSON.stringify(event);
          if (text === last) return;
          last = text;
          send(socket, { event: 'machine', subscription, seq: seq++, ...event });
        },
        failed: (message) => {
          stopUsage();
          subscriptions.delete(subscription);
          send(socket, { event: 'error', subscription, error: { code: 'status-failed', message } });
        },
      });
      subscriptions.set(subscription, () => {
        stopUsage();
        unsubscribe();
      });
    }

    async function statusRead<M extends 'builds.history' | 'archived.list' | 'worktrees.list' | 'maintenance.get'>(
      id: RequestId,
      read: (payload: StatusPayload) => { result: Methods[M]['result'] } | { code: ErrorCode; message: string },
    ): Promise<void> {
      const status = await currentStatus();
      if (socket.readyState !== socket.OPEN) return;
      if ('failed' in status) return error(id, 'status-failed', status.failed);
      const answer = read(status.payload);
      if ('code' in answer) return error(id, answer.code, answer.message);
      send(socket, { id, result: answer.result });
    }

    function readBuildsHistory(id: RequestId, params: unknown): Promise<void> {
      const workspace = isJsonObject(params) ? params.workspace : undefined;
      return statusRead<'builds.history'>(id, (payload) => {
        const environment = payload.environments.find((each) => each.path === workspace);
        if (!environment) return { code: 'unknown-workspace', message: 'No workspace has that path.' };
        return { result: { builds: environment.builds ?? {} } };
      });
    }

    function listArchived(id: RequestId, params: unknown): Promise<void> {
      const before = isJsonObject(params) && typeof params.before === 'string' ? params.before : null;
      const requested = isJsonObject(params) && typeof params.limit === 'number' ? params.limit : ARCHIVED_PAGE_LIMIT;
      const limit = Math.max(1, Math.min(ARCHIVED_PAGE_LIMIT, Math.floor(requested)));
      return statusRead<'archived.list'>(id, (payload) => {
        const archives = payload.archived ?? [];
        const newest = archives.toSorted((a, b) => archiveCursor(b).localeCompare(archiveCursor(a)));
        const from = before === null ? 0 : newest.findIndex((archive) => archiveCursor(archive) < before);
        const page = from === -1 ? [] : newest.slice(from, from + limit);
        const more = from !== -1 && from + limit < newest.length;
        return {
          result: {
            archived: page,
            usage: payload.archivedUsage ?? archivedUsage(archives),
            next: more ? lastCursor(page) : null,
          },
        };
      });
    }

    const statusMethods: Partial<Record<string, (id: RequestId, params: unknown) => void | Promise<void>>> = {
      'workspaces.subscribe': subscribeWorkspaces,
      'workspace.subscribe': subscribeWorkspace,
      'machine.subscribe': subscribeMachine,
      'builds.history': readBuildsHistory,
      'archived.list': listArchived,
      'worktrees.list': (id) =>
        statusRead<'worktrees.list'>(id, (payload) => ({ result: { worktrees: payload.unprovisionedWorktrees } })),
      'maintenance.get': (id) =>
        statusRead<'maintenance.get'>(id, (payload) => ({ result: { maintenance: payload.maintenance ?? null } })),
    };

    function subscribeLogs(id: RequestId, params: unknown, fullBackfill = false): void | Promise<void> {
      const parsed = parseLogFilter(params);
      if ('error' in parsed) return error(id, 'bad-request', parsed.error);
      const cwd = readDir(id, parsed.filter);
      if (!cwd) return;
      const subscription = openSubscription(id);
      if (!subscription) return;
      const end = () => {
        subscriptions.get(subscription)?.();
        subscriptions.delete(subscription);
      };
      const batcher = new LogBatcher(
        {
          send: (records) => send(socket, { event: 'logs', subscription, records }),
          bufferedBytes: () => socket.bufferedAmount,
          ended: () => {
            end();
            send(socket, { event: 'logs-ended', subscription });
          },
          overflow: () => {
            end();
            send(socket, {
              event: 'error',
              subscription,
              error: { code: 'slow-client', message: 'This client fell behind the log stream. Subscribe again.' },
            });
          },
        },
        logLimits,
      );
      if (parsed.filter.archive !== undefined) {
        subscriptions.set(subscription, () => batcher.stop());
        return agentActionReaders().then((actions) => {
          for (const record of archivedLogs(cwd, parsed.filter, actions)) batcher.push(record);
          return batcher.finish();
        });
      }
      const abort = new AbortController();
      let stop: (() => void) | undefined;
      const deadline = setTimeout(() => {
        abort.abort();
        batcher.stop();
        subscriptions.delete(subscription);
        send(socket, {
          event: 'error',
          subscription,
          error: {
            code: 'logs-failed',
            message: `stim logs did not finish within ${commandLimits.timeoutMs / 1000} s.`,
          },
        });
      }, commandLimits.timeoutMs);
      subscriptions.set(subscription, () => {
        clearTimeout(deadline);
        abort.abort();
        batcher.stop();
        stop?.();
      });
      const task = Promise.resolve()
        .then(() =>
          createStim({ projectRoot: cwd, env: options.env }).followLogs(
            {
              sources: parsed.filter.sources,
              minLevel: parsed.filter.level,
              slot: parsed.filter.slot,
              grep: parsed.filter.grep,
              errorsOnly: parsed.filter.errors,
              tail: fullBackfill ? undefined : parsed.filter.tail,
              signal: abort.signal,
            },
            (record) => {
              if (!abort.signal.aborted) batcher.push(record);
            },
            fullBackfill ? (records) => batcher.backfill(records, abort.signal) : undefined,
          ),
        )
        .then(
          (unsubscribe) => {
            clearTimeout(deadline);
            stop = unsubscribe;
            if (abort.signal.aborted) stop();
            return undefined;
          },
          (cause: unknown) => {
            clearTimeout(deadline);
            if (abort.signal.aborted) return;
            batcher.flush(true);
            batcher.stop();
            subscriptions.delete(subscription);
            send(socket, { event: 'error', subscription, error: { code: 'logs-failed', message: readFailure(cause) } });
          },
        )
        .finally(() => running.delete(cancel));
      const cancel = async () => {
        abort.abort();
        await task;
      };
      running.add(cancel);
    }

    function subscribeFrames(
      id: RequestId,
      params: unknown,
      hosted?: { client: string; session: string; view: ReturnType<HostedViews['target']> },
    ): void {
      const framePool = hosted?.view.frames ?? frames;
      const target = isJsonObject(params) ? params : {};
      const { platform, fps, maxEdge, video, at, rate, deviceFrame, duoFrame } = target;
      const targetError = frameTargetError(target, hosted !== undefined);
      if (targetError) return error(id, 'bad-request', targetError);
      const slot = target.slot as string | undefined;
      const physical = target.physical as boolean | undefined;
      const workspace = target.workspace as string | undefined;
      const archive = target.archive as string | undefined;
      const wantsDuo = duoFrame === true && at === undefined;
      const wantsArtwork = deviceFrame === true && !physical && platform !== 'web';
      if (video !== undefined && (!Array.isArray(video) || !video.every((codec) => typeof codec === 'string'))) {
        return error(id, 'bad-request', 'video must be a list of codec names.');
      }
      const wantsVideo = (video as string[] | undefined)?.includes('h264') === true;
      const maxFps = wantsVideo ? FRAME_FPS.video : FRAME_FPS.max;
      if (fps !== undefined && (typeof fps !== 'number' || !Number.isInteger(fps) || fps < 1 || fps > maxFps)) {
        return error(id, 'bad-request', `fps must be a whole number from 1 to ${maxFps}.`);
      }
      if (
        maxEdge !== undefined &&
        (typeof maxEdge !== 'number' ||
          !Number.isInteger(maxEdge) ||
          maxEdge < FRAME_EDGE.min ||
          maxEdge > FRAME_EDGE.max)
      ) {
        return error(
          id,
          'bad-request',
          `maxEdge must be a whole number of pixels from ${FRAME_EDGE.min} to ${FRAME_EDGE.max}.`,
        );
      }
      const resolvedDir = hosted ? null : readDir(id, { workspace, archive });
      if (!hosted && !resolvedDir) return;
      const host =
        archive || hosted || !resolvedDir
          ? undefined
          : viewHostedPlacement(resolvedDir, platform as Platform, slot as string | undefined, physical);
      if (host) {
        if (
          (platform === 'macos' && slot !== undefined && slot !== 'default') ||
          physical ||
          duoFrame ||
          at !== undefined ||
          rate !== undefined
        ) {
          return error(
            id,
            'bad-request',
            platform === 'ios'
              ? 'Hosted iOS frames require a non-physical target without replay or duoFrame.'
              : platform === 'android'
                ? 'Hosted Android frames require a non-physical target without replay or duoFrame.'
                : 'Hosted macOS frames require the default, non-physical target without replay.',
          );
        }
        return void relay.subscribe(id, host, target, (subscription, stop) => subscriptions.set(subscription, stop));
      }
      const offersVideo = wantsVideo && !wantsDuo && (archive !== undefined || frameHelper() !== null);
      const replayAt = parseReplay(at, rate);
      if (typeof replayAt === 'string') return error(id, 'bad-request', replayAt);
      if (replayAt && !offersVideo) {
        return error(id, 'bad-request', 'Replay needs a video subscription: pass video: ["h264"].');
      }
      const hint: FrameHint = {
        fps: Math.min(fps ?? FRAME_FPS.default, offersVideo ? FRAME_FPS.video : FRAME_FPS.max),
        maxEdge: maxEdge ?? FRAME_EDGE.default,
      };
      const replayDir =
        platform === 'macos'
          ? null
          : recordingDir(
              workspace,
              platform as RecordingPlatform,
              typeof slot === 'string' ? slot : 'default',
              archive,
            );
      if (replayAt && (physical || replayDir === null || !hasFootage(replayDir, archive !== undefined))) {
        return error(
          id,
          'no-recording',
          `Nothing was recorded for ${physical ? 'a physical ' : ''}${platform} in ${archive ?? workspace}.`,
        );
      }
      const subscription = openSubscription(id, offersVideo ? { video: 'h264' } : {});
      if (!subscription) return;
      const frameTarget: FrameTarget = {
        ...(archive === undefined ? { workspace } : { archive }),
        platform: platform as Platform,
        ...(slot ? { slot } : {}),
        ...(physical ? { physical } : {}),
      };
      const gate = new VideoGate(DEFAULT_VIDEO_LIMITS.congestedBytes);
      let sequence = 0;
      let streamed: Device | null = null;
      let draining: NodeJS.Timeout | null = null;
      const drain = () => {
        draining = null;
        if (ended || !streamed) return;
        if (socket.bufferedAmount <= DEFAULT_VIDEO_LIMITS.congestedBytes) return framePool.keyframe(streamed);
        framePool.congested(streamed);
        draining = setTimeout(drain, FRAME_RETRY_MS);
      };
      let attached: string | null = null;
      let detach: (() => void) | null = null;
      let ended = false;
      const delivery = new LatestFrames<Frame>(
        hint.fps,
        () => socket.bufferedAmount,
        (frame) => {
          send(socket, {
            event: 'frame',
            subscription,
            platform: frameTarget.platform,
            slot: slot ?? 'default',
            mime: 'image/jpeg',
            ...frame,
          });
        },
      );
      const cleanup = () => {
        ended = true;
        player?.stop();
        replays.delete(subscription);
        stopViewing?.();
        keyframes.delete(subscription);
        congestion.delete(subscription);
        delivery.stop();
        if (draining) clearTimeout(draining);
        detach?.();
        detach = null;
        unsubscribeStatus?.();
      };
      const end = (message: string) => {
        if (ended) return;
        cleanup();
        subscriptions.delete(subscription);
        send(socket, { event: 'error', subscription, error: { code: 'frames-failed', message } });
      };
      const listener = {
        frame: (frame: Frame) => delivery.push(frame),
        delayed: (delayed: boolean, reason?: string) => {
          if (!ended) send(socket, { event: 'frame-delayed', subscription, delayed, ...(reason ? { reason } : {}) });
        },
        failed: end,
        ...(frameTarget.platform === 'macos'
          ? {
              windows: ({
                current,
                windows,
                pinned,
              }: {
                current: MacosWindow | null;
                windows: MacosWindow[];
                pinned: boolean;
              }) => {
                if (!ended) send(socket, { event: 'macos-windows', subscription, current, windows, pinned });
              },
            }
          : {}),
        ...(wantsDuo ? { duo: (frame: Frame) => delivery.push(frame) } : {}),
        ...(wantsArtwork
          ? {
              artwork: (artwork: DeviceFrameArtwork | null) => {
                if (!ended && !player) send(socket, { event: 'device-frame', subscription, artwork });
              },
            }
          : {}),
        ...(offersVideo
          ? {
              video: (unit: AccessUnit) => {
                if (ended || player || socket.readyState !== socket.OPEN) return;
                const verdict = gate.admit(unit, socket.bufferedAmount);
                if (verdict === 'send') socket.send(videoPacket(subscription, sequence++, unit));
                else if (verdict === 'congested' && !draining) drain();
              },
            }
          : {}),
      };
      let player: Player | null = null;
      let latest: StatusPayload | null = null;
      const attach = (resolved: Device) => {
        if (wantsArtwork) send(socket, { event: 'device-frame', subscription, artwork: null });
        if (!hosted && resolved.platform === 'macos') nativeViewerOpened = true;
        detach?.();
        gate.reset();
        streamed = resolved;
        attached = deviceKey(resolved);
        detach = hosted
          ? hostedViews.subscribe(hosted.client, hosted.session, listener, hint)
          : framePool.subscribe(resolved, listener, hint);
      };
      const replay = (): Player => {
        if (player) return player;
        if (wantsArtwork) send(socket, { event: 'device-frame', subscription, artwork: null });
        detach?.();
        detach = null;
        attached = null;
        player = new Player(
          replayDir!,
          {
            unit: (unit) => {
              if (!ended && socket.readyState === socket.OPEN) socket.send(videoPacket(subscription, sequence++, unit));
            },
            bufferedBytes: () => socket.bufferedAmount,
            ended: (position) =>
              queueMicrotask(() => {
                if (!ended) send(socket, { event: 'replay-ended', subscription, at: position });
              }),
          },
          DEFAULT_VIDEO_LIMITS.congestedBytes,
          archive !== undefined,
        );
        return player;
      };
      const goLive = (): string | null => {
        if (archive !== undefined) return `Archive ${archive} cannot go live.`;
        const resolved = latest
          ? ownedDevice(latest, frameTarget, null, { adbEmulators })
          : 'The device status is not known yet.';
        if (typeof resolved === 'string') return resolved;
        player?.stop();
        player = null;
        attach(resolved);
        return null;
      };
      if (offersVideo) {
        congestion.set(subscription, () => {
          if (streamed && !player) framePool.congested(streamed);
        });
        keyframes.set(subscription, () => {
          if (player) return player.resend();
          gate.reset();
          if (streamed) framePool.keyframe(streamed);
        });
        replays.set(subscription, {
          seek: (seekAt, seekRate) => {
            if (physical || replayDir === null || !hasFootage(replayDir, archive !== undefined)) return null;
            const wasLive = player === null;
            const shown = replay().seek(seekAt, seekRate);
            if (shown === null && wasLive) goLive();
            return shown;
          },
          live: goLive,
        });
      }
      if (replayAt && replay().seek(replayAt.at, replayAt.rate) === null) {
        send(socket, { event: 'replay-ended', subscription, at: replayAt.at });
      }
      const stopViewing = archive !== undefined || physical || hosted ? undefined : recorder?.viewing(frameTarget);
      let unsubscribeStatus: (() => void) | null = null;
      if (hosted) attach(hosted.view.device);
      else if (archive === undefined)
        unsubscribeStatus = statusFeed.subscribe({
          item: (payload) => {
            if (ended) return;
            latest = payload as unknown as StatusPayload;
            if (player) return;
            const resolved = ownedDevice(latest, frameTarget, attached, { adbEmulators });
            if (typeof resolved === 'string') return queueMicrotask(() => end(resolved));
            if (deviceKey(resolved) === attached) return;
            attach(resolved);
          },
          failed: (message) => queueMicrotask(() => end(message)),
        });
      subscriptions.set(subscription, cleanup);
    }

    function archiveRead(id: RequestId, read: () => void | Promise<void>): void {
      if (slotsFull()) {
        return error(id, 'limit-exceeded', slotsMessage());
      }
      let dropped = false;
      const cancel = async () => {
        dropped = true;
        await task;
      };
      holdSlot(cancel);
      running.add(cancel);
      const task = archiveReads
        .then(() => new Promise<void>((resolve) => setImmediate(resolve)))
        .then(() => {
          if (!dropped && socket.readyState === socket.OPEN) return read();
          return undefined;
        })
        .finally(() => {
          releaseSlot(cancel);
          running.delete(cancel);
        });
      archiveReads = task.catch(() => socket.close(1011, 'internal error'));
    }

    function queryLogs(id: RequestId, params: unknown): void | Promise<void> {
      const parsed = parseLogFilter(params);
      if ('error' in parsed) return error(id, 'bad-request', parsed.error);
      const cwd = readDir(id, parsed.filter);
      if (!cwd) return;
      if (parsed.filter.archive !== undefined) {
        return agentActionReaders().then((actions) =>
          send(socket, { id, result: { records: archivedLogs(cwd, parsed.filter, actions) } }),
        );
      }
      inProcessRead<'logs.query'>(id, 'stim logs', async (signal) => ({
        records: await createStim({ projectRoot: cwd, env: options.env }).logs({
          sources: parsed.filter.sources,
          minLevel: parsed.filter.level,
          slot: parsed.filter.slot,
          grep: parsed.filter.grep,
          errorsOnly: parsed.filter.errors,
          tail: parsed.filter.tail,
          signal,
        }),
      }));
    }

    function workspaceChanges(id: RequestId, method: 'workspace.files' | 'workspace.diff', params: unknown): void {
      const needsPath = method === 'workspace.diff';
      if (
        !isJsonObject(params) ||
        typeof params.workspace !== 'string' ||
        !params.workspace.length ||
        params.workspace.length > 4096 ||
        params.workspace.includes('\0') ||
        (!needsPath && params.group !== 'changed' && params.group !== 'untracked') ||
        (needsPath &&
          (typeof params.path !== 'string' ||
            !params.path.length ||
            params.path.length > 4096 ||
            params.path.includes('\0'))) ||
        Object.keys(params).some((key) => key !== 'workspace' && !(needsPath ? key === 'path' : key === 'group'))
      ) {
        return error(id, 'bad-request', 'Workspace diff requires workspace and, for a patch, a file path.');
      }
      const cwd = workspaceDir(id, params.workspace, true);
      if (!cwd) return;
      if (slotsFull()) {
        return error(id, 'limit-exceeded', slotsMessage());
      }
      const abort = new AbortController();
      let task: Promise<void>;
      const cancel = async () => {
        abort.abort();
        await task;
      };
      holdSlot(cancel);
      running.add(cancel);
      task = readWorkspaceDiff(
        cwd,
        needsPath ? (params.path as string) : undefined,
        options.env,
        abort.signal,
        !needsPath ? (params.group as 'changed' | 'untracked') : undefined,
      )
        .then(
          (result) => {
            if (!abort.signal.aborted) send(socket, { id, result });
            return undefined;
          },
          (cause: Error) => {
            if (!abort.signal.aborted) error(id, 'stim-failed', cause.message);
            return undefined;
          },
        )
        .finally(() => {
          releaseSlot(cancel);
          running.delete(cancel);
        });
      return;
    }

    function inProcessRead<
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
      timeoutMs = commandLimits.timeoutMs,
      turn: Promise<void> | null = null,
      report = false,
    ): { done: Promise<void>; cancel: () => Promise<void> } | null {
      if (report ? reportWaits.size >= MAX_REPORT_WAITS : slotsFull()) {
        error(
          id,
          'limit-exceeded',
          report ? `A connection can wait for ${MAX_REPORT_WAITS} reports at a time.` : slotsMessage(),
        );
        return null;
      }
      const abort = new AbortController();
      let deadline: ReturnType<typeof setTimeout> | undefined;
      const task = Promise.resolve(turn)
        .then(() => {
          abort.signal.throwIfAborted();
          deadline = setTimeout(() => {
            if (abort.signal.aborted) return;
            abort.abort();
            error(id, 'stim-failed', `${label} did not finish within ${timeoutMs / 1000} s.`);
          }, timeoutMs);
          return read(abort.signal);
        })
        .then(
          (result) => {
            if (abort.signal.aborted) return undefined;
            if (Buffer.byteLength(JSON.stringify(result)) > commandLimits.maxOutputBytes) {
              error(id, 'stim-failed', `${label} printed more than ${commandLimits.maxOutputBytes} bytes.`);
            } else send(socket, { id, result });
            return undefined;
          },
          (cause: unknown) => {
            if (!abort.signal.aborted) error(id, 'stim-failed', readFailure(cause));
            return undefined;
          },
        )
        .finally(() => {
          clearTimeout(deadline);
          releaseSlot(cancel);
          reportWaits.delete(cancel);
          running.delete(cancel);
        });
      const cancel = async () => {
        abort.abort();
        await task;
      };
      if (report) reportWaits.add(cancel);
      else holdSlot(cancel);
      running.add(cancel);
      return { done: task, cancel };
    }

    function workspaceCommand(id: RequestId, method: 'stats.get' | 'settings.get', params: unknown): void {
      if (params !== undefined && !isJsonObject(params)) return error(id, 'bad-request', 'params must be an object.');
      const cwd = workspaceDir(id, params?.workspace, false);
      if (!cwd) return;
      if (method === 'settings.get') {
        return void inProcessRead<'settings.get'>(id, 'stim settings', (signal) =>
          createStim({ projectRoot: cwd, env: options.env }).settings({ signal }),
        );
      }
      return void inProcessRead<'stats.get'>(id, 'stim stats', (signal) =>
        createStim({ projectRoot: cwd, env: options.env }).stats({ signal }),
      );
    }

    function runAction(id: RequestId, params: unknown, session: PairedDevice): void {
      const startedAt = Date.now();
      const raw = isJsonObject(params) ? params : {};
      const clip = (value: unknown) => (typeof value === 'string' ? value.slice(0, AUDIT_FIELD_CHARS) : null);
      const record: AuditRecord = {
        at: new Date(startedAt).toISOString(),
        device: { id: session.id, name: session.name },
        action: clip(raw.action),
        workspace: clip(raw.workspace),
        ...(typeof raw.platform === 'string' ? { platform: clip(raw.platform)! } : {}),
        ok: false,
      };
      const audit = (outcome: Pick<AuditRecord, 'ok' | 'error' | 'durationMs'>) => {
        const logged = outcome.error ? { ...outcome.error, message: clip(outcome.error.message)! } : undefined;
        try {
          appendAudit({ ...record, ...outcome, ...(logged ? { error: logged } : {}) });
        } catch (cause) {
          console.error(`stim-server: could not append to the action log: ${(cause as Error).message}`);
        }
      };
      const refuseAction = (code: ErrorCode, message: string) => {
        audit({ ok: false, error: { code, message } });
        error(id, code, message);
      };
      if (!canControl(session)) {
        return refuseAction(
          'forbidden',
          `This device can only read. On the machine, run \`stim-server devices grant ${session.id} --control\` to let it run actions.`,
        );
      }
      const parsed = parseAction(params);
      if ('code' in parsed) return refuseAction(parsed.code, parsed.message);
      const { action } = parsed;
      const resolved = registeredWorkspace(action.workspace);
      if ('code' in resolved) return refuseAction(resolved.code, resolved.message);
      if (slotsFull()) return refuseAction('limit-exceeded', slotsMessage());
      if (busyWorkspaces.has(resolved.dir)) {
        return refuseAction(
          'action-busy',
          `An action is already running in ${resolved.dir}. Try again when it finishes.`,
        );
      }
      let admittedCwd = resolved.dir;
      let run: ReturnType<typeof stopAction> | ReturnType<typeof reloadAction>;
      try {
        run =
          action.action === 'stop'
            ? stopAction(resolved.dir, options.env, actionLimits, {
                beforeStop: (workspace) => {
                  if (workspace === resolved.dir) return;
                  if (busyWorkspaces.has(workspace))
                    throw new StimError({
                      code: 'STIM_ACTION_BUSY',
                      message: `An action is already running in ${workspace}.`,
                    });
                  busyWorkspaces.add(workspace);
                  admittedCwd = workspace;
                  record.workspace = clip(workspace);
                },
              })
            : reloadAction(resolved.dir, options.env, actionLimits, {
                platform: action.platform,
                beforeReload: (workspace) => {
                  if (workspace === resolved.dir) return;
                  if (busyWorkspaces.has(workspace))
                    throw new StimError({
                      code: 'STIM_ACTION_BUSY',
                      message: `An action is already running in ${workspace}.`,
                    });
                  busyWorkspaces.add(workspace);
                  admittedCwd = workspace;
                  record.workspace = clip(workspace);
                },
              });
      } catch (cause) {
        return refuseAction('action-failed', `stim ${action.action} could not start (${(cause as Error).message}).`);
      }
      busyWorkspaces.add(resolved.dir);
      let finished = false;
      const release = (outcome: CommandOutcome & { unresolved?: boolean }) => {
        if (outcome.unresolved) return;
        releaseSlot(cancel);
        persistentActions.delete(cancel);
        running.delete(cancel);
        busyWorkspaces.delete(resolved.dir);
        busyWorkspaces.delete(admittedCwd);
      };
      const finish = (outcome: ReturnType<typeof actionOutcome>) => {
        if (finished) return;
        finished = true;
        audit({ ok: outcome.ok, ...(outcome.ok ? {} : { error: outcome.error }), durationMs: Date.now() - startedAt });
        if (outcome.ok)
          send(socket, { id, result: { action: action.action, workspace: admittedCwd, output: outcome.output } });
        else send(socket, { id, error: outcome.error });
      };
      const cancel = async () => {
        finish({
          ok: false,
          error: { code: 'action-failed', message: 'stim-server stopped before the action finished.' },
        });
        await run.cancel();
        release(await run.drained);
      };
      holdSlot(cancel);
      persistentActions.add(cancel);
      running.add(cancel);
      void run.outcome.then((outcome) =>
        finish(
          !outcome.ok && 'code' in outcome && outcome.code === 'STIM_ACTION_BUSY'
            ? { ok: false, error: { code: 'action-busy', message: outcome.message } }
            : actionOutcome(outcome),
        ),
      );
      void run.drained.then(release);
    }

    function subscribeStop(id: RequestId, params: unknown, owner: PairedDevice): void {
      if (
        !isJsonObject(params) ||
        Object.keys(params).some((key) => key !== 'cwd' && key !== 'slot') ||
        typeof params.cwd !== 'string' ||
        params.cwd.length > 4096 ||
        params.cwd.includes('\0') ||
        !isAbsolute(params.cwd) ||
        (params.slot !== undefined &&
          (typeof params.slot !== 'string' ||
            !SLOT_NAME.test(params.slot) ||
            ['constructor', 'prototype', '__proto__'].includes(params.slot)))
      ) {
        return error(id, 'bad-request', 'Stop requires an absolute cwd and an optional device slot or web.');
      }
      let cwd: string;
      try {
        cwd = realpathSync(params.cwd);
        if (!lstatSync(cwd).isDirectory()) throw new Error('The workspace is not a directory.');
      } catch (cause) {
        return error(id, 'bad-request', `Cannot stop this workspace: ${readFailure(cause)}`);
      }
      if (busyWorkspaces.has(cwd)) return error(id, 'action-busy', `An action is already running in ${cwd}.`);
      const subscription = openSubscription(id);
      if (!subscription) return;
      const startedAt = Date.now();
      let admittedCwd = cwd;
      const slot = typeof params.slot === 'string' ? params.slot : undefined;
      let observing = true;
      let terminal: StopOutcome | undefined;
      const finish = (outcome: StopOutcome) => {
        terminal ??= outcome;
        if (!observing) return;
        observing = false;
        subscriptions.delete(subscription);
        send(socket, {
          event: 'desktop-stop-ended',
          subscription,
          exitCode: outcome.ok ? 0 : 1,
          stdout: outcome.stdout ?? '',
          message: outcome.ok ? outcome.summary : outcome.message,
        });
      };
      let outputBytes = 0;
      let run: ReturnType<typeof stopAction>;
      try {
        run = stopAction(cwd, options.env, actionLimits, {
          slot,
          beforeStop: (workspace) => {
            if (workspace === cwd) return;
            if (busyWorkspaces.has(workspace))
              throw new StimError({
                code: 'STIM_ACTION_BUSY',
                message: `An action is already running in ${workspace}.`,
              });
            busyWorkspaces.add(workspace);
            admittedCwd = workspace;
          },
          onProgress: (progress) => {
            if (!observing) return;
            outputBytes += Buffer.byteLength(progress.message);
            if (outputBytes > actionLimits.maxOutputBytes) {
              finish({ ok: false, message: `stim stop printed more than ${actionLimits.maxOutputBytes} bytes.` });
              void run.cancel();
              return;
            }
            send(socket, { event: 'desktop-stop-progress', subscription, ...progress });
          },
        });
      } catch (cause) {
        finish({ ok: false, message: readFailure(cause) });
        return;
      }
      const cancel = () => run.cancel();
      busyWorkspaces.add(cwd);
      running.add(cancel);
      subscriptions.set(subscription, () => {
        observing = false;
        void cancel();
      });
      void run.outcome.then(finish);
      void run.drained.then((outcome) => {
        running.delete(cancel);
        busyWorkspaces.delete(cwd);
        busyWorkspaces.delete(admittedCwd);
        const recorded = terminal ?? outcome;
        auditSafely({
          at: new Date(startedAt).toISOString(),
          device: { id: owner.id, name: owner.name },
          action: 'stop',
          workspace: admittedCwd,
          ...(slot === undefined ? {} : { slot }),
          ok: recorded.ok,
          durationMs: Date.now() - startedAt,
          ...(recorded.ok
            ? {}
            : { error: { code: 'action-failed', message: recorded.message.slice(0, AUDIT_FIELD_CHARS) } }),
        });
        return undefined;
      });
    }

    function subscribeReload(id: RequestId, params: unknown, owner: PairedDevice): void {
      if (
        !isJsonObject(params) ||
        Object.keys(params).some((key) => key !== 'cwd' && key !== 'platform') ||
        typeof params.cwd !== 'string' ||
        params.cwd.length > 4096 ||
        params.cwd.includes('\0') ||
        !isAbsolute(params.cwd)
      )
        return error(
          id,
          'bad-request',
          'Reload requires an absolute cwd and an optional ios, android or web platform.',
        );
      const platform = RELOAD_PLATFORMS.find((candidate) => candidate === params.platform);
      if (params.platform !== undefined && platform === undefined)
        return error(id, 'bad-request', 'Choose ios, android or web for reload.');
      let cwd: string;
      try {
        cwd = realpathSync(params.cwd);
        if (!lstatSync(cwd).isDirectory()) throw new Error('The workspace is not a directory.');
      } catch (cause) {
        return error(id, 'bad-request', `Cannot reload this workspace: ${readFailure(cause)}`);
      }
      if (slotsFull()) return error(id, 'limit-exceeded', slotsMessage());
      if (busyWorkspaces.has(cwd)) return error(id, 'action-busy', `An action is already running in ${cwd}.`);
      const subscription = openSubscription(id);
      if (!subscription) return;
      const startedAt = Date.now();
      let admittedCwd = cwd;
      let observing = true;
      let terminal: ReloadOutcome | undefined;
      const finish = (outcome: ReloadOutcome) => {
        terminal ??= outcome;
        if (!observing) return;
        observing = false;
        subscriptions.delete(subscription);
        send(socket, {
          event: 'desktop-reload-ended',
          subscription,
          exitCode: outcome.ok ? 0 : 1,
          stdout: outcome.stdout ?? '',
          message: outcome.ok ? outcome.summary : outcome.message,
        });
      };
      const run = reloadAction(cwd, options.env, actionLimits, {
        platform,
        beforeReload: (workspace) => {
          if (workspace === cwd) return;
          if (busyWorkspaces.has(workspace))
            throw new StimError({ code: 'STIM_ACTION_BUSY', message: `An action is already running in ${workspace}.` });
          busyWorkspaces.add(workspace);
          admittedCwd = workspace;
        },
        onProgress: (progress) => {
          if (observing) send(socket, { event: 'desktop-reload-progress', subscription, ...progress });
        },
      });
      const cancel = () => run.cancel();
      holdSlot(cancel);
      running.add(cancel);
      busyWorkspaces.add(cwd);
      subscriptions.set(subscription, () => {
        observing = false;
        void cancel();
      });
      void run.outcome.then(finish);
      void run.drained.then((outcome) => {
        if (!outcome.unresolved) {
          releaseSlot(cancel);
          running.delete(cancel);
          busyWorkspaces.delete(cwd);
          busyWorkspaces.delete(admittedCwd);
        }
        const recorded = terminal ?? outcome;
        auditSafely({
          at: new Date(startedAt).toISOString(),
          device: { id: owner.id, name: owner.name },
          action: 'reload',
          workspace: admittedCwd,
          ...(platform ? { platform } : {}),
          ok: recorded.ok,
          durationMs: Date.now() - startedAt,
          ...(recorded.ok
            ? {}
            : {
                error: {
                  code: 'action-failed',
                  message: outcome.unresolved ? 'STIM_CLAIM_UNAVAILABLE' : recorded.code || 'STIM_RELOAD_FAILED',
                },
              }),
        });
        return undefined;
      });
    }

    function subscribeStart(id: RequestId, params: unknown, owner: PairedDevice): void {
      if (
        !isJsonObject(params) ||
        Object.keys(params).some((key) => !['cwd', 'remote', 'resetCache', 'waitSeconds'].includes(key)) ||
        typeof params.cwd !== 'string' ||
        params.cwd.length > 4096 ||
        params.cwd.includes('\0') ||
        !isAbsolute(params.cwd) ||
        (params.remote !== undefined && typeof params.remote !== 'boolean') ||
        (params.resetCache !== undefined && typeof params.resetCache !== 'boolean') ||
        (params.waitSeconds !== undefined &&
          (typeof params.waitSeconds !== 'number' ||
            !Number.isSafeInteger(params.waitSeconds) ||
            params.waitSeconds <= 0))
      )
        return error(
          id,
          'bad-request',
          'Start requires an absolute cwd, optional remote/resetCache booleans, and a positive whole waitSeconds.',
        );
      const remote = typeof params.remote === 'boolean' ? params.remote : undefined;
      const resetCache = typeof params.resetCache === 'boolean' ? params.resetCache : undefined;
      const waitSeconds = typeof params.waitSeconds === 'number' ? params.waitSeconds : undefined;
      subscribeLifecycle(id, params.cwd, owner, 'start', (cwd, beforeStart, onProgress) =>
        startAction(cwd, options.env, actionLimits, { remote, resetCache, waitSeconds, beforeStart, onProgress }),
      );
    }

    function subscribeRun(id: RequestId, params: unknown, owner: PairedDevice): void {
      const parsed = parsePlatformRun(params);
      if (!parsed) return error(id, 'bad-request', 'Run requires an absolute cwd and valid platform options.');
      const limits = { ...actionLimits, timeoutMs: options.actionLimits?.timeoutMs ?? 60 * 60_000 };
      subscribeLifecycle(
        id,
        parsed.cwd,
        owner,
        'run',
        (cwd, _beforeRun, onProgress) => platformRunAction(cwd, options.env, limits, parsed.options, onProgress),
        parsed.options.platform,
      );
    }

    function subscribeBuild(id: RequestId, params: unknown, owner: PairedDevice): void {
      const parsed = parsePlatformBuild(params);
      if (!parsed) return error(id, 'bad-request', 'Build requires an absolute cwd and valid artifact-only options.');
      const limits = { ...actionLimits, timeoutMs: options.actionLimits?.timeoutMs ?? 60 * 60_000 };
      subscribeLifecycle(
        id,
        parsed.cwd,
        owner,
        'build',
        (cwd, _beforeBuild, onProgress) => platformBuildAction(cwd, options.env, limits, parsed.options, onProgress),
        parsed.options.platform,
      );
    }

    function subscribeGc(id: RequestId, params: unknown, owner: PairedDevice): void {
      if (!desktopSessions.has(socket)) {
        return error(
          id,
          'forbidden',
          'Garbage collection requires the connection of the Stim Desktop that started this server.',
        );
      }
      if (
        !isJsonObject(params) ||
        Object.keys(params).some(
          (key) => !['cwd', 'cache', 'olderThan', 'worktrees', 'delete', 'idleMs'].includes(key),
        ) ||
        typeof params.cwd !== 'string' ||
        params.cwd.length > 4096 ||
        params.cwd.includes('\0') ||
        !isAbsolute(params.cwd) ||
        (params.cache !== undefined &&
          (typeof params.cache !== 'string' || !params.cache.trim() || params.cache.length > 1024)) ||
        (params.olderThan !== undefined &&
          (typeof params.olderThan !== 'number' || !Number.isSafeInteger(params.olderThan))) ||
        (params.worktrees !== undefined && typeof params.worktrees !== 'boolean') ||
        (params.delete !== undefined && typeof params.delete !== 'boolean') ||
        (params.idleMs !== undefined &&
          (typeof params.idleMs !== 'number' || !Number.isSafeInteger(params.idleMs) || params.idleMs <= 0))
      )
        return error(
          id,
          'bad-request',
          'GC requires an absolute cwd and valid cache, age, worktree, delete and idle selectors.',
        );
      const request = {
        cache: typeof params.cache === 'string' ? params.cache : undefined,
        olderThan: typeof params.olderThan === 'number' ? params.olderThan : undefined,
        worktrees: typeof params.worktrees === 'boolean' ? params.worktrees : undefined,
        delete: typeof params.delete === 'boolean' ? params.delete : undefined,
        idleMs: typeof params.idleMs === 'number' ? params.idleMs : undefined,
      };
      subscribeLifecycle(id, params.cwd, owner, 'gc', (cwd, _admit, onProgress) =>
        gcAction(cwd, options.env, actionLimits, request, onProgress),
      );
    }

    function subscribeMachineAccess(id: RequestId, params: unknown, owner: PairedDevice): void {
      if (!desktopSessions.has(socket))
        return error(
          id,
          'forbidden',
          'Requesting machine access requires the connection of the Stim Desktop that started this server.',
        );
      if (
        !isJsonObject(params) ||
        Object.keys(params).some((key) => key !== 'cwd' && key !== 'ticket') ||
        typeof params.cwd !== 'string' ||
        params.cwd.length > 4096 ||
        params.cwd.includes('\0') ||
        !isAbsolute(params.cwd) ||
        (params.ticket !== undefined && (typeof params.ticket !== 'string' || !decodeSecret(params.ticket)))
      )
        return error(id, 'bad-request', 'Machine access requires an absolute cwd and an optional valid setup ticket.');
      const ticket = typeof params.ticket === 'string' ? params.ticket : undefined;
      subscribeLifecycle(id, params.cwd, owner, 'machine-access', (cwd, _admit, onProgress) =>
        machineAccessAction(cwd, options.env, actionLimits, ticket, onProgress),
      );
    }

    function subscribeWorktreeWarm(id: RequestId, params: unknown, owner: PairedDevice): void {
      if (!desktopSessions.has(socket))
        return error(
          id,
          'forbidden',
          'Warming worktrees requires the connection of the Stim Desktop that started this server.',
        );
      if (
        !isJsonObject(params) ||
        Object.keys(params).some((key) => key !== 'cwd') ||
        typeof params.cwd !== 'string' ||
        params.cwd.length > 4096 ||
        params.cwd.includes('\0') ||
        !isAbsolute(params.cwd)
      )
        return error(id, 'bad-request', 'Worktree warming requires only an absolute cwd.');
      const limits = { ...actionLimits, timeoutMs: options.actionLimits?.timeoutMs ?? 90 * 60_000 };
      subscribeLifecycle(id, params.cwd, owner, 'worktree-warm', (cwd, beforeWarm, onProgress) =>
        worktreeWarmAction(cwd, options.env, limits, { beforeWarm }, onProgress),
      );
    }

    function subscribeWorktreeRemove(id: RequestId, params: unknown, owner: PairedDevice): void {
      if (!desktopSessions.has(socket))
        return error(
          id,
          'forbidden',
          'Removing worktrees requires the connection of the Stim Desktop that started this server.',
        );
      if (
        !isJsonObject(params) ||
        Object.keys(params).some((key) => !['cwd', 'target', 'force'].includes(key)) ||
        typeof params.cwd !== 'string' ||
        params.cwd.length > 4096 ||
        params.cwd.includes('\0') ||
        !isAbsolute(params.cwd) ||
        (params.target !== undefined &&
          (typeof params.target !== 'string' ||
            params.target.length > 4096 ||
            params.target.includes('\0') ||
            !isAbsolute(params.target))) ||
        (params.force !== undefined && typeof params.force !== 'boolean')
      )
        return error(
          id,
          'bad-request',
          'Worktree removal requires an absolute cwd, optional absolute target and boolean force.',
        );
      const request = {
        target: typeof params.target === 'string' ? params.target : undefined,
        force: typeof params.force === 'boolean' ? params.force : undefined,
      };
      subscribeLifecycle(id, params.cwd, owner, 'worktree-remove', (cwd, beforeRemove, onProgress) =>
        worktreeRemoveAction(cwd, options.env, actionLimits, { ...request, beforeRemove }, onProgress),
      );
    }

    function subscribeLifecycle(
      id: RequestId,
      requestedCwd: string,
      owner: PairedDevice,
      kind: 'start' | 'run' | 'build' | 'gc' | 'worktree-remove' | 'worktree-warm' | 'machine-access',
      begin: (
        cwd: string,
        admit: (workspace: string) => void,
        progress: (value: StimProgress) => void,
      ) => ReturnType<typeof startAction>,
      platform?: PlatformRunOptions['platform'],
    ): void {
      let cwd: string;
      try {
        cwd = realpathSync(requestedCwd);
        if (!lstatSync(cwd).isDirectory()) throw new Error('The workspace is not a directory.');
      } catch (cause) {
        return error(id, 'bad-request', `Cannot ${kind} this workspace: ${readFailure(cause)}`);
      }
      if (slotsFull()) return error(id, 'limit-exceeded', slotsMessage());
      if (busyWorkspaces.has(cwd)) return error(id, 'action-busy', `An action is already running in ${cwd}.`);
      const subscription = openSubscription(id);
      if (!subscription) return;
      const startedAt = Date.now();
      let admittedCwd = cwd;
      const admittedWorkspaces = new Set<string>();
      let observing = true;
      let terminal: StartOutcome | undefined;
      const finish = (outcome: StartOutcome) => {
        terminal ??= outcome;
        if (!observing) return;
        observing = false;
        subscriptions.delete(subscription);
        send(socket, {
          event: `desktop-${kind}-ended`,
          subscription,
          exitCode: outcome.ok ? 0 : 1,
          stdout: outcome.stdout ?? '',
          message: outcome.ok ? outcome.summary : outcome.message,
        });
      };
      const run = begin(
        cwd,
        (workspace) => {
          if (admittedWorkspaces.has(workspace)) return;
          if (workspace !== cwd && busyWorkspaces.has(workspace))
            throw new StimError({ code: 'STIM_ACTION_BUSY', message: `An action is already running in ${workspace}.` });
          if (admittedWorkspaces.size === 0) admittedCwd = workspace;
          admittedWorkspaces.add(workspace);
          busyWorkspaces.add(workspace);
        },
        (progress) => {
          if (observing) send(socket, { event: `desktop-${kind}-progress`, subscription, ...progress });
        },
      );
      const cancel = async () => {
        await run.cancel();
      };
      holdSlot(cancel);
      running.add(cancel);
      busyWorkspaces.add(cwd);
      subscriptions.set(subscription, async (): Promise<ProtocolError | void> => {
        observing = false;
        const outcome = await run.cancel();
        if (!outcome.ok && outcome.unresolved) return { code: 'action-failed', message: outcome.message };
        return undefined;
      });
      void run.outcome.then(finish);
      void run.drained.then((outcome) => {
        if (kind === 'gc' || kind === 'worktree-remove' || kind === 'worktree-warm' || kind === 'machine-access')
          desktopReports.invalidate();
        const release = () => {
          releaseSlot(cancel);
          running.delete(cancel);
          busyWorkspaces.delete(cwd);
          for (const workspace of admittedWorkspaces) busyWorkspaces.delete(workspace);
        };
        const roots = outcome.retainedClaimRoots;
        if (outcome.unresolved) {
          const reconcile = () => {
            if (!roots?.length) return;
            if (
              roots.some((root) => {
                const claims = readClaimSet(root);
                return claims.live.length > 0 || claims.unresolved.length > 0;
              })
            )
              return;
            release();
            retainedLifecycles.delete(reconcile);
          };
          retainedLifecycles.add(reconcile);
        } else {
          release();
        }
        const recorded = terminal ?? outcome;
        auditSafely({
          at: new Date(startedAt).toISOString(),
          device: { id: owner.id, name: owner.name },
          action: kind,
          workspace: admittedCwd,
          ...(platform ? { platform } : {}),
          ok: recorded.ok,
          durationMs: Date.now() - startedAt,
          ...(recorded.ok
            ? {}
            : {
                error: {
                  code: 'action-failed',
                  message: outcome.unresolved
                    ? 'STIM_CLAIM_UNAVAILABLE'
                    : recorded.code ||
                      (kind === 'start'
                        ? 'STIM_METRO_START_FAILED'
                        : kind === 'gc'
                          ? 'STIM_GC_FAILED'
                          : kind === 'build'
                            ? 'STIM_BUILD_FAILED'
                            : 'STIM_RUN_FAILED'),
                },
              }),
        });
        return undefined;
      });
    }

    function writeDesktopSetting(id: RequestId, params: unknown, owner: PairedDevice): void {
      if (
        !isJsonObject(params) ||
        typeof params.cwd !== 'string' ||
        !isAbsolute(params.cwd) ||
        params.cwd.length > 4096 ||
        params.cwd.includes('\0') ||
        typeof params.key !== 'string' ||
        params.key.length === 0 ||
        params.key.length > 256 ||
        (params.action !== 'set' && params.action !== 'unset') ||
        (params.action === 'set' ? typeof params.value !== 'string' : 'value' in params) ||
        Object.keys(params).some((key) => !['cwd', 'key', 'scope', 'action', 'value'].includes(key))
      )
        return error(
          id,
          'bad-request',
          'Choose an absolute cwd, setting key, set/unset action and optional scope; set requires text value.',
        );
      const scope = SETTING_SCOPES.find((candidate) => candidate === params.scope);
      if (params.scope !== undefined && scope === undefined)
        return error(id, 'bad-request', 'Choose a settings scope.');
      let cwd: string;
      try {
        cwd = realpathSync(params.cwd);
        if (!lstatSync(cwd).isDirectory()) throw new Error('The settings folder is not a directory.');
      } catch (cause) {
        return error(id, 'bad-request', `Cannot change settings here: ${readFailure(cause)}`);
      }
      if (slotsFull()) return error(id, 'limit-exceeded', slotsMessage());
      if (busyWorkspaces.has(cwd)) return error(id, 'action-busy', `An action is already running in ${cwd}.`);
      const { key, action } = params;
      const value = typeof params.value === 'string' ? params.value : undefined;
      const startedAt = Date.now();
      const abort = new AbortController();
      let finished = false;
      let ok = false;
      let failureCode = 'STIM_CANCELLED';
      let writtenScope = scope;
      let admittedCwd = cwd;
      let outputBytes = 0;
      const finish = (
        reply:
          | { result: Methods['desktop.settings.write']['result'] }
          | { error: { code: ErrorCode; message: string } },
      ) => {
        if (finished) return;
        if ('result' in reply && Buffer.byteLength(JSON.stringify(reply.result)) > actionLimits.maxOutputBytes)
          reply = { error: { code: 'action-failed', message: 'Settings write exceeded its output limit.' } };
        finished = true;
        if ('error' in reply) failureCode = reply.error.code;
        else if ('code' in reply.result) failureCode = reply.result.code;
        else {
          ok = true;
          writtenScope = reply.result.scope;
        }
        send(socket, { id, ...reply });
      };
      const deadline = setTimeout(() => {
        finish({
          error: {
            code: 'action-failed',
            message: `Settings write did not finish within ${actionLimits.timeoutMs / 1000} s.`,
          },
        });
        abort.abort();
      }, actionLimits.timeoutMs);
      const task = Promise.resolve()
        .then(async () => {
          const client = createStim({
            projectRoot: cwd,
            env: options.env,
            onProgress: ({ message }) => {
              outputBytes += Buffer.byteLength(message);
              if (outputBytes > actionLimits.maxOutputBytes) {
                finish({ error: { code: 'action-failed', message: 'Settings write exceeded its output limit.' } });
                abort.abort();
              }
            },
          });
          const beforeWrite = (project: string | null) => {
            if (project && project !== cwd) {
              if (busyWorkspaces.has(project)) {
                finish({ error: { code: 'action-busy', message: `An action is already running in ${project}.` } });
                abort.abort();
                abort.signal.throwIfAborted();
              }
              busyWorkspaces.add(project);
              admittedCwd = project;
            }
          };
          const result =
            value === undefined
              ? await client.unsetSetting(key, { scope, signal: abort.signal, beforeWrite })
              : await client.setSetting(key, value, { scope, signal: abort.signal, beforeWrite });
          finish({ result });
          return undefined;
        })
        .catch((cause: unknown) => {
          if (cause instanceof StimError)
            finish({ result: { code: cause.code, message: cause.message, remedy: cause.remedy } });
          else finish({ error: { code: 'action-failed', message: readFailure(cause) } });
        })
        .finally(() => {
          clearTimeout(deadline);
          releaseSlot(cancel);
          running.delete(cancel);
          busyWorkspaces.delete(cwd);
          busyWorkspaces.delete(admittedCwd);
          auditSafely({
            at: new Date(startedAt).toISOString(),
            device: { id: owner.id, name: owner.name },
            action: `settings.${action}`,
            workspace: admittedCwd,
            setting: settingDefinition(key)?.key,
            ...(writtenScope ? { scope: writtenScope } : {}),
            ok,
            durationMs: Date.now() - startedAt,
            ...(ok ? {} : { error: { code: 'action-failed', message: failureCode } }),
          });
        });
      const cancel = async () => {
        abort.abort();
        await task;
      };
      holdSlot(cancel);
      running.add(cancel);
      busyWorkspaces.add(cwd);
    }

    function collect(query: StimLogsOptions, cwd: string): Promise<NdjsonRecord[] | string> {
      const abort = new AbortController();
      const deadline = setTimeout(() => abort.abort(), commandLimits.timeoutMs);
      let task: Promise<NdjsonRecord[] | string>;
      const cancel = async () => {
        abort.abort();
        await task;
      };
      holdSlot(cancel);
      running.add(cancel);
      task = Promise.resolve()
        .then(() => createStim({ projectRoot: cwd, env: options.env }).logs({ ...query, signal: abort.signal }))
        .then(
          (records) =>
            Buffer.byteLength(records.map((record) => JSON.stringify(record)).join('\n')) > commandLimits.maxOutputBytes
              ? `stim logs printed more than ${commandLimits.maxOutputBytes} bytes.`
              : records,
          (cause: unknown) => readFailure(cause),
        )
        .finally(() => {
          clearTimeout(deadline);
          releaseSlot(cancel);
          running.delete(cancel);
        });
      return task;
    }

    function archiveDetail(id: RequestId, params: unknown): void {
      const target = isJsonObject(params) ? params : {};
      if (target.archive === undefined) return error(id, 'bad-request', 'archive.detail needs params.archive.');
      const targetError = readTargetError(target);
      if (targetError) return error(id, 'bad-request', targetError);
      const archive = target.archive as string;
      const dir = readDir(id, { archive });
      if (!dir) return;
      const result: ArchiveDetailResult = {
        builds: readBuildHistory(readArchiveState(archive)),
        recordings: listRecordedDevices(join(dir, 'recordings'), true)
          .filter((recorded) => !isLink(recorded.dir))
          .flatMap((recorded) => {
            const spans = recordedSpans(recorded.segments.filter((segment) => !isLink(segment.file)));
            return spans.length ? [{ platform: recorded.platform, slot: recorded.slot, spans }] : [];
          })
          .toSorted((a, b) => a.platform.localeCompare(b.platform) || a.slot.localeCompare(b.slot)),
      };
      send(socket, { id, result });
    }

    function replayRange(id: RequestId, params: unknown): void | Promise<void> {
      const target = isJsonObject(params) ? params : {};
      const { platform, slot } = target;
      const targetError = readTargetError(target);
      if (targetError) return error(id, 'bad-request', targetError);
      const workspace = target.workspace as string | undefined;
      const archive = target.archive as string | undefined;
      if (!RECORDING_PLATFORMS.includes(platform as RecordingPlatform)) {
        return error(
          id,
          'bad-request',
          'replay.range needs params.workspace or params.archive and params.platform (ios, android or web).',
        );
      }
      if (slot !== undefined && (typeof slot !== 'string' || !SLOT_NAME.test(slot))) {
        return error(id, 'bad-request', 'params.slot must be 1-64 letters, digits, underscores or hyphens.');
      }
      const cwd = readDir(id, { workspace, archive });
      if (!cwd) return;
      if (archive === undefined && slotsFull(2)) {
        return error(id, 'limit-exceeded', slotsMessage(2));
      }
      const slotName = slot ?? 'default';
      const spans = recordedSpans(
        listSegments(recordingDir(workspace, platform as RecordingPlatform, slotName, archive), archive !== undefined),
      );
      const replayTarget = { workspace, platform: platform as RecordingPlatform, slot: slotName };
      const state = {
        enabled: archive === undefined ? (recorder?.enabled(workspace!) ?? false) : false,
        recording: archive === undefined ? (recorder?.recording(replayTarget) ?? false) : false,
        spans,
      };
      if (!spans.length) return send(socket, { id, result: { ...state, markers: [] } });
      if (archive !== undefined) {
        return agentActionReaders().then((actions) => {
          const timeline = archivedTimeline(cwd, actions);
          const records = [
            ...queryJsonLogs({ records: timeline, sources: ['agent'], tail: 5000 }),
            ...queryJsonLogs({
              records: timeline,
              sources: ['metro', 'client', 'build', 'device'],
              minLevel: 'error',
              tail: 5000,
            }),
          ];
          const markers = timelineMarkers(records, platform as RecordingPlatform, slotName, spans[0]!.start);
          return send(socket, { id, result: { ...state, markers } });
        });
      }
      const since = `${Math.ceil((Date.now() - spans[0]!.start) / 60_000) + 1}m`;
      void Promise.all([
        collect({ sources: ['agent'], since, tail: 5000 }, cwd),
        collect({ sources: ['metro', 'client', 'build', 'device'], minLevel: 'error', since, tail: 5000 }, cwd),
      ]).then(([actions, errors]) => {
        const failed = [actions, errors].find((result) => typeof result === 'string');
        if (typeof failed === 'string') return error(id, 'stim-failed', failed);
        const records = [...(actions as NdjsonRecord[]), ...(errors as NdjsonRecord[])];
        const markers = timelineMarkers(records, platform as RecordingPlatform, slotName, spans[0]!.start);
        return send(socket, { id, result: { ...state, markers } });
      });
    }

    function replayKeyframe(id: RequestId, params: unknown): void | Promise<void> {
      const target = isJsonObject(params) ? params : {};
      const { platform, slot, at } = target;
      const targetError = readTargetError(target);
      if (targetError) return error(id, 'bad-request', targetError);
      const workspace = target.workspace as string | undefined;
      const archive = target.archive as string | undefined;
      if (!RECORDING_PLATFORMS.includes(platform as RecordingPlatform)) {
        return error(
          id,
          'bad-request',
          'replay.keyframe needs params.workspace or params.archive and params.platform (ios, android or web).',
        );
      }
      if (slot !== undefined && (typeof slot !== 'string' || !SLOT_NAME.test(slot))) {
        return error(id, 'bad-request', 'params.slot must be 1-64 letters, digits, underscores or hyphens.');
      }
      if (typeof at !== 'number' || !Number.isFinite(at))
        return error(id, 'bad-request', 'at must be epoch milliseconds.');
      if (!readDir(id, { workspace, archive })) return;
      if (keyframeReads >= MAX_KEYFRAME_READS) {
        return error(id, 'limit-exceeded', `A connection can read ${MAX_KEYFRAME_READS} keyframes at a time.`);
      }
      keyframeReads++;
      return segmentKeyframe(
        recordingDir(workspace, platform as RecordingPlatform, slot ?? 'default', archive),
        at,
        archive !== undefined,
      ).then((found) => {
        keyframeReads--;
        if (!found) return error(id, 'no-recording', 'Nothing was recorded for this device.');
        const { segment, unit } = found;
        return send(socket, {
          id,
          result: {
            start: segment.start,
            end: segment.end,
            at: unit.capturedAt,
            width: unit.width,
            height: unit.height,
            ...(unit.posture ? { posture: unit.posture } : {}),
            data: unit.data.toString('base64'),
          },
        });
      });
    }

    function setRecording(id: RequestId, params: unknown, session: PairedDevice): void {
      const enabled = isJsonObject(params) ? params.enabled : undefined;
      const record: AuditRecord = {
        at: new Date().toISOString(),
        device: { id: session.id, name: session.name },
        action: 'recording.set',
        workspace: null,
        ok: false,
      };
      const audit = (outcome: Pick<AuditRecord, 'ok' | 'error'>) => {
        try {
          appendAudit({ ...record, ...outcome });
        } catch (cause) {
          console.error(`stim-server: could not append to the action log: ${(cause as Error).message}`);
        }
      };
      const refuseSetting = (code: ErrorCode, message: string) => {
        audit({ ok: false, error: { code, message } });
        error(id, code, message);
      };
      if (!canControl(session)) {
        return refuseSetting(
          'forbidden',
          `This device can only read. On the machine, run \`stim-server devices grant ${session.id} --control\` to let it change settings.`,
        );
      }
      if (typeof enabled !== 'boolean') return refuseSetting('bad-request', 'params.enabled must be true or false.');
      recordingTurn = cancelling.track(
        recordingTurn
          .catch(() => {})
          .then(async () => {
            if (closing) return;
            const run = runStim(
              options.stimCli,
              options.env,
              ['settings', 'set', 'recording.enabled', String(enabled), '--scope', 'machine', '--json'],
              homedir(),
              actionLimits,
            );
            let stop!: () => void;
            const stopped = new Promise<null>((resolve) => {
              stop = () => resolve(null);
            });
            const cancel = () => {
              stop();
              return run.cancel();
            };
            running.add(cancel);
            const outcome = await Promise.race([run.outcome, stopped]);
            running.delete(cancel);
            if (!outcome) return;
            const printed = actionOutcome(outcome);
            if (!printed.ok) return refuseSetting('action-failed', printed.error.message);
            audit({ ok: true });
            const deleted = printed.output.recordingsDeleted;
            const recordingsDeleted = Array.isArray(deleted) ? deleted.filter((path) => typeof path === 'string') : [];
            return send(socket, { id, result: { enabled, recordingsDeleted } });
          }),
      );
    }

    function planBuild(id: RequestId, params: unknown): void {
      if (!isJsonObject(params)) return error(id, 'bad-request', 'params must be an object.');
      const { platform, slot } = params;
      if (platform !== 'ios' && platform !== 'android') {
        return error(id, 'bad-request', 'params.platform must be ios or android.');
      }
      if (slot !== undefined && (typeof slot !== 'string' || !SLOT_NAME.test(slot))) {
        return error(id, 'bad-request', 'params.slot must be 1-64 letters, digits, underscores or hyphens.');
      }
      const cwd = workspaceDir(id, params.workspace, true);
      if (!cwd) return;
      queuePlan(id, cwd, { platform, ...(slot === undefined ? {} : { slot }) }, 'build.plan');
    }

    function queuePlan(
      id: RequestId,
      cwd: string,
      plan: StimPlanOptions,
      method: 'build.plan' | 'desktop.plan.get',
      request?: string,
    ): void {
      if (request !== undefined && planRequests.size >= MAX_RETAINED_PLANS) {
        error(id, 'limit-exceeded', 'Acknowledge retained plan refusals before requesting more previews.');
        return;
      }
      let unresolved: DesktopPlanRefusal | undefined;
      const finished = inProcessRead<'build.plan' | 'desktop.plan.get'>(
        id,
        `stim ${plan.platform}`,
        async (signal) => {
          try {
            return await createStim({ projectRoot: cwd, env: options.env }).plan({ ...plan, signal });
          } catch (cause) {
            if (method !== 'desktop.plan.get' || !(cause instanceof StimError)) throw cause;
            const refusal = { code: cause.code, message: cause.message, remedy: cause.remedy };
            if (cause.code === 'STIM_CLAIM_UNAVAILABLE') unresolved = refusal;
            return refusal;
          }
        },
        options.commandLimits?.timeoutMs ?? PLAN_TIMEOUT_MS,
        planQueues.get(cwd) ?? null,
      );
      if (!finished) return;
      planQueues.set(cwd, finished.done);
      if (request !== undefined) planRequests.set(request, { cancel: finished.cancel, refusal: () => unresolved });
      void finished.done.finally(() => {
        if (planQueues.get(cwd) === finished.done) planQueues.delete(cwd);
        if (request !== undefined && planRequests.get(request)?.cancel === finished.cancel && !unresolved)
          planRequests.delete(request);
      });
    }

    function registerPush(id: RequestId, params: unknown, session: PairedDevice): void {
      const value = isJsonObject(params) ? params : {};
      const { token, events, ref } = value;
      const agentOnly = value.agentOnly ?? false;
      const stuckMinutes = value.stuckMinutes ?? DEFAULT_STUCK_MINUTES;
      const quietHours = value.quietHours === undefined ? null : parseQuietHours(value.quietHours);
      const levels = value.levels === undefined ? undefined : parseLevels(value.levels);
      if (
        typeof token !== 'string' ||
        !pushToken.test(token) ||
        !Array.isArray(events) ||
        events.length === 0 ||
        !events.every((event) => ([...PUSH_EVENTS, ...LEGACY_PUSH_EVENTS] as readonly unknown[]).includes(event)) ||
        typeof agentOnly !== 'boolean' ||
        typeof ref !== 'string' ||
        ref.length === 0 ||
        ref.length > 128 ||
        !validStuckMinutes(stuckMinutes) ||
        (value.quietHours !== undefined && quietHours === null) ||
        levels === null
      ) {
        return error(
          id,
          'bad-request',
          'push.register takes an Expo push token, one or more events from ' +
            `${PUSH_EVENTS.join(', ')}, a ref of 1 to 128 characters, and optionally stuckMinutes from 1 to 240 and ` +
            'quietHours { start, end, timeZone } in minutes after midnight and an IANA time zone, and levels ' +
            `mapping events to ${NOTIFICATION_LEVELS.join(' or ')}.`,
        );
      }
      const registered = setDevicePush(session.id, {
        token,
        events: pushEvents(events),
        ...(levels ? { levels } : {}),
        ref,
        registeredAt: new Date().toISOString(),
        stuckMinutes,
        quietHours,
      });
      if (!registered) return error(id, 'unauthorized', 'This device is no longer paired.');
      push.refresh();
      send(socket, { id, result: {} });
    }

    async function buildMethod(id: RequestId, method: string, params: unknown, session: PairedDevice): Promise<void> {
      if (!buildAllowed(session)) {
        return error(id, 'forbidden', `${method} needs build access, which this machine has not granted this device.`);
      }
      buildSession ??= builds.session(session.id, socket, (event) => send(socket, event));
      const answer =
        method === 'build.offer'
          ? await builds.offer(session.id, params, buildSession.signal)
          : method === 'build.sync'
            ? buildSession.sync(params)
            : method === 'build.start'
              ? await buildSession.start(params)
              : method === 'build.cancel'
                ? buildSession.cancel(params)
                : method === 'build.attach'
                  ? buildSession.attach(params)
                  : method === 'build.cached-artifact'
                    ? await buildSession.cachedArtifact(params)
                    : await buildSession.artifact(params);
      send(socket, 'error' in answer ? { id, error: answer.error } : { id, result: answer.result });
    }

    function desktopMethod(id: RequestId, method: string, params: unknown, owner: PairedDevice): Promise<void> | null {
      if (
        ![
          'route.setup',
          'machines.update.start',
          'machines.update.status',
          'device-host.sessions',
          'device-host.sessions.stop',
          'desktop.reports.get',
          'desktop.reports.subscribe',
          'desktop.reports.invalidate',
          'desktop.settings.get',
          'desktop.settings.schema',
          'desktop.settings.write',
          'desktop.logs.subscribe',
          'desktop.doctor.run',
          'desktop.machine-access.subscribe',
          'desktop.stop.subscribe',
          'desktop.reload.subscribe',
          'desktop.start.subscribe',
          'desktop.run.subscribe',
          'desktop.build.subscribe',
          'desktop.gc.subscribe',
          'desktop.worktree.remove.subscribe',
          'desktop.worktree.warm.subscribe',
          'desktop.plan.get',
          'desktop.plan.cancel',
        ].includes(method)
      )
        return null;
      // A server Desktop started holds its private key and admits only the socket that proved it; a server Desktop
      // adopted or one run on its own has no key and keeps serving these methods to this user's local socket.
      if (!local || (options.desktopBootstrap !== undefined && !desktopSessions.has(socket))) {
        return Promise.resolve(
          error(
            id,
            'forbidden',
            method === 'route.setup'
              ? 'Phone connection setup requires the connection of the Stim Desktop that started this server.'
              : method === 'desktop.doctor.run'
                ? 'Running project doctor requires the connection of the Stim Desktop that started this server.'
                : method === 'desktop.settings.write'
                  ? 'Changing settings requires the connection of the Stim Desktop that started this server.'
                  : method === 'desktop.reload.subscribe'
                    ? 'Reloading apps requires the connection of the Stim Desktop that started this server.'
                    : method === 'desktop.build.subscribe'
                      ? 'Building artifacts requires the connection of the Stim Desktop that started this server.'
                      : method === 'desktop.run.subscribe'
                        ? 'Running apps requires the connection of the Stim Desktop that started this server.'
                        : method === 'desktop.start.subscribe'
                          ? 'Starting dev servers requires the connection of the Stim Desktop that started this server.'
                          : method === 'desktop.stop.subscribe'
                            ? 'Stopping workspaces requires the connection of the Stim Desktop that started this server.'
                            : method.startsWith('desktop.')
                              ? 'Desktop operations require the connection of the Stim Desktop that started this server.'
                              : method.startsWith('device-host.sessions')
                                ? 'Listing or stopping hosted sessions requires the connection of the Stim Desktop that started this server.'
                                : 'Updating another machine requires the connection of the Stim Desktop that started this server.',
          ),
        );
      }
      if (method === 'desktop.settings.write') {
        if (!desktopSessions.has(socket)) {
          error(
            id,
            'forbidden',
            'Changing settings requires the connection of the Stim Desktop that started this server.',
          );
          return Promise.resolve();
        }
        writeDesktopSetting(id, params, owner);
        return Promise.resolve();
      }
      if (method === 'desktop.reload.subscribe') {
        if (!desktopSessions.has(socket)) {
          error(
            id,
            'forbidden',
            'Reloading apps requires the connection of the Stim Desktop that started this server.',
          );
          return Promise.resolve();
        }
        subscribeReload(id, params, owner);
        return Promise.resolve();
      }
      if (method === 'desktop.plan.cancel') {
        if (!desktopSessions.has(socket)) {
          error(
            id,
            'forbidden',
            'Cancelling a plan requires the connection of the Stim Desktop that started this server.',
          );
          return Promise.resolve();
        }
        if (!isJsonObject(params) || Object.keys(params).length !== 1 || !validPlanRequest(params.request)) {
          error(id, 'bad-request', 'Choose the request of this connection to cancel.');
          return Promise.resolve();
        }
        const request = params.request;
        const pending = planRequests.get(request);
        void (async () => {
          await pending?.cancel();
          const refusal = pending?.refusal();
          if (planRequests.get(request) === pending) planRequests.delete(request);
          send(socket, { id, result: { cancelled: pending !== undefined, ...(refusal ? { refusal } : {}) } });
        })();
        return Promise.resolve();
      }
      if (method === 'desktop.plan.get') {
        if (!desktopSessions.has(socket)) {
          error(
            id,
            'forbidden',
            'Planning builds requires the connection of the Stim Desktop that started this server.',
          );
          return Promise.resolve();
        }
        if (
          !isJsonObject(params) ||
          Object.keys(params).some(
            (key) => key !== 'cwd' && key !== 'platform' && key !== 'slot' && key !== 'request',
          ) ||
          typeof params.cwd !== 'string' ||
          params.cwd.length > 4096 ||
          !isAbsolute(params.cwd) ||
          (params.request !== undefined && !validPlanRequest(params.request)) ||
          (params.platform !== 'ios' && params.platform !== 'android' && params.platform !== 'macos') ||
          (params.slot !== undefined &&
            (params.platform === 'macos' || typeof params.slot !== 'string' || !SLOT_NAME.test(params.slot)))
        ) {
          error(
            id,
            'bad-request',
            'Choose an absolute cwd and ios/android/macos platform; slot applies only to ios/android.',
          );
          return Promise.resolve();
        }
        if (typeof params.request === 'string' && planRequests.has(params.request)) {
          error(id, 'bad-request', 'This connection already has a plan with that request.');
          return Promise.resolve();
        }
        let cwd: string;
        try {
          cwd = realpathSync(params.cwd);
          if (!lstatSync(cwd).isDirectory()) throw new Error('not a directory');
        } catch {
          error(id, 'bad-request', 'Choose an existing project directory.');
          return Promise.resolve();
        }
        const plan: StimPlanOptions =
          params.platform === 'macos'
            ? { platform: 'macos' }
            : { platform: params.platform, ...(params.slot === undefined ? {} : { slot: params.slot }) };
        queuePlan(id, cwd, plan, 'desktop.plan.get', typeof params.request === 'string' ? params.request : undefined);
        return Promise.resolve();
      }
      const cleanupSubscriptions: Record<string, typeof subscribeGc> = {
        'desktop.machine-access.subscribe': subscribeMachineAccess,
        'desktop.gc.subscribe': subscribeGc,
        'desktop.worktree.remove.subscribe': subscribeWorktreeRemove,
        'desktop.worktree.warm.subscribe': subscribeWorktreeWarm,
      };
      const subscribeCleanup = cleanupSubscriptions[method];
      if (subscribeCleanup) {
        subscribeCleanup(id, params, owner);
        return Promise.resolve();
      }
      if (method === 'desktop.build.subscribe') {
        if (!desktopSessions.has(socket)) {
          error(
            id,
            'forbidden',
            'Building artifacts requires the connection of the Stim Desktop that started this server.',
          );
          return Promise.resolve();
        }
        subscribeBuild(id, params, owner);
        return Promise.resolve();
      }
      if (method === 'desktop.run.subscribe') {
        if (!desktopSessions.has(socket)) {
          error(id, 'forbidden', 'Running apps requires the connection of the Stim Desktop that started this server.');
          return Promise.resolve();
        }
        subscribeRun(id, params, owner);
        return Promise.resolve();
      }
      if (method === 'desktop.start.subscribe') {
        if (!desktopSessions.has(socket)) {
          error(
            id,
            'forbidden',
            'Starting dev servers requires the connection of the Stim Desktop that started this server.',
          );
          return Promise.resolve();
        }
        subscribeStart(id, params, owner);
        return Promise.resolve();
      }
      if (method === 'desktop.stop.subscribe') {
        subscribeStop(id, params, owner);
        return Promise.resolve();
      }
      if (method === 'desktop.doctor.run') {
        if (
          !isJsonObject(params) ||
          Object.keys(params).some((key) => key !== 'cwd' && key !== 'platform') ||
          typeof params.cwd !== 'string' ||
          params.cwd.length > 4096 ||
          !isAbsolute(params.cwd) ||
          (params.platform !== undefined && params.platform !== 'ios' && params.platform !== 'android')
        ) {
          error(id, 'bad-request', 'Run project doctor with an absolute cwd and optional ios/android platform.');
          return Promise.resolve();
        }
        const cwd = resolvePath(params.cwd);
        const platform = params.platform === 'ios' || params.platform === 'android' ? params.platform : undefined;
        inProcessRead<'desktop.doctor.run'>(
          id,
          'stim doctor',
          async (signal) => ({
            ...(await createStim({ projectRoot: cwd, env: options.env }).doctor({ signal, platform, record: true })),
          }),
          options.commandLimits?.timeoutMs ?? DETAILS_TIMEOUT_MS,
        );
        return Promise.resolve();
      }
      if (method === 'desktop.settings.schema' || method === 'desktop.settings.get') {
        readDesktopSettings(id, method, params);
        return Promise.resolve();
      }
      if (method === 'desktop.logs.subscribe') {
        if (
          !isJsonObject(params) ||
          Object.keys(params).some((key) => !['workspace', 'sources', 'level', 'grep', 'errors'].includes(key))
        ) {
          error(id, 'bad-request', 'Choose a workspace and optional sources, level, grep or errors filter.');
          return Promise.resolve();
        }
        return Promise.resolve(subscribeLogs(id, params, true));
      }
      if (method.startsWith('desktop.reports.')) {
        desktopReport(id, method, params);
        return Promise.resolve();
      }
      if (method.startsWith('device-host.sessions')) return hostedSessions(id, method, params);
      return method === 'route.setup' ? setupRoute(id, params) : updateMachine(id, method, params);
    }

    function readDesktopSettings(id: RequestId, method: string, params: unknown): void {
      if (method === 'desktop.settings.schema') {
        if (params !== undefined && (!isJsonObject(params) || Object.keys(params).length)) {
          return error(id, 'bad-request', 'desktop.settings.schema takes no parameters.');
        }
        return send(socket, { id, result: settingsJsonSchema() });
      }
      if (
        !isJsonObject(params) ||
        Object.keys(params).some((key) => key !== 'cwd') ||
        typeof params.cwd !== 'string' ||
        params.cwd.length > 4096 ||
        !isAbsolute(params.cwd)
      ) {
        return error(id, 'bad-request', 'Choose settings with an absolute cwd.');
      }
      const cwd = resolvePath(params.cwd);
      inProcessRead<'desktop.settings.get'>(id, 'stim settings', (signal) =>
        createStim({ projectRoot: cwd, env: options.env }).settings({ signal }),
      );
    }

    function desktopReport(id: RequestId, method: string, params: unknown): void {
      if (
        method === 'desktop.reports.invalidate' &&
        (params === undefined || (isJsonObject(params) && !Object.keys(params).length))
      ) {
        desktopReports.invalidate();
        return send(socket, { id, result: {} });
      }
      if (
        !isJsonObject(params) ||
        (params.report !== 'doctor' && params.report !== 'gc') ||
        Object.keys(params).some(
          (key) => key !== 'report' && (params.report !== 'doctor' || (key !== 'cwd' && key !== 'platform')),
        ) ||
        (params.report === 'doctor' &&
          (typeof params.cwd !== 'string' ||
            params.cwd.length > 4096 ||
            !isAbsolute(params.cwd) ||
            (params.platform !== undefined && params.platform !== 'ios' && params.platform !== 'android')))
      )
        return error(
          id,
          'bad-request',
          'Choose report gc, or report doctor with an absolute cwd and optional ios/android platform.',
        );
      const target: DesktopReportTarget =
        params.report === 'gc'
          ? { report: 'gc' }
          : {
              report: 'doctor',
              cwd: resolvePath(String(params.cwd)),
              ...(params.platform === 'ios' || params.platform === 'android' ? { platform: params.platform } : {}),
            };
      if (method === 'desktop.reports.invalidate') {
        desktopReports.invalidate(target);
        return send(socket, { id, result: {} });
      }
      if (method === 'desktop.reports.get') {
        return void inProcessRead<'desktop.reports.get'>(
          id,
          `stim ${target.report}`,
          async (signal) => {
            const snapshot = await desktopReports.get(target, signal);
            if (snapshot.error) throw new Error(snapshot.error);
            return snapshot;
          },
          options.commandLimits?.timeoutMs ?? DETAILS_TIMEOUT_MS,
          null,
          true,
        );
      }
      const subscription = openSubscription(id);
      if (!subscription) return;
      subscriptions.set(
        subscription,
        desktopReports.subscribe(target, (snapshot) =>
          send(socket, { event: 'desktop-report', subscription, target, snapshot }),
        ),
      );
    }

    async function hostedSessions(id: RequestId, method: string, params: unknown): Promise<void> {
      if (
        method === 'device-host.sessions' &&
        params !== undefined &&
        (!isJsonObject(params) || Object.keys(params).length)
      )
        return error(id, 'bad-request', 'device-host.sessions takes no parameters.');
      if (
        method === 'device-host.sessions.stop' &&
        (!isJsonObject(params) ||
          typeof params.session !== 'string' ||
          Object.keys(params).some((key) => key !== 'session'))
      )
        return error(id, 'bad-request', 'device-host.sessions.stop needs params.session.');
      const answer =
        method === 'device-host.sessions'
          ? hostedDevices.sessions()
          : hostedDevices.stopForPerson((params as { session: string }).session);
      return send(socket, 'error' in answer ? { id, error: answer.error } : { id, result: answer.result });
    }

    async function setupRoute(id: RequestId, params: unknown): Promise<void> {
      if (params !== undefined && (!isJsonObject(params) || Object.keys(params).length)) {
        return error(id, 'bad-request', 'route.setup takes no parameters.');
      }
      settingUpRoute ??= tailscale.setupRoute(addresses[0]!.port).finally(() => {
        settingUpRoute = null;
      });
      try {
        return send(socket, { id, result: await settingUpRoute });
      } catch (cause) {
        return error(id, 'action-failed', (cause as Error).message);
      }
    }

    async function updateMachine(id: RequestId, method: string, params: unknown): Promise<void> {
      const machine = isJsonObject(params) ? params.machine : undefined;
      if (typeof machine !== 'string' || !machine) return error(id, 'bad-request', 'params.machine names the machine.');
      const answer =
        method === 'machines.update.start' ? await machineUpdates.start(machine) : await machineUpdates.status(machine);
      return send(socket, 'error' in answer ? { id, error: answer.error } : { id, result: answer.result });
    }

    function machineMethod(
      id: RequestId,
      method: string,
      params: unknown,
      session: PairedDevice,
    ): Promise<void> | null {
      if ((BUILD_METHODS as readonly string[]).includes(method)) return buildMethod(id, method, params, session);
      if ((SERVER_UPDATE_METHODS as readonly string[]).includes(method))
        return updateMethod(id, method, params, session);
      return null;
    }

    async function updateMethod(id: RequestId, method: string, params: unknown, session: PairedDevice): Promise<void> {
      const approved =
        !local &&
        (readBuildClients().some((entry) => entry.id === session.id && entry.capabilities.includes('build')) ||
          readDeviceHostClients().some(
            (entry) => entry.id === session.id && entry.capabilities.includes('device-host'),
          ));
      if (!approved) {
        return error(
          id,
          'forbidden',
          `${method} needs this machine's build or device-host approval of the requesting machine.`,
        );
      }
      if (method === 'server.update.status') return send(socket, { id, result: await updates.status() });
      const answer =
        method === 'server.update.start'
          ? await updates.start({ id: session.id, name: session.name }, params)
          : updates.chunk(session.id, params);
      send(socket, 'error' in answer ? { id, error: answer.error } : { id, result: answer.result });
    }

    function handleBinary(frame: Buffer): void {
      if (socket.readyState !== socket.OPEN) return;
      if (!device || !buildSession) {
        return void socket.close(CLOSE_BAD_REQUEST, 'unexpected binary frame');
      }
      const refused = buildSession.blob(frame);
      if (refused) socket.close(CLOSE_BAD_REQUEST, refused.slice(0, 120));
    }

    async function hostedMethod(id: RequestId, method: string, raw: unknown, session: PairedDevice): Promise<void> {
      const params = isJsonObject(raw) ? raw : {};
      if (method === 'device-host.frames.subscribe' || method === 'device-host.control.begin') {
        if (typeof params.session !== 'string') return error(id, 'bad-request', 'A hosted session is required.');
        if (
          method === 'device-host.control.begin' &&
          params.takeOver !== undefined &&
          typeof params.takeOver !== 'boolean'
        )
          return error(id, 'bad-request', 'takeOver must be true or false.');
        if (method === 'device-host.frames.subscribe' && (params.at !== undefined || params.rate !== undefined))
          return error(id, 'bad-request', 'Hosted recorded replay is not supported.');
        try {
          const hostedSession = params.session;
          if (method === 'device-host.frames.subscribe') {
            const view = hostedViews.target(session.id, hostedSession);
            return subscribeFrames(
              id,
              { ...params, workspace: view.workspace, platform: view.device.platform, slot: view.slot },
              { client: session.id, session: hostedSession, view },
            );
          }
          const owner = controller(session);
          const outcome = await hostedViews.begin(
            session.id,
            hostedSession,
            owner,
            params.takeOver === true,
            () => socket.readyState === socket.OPEN && controllers.get(socket) === owner,
          );
          return 'code' in outcome ? error(id, outcome.code, outcome.message) : send(socket, { id, result: outcome });
        } catch (cause) {
          return error(id, 'action-failed', (cause as Error).message);
        }
      }
      if (method === 'device-host.frames.keyframe') {
        const name = params.subscription;
        const keyframe = typeof name === 'string' ? keyframes.get(name) : undefined;
        if (!keyframe) return error(id, 'unknown-subscription', `No video subscription ${String(name)}.`);
        keyframe();
        return send(socket, { id, result: {} });
      }
      if (method === 'device-host.frames.congested') {
        const name = params.subscription;
        const congested = typeof name === 'string' ? congestion.get(name) : undefined;
        if (!congested) return error(id, 'unknown-subscription', `No video subscription ${String(name)}.`);
        congested();
        return send(socket, { id, result: {} });
      }
      if (method === 'device-host.unsubscribe') return unsubscribeRequest(id, params.subscription);
      if (method === 'device-host.control.end') {
        const name = params.session;
        if (typeof name !== 'string' || !control.endById(controller(session), name))
          return error(id, 'unknown-session', `No control session ${String(name)} on this connection.`);
        return send(socket, { id, result: {} });
      }
      if (method.startsWith('device-host.input.')) {
        const inputMethod = method.slice('device-host.'.length) as (typeof INPUT_METHODS)[number];
        return input(id, inputMethod, raw, session);
      }
      const answer =
        method === 'device-host.offer'
          ? await hostedDevices.offer(session.id, raw)
          : method === 'device-host.reserve'
            ? await hostedDevices.reserve(session.id, raw)
            : method === 'device-host.attach'
              ? hostedDevices.attach(session.id, raw)
              : method === 'device-host.stop'
                ? hostedDevices.stop(session.id, raw)
                : method === 'device-host.app.offer'
                  ? hostedDevices.appOffer(session.id, raw)
                  : method === 'device-host.app.chunk'
                    ? await hostedDevices.appChunk(session.id, raw)
                    : method === 'device-host.app.handoff'
                      ? await hostedDevices.appHandoff(session.id, raw)
                      : method === 'device-host.app.launch'
                        ? hostedDevices.appLaunch(session.id, raw)
                        : method === 'device-host.app.attach'
                          ? hostedDevices.appAttach(session.id, raw)
                          : method === 'device-host.logs.query'
                            ? await hostedDevices.logsQuery(session.id, raw)
                            : method === 'device-host.metro.open'
                              ? await hostedDevices.metroOpen(session.id, raw, peer)
                              : method === 'device-host.metro.ports'
                                ? await hostedDevices.metroPorts(session.id, raw)
                                : await hostedDevices.metroClose(session.id, raw);
      return send(socket, 'error' in answer ? { id, error: answer.error } : { id, result: answer.result });
    }

    /**
     * Admits this local-socket connection to the Desktop-only methods when it proves the bundled Desktop's private key
     * against this connection's challenge. The challenge answers one attempt, so a replayed or late proof cannot win.
     */
    function authenticateDesktop(id: RequestId, params: unknown): void {
      const challenge = desktopChallenge;
      desktopChallenge = null;
      if (
        !local ||
        !challenge ||
        !isJsonObject(params) ||
        Object.keys(params).some((key) => key !== 'proof') ||
        !options.desktopBootstrap?.verify(challenge.nonce, params.proof)
      ) {
        return error(id, 'forbidden', 'The private Desktop bootstrap proof of this connection is required.');
      }
      desktopSessions.add(socket);
      send(socket, { id, result: { authorized: true } });
    }

    async function unsubscribeRequest(id: RequestId, name: unknown): Promise<void> {
      if (typeof name !== 'string') return error(id, 'unknown-subscription', `No subscription ${String(name)}.`);
      const unsubscribe = subscriptions.get(name);
      if (!unsubscribe) return error(id, 'unknown-subscription', `No subscription ${name}.`);
      subscriptions.delete(name);
      const failure = await unsubscribe();
      send(socket, failure ? { id, error: failure } : { id, result: {} });
    }

    async function handle(raw: string): Promise<void> {
      if (socket.readyState !== socket.OPEN) return;
      let message: unknown;
      try {
        message = JSON.parse(raw);
      } catch {
        message = null;
      }
      const id = isJsonObject(message) ? requestId(message.id) : null;
      if (!isJsonObject(message) || id === null || typeof message.method !== 'string') {
        if (device)
          return send(socket, { id, error: { code: 'bad-request', message: 'Expected {id, method, params}.' } });
        return refuse(id, 'bad-request', 'Expected {id, method, params}.', CLOSE_BAD_REQUEST);
      }
      tracker.begin(id, message.method);
      if (message.method === 'hello') return hello(id, message.params);
      if (!device) return refuse(id, 'unauthorized', 'Send hello first.', CLOSE_REFUSED);
      if (message.method === 'desktop.authenticate') return authenticateDesktop(id, message.params);
      for (const reconcile of retainedLifecycles) reconcile();
      if ((DEVICE_HOST_METHODS as readonly string[]).includes(message.method)) {
        if (!device.capabilities.includes('device-host'))
          return error(id, 'forbidden', 'Explicit device-host approval is required.');
        return hostedMethod(id, message.method, message.params, device);
      }
      const approvedMachine = machineMethod(id, message.method, message.params, device);
      if (approvedMachine) return approvedMachine;
      const desktop = desktopMethod(id, message.method, message.params, device);
      if (desktop) return desktop;
      if (!device.capabilities.includes('read')) {
        return error(id, 'forbidden', `${message.method} needs read access, which this connection does not have.`);
      }
      if (isJsonObject(message.params) && typeof message.params.archive === 'string') {
        const params = message.params;
        const reads: Partial<Record<string, (id: RequestId, params: unknown) => void | Promise<void>>> = {
          'logs.subscribe': subscribeLogs,
          'logs.query': queryLogs,
          'frames.subscribe': subscribeFrames,
          'replay.range': replayRange,
          'archive.detail': archiveDetail,
          'replay.keyframe': replayKeyframe,
        };
        const read = reads[message.method];
        if (read) return archiveRead(id, () => read(id, params));
      }
      if (message.method === 'status.subscribe') return subscribeStatus(id);
      const statusMethod = statusMethods[message.method];
      if (statusMethod) return void statusMethod(id, message.params);
      if (message.method === 'logs.subscribe') return subscribeLogs(id, message.params);
      if (message.method === 'logs.query') return queryLogs(id, message.params);
      if (message.method === 'frames.subscribe') return subscribeFrames(id, message.params);
      if (message.method === 'frames.keyframe') {
        const name = isJsonObject(message.params) ? message.params.subscription : undefined;
        if (typeof name === 'string' && relay.keyframe(id, name)) return;
        const keyframe = typeof name === 'string' ? keyframes.get(name) : undefined;
        if (!keyframe) {
          return send(socket, {
            id,
            error: { code: 'unknown-subscription', message: `No video subscription ${String(name)}.` },
          });
        }
        keyframe();
        return send(socket, { id, result: {} });
      }
      if (message.method === 'frames.seek' || message.method === 'frames.live') {
        const params = isJsonObject(message.params) ? message.params : {};
        const replayable = typeof params.subscription === 'string' ? replays.get(params.subscription) : undefined;
        if (!replayable) {
          return error(id, 'unknown-subscription', `No video subscription ${String(params.subscription)}.`);
        }
        if (message.method === 'frames.live') {
          const refused = replayable.live();
          return refused ? error(id, 'frames-failed', refused) : send(socket, { id, result: {} });
        }
        const parsed = parseReplay(params.at, params.rate);
        if (!parsed || typeof parsed === 'string') {
          return error(id, 'bad-request', parsed ?? 'frames.seek needs params.at and params.rate.');
        }
        const shown = replayable.seek(parsed.at, parsed.rate);
        if (shown === null) return error(id, 'no-recording', 'Nothing was recorded for this device.');
        return send(socket, { id, result: { at: shown } });
      }
      if (message.method === 'replay.range') return replayRange(id, message.params);
      if (message.method === 'archive.detail') return archiveDetail(id, message.params);
      if (message.method === 'replay.keyframe') {
        void replayKeyframe(id, message.params);
        return;
      }
      if (message.method === 'recording.set') return setRecording(id, message.params, device);
      if (message.method === 'build.plan') return planBuild(id, message.params);
      if (message.method === 'machine.get') return send(socket, { id, result: await readMachineUsage() });
      if (message.method === 'machine.details') {
        const machinesPart = buildMachines.snapshot((cwd) => readDetailsReport('doctor', cwd), doctorTarget());
        void machineDetails.get().then((result) => send(socket, { id, result: { ...result, ...machinesPart } }));
        return;
      }
      if (message.method === 'machine.history') {
        const params = message.params ?? {};
        const sinceMs = isJsonObject(params) ? params.sinceMs : undefined;
        if (!isJsonObject(params) || (sinceMs !== undefined && typeof sinceMs !== 'number')) {
          return error(id, 'bad-request', 'machine.history takes an optional numeric sinceMs.');
        }
        return send(socket, { id, result: sampler.history(sinceMs) });
      }
      if (isWorkspaceChangeMethod(message.method)) {
        return workspaceChanges(id, message.method, message.params);
      }
      if (message.method === 'stats.get' || message.method === 'settings.get') {
        return workspaceCommand(id, message.method, message.params);
      }
      if (message.method === 'action') return runAction(id, message.params, device);
      if (message.method === 'control.begin') {
        void beginControl(id, message.params, device);
        return;
      }
      if (message.method === 'control.end') {
        if (relay.control(id, message.method, message.params)) return;
        const name = isJsonObject(message.params) ? message.params.session : undefined;
        if (typeof name !== 'string' || !control.endById(controller(device), name)) {
          return error(id, 'unknown-session', `No control session ${String(name)} on this connection.`);
        }
        return send(socket, { id, result: {} });
      }
      const inputMethod = INPUT_METHODS.find((method) => method === message.method);
      if (inputMethod) {
        void input(id, inputMethod, message.params, device);
        return;
      }
      if (message.method === 'push.register') return registerPush(id, message.params, device);
      if (message.method === 'notifications.list') {
        const params = message.params ?? {};
        const since = isJsonObject(params) ? params.since : undefined;
        if (
          !isJsonObject(params) ||
          (since !== undefined && !(typeof since === 'number' && Number.isInteger(since) && since >= 0))
        ) {
          return error(id, 'bad-request', 'notifications.list takes an optional since, a cursor of 0 or more.');
        }
        listeners.add(socket);
        return send(socket, { id, result: notificationLog.list(device.id, since) });
      }
      if (message.method === 'push.unregister') {
        setDevicePush(device.id, null);
        push.refresh();
        return send(socket, { id, result: {} });
      }
      if (message.method === 'unsubscribe')
        return unsubscribeRequest(id, isJsonObject(message.params) ? message.params.subscription : undefined);
      send(socket, { id, error: { code: 'unknown-method', message: `Unknown method ${message.method}.` } });
    }

    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        const frame = Buffer.isBuffer(data) ? data : Buffer.concat(Array.isArray(data) ? data : [Buffer.from(data)]);
        queue = queue.then(() => handleBinary(frame)).catch(() => socket.close(1011, 'internal error'));
        return;
      }
      const raw = data.toString();
      queue = queue.then(() => handle(raw)).catch(() => socket.close(1011, 'internal error'));
    });
    socket.on('close', (code) => {
      relay.close();
      relays.delete(socket);
      clearTimeout(timer);
      buildSession?.close(code === CLOSE_ABNORMAL && device !== null && buildAllowed(device));
      sessions.delete(socket);
      desktopSessions.delete(socket);
      listeners.delete(socket);
      if (sessions.size === 0) sampler.stop();
      const owner = controllers.get(socket);
      if (owner) control.endFor(owner, null, 'The client disconnected.');
      controllers.delete(socket);
      for (const unsubscribe of subscriptions.values()) unsubscribe();
      subscriptions.clear();
      for (const cancel of [...commands, ...reportWaits]) {
        if (persistentActions.has(cancel)) {
          releaseSlot(cancel);
          continue;
        }
        running.delete(cancel);
        void cancelling.track(cancel());
      }
    });
  }

  function upgrade(request: IncomingMessage, socket: Socket, head: Buffer): void {
    if (startup.state !== 'ready') {
      socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const peer = peerAddress(request);
    if (options.loopbackOnly && peer !== null) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    if (upgradeFromWebPage(request.headers, arrival(request))) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    if (limiter.blocked(peer ?? 'local')) {
      socket.end('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      const idle = setTimeout(() => {
        limiter.record(peer ?? 'local');
        ws.close(CLOSE_AUTH_TIMEOUT, 'authentication timeout');
      }, authTimeoutMs);
      ws.once('close', () => clearTimeout(idle));
      ws.once('message', (data, isBinary) => {
        clearTimeout(idle);
        void authenticate(ws, request, peer, data, isBinary);
      });
    });
  }

  /**
   * Runs the Noise handshake on a network connection and finds the client's records: a first-contact client spends
   * its pairing token or setup ticket, a returning client must already have a record for its key. The network address
   * only keys rate limits and labels the record.
   */
  async function authenticate(
    ws: WebSocket,
    request: IncomingMessage,
    peer: string | null,
    data: unknown,
    isBinary: boolean,
  ): Promise<void> {
    const limitKey = peer ?? 'local';
    /**
     * `unknown-secret` is not a failure: a requester polls with its setup ticket until `stim-server setup` stores it,
     * and a 16-byte lookup reveals nothing without the PSK.
     */
    const refuse = (code: string) => {
      if (code !== 'unknown-secret') limiter.record(limitKey);
      if (ws.readyState === ws.OPEN) ws.close(CLOSE_REFUSED, code);
    };
    try {
      serverKey ??= serverIdentity();
    } catch (error) {
      console.error(`stim-server: cannot read the server key: ${(error as Error).message}`);
      return void ws.close(1011, 'server key unavailable');
    }
    let accepted;
    try {
      accepted = await acceptNoise(ws, data, isBinary, {
        keyPair: serverKey,
        psk: (lookup) => secretPsk(lookup),
        timeoutMs: authTimeoutMs,
      });
    } catch (error) {
      if (!(error instanceof HandshakeRefusal && error.code === 'unknown-secret')) limiter.record(limitKey);
      return;
    }
    const publicKey = accepted.clientKey.toString('base64url');
    let records: KeyRecords | null;
    if (accepted.mode === MODE_FIRST_CONTACT) {
      let name = '';
      try {
        const payload = JSON.parse(accepted.payload.toString('utf8')) as { name?: unknown };
        if (typeof payload.name === 'string') name = payload.name;
      } catch {
        return refuse('bad-request');
      }
      const from = peer ? await describePeer(request, peer) : 'this machine';
      if (ws.readyState !== ws.OPEN) return;
      records = spendSecret(accepted.lookup!, publicKey, name, from);
      if (!records) return refuse('unknown-secret');
      if (!records.device && !records.build && !records['device-host']) return refuse('unauthorized');
    } else {
      records = recordsForKey(publicKey);
      if (!records.device && !records.build && !records['device-host']) return refuse('unauthorized');
    }
    if (ws.readyState !== ws.OPEN) return;
    unauthenticated.settle(request.socket);
    const host = records['device-host'];
    if (host) {
      const node = peer ? await peerNode(request, peer) : null;
      if (node) agentNodes.set(host.id, node);
      else agentNodes.delete(host.id);
      if (ws.readyState !== ws.OPEN) return;
    }
    connection(accepted.socket, peer, false, publicKey);
  }

  function upgradeLocal(request: IncomingMessage, socket: Socket, head: Buffer): void {
    if (startup.state !== 'ready') {
      socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    if (request.headers.origin !== undefined || request.headers['sec-fetch-site'] !== undefined) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    localWss.handleUpgrade(request, socket, head, (ws) => connection(ws, null, true, null));
  }

  const health = {
    server: 'stim-server',
    name: options.name,
    version: options.serverVersion,
    stim: options.stimVersion,
    stimBuild: ownStimBuild,
    protocol: PROTOCOL_VERSION,
    stimHome: configDir(),
  } as const;
  const lanHealth = (): Pick<ServerHealth, 'lan'> => {
    const wanted = new Set(
      transports
        .filter((transport) => transport.id === 'local')
        .flatMap((transport) => transport.bindAddresses?.() ?? []),
    );
    const bound = addresses.filter(({ host }) => wanted.has(host));
    const [first] = bound;
    return first ? { lan: { addresses: bound.map(({ host }) => host), port: first.port } } : {};
  };
  const answerHealth = async (response: ServerResponse) => {
    const { state } = tailscale.snapshot();
    const route =
      state.state === 'running' && state.dnsName
        ? await tailscale.serveRoute(addresses[0]!.port, HEALTH_ROUTE_TIMEOUT_MS)
        : undefined;
    const body: ServerHealth = {
      ...health,
      startup,
      ...(options.host ? { host: await hostHealth() } : {}),
      busy: { builds: builds.running(), hostedSessions: hostedDevices.active() },
      tailscale: healthTailscale(state),
      route,
      nativeViewerOpened,
      ...(options.loopbackOnly ? { loopbackOnly: true as const } : {}),
      ...lanHealth(),
    };
    response
      .writeHead(startup.state === 'ready' ? 200 : 503, { 'content-type': 'application/json' })
      .end(JSON.stringify(body));
  };
  const servers = new Map<string, { server: Server; sockets: Set<Socket> }>();
  const addresses: RunningServer['addresses'] = [];
  const close = async () => {
    const failures: unknown[] = [];
    const settle = async (work: Promise<unknown>) => {
      try {
        await work;
      } catch (error) {
        failures.push(error);
      }
    };
    closing = true;
    desktopReports.close();
    if (startupRetry) clearTimeout(startupRetry);
    if (setupPruneTimer) clearInterval(setupPruneTimer);
    startupProbe?.cancel();
    watcher?.close();
    if (revocationPoll) clearInterval(revocationPoll);
    if (revocationCheck) clearTimeout(revocationCheck);
    await settle(builds.close());
    for (const client of [...wss.clients, ...localWss.clients]) client.terminate();
    hostConnections.close();
    if (startup.state === 'ready') {
      push.close();
      helperAbort.abort();
      sampler.stop();
      await settle(control.close());
      await settle(agentDrivers.close());
      await settle(hostedDevices.close());
      updates.close();
      recorder?.close();
      await Promise.all(
        [
          frames.close(),
          feeds.close(),
          statusFeed.close(),
          ...[...running].map((cancel) => cancel()),
          cancelling.settled(),
        ].map(settle),
      );
    }
    wss.close();
    localWss.close();
    await Promise.all(
      [...servers.values(), ...(localListener ? [localListener] : [])].map((listener) =>
        settle(closeListener(listener)),
      ),
    );
    if (failures.length) throw new AggregateError(failures, 'Server resources did not close cleanly.');
  };
  async function listenOn(host: string): Promise<void> {
    const network = !isLoopback(host);
    const headersTimeout = options.headersTimeoutMs ?? HEADERS_TIMEOUT_MS;
    const limits = network
      ? {
          headersTimeout,
          requestTimeout: headersTimeout * 3,
          connectionsCheckingInterval: Math.min(1000, headersTimeout),
        }
      : {};
    const server = createServer(limits, (request, response) => {
      if (options.loopbackOnly && peerAddress(request) !== null) {
        response.writeHead(403, { 'content-type': 'text/plain' }).end('This stim-server serves this machine only.\n');
        return;
      }
      if (localHealthRequest(request)) {
        void answerHealth(response);
        return;
      }
      if (
        request.method === 'GET' &&
        request.url === '/health' &&
        peerAddress(request) !== null &&
        request.headers.origin === undefined &&
        request.headers['sec-fetch-site'] === undefined
      ) {
        const peerHealth = {
          version: health.version,
          ...(startup.state === 'ready'
            ? {}
            : {
                startup:
                  startup.state === 'degraded' ? { state: 'degraded', cause: startup.cause } : { state: 'pending' },
              }),
        };
        response
          .writeHead(startup.state === 'ready' ? 200 : 503, { 'content-type': 'application/json' })
          .end(JSON.stringify(peerHealth));
        return;
      }
      if (request.url?.startsWith('/setup')) {
        answerSetup(request, response);
        return;
      }
      const agent = /^\/device-host\/agent\/([a-f0-9-]{36})(?:[/?]|$)/.exec(request.url ?? '');
      if (agent && arrival(request) === 'direct') {
        response.writeHead(404, { 'content-type': 'text/plain' }).end('Not found.\n');
        return;
      }
      if (agent && startup.state !== 'ready') {
        response.writeHead(503, { 'content-type': 'text/plain' }).end('stim-server is not ready.\n');
        return;
      }
      if (agent) {
        answerAgent(request, response, agent[1]!).catch(() => {
          if (response.headersSent) response.destroy();
          else response.writeHead(500, { 'content-type': 'text/plain' }).end('Agent control failed.\n');
        });
        return;
      }
      response.writeHead(426, { 'content-type': 'text/plain' }).end('stim-server speaks WebSocket only.\n');
    });
    server.on('upgrade', upgrade);
    const sockets = new Set<Socket>();
    server.on('connection', (socket) => {
      if (network) {
        if (!unauthenticated.admit(socket)) return void socket.destroy();
        socket.setTimeout(headersTimeout, () => socket.destroy());
      }
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(addresses[0]?.port ?? options.port, host, () => {
        server.off('error', reject);
        resolve();
      });
    });
    servers.set(host, { server, sockets });
    addresses.push({ host, port: (server.address() as AddressInfo).port });
  }
  let localSocket: string | null = null;
  let localListener: { server: Server; sockets: Set<Socket> } | null = null;
  /**
   * The Unix socket for this machine's own user. Node cannot read a Unix socket peer's uid, so the kernel's check
   * stands in for it: connecting needs write access to the socket, which is mode 0600 in a 0700 directory this user
   * owns. A socket file that no server answers on is stale and replaced. Windows has no local clients and no socket.
   */
  async function listenLocal(path: string): Promise<void> {
    const dir = dirname(path);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const owner = lstatSync(dir);
    if (!owner.isDirectory() || (process.getuid && owner.uid !== process.getuid()))
      throw new Error(`${dir} is not a directory this user owns, so stim-server does not put its local socket there.`);
    chmodSync(dir, 0o700);
    const claimRoot = `${path}.claims`;
    let attempt = tryAcquireClaim({ root: claimRoot, mode: 'exclusive', label: 'stim-server local socket' });
    for (let tries = 0; !attempt.acquired && tries < LOCAL_SOCKET_CLAIM_TRIES; tries++) {
      if (closing) break;
      if (attempt.pending) releaseClaim(attempt.pending);
      await new Promise((resolve) => setTimeout(resolve, 100));
      attempt = tryAcquireClaim({ root: claimRoot, mode: 'exclusive', label: 'stim-server local socket' });
    }
    if (attempt.pending) releaseClaim(attempt.pending);
    if (!attempt.acquired) {
      const held = attempt.held?.path ?? claimRoot;
      throw new Error(
        `another stim-server holds ${held} while it opens its local socket. If nothing is using it, remove it with ${claimRemoveCommand(held)}.`,
      );
    }
    try {
      await bindLocal(path);
    } finally {
      releaseClaim(attempt.acquired);
    }
  }
  /** Probes, replaces and binds the socket while this server holds the socket's claim. */
  async function bindLocal(path: string): Promise<void> {
    if (existsSync(path)) {
      const answered = await new Promise<boolean>((resolve) => {
        const probe = connectSocket(path);
        probe.once('connect', () => {
          probe.destroy();
          resolve(true);
        });
        probe.once('error', () => resolve(false));
      });
      if (answered) throw Object.assign(new Error(`another stim-server answers on ${path}`), { code: 'EADDRINUSE' });
      rmSync(path, { force: true });
    }
    const server = createServer((request, response) => {
      if (request.method === 'GET' && request.url === '/health') return void answerHealth(response);
      response.writeHead(426, { 'content-type': 'text/plain' }).end('stim-server speaks WebSocket only.\n');
    });
    server.on('upgrade', upgradeLocal);
    const sockets = new Set<Socket>();
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(path, () => {
        server.off('error', reject);
        resolve();
      });
    });
    chmodSync(path, 0o600);
    localListener = { server, sockets };
    localSocket = path;
  }
  try {
    for (const host of options.hosts) await listenOn(host);
  } catch (error) {
    await close().catch(() => undefined);
    throw error;
  }
  const binding = transports.filter((transport) => transport.bindAddresses);
  const listenFailures = new Set<string>();
  const reconcile = async () => {
    const extra = options.loopbackOnly ? [] : binding.flatMap((transport) => transport.bindAddresses?.() ?? []);
    const wanted = new Set([...options.hosts, ...extra]);
    for (const [host, listener] of servers) {
      if (wanted.has(host)) continue;
      servers.delete(host);
      addresses.splice(
        addresses.findIndex((address) => address.host === host),
        1,
      );
      await closeListener(listener);
    }
    let failed = false;
    for (const host of wanted) {
      if (servers.has(host) || closing) continue;
      try {
        await listenOn(host);
      } catch (error) {
        failed = true;
        if (!listenFailures.has(host)) {
          listenFailures.add(host);
          console.error(`stim-server: could not listen on ${host}: ${(error as Error).message}`);
        }
      }
    }
    if (failed && !closing) {
      retry = setTimeout(() => queueReconcile(), options.listenRetryMs ?? LISTEN_RETRY_MS);
      retry.unref();
    }
  };
  let retry: NodeJS.Timeout | null = null;
  let reconciling = Promise.resolve();
  const queueReconcile = () => {
    if (retry) clearTimeout(retry);
    retry = null;
    if (binding.length) reconciling = reconciling.then(reconcile);
  };
  queueReconcile();
  await reconciling;
  const stopWatching = binding.flatMap((transport) => (transport.watch ? [transport.watch(queueReconcile)] : []));
  let settle!: (state: StartupState) => void;
  const ready = new Promise<StartupState>((resolve) => {
    settle = resolve;
  });
  const checkHome = async (): Promise<void> => {
    const directories = [configDir(), serverDir(), join(configDir(), 'workspaces')];
    if (options.record !== false) {
      const recorderRoot = join(serverDir(), 'recorder');
      directories.push(exclusiveClaimDir(recorderRoot), sharedClaimDir(recorderRoot));
    }
    startupProbe = probeDirectories(directories, options.env, options.startupProbeMs ?? STARTUP_PROBE_MS, configDir());
    let reason = await startupProbe.result;
    let cause: StartupCause = 'home-unreadable';
    startupProbe = null;
    if (closing) return settle(startup);
    if (reason === null) {
      try {
        homeId = await createStim({ projectRoot: homedir(), env: options.env }).identity();
        if (closing) return settle(startup);
        becomeReady();
      } catch (error) {
        reason = (error as Error).message;
        cause = 'start-failed';
      }
    }
    if (reason === null) {
      if (startup.state === 'degraded') console.error('stim-server: the Stim home answers again; serving clients.');
      const local = options.localSocket === undefined ? serverLocalSocket() : options.localSocket;
      if (!localListener && local !== null && process.platform !== 'win32') {
        try {
          await listenLocal(local);
        } catch (error) {
          console.error(`stim-server: no local socket, so Stim Desktop cannot connect: ${(error as Error).message}`);
        }
        if (closing) {
          if (localListener) await closeListener(localListener);
          localListener = null;
          return settle(startup);
        }
      }
      startup = { state: 'ready' };
      pruneSetup();
      setupPruneTimer ??= setInterval(pruneSetup, 60 * 60_000).unref();
      return settle(startup);
    }
    if (startup.state !== 'degraded' || startup.reason !== reason) {
      console.error(`stim-server: listening, but not serving clients until the Stim home answers. ${reason}`);
    }
    startup = { state: 'degraded', reason, cause };
    settle(startup);
    startupRetry = setTimeout(() => void checkHome(), options.startupRetryMs ?? STARTUP_RETRY_MS);
  };
  void checkHome();
  return {
    addresses,
    get localSocket() {
      return localSocket;
    },
    ready,
    close: async () => {
      for (const stop of stopWatching) stop();
      const closed = close();
      if (retry) clearTimeout(retry);
      await Promise.all([reconciling, closed]);
      await Promise.all([...servers.values()].map(closeListener));
    },
  };
}
