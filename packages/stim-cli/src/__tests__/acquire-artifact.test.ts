import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import assert from 'node:assert';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireArtifact, type ArtifactAdapter, type ArtifactRequest } from '../engine/acquire-artifact.ts';
import type { BuildLockHandle } from '../engine/build-lock.ts';
import { createCleanupScope } from '../engine/cleanup-scope.ts';

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
        return { acquired: true, path: join(scratch, 'lock') } as BuildLockHandle;
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
  return { held, taken, run: () => acquireArtifact(adapter, request) };
}

describe('acquireArtifact', () => {
  test.each([
    ['a refusal', new Refusal('compiler refused'), { ok: false, failure: 'compiler refused' }],
    ['an error', new Error('compiler crashed'), new Error('compiler crashed')],
  ] as const)(
    '%s after staging removes every owned copy and releases what the run held',
    async (_outcome, thrown, expected) => {
      const { held, taken, run } = fixture(async (stage) => {
        stage('install-copy');
        throw thrown;
      });
      expect(await run().catch((error: unknown) => error)).toEqual(expected);
      expect(existsSync(join(scratch, 'reuse-copy'))).toBe(false);
      expect(existsSync(join(scratch, 'install-copy'))).toBe(false);
      expect(taken).toEqual(['lock', 'offload', 'slot']);
      expect(held).toEqual({ lock: false, slot: false, offload: false });
    },
  );

  test('a successful acquisition hands its owned copies to the caller', async () => {
    const { held, taken, run } = fixture(async (stage) => join(stage('install-copy'), 'App.app'));
    const acquired = await run();
    assert(acquired.ok);
    expect(acquired.artifact).toBe(join(scratch, 'install-copy', 'App.app'));
    expect(taken).toEqual(['lock', 'offload', 'slot']);
    expect(held).toEqual({ lock: false, slot: false, offload: false });
    expect(existsSync(join(scratch, 'reuse-copy'))).toBe(true);
    expect(existsSync(join(scratch, 'install-copy'))).toBe(true);
    acquired.release();
    acquired.release();
    expect(existsSync(join(scratch, 'reuse-copy'))).toBe(false);
    expect(existsSync(join(scratch, 'install-copy'))).toBe(false);
  });
});

test('a cleanup that throws is reported and retried on the next release', () => {
  const reported: unknown[] = [];
  const scope = createCleanupScope((error) => reported.push(error));
  let attempts = 0;
  scope.defer(() => {
    attempts++;
    if (attempts === 1) throw new Error('busy');
  });
  scope.release();
  expect(reported).toEqual([new Error('busy')]);
  scope.release();
  scope.release();
  expect(attempts).toBe(2);
  expect(reported).toHaveLength(1);
});
