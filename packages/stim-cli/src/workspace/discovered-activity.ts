import { lstat, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { StimContext } from '@stim-cli/core';
import { worktreeActivityOfAsync } from '../commands/gc/worktrees.ts';
import type { IdleStopEvidence } from '../policy/idle.ts';
import { gitQuietAsync } from './git.ts';
import { sharedRead } from './git-reads.ts';
import { answered, hungRead, pendingRead, Unanswered } from './bounded-read.ts';
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

// @ref LLP 0004#the-source-scan-has-a-time-budget -- a partial walk is unknown, never idle
const SCAN_BUDGET_MS = 15_000;
const OVER_BUDGET_KEEP_MS = 60 * 60_000;
const OVER_BUDGET = `it could not check every source entry within ${SCAN_BUDGET_MS / 1000} s`;

/** The newest modification time seen under each checkout: a lower bound, so it can prove activity and never idleness. */
const newestSeen = new Map<string, number>();

/** When a scan last ran out of time: the verdict is a keep, so reusing it for an hour can only keep longer. */
const overBudget = new Map<string, number>();

export type SourceScan = { newest: number } | { unknown: string };

/** The pending reads a scan of this pass already waited out its whole budget on, which later scans of it do not wait for. */
const waitedOutBy = new WeakMap<StimContext, WeakSet<Promise<void>>>();

/**
 * Null once no other read holds the one pending-read slot, waiting for it to settle within `left()` and until `signal`
 * aborts; else unknown for this pass, with no cooldown. A read in `waitedOut` is not waited for again, and one waited
 * out here is added to it.
 */
async function waiting(
  left: () => number,
  signal?: AbortSignal,
  waitedOut?: WeakSet<Promise<void>>,
): Promise<SourceScan | null> {
  for (let pending = pendingRead(); pending; pending = pendingRead()) {
    const label = hungRead();
    const busy = { unknown: `its source cannot be read while a read of ${label} has not answered` };
    if (waitedOut?.has(pending)) return busy;
    const ms = left();
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    const settled =
      ms > 0 &&
      (await Promise.race([
        pending.then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), ms);
          onAbort = () => resolve(false);
          signal?.addEventListener('abort', onAbort, { once: true });
        }),
      ]));
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
    signal?.throwIfAborted();
    if (!settled) {
      waitedOut?.add(pending);
      return busy;
    }
  }
  return null;
}

/**
 * The newest modification time of a file or folder under `root`, outside dependency and build folders, never through a
 * link. It stops at once on a write newer than `activeSince`, which proves activity, and reports unknown when it meets
 * an unreadable folder or runs past SCAN_BUDGET_MS, a read that does not answer in time included, since an unseen file
 * could be newer.
 */
export async function scanSourceWrites(
  root: string,
  activeSince: number,
  signal?: AbortSignal,
  waitedOut?: WeakSet<Promise<void>>,
): Promise<SourceScan> {
  const known = newestSeen.get(root);
  if (known !== undefined && known > activeSince) return { newest: known };
  const over = overBudget.get(root);
  if (over !== undefined && Date.now() - over < OVER_BUDGET_KEEP_MS) return { unknown: OVER_BUDGET };
  let newest = known ?? 0;
  const started = performance.now();
  const left = () => SCAN_BUDGET_MS - (performance.now() - started);
  const outOfTime = (): SourceScan => {
    newestSeen.set(root, newest);
    overBudget.set(root, Date.now());
    return { unknown: OVER_BUDGET };
  };
  const unreadable = (path: string, error: unknown): SourceScan => {
    signal?.throwIfAborted();
    return error instanceof Unanswered ? outOfTime() : { unknown: `${path} cannot be read` };
  };
  const queue = [root];
  for (let dir = queue.pop(); dir !== undefined; dir = queue.pop()) {
    signal?.throwIfAborted();
    if (left() < 0) return outOfTime();
    const blocked = pendingRead() && (await waiting(left, signal, waitedOut));
    if (blocked) return blocked;
    let entries;
    try {
      const at = dir;
      entries = await answered(at, () => readdir(at, { withFileTypes: true }), Math.max(1, left()), signal);
    } catch (error) {
      return unreadable(dir, error);
    }
    for (const entry of entries) {
      if (ALWAYS_SKIPPED.has(entry.name)) continue;
      const path = join(dir, entry.name);
      if (SKIPPED_WHERE_IGNORED.has(entry.name)) {
        if (left() < 0) return outOfTime();
        const ignored = await gitQuietAsync(root, ['check-ignore', '-q', '--', relative(root, path)], {
          signal,
          timeoutMs: Math.max(1, left()),
        });
        if (ignored !== null) continue;
      }
      const busy = pendingRead() && (await waiting(left, signal, waitedOut));
      if (busy) return busy;
      let mtime: number;
      try {
        mtime = (await answered(path, () => lstat(path), Math.max(1, left()), signal)).mtimeMs;
      } catch (error) {
        return unreadable(path, error);
      }
      if (mtime > newest) newest = mtime;
      if (newest > activeSince) {
        newestSeen.set(root, newest);
        return { newest };
      }
      if (left() < 0) return outOfTime();
      if (entry.isDirectory() && !entry.isSymbolicLink()) queue.push(path);
    }
  }
  if (left() < 0) return outOfTime();
  newestSeen.set(root, newest);
  return { newest };
}

/**
 * `scanSourceWrites`, reusing a completed walk's newest write within the shared reads of one pass or gc run; those are
 * dropped before and after every action and when a workspace lock is taken, so a check under a claim walks again. A
 * pending read one scan of the operation waited its whole budget for is not waited for by its later scans.
 */
async function sharedSourceScan(root: string, activeSince: number, operation?: StimContext): Promise<SourceScan> {
  const walks = await sharedRead(operation, 'source-walks', async () => new Map<string, number>());
  const walked = walks.get(root);
  if (walked !== undefined) return { newest: walked };
  let waitedOut = operation && waitedOutBy.get(operation);
  if (operation && !waitedOut) waitedOutBy.set(operation, (waitedOut = new WeakSet()));
  const scan = await scanSourceWrites(root, activeSince, operation?.signal, waitedOut);
  if ('newest' in scan && scan.newest <= activeSince) walks.set(root, scan.newest);
  return scan;
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
  const scan = await sharedSourceScan(path, now - idleMs, operation);
  if ('unknown' in scan) return { activity, keep: [scan.unknown] };
  activity.push({ basis: 'file edit', at: scan.newest });
  const gitPath = join(path, '.git');
  const isGit = await answered(gitPath, () => lstat(gitPath), SCAN_BUDGET_MS, signal).then(
    () => true,
    (error: unknown) => {
      signal?.throwIfAborted();
      if (error instanceof Unanswered) throw error;
      return false;
    },
  );
  const git = await worktreeActivityOfAsync(path, [], operation);
  if (git) activity.push({ basis: 'git write', at: git.at });
  else if (isGit) keep.push('its git activity cannot be read');
  const committed = Number(
    (
      await sharedRead(operation, `last-commit\0${path}`, () =>
        gitQuietAsync(path, ['log', '-1', '--format=%ct', 'HEAD'], { signal, cwd: operation?.cwd }),
      )
    )?.trim(),
  );
  if (Number.isFinite(committed) && committed > 0) activity.push({ basis: 'git commit', at: committed * 1000 });
  else if (isGit) keep.push('its last commit cannot be read');
  keep.push(...(await reads.sessions(path, now)));
  const running = runningFromReason(path, await reads.processes());
  if (running) keep.push(running);
  return { activity, keep };
}
