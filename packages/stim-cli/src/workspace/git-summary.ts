import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, posix } from 'node:path';
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
  const guarded = ['Desktop', 'Documents', 'Downloads', 'Library/Mobile Documents', 'Library/CloudStorage'].map((dir) =>
    posix.join(home, dir),
  );
  return [...guarded, '/Volumes'].some((dir) => path === dir || path.startsWith(`${dir}/`));
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

function mergedInto(
  path: string,
  head: string,
  target: DefaultBranch & { sha: string },
  budget: { deadline?: number },
) {
  const targetKey = `${target.ref} ${target.sha}`;
  const cached = readMergeCache(path);
  const known = cached?.head === head ? cached : null;
  if (known?.target === targetKey) return known.mergedInto;
  if (budget.deadline !== undefined && Date.now() > budget.deadline) {
    return known?.target.startsWith(`${target.ref} `) ? known.mergedInto : null;
  }
  budget.deadline ??= Date.now() + MERGE_BUDGET_MS;
  const state = mergeState(path, target, { timeoutMs: GIT_TIMEOUT_MS });
  if (!state.merged && state.timedOut) return null;
  const verdict = state.merged ? state.into : null;
  writeMergeCache({ path, head, target: targetKey, mergedInto: verdict });
  return verdict;
}

const recent = new Map<string, { at: number; git: WorktreeGit | null }>();

/**
 * Reads every worktree's git summary in parallel, each git call bounded by a timeout. A worktree `skip` rejects, or
 * one git cannot answer in time, maps to null. After every read, merge verdicts missing from the cache are judged one
 * at a time; no new judgement starts 250 ms after the first, and a verdict for the same HEAD judged at an older
 * default-branch commit stands in, because a merged branch stays merged. With `maxAgeMs`, a summary read that
 * recently in this process is reused.
 */
export async function readWorktreeGit(
  worktrees: readonly WorktreeFacts[],
  { skip, maxAgeMs = 0 }: { skip: (worktree: WorktreeFacts) => boolean; maxAgeMs?: number },
): Promise<Map<string, WorktreeGit | null>> {
  const now = Date.now();
  const targets = new Map<string, ReturnType<typeof defaultBranchOf>>();
  const reads = await Promise.all(
    worktrees.map(async (worktree) => {
      const memo = recent.get(worktree.path);
      if (memo && now - memo.at < maxAgeMs) return { path: worktree.path, memo: memo.git };
      if (skip(worktree)) return { path: worktree.path, memo: null };
      const repository = worktree.repository;
      if (repository && !targets.has(repository)) targets.set(repository, defaultBranchOf(repository));
      const [out, target] = await Promise.all([
        git(worktree.path, ['status', '--porcelain=v2', '--branch', '--untracked-files=normal']),
        repository ? targets.get(repository) : null,
      ]);
      return { path: worktree.path, status: out === null ? null : parseGitStatus(out), target };
    }),
  );
  const budget: { deadline?: number } = {};
  const summaries = new Map<string, WorktreeGit | null>();
  for (const read of reads) {
    if ('memo' in read || !read.status) {
      summaries.set(read.path, 'memo' in read ? (read.memo ?? null) : null);
      continue;
    }
    const { head, ...counts } = read.status;
    const summary = {
      ...counts,
      mergedInto: head && read.target ? mergedInto(read.path, head, read.target, budget) : null,
    };
    recent.set(read.path, { at: now, git: summary });
    summaries.set(read.path, summary);
  }
  return summaries;
}
