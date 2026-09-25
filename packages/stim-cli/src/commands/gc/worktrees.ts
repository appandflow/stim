import { existsSync } from 'fs';
import { isAbsolute } from 'path';
import chalk from 'chalk';
import { plural } from '../../command-output.ts';
import { loadConfig } from '../../workspace/config.ts';
import { workspaceInUse } from '../../workspace/in-use.ts';
import { workspaceLastUsed } from '../../workspace/workspace-state.ts';
import { fetchDefaultBranch, mergeState, type MergeState } from '../../workspace/merge-state.ts';
import {
  dirtyPaths,
  gitCommonDir,
  hasPopulatedSubmodules,
  hasUncommittedWork,
  listWorktrees,
  resolveFullRef,
  sourceCheckoutOf,
  unpushedCommits,
} from '../../workspace/worktree.ts';
import { excludePodChurn, matchWorktreeEntry, reclaimKeys, removeWorktreeTarget } from '../worktree.ts';
import { listWorkspaceDirs } from './workspaces.ts';

const DEFAULT_WORKTREE_IDLE_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface WorktreeFacts {
  source: 'source' | 'linked' | { refusal: string };
  bare: boolean;
  locked: boolean;
  porcelain: string[] | null;
  unpushed: string[] | null;
  submodules: boolean;
  inUse: string[];
  idleDays: number | null;
  merge: MergeState | null;
}

export type WorktreeSkipCode =
  | 'not-a-worktree'
  | 'bare-repository'
  | 'source-checkout-unknown'
  | 'source-checkout'
  | 'locked'
  | 'in-use'
  | 'status-unreadable'
  | 'dirty'
  | 'unpushed-unchecked'
  | 'unpushed'
  | 'submodules'
  | 'not-merged'
  | 'merge-unknown'
  | 'last-use-unknown'
  | 'recently-used';

interface WorktreeSkip {
  code: WorktreeSkipCode;
  text: string;
}

interface WorktreeCandidate {
  path: string;
  keys: string[];
  idleDays: number | null;
  merge: MergeState | null;
  skipCode: WorktreeSkipCode | null;
  skipped: string | null;
}

export interface WorktreeSweep {
  idle: { olderThan: number; defaulted: boolean } | null;
  worktrees: WorktreeCandidate[];
}

const MERGE_DECIDES: ReadonlySet<WorktreeSkipCode> = new Set([
  'unpushed',
  'not-merged',
  'last-use-unknown',
  'recently-used',
]);

function skip(code: WorktreeSkipCode, text: string): WorktreeSkip {
  return { code, text };
}

export function worktreeSkipReason(facts: WorktreeFacts, olderThan: number | null): WorktreeSkip | null {
  if (facts.bare) return skip('bare-repository', 'bare repository');
  if (typeof facts.source === 'object') {
    return skip('source-checkout-unknown', `source checkout unknown: ${facts.source.refusal}`);
  }
  if (facts.source === 'source') return skip('source-checkout', 'source checkout');
  if (facts.locked) return skip('locked', 'locked with git worktree lock');
  if (facts.inUse.length) return skip('in-use', `in use: ${facts.inUse.join('; ')}`);
  if (facts.porcelain === null) return skip('status-unreadable', 'git status could not be read');
  if (excludePodChurn(facts.porcelain).lines.length) {
    return skip('dirty', 'dirty: uncommitted changes or untracked files');
  }
  if (facts.unpushed === null) return skip('unpushed-unchecked', 'unpushed commits could not be checked');
  const merged = facts.merge?.merged ? facts.merge : null;
  if (facts.unpushed.length && !merged?.coversUnpushed) {
    return skip('unpushed', `unpushed: ${plural(facts.unpushed.length, 'commit')} on no remote or other branch`);
  }
  if (facts.submodules) return skip('submodules', 'initialized submodules');
  if (merged) return null;
  const notMerged = facts.merge && !facts.merge.merged ? facts.merge : null;
  if (olderThan === null) {
    return skip(notMerged?.unknown ? 'merge-unknown' : 'not-merged', notMerged?.detail ?? 'not merged');
  }
  const also = notMerged ? `; ${notMerged.detail}` : '';
  if (facts.idleDays === null) return skip('last-use-unknown', `recently used: its last use is unknown${also}`);
  if (facts.idleDays < olderThan) return skip('recently-used', `recently used ${facts.idleDays}d ago${also}`);
  return null;
}

/** Why gc removes a worktree it did not skip: `merged into origin/main` or `idle 9d`. */
export function worktreeRemovalReason(candidate: Pick<WorktreeCandidate, 'merge' | 'idleDays'>): string {
  return candidate.merge?.merged ? `merged into ${candidate.merge.into}` : `idle ${candidate.idleDays ?? 0}d`;
}

function lastUsedOf(keys: readonly string[]): number {
  const times = keys.map(workspaceLastUsed).filter(Number.isFinite);
  return times.length ? Math.max(...times) : NaN;
}

function idleDaysOf(keys: readonly string[], now: number): number | null {
  const last = lastUsedOf(keys);
  return Number.isFinite(last) ? Math.max(0, Math.floor((now - last) / DAY_MS)) : null;
}

function inUseOf(keys: readonly string[], checks: { managedLocks: boolean }): string[] {
  return [...new Set(keys.flatMap((key) => workspaceInUse(key, checks)))];
}

function porcelainOf(path: string, gitAnswered: boolean | null): string[] | null {
  if (gitAnswered === null) return null;
  if (!gitAnswered) return [];
  const lines = dirtyPaths(path, { limit: Infinity });
  return lines.length ? lines : null;
}

function candidateRoots(): string[] {
  const registered = Object.keys(loadConfig()?.projects ?? {}).filter(isAbsolute);
  const recorded = listWorkspaceDirs().flatMap((entry) => (entry.projectRoot ? [entry.projectRoot] : []));
  return [...new Set([...registered, ...recorded])].filter((root) => existsSync(root)).toSorted();
}

function checkMergeStates(pending: { candidate: WorktreeCandidate; facts: WorktreeFacts }[], idle: number | null) {
  const repos = new Map<string, typeof pending>();
  for (const entry of pending) {
    const common = gitCommonDir(entry.candidate.path) ?? entry.candidate.path;
    repos.set(common, [...(repos.get(common) ?? []), entry]);
  }
  for (const entries of repos.values()) {
    const target = fetchDefaultBranch(entries[0]!.candidate.path);
    for (const { candidate, facts } of entries) {
      const merge: MergeState =
        'error' in target
          ? { merged: false, unknown: true, detail: `merge state unknown: ${target.error}` }
          : mergeState(candidate.path, target);
      const verdict = worktreeSkipReason({ ...facts, merge }, idle);
      Object.assign(candidate, { merge, skipCode: verdict?.code ?? null, skipped: verdict?.text ?? null });
    }
  }
}

/**
 * Classifies each Stim-managed linked worktree. A merged one is removable; with `idle`, so is one unused for
 * `olderThan` days. Merge state is checked only where it decides the verdict, after one fetch per repository.
 */
export function collectWorktreeSweep({
  idle,
  olderThan,
  now,
}: {
  idle: boolean;
  olderThan: number | null;
  now: number;
}): WorktreeSweep {
  const days = idle ? (olderThan ?? DEFAULT_WORKTREE_IDLE_DAYS) : null;
  const groups = new Map<string, string[]>();
  const outside: WorktreeCandidate[] = [];
  for (const root of candidateRoots()) {
    const entry = matchWorktreeEntry(listWorktrees(root), root);
    if (!entry) {
      outside.push({
        path: root,
        keys: [root],
        idleDays: null,
        merge: null,
        skipCode: 'not-a-worktree',
        skipped: 'not inside a git worktree',
      });
      continue;
    }
    groups.set(entry.path, [...(groups.get(entry.path) ?? []), root]);
  }
  const worktrees: WorktreeCandidate[] = [];
  const pending: { candidate: WorktreeCandidate; facts: WorktreeFacts }[] = [];
  for (const [path, roots] of groups) {
    const entries = listWorktrees(path);
    const entry = matchWorktreeEntry(entries, path);
    const source = sourceCheckoutOf(entries);
    const keys = [...new Set([...roots, ...reclaimKeys(path)])];
    const idleDays = idleDaysOf(keys, now);
    const linked = !('refusal' in source) && entry !== null && source.path !== entry.path;
    const gitAnswered = linked ? hasUncommittedWork(path) : null;
    const facts: WorktreeFacts = {
      source: 'refusal' in source ? source : linked ? 'linked' : 'source',
      bare: Boolean(entry?.bare),
      locked: Boolean(entry?.locked),
      porcelain: porcelainOf(path, gitAnswered),
      unpushed: linked ? unpushedCommits(path) : null,
      submodules: linked && hasPopulatedSubmodules(path),
      inUse: linked ? inUseOf(keys, { managedLocks: true }) : [],
      idleDays,
      merge: null,
    };
    const verdict = worktreeSkipReason(facts, days);
    const candidate: WorktreeCandidate = {
      path,
      keys,
      idleDays,
      merge: null,
      skipCode: verdict?.code ?? null,
      skipped: verdict?.text ?? null,
    };
    if (verdict && MERGE_DECIDES.has(verdict.code)) pending.push({ candidate, facts });
    worktrees.push(candidate);
  }
  checkMergeStates(pending, days);
  const listed = [...worktrees, ...outside].filter(
    (w) => idle || (w.skipCode !== 'not-a-worktree' && w.skipCode !== 'source-checkout'),
  );
  return { idle: days === null ? null : { olderThan: days, defaulted: olderThan === null }, worktrees: listed };
}

export async function removeWorktrees(
  sweep: WorktreeSweep,
  { now = Date.now() }: { now?: number } = {},
): Promise<number> {
  let failures = 0;
  for (const candidate of sweep.worktrees) {
    if (candidate.skipped) continue;
    let kept: string[] = [];
    const guard = (lockedKeys: readonly string[]): string[] => {
      const keys = [...new Set([...candidate.keys, ...lockedKeys])];
      const unlocked = keys.filter((key) => !lockedKeys.includes(key));
      const reasons = [
        ...inUseOf(lockedKeys, { managedLocks: false }),
        ...inUseOf(unlocked, { managedLocks: true }),
      ].map((r) => `in use: ${r}`);
      if (candidate.merge?.merged) {
        if (resolveFullRef(candidate.path, 'HEAD') !== candidate.merge.head) {
          reasons.push('its HEAD moved since gc checked it');
        }
      } else {
        const idleDays = idleDaysOf(keys, now);
        if (idleDays === null || !sweep.idle || idleDays < sweep.idle.olderThan) {
          reasons.push(`used ${idleDays === null ? 'at an unknown time' : `${idleDays}d ago`} since gc checked it`);
        }
      }
      kept = reasons;
      return reasons;
    };
    let removed = false;
    try {
      const mergedHead = candidate.merge?.merged && candidate.merge.coversUnpushed ? candidate.merge.head : undefined;
      removed = await removeWorktreeTarget(candidate.path, { linkedOnly: true, guard, mergedHead });
    } catch (error) {
      console.error(chalk.red(`Could not remove ${candidate.path}: ${(error as Error)?.message || String(error)}`));
    }
    if (removed) {
      console.log(chalk.green(`Removed the worktree ${candidate.path} (${worktreeRemovalReason(candidate)})`));
    } else if (kept.length) {
      console.log(chalk.yellow(`Kept the worktree ${candidate.path}: ${kept.join('; ')}`));
    } else {
      failures++;
      console.error(chalk.yellow(`Kept the worktree ${candidate.path}; see the lines above for why.`));
    }
  }
  return failures;
}
