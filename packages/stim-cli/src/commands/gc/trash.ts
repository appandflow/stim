import { lstat, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
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
import {
  deleteTrashEntry,
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
  return `its worktree ${worktree} still exists; run \`stim worktree remove\` on it to finish the removal, then gc deletes this entry`;
}

async function readManifest(dir: string): Promise<TrashManifest | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(dir, TRASH_MANIFEST), 'utf8'));
    if (!parsed || typeof parsed !== 'object' || !('worktree' in parsed) || !('createdAt' in parsed)) return null;
    const { worktree, createdAt } = parsed;
    return typeof worktree === 'string' && typeof createdAt === 'string' ? { worktree, createdAt } : null;
  } catch {
    return null;
  }
}

/** The entries under `$STIM_HOME/trash`, each deletable only with a valid manifest, no live or unresolved ownership claim, and a worktree that is gone. */
export async function collectTrash({
  signal,
  operation,
}: { signal?: AbortSignal; operation?: StimContext } = {}): Promise<TrashReport | null> {
  const root = trashRoot();
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return null;
  }
  const entries: TrashEntry[] = [];
  for (const name of names.toSorted()) {
    const path = join(root, name);
    const stat = await lstat(path).catch(() => null);
    if (!stat?.isDirectory()) continue;
    const manifest = name.startsWith(TRASH_ENTRY_PREFIX) ? await readManifest(path) : null;
    const claim = manifest
      ? claimKept(path)
      : { kept: 'it has no valid trash.json, so Stim did not create it', live: false };
    const live = claim.live;
    const kept = claim.kept ?? (manifest ? await worktreeKept(manifest.worktree) : null);
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

export function trashLines(report: TrashReport | null | undefined): string[] {
  if (!report) return [];
  const total = report.entries.reduce((sum, entry) => sum + (entry.bytes ?? 0), 0);
  const lines = [`Worktree trash (${formatBytes(total)} in ${report.entries.length}) - ${report.root}:`];
  for (const entry of report.entries) {
    const from = entry.worktree ? ` from ${entry.worktree}` : '';
    lines.push(
      `  ${(entry.bytes === null ? 'deleting' : formatBytes(entry.bytes)).padStart(10)}  ${entry.path}${from}`,
    );
    lines.push(entry.kept ? `              kept: ${entry.kept}` : '              --delete would DELETE it');
  }
  return lines;
}

/** Deletes what a fresh `collectTrash` marks deletable, each entry under its own exclusive claim. */
export async function deleteTrash(
  operation: StimContext | undefined,
  output: GcOutput = GC_OUTPUT,
): Promise<{ count: number; bytes: number; failures: number }> {
  const report = await collectTrash({ signal: operation?.signal, operation });
  const done = { count: 0, bytes: 0, failures: 0 };
  for (const entry of report?.entries ?? []) {
    if (!entry.willDelete) continue;
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
    try {
      await deleteTrashEntry(entry.path, operation);
      done.count++;
      done.bytes += entry.bytes ?? 0;
    } catch (error) {
      if (error instanceof WorkspaceProcessCleanupError || (error instanceof Error && 'reportCleanup' in error))
        throw error;
      operation?.signal.throwIfAborted();
      done.failures++;
      const detail = error instanceof Error ? error.message : String(error);
      output.log(chalk.red(`Could not delete ${entry.path}: ${detail}`));
      output.record('trash', 'failed', entry.path, { bytes: entry.bytes ?? 0, detail });
    } finally {
      releaseClaim(claim.acquired);
    }
  }
  if (done.count) {
    output.log(
      chalk.green(
        `Deleted ${plural(done.count, 'worktree trash entry', 'worktree trash entries')} (${formatBytes(done.bytes)})`,
      ),
    );
    output.record('trash', 'done', report?.root ?? trashRoot(), {
      bytes: done.bytes,
      detail: `${plural(done.count, 'entry', 'entries')} deleted`,
    });
  }
  return done;
}
