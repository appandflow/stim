import type { ChildProcess } from 'node:child_process';
import type { StimContext } from '@stim-cli/core';
import { captureProcessIdentity } from '../process-identity.ts';
import { clearClaimChild, markClaimChildPending, setClaimChild, type ClaimHandle } from '../ownership-claim.ts';
import { operationState } from './operation-state.ts';

/**
 * Record every child `context`'s operation later starts through `spawnDeclared` on `claim` until
 * `stopDeclaringSpawnsOn(context, claim)`.
 */
export function declareSpawnsOn(context: StimContext | undefined, claim: ClaimHandle | null | undefined): void {
  if (claim) operationState(context).declaring.add(claim);
}

export function stopDeclaringSpawnsOn(context: StimContext | undefined, claim: ClaimHandle | null | undefined): void {
  if (claim) operationState(context).declaring.delete(claim);
}

/**
 * Start a child that every claim `context`'s operation passed to `declareSpawnsOn` records until it exits. The child keeps
 * the caller's process group, so a terminal interrupt still reaches it; the claim follows the child
 * itself. A claim that cannot be marked stops the spawn rather than letting it run unprotected. A claim
 * records one child, so declared spawns must not overlap. `until: 'close'` also holds the declaration
 * while a launcher's child retains its stdio pipes after the launcher exits.
 */
export function spawnDeclared(
  context: StimContext | undefined,
  spawn: () => ChildProcess,
  { until = 'exit' }: { until?: 'exit' | 'close' } = {},
): ChildProcess {
  const { declaring, running, refusal } = operationState(context);
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
  child.once(until, () => running.delete(child));
  const captured = captureProcessIdentity(pid);
  if (captured.ok) {
    for (const claim of claims) {
      try {
        setClaimChild(claim, { pid, processToken: captured.token });
      } catch {}
    }
  }
  child.once(until, forget);
  return child;
}

/** Refuse every later `spawnDeclared` of `context`'s operation with `reason` until `allowDeclaredSpawns`. */
export function refuseDeclaredSpawns(context: StimContext | undefined, reason: string): void {
  operationState(context).refusal = reason;
}

export function allowDeclaredSpawns(context: StimContext | undefined): void {
  operationState(context).refusal = null;
}

/**
 * Send `signal` to every child `context`'s operation started through `spawnDeclared` that has not exited; returns how
 * many were signalled.
 */
export function signalDeclaredSpawns(context: StimContext | undefined, signal: NodeJS.Signals): number {
  let signalled = 0;
  for (const child of operationState(context).running) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    try {
      if (child.kill(signal)) signalled += 1;
    } catch {}
  }
  return signalled;
}
