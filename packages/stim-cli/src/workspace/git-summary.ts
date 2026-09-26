import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, posix, resolve } from 'node:path';
import { gitMergeCacheDir, type WorktreeFacts, type WorktreeGit } from '@stim-cli/core/state';
import { getExecutor } from '../exec.ts';
import { mergeState, type DefaultBranch } from './merge-state.ts';

const GIT_TIMEOUT_MS = 3000;
const MERGE_BUDGET_MS = 250;
const MERGE_TIMEOUT_BACKOFF_MS = 5 * 60_000;
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
): { into: string | null; deferred: boolean } {
  const targetKey = `${target.ref} ${target.sha}`;
  const cached = readMergeCache(path);
  const known = cached?.head === head ? cached : null;
  if (known?.target === targetKey) return { into: known.mergedInto, deferred: false };
  const standIn = known?.target.startsWith(`${target.ref} `) ? known.mergedInto : null;
  const timeoutKey = `${head} ${targetKey}`;
  const timedOut = mergeTimeouts.get(path);
  if (timedOut?.key === timeoutKey && Date.now() - timedOut.at < MERGE_TIMEOUT_BACKOFF_MS) {
    return { into: standIn, deferred: false };
  }
  if (budget.deadline !== undefined && Date.now() > budget.deadline) return { into: standIn, deferred: true };
  budget.deadline ??= Date.now() + MERGE_BUDGET_MS;
  const state = mergeState(path, target, { timeoutMs: GIT_TIMEOUT_MS });
  if (!state.merged && state.timedOut) {
    mergeTimeouts.set(path, { key: timeoutKey, at: Date.now() });
    return { into: standIn, deferred: false };
  }
  const verdict = state.merged ? state.into : null;
  writeMergeCache({ path, head, target: targetKey, mergedInto: verdict });
  return { into: verdict, deferred: false };
}

interface StampedRefs {
  upstream: string | null;
  target: string | null;
}

const mergeTimeouts = new Map<string, { key: string; at: number }>();
const recent = new Map<string, { at: number; files: string | null; refs: StampedRefs; git: WorktreeGit | null }>();

function gitDirsOf(worktree: string): { gitDir: string; commonDir: string } | null {
  try {
    const dotGit = join(worktree, '.git');
    const pointer = statSync(dotGit).isDirectory()
      ? null
      : /^gitdir: (.+)$/m.exec(readFileSync(dotGit, 'utf-8'))?.[1]?.trim();
    const gitDir = pointer ? resolve(worktree, pointer) : pointer === null ? dotGit : null;
    if (!gitDir) return null;
    try {
      return { gitDir, commonDir: resolve(gitDir, readFileSync(join(gitDir, 'commondir'), 'utf-8').trim()) };
    } catch {
      return { gitDir, commonDir: gitDir };
    }
  } catch {
    return null;
  }
}

function fileStamp(path: string): string {
  try {
    const stat = statSync(path, { bigint: true });
    return `${stat.ino}:${stat.mtimeNs}:${stat.size}`;
  } catch {
    return '-';
  }
}

/**
 * Stamps the git files a summary depends on: the worktree's index, HEAD and reflog, and the common dir's packed refs,
 * last fetch, origin/HEAD, default-branch ref, branch ref and upstream ref. Edits, creations and deletions of files
 * that are not staged touch none of them. `missing` when the worktree has no git dir, such as a deleted worktree git
 * still lists; it is then stamped by its `.git` entry alone.
 */
function gitFilesStamp(worktree: WorktreeFacts, refs: StampedRefs): { stamp: string; missing: boolean } {
  const dirs = gitDirsOf(worktree.path);
  if (!dirs) return { stamp: fileStamp(join(worktree.path, '.git')), missing: true };
  const { gitDir, commonDir } = dirs;
  const files = [
    join(gitDir, 'index'),
    join(gitDir, 'HEAD'),
    join(gitDir, 'logs', 'HEAD'),
    join(commonDir, 'packed-refs'),
    join(commonDir, 'FETCH_HEAD'),
    join(commonDir, 'refs', 'remotes', 'origin', 'HEAD'),
    ...(refs.target ? [join(commonDir, refs.target)] : []),
    ...(worktree.branch ? [join(commonDir, 'refs', 'heads', worktree.branch)] : []),
    ...(refs.upstream
      ? [join(commonDir, 'refs', 'remotes', refs.upstream), join(commonDir, 'refs', 'heads', refs.upstream)]
      : []),
  ];
  return { stamp: files.map(fileStamp).join(' '), missing: false };
}

/**
 * Reads every worktree's git summary in parallel, each git call bounded by a timeout. A worktree `skip` rejects, or
 * one git cannot answer in time, maps to null. After every read, merge verdicts missing from the cache are judged one
 * at a time; no new judgement starts 250 ms after the first, and a verdict for the same HEAD judged at an older
 * default-branch commit stands in, because a merged branch stays merged. A judgement that timed out is not retried
 * for the same HEAD and target for five minutes. With `maxAgeMs`, a summary made that recently in this process is
 * reused while the git files it depends on are unchanged, so a change that is not staged can take up to `maxAgeMs`
 * to show; so is the null of a worktree whose directory is gone.
 */
export async function readWorktreeGit(
  worktrees: readonly WorktreeFacts[],
  { skip, maxAgeMs = 0 }: { skip: (worktree: WorktreeFacts) => boolean; maxAgeMs?: number },
): Promise<Map<string, WorktreeGit | null>> {
  const now = Date.now();
  const targets = new Map<string, ReturnType<typeof defaultBranchOf>>();
  const reads = await Promise.all(
    worktrees.map(async (worktree) => {
      if (skip(worktree)) return { path: worktree.path, memo: null };
      const memo = maxAgeMs > 0 ? recent.get(worktree.path) : undefined;
      const refs = memo?.refs ?? { upstream: null, target: null };
      const files = maxAgeMs > 0 ? gitFilesStamp(worktree, refs) : null;
      if (memo && memo.files !== null && memo.files === files?.stamp && now - memo.at < maxAgeMs) {
        return { path: worktree.path, memo: memo.git };
      }
      const repository = worktree.repository;
      if (repository && !targets.has(repository)) targets.set(repository, defaultBranchOf(repository));
      const [out, target] = await Promise.all([
        git(worktree.path, ['status', '--porcelain=v2', '--branch', '--untracked-files=normal']),
        repository ? targets.get(repository) : null,
      ]);
      return { path: worktree.path, status: out === null ? null : parseGitStatus(out), target, files, refs };
    }),
  );
  const budget: { deadline?: number } = {};
  const summaries = new Map<string, WorktreeGit | null>();
  for (const read of reads) {
    if ('memo' in read) {
      summaries.set(read.path, read.memo ?? null);
      continue;
    }
    if (!read.status) {
      if (read.files?.missing) recent.set(read.path, { at: now, files: read.files.stamp, refs: read.refs, git: null });
      summaries.set(read.path, null);
      continue;
    }
    const { head, ...counts } = read.status;
    const merge = head && read.target ? mergedInto(read.path, head, read.target, budget) : null;
    const summary = { ...counts, mergedInto: merge?.into ?? null };
    const refs = { upstream: counts.upstream, target: read.target?.ref ?? null };
    const settled = !merge?.deferred && refs.upstream === read.refs.upstream && refs.target === read.refs.target;
    recent.set(read.path, { at: now, files: settled ? (read.files?.stamp ?? null) : null, refs, git: summary });
    summaries.set(read.path, summary);
  }
  return summaries;
}
