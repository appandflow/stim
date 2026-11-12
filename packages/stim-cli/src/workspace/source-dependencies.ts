import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  currentSourceDependencies,
  readWorkspaceState,
  SOURCE_DEPENDENCIES_KEY,
  workspaceMetadataFile,
  type SourceDependenciesRecord,
} from '@stim-cli/core/state';
import { dependencyState, hasInstalledDependencies } from '../dependency-state.ts';
import { updateWorkspaceState } from './workspace-state.ts';

const withWorkspace = (keys: readonly string[]): string[] =>
  keys.filter((key) => existsSync(workspaceMetadataFile(key)));

/**
 * Records in each Stim workspace among `keys` that maintenance deleted `dir` from this source checkout. A source
 * checkout with no Stim workspace gets no record, and no workspace is created for it.
 */
export function recordSourceDependencies(keys: readonly string[], dir: string, now: Date = new Date()): void {
  for (const key of withWorkspace(keys))
    updateWorkspaceState(key, (state) => {
      const kept = currentSourceDependencies(state)?.dirs ?? [];
      return { ...state, [SOURCE_DEPENDENCIES_KEY]: { at: now.toISOString(), dirs: [...new Set([...kept, dir])] } };
    });
}

/** The record of the source checkout's workspace at `key`, while the directories it names are still missing. */
function sourceDependenciesOf(key: string): SourceDependenciesRecord | null {
  return currentSourceDependencies(readWorkspaceState(key));
}

/** Notes in the source checkout's workspace that a worktree warm copied from it, which counts as activity there. */
export function recordWarmedFrom(key: string, now: Date = new Date()): void {
  if (existsSync(workspaceMetadataFile(key)))
    updateWorkspaceState(key, (state) => ({ ...state, lastUsedAt: now.toISOString() }));
}

/**
 * What `stim worktree warm` adds to its carry line when the source checkout has no installed dependencies to copy: the
 * missing directories, when maintenance deleted them if it did, and the install that fixes the source and this worktree.
 * Null when the source checkout has them, or is not a project with a lockfile or a Podfile.
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
  install: (dir: string) => string;
  pods: (dir: string) => string;
}): string | null {
  const missing: string[] = [];
  const commands: string[] = [];
  let targetNeedsInstall = false;
  const state = dependencyState(appDir, root);
  if (state && !hasInstalledDependencies(state.root, state.installed)) {
    missing.push('node_modules');
    commands.push(install(state.root));
    targetNeedsInstall ||= !hasInstalledDependencies(join(target, relative(root, state.root)), state.installed);
  }
  if (existsSync(join(iosDir, 'Podfile')) && !existsSync(join(iosDir, 'Pods'))) {
    missing.push('ios/Pods');
    commands.push(pods(iosDir));
    targetNeedsInstall ||= !existsSync(join(target, relative(root, iosDir), 'Pods'));
  }
  if (!missing.length) return null;
  const cleared = sourceDependenciesOf(appDir);
  const since = cleared ? ` since ${cleared.at}, when maintenance deleted them` : '';
  return `the source checkout ${root} has no installed ${missing.join(' or ')} to copy${since}. Install them there (${commands.join('; ')}) so new worktrees warm from it${targetNeedsInstall ? '; this worktree needs its own install before it builds, or stim worktree warm --refresh installs in the source and copies here' : ''}`;
}
