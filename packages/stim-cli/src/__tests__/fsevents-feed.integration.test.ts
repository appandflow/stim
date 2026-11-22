import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { GC_MARK_VERSION, gcMarkFile, readGcMark } from '@stim-cli/core/state';
import { getExecutor } from '../exec.ts';
import { writeCacheFile } from '../cache-file.ts';
import { packagedHistoryHelper, startHistoryFeed } from '../fsevents-helper.ts';
import { readHistoryCheckpoints } from '../fsevents-state.ts';
import { createThreadTable } from '../stimd/threads.ts';

describe.skipIf(process.platform !== 'darwin')('FSEvents dirty feed', () => {
  test('real helper replay and live changes persist through the passes worker, then EOF stops the helper', async () => {
    const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'stim-fsevents-feed-')));
    const home = join(scratch, 'home');
    const root = join(scratch, 'checkout');
    const packaged = packagedHistoryHelper();
    const released = existsSync(packaged.binary);
    const binary = released ? packaged.binary : join(scratch, 'stim-fsevents');
    mkdirSync(home);
    mkdirSync(root);
    vi.stubEnv('STIM_HOME', home);
    const threads = createThreadTable(() => {});
    const failures: string[] = [];
    let feed: ReturnType<typeof startHistoryFeed> | undefined;
    try {
      if (!released)
        await getExecutor().runFileAsync(
          'clang',
          [
            '-Wall',
            '-Wextra',
            '-Werror',
            '-O2',
            '-mmacosx-version-min=14.0',
            '-framework',
            'CoreServices',
            '-o',
            binary,
            resolve('packages/stim-cli/native/fsevents/stim-fsevents.c'),
          ],
          { timeoutMs: 60_000 },
        );
      const device = statSync(root).dev;
      const writeMark = () => {
        const markedAt = new Date().toISOString();
        writeCacheFile(gcMarkFile(root), {
          v: GC_MARK_VERSION,
          root,
          device,
          markedAt,
          lastActivityAt: null,
          candidates: [],
        });
        return markedAt;
      };
      writeMark();
      feed = startHistoryFeed({
        binary,
        sha256: released ? packaged.sha256 : createHash('sha256').update(readFileSync(binary)).digest('hex'),
        dirty: (roots, at) => threads.dirty(roots, at),
        log: (reason) => failures.push(reason),
      });
      await feed.update([{ root, device }]);
      await vi.waitFor(() => expect(readHistoryCheckpoints()[String(device)]?.uuid).toEqual(expect.any(String)), {
        timeout: 20_000,
      });
      const markedAt = writeMark();
      writeFileSync(join(root, 'changed'), 'live');
      await vi.waitFor(
        () => expect(Date.parse(readGcMark(root)?.dirtyAt ?? '')).toBeGreaterThan(Date.parse(markedAt)),
        { timeout: 20_000 },
      );
      await feed.close();
      feed = undefined;
      const offlineMark = writeMark();
      writeFileSync(join(root, 'offline'), 'history');
      feed = startHistoryFeed({
        binary,
        sha256: released ? packaged.sha256 : createHash('sha256').update(readFileSync(binary)).digest('hex'),
        dirty: (roots, at) => threads.dirty(roots, at),
        log: (reason) => failures.push(reason),
      });
      await feed.update([{ root, device }]);
      await vi.waitFor(
        () => expect(Date.parse(readGcMark(root)?.dirtyAt ?? '')).toBeGreaterThan(Date.parse(offlineMark)),
        { timeout: 20_000 },
      );
      await feed.close();
      feed = undefined;
      expect(failures).toEqual([]);
      writeMark();
      const marks = dirname(gcMarkFile(root));
      chmodSync(marks, 0o500);
      try {
        await expect(threads.dirty([root], Date.now())).rejects.toThrow(/EACCES|permission denied/);
        expect(readGcMark(root)?.dirtyAt).toBeUndefined();
      } finally {
        chmodSync(marks, 0o700);
      }
      expect(existsSync(join(home, 'gc', 'fsevents.json'))).toBe(true);
    } finally {
      await feed?.close();
      await threads.close();
      vi.unstubAllEnvs();
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 60_000);
});
