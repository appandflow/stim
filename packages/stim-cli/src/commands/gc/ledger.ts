import { existsSync, lstatSync } from 'node:fs';
import { dirname } from 'node:path';
import chalk from 'chalk';
import type { CreatedDevices } from '@stim-cli/core/state';
import { forgetCreatedDevice } from '../../devices/created-devices.ts';
import type { IosSimRecord } from '../../devices/ios.ts';

export interface StaleLedgerEntry {
  kind: 'ios' | 'web';
  id: string;
}

/** `sims` must be a complete listing, unavailable simulators included, taken after `ledger` was read. */
export function findStaleLedgerEntries(ledger: CreatedDevices, sims: readonly IosSimRecord[]): StaleLedgerEntry[] {
  const listed = new Set(sims.map((sim) => sim.udid));
  return [...ledger.ios].filter((udid) => !listed.has(udid)).map((id) => ({ kind: 'ios', id }));
}

/**
 * Browser profiles the ledger lists whose directory is gone while the workspaces directory that held it is
 * present and the workspace is not a link to a missing volume, so an unmounted volume never reads as a deleted
 * profile.
 */
export function staleBrowserProfiles(
  ledger: CreatedDevices,
  exists: (path: string) => boolean = existsSync,
): StaleLedgerEntry[] {
  return [...ledger.web].filter((path) => isStaleProfile(path, exists)).map((id) => ({ kind: 'web', id }));
}

function isStaleProfile(path: string, exists: (path: string) => boolean): boolean {
  const workspace = dirname(dirname(path));
  return !exists(path) && exists(dirname(workspace)) && !isDanglingLink(workspace);
}

function isDanglingLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink() && !existsSync(path);
  } catch {
    return false;
  }
}

export function forgetStaleLedgerEntries(entries: readonly StaleLedgerEntry[]): number {
  let failures = 0;
  for (const entry of entries) {
    if (entry.kind === 'web' && !isStaleProfile(entry.id, existsSync)) continue;
    try {
      forgetCreatedDevice(entry.kind, entry.id);
      console.log(chalk.green(`Forgot the ledger entry for ${entry.kind} ${entry.id} (not on this machine)`));
    } catch (error) {
      failures++;
      console.log(
        chalk.red(
          `Could not forget the ledger entry for ${entry.kind} ${entry.id}: ${(error as Error)?.message || error}`,
        ),
      );
    }
  }
  return failures;
}
