import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import type { StimContext } from '@stim-cli/core';
import { isJsonObject, readJsonObject, workspaceLightenedFile, workspaceMetadataFile } from '@stim-cli/core/state';
import { phaseLine } from '../command-output.ts';
import { warmWorktreeTarget } from '../commands/worktree.ts';
import { withWorkspaceStateLock } from './workspace-state.ts';
import { listCarryableIgnoredEntries, readWorktreeExclude, warmWorktreePaths } from './worktree.ts';
import { resolveSettings } from './settings.ts';
import { WorkspaceProcessCleanupError } from '../engine/workspace-process-lock.ts';

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

type SourceFacts = { source: string; carryable: Set<string> } | null;

async function sourceFacts(worktree: string, operation?: StimContext): Promise<SourceFacts> {
  try {
    const { root: source, common } = await warmWorktreePaths(worktree, operation);
    const settings = resolveSettings({ gitCommonDir: common, repoRoot: source }).worktree;
    const configured =
      isJsonObject(settings) && Array.isArray(settings.exclude)
        ? settings.exclude.filter((entry): entry is string => typeof entry === 'string')
        : [];
    const patterns = readWorktreeExclude(source) ?? configured;
    return {
      source,
      carryable: new Set(
        await listCarryableIgnoredEntries(source, patterns, {
          env: operation?.env,
          signal: operation?.signal,
          declareFor: operation,
        }),
      ),
    };
  } catch (error) {
    operation?.signal.throwIfAborted();
    if (error instanceof WorkspaceProcessCleanupError) throw error;
    return null;
  }
}

/**
 * Why `worktree warm` could not put back what is deleted at `path`, or null when it copies the same versions back: it
 * carries that directory from the source checkout, and both hold the same lockfile.
 */
export async function restoreProblem(
  { worktree, path }: { worktree: string; path: string },
  cache: Map<string, Promise<SourceFacts>> = new Map(),
  operation?: StimContext,
): Promise<string | null> {
  let pending = cache.get(worktree);
  if (!pending) cache.set(worktree, (pending = sourceFacts(worktree, operation)));
  const facts = await pending;
  if (!facts) return 'its source checkout cannot be resolved, so worktree warm could not restore it';
  const rel = relative(worktree, path);
  if (!facts.carryable.has(rel)) return `worktree warm would not copy ${rel} back from the source checkout`;
  const pods = basename(rel) === 'Pods';
  const locks = pods
    ? [join(dirname(rel), 'Podfile.lock')]
    : [...new Set(['.', dirname(rel)])].flatMap((dir) => LOCKFILES.map((name) => join(dir, name)));
  const differs = locks.find((lock) => {
    const mine = readOrNull(join(worktree, lock));
    const theirs = readOrNull(join(facts.source, lock));
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

function depsFailure(
  root: string,
  message: string,
  remedy = `Run \`stim worktree warm\` in ${root}, or install the project's dependencies, then retry.`,
): { code: string; message: string; remedy: string } {
  return { code: 'STIM_DEPS_FAILED', message: `gc lightened this worktree, and ${message}`, remedy };
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
    const cache = new Map<string, Promise<SourceFacts>>();
    const worktree = (await warmWorktreePaths(root, operation).catch(() => null))?.target;
    for (const dir of missing()) {
      const problem = worktree
        ? await restoreProblem({ worktree, path: dir }, cache, operation)
        : 'its worktree cannot be resolved';
      if (problem)
        return depsFailure(
          root,
          `${dir} cannot be restored by worktree warm: ${problem}.`,
          `Install the project's dependencies in ${root} (for example \`pnpm install\` or \`pod install\`), then retry.`,
        );
    }
    operation.output(
      'stderr',
      `${phaseLine('deps', `gc lightened this worktree; restoring ${missing().join(', ')} with worktree warm`)}\n`,
    );
    let exitCode: number;
    try {
      ({ exitCode } = await warmWorktreeTarget({ cwd: root, operation }));
    } catch (error) {
      operation.signal.throwIfAborted();
      if (error instanceof WorkspaceProcessCleanupError) throw error;
      return depsFailure(root, `worktree warm failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    const left = missing();
    if (exitCode !== 0 || left.length)
      return depsFailure(root, `worktree warm did not restore ${left.join(', ') || 'its dependencies'}.`);
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
