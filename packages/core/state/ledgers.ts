import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { workspaceName } from '../index.ts';
import { createdDevicesFile, easMachineStateRoot, easSessionLedgerFile } from './paths.ts';

export type CreatedDevicePlatform = 'ios' | 'android' | 'web';

/** `web` lists the absolute paths of browser profile directories Stim created. */
export interface CreatedDevices {
  ios: ReadonlySet<string>;
  android: ReadonlySet<string>;
  web: ReadonlySet<string>;
}

function ids(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry !== '')
    : [];
}

export function readCreatedDevices(): CreatedDevices {
  try {
    const parsed = JSON.parse(readFileSync(createdDevicesFile(), 'utf8')) as Record<string, unknown>;
    return { ios: new Set(ids(parsed?.ios)), android: new Set(ids(parsed?.android)), web: new Set(ids(parsed?.web)) };
  } catch {
    return { ios: new Set(), android: new Set(), web: new Set() };
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
