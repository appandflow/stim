import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  currentSourceDependencies,
  readWorkspaceState,
  SOURCE_DEPENDENCIES_KEY,
  workspaceMetadataFile,
} from '@stim-cli/core/state';
import { dependencyState, hasInstalledDependencies } from '../dependency-state.ts';
import { canonicalPath } from '../commands/gc/paths.ts';
import { MAINTENANCE_PURPOSE, WARM_CLAIM_LABEL, warmClaimPath } from '../engine/warm-claim.ts';
import {
  claimRemoveCommand,
  isClaimRefusal,
  isClaimUnavailable,
  readClaimSet,
  releaseClaim,
  tryAcquireClaim,
  type ClaimHandle,
} from '../ownership-claim.ts';
import { updateWorkspaceState } from './workspace-state.ts';

const withWorkspace = (keys: readonly string[]): string[] =>
  keys.filter((key) => existsSync(workspaceMetadataFile(key)));

/**
 * Records in each Stim workspace among `keys` that maintenance deleted `dir` from this source checkout. A source
 * checkout with no Stim workspace gets no record, and no workspace is created for it.
 */
export function recordSourceDependencies(
  keys: readonly string[],
  dirs: string | readonly string[],
  now: Date = new Date(),
): void {
  for (const key of withWorkspace(keys))
    updateWorkspaceState(key, (state) => {
      const kept = currentSourceDependencies(state)?.dirs ?? [];
      return {
        ...state,
        [SOURCE_DEPENDENCIES_KEY]: { at: now.toISOString(), dirs: [...new Set([...kept, ...[dirs].flat()])] },
      };
    });
}

const WARMED_FROM_KEY = 'warmedFromAt';

/**
 * Notes in the source checkout's workspace that a worktree warm is copying from it, which the source dependency rule
 * counts as activity. It leaves `lastUsedAt` alone, so a warm does not postpone any other reduction.
 */
export function recordWarmedFrom(key: string, now: Date = new Date()): void {
  if (existsSync(workspaceMetadataFile(key)))
    updateWorkspaceState(key, (state) => ({ ...state, [WARMED_FROM_KEY]: now.toISOString() }));
}

/** The newest warm from any of the workspaces `keys`, in epoch milliseconds; NaN when none recorded one. */
export function warmedFromAt(keys: readonly string[]): number {
  const times = keys
    .map((key) => Date.parse(String(readWorkspaceState(key)?.[WARMED_FROM_KEY] ?? '')))
    .filter(Number.isFinite);
  return times.length ? Math.max(...times) : Number.NaN;
}

/** Why a worktree warm keeps the source checkout at `root`, or null: a warm holds its copy claim, or the claim cannot be read. */
export function warmCopyingFrom(root: string): string | null {
  for (const path of new Set([root, canonicalPath(root)])) {
    const survey = readClaimSet(warmClaimPath(path));
    if (survey.live.length) return 'a worktree warm is copying from it';
    const unresolved = survey.unresolved[0];
    if (unresolved)
      return `its warm claim at ${unresolved.path} cannot be read: ${unresolved.reason}; if no warm runs, remove the claim with ${claimRemoveCommand(path)}`;
  }
  return null;
}

/**
 * Takes the warm claim of the source checkout at `root` exclusively and without waiting, so no worktree warm can start
 * copying from it until `release`. A warm holds the claim shared around its copy, so the two exclude each other; when
 * a warm holds it, or it cannot be taken, `kept` says why and nothing is held.
 */
export function takeWarmClaim(root: string): { release: () => void } | { kept: string } {
  const held: ClaimHandle[] = [];
  const release = () => {
    for (const claim of held) releaseClaim(claim);
  };
  try {
    for (const path of new Set([root, canonicalPath(root)])) {
      const attempt = tryAcquireClaim({
        root: warmClaimPath(path),
        mode: 'exclusive',
        label: WARM_CLAIM_LABEL,
        details: { phase: 'refresh', purpose: MAINTENANCE_PURPOSE },
      });
      if (!attempt.acquired) {
        releaseClaim(attempt.pending ?? null);
        release();
        return { kept: 'a worktree warm is copying from it' };
      }
      held.push(attempt.acquired);
    }
  } catch (error) {
    release();
    if (isClaimRefusal(error)) return { kept: `${error.code}: ${error.message}` };
    if (isClaimUnavailable(error)) return { kept: `${error.code}: ${error.message} ${error.remedy}` };
    throw error;
  }
  return { release };
}

/**
 * What `stim worktree warm` adds to its carry line when the source checkout has no installed dependencies to copy: the
 * missing directories, when maintenance deleted each one if it did, and the installs that fix the source. Null when the
 * source checkout has them, or is not a project with a lockfile or a Podfile.
 */
export function sourceDependenciesNotice({
  root,
  target,
  appDir,
  iosDir,
  install,
  pods,
}: {
  root: string;
  /** The linked worktree being warmed. */
  target: string;
  appDir: string;
  iosDir: string;
  /** The command that installs node_modules in a directory, with the directory named. */
  install: (dir: string) => string;
  /** The command that installs Pods for an ios directory, with the directory named. */
  pods: (dir: string) => string;
}): string | null {
  const cleared = currentSourceDependencies(readWorkspaceState(appDir));
  const missing: string[] = [];
  const commands: string[] = [];
  let targetNeedsInstall = false;
  const describe = (label: string, dir: string) =>
    cleared?.dirs.includes(dir) ? `${label} (maintenance deleted it at ${cleared.at})` : label;
  const state = dependencyState(appDir, root);
  if (state && !hasInstalledDependencies(state.root, state.installed)) {
    missing.push(describe('node_modules', join(state.root, 'node_modules')));
    commands.push(install(state.root));
    targetNeedsInstall ||= !hasInstalledDependencies(join(target, relative(root, state.root)), state.installed);
  }
  if (existsSync(join(iosDir, 'Podfile')) && !existsSync(join(iosDir, 'Pods'))) {
    missing.push(describe('ios/Pods', join(iosDir, 'Pods')));
    commands.push(pods(iosDir));
    targetNeedsInstall ||= !existsSync(join(target, relative(root, iosDir), 'Pods'));
  }
  if (!missing.length) return null;
  const refresh = targetNeedsInstall
    ? '; this worktree needs its own install before it builds. stim worktree warm --refresh installs in the source and copies here, but it also fast-forwards the source and refuses when that is dirty or detached, so then install there by hand'
    : '';
  return `the source checkout ${root} has no installed ${missing.join(' or ')} to copy. Install them there (${commands.join('; ')}) so new worktrees warm from it${refresh}`;
}
