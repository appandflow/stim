import type { ChildProcess } from 'node:child_process';
import { captureProcessIdentity } from '../process-identity.ts';
import { clearClaimChild, markClaimChildPending, setClaimChild, type ClaimHandle } from '../ownership-claim.ts';

const declaring = new Set<ClaimHandle>();

/** Record every child later started through `spawnDeclared` on `claim` until `stopDeclaringSpawnsOn(claim)`. */
export function declareSpawnsOn(claim: ClaimHandle | null | undefined): void {
  if (claim) declaring.add(claim);
}

export function stopDeclaringSpawnsOn(claim: ClaimHandle | null | undefined): void {
  if (claim) declaring.delete(claim);
}

/**
 * Start a child that every claim passed to `declareSpawnsOn` records until it exits. The child keeps
 * the caller's process group, so a terminal interrupt still reaches it; the claim follows the child
 * itself. A claim that cannot be marked stops the spawn rather than letting it run unprotected. A claim
 * records one child, so declared spawns must not overlap.
 */
export function spawnDeclared(spawn: () => ChildProcess): ChildProcess {
  const claims = [...declaring];
  if (claims.length === 0) return spawn();
  const forget = () => {
    for (const claim of claims) {
      try {
        clearClaimChild(claim);
      } catch {}
    }
  };
  let child: ChildProcess;
  try {
    for (const claim of claims) markClaimChildPending(claim);
    child = spawn();
  } catch (error) {
    forget();
    throw error;
  }
  const pid = child.pid;
  if (pid === undefined) {
    forget();
    return child;
  }
  const captured = captureProcessIdentity(pid);
  if (captured.ok) {
    for (const claim of claims) {
      try {
        setClaimChild(claim, { pid, processToken: captured.token });
      } catch {}
    }
  }
  child.once('exit', forget);
  return child;
}
