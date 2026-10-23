import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { sizeCaches } from '../cache/caches.ts';
import { collectOrphanedWorkspaces, collectWorkspaceOutputs } from '../commands/gc/workspaces.ts';
import { declareSpawnsOn, stopDeclaringSpawnsOn } from '../engine/spawn-claims.ts';
import { resetExecutor } from '../exec.ts';
import { volumeRootFor } from '../fs-util.ts';
import { releaseClaim, tryAcquireClaim } from '../ownership-claim.ts';
import { ensureWorkspaceStorage } from '../workspace/paths.ts';
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

const kilobytes = (dir: string) => 1 + (Number(/(\d+)$/.exec(basename(dir))?.[1]) || 0);

describe('sizeCaches', () => {
  const caches = Array.from({ length: 6 }, (_, index) =>
    makeCacheDescriptor({ name: `cache ${index}`, dir: `/cache/c${index}` }),
  );

  test('measures at most four caches at the same time and keeps the descriptor order', async () => {
    const scans = holdDuUntilOverlapped(4, kilobytes);
    const sized = await sizeCaches(caches, testContext({ home }));
    expect(scans.peak()).toBe(4);
    expect(sized.map(({ name, bytes }) => ({ name, bytes }))).toEqual(
      caches.map(({ name }, index) => ({ name, bytes: (index + 1) * 1024 })),
    );
  });

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

describe('workspace sizes', () => {
  function workspace(name: string, outputs: string[]): string {
    const projectRoot = join(home, 'projects', name);
    const dir = ensureWorkspaceStorage(projectRoot);
    writeFileSync(join(dir, 'state.json'), '{}');
    for (const output of outputs) mkdirSync(join(dir, output), { recursive: true });
    return dir;
  }

  test('orphaned workspaces are measured at the same time and keep their own sizes', async () => {
    const dirs = [workspace('gone1', []), workspace('gone2', []), workspace('gone3', [])];
    const scans = holdDuUntilOverlapped(3, (dir) => 10 * (dirs.indexOf(dir) + 1));
    const { orphaned } = await collectOrphanedWorkspaces([], [volumeRootFor(home)], {
      operation: testContext({ home }),
    });
    expect(scans.peak()).toBe(3);
    expect(orphaned.map(({ dir, bytes }) => [dir, bytes]).toSorted()).toEqual(
      dirs.map((dir, index) => [dir, 10 * (index + 1) * 1024]),
    );
  });

  test('the output directories of every workspace are measured at the same time and summed per workspace', async () => {
    const a = workspace('a', ['derived-data', 'gradle-build']);
    const b = workspace('b', ['derived-data']);
    const c = workspace('c', ['android-cas', 'cache-provider']);
    const sizes = new Map([
      [join(a, 'derived-data'), 1],
      [join(a, 'gradle-build'), 2],
      [join(b, 'derived-data'), 4],
      [join(c, 'android-cas'), 8],
      [join(c, 'cache-provider'), 16],
    ]);
    const scans = holdDuUntilOverlapped(4, (dir) => sizes.get(dir) ?? 0);
    const report = await collectWorkspaceOutputs({
      olderThan: null,
      now: Date.now(),
      operation: testContext({ home }),
      signal: new AbortController().signal,
    });
    expect(scans.started()).toBe(5);
    expect(scans.peak()).toBe(4);
    expect(new Map(report.workspaces.map(({ dir, bytes }) => [dir, bytes]))).toEqual(
      new Map([
        [a, 3 * 1024],
        [b, 4 * 1024],
        [c, 24 * 1024],
      ]),
    );
  });
});
