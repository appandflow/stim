import { existsSync } from 'fs';
import { isAbsolute } from 'path';
import chalk from 'chalk';
import { plural } from '../../command-output.ts';
import { loadConfig } from '../../workspace/config.ts';
import { workspaceInUse } from '../../workspace/in-use.ts';
import { workspaceLastUsed } from '../../workspace/workspace-state.ts';
import {
  dirtyPaths,
  hasPopulatedSubmodules,
  hasUncommittedWork,
  listWorktrees,
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
}

interface WorktreeCandidate {
  path: string;
  keys: string[];
  idleDays: number | null;
  skipped: string | null;
}

export interface WorktreeSweep {
  olderThan: number;
  defaulted: boolean;
  worktrees: WorktreeCandidate[];
}

export function worktreeSkipReason(facts: WorktreeFacts, olderThan: number): string | null {
  if (facts.bare) return 'bare repository';
  if (typeof facts.source === 'object') return `source checkout unknown: ${facts.source.refusal}`;
  if (facts.source === 'source') return 'source checkout';
  if (facts.locked) return 'locked with git worktree lock';
  if (facts.inUse.length) return `in use: ${facts.inUse.join('; ')}`;
  if (facts.porcelain === null) return 'git status could not be read';
  if (excludePodChurn(facts.porcelain).lines.length) return 'dirty: uncommitted changes or untracked files';
  if (facts.unpushed === null) return 'unpushed commits could not be checked';
  if (facts.unpushed.length) return `unpushed: ${plural(facts.unpushed.length, 'commit')} on no remote or other branch`;
  if (facts.submodules) return 'initialized submodules';
  if (facts.idleDays === null) return 'recently used: its last use is unknown';
  if (facts.idleDays < olderThan) return `recently used ${facts.idleDays}d ago`;
  return null;
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

export function collectWorktreeSweep({ olderThan, now }: { olderThan: number | null; now: number }): WorktreeSweep {
  const days = olderThan ?? DEFAULT_WORKTREE_IDLE_DAYS;
  const groups = new Map<string, string[]>();
  const outside: WorktreeCandidate[] = [];
  for (const root of candidateRoots()) {
    const entry = matchWorktreeEntry(listWorktrees(root), root);
    if (!entry) {
      outside.push({ path: root, keys: [root], idleDays: null, skipped: 'not inside a git worktree' });
      continue;
    }
    groups.set(entry.path, [...(groups.get(entry.path) ?? []), root]);
  }
  const worktrees: WorktreeCandidate[] = [];
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
    };
    worktrees.push({ path, keys, idleDays, skipped: worktreeSkipReason(facts, days) });
  }
  return { olderThan: days, defaulted: olderThan === null, worktrees: [...worktrees, ...outside] };
}

export async function removeWorktrees(
  sweep: WorktreeSweep,
  { now = Date.now() }: { now?: number } = {},
): Promise<number> {
  let failures = 0;
  for (const candidate of sweep.worktrees) {
    if (candidate.skipped) continue;
    const guard = (lockedKeys: readonly string[]): string[] => {
      const keys = [...new Set([...candidate.keys, ...lockedKeys])];
      const unlocked = keys.filter((key) => !lockedKeys.includes(key));
      const reasons = [
        ...inUseOf(lockedKeys, { managedLocks: false }),
        ...inUseOf(unlocked, { managedLocks: true }),
      ].map((r) => `in use: ${r}`);
      const idleDays = idleDaysOf(keys, now);
      if (idleDays === null || idleDays < sweep.olderThan) {
        reasons.push(`used ${idleDays === null ? 'at an unknown time' : `${idleDays}d ago`} since gc checked it`);
      }
      return reasons;
    };
    let removed = false;
    try {
      removed = await removeWorktreeTarget(candidate.path, { linkedOnly: true, guard });
    } catch (error) {
      console.log(chalk.red(`Could not remove ${candidate.path}: ${(error as Error)?.message || String(error)}`));
    }
    if (removed) {
      console.log(chalk.green(`Removed the worktree ${candidate.path}`));
    } else {
      failures++;
      console.log(chalk.yellow(`Kept the worktree ${candidate.path}; see the lines above for why.`));
    }
  }
  return failures;
}
