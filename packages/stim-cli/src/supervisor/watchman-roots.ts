import { realpathSync } from 'node:fs';
import { sep } from 'node:path';
import { getExecutor } from '../exec.ts';
import type { NdjsonWriter } from '../ndjson.ts';
import { describeError } from './errors.ts';

export type WatchmanCommand = (args: string[]) => Promise<unknown>;

const WATCHMAN_TIMEOUT_MS = 2000;
const PROBE_DELAYS_MS = [5_000, 30_000, 120_000];

export const runWatchman: WatchmanCommand = async (args) =>
  JSON.parse(await getExecutor().runFileAsync('watchman', ['--no-spawn', ...args], { timeoutMs: WATCHMAN_TIMEOUT_MS }));

function parseWatchRoots(payload: unknown): string[] | null {
  const roots = (payload as { roots?: unknown } | null)?.roots;
  if (!Array.isArray(roots)) return null;
  return roots.filter((root): root is string => typeof root === 'string');
}

function parseSubscriberNames(payload: unknown): string[] | null {
  if (!payload || typeof payload !== 'object' || 'error' in payload) return null;
  const subscribers = (payload as { subscribers?: unknown }).subscribers;
  if (subscribers === undefined) return [];
  if (!Array.isArray(subscribers)) return null;
  const names: string[] = [];
  for (const subscriber of subscribers) {
    const name = (subscriber as { info?: { name?: unknown } } | null)?.info?.name;
    if (typeof name !== 'string') return null;
    names.push(name);
  }
  return names;
}

function canonical(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

export function newRootsContaining(before: string[], current: string[], workspaceRoot: string): string[] {
  const seen = new Set(before.map((root) => canonical(root) ?? root));
  return current.filter((root) => {
    const resolved = canonical(root);
    if (resolved === null || seen.has(resolved)) return false;
    return workspaceRoot === resolved || workspaceRoot.startsWith(resolved.endsWith(sep) ? resolved : resolved + sep);
  });
}

// metro-file-map's WatchmanWatcher names each subscription `metro-file-map-<pid>-<path>-<hash>`.
function metroSubscriptionPrefix(pid: number): string {
  return `metro-file-map-${pid}-`;
}

async function watchRoots(watchman: WatchmanCommand): Promise<string[] | null> {
  try {
    return parseWatchRoots(await watchman(['watch-list']));
  } catch {
    return null;
  }
}

async function subscriberNames(watchman: WatchmanCommand, root: string): Promise<string[] | null> {
  try {
    return parseSubscriberNames(await watchman(['debug-get-subscriptions', root]));
  } catch {
    return null;
  }
}

export interface MetroWatchRoots {
  started(metroPid: number): void;
  beforeClose(): Promise<void>;
  afterClose(): Promise<void>;
}

export function trackMetroWatchRoots({
  workspaceRoot,
  writer,
  watchman = runWatchman,
  probeDelaysMs = PROBE_DELAYS_MS,
}: {
  workspaceRoot: string;
  writer: NdjsonWriter;
  watchman?: WatchmanCommand;
  probeDelaysMs?: number[];
}): MetroWatchRoots {
  const before = watchRoots(watchman);
  const owned = new Set<string>();
  const timers: ReturnType<typeof setTimeout>[] = [];
  let prefix: string | null = null;

  const probe = async () => {
    const earlier = await before;
    if (prefix === null || earlier === null) return;
    const current = await watchRoots(watchman);
    if (current === null) return;
    for (const root of newRootsContaining(earlier, current, workspaceRoot)) {
      if (owned.has(root)) continue;
      const names = await subscriberNames(watchman, root);
      if (names?.some((name) => name.startsWith(prefix as string))) owned.add(root);
    }
  };

  return {
    started(metroPid) {
      prefix = metroSubscriptionPrefix(metroPid);
      for (const delay of probeDelaysMs) {
        const timer = setTimeout(() => void probe(), delay);
        timer.unref?.();
        timers.push(timer);
      }
    },
    async beforeClose() {
      for (const timer of timers) clearTimeout(timer);
      await probe();
    },
    async afterClose() {
      for (const root of owned) {
        const names = await subscriberNames(watchman, root);
        const others = names?.filter((name) => !name.startsWith(prefix as string));
        if (!others || others.length > 0) {
          writer.write({
            src: 'metro',
            level: 'debug',
            event: 'watchman_root_kept',
            msg: others
              ? `kept the watchman root ${root}: ${others.length} other subscription(s) still use it`
              : `kept the watchman root ${root}: could not list its subscriptions`,
          });
          continue;
        }
        try {
          await watchman(['watch-del', root]);
          writer.write({
            src: 'metro',
            level: 'info',
            event: 'watchman_root_removed',
            msg: `removed the watchman root ${root} that this dev server registered`,
          });
        } catch (err) {
          writer.write({
            src: 'metro',
            level: 'warn',
            event: 'watchman_root_kept',
            msg: `could not remove the watchman root ${root}: ${describeError(err)}`,
          });
        }
      }
    },
  };
}
