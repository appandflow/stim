import type { StimContext } from '@stim-cli/core';
import { isClaimUnavailable } from '@stim-cli/core/ownership-claim';
import type { GcMark } from '@stim-cli/core/state';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { reclaimKeysAsync } from '../commands/worktree.ts';
import { matchWorktreeEntry, resolveSourceCheckoutAsync } from '../workspace/worktree.ts';
import { ARTIFACT_DIRS } from '../workspace/regenerable-dirs.ts';
import { realpathAsync } from '../commands/gc/paths.ts';
import type { ArtifactCandidate, ArtifactWorktree } from '../stimd/passes/artifacts.ts';
import { answered } from '../workspace/bounded-read.ts';
import { loadConfig } from '../workspace/config.ts';
import { dependencyMarkDue } from './dependency-marks.ts';
import { outputMark } from './marks.ts';
import { dormantAfterMs, sourceDormantAfterMs } from './stages.ts';

/** Selects saved normal dependencies; complete normal inventories still publish missing or due generations. */
export function normalDependencySelection(
  operation: StimContext | undefined,
  between: () => Promise<void>,
  idleMs: number,
  source = false,
) {
  const role = source ? 'source' : 'linked';
  const threshold = source ? sourceDormantAfterMs : dormantAfterMs;
  const read = async (root: string): Promise<GcMark | null> => {
    const config = loadConfig();
    if (!config) return null;
    const path = await answered(root, () => realpathAsync(root), 3_000, operation?.signal);
    const mark = await outputMark(config, path, operation);
    return mark && path === mark.root ? mark : null;
  };
  const uncertain = (error: unknown) => {
    if (isClaimUnavailable(error) || (error instanceof Error && 'reportCleanup' in error)) throw error;
    operation?.signal.throwIfAborted();
  };
  const paths = async (root: string): Promise<readonly string[] | undefined> => {
    await between();
    try {
      const mark = await read(root);
      const config = loadConfig();
      if (!config || threshold(config, operation?.env) !== idleMs) return [];
      if (dependencyMarkDue(mark, Date.now(), dormantAfterMs(config, operation?.env))) return undefined;
      if (!mark?.dependencies || mark.dependencies.role !== role) return [];
      return mark.dependencies.candidates.map((candidate) => candidate.path);
    } catch (error) {
      uncertain(error);
      return [];
    }
  };
  return {
    paths: (worktree: ArtifactWorktree): Promise<readonly string[] | undefined> => paths(worktree.path),
    async reclaimable(root: string): Promise<boolean | undefined> {
      const selected = await paths(root);
      return selected === undefined ? undefined : selected.length > 0;
    },
    async problem(candidate: ArtifactCandidate): Promise<string | null> {
      try {
        const mark = await read(candidate.worktree);
        const config = loadConfig();
        const observation = mark?.dependencies;
        if (
          !config ||
          threshold(config, operation?.env) !== idleMs ||
          !mark ||
          !observation ||
          observation.role !== role ||
          dependencyMarkDue(mark, Date.now(), dormantAfterMs(config, operation?.env))
        )
          return 'its saved dependency generation is missing or due';
        const { entries, ...checkout } = await resolveSourceCheckoutAsync(candidate.worktree, {
          env: operation?.env,
          signal: operation?.signal,
          declareFor: operation,
          cache: false,
        });
        const holder = matchWorktreeEntry(entries, candidate.worktree);
        if ('refusal' in checkout || !holder || holder.bare || (holder.path === checkout.path) !== (role === 'source'))
          return 'its current Git holder could not be verified';
        const keys = (
          await reclaimKeysAsync(candidate.worktree, operation, [...candidate.keys, ...observation.keys])
        ).filter((key) => matchWorktreeEntry(entries, key)?.path === holder.path);
        if (keys.length !== observation.keys.length || keys.some((key) => !observation.keys.includes(key)))
          return 'its workspace membership changed since the dependency observation';
        if (!keys.some((key) => ARTIFACT_DIRS.dependencies.some((dir) => join(key, dir) === candidate.path)))
          return 'its saved dependency path is outside its current holder';
        const saved = observation.candidates.find(({ path }) => path === candidate.path);
        if (!saved) return 'its dependency path is absent from the saved generation';
        const signal = operation?.signal;
        if ((await answered(mark.root, () => stat(mark.root), 3_000, signal)).dev !== mark.device)
          return 'the marked checkout changed volume';
        if (
          (await answered(candidate.path, () => realpathAsync(candidate.path), 3_000, signal)) !== candidate.path ||
          (await answered(candidate.path, () => stat(candidate.path), 3_000, signal)).dev !== saved.device
        )
          return 'the marked dependency moved or changed volume';
        return null;
      } catch (error) {
        uncertain(error);
        return 'its saved dependency identity could not be checked';
      }
    },
  };
}
