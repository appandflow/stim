import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { workspaceName } from '../index.ts';
import { isJsonObject, readStateFile } from './json-file.ts';
import {
  createdDevicesFile,
  easMachineStateRoot,
  easSessionLedgerFile,
  stimHomesFile,
  stimHomesRoot,
} from './paths.ts';

export type CreatedDevicePlatform = 'ios' | 'android' | 'web';

/**
 * `web` lists the absolute paths of browser profile directories Stim created. `systemImages` lists the canonical
 * directories of Android system images Stim installed with sdkmanager.
 */
export interface CreatedDevices {
  ios: ReadonlySet<string>;
  android: ReadonlySet<string>;
  web: ReadonlySet<string>;
  systemImages: ReadonlySet<string>;
}

function ids(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry !== '')
    : [];
}

/** The devices the Stim home at `home` created; this process's own home by default. */
export function readCreatedDevices(home?: string): CreatedDevices {
  try {
    const parsed: unknown = JSON.parse(readStateFile(createdDevicesFile(home)));
    if (!isJsonObject(parsed)) return { ios: new Set(), android: new Set(), web: new Set(), systemImages: new Set() };
    return {
      ios: new Set(ids(parsed.ios)),
      android: new Set(ids(parsed.android)),
      web: new Set(ids(parsed.web)),
      systemImages: new Set(ids(parsed.systemImages)),
    };
  } catch {
    return { ios: new Set(), android: new Set(), web: new Set(), systemImages: new Set() };
  }
}

export interface EasSessionClaim {
  sessionId: string;
  name: string;
  platform: 'ios' | 'android';
  workspaceRoot: string;
  workspaceHome: string;
  stateFile: string;
}

export interface EasSessionLedgerRead {
  claims: Map<string, EasSessionClaim>;
  notice: string | null;
  safe: boolean;
}

/** Returns the claim normalized to canonical paths, or null when it is not a valid claim for `id`. */
export function validEasSessionClaim(id: string, value: unknown): EasSessionClaim | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const claim = value as Partial<EasSessionClaim>;
  if (claim.sessionId !== id) return null;
  if (typeof claim.name !== 'string' || !claim.name.startsWith('stim-')) return null;
  if (claim.platform !== 'ios' && claim.platform !== 'android') return null;
  if (typeof claim.workspaceRoot !== 'string' || !isAbsolute(claim.workspaceRoot)) return null;
  if (typeof claim.workspaceHome !== 'string' || !isAbsolute(claim.workspaceHome)) return null;
  if (typeof claim.stateFile !== 'string' || !isAbsolute(claim.stateFile)) return null;
  const workspaceRoot = resolve(claim.workspaceRoot);
  const workspaceHome = resolve(claim.workspaceHome);
  const stateFile = resolve(claim.stateFile);
  const stateRelative = relative(workspaceHome, stateFile);
  if (!stateRelative || stateRelative.startsWith('..') || isAbsolute(stateRelative)) return null;
  if (stateFile !== join(workspaceHome, 'workspaces', workspaceName(workspaceRoot), 'state.json')) return null;
  return {
    sessionId: id,
    name: claim.name,
    platform: claim.platform,
    workspaceRoot,
    workspaceHome,
    stateFile,
  };
}

export function readEasSessionLedger(root: string = easMachineStateRoot()): EasSessionLedgerRead {
  const file = easSessionLedgerFile(root);
  if (!existsSync(file)) return { claims: new Map(), notice: null, safe: true };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf-8')) as unknown;
  } catch (error) {
    return {
      claims: new Map(),
      notice: `EAS ownership ledger ${file} is unreadable: ${(error as Error).message}`,
      safe: false,
    };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { claims: new Map(), notice: `EAS ownership ledger ${file} is malformed.`, safe: false };
  }
  const ledger = parsed as { version?: unknown; claims?: unknown };
  if (ledger.version !== 1 || !ledger.claims || typeof ledger.claims !== 'object' || Array.isArray(ledger.claims)) {
    return { claims: new Map(), notice: `EAS ownership ledger ${file} is malformed.`, safe: false };
  }
  const claims = new Map<string, EasSessionClaim>();
  for (const [id, value] of Object.entries(ledger.claims)) {
    const claim = validEasSessionClaim(id, value);
    if (!claim) return { claims: new Map(), notice: `EAS ownership ledger ${file} is malformed.`, safe: false };
    claims.set(id, claim);
  }
  return { claims, notice: null, safe: true };
}

/** One Stim home that created a workspace or a device, as the machine-level list records it. */
export interface StimHomeEntry {
  /** The canonical path of the home directory. */
  path: string;
  createdAt: string;
  lastSeenAt: string;
  /** The ids the home's created-devices ledger last listed: simulator UDIDs and AVD names. */
  devices: { ios: string[]; android: string[] };
}

export interface StimHomesRead {
  homes: Map<string, StimHomeEntry>;
  notice: string | null;
  safe: boolean;
}

function validTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function validIds(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((id) => typeof id === 'string' && id !== '');
}

/** Returns the entry normalized, or null when `value` is not a valid entry for `path`. */
export function validStimHomeEntry(path: string, value: unknown): StimHomeEntry | null {
  if (!isAbsolute(path) || !isJsonObject(value)) return null;
  const { createdAt, lastSeenAt, devices } = value;
  if (!validTimestamp(createdAt) || !validTimestamp(lastSeenAt) || !isJsonObject(devices)) return null;
  const { ios, android } = devices;
  if (!validIds(ios) || !validIds(android)) return null;
  return { path, createdAt, lastSeenAt, devices: { ios: [...ios], android: [...android] } };
}

export function readStimHomes(root: string = stimHomesRoot()): StimHomesRead {
  const file = stimHomesFile(root);
  if (!existsSync(file)) return { homes: new Map(), notice: null, safe: true };
  const unsafe = (reason: string): StimHomesRead => ({
    homes: new Map(),
    notice: `The machine list of Stim homes ${file} ${reason}.`,
    safe: false,
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf-8'));
  } catch (error) {
    return unsafe(`is unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isJsonObject(parsed) || parsed.version !== 1 || !isJsonObject(parsed.homes)) return unsafe('is malformed');
  const homes = new Map<string, StimHomeEntry>();
  for (const [path, value] of Object.entries(parsed.homes)) {
    const entry = validStimHomeEntry(path, value);
    if (!entry) return unsafe('is malformed');
    homes.set(path, entry);
  }
  return { homes, notice: null, safe: true };
}
