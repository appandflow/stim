import { rmSync } from 'node:fs';
import type { StimContext } from '@stim-cli/core';
import { runArtifactLifecycle, type ArtifactLifecycle } from './artifact-lifecycle.ts';
import {
  waitForSharedBuild,
  type acquireBuildLock,
  type BuildLockHandle,
  type releaseBuildLock,
  type waitForBuild,
} from './build-lock.ts';
import type { acquireBuildSlot, BuildSlotHandle, releaseBuildSlot } from './build-slots.ts';
import { createBuildHeadroom } from './build-headroom-run.ts';
import { createCleanupScope } from './cleanup-scope.ts';
import { WorkspaceProcessCleanupError } from './workspace-process-lock.ts';

type SharedBuildOptions = Parameters<typeof waitForSharedBuild>[0];
type BuildSlotOptions = Parameters<typeof acquireBuildSlot>[0];

/** What the driver holds for one acquisition: temporary copies, the build lock, the build slot and an open offload. */
export interface ArtifactRun {
  /**
   * Removes the directory when acquisition fails, or when the caller releases a successful artifact.
   * Returns a function that gives up ownership without removing it.
   */
  own(directory: string): () => void;
  /** Closes the offload connection when acquisition ends. */
  openOffload(close: () => void): void;
  claimSharedBuild(
    options: Pick<SharedBuildOptions, 'key' | 'fingerprint' | 'phase' | 'waitingOn' | 'warn' | 'out'>,
  ): ReturnType<typeof waitForSharedBuild>;
  takeBuildSlot(options: Omit<BuildSlotOptions, 'root' | 'logFile'>): Promise<BuildSlotHandle>;
}

export interface ArtifactAdapter<Artifact, Preparation, Placement, Failure> {
  platform: 'ios' | 'android';
  command: string;
  lifecycle(run: ArtifactRun): Omit<ArtifactLifecycle<Artifact, Preparation, Placement>, 'release'>;
  /** Maps an expected refusal to the platform failure; null rethrows the error. */
  refuse(error: unknown): Failure | null;
  releaseFailed(subject: string, error: unknown): void;
  temporaryReleaseFailed(error: unknown): void;
  /** Settles cache work that still reads owned temporary copies after acquisition fails. */
  settleFailed?(): Promise<void>;
  settleBeforeRelease?(): Promise<void>;
}

export interface ArtifactRequest {
  root: string;
  /** The run's context; without it the local compile gets no disk headroom check and no size measurement. */
  context?: StimContext;
  logFile: string;
  deps: {
    acquireBuildLock: typeof acquireBuildLock;
    releaseBuildLock: typeof releaseBuildLock;
    waitForBuild: typeof waitForBuild;
    acquireBuildSlot: typeof acquireBuildSlot;
    releaseBuildSlot: typeof releaseBuildSlot;
    now: () => number;
  };
}

export type AcquiredArtifact<Artifact, Failure> =
  | { ok: true; artifact: Artifact; release: () => void }
  | { ok: false; failure: Failure };

export function unresolvedCleanup(error: unknown): boolean {
  return (
    error instanceof WorkspaceProcessCleanupError ||
    (typeof error === 'object' && error !== null && 'reportCleanup' in error)
  );
}

export function artifactErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

/** Waits for upload readers; unresolved child cleanup refuses deletion of their temporary inputs. */
export async function settleArtifactUploads(...uploads: readonly (Promise<unknown> | null)[]): Promise<void> {
  const results = await Promise.allSettled(uploads);
  const unresolved = results.find((result) => result.status === 'rejected' && unresolvedCleanup(result.reason));
  if (unresolved?.status === 'rejected') throw unresolved.reason;
}

export async function settleArtifactCleanup(
  failure: unknown,
  ...work: readonly (Promise<unknown> | void)[]
): Promise<void> {
  const results = await Promise.allSettled(work);
  const errors = results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
  if (!errors.length) return;
  if (unresolvedCleanup(failure)) throw failure;
  throw errors.find(unresolvedCleanup) ?? errors[0];
}

export async function acquireArtifact<Artifact, Preparation, Placement, Failure>(
  adapter: ArtifactAdapter<Artifact, Preparation, Placement, Failure>,
  { root, logFile, deps, context }: ArtifactRequest,
): Promise<AcquiredArtifact<Artifact, Failure>> {
  const owned = createCleanupScope((error) => adapter.temporaryReleaseFailed(error));
  let closeOffload: (() => void) | null = null;
  let buildLock: BuildLockHandle | null = null;
  let buildSlot: BuildSlotHandle | null = null;

  const releaseLock = (retain = false) => {
    if (!buildLock) return;
    const held = buildLock;
    buildLock = null;
    try {
      deps.releaseBuildLock(held, retain);
    } catch (error) {
      adapter.releaseFailed(`the build lock at ${held.path}`, error);
    }
  };
  const releaseSlot = (retain = false) => {
    if (!buildSlot) return;
    const held = buildSlot;
    buildSlot = null;
    try {
      deps.releaseBuildSlot(held, retain);
    } catch (error) {
      adapter.releaseFailed('the build slot', error);
    }
  };

  const run: ArtifactRun = {
    own: (directory) => owned.defer(() => rmSync(directory, { recursive: true, force: true })),
    openOffload: (close) => {
      closeOffload = close;
    },
    claimSharedBuild: async (options) => {
      const shared = await waitForSharedBuild({
        ...options,
        platform: adapter.platform,
        root,
        logFile,
        command: adapter.command,
        acquire: deps.acquireBuildLock,
        wait: deps.waitForBuild,
        now: deps.now,
      });
      if (!shared.refusal) buildLock = shared.lock;
      return shared;
    },
    takeBuildSlot: async (options) => {
      buildSlot = await deps.acquireBuildSlot({ ...options, root, logFile });
      return buildSlot;
    },
  };

  const headroom = context ? createBuildHeadroom({ root, platform: adapter.platform, context }) : null;
  try {
    const lifecycle = adapter.lifecycle(run);
    const artifact = await runArtifactLifecycle({
      ...lifecycle,
      build: {
        ...lifecycle.build,
        compile: async (placement, preparation) => {
          await headroom?.begin();
          const compiled = await lifecycle.build.compile(placement, preparation);
          await headroom?.finish();
          return compiled;
        },
      },
      release: async (failure) => {
        let cleanupError: unknown;
        try {
          if (failure !== undefined) await adapter.settleFailed?.();
          else if (buildLock?.claim || buildSlot?.claim) await adapter.settleBeforeRelease?.();
        } catch (error) {
          cleanupError = error;
        }
        const unresolved = unresolvedCleanup(failure) ? failure : cleanupError;
        const close = closeOffload;
        closeOffload = null;
        if (unresolvedCleanup(unresolved)) {
          try {
            close?.();
          } catch {}
          const retained = (claim: BuildLockHandle['claim']) =>
            claim &&
            [failure, cleanupError].some(
              (error) =>
                unresolvedCleanup(error) &&
                (!(error instanceof WorkspaceProcessCleanupError) ||
                  error.claims.some((held) => held.path === claim.path && held.claimId === claim.claimId)),
            );
          try {
            releaseLock(Boolean(retained(buildLock?.claim)));
          } catch {}
          try {
            releaseSlot(Boolean(retained(buildSlot?.claim)));
          } catch {}
          if (cleanupError !== undefined && !unresolvedCleanup(failure)) throw cleanupError;
          return;
        }
        try {
          close?.();
        } finally {
          releaseLock();
          releaseSlot();
        }
        if (cleanupError !== undefined) throw cleanupError;
      },
    });
    return { ok: true, artifact, release: owned.transfer() };
  } catch (error) {
    if (unresolvedCleanup(error)) {
      owned.transfer();
      throw error;
    }
    const failure = adapter.refuse(error);
    if (failure === null) throw error;
    return { ok: false, failure };
  } finally {
    owned.release();
  }
}
