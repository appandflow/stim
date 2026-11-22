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
import { LADDER, TRASH, requestGcItem } from '../daemon/disk-owner.ts';

let home: string;
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'stim-lazy-item-')));
  vi.stubEnv('STIM_HOME', home);
  setExecutor({ runFileAsync: async () => '1\t.' });
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
  test('a Metro-style transform file cache creates no trash entries or remover processes', async () => {
    const dir = cache('entries', 2);
    for (let bucket = 0; bucket < 16; bucket++) {
      const path = join(dir, String(bucket));
      mkdirSync(path);
      for (let file = 0; file < 64; file++) writeFileSync(join(path, String(file)), 'cached');
    }
    const native = vi.fn<() => Promise<string>>().mockResolvedValue('1\t.');
    setExecutor({ runFileAsync: native });
    const staged = vi.fn<() => void>();
    const result = await deleteGcItem({ kind: 'cache', dir }, testContext(), staged);
    expect(result.results).toMatchObject([{ status: 'done', bytes: 6144 }]);
    expect(staged).not.toHaveBeenCalled();
    expect(await pendingItemTrash()).toEqual({ count: 0, bytes: 0 });
    expect(native.mock.calls.flat()).not.toContain('rm');
    expect(existsSync(join(dir, '0', '0'))).toBe(false);
    expect(existsSync(join(dir, '15', '63'))).toBe(false);
  });

  test('a resumed drain does not recreate or credit an entry a pressure pass already removed', async () => {
    for (const [name, bytes] of [
      ['one', 7],
      ['two', 11],
    ] as const) {
      const path = join(home, name);
      mkdirSync(path);
      writeFileSync(join(path, 'data'), 'cached');
      expect(await stageItemTrash(path, bytes, { kind: 'cache', id: path })).toBe(true);
    }
    const paths = (await collectTrash({ itemsOnly: true }))?.entries.map((entry) => entry.path) ?? [];
    const state: { pressure?: Promise<{ count: number; bytes: number; failures: number }> } = {};
    const drain = requestGcItem(
      (signal, between) =>
        deleteTrash(testContext({ signal }), output(), false, true, async () => {
          state.pressure ??= requestGcItem(
            (pressureSignal) => deleteTrash(testContext({ signal: pressureSignal }), output(), false, true),
            LADDER,
          ).result;
          await between();
        }),
      TRASH,
    );
    const first = await drain.result;
    const second = await state.pressure;
    expect(first.count).toBe(1);
    expect(second?.count).toBe(1);
    expect(first.bytes + (second?.bytes ?? 0)).toBe(18);
    expect(paths.every((path) => !existsSync(path))).toBe(true);
    expect(await pendingItemTrash()).toEqual({ count: 0, bytes: 0 });
  });
  test('an atomic cache keeps its root and respects a build holding its exterior claim', async () => {
    const dir = cache('atomic');
    mkdirSync(join(dir, 'artifact'));
    writeFileSync(join(dir, 'artifact', 'data'), 'cached');
    const claim = tryAcquireClaim({ root: cacheClaimRoot(dir), mode: 'shared', label: 'build' });
    if (!claim.acquired) throw new Error('fixture build did not acquire its claim');
    const staged = vi.fn<() => void>();
    try {
      expect((await deleteGcItem({ kind: 'cache', dir }, testContext(), staged)).results).toMatchObject([
        { status: 'kept' },
      ]);
      expect(readFileSync(join(dir, 'artifact', 'data'), 'utf8')).toBe('cached');
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
    mkdirSync(join(dir, 'bucket', 'old'));
    writeFileSync(join(dir, 'bucket', 'old', 'data'), 'cached');
    mkdirSync(join(dir, 'bucket', 'future'));
    writeFileSync(join(dir, 'bucket', 'future', 'data'), 'keep future');
    const future = new Date(Date.now() + 3 * 86_400_000);
    utimesSync(join(dir, 'bucket', 'future'), future, future);
    const staged = vi.fn<() => void>();
    const result = await deleteGcItem({ kind: 'cache', dir }, testContext(), staged);
    expect(result.results).toMatchObject([{ kind: 'cache', status: 'pending', bytes: 1024 }]);
    expect(result.results.filter((entry) => entry.status === 'done')).toEqual([]);
    expect(staged).toHaveBeenCalledOnce();
    expect(existsSync(join(dir, 'bucket', 'old'))).toBe(false);
    expect(readFileSync(join(dir, 'index'), 'utf8')).toBe('keep index');
    expect(readFileSync(join(dir, 'bucket', 'future', 'data'), 'utf8')).toBe('keep future');
    expect(await pendingItemTrash()).toEqual({ count: 1, bytes: 1024 });
    const out = output();
    expect(await deleteTrash(undefined, out, false, true)).toEqual({ count: 1, bytes: 1024, failures: 0 });
    expect(out.results.take()).toMatchObject([{ kind: 'trash', status: 'done', bytes: 1024 }]);
    expect(await pendingItemTrash()).toEqual({ count: 0, bytes: 0 });
  });

  test.each(['cross-volume', 'unavailable'] as const)(
    '%s staging falls back to the selected in-place delete',
    async (mode) => {
      const dir = cache();
      mkdirSync(join(dir, 'artifact'));
      writeFileSync(join(dir, 'artifact', 'data'), 'cached');
      vi.spyOn(temporary, 'filesystemDevice').mockImplementation((path) => {
        if (mode === 'unavailable') throw new Error('device unavailable');
        return path.endsWith('trash') ? 2 : 1;
      });
      const staged = vi.fn<() => void>();
      const result = await deleteGcItem({ kind: 'cache', dir }, testContext(), staged);
      expect(result.results).toMatchObject([{ kind: 'cache', status: 'done', bytes: 1024 }]);
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
      for (const name of ['one', 'two', 'three']) {
        mkdirSync(join(dir, name));
        writeFileSync(join(dir, name, 'data'), 'cached');
      }
      setExecutor({ runFileAsync: async () => '5\t.' });
      const stop = new AbortController();
      await expect(
        deleteGcItem({ kind: 'cache', dir }, testContext({ signal: stop.signal }), () => stop.abort()),
      ).rejects.toThrow(/abort/i);
      const bytes = prune === 'atomic' ? 1706 : 5120;
      expect(await pendingItemTrash()).toEqual({ count: 1, bytes });
      expect(['one', 'two', 'three'].filter((name) => existsSync(join(dir, name)))).toHaveLength(2);
      expect(await deleteTrash(undefined, output(), false, true)).toEqual({ count: 1, bytes, failures: 0 });
      expect(existsSync(dir)).toBe(true);
    },
  );

  test('unrecognized item manifests are kept instead of authorizing deletion', async () => {
    const path = join(home, 'payload');
    mkdirSync(path);
    writeFileSync(join(path, 'data'), 'cached');
    expect(await stageItemTrash(path, 6, { kind: 'cache', id: path })).toBe(true);
    const entry = (await collectTrash({ itemsOnly: true }))?.entries[0];
    if (!entry) throw new Error('the staged entry was not collected');
    writeFileSync(join(entry.path, 'trash.json'), JSON.stringify({ kind: 'gc-item', bytes: 6 }));
    expect(await deleteTrash(undefined, output(), false, true)).toEqual({ count: 0, bytes: 0, failures: 0 });
    expect(existsSync(join(entry.path, 'entries', 'payload'))).toBe(true);
  });
});
