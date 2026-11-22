import { isScopedHome, type StimContext } from '@stim-cli/core';
import { readDiscoveryScan, readGcMark } from '@stim-cli/core/state';
import { isClaimUnavailable } from '@stim-cli/core/ownership-claim';
import { stat } from 'node:fs/promises';
import { listedRoots, type WorktreeSweep } from '../commands/gc/worktrees.ts';
import { realpathAsync } from '../commands/gc/paths.ts';
import { answered } from '../workspace/bounded-read.ts';
import { loadConfig } from '../workspace/config.ts';
import { endedPullRequest } from '../workspace/pull-request.ts';
import { targetedCheckouts } from '../workspace/discovery.ts';
import { matchWorktreeEntry, resolveSourceCheckoutAsync } from '../workspace/worktree.ts';
import { dormantAfterMs } from './stages.ts';
import { worktreeMarkDue } from './worktree-marks.ts';

/** Saved normal worktrees are a shortlist for current reconciliation, never merge or archive authority. */
export function normalWorktreeSelection(operation?: StimContext, idle = false) {
  const read = async (path: string) => {
    const root = await answered(path, () => realpathAsync(path), 3_000, operation?.signal);
    return readGcMark(root);
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
      if (candidate.reduceOnly) return 'its normal inventory permits output reduction only';
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
        const { entries, ...source } = await resolveSourceCheckoutAsync(candidate.path, {
          env: operation?.env,
          signal: operation?.signal,
          declareFor: operation,
          cache: false,
        });
        const holder = matchWorktreeEntry(entries, candidate.path);
        if ('refusal' in source || !holder || holder.bare || holder.path === source.path)
          return 'its current linked Git holder could not be verified';
        const registered = listedRoots();
        const members = registered.filter((root) => matchWorktreeEntry(entries, root)?.path === holder.path);
        if (!members.length) {
          const scan = isScopedHome(operation?.env) ? null : readDiscoveryScan();
          if (
            [...(scan?.found ?? []), ...(scan?.dotFolderFound ?? [])].some(
              (path) => matchWorktreeEntry(entries, path)?.path === holder.path,
            )
          )
            return 'its saved discovery classification permits output reduction only';
          const route = (
            await targetedCheckouts(config, registered, [candidate.path], operation, { nodeWorktrees: true })
          ).find(({ path }) => path === candidate.path);
          if (!route || route.reduceOnly) return 'its current scope does not authorize worktree removal';
        }
        const currentKeys = [...new Set([...keys, ...members])];
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
