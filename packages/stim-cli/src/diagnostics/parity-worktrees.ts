import { lstatSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { captureProcessToken, inspectProcessIdentity } from '../process-identity.ts';
import { gitQuietAsync } from '../workspace/git.ts';
import { removeTemporaryEntryAsync } from '../temporary.ts';

export const PARITY_PREFIX = 'stim-parity-';
const MARKER = 'stim-parity.json';
const GIT_TIMEOUT_MS = 30_000;

interface ParityMarker {
  version: 1;
  repo: string;
  owner: { pid: number; processToken: string };
}

/** Records the repository and the creating process in a parity directory, so a later run can tell a killed run's leftover from a live one. */
export function writeParityMarker(base: string, projectRoot: string): void {
  const processToken = captureProcessToken(process.pid);
  if (processToken === null) return;
  const marker: ParityMarker = {
    version: 1,
    repo: realpathSync.native(projectRoot),
    owner: { pid: process.pid, processToken },
  };
  writeFileSync(join(base, MARKER), JSON.stringify(marker), { mode: 0o600 });
}

function readParityMarker(base: string): ParityMarker | null {
  try {
    const value: unknown = JSON.parse(readFileSync(join(base, MARKER), 'utf8'));
    if (typeof value !== 'object' || value === null) return null;
    if (!('version' in value) || value.version !== 1) return null;
    if (!('repo' in value) || typeof value.repo !== 'string') return null;
    if (!('owner' in value) || typeof value.owner !== 'object' || value.owner === null) return null;
    const { owner } = value;
    if (!('pid' in owner) || typeof owner.pid !== 'number') return null;
    if (!('processToken' in owner) || typeof owner.processToken !== 'string') return null;
    return { version: 1, repo: value.repo, owner: { pid: owner.pid, processToken: owner.processToken } };
  } catch {
    return null;
  }
}

/** Why `base` is not removable as a leftover of a Stim run that has ended, or null when it is. */
export function parityLeftoverKept(base: string): string | null {
  const stat = lstatSync(base, { throwIfNoEntry: false });
  if (!stat?.isDirectory()) return 'it is not a directory Stim made';
  if (process.getuid && stat.uid !== process.getuid()) return 'another user owns it';
  const marker = readParityMarker(base);
  if (!marker) return "it has no Stim record, so it is not provably Stim's";
  const owner = inspectProcessIdentity(marker.owner);
  return owner === 'gone' || owner === 'different' ? null : 'the process that made it may still be running';
}

/** Removes one leftover parity directory and unregisters its worktree from the repository its record names. */
export async function removeParityLeftover(
  base: string,
  signal?: AbortSignal,
): Promise<{ removed: boolean; kept: string | null }> {
  const kept = parityLeftoverKept(base);
  const marker = readParityMarker(base);
  if (kept || !marker) return { removed: false, kept: kept ?? 'it has no Stim record' };
  const { repo } = marker;
  const options = { write: true, timeoutMs: GIT_TIMEOUT_MS, signal };
  const head = join(realpathSync.native(base), 'head');
  let registered = false;
  if (lstatSync(repo, { throwIfNoEntry: false })?.isDirectory() === true) {
    const listed = await gitQuietAsync(repo, ['worktree', 'list', '--porcelain', '-z'], {
      timeoutMs: GIT_TIMEOUT_MS,
      signal,
    });
    registered =
      listed !== null &&
      listed
        .split('\0')
        .some((line) => line.startsWith('worktree ') && relative(head, line.slice('worktree '.length)) === '');
  }
  if (registered) await gitQuietAsync(repo, ['worktree', 'remove', '--force', '--force', head], options);
  await removeTemporaryEntryAsync(base, signal);
  if (registered) await gitQuietAsync(repo, ['worktree', 'prune'], options);
  return { removed: true, kept: null };
}

/** Removes the leftovers of ended runs directly inside `root`, the temporary directory Stim creates them in. */
export async function sweepParityLeftovers(root: string, signal?: AbortSignal): Promise<string[]> {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const name of names.filter((entry) => entry.startsWith(PARITY_PREFIX)).toSorted()) {
    const base = join(root, name);
    try {
      if ((await removeParityLeftover(base, signal)).removed) removed.push(base);
    } catch {
      signal?.throwIfAborted();
    }
  }
  return removed;
}
