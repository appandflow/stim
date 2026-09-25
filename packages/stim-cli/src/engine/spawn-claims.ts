import type { ChildProcess } from 'node:child_process';
import { captureProcessIdentity } from '../process-identity.ts';
import { clearClaimChild, markClaimChildPending, setClaimChild, type ClaimHandle } from '../ownership-claim.ts';

const declaring = new Set<ClaimHandle>();
const running = new Set<ChildProcess>();
let refusal: string | null = null;

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
  if (refusal !== null) throw new Error(refusal);
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
  running.add(child);
  child.once('exit', () => running.delete(child));
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

/** Refuse every later `spawnDeclared` with `reason` until `allowDeclaredSpawns()`. */
export function refuseDeclaredSpawns(reason: string): void {
  refusal = reason;
}

export function allowDeclaredSpawns(): void {
  refusal = null;
}

/** Send `signal` to every child started through `spawnDeclared` that has not exited; returns how many were signalled. */
export function signalDeclaredSpawns(signal: NodeJS.Signals): number {
  let signalled = 0;
  for (const child of running) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    try {
      if (child.kill(signal)) signalled += 1;
    } catch {}
  }
  return signalled;
}
