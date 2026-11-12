import { homedir } from 'node:os';
import { isAbsolute, parse, resolve } from 'node:path';
import { isJsonObject } from './json-file.ts';
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
  | { kind: 'path'; absolute?: boolean; relative?: boolean; patternHelp?: string }
  | { kind: 'strings'; absolutePaths?: boolean }
  | { kind: 'number'; integer?: boolean; minimum?: number; exclusiveMinimum?: number; maximum?: number }
  | { kind: 'boolean' }
  | { kind: 'choice'; choices: readonly string[] }
  | { kind: 'object' }
  | { kind: 'bundle-url' }
  | PluginRefType;

export type PluginKind = 'cache-provider' | 'transport' | 'agent-driver';

/**
 * A setting that names a plugin of one kind. With `choices` it is closed and names only those built-ins; without, it
 * takes a module path or package name. The schema and the settings payload show a closed reference as `choice` and an
 * open one as `string`; whether the module exists is checked only by `stim settings set`, `stim plugin list` and
 * doctor, never by the commands that use it.
 */
export interface PluginRefType {
  kind: 'plugin-ref';
  plugin: PluginKind;
  choices?: readonly string[];
}

/** The kind a plugin reference shows as outside the registry: `choice` when closed, else `string`. */
export function shownSettingType(type: SettingType): Exclude<SettingType, PluginRefType> {
  if (type.kind !== 'plugin-ref') return type;
  return type.choices
    ? { kind: 'choice', choices: type.choices }
    : { kind: 'string', pattern: '\\S', patternHelp: 'a module path or package name' };
}

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
  default?: string | number | boolean | readonly string[];
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
export type SettingsPayload = {
  project: string | null;
  files: Partial<Record<SettingScope, string>>;
  settings: SettingEntry[];
  unknown: Array<{ key: string; scope: SettingScope; file: string; value: unknown; replacement?: string }>;
};

/** The masked JSON result of a settings set or unset. */
export interface SettingWriteResult {
  key: string;
  scope: SettingScope;
  file: string;
  changed: boolean;
  setting: SettingEntry;
  recordingsDeleted?: string[];
}

export const REMOTE_DEVICE_BACKENDS: readonly RemoteDeviceBackend[] = ['proxy', 'eas'] as const;

export const IOS_SIMULATOR_APPS = ['xcode', 'siniulator', 'stim-desktop', 'none'] as const;

export const ANDROID_EMULATOR_APPS = ['emulator', 'stim-desktop'] as const;

// compat C5 permanent
export interface RemovedSetting {
  key?: string;
  replacement: string;
  env?: string;
  scopes?: readonly SettingScope[];
  refuses?: true;
  value?: (old: unknown) => string | null;
  off?: (old: unknown) => string | null;
  kept?: string;
}
function sameNumber(old: unknown): string | null {
  const value = typeof old === 'string' && old.trim() ? Number(old) : old;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? String(value) : null;
}
const offAtZero = (old: unknown): string | null => (sameNumber(old) === '0' ? '0' : null);
const FIXED_LADDER = 'nothing replaced it; the pressure ladder has fixed rules';
const fixed = (env: string): RemovedSetting => ({ replacement: FIXED_LADDER, env, refuses: true });
// prettier-ignore
export const REMOVED_SETTINGS: ReadonlyMap<string, RemovedSetting> = new Map(Object.entries({
  'remote.buildMode': { key: 'remote.build', replacement: 'remote.build', env: 'STIM_REMOTE_BUILD_MODE', value: (old) => old === 'auto' ? 'auto' : old === 'force' ? 'remote' : old === 'off' ? 'local' : null },
  'metro.idleStopMinutes': { key: 'idle.minutes', replacement: 'idle.minutes, which stops the dev server and the owned devices together', value: sameNumber, off: offAtZero, scopes: ['workspace', 'repo', 'committed'] },
  'devices.idleShutdownMinutes': { key: 'idle.minutes', replacement: 'idle.minutes, which stops the dev server and the owned devices together', value: sameNumber, off: offAtZero, scopes: ['machine', 'workspace', 'repo', 'committed'] },
  'share.webrtc': { replacement: 'nothing replaced it; web share viewers take video over the share socket only', env: 'STIM_WEBRTC_STUN' },
  'devices.reclaimIdleMinutes': { replacement: "the stim-daemon's reclaim rule replaced it: while a run waits to boot, the daemon shuts down the longest-idle device of another workspace idle 2 minutes or more" },
  'maintenance.deviceIdleDays': { key: 'idle.dormantDays', replacement: 'idle.dormantDays, after which an idle workspace goes dormant and its owned devices are deleted', env: 'STIM_MAINTENANCE_DEVICE_IDLE_DAYS', refuses: true, value: sameNumber },
  'budget.minFreeDiskGb': { key: 'disk.minFreeGb', replacement: 'disk.minFreeGb', env: 'STIM_BUDGET_MIN_FREE_DISK_GB', refuses: true, value: sameNumber },
  'budget.hardFloorDiskGb': { key: 'disk.hardFloorGb', replacement: 'disk.hardFloorGb', env: 'STIM_BUDGET_HARD_FLOOR_DISK_GB', refuses: true, value: sameNumber },
  'maintenance.criticalFreeDiskGb': { key: 'disk.criticalFreeGb', replacement: 'disk.criticalFreeGb', env: 'STIM_MAINTENANCE_CRITICAL_FREE_DISK_GB', refuses: true, value: sameNumber },
  'maintenance.mode': { key: 'daemon.mode', replacement: 'daemon.mode', env: 'STIM_MAINTENANCE', refuses: true, value: (old) => old === 'on' || old === 'report' || old === 'off' ? old : null, off: (old) => old === 'off' || old === 'report' ? old : null, scopes: ['machine'] },
  'daemon.enabled': { key: 'daemon.mode', replacement: 'daemon.mode', value: (old) => old === true || old === 'true' ? 'on' : old === false || old === 'false' ? 'off' : null },
  'maintenance.idleStopHours': { key: 'idle.dormantDays', replacement: 'idle.dormantDays for workspace dormancy', off: offAtZero, scopes: ['machine', 'workspace', 'repo', 'committed'], kept: 'now applies to hosted device sessions only' },
  'caches.injectMetroStore': { key: 'optimizations.metroSharedCache', replacement: 'optimizations.metroSharedCache', value: (old) => old === true || old === 'true' ? 'true' : old === false || old === 'false' ? 'false' : null },
  'budget.maxCommittedMemoryGb': fixed('STIM_BUDGET_MAX_COMMITTED_MEMORY_GB'),
  'budget.maxLiveWorkspaces': fixed('STIM_BUDGET_MAX_LIVE_WORKSPACES'),
  'maintenance.pressureCheckMinutes': fixed('STIM_MAINTENANCE_PRESSURE_CHECK_MINUTES'),
  'maintenance.sizeCheckMinutes': fixed('STIM_MAINTENANCE_SIZE_CHECK_MINUTES'),
  'maintenance.maxLoadPerCore': fixed('STIM_MAINTENANCE_MAX_LOAD_PER_CORE'),
  'maintenance.memoryPressureLevel': fixed('STIM_MAINTENANCE_MEMORY_PRESSURE_LEVEL'),
  'maintenance.memoryWarningMinutes': fixed('STIM_MAINTENANCE_MEMORY_WARNING_MINUTES'),
  'maintenance.minAvailableMemoryGb': fixed('STIM_MAINTENANCE_MIN_AVAILABLE_MEMORY_GB'),
  'maintenance.capTargetPercent': fixed('STIM_MAINTENANCE_CAP_TARGET_PERCENT'),
  'maintenance.idleCheckMinutes': fixed('STIM_MAINTENANCE_IDLE_CHECK_MINUTES'),
  'maintenance.urgentFreeDiskGb': fixed('STIM_MAINTENANCE_URGENT_FREE_DISK_GB'),
  'maintenance.pressureProtectMinutes': fixed('STIM_MAINTENANCE_PRESSURE_PROTECT_MINUTES'),
}));
export function replacementAdvice(
  key: string,
  old: unknown,
  scope?: SettingScope,
): (RemovedSetting & { command: string | null }) | null {
  const removed = REMOVED_SETTINGS.get(key);
  if (!removed || removed.kept) return null;
  const value = removed.value?.(old);
  const target = settingDefinition(removed.key ?? '');
  const scoped =
    scope && target && target.scopes.length > 1 && target.scopes.includes(scope) ? ` --scope ${scope}` : '';
  const command = removed.key && value ? `stim settings set ${removed.key} ${value}${scoped}` : null;
  return { ...removed, command };
}
// compat end

export const SHARE_DEFAULT_PORT = 7790;

export const SHARE_EXPOSURES = ['auto', 'tailscale', 'proxy'] as const;

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
    key: 'ios.autoInstallRuntime',
    type: BOOLEAN,
    scopes: EVERY,
    default: false,
    description: 'Install an explicitly requested missing iOS simulator runtime on the selected Mac',
  },
  {
    key: 'ios.configuration',
    type: STRING,
    scopes: PROJECT,
    default: 'Debug',
    description: 'Xcode configuration to build, such as Debug or Release',
  },
  {
    key: 'ios.scheme',
    type: STRING,
    scopes: ['workspace', 'committed'],
    description: 'Shared Xcode scheme to build when the workspace has several; the --scheme flag overrides it',
  },
  {
    key: 'ios.remote',
    type: {
      kind: 'string',
      pattern: TAILNET_MACHINE_PATTERN,
      patternHelp: 'eas, proxy, local, auto, remote, remote-only, or a tailnet machine name',
    },
    scopes: EVERY,
    description:
      'Where the iOS simulator runs: local here (overriding a lower layer); auto here first, then a remote.machines entry when this machine is full or busy; remote on a remote.machines entry in order, here only when none takes it; remote-only the same but never here; a machine name exactly that machine; eas or proxy a remote device backend',
  },
  {
    key: 'ios.projectPath',
    type: { ...RELATIVE_PATH, patternHelp: 'a directory path relative to the app directory' },
    scopes: ['workspace', 'committed'],
    default: 'ios',
    description: "Directory under the app that holds a bare React Native app's Xcode project and Podfile",
  },
  {
    key: 'ios.simslim',
    type: { kind: 'choice', choices: ['on', 'off'] },
    scopes: EVERY,
    default: 'on',
    description:
      'Slim every Stim-owned iOS simulator by disabling background services when no ios.simslimProfile is set; off in a project opts that app out and restores stock services',
  },
  {
    key: 'ios.simslimProfile',
    type: { ...RELATIVE_PATH, patternHelp: 'a relative JSON file path inside the app directory' },
    scopes: PROJECT,
    description: 'JSON profile under the app that keeps simulator service categories or labels enabled when slimming',
  },
  {
    key: 'ios.signingIdentity',
    type: {
      kind: 'string',
      pattern: '^(?![\\s\\S]*[\\r\\n\\0])(?=[\\s\\S]*\\S)[\\s\\S]+$',
      patternHelp:
        'the identity name `security find-identity -v -p codesigning` prints, such as "Apple Development: Jane (TEAMID5678)"',
    },
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
    key: 'ios.appStoreConnectKeyPath',
    type: ABSOLUTE_PATH,
    scopes: MACHINE,
    env: 'STIM_ASC_KEY_PATH',
    sensitive: true,
    description: 'App Store Connect API key (.p8) that `stim device provision ios` authenticates with',
  },
  {
    key: 'ios.appStoreConnectKeyId',
    type: { kind: 'string', pattern: '^[A-Za-z0-9]+$', patternHelp: 'the key ID App Store Connect shows' },
    scopes: MACHINE,
    env: 'STIM_ASC_KEY_ID',
    description: 'Key ID of ios.appStoreConnectKeyPath',
  },
  {
    key: 'ios.appStoreConnectIssuerId',
    type: { kind: 'string', pattern: '^[A-Za-z0-9-]+$', patternHelp: 'the issuer ID App Store Connect shows' },
    scopes: MACHINE,
    env: 'STIM_ASC_ISSUER_ID',
    description: 'Issuer ID of ios.appStoreConnectKeyPath',
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
    key: 'android.installImages',
    type: { kind: 'choice', choices: ['auto', 'never'] },
    scopes: EVERY,
    default: 'auto',
    description: 'Whether Stim installs a missing system image with sdkmanager before creating an owned AVD',
  },
  {
    key: 'android.deviceProfile',
    type: {
      kind: 'string',
      pattern: '^[A-Za-z0-9 ._()-]*$',
      patternHelp: 'an avdmanager device id such as pixel_6 or Nexus 5X (`avdmanager list device -c`)',
    },
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
    type: { ...RELATIVE_PATH, patternHelp: 'a relative file path inside the app directory' },
    scopes: PROJECT,
    description: 'AVD config.ini fragment under the app',
  },
  { key: 'android.avdConfig', type: OBJECT, scopes: PROJECT, description: 'Validated AVD config values' },
  {
    key: 'android.gradleRoot',
    type: { ...RELATIVE_PATH, patternHelp: 'a directory path relative to the app directory' },
    scopes: ['workspace', 'committed'],
    default: 'android',
    description:
      'Directory relative to the app holding gradlew and settings.gradle; may be outside the app but not the repository',
  },
  {
    key: 'android.module',
    type: {
      kind: 'string',
      pattern: '^(:(?!\\.\\.?(?::|$))[A-Za-z0-9._-]+)+$',
      patternHelp: 'a Gradle project path such as :app',
    },
    scopes: ['workspace', 'committed'],
    default: ':app',
    description: "The app's Gradle project path, such as :app",
  },
  { key: 'android.variant', type: STRING, scopes: PROJECT, description: 'Gradle build variant' },
  {
    key: 'android.artifactInputs',
    type: OBJECT,
    scopes: PROJECT,
    description:
      'Complete repeatable native Gradle inputs for local APK caching, including declared local files and environment names',
  },
  {
    key: 'android.offloadInputs',
    type: OBJECT,
    scopes: PROJECT,
    description:
      'Native Gradle source sufficiency, exact ignored inputs and generated output directories for build workers',
  },
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
      patternHelp: 'eas, proxy, local, auto, remote, remote-only, or a tailnet machine name',
    },
    scopes: EVERY,
    description:
      'Where the Android emulator runs: local here (overriding a lower layer); auto here first, then a remote.machines entry when this machine is full or busy; remote on a remote.machines entry in order, here only when none takes it; remote-only the same but never here; a machine name exactly that machine; eas or proxy a remote device backend',
  },
  {
    key: 'metro.tunnel',
    type: { kind: 'choice', choices: TUNNEL_MODES },
    scopes: PROJECT,
    default: 'auto',
    description: 'How a remote device reaches Metro; tailscale is tailnet-only and requires explicit selection',
  },
  {
    key: 'metro.command',
    type: { kind: 'strings' },
    scopes: ['workspace', 'committed'],
    description:
      "Command that starts this project's dev server, as an argv array run from the app directory; {port} is replaced with the reserved Metro port",
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
    key: 'idle.minutes',
    type: { kind: 'number', integer: true, minimum: 0 },
    scopes: EVERY,
    default: 15,
    description:
      'Minutes without activity before a workspace goes idle: its dev server stops with its port kept, its owned simulators and emulators shut down, and its regenerable build outputs are deleted; stim revive resumes it. 0 turns the idle and dormant stages off',
  },
  {
    key: 'idle.dormantDays',
    type: { kind: 'number', minimum: 0 },
    scopes: MACHINE,
    default: 1,
    description:
      "Days without activity before a workspace goes dormant and is reduced to its minimal size: its regenerable build outputs and owned simulators and emulators are deleted (the parked pool is untouched), its logs are archived, and a linked worktree's node_modules and Pods are deleted for the next Stim command to restore; any Stim command run in it leaves the stage. Fractions of a day are allowed; 0 never",
  },
  {
    key: 'idle.sourceDormantDays',
    type: { kind: 'number', minimum: 0 },
    scopes: MACHINE,
    default: 7,
    description:
      "Days without activity before a source (main) checkout's node_modules and Pods are deleted, at any pressure level. No activity means no Stim command, source file write, git write or commit in the checkout or in any workspace in it, and no process or agent session working in it; a stim worktree warm copying from it counts as activity when the warmed app has a Stim workspace in the source. Linked worktrees follow idle.dormantDays and go first. Fractions of a day are allowed; 0 never",
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
    key: 'macos.artifactInputs',
    type: OBJECT,
    scopes: PROJECT,
    description:
      'Complete pinned, repeatable SwiftPM inputs producing a relocatable app for completed artifact caching.',
  },
  {
    key: 'macos.arguments',
    type: { kind: 'strings' },
    scopes: PROJECT,
    description: 'Arguments passed directly to the owned macOS development executable.',
  },
  {
    key: 'macos.remote',
    type: {
      kind: 'string',
      pattern: `^(?![Ee][Aa][Ss]$|[Pp][Rr][Oo][Xx][Yy]$)${TAILNET_MACHINE_PATTERN.slice(1)}`,
      patternHelp: 'local, auto, remote, remote-only, or a tailnet machine name (macOS has no eas or proxy backend)',
    },
    scopes: EVERY,
    description:
      'Where stim macos launches the app: local here; auto here unless this machine is busy, then a remote.machines entry; remote on a remote.machines entry in order, here only when none takes it; remote-only the same but never here; a machine name exactly that machine. The --remote flag overrides it',
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
    description:
      "Keep workspace history on removal, and archive a dirty finished worktree's changes before gc removes it; false keeps such worktrees, and is the default under STIM_HOME unless explicitly enabled",
  },
  {
    key: 'archive.maxAgeDays',
    type: CAPACITY,
    scopes: MACHINE,
    default: 30,
    env: 'STIM_ARCHIVE_MAX_AGE_DAYS',
    description: 'Days to keep archived workspace records and worktree change archives; 0 keeps nothing',
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
    description: 'Total archived bytes in binary GB, and separately the worktree change archives; 0 keeps no artifacts',
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
    key: 'workspace.hidden',
    type: BOOLEAN,
    scopes: ['workspace'],
    default: false,
    description: 'Hide this workspace in Stim Desktop and the phone app; the next command that uses it unhides it',
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
  {
    key: 'cache.fingerprintInputs',
    type: { kind: 'strings' },
    scopes: PROJECT,
    description: 'Additional app-relative files and directories included in the native fingerprint',
  },
  {
    key: 'cache.provider',
    type: { kind: 'plugin-ref', plugin: 'cache-provider' },
    scopes: PROJECT,
    description: 'Second-tier cache provider module',
  },
  { key: 'cache.options', type: OBJECT, scopes: PROJECT, description: 'Options passed to the cache provider' },
  {
    key: 'iosSimulatorApp',
    type: { kind: 'choice', choices: IOS_SIMULATOR_APPS },
    scopes: MACHINE,
    default: 'xcode',
    desktopDefault: 'stim-desktop',
    description:
      'App that displays an owned iOS simulator, or none to open no viewer; stim-desktop by default when Stim Desktop is installed',
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
    description: 'Concurrent native builds; 0 derives max(1, floor(CPU cores / 6))',
  },
  {
    key: 'concurrency.maxDevices',
    type: CAPACITY,
    scopes: MACHINE,
    default: 0,
    env: 'STIM_MAX_DEVICES',
    description:
      'Booted owned iOS simulators and Android emulators together; local and hosted macOS apps use separate pools; 0 derives max(2, floor((RAM - 4 GB) / 1.5 GB))',
  },
  {
    key: 'concurrency.maxIosDevices',
    type: CAPACITY,
    scopes: MACHINE,
    default: 0,
    env: 'STIM_MAX_IOS_DEVICES',
    description: 'Booted owned iOS simulators, also bounded by concurrency.maxDevices; 0 means no per-platform limit',
  },
  {
    key: 'concurrency.maxAndroidDevices',
    type: CAPACITY,
    scopes: MACHINE,
    default: 0,
    env: 'STIM_MAX_ANDROID_DEVICES',
    description:
      'Booted owned Android emulators, also bounded by concurrency.maxDevices; 0 means no per-platform limit',
  },
  {
    key: 'concurrency.maxMacosApps',
    type: CAPACITY,
    scopes: MACHINE,
    default: 0,
    env: 'STIM_MAX_MACOS_APPS',
    description:
      'Local and hosted macOS apps in separate pools, also bounded by concurrency.maxDevices; 0 means no per-platform limit',
  },
  {
    key: 'disk.minFreeGb',
    type: GIGABYTES,
    scopes: MACHINE,
    default: 40,
    env: 'STIM_DISK_MIN_FREE_GB',
    description:
      'Free disk, in GB, on a volume Stim writes to below which the pressure level is high and the stim-daemon reclaims; 0 turns the high disk level off',
  },
  {
    key: 'disk.hardFloorGb',
    type: GIGABYTES,
    scopes: MACHINE,
    default: 5,
    env: 'STIM_DISK_HARD_FLOOR_GB',
    description:
      "Free disk, in GB, below which start, ios and android refuse with STIM_LOW_DISK after the stim-daemon's pressure ladder ran; 0 never refuses",
  },
  {
    key: 'disk.criticalFreeGb',
    type: GIGABYTES,
    scopes: MACHINE,
    default: 20,
    env: 'STIM_DISK_CRITICAL_FREE_GB',
    description:
      'Free disk, in GB, on a volume Stim writes to below which the pressure level is critical: the stim-daemon empties the Metro and compilation caches and deletes the devices of idle workspaces and their node_modules and Pods; 0 turns the critical disk level off',
  },
  {
    key: 'maintenance.logMaxMb',
    type: { kind: 'number', exclusiveMinimum: 0 },
    scopes: MACHINE,
    default: 1,
    env: 'STIM_MAINTENANCE_LOG_MAX_MB',
    description: 'Rotation size in MiB of the machine cleanup log (gc and maintenance)',
  },
  {
    key: 'maintenance.logRetentionDays',
    type: { kind: 'number', integer: true, minimum: 1 },
    scopes: MACHINE,
    default: 30,
    env: 'STIM_MAINTENANCE_LOG_RETENTION_DAYS',
    description: 'Retention in days of the rotated machine cleanup log (gc and maintenance)',
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
    key: 'maintenance.worktreeCheckMinutes',
    type: { kind: 'number', integer: true, minimum: 1 },
    scopes: MACHINE,
    default: 15,
    env: 'STIM_MAINTENANCE_WORKTREE_CHECK_MINUTES',
    description: 'Finished-worktree check interval in minutes',
  },
  {
    key: 'maintenance.idleStopHours',
    type: { kind: 'number', minimum: 0 },
    scopes: EVERY,
    default: 6,
    env: 'STIM_MAINTENANCE_IDLE_STOP_HOURS',
    description:
      'Hours before automatic maintenance stops a workspace with a device hosted on a remote Mac once it has no activity, as stim stop does, and before stim-server stops a hosted session whose client has been gone that long; the stim-daemon times every other workspace with idle.minutes and idle.dormantDays; 0 never',
  },
  {
    key: 'maintenance.sweepHours',
    type: { kind: 'number', integer: true, minimum: 0 },
    scopes: MACHINE,
    default: 24,
    env: 'STIM_MAINTENANCE_SWEEP_HOURS',
    description: 'Age sweep interval in hours; 0 turns the age sweep off',
  },
  {
    key: 'maintenance.olderThanDays',
    type: { kind: 'number', integer: true, minimum: 0 },
    scopes: MACHINE,
    default: 3,
    env: 'STIM_MAINTENANCE_OLDER_THAN_DAYS',
    description:
      'Days unused before the age sweep removes it: workspace build outputs, shared cache entries, parked simulators and emulators, and, with maintenance.removeIdleWorktrees, clean pushed linked worktrees; 0 turns those age removals off',
  },
  {
    key: 'maintenance.protectRecentHours',
    type: { kind: 'number', integer: true, minimum: 0 },
    scopes: MACHINE,
    default: 2,
    env: 'STIM_MAINTENANCE_PROTECT_RECENT_HOURS',
    description: 'Cache entries used within this many hours are never evicted',
  },
  {
    key: 'maintenance.gradleVersionIdleDays',
    type: { kind: 'number', integer: true, minimum: 0 },
    scopes: MACHINE,
    default: 7,
    env: 'STIM_MAINTENANCE_GRADLE_VERSION_IDLE_DAYS',
    description:
      "Days an unpinned Gradle version's caches and wrapper distribution stay unmodified before the stim-daemon deletes them, on its daily sweep or at once under disk pressure, after stopping the idle Gradle and Kotlin daemons that keep them; 0 turns this off",
  },
  {
    key: 'maintenance.removeFinishedWorktrees',
    type: BOOLEAN,
    scopes: MACHINE,
    default: true,
    env: 'STIM_MAINTENANCE_REMOVE_FINISHED_WORKTREES',
    description:
      "Remove linked worktrees whose branch or pull request finished, under gc.worktreeGraceMinutes, archiving a dirty one's uncommitted files first, and clean, pushed ones with no commits of their own once idle",
  },
  {
    key: 'maintenance.removeIdleWorktrees',
    type: BOOLEAN,
    scopes: MACHINE,
    default: false,
    env: 'STIM_MAINTENANCE_REMOVE_IDLE_WORKTREES',
    description:
      'In the age sweep, also remove clean, pushed linked worktrees whose branch is not merged once no Stim command has used them for maintenance.olderThanDays, with their git-ignored files; needs maintenance.removeFinishedWorktrees',
  },
  {
    key: 'maintenance.discoverRoots',
    type: { kind: 'strings', absolutePaths: true },
    scopes: MACHINE,
    default: [],
    description:
      'Absolute folders (a leading ~ is the home folder) whose direct children Maintenance and stim gc treat as checkouts, even when no stim command ever ran in them, when Stim recognises them as a project it handles. Linked worktrees of repositories Stim knows, and the direct children of folders that hold a known project, are found without this setting; it adds folders neither covers. A discovered checkout follows the rules of a registered workspace, and a scoped STIM_HOME discovers only from this list',
  },
  {
    key: 'maintenance.keep',
    type: BOOLEAN,
    scopes: PROJECT,
    default: false,
    description:
      'Pin this workspace: the stim-daemon never moves it to the idle or dormant stage, and automatic maintenance and the pressure ladder never clear its build outputs, delete its owned devices or remove its worktree',
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
    key: 'maintenance.cargoTargetMaxGb',
    type: { kind: 'number', minimum: 0 },
    scopes: MACHINE,
    default: 25,
    env: 'STIM_MAINTENANCE_CARGO_TARGET_MAX_GB',
    description:
      "Cap in GiB for one Cargo target/ (an Exact app's or a workspace root's, in a registered workspace or a discovered checkout), in use or not: above it, automatic maintenance removes the profiles and target triples no build wrote or read in the last day, and stops there; 0 means no cap",
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
    default: 0,
    env: 'STIM_CACHES_SWIFT_COMPILATION_CACHE_MAX_GB',
    description:
      'Swift compilation-cache cap in GiB; above it the cache is emptied whole, while no build holds it; 0 means no cap',
  },
  {
    key: 'caches.ccacheMaxGb',
    type: { kind: 'number', exclusiveMinimum: 0 },
    scopes: MACHINE,
    default: 5,
    env: 'STIM_CACHES_CCACHE_MAX_GB',
    description: 'ccache size limit in GiB, passed to ccache as CCACHE_MAXSIZE; ccache evicts by itself',
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
    key: 'pool.bootedGraceMinutes',
    type: CAPACITY,
    scopes: MACHINE,
    default: 15,
    env: 'STIM_POOL_BOOTED_GRACE_MINUTES',
    scopedHomeValue: 0,
    description:
      'Minutes a parked simulator stays booted when memory pressure is normal and a device slot is free, so the next ios adopts it without a boot; 0 shuts it down at once',
  },
  {
    key: 'daemon.mode',
    type: { kind: 'choice', choices: ['on', 'report', 'off'] },
    scopes: MACHINE,
    default: 'on',
    env: 'STIM_DAEMON',
    ciValue: 'off',
    description:
      "The automatic passes of the per-home stimd: the idle and dormant stages, the pressure ladder and automatic maintenance. on: start, ios, android, web, macos and revive start stimd, which exits once nothing runs in the home and every workspace is dormant or removed, and the passes act. report: the passes log what they would do and act on nothing. off: no pass runs. In every mode stimd runs each workspace's Metro and tunnel and collects device logs, so start, ios, android, web and revive start it when they need one; under off it stops a dev server and the workspace's devices idle for idle.minutes and exits once nothing runs. Without a running stimd, a command under the hard disk floor runs the pressure ladder in its own process. stimd keeps the mode it started with, STIM_DAEMON included, unless the machine setting later turns stricter, and the CI and non-sensitive setting environment overrides of the command that started it for its whole life. Off in CI unless STIM_DAEMON is set",
  },
  {
    key: 'daemon.attachedExitWaitSeconds',
    type: CAPACITY,
    scopes: MACHINE,
    default: 120,
    env: 'STIM_DAEMON_ATTACHED_EXIT_WAIT_SECONDS',
    description:
      "Seconds a stimd attached to one command, because a detached start was blocked or stim ci runs the job, keeps serving after that command ends while other commands' operations are still in flight. It then writes a handover journal for the next stimd and exits; 0 exits at once",
  },
  {
    key: 'engine.autoUpdate',
    type: { kind: 'choice', choices: ['auto', 'on', 'off'] },
    scopes: MACHINE,
    default: 'auto',
    description:
      "Whether stimd moves the machine engine to the newest version on its channel by itself: once a day, when Stim Desktop connects, when a phone needs a newer engine, and at most once an hour while a crash-looping build is held. auto: on for an engine Stim Desktop installed or a service runs, off for any other, such as a global npm install. A person's stim engine use or rollback pin stops it until stim engine update, and it never moves to a build at or below one that crash-looped. Needs an engine installed with stim engine install",
  },
  {
    key: 'debug.logs',
    type: { kind: 'boolean' },
    scopes: MACHINE,
    default: false,
    env: 'STIM_DEBUG',
    description:
      'Debug-level logging. While on, the CLI records its commands, child processes and requests to other machines, and stim-server records every request with its timings, under STIM_HOME/logs/debug/ with rotation. Nothing is sent anywhere, and records never carry arguments, tokens or tickets',
  },
  {
    key: 'hosting.agentDriver',
    type: { kind: 'plugin-ref', plugin: 'agent-driver', choices: HOSTED_AGENT_DRIVERS },
    scopes: MACHINE,
    default: 'none',
    description:
      "Tool this Mac starts so a client's coding agent can drive the macOS apps, iOS simulators and Android emulators it hosts for that client; none starts nothing",
  },
  {
    key: 'server.buildsPaused',
    type: { kind: 'boolean' },
    scopes: MACHINE,
    default: false,
    description:
      'Temporarily refuse new incoming builds without interrupting running builds, serving cached artifacts, or changing client approvals; local CLI builds remain available',
  },
  {
    key: 'server.devicesPaused',
    type: { kind: 'boolean' },
    scopes: MACHINE,
    default: false,
    description:
      'Temporarily refuse new hosted iOS, Android and macOS sessions without interrupting existing sessions or changing client approvals; local CLI devices remain available',
  },
  {
    key: 'server.acceptClientBuilds',
    type: { kind: 'boolean' },
    scopes: MACHINE,
    default: false,
    description:
      "Whether a machine approved for builds or device hosting here may update this machine's stim-server service to that machine's own stim-server build; releases from npm need no setting",
  },
  {
    key: 'server.keepAwake',
    type: { kind: 'boolean' },
    scopes: MACHINE,
    default: false,
    description:
      'Keep this Mac from idle system sleep while it runs on AC power and stim-server accepts connections from other machines on its tailnet or local network (caffeinate -s: the display may still sleep). A --loopback-only server holds nothing, and the setting has no effect on Linux and Windows',
  },
  {
    key: 'share.exposure',
    type: { kind: 'choice', choices: SHARE_EXPOSURES },
    scopes: MACHINE,
    default: 'auto',
    description:
      'How stim share is reached from the internet: tailscale through a Tailscale Funnel route, proxy through your own reverse proxy that forwards to a loopback port, auto tailscale when the tailscale command is installed and logged in, else proxy. proxy never runs tailscale serve or tailscale funnel',
  },
  {
    key: 'share.publicUrl',
    type: {
      kind: 'string',
      pattern: '^https://[^\\s/?#@]+(/[^\\s?#]*)?$',
      patternHelp: 'an https origin, optionally with a path prefix, such as https://demo.example.com',
    },
    scopes: MACHINE,
    description:
      'The https address your reverse proxy serves shares under in proxy mode, optionally with a path prefix that the proxy leaves on the path, such as https://demo.example.com. Share links print under it and its origin is the only one the frame socket accepts. Without it proxy mode prints a loopback link and a warning',
  },
  {
    key: 'share.port',
    type: { kind: 'number', integer: true, minimum: 1024, maximum: 65535 },
    scopes: MACHINE,
    default: SHARE_DEFAULT_PORT,
    description:
      'The loopback port the share listener binds in proxy mode, so your reverse proxy can name it. It is not used in tailscale mode, which picks a free port',
  },
  {
    key: 'server.lanAddresses',
    type: { kind: 'strings' },
    scopes: MACHINE,
    default: [],
    description:
      "IPv4 addresses or network interface names (such as en0) on which stim-server also accepts machines and phones on the local network, without Tailscale, on its own port. Empty listens on no local network address. Wildcard addresses are refused. Connections there run protocol 2's Noise authentication and encryption, without TLS",
  },
  {
    key: 'remote.machines',
    type: { kind: 'strings' },
    scopes: MACHINE,
    description:
      'The remote machines this machine may build on and host owned simulators, emulators and macOS apps on: a Tailscale name, optionally with :<port> of its tailscale serve route (default 7443), or local: and a host name or IPv4 address on the local network, optionally with :<port> of its stim-server (default 7787), whose server key stim remote add pins after a person confirms its fingerprint. The order is the placement priority: each workload goes to the first machine with room and a load under its own limit. What each is used for follows the build and device-host approvals it grants, which stim remote add asks for separately. Change the list with stim remote add and stim remote remove',
  },
  {
    key: 'remote.buildPoolDisabled',
    type: { kind: 'strings' },
    scopes: MACHINE,
    default: [],
    description:
      "Members excluded from this requester's automatic build placement: local or exact remote.machines entries. Explicit placement and running builds are unaffected; at least one local or configured, approved remote member must stay enabled",
  },
  {
    key: 'remote.devicePoolDisabled',
    type: { kind: 'strings' },
    scopes: MACHINE,
    default: [],
    description:
      "Members excluded from this requester's automatic simulator and emulator placement: local or exact remote.machines entries. Explicit placement and existing sessions are unaffected; at least one local or configured, approved remote member must stay enabled",
  },
  {
    key: 'remote.easFallback',
    type: BOOLEAN,
    scopes: EVERY,
    default: false,
    description:
      'When ios.remote or android.remote is auto or remote, this machine is at a device cap (concurrency.maxDevices or a per-platform cap) and no remote.machines entry takes the run, run the simulator or emulator on a billed EAS Simulator instead of waiting or refusing, when eas-cli can; remote-only never uses it',
  },
  {
    key: 'remote.easMaxDurationMinutes',
    type: { kind: 'number', integer: true, minimum: 1 },
    scopes: MACHINE,
    default: 30,
    description:
      "Maximum minutes of each EAS Simulator session Stim creates, after which EAS stops it and stops billing; stim stop and stim gc end a session sooner. EAS rejects a value above the account plan's session limit",
  },
  {
    key: 'remote.build',
    type: {
      kind: 'string',
      pattern: TAILNET_MACHINE_PATTERN,
      patternHelp: 'local, auto, remote, remote-only, or a tailnet machine name',
    },
    scopes: MACHINE,
    default: 'auto',
    env: 'STIM_REMOTE_BUILD',
    description:
      'Where iOS simulator, Android emulator and macOS SwiftPM Debug builds run: local here; auto here while it has a free concurrency.maxBuilds slot and load under server.maxLoadPerCore, otherwise on a remote.machines entry; remote on a remote.machines entry in order, here only when none takes the build; remote-only the same but never here; a machine name exactly that machine without fallback. The ios, android and macos --remote-build flag overrides this setting and its environment override',
  },
  {
    key: 'server.maxOffloadedBuilds',
    type: CAPACITY,
    scopes: MACHINE,
    default: 0,
    description:
      'Builds from other machines this machine runs at once, across every client; 0 means no limit. server.maxLoadPerCore, concurrency.maxBuilds and the free disk floor still apply',
  },
  {
    key: 'server.maxLoadPerCore',
    type: { kind: 'number', minimum: 0.1 },
    scopes: MACHINE,
    default: 2,
    description:
      'Load per core (5-minute load average divided by the CPU count) at which this machine counts as saturated: it declines builds other machines send it, reports the limit in its device offers so other machines skip it like a full one, stops preferring itself for automatic placement, and automatic iOS, Android and macOS placement treats it as busy',
  },
  {
    key: 'server.workerRoot',
    type: ABSOLUTE_PATH,
    scopes: MACHINE,
    description:
      'Directory where stim-server keeps the checkouts, dependencies and build state of the machines that build here; default $STIM_HOME/build-worker',
  },
  {
    key: 'server.workerAreaMaxAgeDays',
    type: CAPACITY,
    scopes: MACHINE,
    default: 7,
    description:
      "Days since its last build or cached artifact fetch after which stim-server removes a repository area under server.workerRoot, keeping each client's most recently used one; 0 turns this age removal off. Areas are still removed, least recently used first, while the volume nears its free disk floor",
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

function bundleUrlAccepts(value: unknown, key: string): boolean {
  if (typeof value !== 'string' || !/^(https?:\/\/|\/(?!\/))/.test(value) || /[\s\\#]/.test(value)) return false;
  try {
    const url = new URL(value, 'http://localhost');
    return /\.bundle\/*$/.test(url.pathname) && url.searchParams.get('platform') === key.split('.').at(-1);
  } catch {
    return false;
  }
}

export function expectedShape(declared: SettingType): string {
  const type = shownSettingType(declared);
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
  const type = shownSettingType(setting.type);
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
      return isJsonObject(value);
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

export function settingValueError(definition: SettingDefinition | string, value: unknown): string | null {
  const setting = typeof definition === 'string' ? settingDefinition(definition) : definition;
  if (!setting) throw new Error(`Unknown Stim setting: ${definition}`);
  const type = shownSettingType(setting.type);
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
  if (type.kind === 'strings' && type.absolutePaths) {
    const entries = Array.isArray(value) ? value : [];
    const relative = entries.find((entry) => !isAbsolute(entry) && !/^~(?:[\\/]|$)/.test(entry));
    if (relative !== undefined)
      return `an array of absolute paths (a leading ~ is the home folder), not ${JSON.stringify(relative)}`;
    const broad = entries.find((entry) => {
      const path = entry === '~' || entry.startsWith('~/') ? resolve(homedir(), entry.slice(2)) : resolve(entry);
      return path === resolve(homedir()) || path === parse(path).root;
    });
    if (broad !== undefined)
      return `an array of folders below the home folder, not ${JSON.stringify(broad)}: the home folder and the filesystem root are too broad to discover in`;
  }
  if (type.kind === 'path') {
    const path = value as string;
    if (type.absolute && !isAbsolute(path)) return 'an absolute path';
    if (type.relative && (path.trim() === '' || path !== path.trim() || /[\r\n\0]/.test(path) || isAbsolute(path)))
      return type.patternHelp ?? 'a relative path inside the app directory';
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

export function settingValueAt(settings: unknown, path: string): unknown {
  let node = settings;
  for (const segment of path.split('.')) {
    if (!isJsonObject(node)) return undefined;
    node = node[segment];
  }
  return node;
}

/** Sets a dotted key, or deletes it and empty parents when value is undefined. Returns whether a write occurred. */
export function setSettingValueAt(settings: Record<string, unknown>, path: string, value: unknown): boolean {
  const parts = path.split('.');
  const leaf = parts.at(-1) ?? '';
  const chain: Array<{ parent: Record<string, unknown>; key: string }> = [];
  let node = settings;
  for (const key of parts.slice(0, -1)) {
    const child = node[key];
    let next: Record<string, unknown>;
    if (isJsonObject(child)) next = child;
    else {
      if (value === undefined) return false;
      next = {};
      node[key] = next;
    }
    chain.push({ parent: node, key });
    node = next;
  }
  if (value !== undefined) node[leaf] = value;
  else {
    if (!(leaf in node)) return false;
    delete node[leaf];
    for (const { parent, key } of chain.toReversed()) {
      if (Object.keys(node).length) break;
      delete parent[key];
      node = parent;
    }
  }
  return true;
}

/** Resolves and validates env, scoped-home, CI, config and default values, in that order. */
export function machineSettingValue(
  key: string,
  { config, env }: { config: unknown; env: NodeJS.ProcessEnv },
): { value: unknown; error: string | null } {
  const setting = settingDefinition(key);
  if (!setting) return { value: undefined, error: `${key} is not in the settings registry` };
  const raw = setting.env ? env[setting.env] : undefined;
  const explicit = raw !== undefined && raw !== '';
  let value: unknown;
  let checked: unknown;
  if (explicit) {
    value = coerceSettingText(setting, raw.trim());
    checked = value;
  } else {
    const parts = key.split('.');
    for (let index = 1; index < parts.length; index++) {
      const group = parts.slice(0, index).join('.');
      const container = settingValueAt(config, group);
      if (container !== undefined && !isJsonObject(container))
        return { value: undefined, error: `${group} in the config is not an object` };
    }
    const configured = settingValueAt(config, key);
    checked = configured === undefined ? setting.default : configured;
    if (env.STIM_HOME && setting.scopedHomeValue !== undefined) value = setting.scopedHomeValue;
    else if (env.CI && setting.ciValue !== undefined) value = setting.ciValue;
    else value = checked;
  }
  const expected = checked === undefined ? null : settingValueError(setting, checked);
  const error = expected
    ? `Invalid ${explicit ? setting.env : key} value ${JSON.stringify(explicit ? raw : checked)}. Expected ${expected}.`
    : null;
  return { value, error };
}
