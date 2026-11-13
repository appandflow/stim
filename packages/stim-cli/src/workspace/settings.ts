import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'fs';
import { isAbsolute, join, normalize, relative, resolve, sep } from 'path';
import type { CacheProviderConfig } from '@stim-cli/cache';
import type { StimContext } from '@stim-cli/core';
import { throwIfCancelled } from '../cancellation.ts';
import { WorkspaceProcessCleanupError } from '../engine/workspace-process-lock.ts';
import { getConfigPath, getProjectSettings, getRepoSettings, loadConfig } from './config.ts';
import {
  gitCommonDir as projectGitCommonDir,
  repoRoot as projectRepoRoot,
  gitCommonDirAsync,
  repoRootAsync,
} from './worktree.ts';
import type { TunnelMode } from '../engine/metro-reach.ts';
import type { RemoteDeviceBackend } from '../engine/device-remote.ts';
import {
  isLayeredSetting,
  isJsonObject as isPlainObject,
  settingValueAt,
  setSettingValueAt,
  coerceSettingText,
  placementWord,
  settingDefinition,
  settingValueError,
  REMOTE_DEVICE_BACKENDS,
  REMOVED_SETTINGS,
  SETTING_GROUPS,
  SETTINGS,
  WEB_VIEWPORTS,
  type AutomaticPlacement,
  type SettingScope,
  type SettingsObject,
  type WebViewport,
} from '@stim-cli/core/state';
export type { SettingsObject };

export function mergeSettingsLayers(layers: Array<SettingsObject | null | undefined>): SettingsObject {
  const out: SettingsObject = {};
  for (const layer of layers) {
    if (!isPlainObject(layer)) continue;
    for (const [key, value] of Object.entries(layer)) {
      if (key === '__proto__') continue;
      if (isPlainObject(value) && isPlainObject(out[key])) {
        out[key] = mergeSettingsLayers([out[key] as SettingsObject, value]);
      } else if (!(key in out)) {
        out[key] = value;
      }
    }
  }
  return out;
}

export { REMOTE_DEVICE_BACKENDS };

const LAYERED_SETTINGS = SETTINGS.filter(isLayeredSetting);

const KNOWN_SETTINGS = new Set([...LAYERED_SETTINGS.map((setting) => setting.key), ...SETTING_GROUPS]);

const BOUNDS_CHECKED_WHEN_USED: ReadonlySet<string> = new Set(['android.dataPartitionSizeGb']);

export const SETTINGS_WITH_RESOLVE_TIME_FALLBACK: ReadonlySet<string> = new Set(['optimizations.android.casToolchain']);

export const PATH_SETTINGS: readonly string[] = Object.freeze(
  LAYERED_SETTINGS.filter((setting) => setting.type.kind === 'path').map((setting) => setting.key),
);

export { settingValueAt } from '@stim-cli/core/state';

export function settingShapeErrors(settings: unknown): string[] {
  const errors: string[] = [];
  for (const group of SETTING_GROUPS) {
    const value = settingValueAt(settings, group);
    if (value === undefined || isPlainObject(value)) continue;
    errors.push(`Invalid ${group} setting ${JSON.stringify(value)}. Expected an object.`);
  }
  for (const setting of LAYERED_SETTINGS) {
    if (SETTINGS_WITH_RESOLVE_TIME_FALLBACK.has(setting.key)) continue;
    const raw = settingValueAt(settings, setting.key);
    if (raw === undefined || (setting.key === 'cache.provider' && typeof raw === 'string')) continue;
    const value =
      typeof raw === 'string' && (setting.key === 'ios.signingIdentitySha1' || setting.key === 'ios.lanHost')
        ? raw.trim()
        : raw;
    const expected =
      BOUNDS_CHECKED_WHEN_USED.has(setting.key) && typeof value === 'number' ? null : settingValueError(setting, value);
    if (expected) errors.push(`Invalid ${setting.key} setting ${JSON.stringify(raw)}. Expected ${expected}.`);
  }
  return errors;
}

export const SETTING_SHAPE_REMEDY = 'Run `stim guide settings` for the shape each setting takes.';

function validateAndroidDataPartitionSizeGb(raw: unknown): number {
  const error = settingValueError('android.dataPartitionSizeGb', raw);
  if (error) throw new Error(`Invalid android.dataPartitionSizeGb setting ${JSON.stringify(raw)}. Expected ${error}.`);
  return raw as number;
}

export function androidDataPartitionSizeBytes(sizeGb: unknown): number {
  return validateAndroidDataPartitionSizeGb(sizeGb) * 1024 ** 3;
}

export function androidDataPartitionSizeGbSetting(settings: unknown): number {
  const raw = settingValueAt(settings, 'android.dataPartitionSizeGb');
  return raw === undefined
    ? Number(settingDefinition('android.dataPartitionSizeGb')!.default)
    : validateAndroidDataPartitionSizeGb(raw);
}

export function androidDataPartitionSizeGbSettingError(settings: unknown): string | null {
  try {
    androidDataPartitionSizeGbSetting(settings);
    return null;
  } catch (error) {
    return String((error as Error)?.message || error);
  }
}

interface AndroidAvdConfigRule {
  parse: (value: unknown) => string;
  help: string;
}

function yesNoAvdValue(value: unknown): string {
  if (value === true || value === 'true' || value === 'yes') return 'yes';
  if (value === false || value === 'false' || value === 'no') return 'no';
  throw new Error('expected true, false, "yes", or "no"');
}

function boundedIntegerAvdRule(min: number, max: number, unit?: string): AndroidAvdConfigRule {
  return {
    help: `integer ${min}-${max}${unit ? ` ${unit}` : ''}`,
    parse: (value) => {
      const parsed =
        typeof value === 'number'
          ? value
          : typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)
            ? Number(value)
            : Number.NaN;
      if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
        throw new Error(`expected an integer from ${min} through ${max}${unit ? ` ${unit}` : ''}`);
      }
      return String(parsed);
    },
  };
}

function enumAvdRule(values: readonly string[]): AndroidAvdConfigRule {
  return {
    help: values.join('|'),
    parse: (value) => {
      if (typeof value !== 'string' || !values.includes(value)) {
        throw new Error(`expected one of: ${values.join(', ')}`);
      }
      return value;
    },
  };
}

const ANDROID_AVD_CONFIG_RULES: Record<string, AndroidAvdConfigRule> = {
  'hw.cpu.ncore': boundedIntegerAvdRule(1, 64),
  'hw.gpu.mode': enumAvdRule(['auto', 'host', 'software', 'lavapipe', 'swiftshader', 'swangle']),
  'hw.initialOrientation': enumAvdRule(['portrait', 'landscape']),
  'hw.lcd.density': boundedIntegerAvdRule(72, 1000, 'dpi'),
  'hw.lcd.vsync': boundedIntegerAvdRule(1, 1000, 'Hz'),
  'hw.ramSize': boundedIntegerAvdRule(1536, 8192, 'MB'),
  'hw.screen': enumAvdRule(['no-touch', 'touch', 'multi-touch']),
  'runtime.network.latency': enumAvdRule([
    'none',
    'gsm',
    'hscsd',
    'gprs',
    'edge',
    'umts',
    'hsdpa',
    'lte',
    'evdo',
    '5g',
  ]),
  'runtime.network.speed': enumAvdRule(['gsm', 'hscsd', 'gprs', 'edge', 'umts', 'hsdpa', 'lte', 'evdo', '5g', 'full']),
  'vm.heapSize': boundedIntegerAvdRule(16, 4096, 'MB'),
};

const YES_NO_AVD_RULE: AndroidAvdConfigRule = { help: 'true|false|yes|no', parse: yesNoAvdValue };

for (const key of [
  'hw.accelerometer',
  'hw.accelerometer_uncalibrated',
  'hw.audioInput',
  'hw.audioOutput',
  'hw.battery',
  'hw.dPad',
  'hw.gps',
  'hw.gpu.enabled',
  'hw.gyroscope',
  'hw.keyboard',
  'hw.mainKeys',
  'hw.rotaryInput',
  'hw.trackBall',
  'showDeviceFrame',
]) {
  ANDROID_AVD_CONFIG_RULES[key] = YES_NO_AVD_RULE;
}

const ANDROID_AVD_CONFIG_KEYS: readonly string[] = Object.freeze(Object.keys(ANDROID_AVD_CONFIG_RULES).toSorted());

export const ANDROID_AVD_CONFIG_HELP: readonly string[] = Object.freeze(
  ANDROID_AVD_CONFIG_KEYS.map((key) => `${key}: ${ANDROID_AVD_CONFIG_RULES[key]!.help}`),
);

function isSafeAndroidAvdConfigKey(key: string): boolean {
  return Object.hasOwn(ANDROID_AVD_CONFIG_RULES, key);
}

function normalizedAndroidAvdConfigEntry(key: unknown, value: unknown): [string, string] {
  if (typeof key !== 'string' || key !== key.trim() || !isSafeAndroidAvdConfigKey(key)) {
    throw new Error(
      `Unsupported android.avdConfig key ${JSON.stringify(key)}. Use a documented safe hardware override; identity, path, storage, image, snapshot, and boot-lifecycle keys are protected.`,
    );
  }
  if (typeof value === 'string' && /[\r\n\0]/.test(value)) {
    throw new Error(`Invalid android.avdConfig value for ${key}: expected one line.`);
  }
  try {
    return [key, ANDROID_AVD_CONFIG_RULES[key]!.parse(value)];
  } catch (error) {
    throw new Error(`Invalid android.avdConfig value for ${key}: ${String((error as Error)?.message || error)}.`, {
      cause: error,
    });
  }
}

export function parseAndroidAvdConfigIni(contents: string): Record<string, string> {
  const entries: Record<string, string> = {};
  const lines = contents.replace(/^\uFEFF/, '').split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = String(lines[index] ?? '').trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) {
      throw new Error(`Invalid android.avdConfigFile line ${index + 1}: expected key=value.`);
    }
    const [key, value] = normalizedAndroidAvdConfigEntry(line.slice(0, separator), line.slice(separator + 1).trim());
    if (Object.hasOwn(entries, key)) {
      throw new Error(`Invalid android.avdConfigFile line ${index + 1}: duplicate key ${key}.`);
    }
    entries[key] = value;
  }
  return entries;
}

function pathEscapesRoot(root: string, path: string): boolean {
  const child = relative(root, path);
  return child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child);
}

export function realpathInside(root: string, path: string): string {
  const base = realpathSync(root);
  const real = realpathSync(resolve(base, path));
  if (pathEscapesRoot(base, real)) throw new Error(`it resolves outside ${base}`);
  return real;
}

export function androidAvdConfigSetting(settings: unknown, settingsRoot: string): Record<string, string> {
  if (!isPlainObject(settings) || !isPlainObject(settings.android)) return {};
  const android = settings.android;
  let entries: Record<string, string> = {};
  if ('avdConfigFile' in android) {
    const pathError = settingValueError('android.avdConfigFile', android.avdConfigFile);
    if (typeof android.avdConfigFile !== 'string' || pathError)
      throw new Error(`Invalid android.avdConfigFile setting. Expected ${pathError}.`);
    try {
      const root = realpathSync(settingsRoot);
      const candidate = resolve(root, android.avdConfigFile);
      if (pathEscapesRoot(root, candidate)) throw new Error('path escapes the settings root');
      const path = realpathSync(candidate);
      if (pathEscapesRoot(root, path)) throw new Error('symlink target escapes the settings root');
      const stat = statSync(path);
      if (!stat.isFile()) throw new Error('path is not a regular file');
      if (stat.size > 64 * 1024) throw new Error('file exceeds 64 KiB');
      const contents = readFileSync(path, 'utf8');
      if (Buffer.byteLength(contents) > 64 * 1024) throw new Error('file exceeds 64 KiB');
      entries = parseAndroidAvdConfigIni(contents);
    } catch (error) {
      throw new Error(
        `Could not read valid android.avdConfigFile ${android.avdConfigFile}: ${String((error as Error)?.message || error)}`,
        { cause: error },
      );
    }
  }
  if ('avdConfig' in android) {
    if (settingValueError('android.avdConfig', android.avdConfig)) {
      throw new Error('Invalid android.avdConfig setting. Expected an object of native AVD key/value pairs.');
    }
    for (const [key, value] of Object.entries(android.avdConfig as SettingsObject)) {
      const [normalizedKey, normalizedValue] = normalizedAndroidAvdConfigEntry(key, value);
      entries[normalizedKey] = normalizedValue;
    }
  }
  return entries;
}

export function androidAvdConfigSettingError(settings: unknown, projectPath: string): string | null {
  try {
    androidAvdConfigSetting(settings, projectPath);
    return null;
  } catch (error) {
    return String((error as Error)?.message || error);
  }
}

export const DEFAULT_IOS_PROJECT_PATH = 'ios';

export interface IosProjectDir {
  dir: string;
  relative: string;
  custom: boolean;
}

export function iosProjectDirSetting(settings: unknown, appRoot: string): IosProjectDir {
  const value = settingValueAt(settings, 'ios.projectPath');
  if (
    value === undefined ||
    (typeof value === 'string' && normalize(value).replace(/[\\/]+$/, '') === DEFAULT_IOS_PROJECT_PATH)
  ) {
    return { dir: join(appRoot, DEFAULT_IOS_PROJECT_PATH), relative: DEFAULT_IOS_PROJECT_PATH, custom: false };
  }
  const pathError = settingValueError('ios.projectPath', value);
  if (typeof value !== 'string' || pathError)
    throw new Error(`Invalid ios.projectPath setting. Expected ${pathError}.`);
  try {
    const root = realpathSync(appRoot);
    const candidate = resolve(root, value);
    if (pathEscapesRoot(root, candidate)) throw new Error('path escapes the app directory');
    const dir = realpathSync(candidate);
    if (pathEscapesRoot(root, dir)) throw new Error('symlink target escapes the app directory');
    if (!statSync(dir).isDirectory()) throw new Error('path is not a directory');
    if (!readdirSync(dir).some((name) => name.endsWith('.xcworkspace') || name.endsWith('.xcodeproj'))) {
      throw new Error('it holds no .xcworkspace or .xcodeproj');
    }
    return { dir, relative: relative(root, dir) || '.', custom: true };
  } catch (error) {
    throw new Error(`Could not use ios.projectPath ${value}: ${String((error as Error)?.message || error)}`, {
      cause: error,
    });
  }
}

export function iosProjectDirSettingError(settings: unknown, appRoot: string): string | null {
  try {
    iosProjectDirSetting(settings, appRoot);
    return null;
  } catch (error) {
    return String((error as Error)?.message || error);
  }
}

const INVALID_IOS_PROJECT_DIR = '\0invalid ios.projectPath';

export const DEFAULT_ANDROID_GRADLE_ROOT = 'android';
export const DEFAULT_ANDROID_MODULE = ':app';

export interface AndroidLayout {
  gradleRoot: string;
  gradleRootRelative: string;
  module: string;
  moduleDir: string;
  custom: boolean;
}

function hasGradleScript(dir: string, name: string): boolean {
  return existsSync(join(dir, `${name}.gradle`)) || existsSync(join(dir, `${name}.gradle.kts`));
}

export function androidLayoutSetting(settings: unknown, appRoot: string, bound: string): AndroidLayout {
  const rootValue = settingValueAt(settings, 'android.gradleRoot');
  const moduleValue = settingValueAt(settings, 'android.module');
  const custom =
    (rootValue !== undefined && rootValue !== DEFAULT_ANDROID_GRADLE_ROOT) ||
    (moduleValue !== undefined && moduleValue !== DEFAULT_ANDROID_MODULE);
  if (!custom) {
    const gradleRoot = join(appRoot, DEFAULT_ANDROID_GRADLE_ROOT);
    return {
      gradleRoot,
      gradleRootRelative: DEFAULT_ANDROID_GRADLE_ROOT,
      module: DEFAULT_ANDROID_MODULE,
      moduleDir: join(gradleRoot, 'app'),
      custom: false,
    };
  }
  const rawRoot = rootValue ?? DEFAULT_ANDROID_GRADLE_ROOT;
  const pathError = settingValueError('android.gradleRoot', rawRoot);
  if (typeof rawRoot !== 'string' || pathError)
    throw new Error(`Invalid android.gradleRoot setting. Expected ${pathError}.`);
  const module = moduleValue ?? DEFAULT_ANDROID_MODULE;
  const moduleError = settingValueError('android.module', module);
  if (typeof module !== 'string' || moduleError) {
    throw new Error(
      `Invalid android.module setting ${JSON.stringify(module)}. Expected a Gradle project path such as :app.`,
    );
  }
  try {
    const app = realpathSync(appRoot);
    const limit = realpathSync(bound);
    const gradleRoot = realpathSync(resolve(app, rawRoot));
    if (pathEscapesRoot(limit, gradleRoot)) throw new Error(`it resolves outside ${limit}`);
    if (!statSync(gradleRoot).isDirectory()) throw new Error('it is not a directory');
    if (!hasGradleScript(gradleRoot, 'settings')) throw new Error('it holds no settings.gradle or settings.gradle.kts');
    const mapped = join(gradleRoot, ...module.split(':').filter(Boolean));
    if (!hasGradleScript(mapped, 'build')) {
      throw new Error(`module ${module} has no build.gradle or build.gradle.kts at ${mapped}`);
    }
    const moduleDir = realpathSync(mapped);
    if (pathEscapesRoot(limit, moduleDir)) throw new Error(`module ${module} resolves outside ${limit}`);
    return {
      gradleRoot,
      gradleRootRelative: relative(app, gradleRoot).split(sep).join('/') || '.',
      module,
      moduleDir,
      custom: true,
    };
  } catch (error) {
    throw new Error(`Could not use android.gradleRoot ${rawRoot}: ${String((error as Error)?.message || error)}`, {
      cause: error,
    });
  }
}

export function androidLayoutSettingError(settings: unknown, appRoot: string, bound: string): string | null {
  try {
    androidLayoutSetting(settings, appRoot, bound);
    return null;
  } catch (error) {
    return String((error as Error)?.message || error);
  }
}

const INVALID_ANDROID_GRADLE_ROOT = '\0invalid android.gradleRoot';

export function defaultAndroidLayout(appRoot: string): AndroidLayout {
  return androidLayoutSetting({}, appRoot, appRoot);
}

export function resolveAndroidLayout(settings: SettingsObject | null, root: string, bound: string): AndroidLayout {
  if (settings === null) return defaultAndroidLayout(root);
  try {
    return androidLayoutSetting(settings, root, bound);
  } catch {
    const gradleRoot = join(root, INVALID_ANDROID_GRADLE_ROOT);
    return {
      gradleRoot,
      gradleRootRelative: INVALID_ANDROID_GRADLE_ROOT,
      module: DEFAULT_ANDROID_MODULE,
      moduleDir: join(gradleRoot, 'app'),
      custom: true,
    };
  }
}

export function resolveIosProjectDir(settings: SettingsObject | null, root: string): IosProjectDir {
  if (settings === null) {
    return { dir: join(root, DEFAULT_IOS_PROJECT_PATH), relative: DEFAULT_IOS_PROJECT_PATH, custom: false };
  }
  try {
    return iosProjectDirSetting(settings, root);
  } catch {
    return { dir: join(root, INVALID_IOS_PROJECT_DIR), relative: INVALID_IOS_PROJECT_DIR, custom: true };
  }
}

export function iosSimSlimProfileSetting(settings: unknown, settingsRoot: string): string | null {
  if (!isPlainObject(settings) || !isPlainObject(settings.ios) || !('simslimProfile' in settings.ios)) return null;
  const value = settings.ios.simslimProfile;
  const pathError = settingValueError('ios.simslimProfile', value);
  if (typeof value !== 'string' || pathError)
    throw new Error(`Invalid ios.simslimProfile setting. Expected ${pathError}.`);
  try {
    const root = realpathSync(settingsRoot);
    const candidate = resolve(root, value);
    if (pathEscapesRoot(root, candidate)) throw new Error('path escapes the settings root');
    const path = realpathSync(candidate);
    if (pathEscapesRoot(root, path)) throw new Error('symlink target escapes the settings root');
    const stat = statSync(path);
    if (!stat.isFile()) throw new Error('path is not a regular file');
    if (stat.size > 64 * 1024) throw new Error('file exceeds 64 KiB');
    return path;
  } catch (error) {
    throw new Error(`Could not read ios.simslimProfile ${value}: ${String((error as Error)?.message || error)}`, {
      cause: error,
    });
  }
}

export function iosSimSlimDefaultSetting(settings: unknown): boolean {
  return !(isPlainObject(settings) && isPlainObject(settings.ios) && settings.ios.simslim === 'off');
}

function settingError(settings: unknown, key: string): string | null {
  const raw = settingValueAt(settings, key);
  const value = typeof raw === 'string' && key !== 'ios.signingIdentity' ? raw.trim() : raw;
  const error = value === undefined ? null : settingValueError(key, value);
  return error ? `Invalid ${key} setting ${JSON.stringify(raw)}. Expected ${error}.` : null;
}

export function iosSigningIdentitySetting(settings: unknown): string | null {
  const raw = settingValueAt(settings, 'ios.signingIdentity');
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null;
}

export function iosSigningIdentitySettingError(settings: unknown): string | null {
  return settingError(settings, 'ios.signingIdentity');
}

export function iosSigningIdentitySha1Setting(settings: unknown): string | null {
  const raw = settingValueAt(settings, 'ios.signingIdentitySha1');
  return typeof raw === 'string' && !settingError(settings, 'ios.signingIdentitySha1')
    ? raw.trim().toUpperCase()
    : null;
}

export function iosSigningIdentitySha1SettingError(settings: unknown): string | null {
  return settingError(settings, 'ios.signingIdentitySha1');
}

export function iosLanHostSetting(settings: unknown): string | null {
  const raw = settingValueAt(settings, 'ios.lanHost');
  return typeof raw === 'string' && !settingError(settings, 'ios.lanHost') ? raw.trim() : null;
}

export function iosLanHostSettingError(settings: unknown): string | null {
  return settingError(settings, 'ios.lanHost');
}

export function unknownSettingKeys(settings: unknown, prefix = ''): string[] {
  if (!isPlainObject(settings)) return [];
  const unknown: string[] = [];
  for (const [key, value] of Object.entries(settings)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (path === '$schema') continue;
    if (
      KNOWN_SETTINGS.has(path) &&
      (!isPlainObject(value) || ![...KNOWN_SETTINGS].some((k) => k.startsWith(`${path}.`)))
    )
      continue;
    if (isPlainObject(value) && [...KNOWN_SETTINGS, ...REMOVED_SETTINGS.keys()].some((k) => k.startsWith(`${path}.`))) {
      unknown.push(...unknownSettingKeys(value, path));
      continue;
    }
    unknown.push(path);
  }
  return unknown;
}

export function inertSettingWarning(key: string): string {
  return `Warning: setting "${key}" is not read by Stim and will be ignored.`;
}

export function readCommittedSettings(directory?: string | null): SettingsObject {
  if (!directory) return {};
  const p = join(directory, '.stim.json');
  if (!existsSync(p)) return {};
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf-8'));
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

const MACHINE_READABLE_SETTINGS = SETTINGS.filter(
  (setting) =>
    isLayeredSetting(setting) && setting.scopes.includes('machine') && !setting.key.startsWith('optimizations.'),
);

export function removedMachineSettings(machine: unknown): SettingsObject {
  const settings: SettingsObject = {};
  for (const key of REMOVED_SETTINGS.keys()) {
    const value = settingValueAt(machine, key);
    if (value !== undefined) setSettingValueAt(settings, key, value);
  }
  return settings;
}

function machineLayerSettings(machine: unknown): SettingsObject | null {
  const settings: SettingsObject = removedMachineSettings(machine);
  const optimizations = settingValueAt(machine, 'optimizations');
  if (optimizations !== undefined) settings.optimizations = optimizations;
  for (const setting of MACHINE_READABLE_SETTINGS) {
    const value = settingValueAt(machine, setting.key);
    if (value !== undefined) setSettingValueAt(settings, setting.key, value);
  }
  return Object.keys(settings).length > 0 ? settings : null;
}

export interface SettingsLayer {
  scope: SettingScope;
  file: string;
  settings: SettingsObject;
}

export function settingsLayers({
  projectPath,
  gitCommonDir,
  repoRoot,
}: {
  projectPath?: string | null;
  gitCommonDir?: string | null;
  repoRoot?: string | null;
}): SettingsLayer[] {
  const machine = loadConfig();
  const machineFile = getConfigPath();
  const committedDir = projectPath ?? repoRoot;
  const machineSettings = machineLayerSettings(machine);
  return [
    projectPath
      ? {
          scope: 'workspace' as const,
          file: `${machineFile} (projects["${projectPath}"].settings)`,
          settings: getProjectSettings(projectPath),
        }
      : null,
    gitCommonDir
      ? {
          scope: 'repo' as const,
          file: `${machineFile} (repos["${gitCommonDir}"].settings)`,
          settings: getRepoSettings(gitCommonDir),
        }
      : null,
    committedDir
      ? {
          scope: 'committed' as const,
          file: join(committedDir, '.stim.json'),
          settings: readCommittedSettings(committedDir),
        }
      : null,
    machineSettings ? { scope: 'machine' as const, file: machineFile, settings: machineSettings } : null,
  ].filter((layer): layer is SettingsLayer => layer !== null);
}

export function settingOrigin(layers: SettingsLayer[], dottedKey: string): { file: string; value: unknown } | null {
  for (const layer of layers) {
    const value = settingValueAt(layer.settings, dottedKey);
    if (value !== undefined) return { file: layer.file, value };
  }
  return null;
}

/** The layer a resolved setting's value came from, or null when no layer set it (a default or a flag). */
export function settingOriginScope(layers: SettingsLayer[], dottedKey: string): SettingScope | null {
  for (const layer of layers) {
    if (settingValueAt(layer.settings, dottedKey) !== undefined) return layer.scope;
  }
  return null;
}

export function settingFile(
  context: { projectPath?: string | null; gitCommonDir?: string | null; repoRoot?: string | null },
  dottedKey: string,
): string | null {
  return settingOrigin(settingsLayers(context), dottedKey)?.file ?? null;
}

export function resolveSettings(context: {
  projectPath?: string | null;
  gitCommonDir?: string | null;
  repoRoot?: string | null;
}): SettingsObject {
  return mergeSettingsLayers(settingsLayers(context).map((layer) => layer.settings));
}

export interface ProjectSettingsContext {
  projectPath: string;
  gitCommonDir: string | null;
  repoRoot: string | null;
}

export function projectSettingsContext(
  root: string,
  git: { gitCommonDir: (cwd: string) => string | null; repoRoot: (cwd: string) => string | null } = {
    gitCommonDir: projectGitCommonDir,
    repoRoot: projectRepoRoot,
  },
): ProjectSettingsContext {
  return { projectPath: root, gitCommonDir: git.gitCommonDir(root), repoRoot: git.repoRoot(root) };
}

export interface ResolvedProjectSettings {
  context: ProjectSettingsContext;
  settings: SettingsObject;
}

export function resolveProjectSettings(root: string): ResolvedProjectSettings {
  const context = projectSettingsContext(root);
  return { context, settings: resolveSettings(context) };
}

type ProjectSettingsReadOptions = { env?: NodeJS.ProcessEnv; signal?: AbortSignal; declareFor?: StimContext };

export interface ProjectSettingsReaders {
  gitCommonDir: (cwd: string, options?: ProjectSettingsReadOptions) => string | null | Promise<string | null>;
  repoRoot: (cwd: string, options?: ProjectSettingsReadOptions) => string | null | Promise<string | null>;
}

/** Resolves repository paths asynchronously; declared probes run sequentially and cancellation rejects. */
export async function projectSettingsContextAsync(
  root: string,
  git: ProjectSettingsReaders = { gitCommonDir: gitCommonDirAsync, repoRoot: repoRootAsync },
  { env = process.env, signal, declareFor }: ProjectSettingsReadOptions = {},
): Promise<ProjectSettingsContext> {
  throwIfCancelled(signal, 'settings resolution');
  const options = { env, signal, declareFor };
  const common = Promise.resolve(git.gitCommonDir(root, options));
  const repo = declareFor ? common.then(() => git.repoRoot(root, options)) : git.repoRoot(root, options);
  const [commonResult, repoResult] = await Promise.allSettled([common, repo]);
  for (const result of [commonResult, repoResult])
    if (
      result.status === 'rejected' &&
      (result.reason instanceof WorkspaceProcessCleanupError ||
        (result.reason instanceof Error && 'reportCleanup' in result.reason))
    )
      throw result.reason;
  throwIfCancelled(signal, 'settings resolution');
  if (commonResult.status === 'rejected') throw commonResult.reason;
  if (repoResult.status === 'rejected') throw repoResult.reason;
  return { projectPath: root, gitCommonDir: commonResult.value, repoRoot: repoResult.value };
}

export async function resolveProjectSettingsAsync(
  root: string,
  options?: ProjectSettingsReadOptions,
): Promise<ResolvedProjectSettings> {
  const context = await projectSettingsContextAsync(root, undefined, options);
  return { context, settings: resolveSettings(context) };
}

export const METRO_COMMAND_PORT = '{port}';

export function metroCommandSetting(settings: SettingsObject): string[] | null {
  const value = settingValueAt(settings, 'metro.command');
  if (!Array.isArray(value) || !value.every((arg) => typeof arg === 'string')) return null;
  return typeof value[0] === 'string' && value[0].trim() !== '' ? value : null;
}

export function metroCommandSettingError(settings: SettingsObject): string | null {
  if (settingValueAt(settings, 'metro.command') === undefined) return null;
  const command = metroCommandSetting(settings);
  if (!command) return 'metro.command must be a non-empty array of strings whose first entry is the program to run.';
  if (!command.some((arg) => arg.includes(METRO_COMMAND_PORT))) {
    return `metro.command must pass ${METRO_COMMAND_PORT} so the dev server listens on this workspace's reserved port.`;
  }
  return null;
}

export function runnableMetroCommand(settings: SettingsObject): string[] | null {
  return metroCommandSettingError(settings) ? null : metroCommandSetting(settings);
}

interface CacheSettingsLayer {
  settings: SettingsObject;
  baseDir: string | null;
}

function cacheBlock(layer: SettingsObject | null | undefined): SettingsObject | null {
  if (!isPlainObject(layer) || !isPlainObject(layer.cache)) return null;
  return layer.cache;
}

export function resolveCacheProviderConfig({
  projectPath,
  gitCommonDir,
  repoRoot,
}: {
  projectPath?: string | null;
  gitCommonDir?: string | null;
  repoRoot?: string | null;
}): CacheProviderConfig | null {
  const layers: CacheSettingsLayer[] = [
    { settings: projectPath ? getProjectSettings(projectPath) : {}, baseDir: projectPath ?? null },
    { settings: gitCommonDir ? getRepoSettings(gitCommonDir) : {}, baseDir: repoRoot ?? projectPath ?? null },
    { settings: readCommittedSettings(projectPath), baseDir: projectPath ?? null },
  ];

  const references = layers.map((layer) => {
    const reference = cacheBlock(layer.settings)?.provider;
    return typeof reference === 'string' && reference.trim() !== '' ? reference.trim() : null;
  });
  const selected = layers.findIndex((layer, index) => references[index] !== null && layer.baseDir !== null);
  if (selected === -1) return null;
  const provider = references[selected]!;
  const baseDir = layers[selected]!.baseDir!;

  const options = mergeSettingsLayers(
    layers.map((layer, index) => {
      const namesProvider = references[index] === provider && layer.baseDir === baseDir;
      const overridesAbove = index < selected && references[index] === null;
      if (!namesProvider && !overridesAbove) return null;
      const block = cacheBlock(layer.settings)?.options;
      return isPlainObject(block) ? block : null;
    }),
  );
  return { provider, options, baseDir };
}

export function fingerprintInputsSetting(settings: unknown): string[] | undefined {
  const value = settingValueAt(settings, 'cache.fingerprintInputs');
  if (value === undefined) return undefined;
  const error = settingValueError('cache.fingerprintInputs', value);
  if (error) throw new Error(`Invalid cache.fingerprintInputs setting ${JSON.stringify(value)}. Expected ${error}.`);
  return value as string[];
}

export function cacheProviderSettingError(settings: SettingsObject): string | null {
  const block = settings.cache;
  if (!isPlainObject(block)) {
    return block === undefined
      ? null
      : `Invalid cache setting ${JSON.stringify(block)}. Expected an object with provider and options.`;
  }
  return (
    settingError(settings, 'cache.provider') ??
    settingError(settings, 'cache.options') ??
    settingError(settings, 'cache.fingerprintInputs')
  );
}

export type IosRemoteTarget =
  | { kind: 'backend'; backend: RemoteDeviceBackend }
  | { kind: 'machine'; machine: string; placement?: AutomaticPlacement };

/** The remote target `remote` names, or null for `local`, which runs on this machine whatever a lower layer sets. */
export function parseIosRemote(remote: string): IosRemoteTarget | null {
  const selected = remote.trim();
  const reserved = selected.toLowerCase();
  const word = placementWord(selected);
  if (word === 'local') return null;
  if (word) return { kind: 'machine', machine: 'auto', placement: word };
  return (REMOTE_DEVICE_BACKENDS as readonly string[]).includes(reserved)
    ? { kind: 'backend', backend: reserved as RemoteDeviceBackend }
    : { kind: 'machine', machine: selected };
}

export function remoteIosSetting(settings: SettingsObject): IosRemoteTarget | null {
  const ios = settings.ios;
  return isPlainObject(ios) && typeof ios.remote === 'string' ? parseIosRemote(ios.remote) : null;
}

export { parseIosRemote as parseAndroidRemote };

export function remoteEasFallbackSetting(settings: SettingsObject): boolean {
  return settingValueAt(settings, 'remote.easFallback') === true;
}

export function remoteAndroidSetting(settings: SettingsObject): IosRemoteTarget | null {
  const android = settings.android;
  return isPlainObject(android) && typeof android.remote === 'string' ? parseIosRemote(android.remote) : null;
}

/** `idle.minutes`, or its default when it is unset or invalid. */
export function idleMinutesSetting(settings: SettingsObject): number {
  const setting = settingDefinition('idle.minutes');
  const value = settingValueAt(settings, 'idle.minutes');
  return setting && value !== undefined && settingValueError(setting, value) === null
    ? (value as number)
    : Number(setting?.default);
}

export function maintenanceKeepSetting(settings: SettingsObject): boolean {
  const value = settingValueAt(settings, 'maintenance.keep');
  return value !== undefined && value !== false;
}

export function workspaceHiddenSetting(settings: SettingsObject | undefined): boolean {
  return settingValueAt(settings, 'workspace.hidden') === true;
}

export function tunnelModeSetting(settings: SettingsObject): TunnelMode | null {
  const mode = settingValueAt(settings, 'metro.tunnel');
  return typeof mode === 'string' && !settingError(settings, 'metro.tunnel') ? (mode as TunnelMode) : null;
}

export function metroTunnelSettingError(settings: SettingsObject): string | null {
  const block = settings.metro;
  if (!isPlainObject(block) || block.ngrokUrl === undefined) return null;
  if (block.tunnel !== 'ngrok') {
    return 'metro.ngrokUrl requires metro.tunnel to be "ngrok".';
  }
  if (normalizedHttpsUrl(block.ngrokUrl) === null) {
    return 'metro.ngrokUrl must be a valid HTTPS URL.';
  }
  return null;
}

export function metroPortSetting(
  settings: SettingsObject,
  env: NodeJS.ProcessEnv = process.env,
): { port: number | null; error: string | null } {
  const setting = settingDefinition('metro.port')!;
  const fromEnv = env.STIM_METRO_PORT?.trim();
  const value = fromEnv ? coerceSettingText(setting, fromEnv) : settingValueAt(settings, 'metro.port');
  if (value === undefined) return { port: null, error: null };
  const problem = settingValueError(setting, value);
  if (problem === null) return { port: value as number, error: null };
  const source = fromEnv
    ? `STIM_METRO_PORT value ${JSON.stringify(env.STIM_METRO_PORT)}`
    : `metro.port setting ${JSON.stringify(value)}`;
  return { port: null, error: `Invalid ${source}. Expected ${problem}.` };
}

export function publicUrlSetting(settings: SettingsObject): string | null {
  const block = settings.metro;
  if (typeof block !== 'object' || block === null) return null;
  const url = (block as { publicUrl?: unknown }).publicUrl;
  return typeof url === 'string' && url.trim() ? url : null;
}

export function metroWarmupUrlSetting(settings: SettingsObject, platform: 'ios' | 'android'): string | null {
  const value = settingValueAt(settings, `metro.warmupUrl.${platform}`);
  return typeof value === 'string' ? value : null;
}

export function ngrokUrlSetting(settings: SettingsObject): string | null {
  const block = settings.metro;
  if (typeof block !== 'object' || block === null) return null;
  if ((block as { tunnel?: unknown }).tunnel !== 'ngrok') return null;
  return normalizedHttpsUrl((block as { ngrokUrl?: unknown }).ngrokUrl);
}

function normalizedHttpsUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const url = new URL(raw.trim());
    return url.protocol === 'https:' ? raw.trim().replace(/\/+$/, '') : null;
  } catch {
    return null;
  }
}

export function webSettings(settings: SettingsObject): {
  url: string | null;
  ignoreCertificateErrors: boolean;
  viewport: WebViewport;
} {
  const url = settingValueAt(settings, 'web.url');
  const viewport = settingValueAt(settings, 'web.viewport');
  return {
    url: typeof url === 'string' ? url : null,
    ignoreCertificateErrors: settingValueAt(settings, 'web.ignoreCertificateErrors') === true,
    viewport: WEB_VIEWPORTS.includes(viewport as WebViewport) ? (viewport as WebViewport) : 'desktop',
  };
}

export function removedSettingFindings(
  layers: readonly SettingsLayer[],
  machine: unknown,
  env: NodeJS.ProcessEnv,
): Array<{
  key: string;
  file: string;
  refuses: boolean;
  set: string | null;
  unset: string;
  title: string;
  message: string;
  remedy: string;
}> {
  return [...REMOVED_SETTINGS].flatMap(([key, rule]) => {
    if (!rule.off || !rule.key) return [];
    const target = settingDefinition(rule.key)!;
    const variable = target.env;
    const holder = layers.find((layer) => settingValueAt(layer.settings, rule.key!) !== undefined);
    const configured = holder ? settingValueAt(holder.settings, rule.key) : settingValueAt(machine, rule.key);
    const fromEnv = variable && env[variable]?.trim();
    const applied = fromEnv || configured !== undefined;
    if (rule.kept && applied) return [];
    return layers.flatMap((layer) => {
      if (!rule.scopes?.includes(layer.scope)) return [];
      const value = settingValueAt(layer.settings, key);
      const off = rule.off!(value);
      if (off === null) return [];
      const scope = target.scopes.length > 1 && target.scopes.includes(layer.scope) ? ` --scope ${layer.scope}` : '';
      const shown = `${key} ${JSON.stringify(value)} in ${layer.file}`;
      const fallback = String(target.default);
      const unset = `stim settings unset ${key}${rule.kept ? ` --scope ${layer.scope}` : ''}`;
      const set = applied || rule.kept ? null : `stim settings set ${rule.key} ${off}${scope}`;
      const where = fromEnv ? `from ${variable}` : `in ${holder?.file ?? getConfigPath()}`;
      return [
        {
          key,
          file: layer.file,
          refuses: !rule.kept,
          set,
          unset,
          title: rule.kept ? `${key} ${rule.kept}` : `${key} in the config turned off what Stim now does by default`,
          message: rule.kept
            ? `${shown} ${rule.kept}, so ${rule.key} applies at its default (${fallback}).`
            : applied
              ? `${shown} is no longer read by Stim; ${rule.key} is ${JSON.stringify(fromEnv || configured)} ${where}.`
              : `${shown} is no longer read by Stim, so ${rule.key} would apply at its default (${fallback}); ${rule.key} ${off} keeps what it did.`,
          remedy: rule.kept
            ? `Run \`stim settings set ${rule.key} ${off}${scope}\` to turn ${rule.key} off too, \`stim settings set ${rule.key} ${fallback}${scope}\` to keep ${rule.key} at its default and ${key} at ${JSON.stringify(value)}, or \`${unset}\` to put ${key} back to its default.`
            : set
              ? `Run \`${set}\`, then \`${unset}\`.`
              : `Run \`${unset}\`.`,
        },
      ];
    });
  });
}
