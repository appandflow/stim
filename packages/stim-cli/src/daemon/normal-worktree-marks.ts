import type { StimContext } from '@stim-cli/core';
import { isClaimUnavailable } from '@stim-cli/core/ownership-claim';
import { stat } from 'node:fs/promises';
import { listedRoots, type WorktreeSweep } from '../commands/gc/worktrees.ts';
import { realpathAsync } from '../commands/gc/paths.ts';
import { answered } from '../workspace/bounded-read.ts';
import { loadConfig } from '../workspace/config.ts';
import { endedPullRequest } from '../workspace/pull-request.ts';
import { outputMark } from './marks.ts';
import { dormantAfterMs } from './stages.ts';
import { worktreeMarkDue } from './worktree-marks.ts';

/** Saved normal worktrees are a shortlist for current reconciliation, never merge or archive authority. */
export function normalWorktreeSelection(operation?: StimContext, idle = false) {
  const read = async (path: string) => {
    const config = loadConfig();
    if (!config) return null;
    const root = await answered(path, () => realpathAsync(path), 3_000, operation?.signal);
    return outputMark(config, root, operation);
  };
  const uncertain = (error: unknown) => {
    if (isClaimUnavailable(error) || (error instanceof Error && 'reportCleanup' in error)) throw error;
    operation?.signal.throwIfAborted();
  };
  return {
    async select(
      path: string,
      keys: readonly string[],
      status: { head: string | null; dirty: boolean | null },
    ): Promise<boolean> {
      if (idle || status.dirty !== false) return true;
      try {
        const mark = await read(path);
        const config = loadConfig();
        if (!config) return false;
        const saved = mark?.worktree;
        if (!mark || !saved || worktreeMarkDue(mark, Date.now(), dormantAfterMs(config, operation?.env))) return true;
        if (saved.clean !== true || saved.emptyBranch !== false || saved.finished) return true;
        if (
          saved.head !== status.head ||
          keys.length !== saved.keys.length ||
          keys.some((key) => !saved.keys.includes(key))
        )
          return true;
        // @ref LLP 0001#the-lane-marks-what-each-checkout-could-free -- external completion of a fresh unfinished checkout waits for refresh
        return false;
      } catch (error) {
        uncertain(error);
        return false;
      }
    },
    async problem(candidate: WorktreeSweep['worktrees'][number], keys: readonly string[]): Promise<string | null> {
      if (
        candidate.dirty ||
        (candidate.merge?.merged === false && candidate.merge.noOwnCommits) ||
        (!candidate.merge?.merged && !endedPullRequest(candidate.pullRequest))
      )
        return null;
      try {
        const mark = await read(candidate.path);
        const config = loadConfig();
        const saved = mark?.worktree;
        if (!config || !mark || !saved || worktreeMarkDue(mark, Date.now(), dormantAfterMs(config, operation?.env)))
          return 'its saved worktree generation is missing or due';
        if (saved.clean !== true || !saved.finished || saved.head !== candidate.head)
          return 'the saved generation does not shortlist this clean finished worktree';
        const registered = new Set(listedRoots());
        const currentKeys = [...new Set([...keys, ...candidate.keys.filter((key) => registered.has(key))])];
        if (currentKeys.length !== saved.keys.length || currentKeys.some((key) => !saved.keys.includes(key)))
          return 'its workspace membership changed since the worktree observation';
        if ((await answered(candidate.path, () => stat(candidate.path), 3_000, operation?.signal)).dev !== mark.device)
          return 'the marked worktree changed volume';
        return null;
      } catch (error) {
        uncertain(error);
        return 'its saved worktree identity could not be checked';
      }
    },
  };
}
