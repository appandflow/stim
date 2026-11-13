import { randomBytes } from 'node:crypto';
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  watch,
  writeFileSync,
  type FSWatcher,
} from 'node:fs';
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
import { arrayElementSpans, otherMembers } from './json-spans.ts';

export const PAIRING_TTL_MS: number = 5 * 60_000;

const CLIENT_CAPABILITIES = ['build', 'device-host', 'test'] as const;

type ClientCapability = (typeof CLIENT_CAPABILITIES)[number];

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
  /** The setup journal of the `stim setup` run that approved this client. */
  setupJournal?: string;
  /** The app and version this client named in its last `hello`, cleaned like a name. For display only. */
  clientApp?: string;
  clientVersion?: string;
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

/** The events a registration asks for, in `PUSH_EVENTS` order. */
export function pushEvents(events: readonly unknown[]): PushEvent[] {
  return PUSH_EVENTS.filter((event) => events.includes(event));
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

export type GrantOutcome = 'granted' | 'unknown' | `${ClientCapability}-mismatch`;

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

/**
 * Registry events are hints; callers must reread grants and retain missed-event repair. `also` names more files under
 * the server directory to watch the same way.
 */
export function watchClientRegistries(changed: () => void, also: string[] = []): () => void {
  const files = [...CLIENT_CAPABILITIES.map(clientsFile), ...also];
  const names = new Set(files.map((file) => basename(file)));
  const watchers = new Map<string, FSWatcher>();
  let stopped = false;
  const clearFiles = () => {
    const previous = [...watchers.values()];
    watchers.clear();
    for (const observer of previous) observer.close();
  };
  const refresh = () => {
    clearFiles();
    for (const file of files) {
      try {
        const observer = watch(file, { persistent: false }, (event) => {
          if (stopped || watchers.get(file) !== observer) return;
          if (event === 'rename') refresh();
          changed();
        });
        watchers.set(file, observer);
        observer.once('error', () => {
          if (watchers.get(file) !== observer) return;
          watchers.delete(file);
          observer.close();
          changed();
        });
      } catch {}
    }
  };
  refresh();
  let directory: FSWatcher | undefined;
  try {
    directory = watch(serverDir(), { persistent: false }, (_event, filename) => {
      if (stopped || (filename !== null && !names.has(filename.toString()))) return;
      refresh();
      changed();
    });
    directory.once('error', () => {
      directory?.close();
      directory = undefined;
      if (!stopped) changed();
    });
  } catch {}
  return () => {
    stopped = true;
    directory?.close();
    clearFiles();
  };
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
  return cleanClientText(name) || fallback;
}

function cleanClientText(text: string): string {
  return text
    .replace(/(?![\u200d\s])[\p{Cc}\p{Cf}\p{Cs}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_CLIENT_NAME)
    .replace(/[\ud800-\udbff]$/, '')
    .trim();
}

/** What Stim Desktop names itself in `hello`: `Stim Desktop` for the release app and `Stim Dev` for a development build. */
export const DESKTOP_CLIENT_APPS: readonly string[] = ['Stim Desktop', 'Stim Dev'];

/** Whether a record's recorded client app is Stim Desktop. A client names itself, so this is for display only. */
export function isDesktopClient(device: PairedDevice): boolean {
  return device.clientApp !== undefined && DESKTOP_CLIENT_APPS.includes(device.clientApp);
}

function newDeviceId(): string {
  const taken = new Set(REGISTRIES.flatMap((path) => readSlots(path()).map(slotId)));
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
  const { id, name, publicKey, pairedAt, lastSeenAt, from, setupJournal, clientApp, clientVersion } = value;
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
    ...(typeof clientApp === 'string' && clientApp ? { clientApp } : {}),
    ...(typeof clientVersion === 'string' && clientVersion ? { clientVersion } : {}),
  };
}

/** A registry file that cannot be read, or a Stim home or server directory that does not answer. */
export class RegistryUnavailable extends Error {
  override name = 'RegistryUnavailable';
}

const why = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * The text of `file`, or null when the file does not exist in a server directory that answers, as on a first run. A
 * server directory that cannot be read, such as one whose Stim home is a symlink to an unmounted volume, and a file
 * that cannot be read throw {@link RegistryUnavailable}.
 */
function readRegistryText(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
      throw new RegistryUnavailable(`Cannot read ${file}: ${why(error)}`);
    try {
      readdirSync(dirname(file));
    } catch (directoryError) {
      throw new RegistryUnavailable(`Cannot read ${dirname(file)}: ${why(directoryError)}`);
    }
    return null;
  }
}

function parseRegistry(file: string, text: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new RegistryUnavailable(`Cannot parse ${file}: ${why(error)}`);
  }
  if (!isJsonObject(value)) throw new RegistryUnavailable(`${file} does not hold a JSON object.`);
  return value;
}

/** The JSON object in `file`, or null when it does not exist. A file that cannot be read or parsed throws {@link RegistryUnavailable}. */
function readRegistryFile(file: string): Record<string, unknown> | null {
  const text = readRegistryText(file);
  return text === null ? null : parseRegistry(file, text);
}

/** One entry of a registry's `devices` list: the record it parses to, or null for an entry this version cannot read. */
interface Slot {
  /** The entry's own text in the file. */
  raw: string;
  value: unknown;
  device: PairedDevice | null;
}

const slotId = (slot: Slot): string | undefined => {
  const id = slot.device ? slot.device.id : isJsonObject(slot.value) ? slot.value.id : undefined;
  return typeof id === 'string' ? id : undefined;
};

interface Contents {
  slots: Slot[];
  /** The text of each top-level member of a version 2 file other than `version` and `devices`. */
  others: string[];
  /** The version of a file that a newer Stim wrote. */
  newer: number | null;
}

/** Records of protocol 1, which stored device tokens and tailnet nodes, are not read, and neither are those of a newer version. */
function readContents(file: string): Contents {
  const none: Contents = { slots: [], others: [], newer: null };
  const text = readRegistryText(file);
  if (text === null) return none;
  const registry = parseRegistry(file, text);
  const { version, devices } = registry;
  if (typeof version === 'number' && version > REGISTRY_VERSION) return { ...none, newer: version };
  if (version !== REGISTRY_VERSION) return none;
  if (!Array.isArray(devices)) throw new RegistryUnavailable(`${file} has no devices list.`);
  const spans = arrayElementSpans(text, 'devices');
  if (spans?.length !== devices.length) throw new RegistryUnavailable(`Cannot locate the records in ${file}.`);
  const slots = spans.map(([start, end], index) => ({
    raw: text.slice(start, end),
    value: devices[index],
    device: parseDevice(devices[index]),
  }));
  return { slots, others: otherMembers(text, ['version', 'devices']), newer: null };
}

const readSlots = (file: string): Slot[] => readContents(file).slots;

function readRecords(file: string): PairedDevice[] {
  return readSlots(file).flatMap((slot) => slot.device ?? []);
}

function recordsOrNone(file: string): PairedDevice[] {
  try {
    return readRecords(file);
  } catch (error) {
    if (error instanceof RegistryUnavailable) return [];
    throw error;
  }
}

function refuseNewer(file: string, newer: number | null): void {
  if (newer === null) return;
  throw new RegistryUnavailable(
    `${file} is registry version ${newer}, which a newer Stim wrote; this Stim writes version ${REGISTRY_VERSION} and leaves it as it is.`,
  );
}

/**
 * Writes `devices` as the file's records. An entry this version cannot read stays in its place, as the text it has in
 * the file, and so does any other top-level member. A record left in `devices` takes the place of the entry with its id,
 * and a new one goes last. A file that a newer Stim wrote is not written.
 */
function writeRecords(file: string, devices: PairedDevice[]): void {
  const marker = randomBytes(8).toString('hex');
  const unreadable: string[] = [];
  const remaining = [...devices];
  const entries: unknown[] = [];
  const { slots, others, newer } = readContents(file);
  refuseNewer(file, newer);
  for (const { raw, device } of slots) {
    if (device === null) entries.push(`${marker}${unreadable.push(raw) - 1}`);
    else {
      const index = remaining.findIndex((each) => each.id === device.id);
      if (index >= 0) entries.push(...remaining.splice(index, 1));
    }
  }
  const members = Object.fromEntries(others.map((_, index) => [`${marker}m${index}`, 0]));
  const value = { version: REGISTRY_VERSION, devices: [...entries, ...remaining], ...members };
  let text = `${JSON.stringify(value, null, 2)}\n`;
  for (const [index, raw] of unreadable.entries()) text = text.replace(`"${marker}${index}"`, () => raw);
  for (const [index, raw] of others.entries()) text = text.replace(`"${marker}m${index}": 0`, () => raw);
  writeText(file, text);
}

/**
 * An entry of a registry's `devices` list that this version cannot read, or, with `version`, a whole registry file that
 * a newer Stim wrote. It is kept as it is and grants nothing.
 */
export interface UnreadableRecord {
  /** The registry file's name: `devices.json`, `build-clients.json`, `device-host-clients.json` or `test-clients.json`. */
  file: string;
  /** The entry's position in that file's `devices` list. Absent for a whole file. */
  index?: number;
  /** The entry's own `id`, when it has a string one. */
  id?: string;
  /** The version of a whole file that a newer Stim wrote. */
  version?: number;
}

const REGISTRIES = [devicesFile, ...CLIENT_CAPABILITIES.map((capability) => () => clientsFile(capability))];

/** The entries of the registries that this version cannot read, or none for a registry that cannot be read. */
export function readUnreadable(): UnreadableRecord[] {
  return REGISTRIES.flatMap((path): UnreadableRecord[] => {
    const file = path();
    try {
      const { slots, newer } = readContents(file);
      if (newer !== null) return [{ file: basename(file), version: newer }];
      return slots.flatMap((slot, index) => {
        if (slot.device !== null) return [];
        const id = cleanClientText(slotId(slot) ?? '');
        return [{ file: basename(file), index, ...(id ? { id } : {}) }];
      });
    } catch (error) {
      if (error instanceof RegistryUnavailable) return [];
      throw error;
    }
  });
}

export interface Registries {
  devices: PairedDevice[];
  build: PairedDevice[];
  deviceHost: PairedDevice[];
  test: PairedDevice[];
}

/**
 * Every record of the registries. It throws {@link RegistryUnavailable} when any of them cannot be read, so a
 * Stim home that stopped answering is never mistaken for one with no clients.
 */
export function readRegistries(): Registries {
  return {
    devices: readRecords(devicesFile()),
    build: readRecords(clientsFile('build')),
    deviceHost: readRecords(clientsFile('device-host')),
    test: readRecords(clientsFile('test')),
  };
}

/** Paired devices, or none when `devices.json` cannot be read. */
export function readDevices(): PairedDevice[] {
  return recordsOrNone(devicesFile());
}

/** The machines that may build here. They live apart from `devices.json`, so a server never reads them as devices. */
export function readBuildClients(): PairedDevice[] {
  return recordsOrNone(clientsFile('build'));
}

/** Whether the build client registry parses, so an empty `readBuildClients` means no client rather than a read failure. */
export function buildClientsReadable(): boolean {
  const registry = readJsonObject(clientsFile('build'));
  return registry?.version === REGISTRY_VERSION && Array.isArray(registry.devices);
}

/** Device-host approvals live apart from read/control pairings and build clients. */
export function readDeviceHostClients(): PairedDevice[] {
  return recordsOrNone(clientsFile('device-host'));
}

/** Test approvals live apart from every other record, so no other approval ever runs a client's commands here. */
export function readTestClients(): PairedDevice[] {
  return recordsOrNone(clientsFile('test'));
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
  const secrets = readRegistryFile(secretsFile())?.secrets;
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
  writeText(file, `${JSON.stringify(value, null, 2)}\n`);
}

function writeText(file: string, text: string): void {
  const temporary = join(dirname(file), `.${basename(file)}.${process.pid}.tmp`);
  try {
    writeFileSync(temporary, text, { mode: 0o600 });
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
 * Lets the holder of a setup ticket record its key with `capabilities` until `expiresAt`. `stim setup` stores
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

/** The PSK of the unexpired secret named by `lookup` (hex), or null. Throws {@link RegistryUnavailable}. */
export function secretPsk(lookup: string, now: number = Date.now()): Buffer | null {
  const found = readSecrets().find((secret) => secret.lookup === lookup && unexpired(secret, now));
  return found ? Buffer.from(found.psk, 'hex') : null;
}

/** Every record whose key is `publicKey`, by registry. */
export interface KeyRecords {
  device?: PairedDevice;
  build?: PairedDevice;
  'device-host'?: PairedDevice;
  test?: PairedDevice;
}

export function recordsForKey(publicKey: string, registries: Registries = readRegistries()): KeyRecords {
  const device = registries.devices.find((entry) => entry.publicKey === publicKey);
  const build = registries.build.find((entry) => entry.publicKey === publicKey);
  const host = registries.deviceHost.find((entry) => entry.publicKey === publicKey);
  const test = registries.test.find((entry) => entry.publicKey === publicKey);
  return {
    ...(device ? { device } : {}),
    ...(build ? { build } : {}),
    ...(host ? { 'device-host': host } : {}),
    ...(test ? { test } : {}),
  };
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
    const targets =
      secret.kind === 'pairing'
        ? [devicesFile()]
        : CLIENT_CAPABILITIES.filter((each) => secret.capabilities.includes(each)).map(clientsFile);
    for (const target of targets) refuseNewer(target, readContents(target).newer);
    if (secret.kind === 'pairing') {
      const device = record(secret.capabilities, 'Phone');
      writeRecords(devicesFile(), [
        ...readRecords(devicesFile()).filter((each) => each.publicKey !== publicKey),
        device,
      ]);
      spend();
      return { device };
    }
    const made: KeyRecords = {};
    for (const capability of CLIENT_CAPABILITIES) {
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

const TOUCH_INTERVAL_MS = 60_000;

/** The `client` of a `hello`, whose values the client chose. */
export interface HelloClient {
  name?: unknown;
  version?: unknown;
}

/**
 * Notes that a record's key authenticated now, at most once per `TOUCH_INTERVAL_MS`, and records the app and version
 * the client named in `hello`. A record with no app yet takes it at once, so a record fills in on its first
 * connection after an upgrade, and a new pairing on the hello that follows it.
 */
export function touchDevice(id: string, client: HelloClient = {}, now: number = Date.now()): void {
  const app = typeof client.name === 'string' ? cleanClientText(client.name) : '';
  const version = typeof client.version === 'string' ? cleanClientText(client.version) : '';
  transaction(() => {
    for (const file of REGISTRIES.map((path) => path())) {
      const records = readRecords(file);
      const found = records.find((entry) => entry.id === id);
      if (!found) continue;
      const due = found.lastSeenAt === null || Math.abs(now - Date.parse(found.lastSeenAt)) >= TOUCH_INTERVAL_MS;
      const missing = app !== '' && found.clientApp === undefined;
      if (!due && !missing) return;
      if (due) found.lastSeenAt = new Date(now).toISOString();
      if (app) found.clientApp = app;
      if (app && version) found.clientVersion = version;
      else if (app) delete found.clientVersion;
      writeRecords(file, records);
      return;
    }
  });
}

/** Sets a pairing's read/control permissions. Build, device-host and test clients are approved only by `stim setup`. */
export function grantDevice(id: string, capabilities: Capability[]): GrantOutcome {
  return transaction<GrantOutcome>(() => {
    const devices = readRecords(devicesFile());
    const device = devices.find((entry) => entry.id === id);
    if (device) {
      const asked = CLIENT_CAPABILITIES.find((capability) => capabilities.includes(capability));
      if (asked) return `${asked}-mismatch`;
      device.capabilities = capabilities;
      writeRecords(devicesFile(), devices);
      return 'granted';
    }
    for (const capability of CLIENT_CAPABILITIES) {
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
    const devices = readRecords(devicesFile());
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
    const devices = readRecords(devicesFile());
    let changed = false;
    for (const device of devices) {
      if (device.push?.token !== token) continue;
      delete device.push;
      changed = true;
    }
    if (changed) writeRecords(devicesFile(), devices);
  });
}

export type RenameOutcome = 'renamed' | 'unknown' | 'invalid-name';

/** A name a person typed for a record: 1 to 64 characters after trimming, without control, format or separator characters. */
function personName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > MAX_CLIENT_NAME) return null;
  return /(?!\u200d)[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(trimmed) ? null : trimmed;
}

/** Renames the record `id` in whichever registry holds it. Its key and capabilities stay as they are. */
export function renameDevice(id: string, name: string): RenameOutcome {
  const clean = personName(name);
  if (clean === null) return 'invalid-name';
  return transaction<RenameOutcome>(() => {
    for (const file of REGISTRIES.map((path) => path())) {
      const records = readRecords(file);
      const found = records.find((entry) => entry.id === id);
      if (!found) continue;
      found.name = clean;
      writeRecords(file, records);
      return 'renamed';
    }
    return 'unknown';
  });
}

export function revokeDevice(id: string): boolean {
  return transaction(() => {
    const devices = readRecords(devicesFile());
    const remaining = devices.filter((device) => device.id !== id);
    if (remaining.length !== devices.length) {
      writeRecords(devicesFile(), remaining);
      return true;
    }
    for (const capability of CLIENT_CAPABILITIES) {
      const clients = readRecords(clientsFile(capability));
      const kept = clients.filter((client) => client.id !== id);
      if (kept.length === clients.length) continue;
      writeRecords(clientsFile(capability), kept);
      return true;
    }
    return false;
  });
}
