import { getExecutor } from '../exec.ts';
import { spawnEntry } from '../spawn-entry.ts';
import { readRecords } from './store.ts';

export async function flipDrained(root: string, home: string, signal?: AbortSignal): Promise<void> {
  const { current, staged } = readRecords(root);
  if (!current || !staged || current.dir === staged.dir) return;
  const output = await getExecutor().runFileAsync(process.execPath, [spawnEntry('engine-flip')], {
    timeoutMs: 600_000,
    env: { STIM_ENGINE_ROOT: root, STIM_HOME: home },
    signal: signal ?? new AbortController().signal,
  });
  const last = output.trim().split('\n').at(-1);
  try {
    const value: unknown = JSON.parse(last ?? '');
    if (
      value &&
      typeof value === 'object' &&
      'lockError' in value &&
      value.lockError &&
      typeof value.lockError === 'object'
    ) {
      const error = value.lockError;
      if ('code' in error && 'socketPath' in error)
        throw Object.assign(new Error('Could not lock the engine store.'), error);
    }
  } catch (error) {
    if (error instanceof SyntaxError) return;
    throw error;
  }
}
