import { lstat, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { StimContext } from '@stim-cli/core';
import { answered, Unanswered } from './bounded-read.ts';
import {
  absent,
  describe,
  describeLauncherProblems,
  noteLauncherProblem,
  type Checkout,
  type LauncherProblem,
} from './launchers.ts';
import type { CheckoutRole } from '../policy/checkout-order.ts';
import { matchWorktreeEntry, resolveSourceCheckoutAsync, type SourceCheckout, type WorktreeEntry } from './worktree.ts';

/**
 * Whether `path` lies in a linked worktree. A path git does not place in a listed worktree, or a repository whose
 * source checkout git cannot name, counts as a source checkout, which maintenance reduces last.
 */
function classifyCheckout(entries: readonly WorktreeEntry[], source: SourceCheckout, path: string): CheckoutRole {
  if ('refusal' in source) return 'source';
  const entry = matchWorktreeEntry([...entries], path);
  return entry && !entry.bare && entry.path !== source.path ? 'linked' : 'source';
}

export async function checkoutRoleOf(path: string, operation?: StimContext): Promise<CheckoutRole> {
  const { entries, ...source } = await resolveSourceCheckoutAsync(path, {
    env: operation?.env,
    signal: operation?.signal,
    declareFor: operation,
  });
  return classifyCheckout(entries, source, path);
}

const PROBE_TIMEOUT_MS = 3000;

/**
 * The git worktree root that owns `path`: its nearest ancestor, itself included, holding a `.git` entry, read with
 * one bounded lstat per level, the abort checked between levels, and no git process. The climb stops at the
 * filesystem root, so a `.git` in the home folder makes the home folder the owner, which keeps more. A path in no
 * checkout owns itself. A level that cannot be read for any reason but proven absence (permission, I/O, a read that
 * does not answer) leaves the owner unknown, which keeps the checkout, never a narrower root.
 */
export async function checkoutRootOf(path: string, signal?: AbortSignal, operation?: StimContext): Promise<Checkout> {
  try {
    let start: string;
    try {
      start = await answered(path, () => realpath(path), PROBE_TIMEOUT_MS);
    } catch (error) {
      if (error instanceof Unanswered || !absent(error)) throw error;
      start = resolve(path);
    }
    for (let dir = start; ; dir = dirname(dir)) {
      signal?.throwIfAborted();
      try {
        await answered(dir, () => lstat(join(dir, '.git')), PROBE_TIMEOUT_MS);
        return dir;
      } catch (error) {
        if (error instanceof Unanswered || !absent(error)) throw error;
      }
      if (dirname(dir) === dir) return start;
    }
  } catch (error) {
    signal?.throwIfAborted();
    const problem: LauncherProblem = { kind: 'owner', path, error: describe(error) };
    if (operation) noteLauncherProblem(operation, problem);
    return { unknown: describeLauncherProblems([problem]), problem };
  }
}

/** The role of `path` and the git worktree root that owns it, from the worktree list git already gave for it. */
export async function checkoutOwnerOf(
  path: string,
  operation?: StimContext,
): Promise<{ role: CheckoutRole; checkout: Checkout }> {
  const { entries, ...source } = await resolveSourceCheckoutAsync(path, {
    env: operation?.env,
    signal: operation?.signal,
    declareFor: operation,
  });
  const entry = 'refusal' in source ? null : matchWorktreeEntry([...entries], path);
  return {
    role: classifyCheckout(entries, source, path),
    checkout: entry && !entry.bare ? entry.path : await checkoutRootOf(path, operation?.signal, operation),
  };
}
