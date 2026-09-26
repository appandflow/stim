import type { HomeItem } from '@/lib/home';
import type { StatusPayload } from '@/protocol/types';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * `next`, with every part that deep-equals the same part of `prev` replaced by `prev`'s value, so unchanged
 * objects and arrays keep their identity. Returns `prev` itself when the two are deep-equal.
 */
export function share<T>(prev: unknown, next: T): T {
  if (Object.is(prev, next)) return prev as T;
  if (Array.isArray(prev) && Array.isArray(next)) {
    let same = prev.length === next.length;
    const out = next.map((item, i) => {
      const shared = share(prev[i], item);
      if (shared !== prev[i]) same = false;
      return shared;
    });
    return (same ? prev : out) as T;
  }
  if (isRecord(prev) && isRecord(next)) {
    const keys = Object.keys(next);
    let same = keys.length === Object.keys(prev).length;
    const out: Record<string, unknown> = {};
    for (const key of keys) {
      out[key] = share(prev[key], next[key]);
      if (out[key] !== prev[key] || !Object.hasOwn(prev, key)) same = false;
    }
    return (same ? prev : out) as T;
  }
  return next;
}

/** `share` for a status push, matching environments by path so an added or removed one keeps the others' identity. */
export function shareStatus(prev: StatusPayload | null, next: StatusPayload): StatusPayload {
  if (!prev) return next;
  const byPath = new Map(prev.environments.map((env) => [env.path, env]));
  const environments = next.environments.map((env) => share(byPath.get(env.path), env));
  const sameEnvironments =
    environments.length === prev.environments.length && environments.every((env, i) => env === prev.environments[i]);
  const { environments: _prevEnvironments, ...prevRest } = prev;
  const { environments: _nextEnvironments, ...nextRest } = next;
  const rest = share(prevRest, nextRest);
  if (sameEnvironments && rest === prevRest) return prev;
  return { ...rest, environments: sameEnvironments ? prev.environments : environments };
}

/** `next`, reusing each item of `prev` whose fields are all identical, and `prev` itself when every item is. */
export function shareItems(prev: HomeItem[], next: HomeItem[]): HomeItem[] {
  const byKey = new Map(prev.map((item) => [item.key, item]));
  const out = next.map((item) => {
    const old = byKey.get(item.key);
    return old &&
      old.env === item.env &&
      old.macName === item.macName &&
      old.project === item.project &&
      old.title === item.title &&
      old.inCheckout === item.inCheckout
      ? old
      : item;
  });
  return out.length === prev.length && out.every((item, i) => item === prev[i]) ? prev : out;
}
