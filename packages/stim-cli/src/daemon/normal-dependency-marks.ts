import type { StimContext } from '@stim-cli/core';
import { isClaimUnavailable } from '@stim-cli/core/ownership-claim';
import type { GcMark } from '@stim-cli/core/state';
import { stat } from 'node:fs/promises';
import { realpathAsync } from '../commands/gc/paths.ts';
import type { ArtifactCandidate, ArtifactWorktree } from '../stimd/passes/artifacts.ts';
import { answered } from '../workspace/bounded-read.ts';
import { loadConfig } from '../workspace/config.ts';
import { dependencyMarkDue } from './dependency-marks.ts';
import { outputMark } from './marks.ts';
import { dormantAfterMs } from './stages.ts';

/** Selects saved linked dependencies; complete normal inventories still publish missing or due generations. */
export function normalDependencySelection(
  operation: StimContext | undefined,
  between: () => Promise<void>,
  idleMs: number,
) {
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
  return {
    async paths(worktree: ArtifactWorktree): Promise<readonly string[] | undefined> {
      await between();
      try {
        const mark = await read(worktree.path);
        const config = loadConfig();
        if (!config || dormantAfterMs(config, operation?.env) !== idleMs) return [];
        if (dependencyMarkDue(mark, Date.now(), dormantAfterMs(config, operation?.env))) return undefined;
        if (!mark?.dependencies || mark.dependencies.role !== 'linked') return [];
        return mark.dependencies.candidates.map((candidate) => candidate.path);
      } catch (error) {
        uncertain(error);
        return [];
      }
    },
    async problem(candidate: ArtifactCandidate): Promise<string | null> {
      try {
        const mark = await read(candidate.worktree);
        const config = loadConfig();
        const observation = mark?.dependencies;
        if (
          !config ||
          dormantAfterMs(config, operation?.env) !== idleMs ||
          !mark ||
          !observation ||
          observation.role !== 'linked' ||
          dependencyMarkDue(mark, Date.now(), dormantAfterMs(config, operation?.env))
        )
          return 'its saved linked dependency generation is missing or due';
        if (
          candidate.keys.length !== observation.keys.length ||
          candidate.keys.some((key) => !observation.keys.includes(key))
        )
          return 'its workspace membership changed since the dependency observation';
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
