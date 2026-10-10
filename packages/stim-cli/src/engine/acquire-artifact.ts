import { rmSync } from 'node:fs';
import { runArtifactLifecycle, type ArtifactLifecycle } from './artifact-lifecycle.ts';
import {
  waitForSharedBuild,
  type acquireBuildLock,
  type BuildLockHandle,
  type releaseBuildLock,
  type waitForBuild,
} from './build-lock.ts';
import type { acquireBuildSlot, BuildSlotHandle, releaseBuildSlot } from './build-slots.ts';
import { createCleanupScope } from './cleanup-scope.ts';

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
}

export interface ArtifactRequest {
  root: string;
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

export async function acquireArtifact<Artifact, Preparation, Placement, Failure>(
  adapter: ArtifactAdapter<Artifact, Preparation, Placement, Failure>,
  { root, logFile, deps }: ArtifactRequest,
): Promise<AcquiredArtifact<Artifact, Failure>> {
  const owned = createCleanupScope((error) => adapter.temporaryReleaseFailed(error));
  let closeOffload: (() => void) | null = null;
  let buildLock: BuildLockHandle | null = null;
  let buildSlot: BuildSlotHandle | null = null;

  const releaseLock = () => {
    if (!buildLock) return;
    const held = buildLock;
    buildLock = null;
    try {
      deps.releaseBuildLock(held);
    } catch (error) {
      adapter.releaseFailed(`the build lock at ${held.path}`, error);
    }
  };
  const releaseSlot = () => {
    if (!buildSlot) return;
    const held = buildSlot;
    buildSlot = null;
    try {
      deps.releaseBuildSlot(held);
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

  try {
    const artifact = await runArtifactLifecycle({
      ...adapter.lifecycle(run),
      release: () => {
        const close = closeOffload;
        closeOffload = null;
        try {
          close?.();
        } finally {
          releaseLock();
          releaseSlot();
        }
      },
    });
    return { ok: true, artifact, release: owned.transfer() };
  } catch (error) {
    const failure = adapter.refuse(error);
    if (failure === null) throw error;
    return { ok: false, failure };
  } finally {
    owned.release();
  }
}
