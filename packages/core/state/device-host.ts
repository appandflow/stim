import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { configDir } from '../index.ts';
import { isJsonObject } from './json-file.ts';

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

export interface HostedDeviceSelectors {
  deviceType?: string;
  runtime?: string;
}

export interface HostedDeviceRequest extends HostedDeviceSelectors {
  workspace: string;
  slot: string;
  platform: 'ios';
  attempt: string;
}

export type HostedDevicePhase = 'preparing' | 'ready' | 'stopping' | 'stopped' | 'unknown';

export interface HostedDeviceSession extends HostedDeviceRequest {
  id: string;
  client: string;
  state: HostedDevicePhase;
  device: HostedIosDevice | null;
  createdAt: string;
  notice?: string;
  appAttempt?: string;
  metroPort?: number;
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
  if (!isJsonObject(value) || !parseHostedChoice(value)) return null;
  if (typeof value.udid !== 'string' || !/^[a-fA-F0-9-]{36}$/.test(value.udid) || typeof value.name !== 'string')
    return null;
  return value as unknown as HostedIosDevice;
}

export function parseHostedRequest(value: unknown): HostedDeviceRequest | null {
  if (!isJsonObject(value) || value.platform !== 'ios') return null;
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
    ['deviceType', 'runtime'].some(
      (key) =>
        value[key] !== undefined &&
        (typeof value[key] !== 'string' || !value[key] || value[key].length > 256 || /[\0\r\n]/.test(value[key])),
    )
  )
    return null;
  return {
    workspace: value.workspace,
    slot: value.slot,
    platform: 'ios',
    attempt: value.attempt,
    ...(typeof value.deviceType === 'string' ? { deviceType: value.deviceType } : {}),
    ...(typeof value.runtime === 'string' ? { runtime: value.runtime } : {}),
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
      (entry.device !== null && !parseHostedDevice(entry.device)) ||
      (entry.state === 'ready' && entry.device === null) ||
      (entry.notice !== undefined && typeof entry.notice !== 'string') ||
      (entry.appAttempt !== undefined &&
        (typeof entry.appAttempt !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(entry.appAttempt))) ||
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
export function readHostedDevice(home: string): HostedIosDevice {
  const value: unknown = JSON.parse(readFileSync(join(home, 'hosted-device.json'), 'utf8'));
  const device = parseHostedDevice(value);
  if (!device) throw new Error('The hosted device record is malformed.');
  return device;
}

/** Hosted sessions use isolated homes: only one exact iOS device may appear in this ledger. */
export function assertHostedDeviceLedger(home: string, udid: string): void {
  const value: unknown = JSON.parse(readFileSync(join(home, 'created-devices.json'), 'utf8'));
  if (
    !isJsonObject(value) ||
    value.version !== 1 ||
    !Array.isArray(value.ios) ||
    value.ios.length !== 1 ||
    value.ios[0] !== udid ||
    !Array.isArray(value.android) ||
    value.android.length !== 0 ||
    !Array.isArray(value.web) ||
    value.web.length !== 0
  )
    throw new Error('The hosted device ownership ledger is missing, malformed or names another device.');
}
