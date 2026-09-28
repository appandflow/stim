import { realpathSync } from 'node:fs';
import { sep } from 'node:path';
import { getExecutor } from '../exec.ts';
import type { NdjsonWriter } from '../ndjson.ts';
import { describeError } from './errors.ts';

export type WatchmanCommand = (args: string[], timeoutMs: number) => Promise<unknown>;

const WATCHMAN_TIMEOUT_MS = 2000;
const SHUTDOWN_BUDGET_MS = 3000;
const PROBE_DELAYS_MS = [3_000, 6_000, 10_000, 15_000, 20_000, 30_000, 45_000, 60_000, 120_000, 300_000];

export const runWatchman: WatchmanCommand = async (args, timeoutMs) =>
  JSON.parse(await getExecutor().runFileAsync('watchman', ['--no-spawn', ...args], { timeoutMs }));

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

type BoundWatchman = (args: string[]) => Promise<unknown>;

async function watchRoots(watchman: BoundWatchman): Promise<string[] | null> {
  try {
    return parseWatchRoots(await watchman(['watch-list']));
  } catch {
    return null;
  }
}

async function subscriberNames(watchman: BoundWatchman, root: string): Promise<string[] | null> {
  try {
    return parseSubscriberNames(await watchman(['debug-get-subscriptions', root]));
  } catch {
    return null;
  }
}

async function triggerCount(watchman: BoundWatchman, root: string): Promise<number | null> {
  try {
    const triggers = ((await watchman(['trigger-list', root])) as { triggers?: unknown } | null)?.triggers;
    return Array.isArray(triggers) ? triggers.length : null;
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
  let deadline = Infinity;
  const call: BoundWatchman = async (args) => {
    const left = deadline - Date.now();
    if (left <= 0) throw new Error('the watchman cleanup ran out of time');
    return watchman(args, Math.min(WATCHMAN_TIMEOUT_MS, left));
  };
  const before = watchRoots(call);
  const owned = new Set<string>();
  const timers: ReturnType<typeof setTimeout>[] = [];
  let prefix: string | null = null;

  const probe = async () => {
    const earlier = await before;
    if (prefix === null || earlier === null) return;
    const current = await watchRoots(call);
    if (current === null) return;
    for (const root of newRootsContaining(earlier, current, workspaceRoot)) {
      if (owned.has(root)) continue;
      const names = await subscriberNames(call, root);
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
      deadline = Date.now() + SHUTDOWN_BUDGET_MS;
      await probe();
    },
    async afterClose() {
      for (const root of owned) {
        const names = await subscriberNames(call, root);
        const others = names?.filter((name) => !name.startsWith(prefix as string));
        const triggers = others?.length === 0 ? await triggerCount(call, root) : null;
        const reason = !others
          ? 'could not list its subscriptions'
          : others.length > 0
            ? `${others.length} other subscription(s) still use it`
            : triggers === null
              ? 'could not list its triggers'
              : triggers > 0
                ? `it has ${triggers} trigger(s)`
                : null;
        if (reason) {
          writer.write({
            src: 'metro',
            level: 'debug',
            event: 'watchman_root_kept',
            msg: `kept the watchman root ${root}: ${reason}`,
          });
          continue;
        }
        try {
          await call(['watch-del', root]);
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
