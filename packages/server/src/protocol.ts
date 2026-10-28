export * from '@stim-cli/core/protocol';
import { SETTING_SCOPES } from '@stim-cli/core/state';

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
  BUILD_RUBY_VERSION_PATTERN,
  PUSH_EVENTS,
  LEGACY_PUSH_EVENTS,
  NOTIFICATION_LEVELS,
  NOTIFICATION_SUPPRESSIONS,
  CONTROL_END_REASONS,
  ARCHIVED_PAGE_LIMIT,
} from '@stim-cli/core/protocol';

type JsonSchema = Record<string, unknown>;

const requestId: JsonSchema = { type: ['integer', 'string'] };

const runText = { type: 'string', minLength: 1, maxLength: 1024, pattern: '^[^\\u0000]+$' };
const runSelector = { oneOf: [runText, { type: 'boolean' }] };
const nativeRunProperties = {
  slot: runText,
  remote: runText,
  remoteBuild: runText,
  easProfile: runText,
  device: runSelector,
  wait: runSelector,
  metroCheck: { type: 'boolean' },
  buildCache: { type: 'boolean' },
};
const platformRunOptions: JsonSchema = {
  oneOf: [
    {
      type: 'object',
      required: ['platform'],
      additionalProperties: false,
      properties: {
        platform: { const: 'ios' },
        ...nativeRunProperties,
        configuration: runText,
        scheme: runText,
        deviceType: runText,
        runtime: runText,
        simulatorApp: runText,
      },
    },
    {
      type: 'object',
      required: ['platform'],
      additionalProperties: false,
      properties: {
        platform: { const: 'android' },
        ...nativeRunProperties,
        variant: runText,
        systemImage: runText,
        deviceProfile: runText,
      },
    },
    {
      type: 'object',
      required: ['platform'],
      additionalProperties: false,
      properties: {
        platform: { const: 'macos' },
        remote: runText,
        remoteBuild: runText,
      },
    },
    {
      type: 'object',
      required: ['platform'],
      additionalProperties: false,
      properties: {
        platform: { const: 'web' },
        headed: { type: 'boolean' },
      },
    },
  ],
};

const platformBuildOptions: JsonSchema = {
  oneOf: [
    {
      type: 'object',
      required: ['platform'],
      additionalProperties: false,
      properties: {
        platform: { const: 'ios' },
        configuration: runText,
        scheme: runText,
        arch: { enum: ['arm64', 'x86_64', 'all'] },
        buildCache: { type: 'boolean' },
        remoteBuild: runText,
      },
    },
    {
      type: 'object',
      required: ['platform'],
      additionalProperties: false,
      properties: {
        platform: { const: 'android' },
        variant: runText,
        abi: { enum: ['arm64-v8a', 'armeabi-v7a', 'x86', 'x86_64', 'all'] },
        buildCache: { type: 'boolean' },
        remoteBuild: runText,
      },
    },
    {
      type: 'object',
      required: ['platform'],
      additionalProperties: false,
      properties: { platform: { const: 'macos' }, remoteBuild: runText },
    },
  ],
};

const protocolError: JsonSchema = {
  type: 'object',
  required: ['code', 'message'],
  additionalProperties: false,
  properties: { code: { enum: [...ERROR_CODES] }, message: { type: 'string' } },
};

const sha256: JsonSchema = { type: 'string', pattern: '^[0-9a-f]{64}$' };
const buildRepo: JsonSchema = { type: 'string', pattern: BUILD_REPO_PATTERN };
const buildArtifactIdentity: JsonSchema = {
  type: 'object',
  required: ['fingerprint', 'cacheKey'],
  additionalProperties: false,
  properties: {
    fingerprint: { type: 'string', minLength: 1, maxLength: 256 },
    cacheKey: { type: 'string', minLength: 1, maxLength: 1024 },
  },
};

const gradleArtifactQuery: JsonSchema = {
  type: 'object',
  required: ['project', 'sourceDigest', 'inputs', 'android'],
  additionalProperties: false,
  properties: {
    project: { type: 'string' },
    sourceDigest: sha256,
    inputs: {
      type: 'object',
      required: ['complete', 'ignored', 'outputs'],
      additionalProperties: false,
      properties: {
        complete: { const: true },
        ignored: { type: 'array', items: { type: 'string', minLength: 1 } },
        outputs: { type: 'array', items: { type: 'string', minLength: 1 } },
      },
    },
    android: {
      type: 'object',
      required: ['variant', 'abi', 'gradleBuildCache', 'pch', 'compilerCache'],
      additionalProperties: false,
      properties: {
        variant: { type: 'string', minLength: 1 },
        abi: { type: ['string', 'null'] },
        gradleBuildCache: { type: 'boolean' },
        pch: { enum: ['auto', 'on', 'off'] },
        compilerCache: { enum: ['ccache', 'none'] },
        gradleRoot: { type: ['string', 'null'] },
        module: { type: ['string', 'null'] },
      },
    },
  },
};

const swiftpmArtifactInputs: JsonSchema = {
  type: 'object',
  required: ['complete', 'ignored', 'outputs', 'localFiles', 'environment'],
  additionalProperties: false,
  properties: {
    complete: { const: true },
    ignored: { type: 'array', maxItems: 1000, items: { type: 'string', minLength: 1 } },
    outputs: { type: 'array', maxItems: 1000, items: { type: 'string', minLength: 1 } },
    localFiles: { type: 'array', maxItems: 1000, items: { type: 'string', minLength: 1, maxLength: 4096 } },
    environment: { type: 'array', maxItems: 1000, items: { type: 'string', pattern: '^[A-Za-z_][A-Za-z0-9_]*$' } },
  },
};
const buildCompat: JsonSchema = {
  type: 'integer',
  minimum: 1,
  description: 'The Stim build compatibility version, sent to a stim-server with the build-compat feature.',
};
const stimIdentity: JsonSchema[] = [{ required: ['stimBuild'] }, { required: ['compat'] }];
const swiftpmArtifactQuery: JsonSchema = {
  type: 'object',
  required: ['project', 'sourceDigest', 'inputs', 'build'],
  oneOf: stimIdentity,
  additionalProperties: false,
  properties: {
    project: { type: 'string' },
    sourceDigest: sha256,
    stimBuild: { type: 'string', minLength: 1, maxLength: 256 },
    compat: buildCompat,
    inputs: swiftpmArtifactInputs,
    build: {
      type: 'object',
      required: ['product', 'infoPlist', 'resources', 'assetCatalog'],
      additionalProperties: false,
      properties: {
        product: { type: 'string', pattern: '^[A-Za-z0-9_.-]{1,100}$' },
        infoPlist: { type: 'string', minLength: 1 },
        resources: { type: 'object', maxProperties: 256, additionalProperties: { type: 'string' } },
        assetCatalog: { type: ['string', 'null'], minLength: 1 },
      },
    },
  },
};

const reactNativeArtifactQuery: JsonSchema = {
  type: 'object',
  required: ['project', 'fingerprint', 'isExpo', 'platform', 'toolchain'],
  additionalProperties: false,
  oneOf: [
    {
      properties: {
        platform: { const: 'ios' },
        toolchain: { required: ['arch', 'xcode', 'simulatorSdk', 'cocoapods'] },
      },
      required: ['ios'],
    },
    { properties: { platform: { const: 'android' }, toolchain: { required: ['jdk'] } }, required: ['android'] },
  ],
  properties: {
    project: { type: 'string' },
    fingerprint: { type: 'string', minLength: 1, maxLength: 256 },
    isExpo: { type: 'boolean' },
    platform: { enum: ['ios', 'android'] },
    toolchain: {
      type: 'object',
      oneOf: stimIdentity,
      additionalProperties: false,
      properties: {
        stimBuild: { type: 'string', minLength: 1 },
        compat: buildCompat,
        arch: { type: 'string', minLength: 1 },
        xcode: { type: 'string', minLength: 1 },
        simulatorSdk: { type: 'string', minLength: 1 },
        cocoapods: { type: 'string', minLength: 1 },
        jdk: { type: 'string', minLength: 1 },
      },
    },
    ios: {
      type: 'object',
      required: ['runtime', 'configuration', 'scheme', 'projectPath', 'optimizations'],
      additionalProperties: false,
      properties: {
        runtime: { type: 'string', minLength: 1 },
        configuration: { type: 'string', minLength: 1 },
        scheme: { type: ['string', 'null'] },
        projectPath: { type: 'string', minLength: 1 },
        optimizations: {
          type: 'object',
          required: ['compilationCache', 'swiftCompilationCache', 'prefixMapping'],
          additionalProperties: false,
          properties: {
            compilationCache: { type: 'boolean' },
            swiftCompilationCache: { type: ['boolean', 'null'] },
            prefixMapping: { type: 'boolean' },
          },
        },
      },
    },
    android: {
      type: 'object',
      required: ['variant', 'abi', 'gradleBuildCache', 'pch', 'compilerCache'],
      additionalProperties: false,
      properties: {
        variant: { type: ['string', 'null'] },
        abi: { type: ['string', 'null'] },
        gradleBuildCache: { type: 'boolean' },
        pch: { enum: ['auto', 'on', 'off'] },
        compilerCache: { enum: ['ccache', 'none'] },
        gradleRoot: { type: ['string', 'null'] },
        module: { type: ['string', 'null'] },
      },
    },
  },
};

const workspaceRef: JsonSchema = {
  type: 'object',
  required: ['workspace'],
  additionalProperties: false,
  properties: { workspace: { type: 'string', minLength: 1 } },
};

const keyedDelta = (description: string): JsonSchema => ({
  type: 'object',
  required: ['upsert', 'remove'],
  additionalProperties: false,
  properties: {
    upsert: { type: 'array', items: { type: 'object' }, description },
    remove: { type: 'array', items: { type: 'string' }, description: 'The paths that are gone.' },
  },
});

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
          mode: { enum: ['development', 'release', 'process'] },
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
                    oneOf: [
                      {
                        required: ['backend'],
                        properties: {
                          backend: { const: 'ios-instance' },
                          deviceKey: { pattern: '^ios:mobile:[a-fA-F0-9-]{36}$' },
                        },
                      },
                      {
                        required: ['backend'],
                        properties: {
                          backend: { const: 'android-instance' },
                          deviceKey: { pattern: '^android:mobile:emulator-[0-9]+$' },
                        },
                      },
                      {
                        not: { required: ['backend'] },
                        properties: {
                          deviceKey: { pattern: '^[A-Za-z0-9_-]+(?:\\.[A-Za-z0-9_-]+)+@[1-9][0-9]{0,9}$' },
                        },
                      },
                    ],
                    properties: {
                      tenant: { type: 'string', pattern: '^[A-Za-z0-9._-]{1,128}$' },
                      runId: { type: 'string', pattern: '^[A-Za-z0-9._-]{1,128}$' },
                      clientId: { type: 'string', pattern: '^[A-Za-z0-9._-]{1,128}$' },
                      backend: { enum: ['ios-instance', 'android-instance'] },
                      deviceKey: { type: 'string' },
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
      HostedLocalDeviceCount: {
        anyOf: [
          { type: 'integer', minimum: 0 },
          {
            type: 'object',
            required: ['unknown'],
            additionalProperties: false,
            properties: { unknown: { type: 'string', minLength: 1, maxLength: 4000 } },
          },
        ],
      },
      HostedDeviceOffer: {
        type: 'object',
        required: ['platform', 'choice', 'resources', 'declined', 'capacity'],
        additionalProperties: false,
        properties: {
          platform: { enum: ['ios', 'android', 'macos'] },
          choice: {},
          installImage: { type: 'string', pattern: '^system-images;' },
          declined: { type: ['string', 'null'], minLength: 1 },
          resources: {
            type: 'object',
            required: ['cpus', 'loadPerCore', 'memoryFreeBytes', 'memoryPressure', 'workerDiskFreeBytes'],
            additionalProperties: false,
            properties: {
              cpus: { type: 'integer', minimum: 1 },
              loadPerCore: { type: 'number', minimum: 0 },
              maxLoadPerCore: { type: 'number', exclusiveMinimum: 0 },
              memoryFreeBytes: { type: 'number', minimum: 0 },
              memoryPressure: { enum: ['normal', 'warning', 'critical', null] },
              workerDiskFreeBytes: { type: ['number', 'null'], minimum: 0 },
              localDevices: { $ref: '#/$defs/HostedLocalDeviceCount' },
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
              local: { $ref: '#/$defs/HostedLocalDeviceCount' },
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
      HostedSessionRow: {
        type: 'object',
        required: ['id', 'client', 'platform', 'device', 'app', 'state', 'parked', 'since', 'workspace'],
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          client: {
            type: 'object',
            required: ['id', 'name'],
            additionalProperties: false,
            properties: { id: { type: 'string' }, name: { type: 'string' } },
          },
          platform: { enum: ['ios', 'android', 'macos'] },
          device: { type: ['string', 'null'] },
          app: { type: ['string', 'null'] },
          state: { enum: ['preparing', 'ready', 'stopping', 'stopped', 'unknown'] },
          parked: { type: 'boolean' },
          since: { type: 'string' },
          workspace: { type: 'string' },
        },
      },
      HostedSessionsResult: {
        type: 'object',
        required: ['sessions'],
        additionalProperties: false,
        properties: { sessions: { type: 'array', items: { $ref: '#/$defs/HostedSessionRow' } } },
      },
      HostedSessionStopResult: {
        type: 'object',
        required: ['id', 'state'],
        additionalProperties: false,
        properties: { id: { type: 'string' }, state: { enum: ['stopping', 'stopped'] } },
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
          agent: { $ref: '#/$defs/HostedAppDelivery/properties/agent' },
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
        description:
          'The first request, sent encrypted after the Noise handshake on a network connection, or in the clear on the local Unix socket.',
        required: ['client'],
        additionalProperties: false,
        properties: {
          client: {
            type: 'object',
            required: ['name', 'version'],
            properties: {
              name: { type: 'string' },
              version: { type: 'string' },
              runId: { type: 'string', pattern: '^[A-Za-z0-9._-]{1,64}$' },
            },
          },
          access: { enum: ['build', 'device-host'] },
          desktopBootstrap: { const: true },
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
            required: ['name', 'version', 'stim'],
            additionalProperties: false,
            properties: {
              name: { type: 'string' },
              version: { type: 'string' },
              stim: { type: 'string' },
              home: { type: 'string' },
              id: { type: 'string' },
              port: { type: 'integer' },
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
          desktopBootstrap: {
            type: 'object',
            required: ['nonce', 'proof'],
            additionalProperties: false,
            properties: {
              nonce: { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' },
              proof: { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' },
            },
          },
        },
      },
      DesktopAuthenticateResult: {
        type: 'object',
        required: ['authorized'],
        additionalProperties: false,
        properties: { authorized: { const: true } },
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
      DesktopLogFilter: {
        type: 'object',
        required: ['workspace'],
        additionalProperties: false,
        properties: {
          workspace: { type: 'string' },
          sources: { type: 'array', minItems: 1, items: { enum: [...LOG_SOURCES] } },
          level: { enum: [...LOG_LEVELS] },
          grep: { type: 'string', pattern: '^[^\\u0000]*$' },
          errors: { type: 'boolean' },
        },
      },
      LogFilter: {
        type: 'object',
        oneOf: [{ required: ['workspace'] }, { required: ['archive'] }],
        additionalProperties: false,
        properties: {
          workspace: { type: 'string', description: 'An environment path from a status payload.' },
          archive: {
            type: 'string',
            minLength: 1,
            pattern: '^(?!.*\\.\\.)[^/\\\\\\u0000]+$',
            description: 'An archived[].id from a status payload; omit workspace.',
          },
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
        required: ['platform'],
        oneOf: [
          { required: ['workspace'], not: { required: ['archive'] } },
          { required: ['archive', 'at'], not: { required: ['workspace'] }, properties: { physical: { const: false } } },
        ],
        additionalProperties: false,
        properties: {
          workspace: { type: 'string', description: 'An environment path from a status payload.' },
          archive: {
            type: 'string',
            minLength: 1,
            pattern: '^(?!.*\\.\\.)[^/\\\\\\u0000]+$',
            description: 'An archived[].id from a status payload; omit workspace.',
          },
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
      DesktopReportTarget: {
        oneOf: [
          {
            type: 'object',
            required: ['report'],
            additionalProperties: false,
            properties: { report: { const: 'gc' } },
          },
          {
            type: 'object',
            required: ['report', 'cwd'],
            additionalProperties: false,
            properties: {
              report: { const: 'doctor' },
              cwd: { type: 'string', minLength: 1, maxLength: 4096 },
              platform: { enum: ['ios', 'android'] },
            },
          },
        ],
      },
      DesktopReportSnapshot: {
        type: 'object',
        required: ['pending', 'value'],
        additionalProperties: false,
        properties: {
          pending: { type: 'boolean' },
          value: { type: ['object', 'null'] },
          error: { type: 'string' },
          measuredAt: { type: 'string' },
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
            description: '`remoteMachines` from `stim doctor --json`.',
            items: { type: 'object' },
          },
          buildMachinesError: { type: 'string' },
          buildMachinesAt: { type: 'string' },
          buildMachinesPending: { type: 'boolean' },
          buildClients: {
            type: 'array',
            description: 'The builds this machine ran for each client, from the audit log.',
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
                mode: { enum: ['development', 'release', 'process'] },
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
            session({ clientMetroPort: { type: 'integer', minimum: 1, maximum: 65535 } }),
          ),
          request('device-host.metro.ports', {
            type: 'object',
            required: ['ports'],
            additionalProperties: false,
            properties: {
              ports: { type: 'array', maxItems: 256, items: { type: 'integer', minimum: 1, maximum: 65535 } },
            },
          }),
          request('device-host.metro.close', session({})),
          request('device-host.metro.link', session({})),
          request('device-host.agent.link', session({})),
          request(
            'device-host.frames.subscribe',
            session({
              fps: { type: 'integer', minimum: 1, maximum: FRAME_FPS.video },
              maxEdge: { type: 'integer', minimum: FRAME_EDGE.min, maximum: FRAME_EDGE.max },
              video: { type: 'array', items: { type: 'string' } },
              deviceFrame: { type: 'boolean' },
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
          request('desktop.authenticate', {
            type: 'object',
            required: ['proof'],
            additionalProperties: false,
            properties: { proof: { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' } },
          }),
          optionalParams('route.setup', { type: 'object', maxProperties: 0 }),
          request('desktop.reports.get', { $ref: '#/$defs/DesktopReportTarget' }),
          request('desktop.reports.subscribe', { $ref: '#/$defs/DesktopReportTarget' }),
          optionalParams('desktop.reports.invalidate', {
            oneOf: [{ type: 'object', maxProperties: 0 }, { $ref: '#/$defs/DesktopReportTarget' }],
          }),
          optionalParams('desktop.settings.schema', { type: 'object', maxProperties: 0 }),
          request('desktop.settings.get', {
            type: 'object',
            required: ['cwd'],
            additionalProperties: false,
            properties: { cwd: { type: 'string', minLength: 1, maxLength: 4096 } },
          }),
          request('desktop.settings.write', {
            oneOf: ['set', 'unset'].map((action) => ({
              type: 'object',
              required: ['cwd', 'action', 'key', ...(action === 'set' ? ['value'] : [])],
              additionalProperties: false,
              properties: {
                cwd: { type: 'string', minLength: 1, maxLength: 4096 },
                action: { const: action },
                key: { type: 'string', minLength: 1, maxLength: 256 },
                scope: { enum: [...SETTING_SCOPES] },
                ...(action === 'set' ? { value: { type: 'string' } } : {}),
              },
            })),
          }),
          request('desktop.logs.subscribe', { $ref: '#/$defs/DesktopLogFilter' }),
          request('desktop.doctor.run', {
            type: 'object',
            required: ['cwd'],
            additionalProperties: false,
            properties: {
              cwd: { type: 'string', minLength: 1, maxLength: 4096 },
              platform: { enum: ['ios', 'android'] },
            },
          }),
          request('desktop.stop.subscribe', {
            type: 'object',
            required: ['cwd'],
            additionalProperties: false,
            properties: {
              cwd: { type: 'string', minLength: 1, maxLength: 4096 },
              slot: {
                type: 'string',
                pattern: '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$',
                not: { enum: ['constructor', 'prototype', '__proto__'] },
              },
            },
          }),
          request('desktop.machine-access.subscribe', {
            type: 'object',
            required: ['cwd'],
            additionalProperties: false,
            properties: {
              cwd: { type: 'string', minLength: 1, maxLength: 4096 },
              ticket: { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' },
            },
          }),
          request('desktop.reload.subscribe', {
            type: 'object',
            required: ['cwd'],
            additionalProperties: false,
            properties: {
              cwd: { type: 'string', minLength: 1, maxLength: 4096 },
              platform: { enum: [...RELOAD_PLATFORMS] },
            },
          }),
          request('desktop.start.subscribe', {
            type: 'object',
            required: ['cwd'],
            additionalProperties: false,
            properties: {
              cwd: { type: 'string', minLength: 1, maxLength: 4096 },
              remote: { type: 'boolean' },
              resetCache: { type: 'boolean' },
              waitSeconds: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
            },
          }),
          request('desktop.run.subscribe', {
            type: 'object',
            required: ['cwd', 'options'],
            additionalProperties: false,
            properties: { cwd: { type: 'string', minLength: 1, maxLength: 4096 }, options: platformRunOptions },
          }),
          request('desktop.plan.get', {
            oneOf: [
              {
                type: 'object',
                required: ['cwd', 'platform'],
                additionalProperties: false,
                properties: {
                  cwd: { type: 'string', minLength: 1, maxLength: 4096 },
                  platform: { enum: ['ios', 'android'] },
                  slot: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$' },
                  request: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,128}$' },
                },
              },
              {
                type: 'object',
                required: ['cwd', 'platform'],
                additionalProperties: false,
                properties: {
                  cwd: { type: 'string', minLength: 1, maxLength: 4096 },
                  platform: { const: 'macos' },
                  request: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,128}$' },
                },
              },
            ],
          }),
          request('desktop.plan.cancel', {
            type: 'object',
            required: ['request'],
            additionalProperties: false,
            properties: { request: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,128}$' } },
          }),
          request('desktop.build.subscribe', {
            type: 'object',
            required: ['cwd', 'options'],
            additionalProperties: false,
            properties: { cwd: { type: 'string', minLength: 1, maxLength: 4096 }, options: platformBuildOptions },
          }),
          request('desktop.gc.subscribe', {
            type: 'object',
            required: ['cwd'],
            additionalProperties: false,
            properties: {
              cwd: { type: 'string', minLength: 1, maxLength: 4096 },
              cache: { type: 'string', minLength: 1, maxLength: 1024, pattern: '^.*\\S.*$' },
              olderThan: { type: 'integer', minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER },
              worktrees: { type: 'boolean' },
              delete: { type: 'boolean' },
              idleMs: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
            },
          }),
          request('desktop.worktree.warm.subscribe', {
            type: 'object',
            required: ['cwd'],
            additionalProperties: false,
            properties: { cwd: { type: 'string', minLength: 1, maxLength: 4096 } },
          }),
          request('desktop.worktree.remove.subscribe', {
            type: 'object',
            required: ['cwd'],
            additionalProperties: false,
            properties: {
              cwd: { type: 'string', minLength: 1, maxLength: 4096 },
              target: { type: 'string', minLength: 1, maxLength: 4096 },
              force: { type: 'boolean' },
            },
          }),
          request('status.subscribe'),
          request('workspaces.subscribe'),
          request('workspace.subscribe', workspaceRef),
          request('machine.subscribe'),
          request('builds.history', workspaceRef),
          optionalParams('archived.list', {
            type: 'object',
            additionalProperties: false,
            properties: {
              before: { type: 'string', minLength: 1 },
              limit: { type: 'integer', minimum: 1, maximum: ARCHIVED_PAGE_LIMIT },
            },
          }),
          request('worktrees.list'),
          request('maintenance.get'),
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
              at: { type: 'number', description: 'Epoch milliseconds on the machine clock.' },
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
            required: ['platform'],
            oneOf: [{ required: ['workspace'] }, { required: ['archive'] }],
            additionalProperties: false,
            properties: {
              workspace: { type: 'string' },
              archive: { type: 'string', minLength: 1, pattern: '^(?!.*\\.\\.)[^/\\\\\\u0000]+$' },
              platform: { enum: [...RELOAD_PLATFORMS] },
              slot: { type: 'string', minLength: 1 },
            },
          }),
          request('archive.detail', {
            type: 'object',
            required: ['archive'],
            additionalProperties: false,
            properties: {
              archive: { type: 'string', minLength: 1, pattern: '^(?!.*\\.\\.)[^/\\\\\\u0000]+$' },
            },
          }),
          request('replay.keyframe', {
            type: 'object',
            required: ['platform', 'at'],
            oneOf: [{ required: ['workspace'] }, { required: ['archive'] }],
            additionalProperties: false,
            properties: {
              workspace: { type: 'string' },
              archive: { type: 'string', minLength: 1, pattern: '^(?!.*\\.\\.)[^/\\\\\\u0000]+$' },
              platform: { enum: [...RELOAD_PLATFORMS] },
              slot: { type: 'string', minLength: 1 },
              at: { type: 'number', description: 'Epoch milliseconds on the machine clock.' },
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
            properties: {
              repo: buildRepo,
              lockfile: sha256,
              dependencies: {
                type: 'object',
                required: ['project', 'packageName'],
                additionalProperties: false,
                properties: {
                  project: { type: 'string' },
                  packageName: { type: ['string', 'null'] },
                },
              },
              rubyVersion: { type: 'string', pattern: BUILD_RUBY_VERSION_PATTERN },
              native: { enum: ['xcode', 'gradle'] },
              artifact: buildArtifactIdentity,
              gradleArtifact: gradleArtifactQuery,
              reactNativeArtifact: reactNativeArtifactQuery,
              swiftpmArtifact: swiftpmArtifactQuery,
            },
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
                    kind: { enum: ['file', 'exec', 'link', 'directory'] },
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
            if: { required: ['native'], properties: { native: { properties: { provider: { const: 'gradle' } } } } },
            // oxlint-disable-next-line unicorn/no-thenable -- JSON Schema uses then for conditional validation.
            then: { properties: { platform: { const: 'android' }, fingerprint: { type: 'null' } } },
            else: { properties: { fingerprint: { type: 'string', minLength: 1 } } },
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
              fingerprint: { type: ['string', 'null'], minLength: 1 },
              fingerprintSources: {
                type: 'array',
                maxItems: 20000,
                description: 'The id and hash of each source of fingerprint, to name the sources that differ.',
                items: {
                  type: 'object',
                  required: ['id', 'hash'],
                  additionalProperties: false,
                  properties: {
                    id: { type: 'string', minLength: 1, maxLength: 1024 },
                    hash: { type: ['string', 'null'], pattern: '^[0-9a-f]{1,128}$' },
                  },
                },
              },
              fingerprintIgnored: {
                type: 'array',
                maxItems: 20000,
                description:
                  'Paths relative to project that git ignores for fingerprint on the caller, such as through .git/info/exclude.',
                items: { type: 'string', minLength: 1, maxLength: 1024 },
              },
              fingerprintTracked: {
                type: 'array',
                maxItems: 20000,
                description:
                  'Top-level entries of project that the caller git tracks for fingerprint although an ignore pattern matches them.',
                items: { type: 'string', minLength: 1, maxLength: 255, pattern: '^[^/\\u0000]+$' },
              },
              native: {
                oneOf: [
                  {
                    type: 'object',
                    required: ['provider', 'sourceDigest', 'cacheKey', 'arch', 'parameters'],
                    additionalProperties: false,
                    properties: {
                      provider: { const: 'xcode' },
                      sourceDigest: sha256,
                      cacheKey: { type: 'string', minLength: 1 },
                      arch: { enum: ['arm64', 'x86_64', null] },
                      parameters: {
                        type: 'object',
                        description: 'The non-file parameters of the client artifact identity, to name what differs.',
                      },
                    },
                  },
                  {
                    type: 'object',
                    required: ['provider', 'sourceDigest', 'inputs'],
                    additionalProperties: false,
                    properties: {
                      provider: { const: 'gradle' },
                      sourceDigest: sha256,
                      cache: {
                        type: 'object',
                        required: ['read', 'write', 'remote'],
                        additionalProperties: false,
                        properties: {
                          read: { type: 'boolean' },
                          write: { type: 'boolean' },
                          remote: { type: 'boolean' },
                        },
                      },
                      inputs: {
                        type: 'object',
                        required: ['complete', 'ignored', 'outputs'],
                        additionalProperties: false,
                        properties: {
                          complete: { const: true },
                          ignored: { type: 'array', items: { type: 'string', minLength: 1 } },
                          outputs: { type: 'array', items: { type: 'string', minLength: 1 } },
                        },
                      },
                    },
                  },
                ],
              },
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
                  artifactInputs: swiftpmArtifactInputs,
                  resources: { type: 'object', maxProperties: 256, additionalProperties: { type: 'string' } },
                  assetCatalog: { type: ['string', 'null'], minLength: 1 },
                },
              },
              cacheArtifact: { type: 'boolean' },
              stimBuild: { type: 'string', minLength: 1 },
              compat: {
                ...buildCompat,
                description: 'Compared instead of stimBuild by a machine whose build.offer toolchain reports compat.',
              },
              jdk: {
                type: 'string',
                pattern: '^[0-9]{1,3}$',
                description:
                  'The JDK major an Android build runs on, sent to a stim-server with the build-jdk feature.',
              },
            },
          }),
          request('build.cancel', buildJob),
          request('build.artifact', buildJob),
          request('build.cached-artifact', {
            type: 'object',
            required: ['repo', 'artifact'],
            additionalProperties: false,
            properties: {
              repo: buildRepo,
              artifact: buildArtifactIdentity,
              gradleArtifact: gradleArtifactQuery,
              reactNativeArtifact: reactNativeArtifactQuery,
              swiftpmArtifact: swiftpmArtifactQuery,
            },
          }),
          request('build.attach', buildJob),
          request('server.update.status'),
          request('device-host.sessions'),
          request('device-host.sessions.stop', session({})),
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
                  { $ref: '#/$defs/HostedSessionsResult' },
                  { $ref: '#/$defs/HostedSessionStopResult' },
                  { $ref: '#/$defs/HostedAppDelivery' },
                  { $ref: '#/$defs/HostedMetroResult' },
                  { $ref: '#/$defs/HostedAppOfferResult' },
                  { $ref: '#/$defs/HostedAppChunkResult' },
                  { $ref: '#/$defs/HostedAppHandoffResult' },
                  { $ref: '#/$defs/ServerUpdateStatus' },
                  { $ref: '#/$defs/ServerUpdateProgress' },
                  { $ref: '#/$defs/MachineUpdateStatus' },
                  { $ref: '#/$defs/HelloResult' },
                  { $ref: '#/$defs/DesktopAuthenticateResult' },
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
            required: ['event', 'subscription', 'stream', 'message'],
            additionalProperties: false,
            properties: {
              event: {
                enum: [
                  'desktop-stop-progress',
                  'desktop-reload-progress',
                  'desktop-start-progress',
                  'desktop-run-progress',
                  'desktop-build-progress',
                  'desktop-gc-progress',
                  'desktop-worktree-remove-progress',
                  'desktop-worktree-warm-progress',
                  'desktop-machine-access-progress',
                ],
              },
              subscription: { type: 'string' },
              stream: { enum: ['stdout', 'stderr'] },
              message: { type: 'string' },
            },
          },
          {
            type: 'object',
            required: ['event', 'subscription', 'exitCode', 'stdout', 'message'],
            additionalProperties: false,
            properties: {
              event: {
                enum: [
                  'desktop-stop-ended',
                  'desktop-reload-ended',
                  'desktop-start-ended',
                  'desktop-run-ended',
                  'desktop-build-ended',
                  'desktop-gc-ended',
                  'desktop-worktree-remove-ended',
                  'desktop-worktree-warm-ended',
                  'desktop-machine-access-ended',
                ],
              },
              subscription: { type: 'string' },
              exitCode: { enum: [0, 1] },
              stdout: { type: 'string' },
              message: { type: 'string' },
            },
          },
          {
            type: 'object',
            required: ['event', 'subscription', 'target', 'snapshot'],
            additionalProperties: false,
            properties: {
              event: { const: 'desktop-report' },
              subscription: { type: 'string' },
              target: { $ref: '#/$defs/DesktopReportTarget' },
              snapshot: { $ref: '#/$defs/DesktopReportSnapshot' },
            },
          },
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
            required: ['event', 'subscription', 'seq'],
            additionalProperties: false,
            properties: {
              event: { const: 'workspaces' },
              subscription: { type: 'string' },
              seq: { type: 'integer', minimum: 0 },
              snapshot: {
                type: 'object',
                required: ['workspaces', 'worktrees', 'archived'],
                additionalProperties: false,
                properties: {
                  workspaces: { type: 'array', items: { type: 'object' } },
                  worktrees: { type: 'array', items: { type: 'object' } },
                  archived: { type: 'object' },
                },
              },
              workspaces: keyedDelta('Workspace summaries to insert or replace by path.'),
              worktrees: keyedDelta('Unprovisioned worktree rows to insert or replace by path.'),
              archived: { type: 'object', description: 'The archives summary, when it changed.' },
            },
          },
          {
            type: 'object',
            required: ['event', 'subscription', 'seq', 'environment'],
            additionalProperties: false,
            properties: {
              event: { const: 'workspace' },
              subscription: { type: 'string' },
              seq: { type: 'integer', minimum: 0 },
              environment: {
                oneOf: [{ type: 'null' }, { type: 'object' }],
                description: 'The environment, as `stim status --json` prints it.',
              },
            },
          },
          {
            type: 'object',
            required: ['event', 'subscription', 'seq', 'machine'],
            additionalProperties: false,
            properties: {
              event: { const: 'machine' },
              subscription: { type: 'string' },
              seq: { type: 'integer', minimum: 0 },
              machine: { type: 'object' },
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
            required: ['event', 'subscription'],
            additionalProperties: false,
            properties: {
              event: { const: 'logs-ended' },
              subscription: { type: 'string' },
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
