import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { configDir, type StimContext } from '@stim-cli/core';
import { archiveRoot, type MaintenanceAction } from '@stim-cli/core/state';
import { archivesPastRetention, type ArchiveExpiry } from '../../archive.ts';
import { collectDeviceLeases } from '../../commands/gc/devices.ts';
import { collectStaleStatusCachesAsync, keptStatusCachesReason } from '../../commands/gc/status-caches.ts';
import { emptyProcessLockDirs } from '../../engine/tunnel.ts';
import type { LeaseFileEntry } from '../../engine/device-lease.ts';
import { WorkspaceProcessCleanupError } from '../../engine/workspace-process-lock.ts';
import { workspaceInUseAsync } from '../../workspace/in-use.ts';
import { maintenancePinnedReader } from './protect.ts';
import type { MaintenancePlan } from './plan.ts';

const isCleanupError = (error: unknown) =>
  error instanceof WorkspaceProcessCleanupError || (error instanceof Error && 'reportCleanup' in error);

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

export async function leaseKeepReason(entry: LeaseFileEntry, operation?: StimContext): Promise<string | null> {
  const holder = entry.lease?.holder;
  if (!holder || !existsSync(holder)) return null;
  if (await maintenancePinnedReader(operation)(holder)) return `${holder} is pinned by maintenance.keep`;
  const reasons = operation
    ? await workspaceInUseAsync(holder, {}, operation.signal, operation)
    : await workspaceInUseAsync(holder);
  return reasons.length ? `${holder} is in use: ${reasons.join('; ')}` : null;
}

export function archiveExpiryReason(expiry: ArchiveExpiry): string {
  const found = [
    expiry.records.length && `${plural(expiry.records.length, 'archived workspace')}`,
    expiry.parts.length &&
      `${plural(expiry.parts.length, 'archived log, recording or agent action set', 'archived log, recording or agent action sets')}`,
    expiry.worktreeArchives.length && `${plural(expiry.worktreeArchives.length, 'worktree archive')}`,
  ].filter(Boolean);
  return `${found.join(', ')} outlived archive.maxAgeDays, archive.maxCount or their own archive age limit`;
}

/**
 * The daily prune of what outlived the thing it describes, by the rules `stim gc --delete` already applies: status
 * cache files of gone folders, process lock directories that hold no claim, expired device lease files, and archives
 * past `archive.*` retention. Whatever cannot be shown stale stays, with its reason as a skip.
 */
export async function planPrune({
  now,
  mounted,
  operation,
}: {
  now: number;
  mounted: string[];
  operation?: StimContext;
}): Promise<MaintenancePlan> {
  const actions: MaintenanceAction[] = [];
  const skips: MaintenancePlan['skips'] = [];
  const blocked: string[] = [];
  const signal = operation?.signal;
  const attempt = async (what: string, run: () => Promise<void>) => {
    try {
      await run();
    } catch (error) {
      if (isCleanupError(error)) throw error;
      signal?.throwIfAborted();
      blocked.push(`Could not look for ${what}: ${error instanceof Error ? error.message : error}`);
    }
  };

  await attempt('stale status cache entries', async () => {
    const { stale, kept } = await collectStaleStatusCachesAsync(mounted, signal);
    for (const dir of new Set(stale.map((entry) => dirname(entry.file)))) {
      const own = stale.filter((entry) => dirname(entry.file) === dir);
      actions.push({
        kind: 'would-delete-status-caches',
        target: dir,
        dir,
        bytes: own.reduce((sum, entry) => sum + entry.bytes, 0),
        reason: `${plural(own.length, 'entry', 'entries')} cache${own.length === 1 ? 's' : ''} a folder or worktree that no longer exists`,
      });
    }
    for (const group of kept)
      skips.push({ target: group.dir, reason: keptStatusCachesReason(group), code: group.verdict });
  });

  await attempt('empty process lock directories', async () => {
    const empty = await emptyProcessLockDirs(signal);
    if (empty.length)
      actions.push({
        kind: 'would-delete-process-locks',
        target: join(configDir(), 'process-locks'),
        bytes: 0,
        reason: `${plural(empty.length, 'lock directory', 'lock directories')} left by removed projects and worktrees hold no claim`,
      });
  });

  await attempt('expired device leases', async () => {
    const { expired, kept } = collectDeviceLeases(now);
    for (const entry of expired) {
      signal?.throwIfAborted();
      const keep = await leaseKeepReason(entry, operation);
      if (keep) {
        skips.push({ target: entry.path, reason: `the lease expired, but ${keep}`, code: 'workspace' });
        continue;
      }
      actions.push({
        kind: 'would-delete-device-lease',
        target: entry.path,
        bytes: 0,
        reason: `the ${entry.platform} lease on ${entry.id ?? entry.name} held by ${entry.lease?.holder ?? 'an unrecorded workspace'} expired at ${entry.lease?.expiresAt}`,
      });
    }
    for (const entry of kept) skips.push({ target: entry.path, reason: entry.reason, code: 'lease' });
  });

  await attempt('archives past their retention', async () => {
    const expiry = await archivesPastRetention(now, operation);
    if ('refusal' in expiry) {
      skips.push({ target: archiveRoot(), reason: expiry.refusal });
      return;
    }
    if (expiry.records.length + expiry.parts.length + expiry.worktreeArchives.length)
      actions.push({
        kind: 'would-delete-expired-archives',
        target: archiveRoot(),
        bytes: expiry.bytes,
        reason: archiveExpiryReason(expiry),
      });
  });

  return { actions, blocked, skips };
}
