import { existsSync, lstatSync } from 'node:fs';
import { dirname } from 'node:path';
import chalk from 'chalk';
import type { CreatedDevices, StimConfig } from '@stim-cli/core/state';
import { avdNameAbsent } from '../../devices/android.ts';
import { acquireAvdClaim } from '../../devices/avd-claim.ts';
import { forgetCreatedDevice } from '../../devices/created-devices.ts';
import { projectDeviceSlots } from '../../devices/device-slots.ts';
import type { IosSimRecord } from '../../devices/ios.ts';
import { releaseClaim, type ClaimHandle } from '../../ownership-claim.ts';
import { loadConfig, withConfigLock } from '../../workspace/config.ts';

export interface StaleLedgerEntry {
  kind: 'ios' | 'android' | 'web';
  id: string;
}

/** `sims` must be a complete listing, unavailable simulators included, taken after `ledger` was read. */
export function findStaleLedgerEntries(ledger: CreatedDevices, sims: readonly IosSimRecord[]): StaleLedgerEntry[] {
  const listed = new Set(sims.map((sim) => sim.udid));
  return [...ledger.ios].filter((udid) => !listed.has(udid)).map((id) => ({ kind: 'ios', id }));
}

/**
 * `registered` must come from an emulator listing that succeeded after `ledger` was read. A name stays while an
 * unfinished setup reserves it, or while any AVD root could still hold it.
 */
export function findStaleAndroidLedgerEntries(
  ledger: CreatedDevices,
  registered: readonly string[],
  config: StimConfig | null,
): StaleLedgerEntry[] {
  const listed = new Set(registered);
  return [...ledger.android]
    .filter((name) => !listed.has(name) && isStaleAvdName(name, config))
    .map((id) => ({ kind: 'android', id }));
}

function isStaleAvdName(name: string, config: StimConfig | null): boolean {
  try {
    return !reservedForSetup(name, config) && avdNameAbsent(name);
  } catch {
    return false;
  }
}

function reservedForSetup(name: string, config: StimConfig | null): boolean {
  return Object.values(config?.projects ?? {}).some((project) =>
    projectDeviceSlots(project).some(
      ({ platforms }) => platforms.android?.setupIncomplete && platforms.android.avdName === name,
    ),
  );
}

function forgetStaleAvdName(name: string): boolean {
  let claim: ClaimHandle | null = null;
  try {
    claim = acquireAvdClaim(name);
    return withConfigLock(() => {
      if (!isStaleAvdName(name, loadConfig())) return false;
      forgetCreatedDevice('android', name);
      return true;
    });
  } finally {
    releaseClaim(claim);
  }
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
      if (entry.kind === 'android') {
        if (!forgetStaleAvdName(entry.id)) {
          console.log(chalk.dim(`Kept the ledger entry for android ${entry.id}: the AVD or its setup reappeared`));
          continue;
        }
      } else forgetCreatedDevice(entry.kind, entry.id);
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
