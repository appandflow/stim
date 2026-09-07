import { readWorkspaceState, withWorkspaceStateLock, writeWorkspaceState } from '../supervisor/state.ts';
import { realpathSync } from 'node:fs';

function collectorRoot(root: string): string {
  try {
    return realpathSync(root);
  } catch {
    return root;
  }
}

export function registerCollector(
  root: string,
  platform: string,
  record: Record<string, unknown>,
): Record<string, unknown> {
  root = collectorRoot(root);
  return withWorkspaceStateLock(root, () => {
    const collectors = { ...readWorkspaceState(root)?.collectors, [platform]: record };
    writeWorkspaceState(root, { collectors });
    return collectors;
  });
}

export function unregisterCollector(
  root: string,
  platform: string,
  pid: number,
  processToken: string,
): Record<string, unknown> {
  root = collectorRoot(root);
  return withWorkspaceStateLock(root, () => {
    const state = readWorkspaceState(root);
    const collectors: Record<string, unknown> = { ...state?.collectors };
    const record = collectors[platform] as { pid?: unknown; processToken?: unknown } | undefined;
    if (!(platform in collectors) || record?.pid !== pid || record.processToken !== processToken) return collectors;
    delete collectors[platform];
    writeWorkspaceState(root, { collectors: Object.keys(collectors).length ? collectors : undefined });
    return collectors;
  });
}

export function readCollectors(root: string): Record<string, unknown> {
  return readWorkspaceState(collectorRoot(root))?.collectors || {};
}
