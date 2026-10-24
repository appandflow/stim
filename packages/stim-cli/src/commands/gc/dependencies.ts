import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
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
import { listWorktrees, sourceCheckoutOf } from '../../workspace/worktree.ts';
import { workspaceKeys } from '../../workspace/lightened.ts';
import { canonicalPath } from './paths.ts';
import { GC_OUTPUT, type GcOutput } from './results.ts';
import { LIGHTEN_AFTER_MS } from './workspaces.ts';

export interface WorktreeDependencies {
  candidates: ArtifactCandidate[];
  skips: { target: string; reason: string }[];
}

const NO_RESTORE = 'Stim has no workspace in its worktree, so no start, ios or android run would restore it';
const LOCKFILES = ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'bun.lock', 'bun.lockb'];

function readOrNull(path: string): Buffer | null {
  try {
    return readFileSync(path);
  } catch {
    return null;
  }
}

/** Why `worktree warm` could not put back what was deleted at `path`: it copies the source checkout's copy. */
function restoreProblem({ worktree, path }: ArtifactCandidate, sources: Map<string, string | null>): string | null {
  if (!sources.has(worktree)) {
    const source = sourceCheckoutOf(listWorktrees(worktree));
    sources.set(worktree, 'refusal' in source ? null : source.path);
  }
  const source = sources.get(worktree);
  if (!source) return 'its source checkout cannot be resolved, so worktree warm could not restore it';
  const rel = relative(worktree, path);
  if (!existsSync(join(source, rel))) return `the source checkout has no ${rel} for worktree warm to copy back`;
  const pods = basename(rel) === 'Pods';
  const locks = pods
    ? [join(dirname(rel), 'Podfile.lock')]
    : [...new Set(['.', dirname(rel)])].flatMap((dir) => LOCKFILES.map((name) => join(dir, name)));
  const differs = locks.find((lock) => {
    const mine = readOrNull(join(worktree, lock));
    const theirs = readOrNull(join(source, lock));
    return mine === null ? theirs !== null : theirs === null || !mine.equals(theirs);
  });
  return differs
    ? `its ${differs} differs from the source checkout's, so worktree warm would restore other versions`
    : null;
}

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
  const sources = new Map<string, string | null>();
  const candidates: ArtifactCandidate[] = [];
  const skips = [...found.skips];
  for (const candidate of found.candidates) {
    const reason = workspaceKeys(candidate.keys).length ? restoreProblem(candidate, sources) : NO_RESTORE;
    if (reason) skips.push({ target: candidate.path, reason });
    else candidates.push(candidate);
  }
  return { candidates, skips };
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
