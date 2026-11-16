import { lstat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { StimContext } from '@stim-cli/core';
import { canonicalPath } from '../commands/gc/paths.ts';
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

/**
 * The git worktree root that owns `path`: its nearest ancestor, itself included, holding a `.git` entry, read with one
 * lstat per level and no git process. A path in no git checkout owns itself. A registered app inside a monorepo is
 * owned by the worktree root, which is where an executable on PATH can point.
 */
export async function checkoutRootOf(path: string): Promise<string> {
  const start = canonicalPath(path);
  for (let dir = start; ; dir = dirname(dir)) {
    try {
      await lstat(join(dir, '.git'));
      return dir;
    } catch {}
    if (dirname(dir) === dir) return start;
  }
}
