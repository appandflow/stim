import chalk from 'chalk';
import type { StimContext } from '@stim-cli/core';
import { formatBytes } from '../../fs-util.ts';
import {
  artifactWorktrees,
  clearArtifact,
  collectArtifactsAsync,
  type ArtifactCandidate,
} from '../../maintenance/artifacts.ts';
import { maintenancePinned } from '../../maintenance/protect.ts';
import { canonicalPath } from './paths.ts';
import { GC_OUTPUT, type GcOutput } from './results.ts';
import { LIGHTEN_AFTER_MS } from './workspaces.ts';

export interface WorktreeDependencies {
  candidates: ArtifactCandidate[];
  skips: { target: string; reason: string }[];
}

const NO_RESTORE = 'Stim has no workspace in its worktree, so no start, ios or android run would restore it';

/**
 * node_modules and ios/Pods of linked worktrees `gc --delete` lightens: idle for LIGHTEN_AFTER_MS, holding a Stim
 * workspace that restores them, and with nothing running from them.
 */
export async function collectWorktreeDependencies({
  now,
  operation,
}: {
  now: number;
  operation?: StimContext;
}): Promise<WorktreeDependencies> {
  const found = await collectArtifactsAsync(
    'dependencies',
    {
      now,
      windowMs: LIGHTEN_AFTER_MS,
      protectedRoot: canonicalPath(operation?.cwd ?? process.cwd()),
      pinned: maintenancePinned,
    },
    operation?.signal ?? new AbortController().signal,
    operation,
  );
  return {
    candidates: found.candidates.filter((candidate) => candidate.keys.length),
    skips: [
      ...found.skips,
      ...found.candidates
        .filter((candidate) => !candidate.keys.length)
        .map(({ path }) => ({ target: path, reason: NO_RESTORE })),
    ],
  };
}

export async function lightenWorktreeDependencies(
  found: WorktreeDependencies | null | undefined,
  { log, record }: GcOutput = GC_OUTPUT,
  operation?: StimContext,
): Promise<number> {
  if (!found?.candidates.length) return 0;
  const worktrees = artifactWorktrees();
  const protectedRoot = canonicalPath(operation?.cwd ?? process.cwd());
  let failures = 0;
  for (const { worktree, path } of found.candidates) {
    operation?.signal.throwIfAborted();
    try {
      const outcome = await clearArtifact(
        { kind: 'would-delete-dependencies', target: path, bytes: 0, reason: 'gc --delete' },
        'dependencies',
        { windowMs: LIGHTEN_AFTER_MS, protectedRoot, pinned: maintenancePinned, worktrees },
      );
      if (outcome.status === 'done') {
        log(
          chalk.green(
            `Lightened ${worktree}: deleted ${path}, freeing ${formatBytes(outcome.bytes)}; the next start, ios or android restores it with worktree warm`,
          ),
        );
        record('worktreeDependencies', 'done', path, { bytes: outcome.bytes });
      } else {
        log(chalk.yellow(`Kept ${path}: ${outcome.detail}`));
        record('worktreeDependencies', 'kept', path, { bytes: null, detail: outcome.detail });
      }
    } catch (error) {
      operation?.signal.throwIfAborted();
      failures++;
      const detail = error instanceof Error ? error.message : String(error);
      log(chalk.red(`Could not delete ${path}: ${detail}`));
      record('worktreeDependencies', 'failed', path, { bytes: null, detail });
    }
  }
  return failures;
}
