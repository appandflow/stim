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
