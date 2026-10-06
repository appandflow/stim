import { t } from '@lingui/core/macro';

import { RequestError } from '@/lib/connection';
import { pullRequestStateName } from '@/lib/format';
import { formatSize, formatDuration } from '@/intl/format';
import type { DevicePlatform, StatusPayload } from '@/protocol/types';

export type ArchivedWorkspace = NonNullable<StatusPayload['archived']>[number];
export type WorkspaceTarget = { workspace: string; archive?: never } | { archive: string; workspace?: never };

export function removedByWords(removedBy: string): string {
  switch (removedBy) {
    case 'worktree-remove':
      return t`worktree removal`;
    case 'gc':
      return t`cleanup`;
    case 'maintenance':
      return t`automatic maintenance`;
    default:
      return removedBy;
  }
}

export function archivedView(archive: ArchivedWorkspace, now: number) {
  const age = formatDuration(Math.max(0, now - Date.parse(archive.removedAt)));
  const by = removedByWords(archive.removedBy);
  const pr = archive.worktree.pullRequest;
  return {
    title: archive.worktree.branch || archive.project,
    pr: pr ? `#${pr.number} ${pullRequestStateName(pr.state)}` : null,
    removed: t`Removed ${age} ago`,
    removedBy: t`Removed ${age} ago by ${by}`,
    size: formatSize(archive.bytes.total),
  };
}

export function archiveError(error: Error, kind: 'logs' | 'replay'): string {
  if (error instanceof RequestError && error.error.code === 'bad-request') {
    return kind === 'logs'
      ? t`Update stim-server to view archived logs`
      : t`Update stim-server to view archived replay`;
  }
  return error.message;
}

export function archivedDeviceRoute({
  macId,
  path,
  platform,
  slot,
  at,
  hasStatus,
  workspaceListed,
  archives,
}: {
  macId: string;
  path: string;
  platform: DevicePlatform;
  slot: string;
  at?: string;
  hasStatus: boolean;
  workspaceListed: boolean;
  archives: readonly ArchivedWorkspace[];
}):
  | { pathname: '/mac/[id]/archived'; params: { id: string; archive: string } }
  | {
      pathname: '/mac/[id]/archived-replay';
      params: { id: string; archive: string; platform: 'ios' | 'android' | 'web'; at?: string };
    }
  | null {
  if (!hasStatus || workspaceListed) return null;
  const archive = archives
    .filter((entry) => entry.projectRoot === path)
    .reduce<ArchivedWorkspace | null>(
      (newest, entry) => (!newest || Date.parse(entry.removedAt) > Date.parse(newest.removedAt) ? entry : newest),
      null,
    );
  if (!archive) return null;
  const params = { id: macId, archive: archive.id };
  if (
    archive.bytes.recordings > 0 &&
    slot === 'default' &&
    (platform === 'ios' || platform === 'android' || platform === 'web')
  ) {
    return {
      pathname: '/mac/[id]/archived-replay',
      params: { ...params, platform, ...(at === undefined ? {} : { at }) },
    };
  }
  return { pathname: '/mac/[id]/archived', params };
}
