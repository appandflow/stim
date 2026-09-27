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
  'frames.keyframe',
  'build.plan',
  'machine.get',
  'machine.history',
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
] as const;

export type Method = (typeof METHODS)[number];

export const PUSH_TOKEN_PATTERN = '^(Expo|Exponent)PushToken\\[[^\\]\\s]{1,256}\\]$';

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
  'device-busy',
  'unknown-session',
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

/** `reload` also reaches the workspace's Stim-owned Chrome page. */
export const RELOAD_PLATFORMS = ['ios', 'android', 'web'] as const;

export type ReloadPlatform = (typeof RELOAD_PLATFORMS)[number];

export const FRAME_FPS = { default: 5, max: 30, video: 60 } as const;

export const FRAME_EDGE = { min: 240, default: 1280, max: 2048 } as const;

/**
 * A device `stim status` lists as owned by `workspace`, in `slot` (`default` when absent). Frames come only
 * from a booted simulator or a running emulator Stim created. `fps` caps how many frames a second this
 * subscription gets, and `maxEdge` asks for frames scaled to fit that many pixels; the server may send smaller
 * frames, and larger ones while another subscriber of the same device asks for more.
 */
export interface FrameTarget {
  workspace: string;
  platform: Platform;
  slot?: string;
  fps?: number;
  maxEdge?: number;
  /** The codecs this client decodes. The server picks one when it can encode video; see {@link FramesSubscribeResult}. */
  video?: VideoCodec[];
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
 * unless `takeOver` is true.
 */
export interface ControlBeginParams {
  workspace: string;
  platform: Platform;
  slot?: string;
  takeOver?: boolean;
}

/**
 * `lease` is the `stim device lock` lease the server holds for the session, or null when it holds none, such
 * as after taking over a device another workspace leases. `postures` lists what `input.posture` accepts for
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

/** `x` and `y` are fractions of the upright screen, origin top-left. `display` is 0 for the main display. */
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

/** `home` and `lock` on both platforms; `back` and `app-switch` on Android only. */
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

/** The attention events stim-server can push, named like the phone's notification settings. */
export const PUSH_EVENTS = ['build-failed', 'log-errors', 'disk', 'app-stopped', 'slow-build'] as const;

export type PushEvent = (typeof PUSH_EVENTS)[number];

/**
 * Asks the server to push this device's attention notifications through the Expo push service to `token`, an
 * Expo push token, for at least one event. Registering again replaces the previous registration. `ref` is echoed as `data.ref` in every
 * push, so the phone can tell which Mac sent it.
 */
export interface PushRegisterParams {
  token: string;
  events: PushEvent[];
  agentOnly?: boolean;
  ref: string;
}

export interface Methods {
  hello: { params: HelloParams; result: HelloResult };
  'status.subscribe': { params?: Record<string, never>; result: SubscribeResult };
  'logs.query': { params: LogFilter; result: LogsQueryResult };
  'logs.subscribe': { params: LogFilter; result: SubscribeResult };
  'stats.get': { params?: WorkspaceParams; result: StatsResult };
  'settings.get': { params?: WorkspaceParams; result: SettingsResult };
  'frames.subscribe': { params: FrameTarget; result: FramesSubscribeResult };
  'frames.keyframe': { params: KeyframeParams; result: Record<string, never> };
  'build.plan': { params: BuildPlanParams; result: BuildPlanResult };
  'machine.get': { params?: Record<string, never>; result: MachineUsage };
  'machine.history': { params?: MachineHistoryParams; result: MachineHistory };
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
 * client keeps showing its last frame. Followed by `delayed: false` once captures recover.
 */
export interface FrameDelayedEvent {
  event: 'frame-delayed';
  subscription: string;
  delayed: boolean;
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

export type ServerEvent = StatusEvent | LogsEvent | FrameEvent | FrameDelayedEvent | ErrorEvent | ControlEndedEvent;

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
          platform: { enum: ['ios', 'android'] },
          slot: { type: 'string', minLength: 1, default: 'default' },
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
          platform: { enum: ['ios', 'android'] },
          slot: { type: 'string', minLength: 1, default: 'default' },
          takeOver: { type: 'boolean', default: false },
        },
      },
      ControlBeginResult: {
        type: 'object',
        required: ['session', 'platform', 'lease', 'postures'],
        additionalProperties: false,
        properties: {
          session: { type: 'string' },
          platform: { enum: ['ios', 'android'] },
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
          request('build.plan', { $ref: '#/$defs/BuildPlanParams' }),
          request('machine.get'),
          optionalParams('machine.history', {
            type: 'object',
            additionalProperties: false,
            properties: { sinceMs: { type: 'number' } },
          }),
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
                display: { type: 'integer', minimum: 0, maximum: 3, default: 0 },
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
              events: { type: 'array', minItems: 1, uniqueItems: true, items: { enum: [...PUSH_EVENTS] } },
              agentOnly: { type: 'boolean', default: false },
              ref: { type: 'string', minLength: 1, maxLength: 128 },
            },
          }),
          request('push.unregister'),
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
                  { $ref: '#/$defs/ControlBeginResult' },
                  { $ref: '#/$defs/ActionResult' },
                  { $ref: '#/$defs/MachineUsage' },
                  { $ref: '#/$defs/MachineHistory' },
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
