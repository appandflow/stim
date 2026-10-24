import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import type { StimContext } from '@stim-cli/core';
import { isJsonObject, readJsonObject, workspaceLightenedFile, workspaceMetadataFile } from '@stim-cli/core/state';
import { phaseLine } from '../command-output.ts';
import { warmWorktreeTarget } from '../commands/worktree.ts';
import { withWorkspaceStateLock } from './workspace-state.ts';
import { listWorktrees, sourceCheckoutOf } from './worktree.ts';

export function lightenedDirs(root: string): string[] {
  const record = readJsonObject(workspaceLightenedFile(root));
  return isJsonObject(record) && Array.isArray(record.dirs)
    ? record.dirs.filter((dir): dir is string => typeof dir === 'string')
    : [];
}

/** The keys among `keys` that have a Stim workspace, which is what restores a lightened worktree. */
export function workspaceKeys(keys: readonly string[]): string[] {
  return keys.filter((key) => existsSync(workspaceMetadataFile(key)));
}

const LOCKFILES = ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'bun.lock', 'bun.lockb'];

function readOrNull(path: string): Buffer | null {
  try {
    return readFileSync(path);
  } catch {
    return null;
  }
}

/** Why `worktree warm` could not put back what was deleted at `path`: it copies the source checkout's copy. */
export function restoreProblem(
  { worktree, path }: { worktree: string; path: string },
  sources: Map<string, string | null> = new Map(),
): string | null {
  if (!sources.has(worktree)) {
    const source = sourceCheckoutOf(listWorktrees(worktree));
    sources.set(worktree, 'refusal' in source ? null : source.path);
  }
  const source = sources.get(worktree);
  if (!source) return 'its source checkout cannot be resolved, so worktree warm could not restore it';
  const rel = relative(worktree, path);
  if (!existsSync(join(source, rel))) return `the source checkout has no ${rel} for worktree warm to copy back`;
  const pods = basename(rel) === 'Pods';
  const locks = pods
    ? [join(dirname(rel), 'Podfile.lock')]
    : [...new Set(['.', dirname(rel)])].flatMap((dir) => LOCKFILES.map((name) => join(dir, name)));
  const differs = locks.find((lock) => {
    const mine = readOrNull(join(worktree, lock));
    const theirs = readOrNull(join(source, lock));
    return mine === null ? theirs !== null : theirs === null || !mine.equals(theirs);
  });
  return differs
    ? `its ${differs} differs from the source checkout's, so worktree warm would restore other versions`
    : null;
}

/** Records in each Stim workspace among `keys` that `dir` is being deleted to lighten its worktree. */
export function recordLightened(keys: readonly string[], dir: string, now: Date = new Date()): void {
  for (const key of workspaceKeys(keys))
    withWorkspaceStateLock(key, () => {
      const file = workspaceLightenedFile(key);
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.tmp-${process.pid}`;
      const dirs = [...new Set([...lightenedDirs(key), dir])];
      writeFileSync(tmp, `${JSON.stringify({ at: now.toISOString(), dirs }, null, 2)}\n`, { mode: 0o600 });
      renameSync(tmp, file);
    });
}

/**
 * Restores the dependencies gc deleted from this workspace's worktree through `stim worktree warm`, or returns the
 * failure to report. A workspace gc never lightened is left alone.
 */
export async function restoreLightenedDependencies(
  root: string,
  operation: StimContext,
): Promise<{ code: string; message: string; remedy: string } | null> {
  const dirs = lightenedDirs(root);
  if (!dirs.length) return null;
  const missing = () => dirs.filter((dir) => !existsSync(dir));
  if (missing().length) {
    operation.output(
      'stderr',
      `${phaseLine('deps', `gc lightened this worktree; restoring ${missing().join(', ')} with worktree warm`)}\n`,
    );
    const { exitCode } = await warmWorktreeTarget({ cwd: root, operation });
    const left = missing();
    if (exitCode !== 0 || left.length)
      return {
        code: 'STIM_DEPS_FAILED',
        message: `gc lightened this worktree, and worktree warm did not restore ${left.join(', ') || 'its dependencies'}.`,
        remedy: `Run \`stim worktree warm\` in ${root}, or install the project's dependencies, then retry.`,
      };
  }
  withWorkspaceStateLock(root, () => rmSync(workspaceLightenedFile(root), { force: true }));
  return null;
}

/** Prints a restore failure the way a native run reports a refusal, with the JSON line on stdout when asked. */
export function printLightenedFailure(
  operation: StimContext,
  failure: { code: string; message: string; remedy: string },
  json: boolean,
): void {
  operation.output('stderr', `${phaseLine('error', `${failure.code}: ${failure.message}`)}\n`);
  operation.output('stderr', `${phaseLine('remedy', failure.remedy)}\n`);
  if (json) operation.output('stdout', `${JSON.stringify(failure)}\n`);
}
