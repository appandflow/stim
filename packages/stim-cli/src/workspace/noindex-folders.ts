import { lstatSync, readdirSync, renameSync } from 'node:fs';
import { join, sep } from 'node:path';
import { configDir, defaultMetroCacheRoot, legacyNoindexDir, updateCacheManifest } from '@stim-cli/core';
import { agentDeviceStateDirsIn, sharedNoindexCaches } from '@stim-cli/core/state';
import { claimForEmptying } from '../cache/cache-claim.ts';
import { manifestPath } from '../cache/cache-manifest.ts';
import { agentDeviceDaemon } from '../devices/activity.ts';
import { listBuildLocks } from '../engine/build-lock.ts';
import { listBuildSlots } from '../engine/build-slots.ts';
import { readClaimSet, releaseClaim } from '../ownership-claim.ts';
import { workspaceDir } from './paths.ts';

/** One folder of the Stim home that still had its name from before the `*.noindex` rename. */
export type NoindexRename = { from: string; to: string } & ({ moved: true } | { moved: false; kept: string });

function present(path: string): boolean {
  try {
    return lstatSync(path, { throwIfNoEntry: false }) !== undefined;
  } catch {
    return true;
  }
}

function realDirectory(path: string): boolean {
  try {
    return lstatSync(path, { throwIfNoEntry: false })?.isDirectory() === true;
  } catch {
    return false;
  }
}

/** Whether `from` is a directory still waiting for its rename to `to`: a real one, not a link, with nothing at `to`. */
function pending(from: string, to: string): boolean {
  return realDirectory(from) && !present(to);
}

function rename(from: string, to: string, after?: () => void): NoindexRename {
  try {
    renameSync(from, to);
  } catch (error) {
    return {
      from,
      to,
      moved: false,
      kept: `it could not be renamed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  after?.();
  return { from, to, moved: true };
}

const under = (dir: unknown, root: string): dir is string =>
  typeof dir === 'string' && (dir === root || dir.startsWith(root + sep));

function moveRegistrations(from: string, to: string): void {
  updateCacheManifest(manifestPath(), (caches) => {
    const kept = caches.filter((cache) => !under(cache.dir, to));
    for (const cache of kept) if (under(cache.dir, from)) cache.dir = to + cache.dir.slice(from.length);
    return kept;
  });
}

function runningBuild(): string | null {
  const slot = listBuildSlots().find((each) => each.alive || each.unresolved);
  if (slot) return `${slot.unresolved ? 'an unresolved' : 'a running'} build holds build slot ${slot.index ?? '?'}`;
  const lock = listBuildLocks().find((each) => each.alive || each.unresolved);
  return lock ? `${lock.unresolved ? 'an unresolved' : 'a running'} build holds ${lock.path}` : null;
}

/**
 * Renames a cache Stim empties whole while no build runs, under the emptying claims of both names, which a build
 * holding the compilation cache refuses. No build claims ccache, so only the build slots and locks show its users.
 */
function moveClaimedCache(to: string): NoindexRename | null {
  const from = legacyNoindexDir(to);
  if (!pending(from, to)) return null;
  const building = runningBuild();
  if (building) return { from, to, moved: false, kept: building };
  const old = claimForEmptying(from);
  if (typeof old === 'string') return { from, to, moved: false, kept: old };
  try {
    const fresh = claimForEmptying(to);
    if (typeof fresh === 'string') return { from, to, moved: false, kept: fresh };
    try {
      return pending(from, to) ? rename(from, to, () => moveRegistrations(from, to)) : null;
    } finally {
      releaseClaim(fresh);
    }
  } finally {
    releaseClaim(old);
  }
}

function workspaceEntries(): string[] {
  const root = join(configDir(), 'workspaces');
  try {
    return readdirSync(root).map((name) => join(root, name));
  } catch {
    return [];
  }
}

/** Renames the home's Metro cache root once no workspace's dev server holds its Metro claim. */
function moveMetroCache(workspaces: readonly string[]): NoindexRename | null {
  const to = defaultMetroCacheRoot();
  if (to === null) return null;
  const from = legacyNoindexDir(to);
  if (!pending(from, to)) return null;
  for (const dir of workspaces) {
    const claims = readClaimSet(join(dir, 'metro.claim'));
    if (claims.live.length) return { from, to, moved: false, kept: `the dev server of ${dir} holds it` };
    if (claims.unresolved.length)
      return { from, to, moved: false, kept: `the Metro claim of ${dir} is unresolved, so a dev server may hold it` };
  }
  return rename(from, to, () => moveRegistrations(from, to));
}

function moveAgentDeviceDir(directory: string): NoindexRename | null {
  const [to, from] = agentDeviceStateDirsIn(directory);
  if (!realDirectory(directory) || !pending(from, to)) return null;
  const daemon = agentDeviceDaemon(from);
  if (daemon === 'live' || daemon === 'unknown')
    return { from, to, moved: false, kept: 'its agent-device daemon may be running' };
  if (daemon === 'none' && present(join(from, 'daemon.lock')))
    return { from, to, moved: false, kept: 'its agent-device daemon may be starting' };
  return rename(from, to);
}

/**
 * Renames the workspace's agent-device state directory to `agent-device.noindex` unless a daemon may still use it.
 * A daemon that runs under the old name keeps it until it stops.
 */
export function migrateWorkspaceAgentDeviceDir(projectRoot: string): NoindexRename | null {
  return moveAgentDeviceDir(workspaceDir(projectRoot));
}

// @ref LLP 0028#an-existing-home-renames-each-folder-once-nothing-holds-it -- one rename, only while nothing holds it
/**
 * Renames each folder of the home Stim fills with churn to its `*.noindex` name, once nothing holds it. A folder that a
 * setting or the environment names, a link, or one whose new name already exists stays as it is.
 */
export function migrateNoindexFolders(): NoindexRename[] {
  const workspaces = workspaceEntries();
  return [
    ...sharedNoindexCaches().map(moveClaimedCache),
    moveMetroCache(workspaces),
    ...workspaces.map(moveAgentDeviceDir),
  ].filter((outcome): outcome is NoindexRename => outcome !== null);
}

/**
 * The shared caches whose old-name folder exists beside the renamed one, which an older Stim recreated or a build
 * that resolved the old path before the rename refilled. Cleanup measures and trims them like the renamed cache.
 */
export function leftoverNoindexCaches(): { dir: string; category: 'compilation-cache' | 'ccache' | 'metro-cache' }[] {
  const [compilation, ccache] = sharedNoindexCaches();
  const metro = defaultMetroCacheRoot();
  const folders = [
    { to: compilation, category: 'compilation-cache' as const },
    { to: ccache, category: 'ccache' as const },
    ...(metro === null ? [] : [{ to: metro, category: 'metro-cache' as const }]),
  ];
  return folders
    .filter(({ to }) => present(to) && realDirectory(legacyNoindexDir(to)))
    .map(({ to, category }) => ({ dir: legacyNoindexDir(to), category }));
}
