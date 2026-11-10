import type { ChildProcess } from 'node:child_process';
import type { StimContext } from '@stim-cli/core';
import { captureProcessIdentity } from '../process-identity.ts';
import { clearClaimChild, markClaimChildPending, setClaimChild, type ClaimHandle } from '../ownership-claim.ts';
import { operationState } from './operation-state.ts';
import { WorkspaceProcessCleanupError } from './workspace-process-error.ts';

interface PendingFence {
  claim: ClaimHandle;
  fences: number;
  children: Set<Promise<void>>;
  peers: Set<PendingFence>;
  failure: unknown;
  done: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
}

const fences = new Map<string, PendingFence>();
const declaredChildren = new Map<string, Set<Promise<void>>>();
const claimKey = (claim: ClaimHandle) => `${claim.path}\0${claim.claimId}`;

function finishFence(state: PendingFence): void {
  const peers = [...state.peers].filter((peer) => fences.get(claimKey(peer.claim)) === peer);
  if (peers.some((peer) => peer.fences || peer.children.size)) return;
  let failure = peers.find((peer) => peer.failure)?.failure;
  if (!failure) {
    for (const peer of peers) {
      try {
        clearClaimChild(peer.claim);
      } catch (error) {
        failure = new WorkspaceProcessCleanupError(
          peers.map((item) => item.claim),
          'Cannot clear a pending child marker.',
          'Verify that the operation and all descendants have stopped.',
          error instanceof Error ? error : undefined,
        );
        break;
      }
    }
  }
  for (const peer of peers) {
    if (failure) {
      peer.failure ??= failure;
      peer.reject(failure);
    } else {
      fences.delete(claimKey(peer.claim));
      peer.resolve();
    }
  }
}

function followChild(claim: ClaimHandle, settled: Promise<void>): void {
  const key = claimKey(claim);
  let children = declaredChildren.get(key);
  if (!children) declaredChildren.set(key, (children = new Set()));
  children.add(settled);
  const state = fences.get(key);
  for (const peer of state?.peers ?? []) {
    if (fences.get(claimKey(peer.claim)) !== peer || peer.children.has(settled)) continue;
    peer.children.add(settled);
    void settled.then(
      () => {
        peer.children.delete(settled);
        finishFence(peer);
        return undefined;
      },
      (error: unknown) => {
        peer.children.delete(settled);
        peer.failure ??= error;
        finishFence(peer);
        return undefined;
      },
    );
  }
  void settled.then(
    () => {
      children.delete(settled);
      if (!children.size) declaredChildren.delete(key);
      return undefined;
    },
    () => {
      children.delete(settled);
      if (!children.size) declaredChildren.delete(key);
      return undefined;
    },
  );
}

export function claimIsFenced(claim: ClaimHandle): boolean {
  return fences.has(claimKey(claim));
}

export function trackClaimActivity(claim: ClaimHandle): { settle: (error?: unknown) => void } {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const settled = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  followChild(claim, settled);
  return { settle: (error) => (error ? reject(error) : resolve()) };
}

export function fenceDeclaredSpawns(context: StimContext): {
  claims: ClaimHandle[];
  finish: (failure?: unknown) => Promise<void>;
} {
  const claims = [...operationState(context).declaring];
  const states: PendingFence[] = [];
  if (!claims.length)
    throw Object.assign(new Error('No ownership claim protects fingerprint evaluation.'), {
      code: 'STIM_CLAIM_UNAVAILABLE',
      remedy: 'Run stim doctor, then retry after the workspace is available.',
      reportCleanup: true,
    });
  try {
    for (const claim of claims) {
      const key = claimKey(claim);
      let state = fences.get(key);
      if (state?.failure) throw state.failure;
      if (!state) {
        markClaimChildPending(claim);
        let resolve!: () => void;
        let reject!: (error: unknown) => void;
        const done = new Promise<void>((yes, no) => {
          resolve = yes;
          reject = no;
        });
        void done.catch(() => {});
        state = { claim, fences: 0, children: new Set(), peers: new Set(), failure: null, done, resolve, reject };
        state.peers.add(state);
        fences.set(key, state);
      }
      state.fences++;
      states.push(state);
    }
    const peers = new Set(states.flatMap((state) => [...state.peers]));
    for (const state of peers) state.peers = peers;
    const children = new Set(
      [...peers].flatMap((state) =>
        Array.from(state.children).concat(Array.from(declaredChildren.get(claimKey(state.claim)) ?? [])),
      ),
    );
    for (const child of children) followChild(states[0]!.claim, child);
  } catch (error) {
    const failure = Object.assign(
      new WorkspaceProcessCleanupError(
        claims,
        'Cannot establish pending child ownership.',
        'Verify that the operation and all descendants have stopped.',
        error instanceof Error ? error : undefined,
      ),
      { reportCleanup: true },
    );
    for (const state of states) {
      state.failure ??= failure;
      state.fences--;
      finishFence(state);
    }
    throw failure;
  }
  let finished = false;
  return {
    claims,
    finish: async (failure) => {
      if (!finished) {
        finished = true;
        for (const state of states) {
          state.failure ??= failure;
          state.fences--;
          finishFence(state);
        }
      }
      try {
        await Promise.all(states.map((state) => state.done));
      } catch (error) {
        const remedy =
          error && typeof error === 'object' && 'remedy' in error && typeof error.remedy === 'string'
            ? error.remedy
            : 'Verify that the operation and all descendants have stopped.';
        throw Object.assign(
          new WorkspaceProcessCleanupError(
            claims,
            'Cannot verify all declared child cleanup.',
            remedy,
            error instanceof Error ? error : undefined,
          ),
          { reportCleanup: true },
        );
      }
    },
  };
}

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
 * records one child, so declared spawns must not overlap unless protected by a pending fence. `until: 'close'` also holds the declaration
 * while a launcher's child retains its stdio pipes after the launcher exits. A promise holds the declaration until
 * cleanup resolves; a rejection keeps the child record for recovery.
 */
export function spawnDeclared(
  context: StimContext | undefined,
  spawn: () => ChildProcess,
  { until = 'exit' }: { until?: 'exit' | 'close' | Promise<void> } = {},
): ChildProcess {
  const { declaring, running, refusal } = operationState(context);
  if (refusal !== null) throw new Error(refusal);
  const claims = [...declaring];
  if (claims.length === 0) return spawn();
  const forget = () => {
    for (const claim of claims) {
      if (fences.has(claimKey(claim))) continue;
      try {
        clearClaimChild(claim);
      } catch {}
    }
  };
  let child: ChildProcess;
  try {
    for (const claim of claims) if (!fences.has(claimKey(claim))) markClaimChildPending(claim);
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
  const captured = captureProcessIdentity(pid);
  if (captured.ok) {
    for (const claim of claims) {
      if (fences.has(claimKey(claim))) continue;
      try {
        setClaimChild(claim, { pid, processToken: captured.token });
      } catch {}
    }
  }
  const settled = () => {
    running.delete(child);
    forget();
  };
  const completion = typeof until === 'string' ? new Promise<void>((resolve) => child.once(until, resolve)) : until;
  for (const claim of claims) followChild(claim, completion);
  if (typeof until === 'string') child.once(until, settled);
  else void completion.then(settled, () => {});
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
