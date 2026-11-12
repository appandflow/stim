import type { MaintenanceAction, MaintenanceSize } from '@stim-cli/core/state';
import type { MaintenanceSettings } from './settings.ts';

const CAP_TARGET = 0.8;

export interface MaintenancePlan {
  actions: MaintenanceAction[];
  blocked: string[];
  skips: MaintenanceSkip[];
}

export type MaintenanceSkip = {
  target: string;
  reason: string;
  workspace?: string;
  code?: string;
};

export const skipKey = (skip: Pick<MaintenanceSkip, 'target' | 'code'>): string =>
  skip.code ? `${skip.target} (${skip.code})` : skip.target;

/** The cap trims of the hourly size scan: workspace outputs and the shared caches over their caps, oldest first. */
export function plan({
  sizes,
  settings,
  protectedRoot,
  pinned = () => false,
  recentlyUsed = () => null,
  sourceRoots = new Set(),
}: {
  sizes: readonly MaintenanceSize[];
  settings: MaintenanceSettings;
  protectedRoot: string;
  pinned?: (workspace: string) => boolean;
  recentlyUsed?: (workspace: string) => string | null;
  /** Workspaces that are source checkouts: a cap trims them after every linked worktree. */
  sourceRoots?: ReadonlySet<string>;
}): MaintenancePlan {
  const actions: MaintenanceAction[] = [];
  const blocked: string[] = [];
  const skips: MaintenancePlan['skips'] = [];
  const add = (action: MaintenanceAction): boolean => {
    if (action.kind === 'would-clear-outputs' && action.workspace && pinned(action.workspace)) {
      skips.push({ target: action.workspace, reason: 'pinned by maintenance.keep', workspace: action.workspace });
      return false;
    }
    const recent = action.kind === 'would-clear-outputs' && action.workspace ? recentlyUsed(action.workspace) : null;
    if (recent) {
      skips.push({ target: action.workspace!, reason: recent, workspace: action.workspace! });
      return false;
    }
    if (actions.some((entry) => entry.kind === action.kind && entry.target === action.target)) return false;
    actions.push(action);
    return true;
  };
  const caps = [
    ['workspace-outputs', settings.workspaceOutputsMaxGb, 'would-clear-outputs'],
    ['build-cache', settings.buildCacheMaxGb, 'would-trim-cache'],
    ['metro-cache', settings.metroCacheMaxGb, 'would-trim-cache'],
    ['compilation-cache', settings.swiftCompilationCacheMaxGb, 'would-empty-cache'],
  ] as const;
  for (const [category, capGb, kind] of caps) {
    const entries = sizes.filter((size) => size.category === category);
    const total = entries.reduce((sum, size) => sum + size.bytes, 0);
    const cap = capGb * 1024 ** 3;
    if (cap === 0 || total <= cap) continue;
    let remaining = total;
    const targetBytes = cap * CAP_TARGET;
    const why = `${category} ${(total / 1024 ** 3).toFixed(1)}G over the ${capGb}G cap; ${
      category === 'compilation-cache' ? 'emptied whole' : `target ${(targetBytes / 1024 ** 3).toFixed(1)}G`
    }`;
    const sourceRank = (size: MaintenanceSize) => (size.workspace && sourceRoots.has(size.workspace) ? 1 : 0);
    for (const size of entries.toSorted(
      (a, b) => sourceRank(a) - sourceRank(b) || (b.idleDays ?? 0) - (a.idleDays ?? 0),
    )) {
      if (remaining <= targetBytes) break;
      const kept = size.workspace === protectedRoot ? 'the triggering workspace is protected' : size.blocked;
      if (kept) {
        skips.push({
          target: size.dir,
          reason: kept,
          ...(size.workspace ? { workspace: size.workspace } : {}),
        });
        continue;
      }
      const bytes =
        kind === 'would-trim-cache' ? Math.round(Math.min(size.bytes, remaining - targetBytes)) : size.bytes;
      if (
        !add({
          kind,
          target: size.workspace ?? size.dir,
          bytes,
          reason: `${!size.workspace || size.idleDays == null ? '' : `idle ${size.idleDays} days, `}${why}`,
          ...(size.workspace ? { workspace: size.workspace } : {}),
          ...(kind === 'would-clear-outputs' ? {} : { dir: size.dir }),
        })
      )
        continue;
      remaining -= bytes;
    }
    if (remaining > targetBytes) blocked.push(`${why}; eligible targets cannot reach the target`);
  }
  return { actions, blocked, skips };
}
