import type { BuildPlanPayload, NdjsonRecord, StatusPayload } from '@stim-cli/core/state';

export const PROTOCOL_VERSION = 1;

export const PROTOCOL_SCHEMA_FILE = 'protocol.schema.json';

/** `read` serves state. `control` also runs {@link ACTIONS}; only the Mac grants it. */
export const CAPABILITIES = ['read', 'control'] as const;

export type Capability = (typeof CAPABILITIES)[number];

export const METHODS = [
  'hello',
  'status.subscribe',
  'logs.query',
  'logs.subscribe',
  'stats.get',
  'settings.get',
  'frames.subscribe',
  'build.plan',
  'machine.get',
  'unsubscribe',
  'action',
] as const;

export type Method = (typeof METHODS)[number];

/**
 * `unauthorized`, `pairing-expired` and `protocol-unsupported` refuse the client until it pairs again or
 * updates; clients retry the others.
 */
export const ERROR_CODES = [
  'unauthorized',
  'pairing-expired',
  'protocol-unsupported',
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

export interface HelloParams {
  protocol: number;
  client: { name: string; version: string };
  auth: PairingAuth | DeviceAuth;
}

export interface HelloResult {
  protocol: number;
  /**
   * The Mac's name, this package's version, the version of the `stim` it runs, and the home directory of the
   * user it runs as, so clients can show paths under it as `~/...`.
   */
  server: { name: string; version: string; stim: string; home: string };
  capabilities: Capability[];
  /** The actions this device may run: every one of {@link ACTIONS} with `control`, none without. */
  actions: ActionName[];
  /** The paired device this connection authenticated as, as `stim-server devices` lists it. */
  device: { id: string; name: string };
  /** Present only when the hello spent a pairing token. The server keeps only its hash. */
  deviceToken?: string;
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

export type Platform = 'ios' | 'android';

/**
 * A device `stim status` lists as owned by `workspace`, in `slot` (`default` when absent). Frames come only
 * from a booted simulator or a running emulator Stim created.
 */
export interface FrameTarget {
  workspace: string;
  platform: Platform;
  slot?: string;
}

/** Each action runs one fixed `stim` command in the workspace. */
export const ACTIONS = ['reload', 'stop'] as const;

export type ActionName = (typeof ACTIONS)[number];

/**
 * `reload` runs `stim reload --json`, with `platform` when both platforms are live; `stop` runs
 * `stim stop --json`. `workspace` is an environment `path` from a status payload. Needs `control`.
 */
export type ActionParams =
  | { action: 'reload'; workspace: string; platform?: Platform }
  | { action: 'stop'; workspace: string };

/** `output` is the JSON the command printed. */
export interface ActionResult {
  action: ActionName;
  workspace: string;
  output: Record<string, unknown>;
}

/** Predicts the next `ios` or `android` build of `workspace` in `slot` (`default` when absent). */
export interface BuildPlanParams {
  workspace: string;
  platform: Platform;
  slot?: string;
}

/** `stim ios|android --plan --json`. It builds, boots and installs nothing, and writes no Stim state. */
export type BuildPlanResult = BuildPlanPayload;
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
  sampledAt: string;
}

export interface Methods {
  hello: { params: HelloParams; result: HelloResult };
  'status.subscribe': { params?: Record<string, never>; result: SubscribeResult };
  'logs.query': { params: LogFilter; result: LogsQueryResult };
  'logs.subscribe': { params: LogFilter; result: SubscribeResult };
  'stats.get': { params?: WorkspaceParams; result: StatsResult };
  'settings.get': { params?: WorkspaceParams; result: SettingsResult };
  'frames.subscribe': { params: FrameTarget; result: SubscribeResult };
  'build.plan': { params: BuildPlanParams; result: BuildPlanResult };
  'machine.get': { params?: Record<string, never>; result: MachineUsage };
  unsubscribe: { params: UnsubscribeParams; result: Record<string, never> };
  action: { params: ActionParams; result: ActionResult };
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

/** A full status payload, as `stim status --watch --json` prints it. */
export interface StatusEvent {
  event: 'status';
  subscription: string;
  payload: StatusPayload;
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

/** A screenshot of the device, sent when the screen changed, at most 5 times a second. */
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
}

/**
 * Captures for a `frames.subscribe` subscription are slow or a timed-out capture is being retried; the
 * client keeps showing its last frame. Followed by `delayed: false` once captures recover.
 */
export interface FrameDelayedEvent {
  event: 'frame-delayed';
  subscription: string;
  delayed: boolean;
}

export type ServerEvent = StatusEvent | LogsEvent | FrameEvent | FrameDelayedEvent | ErrorEvent;

export type ServerMessage = ServerResponse | ServerEvent;

type JsonSchema = Record<string, unknown>;

const requestId: JsonSchema = { type: ['integer', 'string'] };

const protocolError: JsonSchema = {
  type: 'object',
  required: ['code', 'message'],
  additionalProperties: false,
  properties: { code: { enum: [...ERROR_CODES] }, message: { type: 'string' } },
};

function request(method: Method, params?: JsonSchema): JsonSchema {
  return {
    type: 'object',
    required: params ? ['id', 'method', 'params'] : ['id', 'method'],
    additionalProperties: false,
    properties: { id: requestId, method: { const: method }, params: params ?? { type: 'object', maxProperties: 0 } },
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
            ],
          },
        },
      },
      HelloResult: {
        type: 'object',
        required: ['protocol', 'server', 'capabilities', 'actions', 'device'],
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
          actions: { type: 'array', items: { enum: [...ACTIONS] } },
          device: {
            type: 'object',
            required: ['id', 'name'],
            additionalProperties: false,
            properties: { id: { type: 'string' }, name: { type: 'string' } },
          },
          deviceToken: { type: 'string' },
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
          slot: { type: 'string', minLength: 1 },
          grep: { type: 'string', description: 'A regular expression matched against each message.' },
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
          platform: { enum: ['ios', 'android'] },
          slot: { type: 'string', minLength: 1, default: 'default' },
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
              platform: { enum: ['ios', 'android'] },
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
      MachineUsage: {
        type: 'object',
        required: ['volumes', 'memory', 'load', 'sampledAt'],
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
          sampledAt: { type: 'string', format: 'date-time' },
        },
      },
      ClientRequest: {
        oneOf: [
          request('hello', { $ref: '#/$defs/HelloParams' }),
          request('status.subscribe'),
          request('logs.query', { $ref: '#/$defs/LogFilter' }),
          request('logs.subscribe', { $ref: '#/$defs/LogFilter' }),
          request('frames.subscribe', { $ref: '#/$defs/FrameTarget' }),
          request('build.plan', { $ref: '#/$defs/BuildPlanParams' }),
          request('machine.get'),
          optionalParams('stats.get', { $ref: '#/$defs/WorkspaceParams' }),
          optionalParams('settings.get', { $ref: '#/$defs/WorkspaceParams' }),
          request('unsubscribe', {
            type: 'object',
            required: ['subscription'],
            additionalProperties: false,
            properties: { subscription: { type: 'string' } },
          }),
          request('action', { $ref: '#/$defs/ActionParams' }),
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
                  { $ref: '#/$defs/HelloResult' },
                  { $ref: '#/$defs/ActionResult' },
                  { $ref: '#/$defs/MachineUsage' },
                  {
                    type: 'object',
                    required: ['subscription'],
                    additionalProperties: false,
                    properties: { subscription: { type: 'string' } },
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
            required: ['event', 'subscription', 'payload'],
            additionalProperties: false,
            properties: {
              event: { const: 'status' },
              subscription: { type: 'string' },
              payload: { type: 'object', description: 'A full payload, as `stim status --watch --json` prints it.' },
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
              platform: { enum: ['ios', 'android'] },
              slot: { type: 'string' },
              mime: { const: 'image/jpeg' },
              width: { type: 'integer' },
              height: { type: 'integer' },
              capturedAt: { type: 'string', format: 'date-time' },
              data: { type: 'string', contentEncoding: 'base64' },
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
