import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import chalk from 'chalk';
import { isOnMountedVolume } from '../../fs-util.ts';
import { easMachineStateRoot, readEasSessionLedger, removeEasSessionClaim } from '../../engine/eas-session-ledger.ts';
import { describeError } from './eas-sessions.ts';
import type { EasSessionClaim } from '../../engine/eas-session-ledger.ts';

export interface StaleEasLedgerEntry {
  id: string;
  workspaceRoot: string;
}

export interface EasLedgerDependencies {
  easLedgerRoot?: string;
  removeEasSessionClaim?: typeof removeEasSessionClaim;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * An entry is dropped only when its id cannot be an EAS session id and its workspace root is provably gone:
 * absolute, missing, and on a mounted volume, the same proof gc uses for dead project entries.
 */
export function isStaleEasLedgerEntry(
  claim: EasSessionClaim,
  mountedVolumes: string[],
  exists: (path: string) => boolean = existsSync,
): boolean {
  if (UUID.test(claim.sessionId)) return false;
  const root = claim.workspaceRoot;
  if (!isAbsolute(root) || exists(root)) return false;
  return isOnMountedVolume(root, mountedVolumes);
}

export function findStaleEasLedgerEntries(
  mountedVolumes: string[],
  deps: EasLedgerDependencies = {},
): StaleEasLedgerEntry[] {
  const ledger = readEasSessionLedger(deps.easLedgerRoot ?? easMachineStateRoot());
  if (!ledger.safe) return [];
  return [...ledger.claims.values()]
    .filter((claim) => isStaleEasLedgerEntry(claim, mountedVolumes))
    .map(({ sessionId, workspaceRoot }) => ({ id: sessionId, workspaceRoot }));
}

export function forgetStaleEasLedgerEntries(
  entries: readonly StaleEasLedgerEntry[],
  mountedVolumes: string[],
  deps: EasLedgerDependencies = {},
): number {
  let failures = 0;
  const root = deps.easLedgerRoot ?? easMachineStateRoot();
  const remove = deps.removeEasSessionClaim ?? removeEasSessionClaim;
  for (const entry of entries) {
    try {
      const current = readEasSessionLedger(root).claims.get(entry.id);
      if (!current || !isStaleEasLedgerEntry(current, mountedVolumes)) {
        console.log(chalk.dim(`Kept the EAS ledger entry ${entry.id}: it changed since the report.`));
        continue;
      }
      if (remove(entry.id, root)) {
        console.log(
          chalk.green(`Forgot the EAS ledger entry ${entry.id} (invalid id, ${entry.workspaceRoot} is gone)`),
        );
      }
    } catch (error) {
      failures++;
      console.log(chalk.red(`Could not forget the EAS ledger entry ${entry.id}: ${describeError(error)}`));
    }
  }
  return failures;
}
