import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { configDir } from '../index.ts';
import { loadConfig } from './config.ts';
import { isJsonObject } from './json-file.ts';
import { coerceSettingText, settingDefinition, settingValueError } from './settings-registry.ts';
import {
  hostedMacosAppSlot,
  parseHostedMacosChoice,
  parseHostedMacosDevice,
  type HostedAgentGrant,
  type HostedMacosChoice,
  type HostedMacosDevice,
} from './hosted-macos.ts';
export type HostedDevicePlatform = 'ios' | 'android' | 'macos';

/** Deadlines stim-server gives each hosted worker run. Clients derive their waits from these. */
export interface DeviceHostLimits {
  prepareMs: number;
  imageInstallMs: number;
  offerMs: number;
  stopMs: number;
  logsMs: number;
  killGraceMs: number;
}

export const DEVICE_HOST_LIMITS: Readonly<DeviceHostLimits> = {
  prepareMs: 5 * 60_000,
  imageInstallMs: 30 * 60_000,
  offerMs: 30_000,
  stopMs: 90_000,
  logsMs: 15_000,
  killGraceMs: 5000,
};

/** How many parked sessions one reserve inspects, and possibly retires, before it creates a device. */
export const HOSTED_PARKED_CANDIDATES: number = 3;

/** How long a cancelled hosted worker run can take to settle: SIGTERM, SIGKILL after the grace, then it is abandoned. */
export function hostedWorkerSettleMs(limits: Pick<DeviceHostLimits, 'killGraceMs'> = DEVICE_HOST_LIMITS): number {
  return limits.killGraceMs * 2;
}

export interface HostedIosChoice {
  deviceTypeId: string;
  runtimeId: string;
  deviceType: string;
  runtime: string;
  architecture: 'arm64' | 'x86_64';
}

export interface HostedIosDevice extends HostedIosChoice {
  udid: string;
  name: string;
}

export interface HostedAndroidChoice {
  systemImage: string;
  deviceProfile: string;
  architecture: 'arm64-v8a' | 'x86_64';
}

export interface HostedAndroidDevice extends HostedAndroidChoice {
  avdName: string;
  serial: string;
  consolePort: number;
}

export type HostedDevice = HostedIosDevice | HostedAndroidDevice | HostedMacosDevice;

export interface HostedDeviceSelectors {
  deviceType?: string;
  runtime?: string;
  systemImage?: string;
  deviceProfile?: string;
}

export interface HostedDeviceOfferRequest extends HostedDeviceSelectors {
  platform: HostedDevicePlatform;
}

export type HostedNativeOffer = {
  resources: {
    cpus: number;
    /** Five-minute system load divided by available CPU count. */
    loadPerCore: number;
    maxLoadPerCore?: number;
    memoryFreeBytes: number;
    memoryPressure: 'normal' | 'warning' | 'critical' | null;
    /** Available bytes on the Stim home volume, not necessarily the Android AVD volume. */
    workerDiskFreeBytes: number | null;
    localDevices?: number | { unknown: string };
    /** Local owned simulators and emulators by platform; `localDevices` is their sum. Read by the server, never sent to clients. */
    localPlatforms?: HostedLocalPlatformCounts | { unknown: string };
  };
  declined: string | null;
} & (
  | { platform: 'ios'; choice: HostedIosChoice | null }
  | {
      platform: 'android';
      choice: HostedAndroidChoice | null;
      /** The system image the host installs before it creates the AVD; absent when the chosen image is installed. */
      installImage?: string;
    }
  | { platform: 'macos'; choice: HostedMacosChoice | null }
);

/** Why a host's memory pressure refuses a hosted session, or null when it is `normal`. A missing sample is its own reason. */
export function hostedMemoryRefusal(pressure: unknown): string | null {
  if (pressure === 'normal') return null;
  return pressure === 'warning' || pressure === 'critical'
    ? `Host memory pressure is ${pressure}; hosted sessions wait until it is normal.`
    : 'Host memory pressure could not be read; retry shortly.';
}

export interface HostedLocalPlatformCounts {
  ios: number;
  android: number;
}

export type HostedDeviceOffer = HostedNativeOffer & {
  capacity: { running: number; max: number; available: number | null; local?: number | { unknown: string } };
};

export interface HostedDeviceRequest extends HostedDeviceOfferRequest {
  workspace: string;
  slot: string;
  attempt: string;
}

export type HostedDevicePhase = 'preparing' | 'ready' | 'stopping' | 'stopped' | 'unknown';

export interface HostedDeviceSession extends HostedDeviceRequest {
  id: string;
  client: string;
  state: HostedDevicePhase;
  device: HostedDevice | null;
  consolePort?: number;
  appSlot?: number;
  createdAt: string;
  parked?: { at: string };
  /** Milliseconds this server ran with no connection from the session's client since it was last connected. */
  clientAbsentMs?: number;
  /** Set when stim-server stopped this session because its client was gone for maintenance.idleStopHours. */
  idleStop?: { at: string; reason: string };
  notice?: string;
  appAttempt?: string;
  agent?: HostedAgentGrant;
  metroPort?: number;
  clientMetroPort?: number;
}

function machineSetting(key: string, env: NodeJS.ProcessEnv): { value: unknown } | { invalid: string } {
  const setting = settingDefinition(key);
  if (!setting?.env) return { invalid: `${key} is not in the settings registry` };
  const raw = env[setting.env];
  const fromEnv = raw !== undefined && raw !== '';
  let value: unknown;
  if (fromEnv) value = coerceSettingText(setting, raw);
  else if (env.STIM_HOME && setting.scopedHomeValue !== undefined) value = setting.scopedHomeValue;
  else if (env.CI && setting.ciValue !== undefined) value = setting.ciValue;
  else {
    const [group = '', name = ''] = key.split('.');
    const container = loadConfig()?.[group];
    if (container !== undefined && !isJsonObject(container))
      return { invalid: `${group} in the config is not an object` };
    const configured = container?.[name];
    value = configured === undefined ? setting.default : configured;
  }
  const error = settingValueError(setting, value);
  return error ? { invalid: `${fromEnv ? setting.env : key} is invalid: expected ${error}` } : { value };
}

/**
 * The window after which stim-server stops a hosted session whose client is gone: the machine-scope
 * `maintenance.idleStopHours` of the home it runs in, 0 unless `maintenance.mode` is on. An invalid value is reported
 * so the caller stops nothing.
 */
export function hostedIdleStopHours(env: NodeJS.ProcessEnv): { hours: number } | { invalid: string } {
  const mode = machineSetting('maintenance.mode', env);
  if ('invalid' in mode) return mode;
  if (mode.value !== 'on') return { hours: 0 };
  const hours = machineSetting('maintenance.idleStopHours', env);
  if ('invalid' in hours) return hours;
  return typeof hours.value === 'number'
    ? { hours: hours.value }
    : { invalid: 'maintenance.idleStopHours is not a number' };
}

export function deviceHostRoot(): string {
  return join(configDir(), 'server', 'device-host-sessions');
}

export function deviceHostArea(id: string): string {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid hosted session id.');
  return join(configDir(), 'device-host', 'sessions', id);
}

export function parseHostedChoice(value: unknown): HostedIosChoice | null {
  if (!isJsonObject(value)) return null;
  const { deviceTypeId, runtimeId, deviceType, runtime, architecture } = value;
  if (
    typeof deviceTypeId !== 'string' ||
    !deviceTypeId ||
    typeof runtimeId !== 'string' ||
    !runtimeId ||
    typeof deviceType !== 'string' ||
    !deviceType ||
    typeof runtime !== 'string' ||
    !runtime ||
    (architecture !== 'arm64' && architecture !== 'x86_64')
  )
    return null;
  return { deviceTypeId, runtimeId, deviceType, runtime, architecture };
}

export function parseHostedDevice(value: unknown): HostedIosDevice | null {
  if (!isJsonObject(value) || value.avdName !== undefined) return null;
  const choice = parseHostedChoice(value);
  const { udid, name } = value;
  if (!choice || typeof udid !== 'string' || !/^[a-fA-F0-9-]{36}$/.test(udid) || typeof name !== 'string') return null;
  return { ...choice, udid, name };
}

export function parseHostedAndroidDevice(value: unknown): HostedAndroidDevice | null {
  if (!isJsonObject(value)) return null;
  const { avdName, consolePort, systemImage, deviceProfile, architecture } = value;
  if (
    value.udid !== undefined ||
    typeof avdName !== 'string' ||
    !/^stim-[A-Za-z0-9._-]+$/.test(avdName) ||
    !hostedConsolePort(consolePort) ||
    value.serial !== `emulator-${consolePort}` ||
    typeof systemImage !== 'string' ||
    !/^system-images;android-\d+;[^;\s]+;(arm64-v8a|x86_64)$/.test(systemImage) ||
    typeof deviceProfile !== 'string' ||
    !deviceProfile ||
    (architecture !== 'arm64-v8a' && architecture !== 'x86_64') ||
    !systemImage.endsWith(`;${architecture}`)
  )
    return null;
  return { avdName, serial: `emulator-${consolePort}`, consolePort, systemImage, deviceProfile, architecture };
}

/** Android Emulator -help-port defines the supported even console ports as 5554 through 5584. */
export function hostedConsolePort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 5554 && value <= 5584 && value % 2 === 0;
}

export function parseHostedPlatformDevice(value: unknown, platform: HostedDevicePlatform): HostedDevice | null {
  return platform === 'ios'
    ? parseHostedDevice(value)
    : platform === 'android'
      ? parseHostedAndroidDevice(value)
      : parseHostedMacosDevice(value);
}

export function hostedDeviceId(device: HostedDevice): string {
  return 'udid' in device ? device.udid : 'avdName' in device ? device.avdName : `macos-${device.appSlot}`;
}

export function parseHostedRequest(value: unknown): HostedDeviceRequest | null {
  if (!isJsonObject(value) || (value.platform !== 'ios' && value.platform !== 'android' && value.platform !== 'macos'))
    return null;
  if (
    typeof value.workspace !== 'string' ||
    !value.workspace ||
    value.workspace.length > 4096 ||
    /[\0\r\n]/.test(value.workspace)
  )
    return null;
  if (
    typeof value.slot !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value.slot) ||
    ['constructor', 'prototype', '__proto__', 'web'].includes(value.slot)
  )
    return null;
  if (typeof value.attempt !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value.attempt)) return null;
  const selectors = parseHostedOfferRequest(value);
  return selectors ? { workspace: value.workspace, slot: value.slot, attempt: value.attempt, ...selectors } : null;
}

export function parseHostedOfferRequest(value: unknown): HostedDeviceOfferRequest | null {
  if (!isJsonObject(value) || (value.platform !== 'ios' && value.platform !== 'android' && value.platform !== 'macos'))
    return null;
  if (
    ['deviceType', 'runtime', 'systemImage', 'deviceProfile'].some(
      (key) =>
        value[key] !== undefined &&
        (typeof value[key] !== 'string' || !value[key] || value[key].length > 256 || /[\0\r\n]/.test(value[key])),
    )
  )
    return null;
  if (
    (value.platform === 'ios'
      ? ['systemImage', 'deviceProfile']
      : value.platform === 'android'
        ? ['deviceType', 'runtime']
        : ['deviceType', 'runtime', 'systemImage', 'deviceProfile']
    ).some((key) => value[key] !== undefined)
  )
    return null;
  return {
    platform: value.platform as HostedDevicePlatform,
    ...(typeof value.deviceType === 'string' ? { deviceType: value.deviceType } : {}),
    ...(typeof value.runtime === 'string' ? { runtime: value.runtime } : {}),
    ...(typeof value.systemImage === 'string' ? { systemImage: value.systemImage } : {}),
    ...(typeof value.deviceProfile === 'string' ? { deviceProfile: value.deviceProfile } : {}),
  };
}

export function parseHostedLocalDeviceCount(value: unknown): number | { unknown: string } | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  if (isJsonObject(value) && typeof value.unknown === 'string' && value.unknown)
    return { unknown: value.unknown.slice(0, 4000) };
  return null;
}

const isCount = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;

export function parseHostedLocalPlatformCounts(value: unknown): HostedLocalPlatformCounts | { unknown: string } | null {
  if (isJsonObject(value) && isCount(value.ios) && isCount(value.android))
    return { ios: value.ios, android: value.android };
  if (isJsonObject(value) && typeof value.unknown === 'string' && value.unknown)
    return { unknown: value.unknown.slice(0, 4000) };
  return null;
}

export function parseHostedNativeOffer(value: unknown): HostedNativeOffer | null {
  if (!isJsonObject(value) || !isJsonObject(value.resources)) return null;
  const { resources } = value;
  const local = parseHostedLocalDeviceCount(resources.localDevices);
  if (resources.localDevices !== undefined && local === null) return null;
  const localPlatforms = parseHostedLocalPlatformCounts(resources.localPlatforms);
  if (resources.localPlatforms !== undefined && localPlatforms === null) return null;
  if (
    (value.platform !== 'ios' && value.platform !== 'android' && value.platform !== 'macos') ||
    (value.declined !== null &&
      (typeof value.declined !== 'string' || !value.declined || value.declined.length > 4000)) ||
    !Number.isInteger(resources.cpus) ||
    Number(resources.cpus) < 1 ||
    ['loadPerCore', 'memoryFreeBytes'].some(
      (key) => typeof resources[key] !== 'number' || !Number.isFinite(resources[key]) || resources[key] < 0,
    ) ||
    (resources.workerDiskFreeBytes !== null &&
      (typeof resources.workerDiskFreeBytes !== 'number' ||
        !Number.isFinite(resources.workerDiskFreeBytes) ||
        resources.workerDiskFreeBytes < 0)) ||
    (resources.memoryPressure !== null &&
      resources.memoryPressure !== 'normal' &&
      resources.memoryPressure !== 'warning' &&
      resources.memoryPressure !== 'critical')
  )
    return null;
  let choice: HostedIosChoice | HostedAndroidChoice | HostedMacosChoice | null = null;
  if (value.choice !== null) {
    if (value.platform === 'ios') {
      const parsed = parseHostedChoice(value.choice);
      if (!parsed) return null;
      choice = {
        deviceType: parsed.deviceType,
        runtime: parsed.runtime,
        deviceTypeId: parsed.deviceTypeId,
        runtimeId: parsed.runtimeId,
        architecture: parsed.architecture,
      };
    } else if (value.platform === 'macos') {
      choice = parseHostedMacosChoice(value.choice);
      if (!choice) return null;
    } else {
      const selected = value.choice;
      if (
        !isJsonObject(selected) ||
        typeof selected.systemImage !== 'string' ||
        !/^system-images;android-\d+;[^;\s]+;(arm64-v8a|x86_64)$/.test(selected.systemImage) ||
        typeof selected.deviceProfile !== 'string' ||
        !selected.deviceProfile ||
        (selected.architecture !== 'arm64-v8a' && selected.architecture !== 'x86_64') ||
        !selected.systemImage.endsWith(`;${selected.architecture}`)
      )
        return null;
      choice = {
        systemImage: selected.systemImage,
        deviceProfile: selected.deviceProfile,
        architecture: selected.architecture,
      };
    }
  } else if (!value.declined) return null;
  return {
    platform: value.platform,
    choice,
    ...(choice && 'systemImage' in choice && value.installImage === choice.systemImage
      ? { installImage: choice.systemImage }
      : {}),
    declined: value.declined,
    resources: {
      cpus: resources.cpus,
      loadPerCore: resources.loadPerCore,
      ...(typeof resources.maxLoadPerCore === 'number' &&
      Number.isFinite(resources.maxLoadPerCore) &&
      resources.maxLoadPerCore > 0
        ? { maxLoadPerCore: resources.maxLoadPerCore }
        : {}),
      memoryFreeBytes: resources.memoryFreeBytes,
      memoryPressure: resources.memoryPressure,
      workerDiskFreeBytes: resources.workerDiskFreeBytes,
      ...(local !== null ? { localDevices: local } : {}),
      ...(localPlatforms !== null ? { localPlatforms } : {}),
    },
  } as HostedNativeOffer;
}

/** A missing established journal or malformed record is a refusal, never an empty reservation set. */
export function readHostedSessions(): HostedDeviceSession[] {
  const root = deviceHostRoot();
  try {
    readdirSync(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      try {
        if (readdirSync(join(configDir(), 'device-host', 'sessions')).length)
          throw new Error(`Hosted session journal is missing while worker areas remain: ${root}`, { cause: error });
      } catch (areaError) {
        if ((areaError as NodeJS.ErrnoException).code !== 'ENOENT') throw areaError;
      }
      return [];
    }
    throw error;
  }
  const value: unknown = JSON.parse(readFileSync(join(root, 'sessions.json'), 'utf8'));
  if (!isJsonObject(value) || value.version !== 1 || !Array.isArray(value.sessions))
    throw new Error(`Malformed hosted session journal: ${root}`);
  const ids = new Set<string>();
  return value.sessions.map((entry): HostedDeviceSession => {
    if (
      !isJsonObject(entry) ||
      !parseHostedRequest(entry) ||
      typeof entry.id !== 'string' ||
      !/^[a-f0-9-]{36}$/.test(entry.id) ||
      ids.has(entry.id) ||
      typeof entry.client !== 'string' ||
      !entry.client ||
      typeof entry.createdAt !== 'string' ||
      !['preparing', 'ready', 'stopping', 'stopped', 'unknown'].includes(String(entry.state)) ||
      (entry.platform === 'android' && !hostedConsolePort(entry.consolePort)) ||
      (entry.platform === 'macos' ? !hostedMacosAppSlot(entry.appSlot) : entry.appSlot !== undefined) ||
      (entry.device !== null && !parseHostedPlatformDevice(entry.device, entry.platform as HostedDevicePlatform)) ||
      (entry.platform === 'macos' &&
        entry.device !== null &&
        (entry.device as HostedMacosDevice).appSlot !== entry.appSlot) ||
      (entry.platform === 'android' &&
        entry.device !== null &&
        (entry.device as HostedAndroidDevice).consolePort !== entry.consolePort) ||
      (entry.state === 'ready' && entry.device === null) ||
      (entry.parked !== undefined &&
        (!isJsonObject(entry.parked) ||
          typeof entry.parked.at !== 'string' ||
          !Number.isFinite(Date.parse(entry.parked.at)) ||
          new Date(entry.parked.at).toISOString() !== entry.parked.at ||
          entry.state !== 'stopped' ||
          entry.platform === 'macos')) ||
      (entry.clientAbsentMs !== undefined &&
        (typeof entry.clientAbsentMs !== 'number' ||
          !Number.isFinite(entry.clientAbsentMs) ||
          entry.clientAbsentMs < 0)) ||
      (entry.idleStop !== undefined &&
        (!isJsonObject(entry.idleStop) ||
          typeof entry.idleStop.at !== 'string' ||
          !Number.isFinite(Date.parse(entry.idleStop.at)) ||
          typeof entry.idleStop.reason !== 'string')) ||
      (entry.notice !== undefined && typeof entry.notice !== 'string') ||
      (entry.appAttempt !== undefined &&
        (typeof entry.appAttempt !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(entry.appAttempt))) ||
      (entry.clientMetroPort !== undefined &&
        (typeof entry.clientMetroPort !== 'number' ||
          !Number.isInteger(entry.clientMetroPort) ||
          entry.clientMetroPort < 1 ||
          entry.clientMetroPort > 65535 ||
          entry.platform !== 'android')) ||
      (entry.metroPort !== undefined &&
        (typeof entry.metroPort !== 'number' ||
          !Number.isInteger(entry.metroPort) ||
          entry.metroPort < 1 ||
          entry.metroPort > 65535))
    )
      throw new Error(`Malformed hosted session record: ${root}`);
    ids.add(entry.id);
    return entry as unknown as HostedDeviceSession;
  });
}

/** The private worker's exact device record; an absent record is unresolved after creation started. */
export function readHostedDevice(home: string): HostedIosDevice;
export function readHostedDevice(home: string, platform: 'android'): HostedAndroidDevice;
export function readHostedDevice(home: string, platform: 'macos'): HostedMacosDevice;
export function readHostedDevice(home: string, platform: HostedDevicePlatform): HostedDevice;
export function readHostedDevice(home: string, platform: HostedDevicePlatform = 'ios'): HostedDevice {
  const value: unknown = JSON.parse(readFileSync(join(home, 'hosted-device.json'), 'utf8'));
  const device = parseHostedPlatformDevice(value, platform);
  if (!device) throw new Error('The hosted device record is malformed.');
  return device;
}

export function readHostedDeviceLedger(
  home: string,
  options: { required?: boolean } = {},
): { ios: string[]; android: string[]; web: string[] } | null {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(join(home, 'created-devices.json'), 'utf8'));
  } catch (error) {
    if (!options.required && (error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (
    !isJsonObject(value) ||
    value.version !== 1 ||
    !['ios', 'android', 'web'].every(
      (key) => Array.isArray(value[key]) && value[key].every((id: unknown) => typeof id === 'string'),
    )
  )
    throw new Error('The hosted device ownership ledger is malformed.');
  return value as { ios: string[]; android: string[]; web: string[] };
}

/** Hosted sessions use isolated homes: only one exact device of their platform may appear in this ledger. */
export function assertHostedDeviceLedger(
  home: string,
  id: string,
  platform: HostedDevicePlatform = 'ios',
  options: { allowEmpty?: boolean } = {},
): 'listed' | 'empty' {
  const value = readHostedDeviceLedger(home, { required: platform !== 'macos' });
  if (!value && platform === 'macos') return 'empty';
  if (value && !value.ios.length && !value.android.length && !value.web.length) {
    if (platform === 'macos' || options.allowEmpty) return 'empty';
  }
  if (
    !value ||
    value.ios.length !== (platform === 'ios' ? 1 : 0) ||
    (platform === 'ios' && value.ios[0] !== id) ||
    value.android.length !== (platform === 'android' ? 1 : 0) ||
    (platform === 'android' && value.android[0] !== id) ||
    value.web.length !== 0
  )
    throw new Error('The hosted device ownership ledger is missing, malformed or names another device.');
  return 'listed';
}
