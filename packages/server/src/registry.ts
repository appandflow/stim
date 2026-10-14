import { randomBytes } from 'node:crypto';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { configDir, withDirLock } from '@stim-cli/core';
import { isJsonObject, readJsonObject } from '@stim-cli/core/state';
import type { NoiseKeyPair } from '@stim-cli/core/noise';
import {
  decodeSecret,
  newSecret,
  readOrCreateKeyFile,
  secretValues,
  type SecretValues,
} from '@stim-cli/core/noise-session';
import {
  CAPABILITIES,
  NOTIFICATION_LEVELS,
  PUSH_EVENTS,
  PUSH_TOKEN_PATTERN,
  type Capability,
  type NotificationLevel,
  type PushEvent,
  type QuietHours,
} from './protocol.ts';
import { DEFAULT_STUCK_MINUTES } from '@stim-cli/core/oversight';

export const PAIRING_TTL_MS: number = 5 * 60_000;

type ClientCapability = 'build' | 'device-host';

/**
 * A client this server accepts: its long-term public key, which the Noise handshake authenticates, and the
 * capabilities a person gave it here. `from` labels the connection it paired over, for display only.
 */
export interface PairedDevice {
  id: string;
  name: string;
  /** The client's X25519 public key, base64url. */
  publicKey: string;
  from?: string;
  pairedAt: string;
  lastSeenAt: string | null;
  capabilities: Capability[];
  /** Where and what to push, from the device's last `push.register`. */
  push?: PushRegistration;
  /** The setup journal of the `stim-server setup` run that approved this client. */
  setupJournal?: string;
}

export interface PushRegistration {
  token: string;
  events: PushEvent[];
  /** Absent for a phone that registered before levels, which gets each event's default delivery. */
  levels?: Partial<Record<PushEvent, NotificationLevel>>;
  ref: string;
  registeredAt: string;
  stuckMinutes: number;
  quietHours: QuietHours | null;
}

/** The events a registration asks for, with the legacy `disk` read as `machine` and other legacy names dropped. */
export function pushEvents(events: readonly unknown[]): PushEvent[] {
  return PUSH_EVENTS.filter((event) => events.includes(event) || (event === 'machine' && events.includes('disk')));
}

/** Levels as `push.register` takes them, or null when `value` is not valid. */
export function parseLevels(value: unknown): Partial<Record<PushEvent, NotificationLevel>> | null {
  if (!isJsonObject(value)) return null;
  const entries = Object.entries(value);
  const valid = entries.every(
    ([event, level]) =>
      (PUSH_EVENTS as readonly string[]).includes(event) && (NOTIFICATION_LEVELS as readonly unknown[]).includes(level),
  );
  return valid ? (Object.fromEntries(entries) as Partial<Record<PushEvent, NotificationLevel>>) : null;
}

function validTimeZone(timeZone: string): boolean {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone }).resolvedOptions().timeZone.length > 0;
  } catch {
    return false;
  }
}

const minuteOfDay = (value: unknown) =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < 1440;

/** Quiet hours as `push.register` takes them, or null when `value` is not valid. */
export function parseQuietHours(value: unknown): QuietHours | null {
  if (!isJsonObject(value)) return null;
  const { start, end, timeZone } = value;
  if (!minuteOfDay(start) || !minuteOfDay(end) || typeof timeZone !== 'string' || !validTimeZone(timeZone)) return null;
  return { start: start as number, end: end as number, timeZone };
}

/** Whether `value` is a stuck threshold `push.register` takes: whole minutes from 1 to 240. */
export function validStuckMinutes(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 240;
}

export type GrantOutcome = 'granted' | 'unknown' | 'build-mismatch' | 'device-host-mismatch';

export function serverDir(): string {
  return join(configDir(), 'server');
}

/** The server's long-term X25519 key, created on first use. Replacing it makes every client refuse this server. */
export function serverIdentity(): NoiseKeyPair {
  return readOrCreateKeyFile(join(serverDir(), 'identity.key'));
}

const REGISTRY_VERSION = 2;

function devicesFile(): string {
  return join(serverDir(), 'devices.json');
}

function clientsFile(capability: ClientCapability): string {
  return join(serverDir(), `${capability}-clients.json`);
}

function secretsFile(): string {
  return join(serverDir(), 'secrets.json');
}

function newId(): string {
  return randomBytes(4).toString('hex');
}

function parseCapabilities(value: unknown): Capability[] {
  return Array.isArray(value) ? CAPABILITIES.filter((capability) => value.includes(capability)) : [];
}

export function capabilitiesFor(control: boolean): Exclude<Capability, ClientCapability>[] {
  return control ? ['read', 'control'] : ['read'];
}

const MAX_CLIENT_NAME = 64;

/**
 * A client sends its own name, which the person cannot edit in the phone app, so pairing cleans it up instead of
 * refusing it. U+200D stays because emoji sequences join with it.
 */
function pairingName(name: string, fallback: string): string {
  const clean = name
    .replace(/(?![\u200d\s])[\p{Cc}\p{Cf}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_CLIENT_NAME)
    .replace(/[\ud800-\udbff]$/, '')
    .trim();
  return clean || fallback;
}

function newDeviceId(): string {
  const taken = new Set(
    [...readDevices(), ...readRecords(clientsFile('build')), ...readRecords(clientsFile('device-host'))].map(
      (device) => device.id,
    ),
  );
  let id = newId();
  while (taken.has(id)) id = newId();
  return id;
}

const pushToken = new RegExp(PUSH_TOKEN_PATTERN);

function parsePush(value: unknown): PushRegistration | null {
  if (!isJsonObject(value)) return null;
  const { token, events, ref, registeredAt, stuckMinutes } = value;
  if (typeof token !== 'string' || !pushToken.test(token) || typeof ref !== 'string') return null;
  if (!Array.isArray(events) || typeof registeredAt !== 'string') return null;
  const levels = value.levels === undefined ? null : parseLevels(value.levels);
  return {
    token,
    events: pushEvents(events),
    ...(levels ? { levels } : {}),
    ref,
    registeredAt,
    stuckMinutes: validStuckMinutes(stuckMinutes) ? stuckMinutes : DEFAULT_STUCK_MINUTES,
    quietHours: parseQuietHours(value.quietHours),
  };
}

const KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const JOURNAL_PATTERN = /^[a-f0-9]{64}$/;

function parseDevice(value: unknown): PairedDevice | null {
  if (!isJsonObject(value)) return null;
  const { id, name, publicKey, pairedAt, lastSeenAt, from, setupJournal } = value;
  if (typeof id !== 'string' || typeof name !== 'string' || typeof pairedAt !== 'string') return null;
  if (typeof publicKey !== 'string' || !KEY_PATTERN.test(publicKey)) return null;
  const push = parsePush(value.push);
  return {
    id,
    name,
    publicKey,
    ...(typeof from === 'string' ? { from } : {}),
    pairedAt,
    lastSeenAt: typeof lastSeenAt === 'string' ? lastSeenAt : null,
    capabilities: parseCapabilities(value.capabilities),
    ...(push ? { push } : {}),
    ...(typeof setupJournal === 'string' && JOURNAL_PATTERN.test(setupJournal) ? { setupJournal } : {}),
  };
}

/** Records of protocol 1, which stored device tokens and tailnet nodes, are not read. */
function readRecords(file: string): PairedDevice[] {
  const registry = readJsonObject(file);
  const devices = registry?.version === REGISTRY_VERSION ? registry.devices : null;
  return Array.isArray(devices) ? devices.flatMap((entry) => parseDevice(entry) ?? []) : [];
}

function writeRecords(file: string, devices: PairedDevice[]): void {
  writeJson(file, { version: REGISTRY_VERSION, devices });
}

export function readDevices(): PairedDevice[] {
  return readRecords(devicesFile());
}

/** The machines that may build here. They live apart from `devices.json`, so a server never reads them as devices. */
export function readBuildClients(): PairedDevice[] {
  return readRecords(clientsFile('build'));
}

/** Whether the build client registry parses, so an empty `readBuildClients` means no client rather than a read failure. */
export function buildClientsReadable(): boolean {
  const registry = readJsonObject(clientsFile('build'));
  return registry?.version === REGISTRY_VERSION && Array.isArray(registry.devices);
}

/** Device-host approvals live apart from read/control pairings and build clients. */
export function readDeviceHostClients(): PairedDevice[] {
  return readRecords(clientsFile('device-host'));
}

/**
 * A pairing token or setup ticket the server accepts as a Noise PSK. Only `psk` and `lookup` are kept, never the
 * secret, and the entry is deleted once spent or expired.
 */
interface SecretRecord {
  lookup: string;
  psk: string;
  kind: 'pairing' | 'setup';
  capabilities: Capability[];
  expiresAt: string;
  /** For a setup ticket: the journal of the setup run that stored it. */
  journal?: string;
  /**
   * The key that spent it. A spent secret stays until it expires so that client can repeat first contact after a lost
   * reply; it never admits another key.
   */
  spentBy?: string;
}

function readSecrets(): SecretRecord[] {
  const secrets = readJsonObject(secretsFile())?.secrets;
  if (!Array.isArray(secrets)) return [];
  return secrets.flatMap((entry) => {
    if (!isJsonObject(entry)) return [];
    const { lookup, psk, kind, expiresAt, journal, spentBy } = entry;
    if (typeof lookup !== 'string' || !/^[a-f0-9]{32}$/.test(lookup)) return [];
    if (typeof psk !== 'string' || !/^[a-f0-9]{64}$/.test(psk)) return [];
    if ((kind !== 'pairing' && kind !== 'setup') || typeof expiresAt !== 'string') return [];
    return [
      {
        lookup,
        psk,
        kind,
        capabilities: parseCapabilities(entry.capabilities),
        expiresAt,
        ...(typeof journal === 'string' && JOURNAL_PATTERN.test(journal) ? { journal } : {}),
        ...(typeof spentBy === 'string' && KEY_PATTERN.test(spentBy) ? { spentBy } : {}),
      },
    ];
  });
}

function writeSecrets(secrets: SecretRecord[]): void {
  writeJson(secretsFile(), { version: 1, secrets });
}

export function writeJson(file: string, value: unknown): void {
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

const unexpired = (secret: SecretRecord, now: number) => Date.parse(secret.expiresAt) > now;

/** The device that spends the token gets `capabilities`. The token is shown once and never stored. */
export function createPairingToken(
  now: number = Date.now(),
  capabilities: Exclude<Capability, ClientCapability>[] = capabilitiesFor(false),
): { token: string; expiresAt: string } {
  const token = newSecret();
  const expiresAt = new Date(now + PAIRING_TTL_MS).toISOString();
  storeSecret(decodeSecret(token)!, 'pairing', capabilities, expiresAt, now);
  return { token, expiresAt };
}

function storeSecret(
  secret: Buffer,
  kind: SecretRecord['kind'],
  capabilities: Capability[],
  expiresAt: string,
  now: number,
): SecretValues {
  const values = secretValues(secret);
  transaction(() => {
    const kept = readSecrets().filter((each) => unexpired(each, now) && each.lookup !== values.lookup.toString('hex'));
    writeSecrets([
      ...kept,
      {
        lookup: values.lookup.toString('hex'),
        psk: values.psk.toString('hex'),
        kind,
        capabilities,
        expiresAt,
        ...(kind === 'setup' ? { journal: values.journal } : {}),
      },
    ]);
  });
  return values;
}

/**
 * Lets the holder of a setup ticket record its key with `capabilities` until `expiresAt`. `stim-server setup` stores
 * it once the person approved; the ticket itself is never written.
 */
export function storeSetupSecret(
  ticket: Buffer,
  capabilities: ClientCapability[],
  expiresAt: string,
  now: number = Date.now(),
): void {
  storeSecret(ticket, 'setup', capabilities, expiresAt, now);
}

/**
 * Deletes a setup run's secret when the run ends. A spent one stays until its ticket expires, so the client that spent
 * it can repeat first contact if it lost the reply.
 */
export function dropSetupSecret(journal: string): void {
  transaction(() => {
    const secrets = readSecrets();
    const kept = secrets.filter((secret) => secret.journal !== journal || secret.spentBy !== undefined);
    if (kept.length !== secrets.length) writeSecrets(kept);
  });
}

/** The PSK of the unexpired secret named by `lookup` (hex), or null. */
export function secretPsk(lookup: string, now: number = Date.now()): Buffer | null {
  const found = readSecrets().find((secret) => secret.lookup === lookup && unexpired(secret, now));
  return found ? Buffer.from(found.psk, 'hex') : null;
}

/** Every record whose key is `publicKey`, by registry. */
export interface KeyRecords {
  device?: PairedDevice;
  build?: PairedDevice;
  'device-host'?: PairedDevice;
}

export function recordsForKey(publicKey: string): KeyRecords {
  const device = readDevices().find((entry) => entry.publicKey === publicKey);
  const build = readBuildClients().find((entry) => entry.publicKey === publicKey);
  const host = readDeviceHostClients().find((entry) => entry.publicKey === publicKey);
  return { ...(device ? { device } : {}), ...(build ? { build } : {}), ...(host ? { 'device-host': host } : {}) };
}

/**
 * Spends the secret `lookup` names for the client that just proved it holds it, recording `publicKey` with the
 * capabilities stored with the secret, never ones the client names. A pairing token makes one device record, replacing
 * an earlier pairing of the same key; a setup ticket makes a record for each capability setup approved. The key that
 * spent it may repeat first contact until the secret expires and gets its current records. Null when the secret
 * expired, or another key spent it.
 */
export function spendSecret(
  lookup: string,
  publicKey: string,
  name: string,
  from: string,
  now: number = Date.now(),
): KeyRecords | null {
  return transaction(() => {
    const secrets = readSecrets().filter((each) => unexpired(each, now));
    const secret = secrets.find((each) => each.lookup === lookup);
    if (!secret) {
      writeSecrets(secrets);
      return null;
    }
    if (secret.spentBy !== undefined) return secret.spentBy === publicKey ? recordsForKey(publicKey) : null;
    const spend = () => {
      secret.spentBy = publicKey;
      writeSecrets(secrets);
    };
    const at = new Date(now).toISOString();
    const record = (capabilities: Capability[], fallback: string): PairedDevice => ({
      id: newDeviceId(),
      name: pairingName(name, fallback),
      publicKey,
      from,
      pairedAt: at,
      lastSeenAt: at,
      capabilities,
      ...(secret.journal ? { setupJournal: secret.journal } : {}),
    });
    if (secret.kind === 'pairing') {
      const device = record(secret.capabilities, 'Phone');
      writeRecords(devicesFile(), [...readDevices().filter((each) => each.publicKey !== publicKey), device]);
      spend();
      return { device };
    }
    const made: KeyRecords = {};
    for (const capability of ['build', 'device-host'] as const) {
      if (!secret.capabilities.includes(capability)) continue;
      const created = record([capability], 'Machine');
      writeRecords(clientsFile(capability), [
        ...readRecords(clientsFile(capability)).filter((each) => each.publicKey !== publicKey),
        created,
      ]);
      made[capability] = created;
    }
    spend();
    return made;
  });
}

/** Notes that a record's key authenticated now. */
export function touchDevice(id: string, now: number = Date.now()): void {
  transaction(() => {
    for (const file of [devicesFile(), clientsFile('build'), clientsFile('device-host')]) {
      const records = readRecords(file);
      const found = records.find((entry) => entry.id === id);
      if (!found) continue;
      found.lastSeenAt = new Date(now).toISOString();
      writeRecords(file, records);
      return;
    }
  });
}

/** Sets a pairing's read/control permissions. Build and device-host clients are approved only by `stim-server setup`. */
export function grantDevice(id: string, capabilities: Capability[]): GrantOutcome {
  return transaction<GrantOutcome>(() => {
    const devices = readDevices();
    const device = devices.find((entry) => entry.id === id);
    if (device) {
      if (capabilities.includes('build')) return 'build-mismatch';
      if (capabilities.includes('device-host')) return 'device-host-mismatch';
      device.capabilities = capabilities;
      writeRecords(devicesFile(), devices);
      return 'granted';
    }
    for (const capability of ['build', 'device-host'] as const) {
      if (!readRecords(clientsFile(capability)).some((entry) => entry.id === id)) continue;
      return `${capability}-mismatch`;
    }
    return 'unknown';
  });
}

/**
 * Sets or, with null, removes a device's push registration, taking the token from any other pairing, such as the
 * same phone's previous one. False when the device is no longer paired.
 */
export function setDevicePush(id: string, push: PushRegistration | null): boolean {
  return transaction(() => {
    const devices = readDevices();
    const device = devices.find((entry) => entry.id === id);
    if (!device) return false;
    for (const other of devices) if (push && other.push?.token === push.token) delete other.push;
    if (push) device.push = push;
    else delete device.push;
    writeRecords(devicesFile(), devices);
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
    if (changed) writeRecords(devicesFile(), devices);
  });
}

export function revokeDevice(id: string): boolean {
  return transaction(() => {
    const devices = readDevices();
    const remaining = devices.filter((device) => device.id !== id);
    if (remaining.length !== devices.length) {
      writeRecords(devicesFile(), remaining);
      return true;
    }
    for (const capability of ['build', 'device-host'] as const) {
      const clients = readRecords(clientsFile(capability));
      const kept = clients.filter((client) => client.id !== id);
      if (kept.length === clients.length) continue;
      writeRecords(clientsFile(capability), kept);
      return true;
    }
    return false;
  });
}
