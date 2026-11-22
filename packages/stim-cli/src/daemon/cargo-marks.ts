import { realpath } from 'node:fs/promises';
import { sep } from 'node:path';
import { isClaimUnavailable } from '@stim-cli/core/ownership-claim';
import type { StimContext } from '@stim-cli/core';
import type { Config } from '../workspace/config.ts';
import { listedRoots } from '../commands/gc/worktrees.ts';
import { answered } from '../workspace/bounded-read.ts';
import { resolveSourceCheckoutAsync } from '../workspace/worktree.ts';

/** Saved Git holders currently reached through a registered workspace, without listing sibling folders. */
export async function registeredCargoHolders(
  config: Config,
  roots: readonly string[],
  operation?: StimContext,
): Promise<Set<string>> {
  const registered = new Set([...Object.keys(config.projects), ...listedRoots()]);
  if (!registered.size || !roots.length) return new Set();
  const wanted = new Map<string, string>();
  const allowed = new Set<string>();
  for (const root of roots) {
    try {
      wanted.set(await answered(root, () => realpath(root), 3_000, operation?.signal), root);
    } catch (error) {
      if (isClaimUnavailable(error) && 'reportCleanup' in error) throw error;
      operation?.signal.throwIfAborted();
    }
  }
  if (!wanted.size) return allowed;
  for (const root of registered) {
    operation?.signal.throwIfAborted();
    try {
      const identity = await answered(root, () => realpath(root), 3_000, operation?.signal);
      const source = await resolveSourceCheckoutAsync(root, {
        env: operation?.env,
        signal: operation?.signal,
        declareFor: operation,
        cache: false,
        timeoutMs: 3_000,
      });
      if ('refusal' in source) continue;
      const holder = source.entries
        .filter(
          (entry) =>
            !entry.bare && !entry.prunable && (identity === entry.path || identity.startsWith(`${entry.path}${sep}`)),
        )
        .toSorted((a, b) => b.path.length - a.path.length)[0];
      const saved = holder && wanted.get(holder.path);
      if (saved) allowed.add(saved);
      if (allowed.size === wanted.size) break;
    } catch (error) {
      if (isClaimUnavailable(error) && 'reportCleanup' in error) throw error;
      operation?.signal.throwIfAborted();
    }
  }
  return allowed;
}
