import { lstat, readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import chalk from 'chalk';
import type { StimContext } from '@stim-cli/core';
import { trashRoot } from '@stim-cli/core/state';
import {
  claimRemoveCommand,
  isClaimRefusal,
  isClaimUnavailable,
  readClaimSet,
  releaseClaim,
  tryAcquireClaim,
} from '@stim-cli/core/ownership-claim';
import { directorySizeAsync, formatBytes } from '../../fs-util.ts';
import { plural } from '../../command-output.ts';
import { WorkspaceProcessCleanupError } from '../../engine/workspace-process-lock.ts';
import { openDeleteSession, type DeleteSession } from '../../delete-child.ts';
import { filesystemDevice } from '../../temporary.ts';
import {
  deleteTrashEntry,
  claimSetKept,
  trashEntryMisplaced,
  TRASH_CLAIMS,
  TRASH_ENTRY_PREFIX,
  TRASH_MANIFEST,
  type TrashManifest,
} from '../../workspace/worktree-trash.ts';
import { GC_OUTPUT, type GcOutput } from './results.ts';

interface TrashEntry {
  path: string;
  worktree: string | null;
  removedAt: string | null;
  bytes: number | null;
  willDelete: boolean;
  kept: string | null;
}

export interface TrashReport {
  root: string;
  entries: TrashEntry[];
}

const CLAIM_LABEL = 'worktree trash';

function claimKept(dir: string): { kept: string | null; live: boolean } {
  const survey = readClaimSet(join(dir, TRASH_CLAIMS));
  if (survey.live.length) return { kept: 'a worktree removal is still moving or deleting it', live: true };
  const problem = survey.unresolved[0];
  if (problem)
    return {
      kept: `its ownership claim cannot be verified (${problem.reason}); run \`${claimRemoveCommand(problem.path)}\``,
      live: false,
    };
  return { kept: null, live: false };
}

async function worktreeKept(worktree: string): Promise<string | null> {
  try {
    await lstat(worktree);
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    return `its worktree ${worktree} cannot be checked (${String(code ?? 'unknown error')})`;
  }
  return `its worktree ${worktree} still exists; if it is the one this entry came from, run \`stim worktree remove\` on it to finish the removal, then gc deletes this entry`;
}

async function readManifest(dir: string): Promise<TrashManifest | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(dir, TRASH_MANIFEST), 'utf8'));
    if (!parsed || typeof parsed !== 'object' || !('worktree' in parsed) || !('createdAt' in parsed)) return null;
    const { worktree, createdAt } = parsed;
    if (typeof worktree !== 'string' || typeof createdAt !== 'string') return null;
    return 'kind' in parsed && parsed.kind === 'warm' ? { worktree, createdAt, kind: 'warm' } : { worktree, createdAt };
  } catch {
    return null;
  }
}

const NOT_WRITTEN_BY_STIM = 'it has no valid trash.json, so Stim did not create it';

/**
 * What the contents of the entry `dir` say, apart from its claim: its manifest, and why they keep it (null when they do
 * not). An entry with no manifest is deletable only while it holds nothing but its claims: a delete that stopped after
 * its manifest went, or an entry whose manifest was not written yet.
 */
async function readContents(
  dir: string,
  dev: number,
): Promise<{ manifest: TrashManifest | null; kept: string | null }> {
  if (!basename(dir).startsWith(TRASH_ENTRY_PREFIX)) return { manifest: null, kept: NOT_WRITTEN_BY_STIM };
  const manifest = await readManifest(dir);
  if (!manifest) {
    const names = await readdir(dir).catch(() => null);
    const onlyClaims =
      names?.every((name) => name === TRASH_CLAIMS) === true &&
      (!names.length || claimSetKept(join(dir, TRASH_CLAIMS), dev, true) === null);
    return { manifest, kept: onlyClaims ? null : NOT_WRITTEN_BY_STIM };
  }
  return { manifest, kept: manifest.kind === 'warm' ? null : await worktreeKept(manifest.worktree) };
}

/** The entries under `$STIM_HOME/trash`, each deletable only with a valid manifest, no live or unresolved ownership claim, and a worktree that is gone. */
export async function collectTrash({
  signal,
  operation,
}: { signal?: AbortSignal; operation?: StimContext } = {}): Promise<TrashReport | null> {
  const root = trashRoot();
  let names: string[];
  let dev: number;
  try {
    names = await readdir(root);
    dev = filesystemDevice(root);
  } catch {
    return null;
  }
  const entries: TrashEntry[] = [];
  for (const name of names.toSorted()) {
    const path = join(root, name);
    const stat = await lstat(path).catch(() => null);
    if (!stat?.isDirectory()) continue;
    const { manifest, kept: contents } = await readContents(path, dev);
    const claim = contents === NOT_WRITTEN_BY_STIM ? { kept: null, live: false } : claimKept(path);
    const live = claim.live;
    const kept = contents === NOT_WRITTEN_BY_STIM ? contents : (claim.kept ?? contents);
    entries.push({
      path,
      worktree: manifest?.worktree ?? null,
      removedAt: manifest?.createdAt ?? null,
      bytes: live ? null : await directorySizeAsync(path, { timeoutMs: 'unbounded', signal, operation }),
      willDelete: kept === null,
      kept,
    });
  }
  return entries.length ? { root, entries } : null;
}

/** Deletes what a fresh `collectTrash` marks deletable, each entry under its own exclusive claim. */
export async function deleteTrash(
  operation: StimContext | undefined,
  output: GcOutput = GC_OUTPUT,
): Promise<{ count: number; bytes: number; failures: number }> {
  const report = await collectTrash({ signal: operation?.signal, operation });
  const done = { count: 0, bytes: 0, failures: 0 };
  if (!report) return done;
  const dev = filesystemDevice(report.root);
  const signal = operation?.signal;
  let session: DeleteSession | undefined;
  try {
    for (const entry of report.entries) {
      if (!entry.willDelete) continue;
      const misplaced =
        trashEntryMisplaced(entry.path, dev) ??
        claimSetKept(join(entry.path, TRASH_CLAIMS), dev, entry.worktree === null);
      if (misplaced) {
        output.record('trash', 'kept', entry.path, { bytes: entry.bytes ?? 0, detail: misplaced });
        continue;
      }
      let claim;
      try {
        claim = tryAcquireClaim({ root: join(entry.path, TRASH_CLAIMS), mode: 'exclusive', label: CLAIM_LABEL });
      } catch (error) {
        if (!isClaimRefusal(error) && !isClaimUnavailable(error)) throw error;
        output.record('trash', 'kept', entry.path, { bytes: entry.bytes ?? 0, detail: error.reason });
        continue;
      }
      if (!claim.acquired) {
        if (claim.pending) releaseClaim(claim.pending);
        output.record('trash', 'kept', entry.path, {
          bytes: entry.bytes ?? 0,
          detail: 'a worktree removal is still moving or deleting it',
        });
        continue;
      }
      let retained = false;
      try {
        const now = await readContents(entry.path, dev);
        if (now.kept) {
          output.record('trash', 'kept', entry.path, { bytes: entry.bytes ?? 0, detail: now.kept });
          continue;
        }
        if (session?.exited()) {
          await session.close();
          session = undefined;
        }
        session ??= await openDeleteSession(signal);
        await deleteTrashEntry(entry.path, claim.acquired, session, { dev, signal });
        done.count++;
        done.bytes += entry.bytes ?? 0;
      } catch (error) {
        retained = error instanceof WorkspaceProcessCleanupError;
        if (retained || (error instanceof Error && 'reportCleanup' in error)) throw error;
        operation?.signal.throwIfAborted();
        done.failures++;
        const detail = error instanceof Error ? error.message : String(error);
        output.log(chalk.red(`Could not delete ${entry.path}: ${detail}`));
        output.record('trash', 'failed', entry.path, { bytes: entry.bytes ?? 0, detail });
      } finally {
        if (!retained) releaseClaim(claim.acquired);
      }
    }
  } finally {
    await session?.close();
  }
  if (done.count) {
    output.log(
      chalk.green(
        `Deleted ${plural(done.count, 'worktree trash entry', 'worktree trash entries')} (${formatBytes(done.bytes)})`,
      ),
    );
    output.record('trash', 'done', report.root, {
      bytes: done.bytes,
      detail: `${plural(done.count, 'entry', 'entries')} deleted`,
    });
  }
  return done;
}
