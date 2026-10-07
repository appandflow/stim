import { t } from '@lingui/core/macro';

import { formatDuration, formatSize } from '@/intl/format';
import { removedByWords, type ArchivedWorkspace } from '@/lib/archived';
import { pathInCheckout, projectOf, workspaceCheckout, workspaceTitle } from '@/lib/workspace-names';
import type { GitChip } from '@/lib/workspace-view';
import type { ArchiveDetailResult, EnvironmentState } from '@/protocol/types';

export function archivedPage(archive: ArchivedWorkspace, detail: ArchiveDetailResult | null | undefined, now: number) {
  const checkout = workspaceCheckout(archive.projectRoot);
  const merged = archive.worktree.merged === true || archive.worktree.pullRequest?.state === 'merged';
  const env: EnvironmentState = {
    path: archive.projectRoot,
    live: false,
    memoryMb: 0,
    warnings: [],
    worktree: {
      path: checkout,
      ...(archive.worktree.branch ? { branch: archive.worktree.branch } : {}),
      ...(archive.worktree.repository ? { repository: archive.worktree.repository } : {}),
    },
    builds: detail?.builds ?? {},
    lastBuilds: detail
      ? Object.fromEntries(
          Object.entries(detail.builds).flatMap(([platform, builds]) => (builds?.[0] ? [[platform, builds[0]]] : [])),
        )
      : archive.builds.last
        ? { [archive.builds.last.platform]: archive.builds.last }
        : {},
    endedAgents: archive.agents,
    logs: { dir: '', errorsSinceMarker: archive.builds.lastErrorCount },
  };
  const expired = (kind: keyof ArchivedWorkspace['expires']) =>
    archive.bytes[kind] === 0 || (archive.expires[kind] !== null && Date.parse(archive.expires[kind]) <= now);
  const retention = (['logs', 'recordings', 'agentActions', 'record'] as const).map((kind) => ({
    kind,
    bytes: archive.bytes[kind],
    until: archive.expires[kind],
    expired: expired(kind),
    soon: !expired(kind) && archive.expires[kind] !== null && Date.parse(archive.expires[kind]) - now <= 86_400_000,
  }));
  const age = formatDuration(Math.max(0, now - Date.parse(archive.removedAt)));
  const by = archive.replacedBy ? t`a newer workspace` : removedByWords(archive.removedBy);
  const pr = archive.worktree.pullRequest;
  const number = pr?.number ?? 0;
  const prLabel = pr ? (merged ? t`#${number} Merged` : `#${number}`) : merged ? t`Merged` : null;
  const branch = archive.worktree.branch;
  const git: GitChip | null =
    prLabel || branch
      ? {
          label: [branch, prLabel].filter(Boolean).join(', '),
          pr: prLabel ? { text: prLabel, tone: merged ? 'brand' : 'tertiary', ci: null } : null,
          parts: branch ? [{ text: branch, tone: 'secondary' }] : [],
        }
      : null;
  const history = Object.values(detail?.builds ?? {}).flatMap((builds) => builds ?? []);
  return {
    env,
    title: workspaceTitle(env, []),
    project: projectOf(env, []).name,
    inCheckout: pathInCheckout(env, []),
    removed: t`Removed ${age} ago`,
    removedLabel: t`Removed ${age} ago by ${by}`,
    size: formatSize(archive.bytes.total),
    bytes: archive.bytes,
    lastUsedAt: archive.lastUsedAt,
    head: archive.worktree.head,
    subject: archive.worktree.subject,
    retention,
    logsExpired: expired('logs'),
    recordingsExpired: expired('recordings'),
    recordings: detail?.recordings ?? [],
    git,
    prLabel,
    merged,
    totals: {
      builds: archive.builds.count,
      cacheHits: detail
        ? history.filter((build) => build.cacheHit === 'local' || build.cacheHit === 'remote').length
        : null,
      offloaded: detail ? history.filter((build) => build.offloadedTo).length : null,
      errors: archive.builds.lastErrorCount,
    },
    sessions: archive.agents.map((agent) => ({
      agent,
      durationMs: agent.startedAt ? Math.max(0, Date.parse(agent.endedAt) - Date.parse(agent.startedAt)) : null,
    })),
  };
}

export type ArchivedPage = ReturnType<typeof archivedPage>;
