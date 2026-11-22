import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deleteGcItem } from '../commands/gc/item.ts';
import { collectTrash, deleteTrash } from '../commands/gc/trash.ts';
import { createGcResults } from '../commands/gc/results.ts';
import { pendingItemTrash, stageItemTrash } from '../workspace/item-trash.ts';
import * as temporary from '../temporary.ts';
import { resetExecutor, setExecutor } from '../exec.ts';
import { testContext } from './_context.ts';
import { cacheClaimRoot } from '../cache/cache-claim.ts';
import { releaseClaim, tryAcquireClaim } from '../ownership-claim.ts';

let home: string;
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'stim-lazy-item-')));
  vi.stubEnv('STIM_HOME', home);
  setExecutor({ runFileAsync: async () => '' });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetExecutor();
  rmSync(home, { recursive: true, force: true });
});

function cache(prune = 'entries', entriesDepth = 1) {
  const dir = join(home, 'cache');
  mkdirSync(dir);
  writeFileSync(
    join(home, 'caches.json'),
    JSON.stringify({ version: 1, caches: [{ name: 'fixture', dir, prune, entriesDepth }] }),
  );
  return dir;
}

const output = () => {
  const results = createGcResults();
  return { results, log: () => {}, error: () => {}, fail: () => {}, record: results.record };
};

describe.skipIf(process.platform === 'win32')('same-volume explicit item handoff', () => {
  test('an atomic cache keeps its root and respects a build holding its exterior claim', async () => {
    const dir = cache('atomic');
    writeFileSync(join(dir, 'artifact'), 'cached');
    const claim = tryAcquireClaim({ root: cacheClaimRoot(dir), mode: 'shared', label: 'build' });
    if (!claim.acquired) throw new Error('fixture build did not acquire its claim');
    const staged = vi.fn<() => void>();
    try {
      expect((await deleteGcItem({ kind: 'cache', dir }, testContext(), staged)).results).toMatchObject([
        { status: 'kept' },
      ]);
      expect(readFileSync(join(dir, 'artifact'), 'utf8')).toBe('cached');
      expect(staged).not.toHaveBeenCalled();
    } finally {
      releaseClaim(claim.acquired);
    }
    expect((await deleteGcItem({ kind: 'cache', dir }, testContext(), staged)).results).toMatchObject([
      { status: 'pending' },
    ]);
    expect(existsSync(dir)).toBe(true);
    expect(existsSync(join(dir, 'artifact'))).toBe(false);
    expect(staged).toHaveBeenCalledOnce();
  });
  test('only the selector entries move, and pending bytes become freed bytes only after the drain', async () => {
    const dir = cache('entries', 2);
    mkdirSync(join(dir, 'bucket'));
    writeFileSync(join(dir, 'index'), 'keep index');
    writeFileSync(join(dir, 'bucket', 'old'), 'cached');
    writeFileSync(join(dir, 'bucket', 'future'), 'keep future');
    const future = new Date(Date.now() + 3 * 86_400_000);
    utimesSync(join(dir, 'bucket', 'future'), future, future);
    const staged = vi.fn<() => void>();
    const result = await deleteGcItem({ kind: 'cache', dir }, testContext(), staged);
    expect(result.results).toMatchObject([{ kind: 'cache', status: 'pending', bytes: 6 }]);
    expect(result.results.filter((entry) => entry.status === 'done')).toEqual([]);
    expect(staged).toHaveBeenCalledOnce();
    expect(existsSync(join(dir, 'bucket', 'old'))).toBe(false);
    expect(readFileSync(join(dir, 'index'), 'utf8')).toBe('keep index');
    expect(readFileSync(join(dir, 'bucket', 'future'), 'utf8')).toBe('keep future');
    expect(await pendingItemTrash()).toEqual({ count: 1, bytes: 6 });
    const out = output();
    expect(await deleteTrash(undefined, out, false, true)).toEqual({ count: 1, bytes: 6, failures: 0 });
    expect(out.results.take()).toMatchObject([{ kind: 'trash', status: 'done', bytes: 6 }]);
    expect(await pendingItemTrash()).toEqual({ count: 0, bytes: 0 });
  });

  test.each(['cross-volume', 'unavailable'] as const)(
    '%s staging falls back to the selected in-place delete',
    async (mode) => {
      const dir = cache();
      writeFileSync(join(dir, 'artifact'), 'cached');
      vi.spyOn(temporary, 'filesystemDevice').mockImplementation((path) => {
        if (mode === 'unavailable') throw new Error('device unavailable');
        return path.endsWith('trash') ? 2 : 1;
      });
      const staged = vi.fn<() => void>();
      const result = await deleteGcItem({ kind: 'cache', dir }, testContext(), staged);
      expect(result.results).toMatchObject([{ kind: 'cache', status: 'done', bytes: 6 }]);
      expect(staged).not.toHaveBeenCalled();
      expect(existsSync(dir)).toBe(true);
      expect(existsSync(join(dir, 'artifact'))).toBe(false);
      expect(await pendingItemTrash()).toEqual({ count: 0, bytes: 0 });
    },
  );

  test.each(['entries', 'atomic'])(
    'a %s cancellation after the first handoff leaves recoverable trash and keeps the next entries',
    async (prune) => {
      const dir = cache(prune);
      for (const name of ['one', 'two', 'three']) writeFileSync(join(dir, name), 'cached');
      setExecutor({ runFileAsync: async () => '5\t.' });
      const stop = new AbortController();
      await expect(
        deleteGcItem({ kind: 'cache', dir }, testContext({ signal: stop.signal }), () => stop.abort()),
      ).rejects.toThrow(/abort/i);
      const bytes = prune === 'atomic' ? 1706 : 6;
      expect(await pendingItemTrash()).toEqual({ count: 1, bytes });
      expect(['one', 'two', 'three'].filter((name) => existsSync(join(dir, name)))).toHaveLength(2);
      expect(await deleteTrash(undefined, output(), false, true)).toEqual({ count: 1, bytes, failures: 0 });
      expect(existsSync(dir)).toBe(true);
    },
  );

  test('unrecognized item manifests are kept instead of authorizing deletion', async () => {
    const path = join(home, 'payload');
    writeFileSync(path, 'cached');
    expect(await stageItemTrash(path, 6, { kind: 'cache', id: path })).toBe(true);
    const entry = (await collectTrash({ itemsOnly: true }))?.entries[0];
    if (!entry) throw new Error('the staged entry was not collected');
    writeFileSync(join(entry.path, 'trash.json'), JSON.stringify({ kind: 'gc-item', bytes: 6 }));
    expect(await deleteTrash(undefined, output(), false, true)).toEqual({ count: 0, bytes: 0, failures: 0 });
    expect(existsSync(join(entry.path, 'entries', 'payload'))).toBe(true);
  });
});
