import { existsSync } from 'node:fs';
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

/** Browser profiles the ledger lists whose directory is gone; they live under STIM_HOME, so absence is proof. */
export function staleBrowserProfiles(
  ledger: CreatedDevices,
  exists: (path: string) => boolean = existsSync,
): StaleLedgerEntry[] {
  return [...ledger.web].filter((path) => !exists(path)).map((id) => ({ kind: 'web', id }));
}

export function forgetStaleLedgerEntries(entries: readonly StaleLedgerEntry[]): number {
  let failures = 0;
  for (const entry of entries) {
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
