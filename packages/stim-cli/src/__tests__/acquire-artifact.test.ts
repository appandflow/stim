import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import assert from 'node:assert';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireArtifact, type ArtifactAdapter, type ArtifactRequest } from '../engine/acquire-artifact.ts';
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
  return { held, taken, adapter, run: () => acquireArtifact(adapter, request) };
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

test('failed acquisition keeps temporary bytes until pending cache readers settle', async () => {
  let allowRead = () => {};
  let notifyWaiting = () => {};
  const mayRead = new Promise<void>((resolve) => {
    allowRead = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    notifyWaiting = resolve;
  });
  let readBytes: Promise<string> | undefined;
  const fixtureRun = fixture(async (stage) => {
    const path = join(stage('upload-source'), 'value');
    writeFileSync(path, 'built app');
    readBytes = mayRead.then(() => readFile(path, 'utf8'));
    throw new Refusal('cancelled');
  });
  fixtureRun.adapter.settleFailed = async () => {
    notifyWaiting();
    await readBytes;
  };
  const pending = fixtureRun.run();
  try {
    await waiting;
    expect(fixtureRun.held).toEqual({ lock: false, slot: false, offload: false });
    expect(existsSync(join(scratch, 'upload-source'))).toBe(true);
    allowRead();
    expect(await pending).toEqual({ ok: false, failure: 'cancelled' });
    expect(await readBytes).toBe('built app');
    expect(existsSync(join(scratch, 'upload-source'))).toBe(false);
  } finally {
    allowRead();
    await pending;
  }
});
