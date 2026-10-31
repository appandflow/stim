import { describe, expect, test } from 'vitest';
import { runArtifactLifecycle, type ArtifactLifecycle } from '../engine/artifact-lifecycle.ts';

function unexpected(operation: string): never {
  throw new Error(`Unexpected ${operation}`);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function recipe() {
  const state = { claimed: false, stored: null as string | null };
  const phases: ArtifactLifecycle<string, string, string> = {
    resolve: async () => ({ kind: 'miss' }),
    claim: async () => {
      state.claimed = true;
      return null;
    },
    reuse: async (artifact) => artifact,
    build: {
      admit: async () => {},
      prepare: async () => 'source',
      revalidate: async () => null,
      compile: async (_placement, source) => `${source}-compiled`,
      validate: async () => 'cacheable',
      store: async (artifact) => {
        state.stored = artifact;
      },
    },
    release: () => {
      state.claimed = false;
    },
  };
  return { phases, state };
}

describe('artifact lifecycle', () => {
  test('retains the producer claim until input validation and artifact storage finish', async () => {
    const { phases, state } = recipe();
    const validating = deferred<void>();
    const validated = deferred<'cacheable'>();
    const storing = deferred<void>();
    const stored = deferred<void>();
    phases.build.validate = async () => {
      validating.resolve();
      return validated.promise;
    };
    phases.build.store = async (artifact) => {
      storing.resolve();
      await stored.promise;
      state.stored = artifact;
    };

    const run = runArtifactLifecycle(phases);
    await validating.promise;
    expect(state).toEqual({ claimed: true, stored: null });
    validated.resolve('cacheable');
    await storing.promise;
    expect(state).toEqual({ claimed: true, stored: null });
    stored.resolve();
    expect(await run).toBe('source-compiled');
    expect(state).toEqual({ claimed: false, stored: 'source-compiled' });
  });

  test.each(['placement', 'preparation'])(
    'failed %s releases the producer claim without compiling or publishing',
    async (phase) => {
      const { phases, state } = recipe();
      const failure = new Error('source preparation failed');
      const fail = async () => {
        throw failure;
      };
      if (phase === 'placement') {
        phases.build.placement = { select: fail, acquire: async () => unexpected('upload after failed selection') };
        phases.build.prepare = async () => unexpected('preparation after failed selection');
      } else phases.build.prepare = fail;
      phases.build.compile = async () => unexpected('compile after failed preparation');

      await expect(runArtifactLifecycle(phases)).rejects.toBe(failure);
      expect(state).toEqual({ claimed: false, stored: null });
    },
  );
});
