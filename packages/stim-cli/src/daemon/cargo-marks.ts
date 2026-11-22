import { realpath } from 'node:fs/promises';
import { dirname, sep } from 'node:path';
import { isClaimUnavailable } from '@stim-cli/core/ownership-claim';
import type { StimContext } from '@stim-cli/core';
import type { GcMark, GcMarkCandidate } from '@stim-cli/core/state';
import { targetedCheckouts } from '../workspace/discovery.ts';
import type { Config } from '../workspace/config.ts';
import { listedRoots } from '../commands/gc/worktrees.ts';
import { answered } from '../workspace/bounded-read.ts';
import { resolveSourceCheckoutAsync } from '../workspace/worktree.ts';

async function currentCargoHolder(root: string, operation?: StimContext): Promise<string | null> {
  const identity = await answered(root, () => realpath(root), 3_000, operation?.signal);
  const source = await resolveSourceCheckoutAsync(root, {
    env: operation?.env,
    signal: operation?.signal,
    declareFor: operation,
    cache: false,
    timeoutMs: 3_000,
  });
  if ('refusal' in source) return null;
  return (
    source.entries
      .filter(
        (entry) =>
          !entry.bare && !entry.prunable && (identity === entry.path || identity.startsWith(`${entry.path}${sep}`)),
      )
      .toSorted((a, b) => b.path.length - a.path.length)[0]?.path ?? null
  );
}

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
      const holder = await currentCargoHolder(root, operation);
      const saved = holder && wanted.get(holder);
      if (saved) allowed.add(saved);
      if (allowed.size === wanted.size) break;
    } catch (error) {
      if (isClaimUnavailable(error) && 'reportCleanup' in error) throw error;
      operation?.signal.throwIfAborted();
    }
  }
  return allowed;
}

export async function discoveredCargoHolders(
  config: Config,
  marks: readonly GcMark[],
  operation?: StimContext,
): Promise<Set<string>> {
  const vias = [...new Set(marks.flatMap((mark) => mark.cargoVia ?? []))];
  const allowed = new Set<string>();
  if (!vias.length) return allowed;
  const current = new Set((await targetedCheckouts(config, listedRoots(), vias, operation)).map(({ path }) => path));
  const holders = new Map<string, Promise<string | null>>();
  for (const mark of marks) {
    operation?.signal.throwIfAborted();
    if (!mark.cargoVia?.some((via) => current.has(via))) continue;
    try {
      const identity = await answered(mark.root, () => realpath(mark.root), 3_000, operation?.signal);
      for (const via of mark.cargoVia) {
        if (!current.has(via)) continue;
        let holder = holders.get(via);
        if (!holder) holders.set(via, (holder = currentCargoHolder(via, operation)));
        if ((await holder) === identity) {
          allowed.add(mark.root);
          break;
        }
      }
    } catch (error) {
      if (isClaimUnavailable(error) && 'reportCleanup' in error) throw error;
      operation?.signal.throwIfAborted();
    }
  }
  return allowed;
}

export async function discoveredCargoCandidates(mark: GcMark, operation?: StimContext): Promise<GcMarkCandidate[]> {
  const candidates: GcMarkCandidate[] = [];
  for (const candidate of mark.candidates) {
    if (candidate.kind !== 'cargo-target') continue;
    try {
      if ((await currentCargoHolder(dirname(candidate.path), operation)) === mark.root) candidates.push(candidate);
    } catch (error) {
      if (isClaimUnavailable(error) && 'reportCleanup' in error) throw error;
      operation?.signal.throwIfAborted();
    }
  }
  return candidates;
}
