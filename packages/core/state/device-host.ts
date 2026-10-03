import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { configDir } from '../index.ts';
import { isJsonObject } from './json-file.ts';
export type HostedDevicePlatform = 'ios' | 'android';

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

export interface HostedAndroidDevice {
  avdName: string;
  serial: string;
  consolePort: number;
  systemImage: string;
  deviceProfile: string;
  architecture: 'arm64-v8a' | 'x86_64';
}

export type HostedDevice = HostedIosDevice | HostedAndroidDevice;

export interface HostedDeviceSelectors {
  deviceType?: string;
  runtime?: string;
  systemImage?: string;
  deviceProfile?: string;
}

export interface HostedDeviceRequest extends HostedDeviceSelectors {
  workspace: string;
  slot: string;
  platform: HostedDevicePlatform;
  attempt: string;
}

export type HostedDevicePhase = 'preparing' | 'ready' | 'stopping' | 'stopped' | 'unknown';

export interface HostedDeviceSession extends HostedDeviceRequest {
  id: string;
  client: string;
  state: HostedDevicePhase;
  device: HostedDevice | null;
  consolePort?: number;
  createdAt: string;
  notice?: string;
  appAttempt?: string;
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
  if (
    !['deviceTypeId', 'runtimeId', 'deviceType', 'runtime'].every((key) => typeof value[key] === 'string' && value[key])
  )
    return null;
  if (value.architecture !== 'arm64' && value.architecture !== 'x86_64') return null;
  return value as unknown as HostedIosChoice;
}

export function parseHostedDevice(value: unknown): HostedIosDevice | null {
  if (!isJsonObject(value) || value.avdName !== undefined || !parseHostedChoice(value)) return null;
  if (typeof value.udid !== 'string' || !/^[a-fA-F0-9-]{36}$/.test(value.udid) || typeof value.name !== 'string')
    return null;
  return value as unknown as HostedIosDevice;
}

export function parseHostedAndroidDevice(value: unknown): HostedAndroidDevice | null {
  if (!isJsonObject(value)) return null;
  if (
    value.udid !== undefined ||
    typeof value.avdName !== 'string' ||
    !/^stim-[A-Za-z0-9._-]+$/.test(value.avdName) ||
    !hostedConsolePort(value.consolePort) ||
    value.serial !== `emulator-${value.consolePort}` ||
    typeof value.systemImage !== 'string' ||
    !/^system-images;android-\d+;[^;\s]+;(arm64-v8a|x86_64)$/.test(value.systemImage) ||
    typeof value.deviceProfile !== 'string' ||
    !value.deviceProfile ||
    (value.architecture !== 'arm64-v8a' && value.architecture !== 'x86_64') ||
    !value.systemImage.endsWith(`;${value.architecture}`)
  )
    return null;
  return value as unknown as HostedAndroidDevice;
}

/** Android Emulator -help-port defines the supported even console ports as 5554 through 5584. */
export function hostedConsolePort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 5554 && value <= 5584 && value % 2 === 0;
}

export function parseHostedPlatformDevice(value: unknown, platform: HostedDevicePlatform): HostedDevice | null {
  return platform === 'ios' ? parseHostedDevice(value) : parseHostedAndroidDevice(value);
}

export function hostedDeviceId(device: HostedDevice): string {
  return 'udid' in device ? device.udid : device.avdName;
}

export function parseHostedRequest(value: unknown): HostedDeviceRequest | null {
  if (!isJsonObject(value) || !['ios', 'android'].includes(String(value.platform))) return null;
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
  if (
    ['deviceType', 'runtime', 'systemImage', 'deviceProfile'].some(
      (key) =>
        value[key] !== undefined &&
        (typeof value[key] !== 'string' || !value[key] || value[key].length > 256 || /[\0\r\n]/.test(value[key])),
    )
  )
    return null;
  if (
    (value.platform === 'ios' ? ['systemImage', 'deviceProfile'] : ['deviceType', 'runtime']).some(
      (key) => value[key] !== undefined,
    )
  )
    return null;
  return {
    workspace: value.workspace,
    slot: value.slot,
    platform: value.platform as HostedDevicePlatform,
    attempt: value.attempt,
    ...(typeof value.deviceType === 'string' ? { deviceType: value.deviceType } : {}),
    ...(typeof value.runtime === 'string' ? { runtime: value.runtime } : {}),
    ...(typeof value.systemImage === 'string' ? { systemImage: value.systemImage } : {}),
    ...(typeof value.deviceProfile === 'string' ? { deviceProfile: value.deviceProfile } : {}),
  };
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
      (entry.device !== null && !parseHostedPlatformDevice(entry.device, entry.platform as HostedDevicePlatform)) ||
      (entry.platform === 'android' &&
        entry.device !== null &&
        (entry.device as HostedAndroidDevice).consolePort !== entry.consolePort) ||
      (entry.state === 'ready' && entry.device === null) ||
      (entry.notice !== undefined && typeof entry.notice !== 'string') ||
      (entry.appAttempt !== undefined &&
        (typeof entry.appAttempt !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(entry.appAttempt)))
    )
      throw new Error(`Malformed hosted session record: ${root}`);
    ids.add(entry.id);
    return entry as unknown as HostedDeviceSession;
  });
}

/** The private worker's exact device record; an absent record is unresolved after creation started. */
export function readHostedDevice(home: string): HostedIosDevice;
export function readHostedDevice(home: string, platform: 'android'): HostedAndroidDevice;
export function readHostedDevice(home: string, platform: HostedDevicePlatform): HostedDevice;
export function readHostedDevice(home: string, platform: HostedDevicePlatform = 'ios'): HostedDevice {
  const value: unknown = JSON.parse(readFileSync(join(home, 'hosted-device.json'), 'utf8'));
  const device = parseHostedPlatformDevice(value, platform);
  if (!device) throw new Error('The hosted device record is malformed.');
  return device;
}

/** Hosted sessions use isolated homes: only one exact device of their platform may appear in this ledger. */
export function assertHostedDeviceLedger(home: string, id: string, platform: HostedDevicePlatform = 'ios'): void {
  const value: unknown = JSON.parse(readFileSync(join(home, 'created-devices.json'), 'utf8'));
  if (
    !isJsonObject(value) ||
    value.version !== 1 ||
    !Array.isArray(value.ios) ||
    value.ios.length !== (platform === 'ios' ? 1 : 0) ||
    (platform === 'ios' && value.ios[0] !== id) ||
    !Array.isArray(value.android) ||
    value.android.length !== (platform === 'android' ? 1 : 0) ||
    (platform === 'android' && value.android[0] !== id) ||
    !Array.isArray(value.web) ||
    value.web.length !== 0
  )
    throw new Error('The hosted device ownership ledger is missing, malformed or names another device.');
}
