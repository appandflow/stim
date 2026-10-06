export * from '@stim-cli/core/protocol';

import {
  PROTOCOL_VERSION,
  CAPABILITIES,
  FEATURES,
  type Method,
  PUSH_TOKEN_PATTERN,
  ERROR_CODES,
  LOG_SOURCES,
  LOG_LEVELS,
  MAX_LOG_TAIL,
  PLATFORMS,
  RELOAD_PLATFORMS,
  FRAME_FPS,
  FRAME_EDGE,
  VIDEO_CODECS,
  REPLAY_RATES,
  REPLAY_MARKER_KINDS,
  ACTIONS,
  TOUCH_PHASES,
  INPUT_KEYS,
  KEY_MODIFIERS,
  MAX_INPUT_TEXT,
  INPUT_BUTTONS,
  ROTATE_DIRECTIONS,
  DEVICE_POSTURES,
  BUILD_REPO_PATTERN,
  PUSH_EVENTS,
  LEGACY_PUSH_EVENTS,
  NOTIFICATION_LEVELS,
  NOTIFICATION_SUPPRESSIONS,
  CONTROL_END_REASONS,
} from '@stim-cli/core/protocol';

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
          devClientScheme: { type: 'string', pattern: '^[a-zA-Z][a-zA-Z0-9+.-]{0,127}$' },
          arguments: {
            type: 'array',
            maxItems: 32,
            items: { type: 'string', maxLength: 1024, pattern: '^[^\\u0000\\r\\n]*$' },
          },
          state: { enum: ['receiving', 'installing', 'installed', 'unknown'] },
          launched: { enum: [true, 'unverified', null] },
          notice: { type: 'string' },
          agent: {
            oneOf: [
              {
                type: 'object',
                required: ['driver'],
                additionalProperties: false,
                properties: { driver: { const: 'none' } },
              },
              {
                type: 'object',
                required: ['driver', 'path', 'token', 'scope'],
                additionalProperties: false,
                properties: {
                  driver: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,31}$', not: { const: 'none' } },
                  path: { type: 'string', pattern: '^/device-host/agent/[a-f0-9-]{36}/$' },
                  token: { type: 'string', pattern: '^[A-Za-z0-9_-]{32,256}$' },
                  scope: { type: 'string', pattern: '^[A-Za-z0-9._:-]{1,256}$' },
                  lease: {
                    type: 'object',
                    required: ['tenant', 'runId', 'clientId', 'deviceKey'],
                    additionalProperties: false,
                    properties: {
                      tenant: { type: 'string', pattern: '^[A-Za-z0-9._-]{1,128}$' },
                      runId: { type: 'string', pattern: '^[A-Za-z0-9._-]{1,128}$' },
                      clientId: { type: 'string', pattern: '^[A-Za-z0-9._-]{1,128}$' },
                      deviceKey: {
                        type: 'string',
                        pattern: '^[A-Za-z0-9_-]+(?:\\.[A-Za-z0-9_-]+)+@[1-9][0-9]{0,9}$',
                      },
                    },
                  },
                },
              },
            ],
          },
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
      ServerUpdateProgress: {
        type: 'object',
        required: ['id', 'by', 'target', 'state', 'startedAt', 'missing', 'log'],
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          by: {
            type: 'object',
            required: ['id', 'name'],
            additionalProperties: false,
            properties: { id: { type: 'string' }, name: { type: 'string' } },
          },
          target: { type: 'string' },
          state: { enum: ['uploading', 'installing'] },
          startedAt: { type: 'string' },
          missing: {
            type: 'array',
            items: {
              type: 'object',
              required: ['name', 'offset'],
              additionalProperties: false,
              properties: { name: { type: 'string' }, offset: { type: 'integer', minimum: 0 } },
            },
          },
          log: { type: 'array', items: { type: 'string' } },
        },
      },
      ServerUpdateStatus: {
        type: 'object',
        required: ['server', 'service', 'acceptsClientBuilds', 'running', 'last'],
        additionalProperties: false,
        properties: {
          server: {
            type: 'object',
            required: ['version', 'stimBuild'],
            additionalProperties: false,
            properties: { version: { type: 'string' }, stimBuild: { type: ['string', 'null'] } },
          },
          service: { type: ['string', 'null'] },
          acceptsClientBuilds: { type: 'boolean' },
          running: { anyOf: [{ $ref: '#/$defs/ServerUpdateProgress' }, { type: 'null' }] },
          last: {
            anyOf: [
              {
                type: 'object',
                required: ['at', 'target', 'ok', 'message'],
                additionalProperties: false,
                properties: {
                  at: { type: 'string' },
                  target: { type: 'string' },
                  ok: { type: 'boolean' },
                  message: { type: 'string' },
                },
              },
              { type: 'null' },
            ],
          },
        },
      },
      MachineUpdateStatus: {
        type: 'object',
        required: ['remote', 'unreachable', 'upload'],
        additionalProperties: false,
        properties: {
          remote: { anyOf: [{ $ref: '#/$defs/ServerUpdateStatus' }, { type: 'null' }] },
          unreachable: { type: ['string', 'null'] },
          upload: {
            anyOf: [
              {
                type: 'object',
                required: ['sent', 'total', 'error'],
                additionalProperties: false,
                properties: {
                  sent: { type: 'integer', minimum: 0 },
                  total: { type: 'integer', minimum: 0 },
                  error: { type: ['string', 'null'] },
                },
              },
              { type: 'null' },
            ],
          },
        },
      },
      HostedAppChunkResult: {
        type: 'object',
        required: ['offset'],
        additionalProperties: false,
        properties: { offset: { type: 'integer', minimum: 0 } },
      },
      HostedAppHandoffResult: {
        type: 'object',
        required: ['files', 'bytes'],
        additionalProperties: false,
        properties: { files: { type: 'integer', minimum: 0 }, bytes: { type: 'integer', minimum: 0 } },
      },
      HostedDeviceOffer: {
        type: 'object',
        required: ['platform', 'choice', 'resources', 'declined', 'capacity'],
        additionalProperties: false,
        properties: {
          platform: { enum: ['ios', 'android', 'macos'] },
          choice: {},
          declined: { type: ['string', 'null'], minLength: 1 },
          resources: {
            type: 'object',
            required: ['cpus', 'loadPerCore', 'memoryFreeBytes', 'memoryPressure', 'workerDiskFreeBytes'],
            additionalProperties: false,
            properties: {
              cpus: { type: 'integer', minimum: 1 },
              loadPerCore: { type: 'number', minimum: 0 },
              memoryFreeBytes: { type: 'number', minimum: 0 },
              memoryPressure: { enum: ['normal', 'warning', 'critical', null] },
              workerDiskFreeBytes: { type: ['number', 'null'], minimum: 0 },
            },
          },
          capacity: {
            type: 'object',
            required: ['running', 'max', 'available'],
            additionalProperties: false,
            properties: {
              running: { type: 'integer', minimum: 0 },
              max: { type: 'integer', minimum: 0 },
              available: { type: ['integer', 'null'], minimum: 0 },
            },
          },
        },
        not: { properties: { choice: { type: 'null' }, declined: { type: 'null' } } },
        oneOf: [
          {
            properties: {
              platform: { const: 'ios' },
              choice: {
                anyOf: [
                  { type: 'null' },
                  {
                    type: 'object',
                    required: ['deviceTypeId', 'runtimeId', 'deviceType', 'runtime', 'architecture'],
                    additionalProperties: false,
                    properties: {
                      deviceTypeId: { type: 'string' },
                      runtimeId: { type: 'string' },
                      deviceType: { type: 'string' },
                      runtime: { type: 'string' },
                      architecture: { enum: ['arm64', 'x86_64'] },
                    },
                  },
                ],
              },
            },
          },
          {
            properties: {
              platform: { const: 'android' },
              choice: {
                anyOf: [
                  { type: 'null' },
                  {
                    type: 'object',
                    required: ['systemImage', 'deviceProfile', 'architecture'],
                    additionalProperties: false,
                    properties: {
                      systemImage: { type: 'string' },
                      deviceProfile: { type: 'string' },
                      architecture: { enum: ['arm64-v8a', 'x86_64'] },
                    },
                  },
                ],
              },
            },
          },
          {
            properties: {
              platform: { const: 'macos' },
              choice: {
                anyOf: [
                  { type: 'null' },
                  {
                    type: 'object',
                    required: ['architecture', 'macosVersion'],
                    additionalProperties: false,
                    properties: {
                      architecture: { enum: ['arm64', 'x86_64'] },
                      macosVersion: { type: 'string', pattern: '^\\d+(\\.\\d+){0,2}$' },
                    },
                  },
                ],
              },
            },
          },
        ],
      },
      HostedMetroResult: {
        type: 'object',
        required: ['port'],
        additionalProperties: false,
        properties: { port: { type: ['integer', 'null'], minimum: 1, maximum: 65535 } },
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
          platform: { enum: ['ios', 'android', 'macos'] },
          attempt: { type: 'string' },
          deviceType: { type: 'string' },
          runtime: { type: 'string' },
          systemImage: { type: 'string' },
          deviceProfile: { type: 'string' },
          consolePort: { type: 'integer', minimum: 5554, maximum: 5584, multipleOf: 2 },
          appSlot: { type: 'integer', minimum: 1, maximum: 64 },
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
              {
                type: 'object',
                required: ['architecture', 'macosVersion', 'appSlot'],
                additionalProperties: false,
                properties: {
                  architecture: { enum: ['arm64', 'x86_64'] },
                  macosVersion: { type: 'string', pattern: '^\\d+(\\.\\d+){0,2}$' },
                  appSlot: { type: 'integer', minimum: 1, maximum: 64 },
                },
              },
            ],
          },
          createdAt: { type: 'string' },
          notice: { type: 'string' },
          appAttempt: { type: 'string' },
          metroPort: { type: 'integer', minimum: 1, maximum: 65535 },
        },
        oneOf: [
          {
            required: ['appSlot'],
            properties: {
              platform: { const: 'macos' },
              device: { anyOf: [{ type: 'null' }, { required: ['appSlot', 'macosVersion'] }] },
            },
          },
          { properties: { platform: { enum: ['ios', 'android'] } }, not: { required: ['appSlot'] } },
        ],
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
          host: {
            anyOf: [
              { type: 'null' },
              {
                type: 'object',
                required: ['name', 'screenRecording', 'accessibility'],
                additionalProperties: false,
                properties: {
                  name: { type: 'string' },
                  screenRecording: { type: 'boolean' },
                  accessibility: { type: 'boolean' },
                },
              },
            ],
          },
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
      DeviceFrameArtwork: {
        type: 'object',
        required: ['width', 'height', 'aperture', 'cornerRadius', 'quarterTurns', 'background', 'foreground'],
        additionalProperties: false,
        properties: {
          width: { type: 'number', exclusiveMinimum: 0 },
          height: { type: 'number', exclusiveMinimum: 0 },
          aperture: {
            type: 'object',
            required: ['x', 'y', 'width', 'height'],
            additionalProperties: false,
            properties: {
              x: { type: 'number', minimum: 0 },
              y: { type: 'number', minimum: 0 },
              width: { type: 'number', exclusiveMinimum: 0 },
              height: { type: 'number', exclusiveMinimum: 0 },
            },
          },
          cornerRadius: { type: 'number', minimum: 0 },
          quarterTurns: { type: 'integer', minimum: 0, maximum: 3 },
          background: { type: 'string', contentEncoding: 'base64' },
          foreground: { type: 'string', contentEncoding: 'base64' },
        },
      },
      MacosWindow: {
        type: 'object',
        required: ['id', 'title', 'frame'],
        additionalProperties: false,
        properties: {
          id: { type: 'integer', minimum: 0 },
          title: { type: 'string' },
          frame: {
            type: 'object',
            required: ['x', 'y', 'width', 'height'],
            additionalProperties: false,
            properties: {
              x: { type: 'number' },
              y: { type: 'number' },
              width: { type: 'number', minimum: 0 },
              height: { type: 'number', minimum: 0 },
            },
          },
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
          deviceFrame: { type: 'boolean', default: false },
          duoFrame: { type: 'boolean', default: false },
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
      SimulatorOptions: {
        type: 'object',
        required: ['canShake', 'slowAnimations'],
        additionalProperties: false,
        properties: { canShake: { type: 'boolean' }, slowAnimations: { type: ['boolean', 'null'] } },
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
          simulator: { $ref: '#/$defs/SimulatorOptions' },
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
          request('device-host.offer', {
            type: 'object',
            required: ['platform'],
            additionalProperties: false,
            properties: {
              platform: { enum: ['ios', 'android', 'macos'] },
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
              {
                properties: { platform: { const: 'macos' } },
                not: {
                  anyOf: [
                    { required: ['deviceType'] },
                    { required: ['runtime'] },
                    { required: ['systemImage'] },
                    { required: ['deviceProfile'] },
                  ],
                },
              },
            ],
          }),
          request('device-host.reserve', {
            type: 'object',
            required: ['workspace', 'slot', 'platform', 'attempt'],
            additionalProperties: false,
            properties: {
              workspace: { type: 'string', minLength: 1, maxLength: 4096 },
              slot: { type: 'string', pattern: '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$' },
              platform: { enum: ['ios', 'android', 'macos'] },
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
              {
                properties: { platform: { const: 'macos' } },
                not: {
                  anyOf: [
                    { required: ['deviceType'] },
                    { required: ['runtime'] },
                    { required: ['systemImage'] },
                    { required: ['deviceProfile'] },
                  ],
                },
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
                devClientScheme: { type: 'string', pattern: '^[a-zA-Z][a-zA-Z0-9+.-]{0,127}$' },
                arguments: {
                  type: 'array',
                  maxItems: 32,
                  items: { type: 'string', maxLength: 1024, pattern: '^[^\\u0000\\r\\n]*$' },
                },
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
          request(
            'device-host.app.handoff',
            session(
              {
                attempt: { type: 'string' },
                build: {
                  type: 'object',
                  required: ['handoff', 'sha256'],
                  additionalProperties: false,
                  properties: { handoff: sha256, sha256 },
                },
              },
              ['attempt', 'build'],
            ),
          ),
          request('device-host.app.launch', session({ attempt: { type: 'string' } }, ['attempt'])),
          request('device-host.app.attach', session({ attempt: { type: 'string' } }, ['attempt'])),
          request(
            'device-host.logs.query',
            session({
              cursor: {
                type: 'object',
                maxProperties: 16,
                additionalProperties: { type: 'integer', minimum: 0 },
              },
            }),
          ),
          request(
            'device-host.metro.open',
            session(
              {
                gatewayPort: { type: 'integer', minimum: 1, maximum: 65535 },
                secret: { type: 'string', pattern: '^[a-f0-9]{64}$' },
              },
              ['gatewayPort', 'secret'],
            ),
          ),
          request('device-host.metro.close', session({})),
          request(
            'device-host.frames.subscribe',
            session({
              fps: { type: 'integer', minimum: 1, maximum: FRAME_FPS.video },
              maxEdge: { type: 'integer', minimum: FRAME_EDGE.min, maximum: FRAME_EDGE.max },
              video: { type: 'array', items: { type: 'string' } },
            }),
          ),
          request('device-host.frames.keyframe', {
            type: 'object',
            required: ['subscription'],
            additionalProperties: false,
            properties: { subscription: { type: 'string' } },
          }),
          request('device-host.frames.congested', {
            type: 'object',
            required: ['subscription'],
            additionalProperties: false,
            properties: { subscription: { type: 'string' } },
          }),
          request('device-host.unsubscribe', {
            type: 'object',
            required: ['subscription'],
            additionalProperties: false,
            properties: { subscription: { type: 'string' } },
          }),
          request('device-host.control.begin', session({ takeOver: { type: 'boolean' } })),
          request('device-host.control.end', session({})),
          request(
            'device-host.input.touch',
            session(
              {
                phase: { enum: [...TOUCH_PHASES] },
                x: { type: 'number', minimum: 0, maximum: 1 },
                y: { type: 'number', minimum: 0, maximum: 1 },
                display: { type: 'integer', minimum: 0, maximum: 3 },
                duoRevision: { type: 'string', format: 'uuid' },
              },
              ['phase', 'x', 'y'],
            ),
          ),
          request(
            'device-host.input.text',
            session(
              {
                text: { type: 'string', minLength: 1, maxLength: MAX_INPUT_TEXT, pattern: '^[\\x20-\\x7e\\n\\t\\b]+$' },
              },
              ['text'],
            ),
          ),
          request(
            'device-host.input.scroll',
            session(
              {
                x: { type: 'number', minimum: 0, maximum: 1 },
                y: { type: 'number', minimum: 0, maximum: 1 },
                deltaX: { type: 'number', minimum: -1000, maximum: 1000 },
                deltaY: { type: 'number', minimum: -1000, maximum: 1000 },
              },
              ['x', 'y', 'deltaX', 'deltaY'],
            ),
          ),
          request(
            'device-host.input.key',
            session(
              {
                key: { enum: [...INPUT_KEYS] },
                modifiers: { type: 'array', maxItems: 4, uniqueItems: true, items: { enum: [...KEY_MODIFIERS] } },
              },
              ['key'],
            ),
          ),
          request(
            'device-host.input.window',
            session({ window: { oneOf: [{ type: 'null' }, { type: 'integer', minimum: 0, maximum: 4294967295 }] } }, [
              'window',
            ]),
          ),
          request('device-host.input.button', session({ button: { enum: [...INPUT_BUTTONS] } }, ['button'])),
          request('device-host.input.rotate', session({ direction: { enum: [...ROTATE_DIRECTIONS] } }, ['direction'])),
          request('device-host.input.posture', session({ posture: { enum: [...DEVICE_POSTURES] } }, ['posture'])),
          request('hello', { $ref: '#/$defs/HelloParams' }),
          optionalParams('route.setup', { type: 'object', maxProperties: 0 }),
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
              platform: { enum: [...RELOAD_PLATFORMS] },
              slot: { type: 'string', minLength: 1 },
            },
          }),
          request('replay.keyframe', {
            type: 'object',
            required: ['workspace', 'platform', 'at'],
            additionalProperties: false,
            properties: {
              workspace: { type: 'string' },
              platform: { enum: [...RELOAD_PLATFORMS] },
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
          request('workspace.files', {
            type: 'object',
            required: ['workspace', 'group'],
            additionalProperties: false,
            properties: {
              workspace: { type: 'string', minLength: 1, maxLength: 4096 },
              group: { enum: ['changed', 'untracked'] },
            },
          }),
          request('workspace.diff', {
            type: 'object',
            required: ['workspace', 'path'],
            additionalProperties: false,
            properties: {
              workspace: { type: 'string', minLength: 1, maxLength: 4096 },
              path: { type: 'string', minLength: 1, maxLength: 4096 },
            },
          }),
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
          request(
            'input.scroll',
            session(
              {
                x: { type: 'number', minimum: 0, maximum: 1 },
                y: { type: 'number', minimum: 0, maximum: 1 },
                deltaX: { type: 'number', minimum: -1000, maximum: 1000 },
                deltaY: { type: 'number', minimum: -1000, maximum: 1000 },
              },
              ['x', 'y', 'deltaX', 'deltaY'],
            ),
          ),
          request(
            'input.key',
            session(
              {
                key: { enum: [...INPUT_KEYS] },
                modifiers: { type: 'array', maxItems: 4, uniqueItems: true, items: { enum: [...KEY_MODIFIERS] } },
              },
              ['key'],
            ),
          ),
          request(
            'input.window',
            session({ window: { oneOf: [{ type: 'null' }, { type: 'integer', minimum: 0, maximum: 4294967295 }] } }, [
              'window',
            ]),
          ),
          request('input.button', session({ button: { enum: [...INPUT_BUTTONS] } }, ['button'])),
          request('input.rotate', session({ direction: { enum: [...ROTATE_DIRECTIONS] } }, ['direction'])),
          request('input.posture', session({ posture: { enum: [...DEVICE_POSTURES] } }, ['posture'])),
          request('input.simulator', {
            oneOf: [
              session({ action: { enum: ['read', 'shake'] } }, ['action']),
              session({ action: { const: 'slow-animations' }, enabled: { type: 'boolean' } }, ['action', 'enabled']),
            ],
          }),
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
            required: ['repo', 'project', 'platform', 'fingerprint', 'stimBuild'],
            additionalProperties: false,
            oneOf: [
              {
                properties: { platform: { const: 'macos' }, macos: { type: 'object' } },
                required: ['macos'],
              },
              {
                properties: { platform: { enum: ['ios', 'android'] } },
                required: ['configuration', 'scheme', 'runtime', 'packageName', 'isExpo', 'optimizations'],
              },
            ],
            properties: {
              repo: buildRepo,
              project: { type: 'string', description: 'The app directory relative to the repository root.' },
              platform: { enum: ['ios', 'android', 'macos'] },
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
              macos: {
                type: ['object', 'null'],
                required: ['product', 'infoPlist', 'bundleId'],
                additionalProperties: false,
                properties: {
                  product: { type: 'string', pattern: '^[A-Za-z0-9_.-]{1,100}$' },
                  infoPlist: { type: 'string', minLength: 1 },
                  bundleId: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9.-]{0,199}$' },
                  resources: { type: 'object', maxProperties: 256, additionalProperties: { type: 'string' } },
                  assetCatalog: { type: ['string', 'null'], minLength: 1 },
                },
              },
              stimBuild: { type: 'string', minLength: 1 },
            },
          }),
          request('build.cancel', buildJob),
          request('build.artifact', buildJob),
          request('build.attach', buildJob),
          request('server.update.status'),
          request('machines.update.start', {
            type: 'object',
            required: ['machine'],
            additionalProperties: false,
            properties: { machine: { type: 'string', minLength: 1 } },
          }),
          request('machines.update.status', {
            type: 'object',
            required: ['machine'],
            additionalProperties: false,
            properties: { machine: { type: 'string', minLength: 1 } },
          }),
          request('server.update.start', {
            oneOf: [
              {
                type: 'object',
                required: ['release'],
                additionalProperties: false,
                properties: {
                  release: { type: 'string', pattern: '^\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$' },
                },
              },
              {
                type: 'object',
                required: ['packages'],
                additionalProperties: false,
                properties: {
                  packages: {
                    type: 'array',
                    minItems: 1,
                    maxItems: 8,
                    items: {
                      type: 'object',
                      required: ['name', 'size', 'sha256'],
                      additionalProperties: false,
                      properties: {
                        name: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\\.tgz$' },
                        size: { type: 'integer', minimum: 1, maximum: 64 * 1024 ** 2 },
                        sha256,
                      },
                    },
                  },
                },
              },
            ],
          }),
          request('server.update.chunk', {
            type: 'object',
            required: ['id', 'name', 'offset', 'data'],
            additionalProperties: false,
            properties: {
              id: { type: 'string' },
              name: { type: 'string' },
              offset: { type: 'integer', minimum: 0 },
              data: { type: 'string', maxLength: 32768 },
            },
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
                  { $ref: '#/$defs/HostedDeviceOffer' },
                  { $ref: '#/$defs/HostedDeviceSession' },
                  { $ref: '#/$defs/HostedAppDelivery' },
                  { $ref: '#/$defs/HostedMetroResult' },
                  { $ref: '#/$defs/HostedAppOfferResult' },
                  { $ref: '#/$defs/HostedAppChunkResult' },
                  { $ref: '#/$defs/HostedAppHandoffResult' },
                  { $ref: '#/$defs/ServerUpdateStatus' },
                  { $ref: '#/$defs/ServerUpdateProgress' },
                  { $ref: '#/$defs/MachineUpdateStatus' },
                  { $ref: '#/$defs/HelloResult' },
                  { $ref: '#/$defs/ControlBeginResult' },
                  { $ref: '#/$defs/SimulatorOptions' },
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
            required: ['event', 'subscription', 'current', 'windows', 'pinned'],
            additionalProperties: false,
            properties: {
              event: { const: 'macos-windows' },
              subscription: { type: 'string' },
              current: { oneOf: [{ type: 'null' }, { $ref: '#/$defs/MacosWindow' }] },
              windows: { type: 'array', items: { $ref: '#/$defs/MacosWindow' } },
              pinned: { type: 'boolean' },
            },
          },
          {
            type: 'object',
            required: ['event', 'subscription', 'artwork'],
            additionalProperties: false,
            properties: {
              event: { const: 'device-frame' },
              platform: { enum: [...PLATFORMS] },
              slot: { type: 'string' },
              subscription: { type: 'string' },
              artwork: { oneOf: [{ type: 'null' }, { $ref: '#/$defs/DeviceFrameArtwork' }] },
            },
          },
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
              artworkTurns: { type: 'integer', minimum: 0, maximum: 3 },
              duo: {
                type: 'object',
                required: ['revision', 'screenID', 'angle', 'orientation'],
                additionalProperties: false,
                properties: {
                  revision: { type: 'string', format: 'uuid' },
                  screenID: { type: 'integer', minimum: 0, maximum: 4294967295 },
                  angle: { type: 'number', minimum: 0, maximum: 180 },
                  orientation: { type: 'integer', minimum: 1, maximum: 4 },
                },
              },
            },
          },
          {
            type: 'object',
            required: ['event', 'subscription', 'delayed'],
            additionalProperties: false,
            properties: {
              event: { const: 'frame-delayed' },
              platform: { enum: [...PLATFORMS] },
              slot: { type: 'string' },
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
              platform: { enum: [...PLATFORMS] },
              slot: { type: 'string' },
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
              platform: { enum: [...PLATFORMS] },
              slot: { type: 'string' },
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
