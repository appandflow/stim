/**
 * Stim server protocol v1, copied from `@stim-cli/server` (packages/server/src/protocol.ts) because this
 * npm app cannot import the pnpm workspace packages; see "Protocol types" in the README.
 * packages/server/__tests__/mobile-protocol.test.ts fails the root typecheck when the two drift apart.
 */

export const PROTOCOL_VERSION = 1;

export type Platform = 'ios' | 'android';

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
}

export interface AndroidState {
  name?: string;
  owned: boolean;
  physical: boolean;
  serial?: string | null;
  state?: 'detected' | 'not-detected' | 'missing' | 'unknown';
  activity?: DeviceActivity;
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
}

export interface RemoteDeviceState {
  platform: Platform | null;
  backend: 'eas';
  sessionId: string;
  state: 'claimed' | 'unclaimed' | 'unknown';
  startedAt: string | null;
  webPreviewUrl: string | null;
}

export interface WorktreeFacts {
  path: string;
  branch?: string;
  repository?: string;
}

export interface EnvironmentState {
  path: string;
  labelOnly?: boolean;
  slots?: { slot: string; ios?: SimState | null; android?: AndroidState | null }[];
  live: boolean;
  memoryMb: number;
  warnings: string[];
  ios?: SimState | null;
  android?: AndroidState | null;
  metro?: { port: number; running: boolean; pid: number | null } | null;
  supervisor?: { pid: number | null; mode: string | null; startedAt: string | null; healthy: boolean } | null;
  logs?: { dir: string; errorsSinceMarker: number } | null;
  worktree?: WorktreeFacts | null;
  remoteDevices?: RemoteDeviceState[];
  build?: BuildReport | null;
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
}

export type LogSource = 'metro' | 'client' | 'device' | 'build';
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
  platform: Platform;
  slot?: string;
}

export type ClientAuth = { deviceToken: string } | { pairingToken: string; deviceName: string };

export interface Methods {
  hello: {
    params: { protocol: number; client: { name: string; version: string }; auth: ClientAuth };
    result: {
      protocol: number;
      server: { name: string; version: string; stim: string };
      capabilities: string[];
      /** Returned once, when `auth` spent a pairing token. */
      deviceToken?: string;
    };
  };
  'status.subscribe': { params: Record<string, never>; result: { subscription: string } };
  'logs.query': { params: LogFilter; result: { records: LogRecord[] } };
  'logs.subscribe': { params: LogFilter; result: { subscription: string } };
  'stats.get': { params: { workspace?: string }; result: Record<string, unknown> };
  'settings.get': { params: { workspace?: string }; result: Record<string, unknown> };
  'frames.subscribe': { params: FrameTarget; result: { subscription: string } };
  unsubscribe: { params: { subscription: string }; result: Record<string, never> };
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
}

export interface LogsEvent {
  event: 'logs';
  subscription: string;
  records: LogRecord[];
}

export interface FrameEvent {
  event: 'frame';
  subscription: string;
  platform: Platform;
  slot: string;
  mime: 'image/jpeg' | 'image/png';
  width: number;
  height: number;
  capturedAt: string;
  /** Base64-encoded image bytes. */
  data: string;
}

export interface ErrorEvent {
  event: 'error';
  subscription?: string;
  error: ProtocolError;
}

export type ServerEvent = StatusEvent | LogsEvent | FrameEvent | ErrorEvent;

export type ServerMessage = Response | ServerEvent;
