import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  easMachineStateRoot,
  easSessionLedgerFile,
  easSessionLedgerLock,
  readEasSessionLedger,
  validEasSessionClaim,
  type EasSessionClaim,
} from '@stim-cli/core/state';
import { withDirLock } from '../dir-lock.ts';

export { easMachineStateRoot, readEasSessionLedger, type EasSessionClaim } from '@stim-cli/core/state';

interface EasSessionLedger {
  version: 1;
  claims: Record<string, EasSessionClaim>;
}

function writeLedger(root: string, ledger: EasSessionLedger): void {
  mkdirSync(root, { recursive: true });
  const file = easSessionLedgerFile(root);
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(ledger, null, 2)}\n`);
  try {
    renameSync(tmp, file);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

export function recordEasSessionClaim(claim: EasSessionClaim, root: string = easMachineStateRoot()): void {
  const normalized = validEasSessionClaim(claim.sessionId, claim);
  if (!normalized) throw new Error(`Invalid EAS session claim for ${claim.sessionId}.`);
  withDirLock(
    easSessionLedgerLock(root),
    () => {
      const current = readEasSessionLedger(root);
      if (!current.safe) throw new Error(current.notice ?? 'EAS ownership ledger is unreadable.');
      current.claims.set(normalized.sessionId, normalized);
      writeLedger(root, { version: 1, claims: Object.fromEntries(current.claims) });
    },
    { ensureParent: () => mkdirSync(dirname(easSessionLedgerLock(root)), { recursive: true }) },
  );
}

export function removeEasSessionClaim(sessionId: string, root: string = easMachineStateRoot()): boolean {
  const file = easSessionLedgerFile(root);
  if (!existsSync(file)) return false;
  return withDirLock(easSessionLedgerLock(root), () => {
    const current = readEasSessionLedger(root);
    if (!current.safe) return false;
    if (!current.claims.delete(sessionId)) return false;
    writeLedger(root, { version: 1, claims: Object.fromEntries(current.claims) });
    return true;
  });
}
