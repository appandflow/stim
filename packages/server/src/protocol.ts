import type { NdjsonRecord, StatusPayload } from '@stim-cli/core/state';

export const PROTOCOL_VERSION = 1;

export const PROTOCOL_SCHEMA_FILE = 'protocol.schema.json';

export const CAPABILITIES = ['read'] as const;

export type Capability = (typeof CAPABILITIES)[number];

export const METHODS = [
  'hello',
  'status.subscribe',
  'logs.query',
  'logs.subscribe',
  'stats.get',
  'settings.get',
  'frames.subscribe',
  'unsubscribe',
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
  /** The Mac's name, this package's version, and the version of the `stim` it runs. */
  server: { name: string; version: string; stim: string };
  capabilities: Capability[];
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

export const LOG_SOURCES = ['metro', 'client', 'device', 'build'] as const;

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

export interface Methods {
  hello: { params: HelloParams; result: HelloResult };
  'status.subscribe': { params?: Record<string, never>; result: SubscribeResult };
  'logs.query': { params: LogFilter; result: LogsQueryResult };
  'logs.subscribe': { params: LogFilter; result: SubscribeResult };
  'stats.get': { params?: WorkspaceParams; result: StatsResult };
  'settings.get': { params?: WorkspaceParams; result: SettingsResult };
  'frames.subscribe': { params: FrameTarget; result: SubscribeResult };
  unsubscribe: { params: UnsubscribeParams; result: Record<string, never> };
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

/** A screenshot of the device, sent only when the screen changed, 1 to 5 times a second. */
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

export type ServerEvent = StatusEvent | LogsEvent | FrameEvent | ErrorEvent;

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
        required: ['protocol', 'server', 'capabilities', 'device'],
        additionalProperties: false,
        properties: {
          protocol: { type: 'integer' },
          server: {
            type: 'object',
            required: ['name', 'version', 'stim'],
            additionalProperties: false,
            properties: { name: { type: 'string' }, version: { type: 'string' }, stim: { type: 'string' } },
          },
          capabilities: { type: 'array', items: { enum: [...CAPABILITIES] } },
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
      WorkspaceParams: {
        type: 'object',
        additionalProperties: false,
        properties: { workspace: { type: 'string', description: 'An environment path from a status payload.' } },
      },
      ClientRequest: {
        oneOf: [
          request('hello', { $ref: '#/$defs/HelloParams' }),
          request('status.subscribe'),
          request('logs.query', { $ref: '#/$defs/LogFilter' }),
          request('logs.subscribe', { $ref: '#/$defs/LogFilter' }),
          request('frames.subscribe', { $ref: '#/$defs/FrameTarget' }),
          optionalParams('stats.get', { $ref: '#/$defs/WorkspaceParams' }),
          optionalParams('settings.get', { $ref: '#/$defs/WorkspaceParams' }),
          request('unsubscribe', {
            type: 'object',
            required: ['subscription'],
            additionalProperties: false,
            properties: { subscription: { type: 'string' } },
          }),
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
                    description: 'The payload of `stim stats --json` or `stim settings --json`, or {} for unsubscribe.',
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
