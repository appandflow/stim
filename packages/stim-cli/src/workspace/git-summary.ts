import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { gitMergeCacheDir, type WorktreeFacts, type WorktreeGit } from '@stim-cli/core/state';
import { getExecutor } from '../exec.ts';
import { mergeState, type DefaultBranch } from './merge-state.ts';

const GIT_TIMEOUT_MS = 3000;
const MERGE_BUDGET_MS = 250;
const ORIGIN_PREFIX = 'refs/remotes/origin/';

export interface GitStatusSummary extends Omit<WorktreeGit, 'mergedInto'> {
  head: string | null;
}

/** Counts the entries of `git status --porcelain=v2 --branch` output. `head` is null on an unborn branch. */
export function parseGitStatus(text: string): GitStatusSummary {
  const summary: GitStatusSummary = { head: null, changed: 0, untracked: 0, upstream: null, ahead: null, behind: null };
  for (const line of text.split('\n')) {
    if (line.startsWith('# branch.oid ')) {
      const oid = line.slice('# branch.oid '.length);
      summary.head = /^[\da-f]{40,64}$/.test(oid) ? oid : null;
    } else if (line.startsWith('# branch.upstream ')) {
      summary.upstream = line.slice('# branch.upstream '.length);
    } else if (line.startsWith('# branch.ab ')) {
      const counts = /^\+(\d+) -(\d+)$/.exec(line.slice('# branch.ab '.length));
      if (counts) {
        summary.ahead = Number(counts[1]);
        summary.behind = Number(counts[2]);
      }
    } else if (/^[12u] /.test(line)) {
      summary.changed++;
    } else if (line.startsWith('? ')) {
      summary.untracked++;
    }
  }
  return summary;
}

/**
 * Folders macOS guards with a privacy prompt (TCC) that names the app responsible for the reading process. Stim
 * Desktop runs status as its child, so status opens a worktree there only when the user registered an environment in it.
 */
export function inPrivacyProtectedFolder(path: string, home: string): boolean {
  const guarded = ['Desktop', 'Documents', 'Downloads', join('Library', 'Mobile Documents')].map((dir) =>
    join(home, dir),
  );
  return [...guarded, '/Volumes'].some((dir) => path === dir || path.startsWith(dir + sep));
}

async function git(path: string, args: string[]): Promise<string | null> {
  try {
    return await getExecutor().runFileAsync('git', ['--no-optional-locks', '-C', path, ...args], {
      timeoutMs: GIT_TIMEOUT_MS,
    });
  } catch {
    return null;
  }
}

async function defaultBranchOf(repository: string): Promise<(DefaultBranch & { sha: string }) | null> {
  const out = await git(repository, ['for-each-ref', '--format=%(symref) %(objectname)', 'refs/remotes/origin/HEAD']);
  const [ref, sha] = (out ?? '').split(' ');
  if (!ref?.startsWith(ORIGIN_PREFIX) || !sha) return null;
  return { ref, name: `origin/${ref.slice(ORIGIN_PREFIX.length)}`, sha };
}

function mergeCacheFile(path: string): string {
  return join(gitMergeCacheDir(), `${createHash('sha256').update(path).digest('hex').slice(0, 32)}.json`);
}

interface MergeCacheEntry {
  path: string;
  head: string;
  target: string;
  mergedInto: string | null;
}

function readMergeCache(path: string): MergeCacheEntry | null {
  try {
    const entry = JSON.parse(readFileSync(mergeCacheFile(path), 'utf-8')) as Partial<MergeCacheEntry>;
    if (entry.path !== path || typeof entry.head !== 'string' || typeof entry.target !== 'string') return null;
    return { path, head: entry.head, target: entry.target, mergedInto: entry.mergedInto ?? null };
  } catch {
    return null;
  }
}

function writeMergeCache(entry: MergeCacheEntry): void {
  const file = mergeCacheFile(entry.path);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    mkdirSync(gitMergeCacheDir(), { recursive: true });
    writeFileSync(temporary, JSON.stringify(entry));
    renameSync(temporary, file);
  } catch {
    rmSync(temporary, { force: true });
  }
}

/**
 * `gc`'s merge verdict for HEAD, cached per worktree with the HEAD and default-branch commit it was judged at. Past
 * `deadline`, a verdict for the same HEAD judged at an older default-branch commit stands in: the branch may have
 * merged since, but a merged branch stays merged.
 */
function mergedInto(path: string, head: string, target: DefaultBranch & { sha: string }, deadline: number) {
  const targetKey = `${target.ref} ${target.sha}`;
  const cached = readMergeCache(path);
  const known = cached?.head === head ? cached : null;
  if (known && (known.target === targetKey || Date.now() > deadline)) return known.mergedInto;
  if (Date.now() > deadline) return null;
  const state = mergeState(path, target, { timeoutMs: GIT_TIMEOUT_MS });
  const verdict = state.merged ? state.into : null;
  writeMergeCache({ path, head, target: targetKey, mergedInto: verdict });
  return verdict;
}

const recent = new Map<string, { at: number; git: WorktreeGit | null }>();

/**
 * Reads every worktree's git summary in parallel, each git call bounded by a timeout. A worktree `skip` rejects, or
 * one git cannot answer in time, maps to null. Merge verdicts missing from the cache are judged for up to 250 ms per
 * call; later calls judge the rest. With `maxAgeMs`, a summary read that recently in this process is reused.
 */
export async function readWorktreeGit(
  worktrees: readonly WorktreeFacts[],
  { skip, maxAgeMs = 0 }: { skip: (worktree: WorktreeFacts) => boolean; maxAgeMs?: number },
): Promise<Map<string, WorktreeGit | null>> {
  const now = Date.now();
  const targets = new Map<string, ReturnType<typeof defaultBranchOf>>();
  let deadline: number | undefined;
  const reads = worktrees.map(async (worktree): Promise<[string, WorktreeGit | null]> => {
    const memo = recent.get(worktree.path);
    if (memo && now - memo.at < maxAgeMs) return [worktree.path, memo.git];
    if (skip(worktree)) return [worktree.path, null];
    const repository = worktree.repository;
    if (repository && !targets.has(repository)) targets.set(repository, defaultBranchOf(repository));
    const [out, target] = await Promise.all([
      git(worktree.path, ['status', '--porcelain=v2', '--branch', '--untracked-files=normal']),
      repository ? targets.get(repository) : null,
    ]);
    if (out === null) return [worktree.path, null];
    const { head, ...counts } = parseGitStatus(out);
    deadline ??= Date.now() + MERGE_BUDGET_MS;
    const summary = {
      ...counts,
      mergedInto: head && target ? mergedInto(worktree.path, head, target, deadline) : null,
    };
    recent.set(worktree.path, { at: now, git: summary });
    return [worktree.path, summary];
  });
  return new Map(await Promise.all(reads));
}
