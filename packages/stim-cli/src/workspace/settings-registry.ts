import { isAbsolute } from 'node:path';
import { ANDROID_COMPILER_CACHE_CHOICES, ANDROID_PCH_CHOICES } from '../optimizations.ts';
import { TUNNEL_MODES } from '../engine/metro-reach.ts';
import type { RemoteDeviceBackend } from '../engine/device-remote.ts';

export type SettingScope = 'machine' | 'workspace' | 'repo' | 'committed';

export const SETTING_SCOPES: readonly SettingScope[] = ['machine', 'workspace', 'repo', 'committed'];

export type SettingType =
  | { kind: 'string'; pattern?: string; patternHelp?: string }
  | { kind: 'path'; absolute?: boolean; relative?: boolean }
  | { kind: 'strings' }
  | { kind: 'number'; integer?: boolean; minimum?: number; maximum?: number }
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
  scopedHomeValue?: number;
}

export const REMOTE_DEVICE_BACKENDS: readonly RemoteDeviceBackend[] = ['proxy', 'eas'] as const;

export const IOS_SIMULATOR_APPS = ['xcode', 'siniulator', 'stim-desktop'] as const;

const PROJECT: readonly SettingScope[] = ['workspace', 'repo', 'committed'];
const EVERY: readonly SettingScope[] = ['machine', 'workspace', 'repo', 'committed'];
const MACHINE: readonly SettingScope[] = ['machine'];

const STRING = { kind: 'string' } as const;
const PATH = { kind: 'path' } as const;
const ABSOLUTE_PATH = { kind: 'path', absolute: true } as const;
const RELATIVE_PATH = { kind: 'path', relative: true } as const;
const BOOLEAN = { kind: 'boolean' } as const;
const OBJECT = { kind: 'object' } as const;
const REMOTE = { kind: 'choice', choices: REMOTE_DEVICE_BACKENDS } as const;
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
  optimization('android.targetAbiOnly', 'Narrow Debug builds to the device ABI'),
  { key: 'ios.deviceType', type: STRING, scopes: PROJECT, description: 'Simulator model for owned simulators' },
  { key: 'ios.runtime', type: STRING, scopes: PROJECT, description: 'iOS runtime owned simulators are created on' },
  {
    key: 'ios.configuration',
    type: STRING,
    scopes: PROJECT,
    default: 'Debug',
    description: 'Xcode configuration to build, such as Debug or Release',
  },
  { key: 'ios.remote', type: REMOTE, scopes: PROJECT, description: 'Default remote backend for iOS' },
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
  { key: 'android.systemImage', type: STRING, scopes: PROJECT, description: 'SDK system image for owned AVDs' },
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
  { key: 'android.remote', type: REMOTE, scopes: PROJECT, description: 'Default remote backend for Android' },
  {
    key: 'metro.tunnel',
    type: { kind: 'choice', choices: TUNNEL_MODES },
    scopes: PROJECT,
    default: 'auto',
    description: 'How a remote device reaches Metro',
  },
  { key: 'metro.ngrokUrl', type: STRING, scopes: PROJECT, description: 'Stable ngrok URL for the managed tunnel' },
  { key: 'metro.publicUrl', type: STRING, scopes: PROJECT, description: 'Existing public Metro URL' },
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
    description: 'App that displays an owned iOS simulator',
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
    description: 'Free disk, in GB, ios, android and start reclaim toward; 0 turns reclaiming off',
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
    description: 'Live workspaces before idle ones are reclaimed; unset or 0 means no limit',
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

function numberBounds(type: { integer?: boolean; minimum?: number; maximum?: number }): string {
  const noun = type.integer ? 'a whole number' : 'a number';
  if (type.minimum !== undefined && type.maximum !== undefined)
    return `${noun} from ${type.minimum} through ${type.maximum}`;
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
