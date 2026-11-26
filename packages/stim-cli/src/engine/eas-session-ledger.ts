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
import { withDirLock, withDirLockAsync } from '../dir-lock.ts';

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

function easSessionClaimWrite(claim: EasSessionClaim, root: string): () => void {
  const normalized = validEasSessionClaim(claim.sessionId, claim);
  if (!normalized) throw new Error(`Invalid EAS session claim for ${claim.sessionId}.`);
  return () => {
    const current = readEasSessionLedger(root);
    if (!current.safe) throw new Error(current.notice ?? 'EAS ownership ledger is unreadable.');
    current.claims.set(normalized.sessionId, normalized);
    writeLedger(root, { version: 1, claims: Object.fromEntries(current.claims) });
  };
}

/** Records the claim after waiting for the ledger lock without blocking the event loop. */
export async function recordEasSessionClaim(
  claim: EasSessionClaim,
  root: string = easMachineStateRoot(),
): Promise<void> {
  await withDirLockAsync(easSessionLedgerLock(root), easSessionClaimWrite(claim, root), {
    ensureParent: () => mkdirSync(dirname(easSessionLedgerLock(root)), { recursive: true }),
  });
}

export function removeEasSessionClaim(
  sessionId: string,
  root: string = easMachineStateRoot(),
  when: (claim: EasSessionClaim) => boolean = () => true,
): boolean {
  const file = easSessionLedgerFile(root);
  if (!existsSync(file)) return false;
  return withDirLock(easSessionLedgerLock(root), () => {
    const current = readEasSessionLedger(root);
    if (!current.safe) return false;
    const claim = current.claims.get(sessionId);
    if (!claim || !when(claim)) return false;
    current.claims.delete(sessionId);
    writeLedger(root, { version: 1, claims: Object.fromEntries(current.claims) });
    return true;
  });
}

/** Removes a matching EAS session claim after asynchronously acquiring the ownership ledger lock. */
export async function removeEasSessionClaimAsync(
  sessionId: string,
  root: string = easMachineStateRoot(),
  when: (claim: EasSessionClaim) => boolean = () => true,
  signal?: AbortSignal,
): Promise<boolean> {
  signal?.throwIfAborted();
  if (!existsSync(easSessionLedgerFile(root))) return false;
  return withDirLockAsync(easSessionLedgerLock(root), () => removeEasSessionClaim(sessionId, root, when), { signal });
}
