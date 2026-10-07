import { isAbsolute } from 'node:path';
import { TAILNET_MACHINE_PATTERN } from './tailnet.ts';
import { HOSTED_AGENT_DRIVERS } from './hosted-macos.ts';

export const ANDROID_COMPILER_CACHE_CHOICES = ['auto', 'ccache', 'cas', 'none'] as const;
export const ANDROID_PCH_CHOICES = ['auto', 'on', 'off'] as const;

export type TunnelMode = 'auto' | 'off' | 'expo' | 'cloudflared' | 'ngrok' | 'tailscale';

export const TUNNEL_MODES: readonly TunnelMode[] = ['auto', 'off', 'expo', 'cloudflared', 'ngrok', 'tailscale'];

export type RemoteDeviceBackend = 'proxy' | 'eas';

export type SettingScope = 'machine' | 'workspace' | 'repo' | 'committed';

export const SETTING_SCOPES: readonly SettingScope[] = ['machine', 'workspace', 'repo', 'committed'];

export type SettingType =
  | { kind: 'string'; pattern?: string; patternHelp?: string }
  | { kind: 'path'; absolute?: boolean; relative?: boolean }
  | { kind: 'strings' }
  | { kind: 'number'; integer?: boolean; minimum?: number; exclusiveMinimum?: number; maximum?: number }
  | { kind: 'boolean' }
  | { kind: 'choice'; choices: readonly string[] }
  | { kind: 'object' }
  | { kind: 'bundle-url' };

/**
 * One setting Stim reads. `scopes` are the layers the setting may be written to;
 * `committedAt: 'repository'` reads the committed layer from the repository root's
 * `.stim.json` instead of the app's. A `sensitive` value is never printed and is
 * written to `.stim.json` only as an `env:` or `file:` reference. `scopedHomeValue`
 * replaces every layer and the default while STIM_HOME is set and `env` is not.
 * `ciValue` replaces every layer and the default while CI is set and `env` is not.
 * `desktopDefault` replaces `default` on macOS while Stim Desktop is installed.
 */
export interface SettingDefinition {
  key: string;
  type: SettingType;
  scopes: readonly SettingScope[];
  description: string;
  default?: string | number | boolean;
  env?: string;
  sensitive?: boolean;
  committedAt?: 'repository';
  scopedHomeValue?: string | number | boolean;
  ciValue?: string | number | boolean;
  desktopDefault?: string;
}

export interface SettingEntry {
  key: string;
  value: unknown;
  origin: SettingScope | 'env' | 'default' | null;
  layers: Partial<Record<SettingScope, unknown>>;
  env?: { name: string; value: string };
  sensitive?: true;
  defaultReason?: string;
}

/** The payload `stim settings --json` prints. */
export interface SettingsPayload {
  project: string | null;
  files: Partial<Record<SettingScope, string>>;
  settings: SettingEntry[];
  unknown: Array<{ key: string; scope: SettingScope; file: string; value: unknown }>;
}

export const REMOTE_DEVICE_BACKENDS: readonly RemoteDeviceBackend[] = ['proxy', 'eas'] as const;

export const IOS_SIMULATOR_APPS = ['xcode', 'siniulator', 'stim-desktop'] as const;

export const ANDROID_EMULATOR_APPS = ['emulator', 'stim-desktop'] as const;

export const OFFLOAD_MODES = ['auto', 'force', 'off'] as const;

export type OffloadMode = (typeof OFFLOAD_MODES)[number];

export const WEB_VIEWPORTS = ['desktop', 'phone'] as const;

export type WebViewport = (typeof WEB_VIEWPORTS)[number];

const PROJECT: readonly SettingScope[] = ['workspace', 'repo', 'committed'];
const EVERY: readonly SettingScope[] = ['machine', 'workspace', 'repo', 'committed'];
const MACHINE: readonly SettingScope[] = ['machine'];
const RECORDING: readonly SettingScope[] = ['machine', 'workspace', 'repo'];

const STRING = { kind: 'string' } as const;
const PATH = { kind: 'path' } as const;
const ABSOLUTE_PATH = { kind: 'path', absolute: true } as const;
const RELATIVE_PATH = { kind: 'path', relative: true } as const;
const BOOLEAN = { kind: 'boolean' } as const;
const OBJECT = { kind: 'object' } as const;
const PARKED_MAX = { kind: 'number', integer: true, minimum: 0 } as const;
const CAPACITY = { kind: 'number', integer: true, minimum: 0 } as const;
const GIGABYTES = { kind: 'number', minimum: 0 } as const;

function optimization(key: string, description: string, type: SettingType = BOOLEAN): SettingDefinition {
  return {
    key: `optimizations.${key}`,
    type,
    scopes: EVERY,
    description,
    ...(type.kind === 'boolean' ? { default: true } : {}),
  };
}

export const SETTINGS: readonly SettingDefinition[] = [
  optimization('buildCache', 'Read and write native build artifacts'),
  optimization('remoteBuildCache', 'Use remote artifact providers'),
  optimization('releaseBundleSwap', 'Swap current JS into cached release builds'),
  optimization('metroSharedCache', "Append Stim's shared Metro cache store"),
  optimization('metroWarmup', 'Prefetch the development bundle during ios and android'),
  optimization('ios.compilationCache', 'Xcode compilation caching'),
  {
    key: 'optimizations.ios.swiftCompilationCache',
    type: BOOLEAN,
    scopes: EVERY,
    description: 'Swift compilation caching; unset detects toolchain support',
  },
  optimization('ios.prefixMapping', 'Clang source and DerivedData prefix mapping'),
  {
    ...optimization('android.compilerCache', 'Android compiler cache backend', {
      kind: 'choice',
      choices: ANDROID_COMPILER_CACHE_CHOICES,
    }),
    default: 'auto',
  },
  {
    ...optimization('android.casToolchain', 'Absolute path to the Android CAS toolchain manifest', ABSOLUTE_PATH),
    env: 'STIM_ANDROID_CAS_TOOLCHAIN',
  },
  {
    ...optimization('android.pch', 'Android precompiled headers', { kind: 'choice', choices: ANDROID_PCH_CHOICES }),
    default: 'auto',
  },
  optimization('android.gradleBuildCache', 'Gradle build cache'),
  optimization('android.targetAbiOnly', 'Narrow Debug and hosted Android builds to the device ABI'),
  { key: 'ios.deviceType', type: STRING, scopes: EVERY, description: 'Simulator model for owned simulators' },
  { key: 'ios.runtime', type: STRING, scopes: EVERY, description: 'iOS runtime owned simulators are created on' },
  {
    key: 'ios.configuration',
    type: STRING,
    scopes: PROJECT,
    default: 'Debug',
    description: 'Xcode configuration to build, such as Debug or Release',
  },
  {
    key: 'ios.remote',
    type: {
      kind: 'string',
      pattern: TAILNET_MACHINE_PATTERN,
      patternHelp: 'eas, proxy, auto, or a tailnet machine name',
    },
    scopes: PROJECT,
    description:
      'Default iOS remote target: eas, proxy, or an approved Mac in hosting.machines; auto is not available yet',
  },
  {
    key: 'ios.simslimProfile',
    type: RELATIVE_PATH,
    scopes: PROJECT,
    description: 'SimSlim JSON profile under the app',
  },
  {
    key: 'ios.signingIdentity',
    type: STRING,
    scopes: PROJECT,
    description: 'Keychain identity used to re-seal a device build',
  },
  {
    key: 'ios.signingIdentitySha1',
    type: { kind: 'string', pattern: '^[0-9A-Fa-f]{40}$', patternHelp: 'a 40-character hex SHA-1 hash' },
    scopes: PROJECT,
    description: 'SHA-1 of the signing identity, when two share a name',
  },
  {
    key: 'ios.lanHost',
    type: {
      kind: 'string',
      pattern: '^(?!-)[A-Za-z0-9-]+(?:\\.(?!-)[A-Za-z0-9-]+)*$',
      patternHelp: 'a bare address or hostname, never a URL, scheme, or port',
    },
    scopes: PROJECT,
    description: "Address a phone uses to reach this workspace's Metro",
  },
  { key: 'android.systemImage', type: STRING, scopes: EVERY, description: 'SDK system image for owned AVDs' },
  {
    key: 'android.deviceProfile',
    type: STRING,
    scopes: EVERY,
    default: 'pixel_6',
    description: 'avdmanager hardware profile id for new owned AVDs',
  },
  {
    key: 'android.dataPartitionSizeGb',
    type: { kind: 'number', integer: true, minimum: 6, maximum: 16 * 1024 },
    scopes: PROJECT,
    default: 8,
    description: 'Data partition size of a new owned AVD, in GiB',
  },
  {
    key: 'android.avdConfigFile',
    type: RELATIVE_PATH,
    scopes: PROJECT,
    description: 'AVD config.ini fragment under the app',
  },
  { key: 'android.avdConfig', type: OBJECT, scopes: PROJECT, description: 'Validated AVD config values' },
  { key: 'android.variant', type: STRING, scopes: PROJECT, description: 'Gradle build variant' },
  {
    key: 'android.keystore',
    type: PATH,
    scopes: PROJECT,
    description: 'Keystore a re-packed release APK is signed with',
  },
  {
    key: 'android.keystorePassword',
    type: STRING,
    scopes: PROJECT,
    sensitive: true,
    description: 'Keystore password, or an apksigner env: or file: reference',
  },
  {
    key: 'android.remote',
    type: {
      kind: 'string',
      pattern: TAILNET_MACHINE_PATTERN,
      patternHelp: 'eas, proxy, auto, or a tailnet machine name',
    },
    scopes: PROJECT,
    description:
      'Default Android remote target: eas, proxy, or an approved Mac in hosting.machines; auto is not available yet',
  },
  {
    key: 'metro.tunnel',
    type: { kind: 'choice', choices: TUNNEL_MODES },
    scopes: PROJECT,
    default: 'auto',
    description: 'How a remote device reaches Metro; tailscale is tailnet-only and requires explicit selection',
  },
  { key: 'metro.ngrokUrl', type: STRING, scopes: PROJECT, description: 'Stable ngrok URL for the managed tunnel' },
  { key: 'metro.publicUrl', type: STRING, scopes: PROJECT, description: 'Existing public Metro URL' },
  {
    key: 'metro.port',
    type: { kind: 'number', integer: true, minimum: 1024, maximum: 65535 },
    scopes: PROJECT,
    env: 'STIM_METRO_PORT',
    description: "This workspace's Metro port, reserved instead of one Stim picks",
  },
  {
    key: 'metro.warmupUrl.ios',
    type: { kind: 'bundle-url' },
    scopes: PROJECT,
    description: 'Bundle URL `stim ios` prefetches to warm Metro',
  },
  {
    key: 'metro.warmupUrl.android',
    type: { kind: 'bundle-url' },
    scopes: PROJECT,
    description: 'Bundle URL `stim android` prefetches to warm Metro',
  },
  {
    key: 'metro.idleStopMinutes',
    type: { kind: 'number', integer: true, minimum: 0 },
    scopes: PROJECT,
    default: 60,
    description: 'Minutes without a bundle request, client log or Stim command before the dev server stops; 0 never',
  },
  {
    key: 'devices.idleShutdownMinutes',
    type: { kind: 'number', integer: true, minimum: 0 },
    scopes: EVERY,
    default: 30,
    description:
      'Minutes an owned simulator or emulator stays idle before the workspace supervisor shuts it down; 0 never',
  },
  {
    key: 'devices.reclaimIdleMinutes',
    type: { kind: 'number', integer: true, minimum: 0 },
    scopes: EVERY,
    default: 10,
    description:
      'Minutes an owned simulator or emulator stays idle before a waiting run reclaims its device slot; 0 never',
  },
  {
    key: 'macos.product',
    type: { kind: 'string', pattern: '^[A-Za-z0-9_-]+$', patternHelp: 'a Swift Package executable product name' },
    scopes: PROJECT,
    description: 'The Swift Package executable product stim macos builds in Debug.',
  },
  {
    key: 'macos.infoPlist',
    type: RELATIVE_PATH,
    scopes: PROJECT,
    description: 'Development Info.plist relative to the Swift Package directory.',
  },
  {
    key: 'macos.arguments',
    type: { kind: 'strings' },
    scopes: PROJECT,
    description: 'Arguments passed directly to the owned macOS development executable.',
  },
  {
    key: 'macos.assetCatalog',
    type: RELATIVE_PATH,
    scopes: PROJECT,
    description: 'Optional .xcassets directory relative to the Swift Package directory.',
  },
  {
    key: 'macos.resources',
    type: OBJECT,
    scopes: PROJECT,
    description:
      'Resource destinations under Contents/Resources mapped to sources relative to the Swift Package directory.',
  },
  {
    key: 'web.url',
    type: {
      kind: 'string',
      pattern: '^https?://',
      patternHelp: 'an http:// or https:// URL; {port:<label>} is replaced by a named or the Metro port',
    },
    scopes: PROJECT,
    description: 'Page `stim web` opens; unset opens the Metro URL for Expo web',
  },
  {
    key: 'web.ignoreCertificateErrors',
    type: BOOLEAN,
    scopes: PROJECT,
    default: false,
    description: "Accept self-signed dev certificates in Stim's owned Chrome profile",
  },
  {
    key: 'web.viewport',
    type: { kind: 'choice', choices: WEB_VIEWPORTS },
    scopes: PROJECT,
    default: 'desktop',
    description: 'Viewport of the owned Chrome page: desktop, or phone for a 390x844 touch screen',
  },
  {
    key: 'recording.enabled',
    type: BOOLEAN,
    scopes: RECORDING,
    default: true,
    env: 'STIM_RECORDING',
    description: 'Let stim-server record device screens for replay; false stops it and deletes the recordings',
  },
  {
    key: 'archive.enabled',
    type: BOOLEAN,
    scopes: EVERY,
    default: true,
    env: 'STIM_ARCHIVE_ENABLED',
    scopedHomeValue: false,
    description: 'Keep workspace history on removal; false under STIM_HOME unless explicitly enabled',
  },
  {
    key: 'archive.maxAgeDays',
    type: CAPACITY,
    scopes: MACHINE,
    default: 30,
    env: 'STIM_ARCHIVE_MAX_AGE_DAYS',
    description: 'Days to keep archived workspace records; 0 keeps nothing',
  },
  {
    key: 'archive.maxCount',
    type: CAPACITY,
    scopes: MACHINE,
    default: 200,
    env: 'STIM_ARCHIVE_MAX_COUNT',
    description: 'Archived workspace count; oldest records go first, 0 keeps nothing',
  },
  {
    key: 'archive.maxTotalGb',
    type: GIGABYTES,
    scopes: MACHINE,
    default: 5,
    env: 'STIM_ARCHIVE_MAX_TOTAL_GB',
    description: 'Total archived bytes in binary GB; 0 keeps no artifacts',
  },
  {
    key: 'archive.logs.maxAgeDays',
    type: CAPACITY,
    scopes: MACHINE,
    default: 14,
    env: 'STIM_ARCHIVE_LOGS_MAX_AGE_DAYS',
    description: 'Days to keep archived logs; 0 keeps none',
  },
  {
    key: 'archive.logs.maxMbPerWorkspace',
    type: GIGABYTES,
    scopes: MACHINE,
    default: 100,
    env: 'STIM_ARCHIVE_LOGS_MAX_MB_PER_WORKSPACE',
    description: 'Archived logs per workspace in binary MB; 0 keeps none',
  },
  {
    key: 'archive.recordings.maxAgeDays',
    type: CAPACITY,
    scopes: MACHINE,
    default: 3,
    env: 'STIM_ARCHIVE_RECORDINGS_MAX_AGE_DAYS',
    description: 'Days to keep archived recordings; 0 keeps none',
  },
  {
    key: 'archive.recordings.maxTotalGb',
    type: GIGABYTES,
    scopes: MACHINE,
    default: 2,
    env: 'STIM_ARCHIVE_RECORDINGS_MAX_TOTAL_GB',
    description: 'Archived recordings in binary GB; 0 keeps none',
  },
  {
    key: 'archive.agentActions.maxAgeDays',
    type: CAPACITY,
    scopes: MACHINE,
    default: 7,
    env: 'STIM_ARCHIVE_AGENT_ACTIONS_MAX_AGE_DAYS',
    description: 'Days to keep archived agent-device sessions; 0 keeps none',
  },
  {
    key: 'worktree.exclude',
    type: { kind: 'strings' },
    scopes: ['repo', 'committed'],
    committedAt: 'repository',
    description: 'Ignored paths `worktree warm` skips',
  },
  {
    key: 'worktree.defaultBranch',
    type: STRING,
    scopes: ['repo', 'committed'],
    committedAt: 'repository',
    description: 'Branch `worktree warm --refresh` expects the source checkout on',
  },
  { key: 'cache.provider', type: STRING, scopes: PROJECT, description: 'Second-tier cache provider module' },
  { key: 'cache.options', type: OBJECT, scopes: PROJECT, description: 'Options passed to the cache provider' },
  {
    key: 'iosSimulatorApp',
    type: { kind: 'choice', choices: IOS_SIMULATOR_APPS },
    scopes: MACHINE,
    default: 'xcode',
    desktopDefault: 'stim-desktop',
    description: 'App that displays an owned iOS simulator; stim-desktop by default when Stim Desktop is installed',
  },
  {
    key: 'androidEmulatorApp',
    type: { kind: 'choice', choices: ANDROID_EMULATOR_APPS },
    scopes: MACHINE,
    default: 'emulator',
    desktopDefault: 'stim-desktop',
    description:
      'App that displays an owned Android emulator Stim boots on macOS; stim-desktop by default when Stim Desktop is installed',
  },
  {
    key: 'concurrency.maxBuilds',
    type: CAPACITY,
    scopes: MACHINE,
    default: 0,
    env: 'STIM_MAX_BUILDS',
    description: 'Concurrent native builds; 0 means no limit',
  },
  {
    key: 'concurrency.maxDevices',
    type: CAPACITY,
    scopes: MACHINE,
    default: 0,
    env: 'STIM_MAX_DEVICES',
    description: 'Booted owned devices; 0 means no limit',
  },
  {
    key: 'budget.minFreeDiskGb',
    type: GIGABYTES,
    scopes: MACHINE,
    default: 20,
    env: 'STIM_BUDGET_MIN_FREE_DISK_GB',
    scopedHomeValue: 0,
    description: 'Free disk, in GB, ios, android and start reclaim toward; 0 reclaims only below the hard floor',
  },
  {
    key: 'budget.hardFloorDiskGb',
    type: GIGABYTES,
    scopes: MACHINE,
    default: 5,
    env: 'STIM_BUDGET_HARD_FLOOR_DISK_GB',
    scopedHomeValue: 0,
    description: 'Free disk, in GB, below which ios, android and start refuse with STIM_LOW_DISK; 0 never refuses',
  },
  {
    key: 'budget.maxCommittedMemoryGb',
    type: GIGABYTES,
    scopes: MACHINE,
    env: 'STIM_BUDGET_MAX_COMMITTED_MEMORY_GB',
    scopedHomeValue: 0,
    description:
      'Estimated memory, in GB, of live environments before idle ones are reclaimed; unset is 60% of RAM, 0 is off',
  },
  {
    key: 'budget.maxLiveWorkspaces',
    type: CAPACITY,
    scopes: MACHINE,
    env: 'STIM_BUDGET_MAX_LIVE_WORKSPACES',
    scopedHomeValue: 0,
    description: 'Live workspaces before idle ones are reclaimed; unset or 0 means no limit',
  },
  {
    key: 'maintenance.mode',
    type: { kind: 'choice', choices: ['off', 'report'] },
    scopes: MACHINE,
    default: 'report',
    env: 'STIM_MAINTENANCE',
    scopedHomeValue: 'off',
    ciValue: 'off',
    description:
      'Automatic resource maintenance. report measures, plans and logs what it would do and never deletes or stops anything; off disables it. Off under STIM_HOME or CI unless STIM_MAINTENANCE is set',
  },
  {
    key: 'maintenance.pressureCheckMinutes',
    type: { kind: 'number', integer: true, minimum: 1 },
    scopes: MACHINE,
    default: 1,
    env: 'STIM_MAINTENANCE_PRESSURE_CHECK_MINUTES',
    description: 'Disk and memory check interval in minutes',
  },
  {
    key: 'maintenance.sizeCheckMinutes',
    type: { kind: 'number', integer: true, minimum: 1 },
    scopes: MACHINE,
    default: 60,
    env: 'STIM_MAINTENANCE_SIZE_CHECK_MINUTES',
    description: 'Directory size check interval in minutes',
  },
  {
    key: 'maintenance.maxLoadPerCore',
    type: { kind: 'number', exclusiveMinimum: 0 },
    scopes: MACHINE,
    default: 4,
    env: 'STIM_MAINTENANCE_MAX_LOAD_PER_CORE',
    description: 'Defer size scans above this one-minute load per CPU',
  },
  {
    key: 'maintenance.logMaxMb',
    type: { kind: 'number', exclusiveMinimum: 0 },
    scopes: MACHINE,
    default: 1,
    env: 'STIM_MAINTENANCE_LOG_MAX_MB',
    description: 'Machine maintenance log rotation size in MiB',
  },
  {
    key: 'maintenance.logRetentionDays',
    type: { kind: 'number', integer: true, minimum: 1 },
    scopes: MACHINE,
    default: 30,
    env: 'STIM_MAINTENANCE_LOG_RETENTION_DAYS',
    description: 'Retention of the rotated machine maintenance log in days',
  },
  {
    key: 'maintenance.logChecks',
    type: BOOLEAN,
    scopes: MACHINE,
    default: false,
    env: 'STIM_MAINTENANCE_LOG_CHECKS',
    description: 'Write debug check records and routine skips',
  },
  {
    key: 'maintenance.memoryPressureLevel',
    type: { kind: 'choice', choices: ['warning', 'critical', 'off'] },
    scopes: MACHINE,
    default: 'warning',
    env: 'STIM_MAINTENANCE_MEMORY_PRESSURE_LEVEL',
    description: 'Lowest macOS memory pressure level considered; off disables memory pressure reporting',
  },
  {
    key: 'maintenance.memoryWarningMinutes',
    type: { kind: 'number', integer: true, minimum: 0 },
    scopes: MACHINE,
    default: 10,
    env: 'STIM_MAINTENANCE_MEMORY_WARNING_MINUTES',
    description: 'Consecutive warning minutes before memory counts as pressure',
  },
  {
    key: 'maintenance.minAvailableMemoryGb',
    type: { kind: 'number', minimum: 0 },
    scopes: MACHINE,
    env: 'STIM_MAINTENANCE_MIN_AVAILABLE_MEMORY_GB',
    description: 'Available-memory threshold in GiB; unset is 10% of RAM',
  },
  {
    key: 'maintenance.capTargetPercent',
    type: { kind: 'number', integer: true, minimum: 10, maximum: 100 },
    scopes: MACHINE,
    default: 80,
    env: 'STIM_MAINTENANCE_CAP_TARGET_PERCENT',
    description: 'Plan toward this percentage of each size cap',
  },
  {
    key: 'maintenance.workspaceOutputsMaxGb',
    type: { kind: 'number', minimum: 0 },
    scopes: MACHINE,
    default: 20,
    env: 'STIM_MAINTENANCE_WORKSPACE_OUTPUTS_MAX_GB',
    description: 'Workspace build-output cap in GiB; 0 means no cap',
  },
  {
    key: 'caches.buildCacheMaxGb',
    type: { kind: 'number', minimum: 0 },
    scopes: MACHINE,
    default: 10,
    env: 'STIM_CACHES_BUILD_CACHE_MAX_GB',
    description: 'Shared native build-cache cap in GiB; 0 means no cap',
  },
  {
    key: 'caches.metroCacheMaxGb',
    type: { kind: 'number', minimum: 0 },
    scopes: MACHINE,
    default: 5,
    env: 'STIM_CACHES_METRO_CACHE_MAX_GB',
    description: 'Combined Metro transform-cache cap in GiB; 0 means no cap',
  },
  {
    key: 'caches.swiftCompilationCacheMaxGb',
    type: { kind: 'number', minimum: 0 },
    scopes: MACHINE,
    default: 15,
    env: 'STIM_CACHES_SWIFT_COMPILATION_CACHE_MAX_GB',
    description: 'Swift compilation-cache cap in GiB; planned emptying is whole; 0 means no cap',
  },
  {
    key: 'gc.worktreeGraceMinutes',
    type: CAPACITY,
    scopes: MACHINE,
    default: 120,
    env: 'STIM_GC_WORKTREE_GRACE_MINUTES',
    description:
      'Minutes after a linked worktree last changed, or its branch or pull request finished, before gc removes it; 0 removes it at once',
  },
  {
    key: 'pool.iosParkedMax',
    type: PARKED_MAX,
    scopes: MACHINE,
    default: 3,
    env: 'STIM_POOL_IOS_PARKED_MAX',
    scopedHomeValue: 0,
    description: 'Parked simulators kept for adoption; 0 turns parking off',
  },
  {
    key: 'pool.androidParkedMax',
    type: PARKED_MAX,
    scopes: MACHINE,
    default: 3,
    env: 'STIM_POOL_ANDROID_PARKED_MAX',
    scopedHomeValue: 0,
    description: 'Parked emulators kept for adoption; 0 turns parking off',
  },
  {
    key: 'hosting.machines',
    type: { kind: 'strings' },
    scopes: MACHINE,
    description:
      'Tailscale names of the Macs that may host owned simulator sessions for this one, each optionally with :<port> of its tailscale serve route (default 7443); doctor --fix asks for separate device-host approval',
  },
  {
    key: 'hosting.agentDriver',
    type: { kind: 'choice', choices: HOSTED_AGENT_DRIVERS },
    scopes: MACHINE,
    default: 'none',
    description:
      "Tool this Mac starts so a client's coding agent can drive the macOS apps and iOS simulators it hosts for that client; none starts nothing",
  },
  {
    key: 'server.acceptClientBuilds',
    type: { kind: 'boolean' },
    scopes: MACHINE,
    default: false,
    description:
      "Whether a Mac approved for builds or device hosting here may update this Mac's stim-server service to that Mac's own stim-server build; releases from npm need no setting",
  },
  {
    key: 'offload.machines',
    type: { kind: 'strings' },
    scopes: MACHINE,
    description:
      'Tailscale names of the Macs that may build for this one, each optionally with :<port> of its tailscale serve route (default 7443)',
  },
  {
    key: 'offload.machine',
    type: {
      kind: 'string',
      pattern: TAILNET_MACHINE_PATTERN,
      patternHelp: 'auto, local, or a tailnet machine name',
    },
    scopes: MACHINE,
    default: 'auto',
    env: 'STIM_OFFLOAD_MACHINE',
    description:
      'Build placement: auto follows offload.mode with local fallback; local always builds here; a name in offload.machines requires that machine without fallback. The ios, android and macos --build-machine flag overrides this setting and its environment override',
  },
  {
    key: 'offload.mode',
    type: { kind: 'choice', choices: OFFLOAD_MODES },
    scopes: MACHINE,
    default: 'auto',
    env: 'STIM_OFFLOAD_MODE',
    description:
      'When offload.machine is auto, where iOS simulator Debug, Android emulator debug and macOS SwiftPM Debug builds run: auto builds here while this Mac has a free concurrency.maxBuilds slot and its load is under offload.maxLoadPerCore, and otherwise offloads to a less loaded machine in offload.machines; force offloads whenever a machine can take the build; off always builds here',
  },
  {
    key: 'offload.maxLoadPerCore',
    type: { kind: 'number', minimum: 0.1 },
    scopes: MACHINE,
    default: 2,
    description:
      'Load per core (5-minute load average divided by the CPU count) at which a Mac counts as saturated: a build machine declines offloaded builds, and auto offload stops preferring this Mac',
  },
  {
    key: 'offload.workerRoot',
    type: ABSOLUTE_PATH,
    scopes: MACHINE,
    description:
      'Directory where stim-server keeps the checkouts, dependencies and build state of Macs that build here; default $STIM_HOME/build-worker',
  },
  {
    key: 'offload.gradleDaemonIdleMinutes',
    type: { kind: 'number', integer: true, minimum: 0, maximum: 35_791 },
    scopes: MACHINE,
    default: 30,
    description:
      'Minutes the Gradle daemon of an offloaded Android build stays warm on this build machine after the build; 0 stops it when the build ends',
  },
  {
    key: 'caches.buildCache',
    type: ABSOLUTE_PATH,
    scopes: MACHINE,
    env: 'STIM_BUILD_CACHE',
    description: 'Absolute path of the shared build cache',
  },
  {
    key: 'caches.metroCache',
    type: ABSOLUTE_PATH,
    scopes: MACHINE,
    env: 'STIM_METRO_CACHE',
    description: 'Absolute parent path of the Metro transform caches',
  },
  {
    key: 'tempDir',
    type: ABSOLUTE_PATH,
    scopes: MACHINE,
    env: 'STIM_TMPDIR',
    description: 'Absolute directory for large temporary copies',
  },
];

const BY_KEY: ReadonlyMap<string, SettingDefinition> = new Map(SETTINGS.map((setting) => [setting.key, setting]));

export function settingDefinition(key: string): SettingDefinition | null {
  return BY_KEY.get(key) ?? null;
}

export function isLayeredSetting(setting: SettingDefinition): boolean {
  return setting.scopes.some((scope) => scope !== 'machine');
}

export const SETTING_GROUPS: readonly string[] = [
  ...new Set(
    SETTINGS.filter(isLayeredSetting).flatMap((setting) =>
      setting.key
        .split('.')
        .slice(0, -1)
        .map((_, index, parts) => parts.slice(0, index + 1).join('.')),
    ),
  ),
];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function bundleUrlAccepts(value: unknown, key: string): boolean {
  if (typeof value !== 'string' || !/^(https?:\/\/|\/(?!\/))/.test(value) || /[\s\\#]/.test(value)) return false;
  try {
    const url = new URL(value, 'http://localhost');
    return /\.bundle\/*$/.test(url.pathname) && url.searchParams.get('platform') === key.split('.').at(-1);
  } catch {
    return false;
  }
}

export function expectedShape(type: SettingType): string {
  switch (type.kind) {
    case 'boolean':
      return 'true or false';
    case 'string':
      return 'a string';
    case 'path':
      return 'a string path';
    case 'strings':
      return 'an array of strings';
    case 'number':
      return 'a number';
    case 'choice':
      return `one of: ${type.choices.join(', ')}`;
    case 'object':
      return 'an object';
    case 'bundle-url':
      return 'an HTTP(S) URL or /path ending in .bundle with a matching platform query and no fragment';
  }
}

export function acceptsShape(setting: SettingDefinition, value: unknown): boolean {
  const { type } = setting;
  switch (type.kind) {
    case 'boolean':
      return typeof value === 'boolean';
    case 'string':
    case 'path':
      return typeof value === 'string';
    case 'strings':
      return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
    case 'number':
      return typeof value === 'number';
    case 'choice':
      return typeof value === 'string' && type.choices.includes(value);
    case 'object':
      return isPlainObject(value);
    case 'bundle-url':
      return bundleUrlAccepts(value, setting.key);
  }
}

function numberBounds(type: {
  integer?: boolean;
  minimum?: number;
  exclusiveMinimum?: number;
  maximum?: number;
}): string {
  const noun = type.integer ? 'a whole number' : 'a number';
  if (type.minimum !== undefined && type.maximum !== undefined)
    return `${noun} from ${type.minimum} through ${type.maximum}`;
  if (type.exclusiveMinimum !== undefined) return `${noun}, greater than ${type.exclusiveMinimum}`;
  if (type.minimum !== undefined) return `${noun}, ${type.minimum} or more`;
  return noun;
}

export function settingValueError(setting: SettingDefinition, value: unknown): string | null {
  const { type } = setting;
  if (!acceptsShape(setting, value)) {
    return type.kind === 'number' ? numberBounds(type) : expectedShape(type);
  }
  if (type.kind === 'number') {
    const number = value as number;
    if (
      !Number.isFinite(number) ||
      (type.integer && !Number.isSafeInteger(number)) ||
      (type.minimum !== undefined && number < type.minimum) ||
      (type.exclusiveMinimum !== undefined && number <= type.exclusiveMinimum) ||
      (type.maximum !== undefined && number > type.maximum)
    ) {
      return numberBounds(type);
    }
  }
  if (type.kind === 'path') {
    const path = value as string;
    if (type.absolute && !isAbsolute(path)) return 'an absolute path';
    if (type.relative && (path.trim() === '' || isAbsolute(path))) return 'a relative path inside the app directory';
  }
  if (type.kind === 'string' && type.pattern && !new RegExp(type.pattern).test(value as string)) {
    return type.patternHelp ?? `a string matching ${type.pattern}`;
  }
  return null;
}

const SENSITIVE_REFERENCE = /^(env|file):\S/;

export function isSensitiveReference(value: unknown): boolean {
  return typeof value === 'string' && SENSITIVE_REFERENCE.test(value);
}

const JSON_ENCODED_KINDS: readonly SettingType['kind'][] = ['boolean', 'number', 'strings', 'object'];

/**
 * Coerces raw text (a CLI argument or an environment variable) through a setting's
 * registry type, the same way for both sources. Types whose values are not written
 * as bare text (boolean, number, strings, object) are read as JSON; a value that
 * fails to parse is left as the original string so `settingValueError` reports it. A boolean also reads `1` and `0`.
 */
export function coerceSettingText(setting: SettingDefinition, raw: string): unknown {
  if (!JSON_ENCODED_KINDS.includes(setting.type.kind)) return raw;
  if (setting.type.kind === 'boolean' && (raw === '1' || raw === '0')) return raw === '1';
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
