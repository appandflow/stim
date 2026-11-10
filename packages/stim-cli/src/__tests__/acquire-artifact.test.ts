import assert from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireArtifact,
  settleArtifactUploads,
  type ArtifactAdapter,
  type ArtifactRequest,
} from '../engine/acquire-artifact.ts';
import { WorkspaceProcessCleanupError } from '../engine/workspace-process-lock.ts';
import { withAmbientContext } from '@stim-cli/core';
import { acquireBuildLock, releaseBuildLock, waitForBuild } from '../engine/build-lock.ts';
import { acquireBuildSlot, releaseBuildSlot } from '../engine/build-slots.ts';
import { markClaimChildPending, readClaimSet, releaseClaim, type ClaimHandle } from '../ownership-claim.ts';
import { operationState } from '../engine/operation-state.ts';
import { testContext } from './_context.ts';

class Refusal extends Error {}

let scratch: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'stim-acquire-artifact-'));
});
afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function staged(name: string): string {
  const directory = join(scratch, name);
  mkdirSync(directory);
  return directory;
}

function fixture(compile: (stage: (name: string) => string) => Promise<string>) {
  const held = { lock: false, slot: false, offload: false };
  const taken: string[] = [];
  const request: ArtifactRequest = {
    root: scratch,
    logFile: join(scratch, 'build.log'),
    deps: {
      acquireBuildLock: () => {
        held.lock = true;
        taken.push('lock');
        return { acquired: true, path: join(scratch, 'lock') };
      },
      releaseBuildLock: () => {
        held.lock = false;
        return true;
      },
      waitForBuild: async () => ({}),
      acquireBuildSlot: async () => {
        held.slot = true;
        taken.push('slot');
        return { acquired: true };
      },
      releaseBuildSlot: () => {
        held.slot = false;
        return true;
      },
      now: () => 0,
    },
  };
  const adapter: ArtifactAdapter<string, null, null, string> = {
    platform: 'ios',
    command: 'stim ios',
    lifecycle: (run) => ({
      resolve: async () => ({ kind: 'miss' }),
      claim: async () => {
        await run.claimSharedBuild({
          key: 'key',
          fingerprint: 'fingerprint',
          phase: () => {},
          waitingOn: () => {},
          warn: () => {},
          out: () => {},
        });
        return 'stale';
      },
      reuse: async () => {
        run.own(staged('reuse-copy'));
        return null;
      },
      build: {
        placement: {
          select: () => {
            held.offload = true;
            taken.push('offload');
            run.openOffload(() => {
              held.offload = false;
            });
            return null;
          },
          acquire: async () => null,
        },
        admit: async () => {
          await run.takeBuildSlot({ max: 1 });
        },
        prepare: async () => null,
        revalidate: async () => null,
        compile: () =>
          compile((name) => {
            const directory = staged(name);
            run.own(directory);
            return directory;
          }),
        validate: async () => 'uncacheable',
        store: async () => {},
      },
    }),
    refuse: (error) => (error instanceof Refusal ? error.message : null),
    releaseFailed: () => {},
    temporaryReleaseFailed: () => {},
  };
  return { held, taken, adapter, request, run: () => acquireArtifact(adapter, request) };
}

test.each(['plain', 'class'] as const)('preserves a %s cleanup refusal when release diagnostics fail', async (kind) => {
  const failure =
    kind === 'plain'
      ? { code: 'STIM_CLAIM_UNAVAILABLE', reportCleanup: true, message: 'unverified cleanup' }
      : new WorkspaceProcessCleanupError([], 'Worker cleanup is unresolved', 'Verify its child');
  const fixtureRun = fixture(async (stage) => {
    writeFileSync(join(stage('upload-source'), 'value'), 'built app');
    throw failure;
  });
  const releaseLock = vi.fn<() => never>(() => {
    throw new Error('lock release failed');
  });
  const releaseSlot = vi.fn<() => boolean>(() => true);
  const diagnostic = vi.fn<() => never>(() => {
    throw new Error('release diagnostic failed');
  });
  fixtureRun.request.deps.releaseBuildLock = releaseLock;
  fixtureRun.request.deps.releaseBuildSlot = releaseSlot;
  fixtureRun.adapter.releaseFailed = diagnostic;
  const refuse = vi.spyOn(fixtureRun.adapter, 'refuse');

  await expect(fixtureRun.run()).rejects.toBe(failure);
  expect(releaseLock).toHaveBeenCalledOnce();
  expect(releaseSlot).toHaveBeenCalledOnce();
  expect(diagnostic).toHaveBeenCalledOnce();
  expect(refuse).not.toHaveBeenCalled();
  expect(await readFile(join(scratch, 'upload-source', 'value'), 'utf8')).toBe('built app');
});

test.each(['both', 'lock', 'slot', 'plain', 'clean', 'independent'] as const)(
  'real build claims retain only unresolved %s ownership',
  async (coverage) => {
    const context = testContext({ home: scratch, projectRoot: scratch, cwd: scratch });
    let lock: ClaimHandle | undefined;
    let slot: ClaimHandle | undefined;
    let original: WorkspaceProcessCleanupError | undefined;
    const fixtureRun = fixture(async () => {
      if (!lock || !slot) throw new Error('The real claims were not acquired.');
      const claims =
        coverage === 'both'
          ? [lock, slot]
          : coverage === 'lock' || coverage === 'independent'
            ? [lock]
            : coverage === 'slot'
              ? [slot]
              : [];
      for (const claim of coverage === 'plain' || coverage === 'independent' ? [lock, slot] : claims)
        markClaimChildPending(claim);
      if (coverage === 'clean') throw new Error('ordinary failure');
      if (coverage === 'plain') throw { reportCleanup: true, message: 'unknown cleanup' };
      original = new WorkspaceProcessCleanupError(claims, 'Worker cleanup is unresolved', 'Verify its child');
      throw original;
    });
    fixtureRun.request.deps = {
      acquireBuildLock: (options) => {
        const result = acquireBuildLock(options);
        lock = result.claim;
        return result;
      },
      releaseBuildLock,
      waitForBuild,
      acquireBuildSlot: async (options) => {
        const result = await acquireBuildSlot({ ...options, engine: null });
        slot = result.claim;
        return result;
      },
      releaseBuildSlot,
      now: Date.now,
    };
    let heldAtSettlement = false;
    fixtureRun.adapter.settleFailed = async () => {
      if (!lock || !slot) throw new Error('The real claims were not acquired.');
      heldAtSettlement = readClaimSet(lock.root).live.length > 0 && readClaimSet(slot.root).live.length > 0;
      if (coverage === 'independent')
        throw new WorkspaceProcessCleanupError([slot], 'Upload cleanup unresolved', 'Inspect.');
    };
    try {
      const failure = await withAmbientContext(context, () => fixtureRun.run()).catch((error: unknown) => error);
      expect(failure).toBeDefined();
      expect(failure).toBe(original ?? failure);
      expect(heldAtSettlement).toBe(true);
      if (!lock || !slot) throw new Error('The real claims were not acquired.');
      const expectLock =
        coverage === 'both' || coverage === 'lock' || coverage === 'plain' || coverage === 'independent';
      const expectSlot =
        coverage === 'both' || coverage === 'slot' || coverage === 'plain' || coverage === 'independent';
      expect(readClaimSet(lock.root).live.some((claim) => claim.claimId === lock?.claimId)).toBe(expectLock);
      expect(readClaimSet(slot.root).live.some((claim) => claim.claimId === slot?.claimId)).toBe(expectSlot);
      expect(readClaimSet(lock.root).live.some((claim) => claim.claimId === lock?.claimId && claim.childDeclared)).toBe(
        expectLock,
      );
      expect(readClaimSet(slot.root).live.some((claim) => claim.claimId === slot?.claimId && claim.childDeclared)).toBe(
        expectSlot,
      );
      expect(operationState(context).declaring.size).toBe(0);
    } finally {
      if (lock) releaseClaim(lock);
      if (slot) releaseClaim(slot);
    }
  },
);

test.each(['ios', 'android'] as const)(
  '%s joins successful verification before releasing real build claims',
  async (platform) => {
    const context = testContext({ home: scratch, projectRoot: scratch, cwd: scratch });
    let lock: ClaimHandle | undefined;
    let slot: ClaimHandle | undefined;
    let finish!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const verification = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const fixtureRun = fixture(async (stage) => stage('success'));
    fixtureRun.adapter.platform = platform;
    fixtureRun.request.deps = {
      acquireBuildLock: (options) => {
        const result = acquireBuildLock(options);
        lock = result.claim;
        return result;
      },
      releaseBuildLock,
      waitForBuild,
      acquireBuildSlot: async (options) => {
        const result = await acquireBuildSlot({ ...options, engine: null });
        slot = result.claim;
        return result;
      },
      releaseBuildSlot,
      now: Date.now,
    };
    fixtureRun.adapter.settleBeforeRelease = async () => {
      entered();
      await verification;
    };
    const pending = withAmbientContext(context, () => fixtureRun.run());
    try {
      await started;
      assert(lock);
      assert(slot);
      expect(readClaimSet(lock.root).live.some((claim) => claim.claimId === lock?.claimId)).toBe(true);
      expect(readClaimSet(slot.root).live.some((claim) => claim.claimId === slot?.claimId)).toBe(true);
      finish();
      const result = await pending;
      expect(result.ok).toBe(true);
      if (result.ok) result.release();
      expect(readClaimSet(lock.root).live.some((claim) => claim.claimId === lock?.claimId)).toBe(false);
      expect(readClaimSet(slot.root).live.some((claim) => claim.claimId === slot?.claimId)).toBe(false);
    } finally {
      finish();
      await pending.catch(() => {});
      if (lock) releaseClaim(lock);
      if (slot) releaseClaim(slot);
    }
  },
);

test.each(['acquisition', 'pending upload'])('unresolved %s cleanup preserves staged bytes', async (phase) => {
  const failure = new WorkspaceProcessCleanupError([], 'Worker cleanup is unresolved', 'Verify its child');
  const fixtureRun = fixture(async (stage) => {
    writeFileSync(join(stage('upload-source'), 'value'), 'built app');
    throw phase === 'acquisition' ? failure : new Refusal('install cancelled');
  });
  if (phase === 'pending upload')
    fixtureRun.adapter.settleFailed = async () => {
      await settleArtifactUploads(Promise.reject(failure));
    };
  await expect(fixtureRun.run()).rejects.toBe(failure);
  expect(await readFile(join(scratch, 'upload-source', 'value'), 'utf8')).toBe('built app');
});

test('joins failed acquisition cleanup before releasing build ownership', async () => {
  const fixtureRun = fixture(async () => {
    throw new Error('acquisition failed');
  });
  let finish!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  fixtureRun.adapter.settleFailed = () =>
    new Promise<void>((resolve) => {
      finish = resolve;
      entered();
    });
  const result = fixtureRun.run();
  const settled = result.catch((error: unknown) => error);
  await started;
  expect(fixtureRun.held.lock).toBe(true);
  expect(fixtureRun.held.slot).toBe(true);
  finish();
  expect(await settled).toMatchObject({ message: 'acquisition failed' });
  expect(fixtureRun.held.lock).toBe(false);
  expect(fixtureRun.held.slot).toBe(false);
});

test.each(['plain', 'class'] as const)(
  'keeps the first %s cleanup refusal after a second upload refusal',
  async (kind) => {
    const first =
      kind === 'plain'
        ? { code: 'STIM_CLAIM_UNAVAILABLE', reportCleanup: true, message: 'first unverified cleanup' }
        : new WorkspaceProcessCleanupError([], 'First cleanup is unresolved', 'Verify its child');
    const second = new WorkspaceProcessCleanupError([], 'Upload cleanup is unresolved', 'Verify its child');
    const fixtureRun = fixture(async (stage) => {
      writeFileSync(join(stage('upload-source'), 'value'), 'built app');
      throw first;
    });
    const settled = vi.fn<() => Promise<void>>(async () => settleArtifactUploads(Promise.reject(second)));
    fixtureRun.adapter.settleFailed = settled;
    await expect(fixtureRun.run()).rejects.toBe(first);
    expect(settled).toHaveBeenCalledOnce();
    expect(await readFile(join(scratch, 'upload-source', 'value'), 'utf8')).toBe('built app');
  },
);
