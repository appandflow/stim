import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { configDir, withDirLock } from '@stim-cli/core';
import { isJsonObject, readJsonObject } from '@stim-cli/core/state';
import { CAPABILITIES, PUSH_EVENTS, PUSH_TOKEN_PATTERN, type Capability, type PushEvent } from './protocol.ts';

export const PAIRING_TTL_MS: number = 5 * 60_000;

export type PeerIdentity = { kind: 'local' } | { kind: 'tailnet'; nodeId: string; nodeName: string; user: string };

export interface PairedDevice {
  id: string;
  name: string;
  tokenHash: string;
  identity: PeerIdentity;
  pairedAt: string;
  lastSeenAt: string | null;
  capabilities: Capability[];
  /** Where and what to push, from the device's last `push.register`. */
  push?: PushRegistration;
}

export interface PushRegistration {
  token: string;
  events: PushEvent[];
  agentOnly: boolean;
  ref: string;
  registeredAt: string;
}

interface PairingRecord {
  tokenHash: string;
  expiresAt: string;
  capabilities: Capability[];
}

export type AuthOutcome =
  | { ok: true; device: PairedDevice; deviceToken?: string }
  | { ok: false; reason: 'pairing-unknown' | 'pairing-expired' | 'device-unknown' | 'node-mismatch' };

export function serverDir(): string {
  return join(configDir(), 'server');
}

function devicesFile(): string {
  return join(serverDir(), 'devices.json');
}

function pairingFile(): string {
  return join(serverDir(), 'pairing.json');
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function newToken(): string {
  return randomBytes(32).toString('base64url');
}

function parseIdentity(value: unknown): PeerIdentity | null {
  if (!isJsonObject(value)) return null;
  if (value.kind === 'local') return { kind: 'local' };
  const { nodeId, nodeName, user } = value;
  if (
    value.kind === 'tailnet' &&
    typeof nodeId === 'string' &&
    typeof nodeName === 'string' &&
    typeof user === 'string'
  )
    return { kind: 'tailnet', nodeId, nodeName, user };
  return null;
}

function parseCapabilities(value: unknown): Capability[] {
  return Array.isArray(value) ? CAPABILITIES.filter((capability) => value.includes(capability)) : [];
}

export function capabilitiesFor(control: boolean): Capability[] {
  return control ? ['read', 'control'] : ['read'];
}

const pushToken = new RegExp(PUSH_TOKEN_PATTERN);

function parsePush(value: unknown): PushRegistration | null {
  if (!isJsonObject(value)) return null;
  const { token, events, agentOnly, ref, registeredAt } = value;
  if (typeof token !== 'string' || !pushToken.test(token) || typeof ref !== 'string') return null;
  if (!Array.isArray(events) || typeof registeredAt !== 'string') return null;
  return {
    token,
    events: PUSH_EVENTS.filter((event) => events.includes(event)),
    agentOnly: agentOnly === true,
    ref,
    registeredAt,
  };
}

function parseDevice(value: unknown): PairedDevice | null {
  if (!isJsonObject(value)) return null;
  const { id, name, tokenHash, pairedAt, lastSeenAt } = value;
  const identity = parseIdentity(value.identity);
  if (typeof id !== 'string' || typeof name !== 'string' || typeof tokenHash !== 'string' || !identity) return null;
  if (typeof pairedAt !== 'string') return null;
  const push = parsePush(value.push);
  return {
    id,
    name,
    tokenHash,
    identity,
    pairedAt,
    lastSeenAt: typeof lastSeenAt === 'string' ? lastSeenAt : null,
    capabilities: parseCapabilities(value.capabilities),
    ...(push ? { push } : {}),
  };
}

export function readDevices(): PairedDevice[] {
  const devices = readJsonObject(devicesFile())?.devices;
  return Array.isArray(devices) ? devices.flatMap((entry) => parseDevice(entry) ?? []) : [];
}

function readPairings(): PairingRecord[] {
  const tokens = readJsonObject(pairingFile())?.tokens;
  if (!Array.isArray(tokens)) return [];
  return tokens.flatMap((entry) =>
    isJsonObject(entry) && typeof entry.tokenHash === 'string' && typeof entry.expiresAt === 'string'
      ? [
          {
            tokenHash: entry.tokenHash,
            expiresAt: entry.expiresAt,
            capabilities: 'capabilities' in entry ? parseCapabilities(entry.capabilities) : capabilitiesFor(false),
          },
        ]
      : [],
  );
}

function writeJson(file: string, value: unknown): void {
  const temporary = join(dirname(file), `.${basename(file)}.${process.pid}.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, file);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function transaction<T>(fn: () => T): T {
  return withDirLock(join(serverDir(), 'registry.lock'), fn, {
    ensureParent: () => mkdirSync(serverDir(), { recursive: true, mode: 0o700 }),
  });
}

function unexpired(record: PairingRecord, now: number): boolean {
  return Date.parse(record.expiresAt) > now;
}

/** The device that spends the token gets `capabilities`. */
export function createPairingToken(
  now: number = Date.now(),
  capabilities: Capability[] = capabilitiesFor(false),
): { token: string; expiresAt: string } {
  const token = newToken();
  const expiresAt = new Date(now + PAIRING_TTL_MS).toISOString();
  transaction(() => {
    const pending = readPairings().filter((record) => unexpired(record, now));
    writeJson(pairingFile(), {
      version: 1,
      tokens: [...pending, { tokenHash: hashToken(token), expiresAt, capabilities }],
    });
  });
  return { token, expiresAt };
}

function sameNode(a: PeerIdentity, b: PeerIdentity): boolean {
  if (a.kind === 'local' || b.kind === 'local') return a.kind === b.kind;
  return a.nodeId === b.nodeId;
}

export function spendPairingToken(
  token: string,
  name: string,
  identity: PeerIdentity,
  now: number = Date.now(),
): AuthOutcome {
  return transaction(() => {
    const pairings = readPairings();
    const tokenHash = hashToken(token);
    const match = pairings.find((record) => record.tokenHash === tokenHash);
    const pending = pairings.filter((record) => record !== match && unexpired(record, now));
    if (pending.length !== pairings.length) writeJson(pairingFile(), { version: 1, tokens: pending });
    if (!match) return { ok: false, reason: 'pairing-unknown' };
    if (!unexpired(match, now)) return { ok: false, reason: 'pairing-expired' };
    const deviceToken = newToken();
    const at = new Date(now).toISOString();
    const device: PairedDevice = {
      id: randomBytes(4).toString('hex'),
      name,
      tokenHash: hashToken(deviceToken),
      identity,
      pairedAt: at,
      lastSeenAt: at,
      capabilities: match.capabilities,
    };
    writeJson(devicesFile(), { version: 1, devices: [...readDevices(), device] });
    return { ok: true, device, deviceToken };
  });
}

export function authenticateDevice(token: string, identity: PeerIdentity, now: number = Date.now()): AuthOutcome {
  return transaction(() => {
    const devices = readDevices();
    const tokenHash = hashToken(token);
    const device = devices.find((entry) => entry.tokenHash === tokenHash);
    if (!device) return { ok: false, reason: 'device-unknown' };
    if (!sameNode(device.identity, identity)) return { ok: false, reason: 'node-mismatch' };
    device.lastSeenAt = new Date(now).toISOString();
    writeJson(devicesFile(), { version: 1, devices });
    return { ok: true, device };
  });
}

export function grantDevice(id: string, capabilities: Capability[]): boolean {
  return transaction(() => {
    const devices = readDevices();
    const device = devices.find((entry) => entry.id === id);
    if (!device) return false;
    device.capabilities = capabilities;
    writeJson(devicesFile(), { version: 1, devices });
    return true;
  });
}

/** Sets or, with null, removes a device's push registration. False when the device is no longer paired. */
export function setDevicePush(id: string, push: PushRegistration | null): boolean {
  return transaction(() => {
    const devices = readDevices();
    const device = devices.find((entry) => entry.id === id);
    if (!device) return false;
    if (push) device.push = push;
    else delete device.push;
    writeJson(devicesFile(), { version: 1, devices });
    return true;
  });
}

/** Removes every registration of a push token the push service no longer delivers to. */
export function dropPushToken(token: string): void {
  transaction(() => {
    const devices = readDevices();
    let changed = false;
    for (const device of devices) {
      if (device.push?.token !== token) continue;
      delete device.push;
      changed = true;
    }
    if (changed) writeJson(devicesFile(), { version: 1, devices });
  });
}

export function revokeDevice(id: string): boolean {
  return transaction(() => {
    const devices = readDevices();
    const remaining = devices.filter((device) => device.id !== id);
    if (remaining.length === devices.length) return false;
    writeJson(devicesFile(), { version: 1, devices: remaining });
    return true;
  });
}
