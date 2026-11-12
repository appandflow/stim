import type { StimContext } from '@stim-cli/core';
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
