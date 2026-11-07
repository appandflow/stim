import { join } from 'node:path';
import { allDrained, readBuildClaims } from './claims.ts';
import { takeLock } from './locks.ts';
import { readRecords } from './store.ts';
import { getExecutor } from '../exec.ts';

/** The caller holds the store lock; the staged selector runs while the flip lock is also held. */
export async function flipDrained(root: string, home: string, signal?: AbortSignal): Promise<void> {
  const initial = readRecords(root);
  if (!initial.current || !initial.staged || initial.current.dir === initial.staged.dir) return;
  const lock = await takeLock(root, '.flip.sock');
  if (!lock) return;
  try {
    const { current, staged } = readRecords(root);
    if (
      !current ||
      !staged ||
      current.dir === staged.dir ||
      !readBuildClaims(root).every(({ survey }) => allDrained(survey))
    )
      return;
    await getExecutor().runFileAsync(
      process.execPath,
      [join(root, staged.dir, 'dist', 'engine-select.mjs'), '--flip'],
      {
        timeoutMs: 600_000,
        env: { STIM_ENGINE_ROOT: root, STIM_HOME: home },
        signal,
      },
    );
  } finally {
    await lock.release();
  }
}
