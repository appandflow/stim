import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { readShareLinks, workspaceShareLinksFile, type SavedShare } from '@stim-cli/core/state';
import { withWorkspaceStateLock } from './workspace-state.ts';

/**
 * Replaces the workspace's saved links. The file holds URL tokens and passwords, so it is written privately (mode
 * 0600, in the 0700 workspace directory) and renamed into place, and an empty set removes it.
 */
function writeLinks(root: string, links: Record<string, SavedShare>): void {
  const file = workspaceShareLinksFile(root);
  if (Object.keys(links).length === 0) {
    rmSync(file, { force: true });
    return;
  }
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, `${JSON.stringify({ version: 1, links }, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, file);
  } catch (cause) {
    rmSync(tmp, { force: true });
    throw cause;
  }
}

/** Saves a started share under `key`, replacing that target's earlier one and dropping every expired link. */
export function saveShareLink(root: string, key: string, share: SavedShare): void {
  withWorkspaceStateLock(root, () => writeLinks(root, { ...readShareLinks(root), [key]: share }));
}

/** The workspace's links that have not expired; removes the expired ones from disk. */
export function reusableShareLinks(root: string): Record<string, SavedShare> {
  if (!existsSync(workspaceShareLinksFile(root))) return {};
  return withWorkspaceStateLock(root, () => {
    const links = readShareLinks(root);
    writeLinks(root, links);
    return links;
  });
}

/** Deletes every saved link of the workspace; returns how many had not expired. */
export function forgetShareLinks(root: string): number {
  if (!existsSync(workspaceShareLinksFile(root))) return 0;
  return withWorkspaceStateLock(root, () => {
    const count = Object.keys(readShareLinks(root)).length;
    rmSync(workspaceShareLinksFile(root), { force: true });
    return count;
  });
}

/** Marks the workspace's saved shares, or those of one `slot`, as stopped on purpose so nothing restarts them on its own. */
export function pauseShareLinks(root: string, slot?: string): void {
  if (!existsSync(workspaceShareLinksFile(root))) return;
  withWorkspaceStateLock(root, () => {
    const links = readShareLinks(root);
    let changed = false;
    for (const link of Object.values(links)) {
      if (link.state === 'live' && (slot === undefined || link.slot === slot)) {
        link.state = 'stopped';
        changed = true;
      }
    }
    if (changed) writeLinks(root, links);
  });
}
