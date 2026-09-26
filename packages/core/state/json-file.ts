import { AsyncLocalStorage } from 'node:async_hooks';
import { readFileSync } from 'node:fs';

type CachedRead = { text: string } | { error: unknown };

const readScope = new AsyncLocalStorage<Map<string, CachedRead>>();

/**
 * Runs `fn` with each state file read from disk at most once: inside it, including after an `await`, `readStateFile`
 * returns the text, or throws the error, of the first read of that path. Callers still parse every time, so no two
 * share a mutable object. Only for computations that write none of the files they read.
 */
export function withStateReadCache<T>(fn: () => T): T {
  return readScope.run(new Map(), fn);
}

export function readStateFile(path: string): string {
  const cache = readScope.getStore();
  if (!cache) return readFileSync(path, 'utf-8');
  let entry = cache.get(path);
  if (!entry) {
    try {
      entry = { text: readFileSync(path, 'utf-8') };
    } catch (error) {
      entry = { error };
    }
    cache.set(path, entry);
  }
  if ('error' in entry) throw entry.error;
  return entry.text;
}

export function readJsonFile(path: string): unknown {
  return JSON.parse(readStateFile(path));
}

export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function readJsonObject(path: string): Record<string, unknown> | null {
  try {
    const value = readJsonFile(path);
    return isJsonObject(value) ? value : null;
  } catch {
    return null;
  }
}
