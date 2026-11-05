import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { readShareLinks, workspaceShareLinksFile, type SavedShare } from '@stim-cli/core/state';
import { withWorkspaceStateLock, withWorkspaceStateLockAsync } from './workspace-state.ts';

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

/**
 * {@link saveShareLink} for a caller that must not block on the workspace state lock, such as stim-server. `build`
 * gets the entry already filed under `key` (unexpired) so it can carry fields over.
 */
export function saveShareLinkAsync(
  root: string,
  key: string,
  build: (existing: SavedShare | undefined) => SavedShare,
): Promise<void> {
  return withWorkspaceStateLockAsync(root, () => {
    const links = readShareLinks(root);
    writeLinks(root, { ...links, [key]: build(links[key]) });
  });
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

type LinkMatch = (key: string, link: SavedShare) => boolean;

/** Marks the matching live links stopped and writes the file; call it under the workspace state lock. */
function markStopped(root: string, matches: LinkMatch): void {
  const links = readShareLinks(root);
  let changed = false;
  for (const [key, link] of Object.entries(links)) {
    if (link.state === 'live' && matches(key, link)) {
      link.state = 'stopped';
      changed = true;
    }
  }
  if (changed) writeLinks(root, links);
}

function pauseWhere(root: string, matches: LinkMatch): void {
  if (existsSync(workspaceShareLinksFile(root))) withWorkspaceStateLock(root, () => markStopped(root, matches));
}

async function pauseWhereAsync(root: string, matches: LinkMatch): Promise<void> {
  if (existsSync(workspaceShareLinksFile(root)))
    await withWorkspaceStateLockAsync(root, () => markStopped(root, matches));
}

const inSlot =
  (slot: string | undefined): LinkMatch =>
  (_key, link) =>
    slot === undefined || link.slot === slot;

/** Marks the workspace's saved shares, or those of one `slot`, as stopped on purpose so nothing restarts them on its own. */
export function pauseShareLinks(root: string, slot?: string): void {
  pauseWhere(root, inSlot(slot));
}

/** {@link pauseShareLinks} for a caller that must not block on the workspace state lock, such as stim-server. */
export function pauseShareLinksAsync(root: string, slot?: string): Promise<void> {
  return pauseWhereAsync(root, inSlot(slot));
}

/** Marks the saved share filed under `key` (see {@link shareLinkKey}) as stopped on purpose, without blocking. */
export function pauseShareLinkAsync(root: string, key: string): Promise<void> {
  return pauseWhereAsync(root, (entry) => entry === key);
}
