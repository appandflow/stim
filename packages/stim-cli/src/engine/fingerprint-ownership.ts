import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { workspaceName, type StimContext } from '@stim-cli/core';
import { operationState } from './operation-state.ts';
import { NATIVE_RUN_LOCK } from './native-run.ts';
import { declareSpawnsOn, fenceDeclaredSpawns, stopDeclaringSpawnsOn } from './spawn-claims.ts';
import {
  withWorkspaceProcessLock,
  workspaceProcessLockPath,
  WorkspaceProcessCleanupError,
} from './workspace-process-lock.ts';
import { ClaimUnavailableError, releaseClaim, tryAcquireClaim, type ClaimHandle } from '../ownership-claim.ts';
import { ownStoreEngine } from '../daemon/engine-switch.ts';
import { buildClaimRoot } from '../engine-store/claims.ts';
import { takeLock } from '../engine-store/locks.ts';
import { readManifest } from '../engine-store/store.ts';

export async function withFingerprintOwnership<T>(
  context: StimContext,
  root: string,
  work: (claims: ReturnType<typeof fenceDeclaredSpawns>['claims']) => Promise<T>,
  signal: AbortSignal = context.signal,
): Promise<T> {
  const engine = ownStoreEngine();
  const engineRoot = engine && buildClaimRoot(engine.root, engine.build);
  let engineClaim: ClaimHandle | null = null;
  if (engine && engineRoot && ![...operationState(context).declaring].some((claim) => claim.root === engineRoot)) {
    const lock = await takeLock(engine.root, '.lock.sock');
    if (!lock) throw new ClaimUnavailableError('the engine store is busy');
    let admissionFailure: { error: unknown } | null = null;
    try {
      signal.throwIfAborted();
      const tree = join(engine.root, engine.build);
      const manifest = readManifest(tree);
      if (!manifest || manifest.build !== engine.build || !existsSync(join(tree, 'dist', 'cli.mjs')))
        throw new ClaimUnavailableError('the selected engine is unavailable');
      const attempt = tryAcquireClaim({
        root: engineRoot,
        mode: 'shared',
        label: 'fingerprint engine',
        details: { drained: false },
      });
      if (attempt.pending) releaseClaim(attempt.pending);
      if (!attempt.acquired)
        throw new ClaimUnavailableError('the selected engine claim is busy', { claimPath: engineRoot });
      engineClaim = attempt.acquired;
    } catch (error) {
      admissionFailure = { error };
    }
    try {
      await lock.release();
    } catch (error) {
      if (engineClaim && !releaseClaim(engineClaim))
        throw new ClaimUnavailableError('could not release the selected engine claim', {
          claimPath: engineClaim.path,
        });
      engineClaim = null;
      throw error;
    }
    if (admissionFailure) throw admissionFailure.error;
  }
  let retained = false;
  let outcome: { value: T } | { error: unknown };
  try {
    signal.throwIfAborted();
    if (engineClaim) declareSpawnsOn(context, engineClaim);
    outcome = { value: await withWorkspaceOwnership(context, root, work, signal) };
  } catch (error) {
    retained = Boolean(
      engineClaim && error instanceof WorkspaceProcessCleanupError && error.claims.includes(engineClaim),
    );
    outcome = { error };
  }
  if (engineClaim) {
    stopDeclaringSpawnsOn(context, engineClaim);
    if (!retained && !releaseClaim(engineClaim))
      throw new ClaimUnavailableError('could not release the selected engine claim', { claimPath: engineClaim.path });
  }
  if ('error' in outcome) throw outcome.error;
  return outcome.value;
}

async function withWorkspaceOwnership<T>(
  context: StimContext,
  root: string,
  work: (claims: ReturnType<typeof fenceDeclaredSpawns>['claims']) => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  const workspace = join(context.home, 'workspaces', workspaceName(root));
  const nativeRoot = workspaceProcessLockPath(workspace, NATIVE_RUN_LOCK, true);
  const run = async (): Promise<T> => {
    signal.throwIfAborted();
    const fence = fenceDeclaredSpawns(context);
    let failure: unknown;
    try {
      return await work(fence.claims);
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'reportCleanup' in error) failure = error;
      throw error;
    } finally {
      await fence.finish(failure);
    }
  };
  if ([...operationState(context).declaring].some((claim) => claim.root === nativeRoot)) return run();
  return withWorkspaceProcessLock(workspace, NATIVE_RUN_LOCK, run, {
    external: true,
    signal,
    waitMs: 0,
    declareSpawnsFor: context,
    ownerPurpose: 'fingerprint evaluation',
  });
}
