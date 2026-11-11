import { readWorkspaceState, withWorkspaceStateLock, writeWorkspaceState } from '../../workspace/workspace-state.ts';
import { isJsonObject } from '@stim-cli/core/state';
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

export function readCollectors(root: string): Record<string, unknown> {
  return readWorkspaceState(collectorRoot(root))?.collectors || {};
}

export function unregisterStream(root: string, platform: string, streamId: string): void {
  root = collectorRoot(root);
  withWorkspaceStateLock(root, () => {
    const collectors: Record<string, unknown> = { ...readWorkspaceState(root)?.collectors };
    const record = collectors[platform] as { streamId?: unknown } | undefined;
    if (record?.streamId !== streamId) return;
    delete collectors[platform];
    writeWorkspaceState(root, { collectors: Object.keys(collectors).length ? collectors : undefined });
  });
}

export function sameCollectorRecord(a: unknown, b: unknown): boolean {
  if (!a || !b) return !a && !b;
  if (!isJsonObject(a) || !isJsonObject(b)) return false;
  if (a.kind === 'stream' || b.kind === 'stream')
    return a.kind === 'stream' && b.kind === 'stream' && typeof a.streamId === 'string' && a.streamId === b.streamId;
  return (
    (typeof a.pid === 'number' || typeof a.pid === 'string') && a.pid === b.pid && a.processToken === b.processToken
  );
}

export function removeCollectorIfSame(root: string, platform: string, expected: unknown): boolean {
  root = collectorRoot(root);
  return withWorkspaceStateLock(root, () => {
    const collectors: Record<string, unknown> = { ...readWorkspaceState(root)?.collectors };
    if (!sameCollectorRecord(collectors[platform], expected)) return false;
    delete collectors[platform];
    writeWorkspaceState(root, { collectors: Object.keys(collectors).length ? collectors : undefined });
    return true;
  });
}

export function unregisterStreamAll(root: string, streamId: string): void {
  root = collectorRoot(root);
  withWorkspaceStateLock(root, () => {
    const collectors: Record<string, unknown> = { ...readWorkspaceState(root)?.collectors };
    for (const [key, record] of Object.entries(collectors))
      if (isJsonObject(record) && record.kind === 'stream' && record.streamId === streamId) delete collectors[key];
    writeWorkspaceState(root, { collectors: Object.keys(collectors).length ? collectors : undefined });
  });
}

export function markStreamHandedOver(root: string, streamId: string): void {
  root = collectorRoot(root);
  withWorkspaceStateLock(root, () => {
    const collectors: Record<string, unknown> = { ...readWorkspaceState(root)?.collectors };
    for (const [key, record] of Object.entries(collectors))
      if (isJsonObject(record) && record.kind === 'stream' && record.streamId === streamId)
        collectors[key] = { ...record, handover: true, handedOverAt: new Date().toISOString() };
    writeWorkspaceState(root, { collectors });
  });
}

export const handedOverStream = (record: unknown): record is Record<string, unknown> & { streamId: string } =>
  isJsonObject(record) && record.kind === 'stream' && record.handover === true && typeof record.streamId === 'string';
