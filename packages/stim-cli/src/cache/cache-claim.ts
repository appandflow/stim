import { mkdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { canonicalPath } from '../commands/gc/paths.ts';
import { formatElapsed, phaseLine } from '../command-output.ts';
import {
  CLAIM_UNAVAILABLE,
  claimFailure,
  isClaimRefusal,
  isClaimUnavailable,
  readClaimSet,
  releaseClaim,
  tryAcquireClaim,
  type ClaimFailure,
  type ClaimHandle,
  type ClaimHolder,
} from '../ownership-claim.ts';

const LABEL = 'cache';
const POLL_MS = 500;
const EMPTYING_WAIT_MS = 10 * 60_000;

/**
 * The claim set guarding a cache Stim can only empty whole. It sits beside the cache, so emptying the cache never
 * removes it, and its parent is resolved so a build and an emptier name the same set before the cache exists.
 */
export function cacheClaimRoot(dir: string): string {
  return join(canonicalPath(dirname(dir)), `${basename(dir)}.claims`);
}

function describe(holder: ClaimHolder): string {
  const { platform, projectRoot } = holder.details;
  const where = typeof projectRoot === 'string' ? ` in ${projectRoot}` : '';
  return holder.mode === 'shared'
    ? `the ${typeof platform === 'string' ? platform : 'iOS'} build (pid ${holder.owner.pid}${where}) may be using it`
    : `pid ${holder.owner.pid} is emptying it`;
}

/** Why the cache at `dir` may be in use, from its claim set, without taking or removing any claim. */
export function cacheUser(dir: string): string | undefined {
  const root = cacheClaimRoot(dir);
  const survey = readClaimSet(root);
  const problem = survey.unresolved[0];
  if (problem) return `the cache claim ${problem.path} is unresolved, so a build may be using it`;
  const holder = survey.live[0];
  return holder ? describe(holder) : undefined;
}

/**
 * Takes the exclusive claim an emptier holds while it removes the cache's contents; a string is why it cannot.
 * It never waits for a build that holds the cache.
 */
export function claimForEmptying(dir: string): ClaimHandle | string {
  try {
    const attempt = tryAcquireClaim({ root: cacheClaimRoot(dir), mode: 'exclusive', label: LABEL });
    if (attempt.acquired) return attempt.acquired;
    if (attempt.pending) releaseClaim(attempt.pending);
    const holder = attempt.held ?? attempt.waitingFor?.[0];
    return holder ? describe(holder) : `its claim at ${cacheClaimRoot(dir)} could not be taken`;
  } catch (error) {
    if (isClaimRefusal(error) || isClaimUnavailable(error)) return error.message;
    return `its claim at ${cacheClaimRoot(dir)} could not be taken: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * Takes the shared claim a build holds on the compilation cache it compiles with, waiting while an emptier holds it.
 * A claim set Stim cannot resolve, or no process identity, is a failure: the build never runs unguarded.
 */
export async function shareCompilationCache({
  dir,
  projectRoot,
  note,
  signal,
}: {
  dir: string;
  projectRoot: string;
  note: (line: string) => void;
  signal?: AbortSignal;
}): Promise<{ claim: ClaimHandle } | { failure: ClaimFailure }> {
  const root = cacheClaimRoot(dir);
  const started = Date.now();
  let told = false;
  for (;;) {
    signal?.throwIfAborted();
    let attempt;
    try {
      mkdirSync(dirname(dir), { recursive: true });
      attempt = tryAcquireClaim({ root, mode: 'shared', label: LABEL, details: { platform: 'ios', projectRoot } });
    } catch (error) {
      return {
        failure: claimFailure(error, null) ?? {
          code: CLAIM_UNAVAILABLE,
          message: `Stim could not take the compilation cache claim at ${root}: ${error instanceof Error ? error.message : String(error)}.`,
          remedy: `Restore write access to ${dirname(root)}, then retry the same Stim command.`,
        },
      };
    }
    if (attempt.acquired) return { claim: attempt.acquired };
    const emptier = attempt.held ? `pid ${attempt.held.owner.pid}` : 'another process';
    const waited = Date.now() - started;
    if (waited >= EMPTYING_WAIT_MS)
      return {
        failure: {
          code: 'STIM_BUILD_FAILED',
          message: `${emptier} has been emptying the compilation cache at ${dir} for ${formatElapsed(waited)}.`,
          remedy: 'Run the same command again once it has finished.',
        },
      };
    if (!told) note(phaseLine('build', `waiting for ${emptier} to finish emptying the compilation cache at ${dir}`));
    told = true;
    await sleep(POLL_MS);
  }
}
