import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sizeCaches } from '../cache/caches.ts';
import { declareSpawnsOn, stopDeclaringSpawnsOn } from '../engine/spawn-claims.ts';
import { resetExecutor } from '../exec.ts';
import { releaseClaim, tryAcquireClaim } from '../ownership-claim.ts';
import { holdDuUntilOverlapped } from './_du-barrier.ts';
import { testContext } from './_context.ts';
import { makeCacheDescriptor } from './_factories.ts';

let home: string;

beforeEach(() => {
  home = realpathSync.native(mkdtempSync(join(tmpdir(), 'stim-gc-size-scans-')));
  vi.stubEnv('STIM_HOME', home);
  resetExecutor();
});

afterEach(() => {
  resetExecutor();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

describe('sizeCaches', () => {
  const caches = Array.from({ length: 6 }, (_, index) =>
    makeCacheDescriptor({ name: `cache ${index}`, dir: `/cache/c${index}` }),
  );

  test('measures one cache at a time while a claim records the children of the operation', async () => {
    const scans = holdDuUntilOverlapped(2, () => 1, 50);
    const operation = testContext({ home });
    const got = tryAcquireClaim({ root: join(home, 'maintenance.lock'), mode: 'exclusive' });
    if (!got.acquired) throw new Error('claim unavailable');
    declareSpawnsOn(operation, got.acquired);
    try {
      await sizeCaches(caches.slice(0, 3), operation);
    } finally {
      stopDeclaringSpawnsOn(operation, got.acquired);
      releaseClaim(got.acquired);
    }
    expect(scans.peak()).toBe(1);
  });
});
