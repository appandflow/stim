import { lstat, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { StimContext } from '@stim-cli/core';
import { worktreeActivityOfAsync } from '../commands/gc/worktrees.ts';
import type { IdleStopEvidence } from '../policy/idle.ts';
import { gitQuietAsync } from './git.ts';
import type { DiscoveredReads } from './discovered-reads.ts';
import { runningFromReason } from './running-from.ts';

/** Folders holding dependencies or other checkouts, skipped wherever they are. */
const ALWAYS_SKIPPED = new Set(['.git', '.worktrees', 'node_modules', 'Pods']);

/** Folders holding build output, skipped only where git ignores them: a tracked or unignored one is source. */
export const SKIPPED_WHERE_IGNORED: ReadonlySet<string> = new Set([
  'build',
  'dist',
  'target',
  '.gradle',
  '.build',
  '.dd',
  '.cxx',
  '.next',
  '.expo',
  '.turbo',
  '.cache',
  'DerivedData',
  'coverage',
]);

const SCAN_LIMIT = 20_000;
const OVER_BOUND_KEEP_MS = 60 * 60_000;

/** The newest modification time seen under each checkout: a lower bound, so it can prove activity and never idleness. */
const newestSeen = new Map<string, number>();

/** When a scan last met the bound: the verdict is a keep, so reusing it for an hour can only keep longer. */
const overBound = new Map<string, number>();

export type SourceScan = { newest: number } | { unknown: string };

/**
 * The newest modification time of a file or folder under `root`, outside dependency and build folders, never through a
 * link. It stops at once on a write newer than `activeSince`, which proves activity, and reports unknown when it meets
 * an unreadable folder or more than SCAN_LIMIT entries, since an unseen file could be newer.
 */
export async function scanSourceWrites(
  root: string,
  activeSince: number,
  signal?: AbortSignal,
  limit: number = SCAN_LIMIT,
): Promise<SourceScan> {
  const known = newestSeen.get(root);
  if (known !== undefined && known > activeSince) return { newest: known };
  const bounded = overBound.get(root);
  if (bounded !== undefined && Date.now() - bounded < OVER_BOUND_KEEP_MS)
    return { unknown: `it has more than ${limit} source entries to check` };
  let newest = known ?? 0;
  let seen = 0;
  const queue = [root];
  for (let dir = queue.pop(); dir !== undefined; dir = queue.pop()) {
    signal?.throwIfAborted();
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      signal?.throwIfAborted();
      return { unknown: `${dir} cannot be read` };
    }
    for (const entry of entries) {
      if (ALWAYS_SKIPPED.has(entry.name)) continue;
      const path = join(dir, entry.name);
      if (
        SKIPPED_WHERE_IGNORED.has(entry.name) &&
        (await gitQuietAsync(root, ['check-ignore', '-q', '--', relative(root, path)], { signal })) !== null
      )
        continue;
      if (++seen > limit) {
        newestSeen.set(root, newest);
        overBound.set(root, Date.now());
        return { unknown: `it has more than ${limit} source entries to check` };
      }
      let mtime: number;
      try {
        mtime = (await lstat(path)).mtimeMs;
      } catch {
        signal?.throwIfAborted();
        return { unknown: `${path} cannot be read` };
      }
      if (mtime > newest) newest = mtime;
      if (newest > activeSince) {
        newestSeen.set(root, newest);
        return { newest };
      }
      if (entry.isDirectory() && !entry.isSymbolicLink()) queue.push(path);
    }
  }
  newestSeen.set(root, newest);
  return { newest };
}

/**
 * What idleness rests on for a checkout with no Stim state: the newest source write (git-ignored files included), the
 * last commit and the last git write count as activity; a process running from or working in it, an agent session
 * working in it, or evidence that cannot be read keeps it.
 */
export async function discoveredEvidence(
  path: string,
  {
    now,
    idleMs,
    reads,
    operation,
  }: {
    now: number;
    idleMs: number;
    reads: DiscoveredReads;
    operation?: StimContext;
  },
): Promise<IdleStopEvidence> {
  const signal = operation?.signal;
  const activity: IdleStopEvidence['activity'] = [];
  const keep: string[] = [];
  const scan = await scanSourceWrites(path, now - idleMs, signal);
  if ('newest' in scan) activity.push({ basis: 'file edit', at: scan.newest });
  else keep.push(scan.unknown);
  const git = await worktreeActivityOfAsync(path, [], operation);
  if (git) activity.push({ basis: 'git write', at: git.at });
  const committed = Number(
    (await gitQuietAsync(path, ['log', '-1', '--format=%ct', 'HEAD'], { signal, cwd: operation?.cwd }))?.trim(),
  );
  if (Number.isFinite(committed) && committed > 0) activity.push({ basis: 'git commit', at: committed * 1000 });
  keep.push(...(await reads.sessions(path, now)));
  const running = runningFromReason(path, await reads.processes());
  if (running) keep.push(running);
  return { activity, keep };
}
