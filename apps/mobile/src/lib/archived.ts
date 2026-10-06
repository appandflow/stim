import { t } from '@lingui/core/macro';

import { RequestError } from '@/lib/connection';
import { pullRequestStateName } from '@/lib/format';
import { formatSize, formatDuration } from '@/intl/format';
import type { StatusPayload } from '@/protocol/types';

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
