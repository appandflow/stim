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

  test.each(['external', 'cache', 'shared', 'prepared'] as const)(
    'a ready %s artifact bypasses remaining production',
    async (hit) => {
      const { phases, state } = recipe();
      if (hit === 'external') {
        phases.resolve = async () => ({ kind: 'ready', artifact: 'installable' });
        phases.reuse = async () => unexpected('external artifact materialization');
      } else if (hit === 'cache') {
        phases.resolve = async () => ({ kind: 'cached', artifact: 'cached' });
        phases.reuse = async () => 'installable';
      } else if (hit === 'shared') {
        phases.claim = async () => 'cached';
        phases.reuse = async () => 'installable';
      } else {
        phases.build.placement = {
          select: () => 'worker',
          acquire: async () => unexpected('worker request after a late cache hit'),
        };
        phases.build.revalidate = async () => ({ ready: 'installable' });
        phases.reuse = async () => unexpected('late artifact materialized twice');
      }
      if (hit === 'external' || hit === 'cache') phases.claim = async () => unexpected('claim on a hit');
      if (hit !== 'prepared') phases.build.prepare = async () => unexpected('preparation on a hit');
      phases.build.admit = async () => unexpected('capacity admission on a hit');
      phases.build.compile = async () => unexpected('compilation on a hit');

      expect(await runArtifactLifecycle(phases)).toBe('installable');
      expect(state).toEqual({ claimed: false, stored: null });
    },
  );

  test('replaces an unusable cached artifact with a freshly compiled artifact', async () => {
    const { phases, state } = recipe();
    phases.resolve = async () => ({ kind: 'cached', artifact: 'stale' });
    phases.reuse = async () => null;

    expect(await runArtifactLifecycle(phases)).toBe('source-compiled');
    expect(state.stored).toBe('source-compiled');
  });

  test('changed inputs prevent storage while the compiled artifact can still be prepared for installation', async () => {
    const { phases, state } = recipe();
    phases.build.validate = async () => 'uncacheable';
    phases.build.store = async () => unexpected('storage under invalidated inputs');
    phases.build.finish = async (artifact) => `${artifact}-install-copy`;

    expect(await runArtifactLifecycle(phases)).toBe('source-compiled-install-copy');
    expect(state).toEqual({ claimed: false, stored: null });
  });

  test('failed source preparation releases the producer claim without compiling or publishing', async () => {
    const { phases, state } = recipe();
    const failure = new Error('source preparation failed');
    phases.build.prepare = async () => {
      throw failure;
    };
    phases.build.compile = async () => unexpected('compile after failed preparation');

    await expect(runArtifactLifecycle(phases)).rejects.toBe(failure);
    expect(state).toEqual({ claimed: false, stored: null });
  });
});
