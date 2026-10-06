import { coerceSettingText, settingDefinition, settingValueError } from './settings-registry.ts';
import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { basename, join } from 'node:path';
import { archiveRoot } from './paths.ts';
import { isJsonObject, readJsonObject } from './json-file.ts';
import type { EndedAgentSession, LastBuildReport } from './status.ts';

export interface ArchivedBytes {
  logs: number;
  recordings: number;
  agentActions: number;
  record: number;
  total: number;
}

export interface ArchivedWorkspace {
  id: string;
  projectRoot: string;
  project: string;
  workspace: string;
  worktree: {
    repository: string | null;
    branch: string | null;
    head: string | null;
    subject: string | null;
    merged: boolean | null;
    pullRequest: { number: number; state: string; title: string; url: string } | null;
  };
  removedAt: string;
  removedBy: string;
  lastUsedAt: string | null;
  builds: { count: number; last: LastBuildReport | null; lastErrorCount: number };
  agents: EndedAgentSession[];
  bytes: ArchivedBytes;
  expires: { logs: string | null; recordings: string | null; agentActions: string | null; record: string | null };
  version: number;
  replacedBy?: string;
}

export interface ArchivedUsage {
  count: number;
  bytes: number;
  byKind: { logs: number; recordings: number; agentActions: number; record: number };
}

export function readArchives(): ArchivedWorkspace[] {
  let names: string[];
  try {
    names = readdirSync(archiveRoot());
  } catch {
    return [];
  }
  return names
    .flatMap((name) => {
      const archive = readArchive(name);
      return archive ? [archive] : [];
    })
    .toSorted((a, b) => Date.parse(b.removedAt) - Date.parse(a.removedAt) || b.id.localeCompare(a.id));
}

export function readArchive(id: string): ArchivedWorkspace | null {
  if (!id || id.startsWith('.') || basename(id) !== id || id.includes('\0')) return null;
  try {
    if (!lstatSync(join(archiveRoot(), id)).isDirectory()) return null;
  } catch {
    return null;
  }
  const record = readJsonObject(join(archiveRoot(), id, 'archive.json'));
  if (
    !record ||
    record.id !== id ||
    ['projectRoot', 'project', 'workspace', 'removedAt', 'removedBy'].some((key) => typeof record[key] !== 'string') ||
    !Number.isFinite(Date.parse(record.removedAt as string)) ||
    !isJsonObject(record.bytes) ||
    !isJsonObject(record.expires) ||
    !isJsonObject(record.worktree) ||
    !isJsonObject(record.builds) ||
    !Array.isArray(record.agents) ||
    typeof record.version !== 'number'
  )
    return null;
  const bytes = record.bytes as Record<string, unknown>;
  if (
    ['logs', 'recordings', 'agentActions', 'record', 'total'].some(
      (key) => typeof bytes[key] !== 'number' || !Number.isFinite(bytes[key]) || (bytes[key] as number) < 0,
    )
  )
    return null;
  return record as unknown as ArchivedWorkspace;
}

export function archivedUsage(archives: readonly ArchivedWorkspace[]): ArchivedUsage {
  const usage: ArchivedUsage = {
    count: archives.length,
    bytes: 0,
    byKind: { logs: 0, recordings: 0, agentActions: 0, record: 0 },
  };
  for (const archive of archives) {
    usage.bytes += archive.bytes.total;
    for (const kind of ['logs', 'recordings', 'agentActions', 'record'] as const)
      usage.byKind[kind] += archive.bytes[kind];
  }
  return usage;
}

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

export function linkReplacedArchives(
  archives: readonly ArchivedWorkspace[],
  paths: readonly string[],
): ArchivedWorkspace[] {
  const live = new Map(paths.map((path) => [canonical(path), path]));
  return archives.map((archive) => {
    const replacedBy = live.get(canonical(archive.projectRoot));
    return replacedBy ? { ...archive, replacedBy } : archive;
  });
}

function archiveEnabledValue(layer: unknown): unknown {
  if (!layer || typeof layer !== 'object') return undefined;
  const archive = (layer as { archive?: { enabled?: unknown } }).archive;
  return archive?.enabled;
}

export function archiveEnabled(env: NodeJS.ProcessEnv, layers: readonly unknown[]): boolean {
  const definition = settingDefinition('archive.enabled')!;
  const override = env[definition.env!];
  if ((!override || override === '') && env.STIM_HOME) return definition.scopedHomeValue as boolean;
  const value =
    override !== undefined && override !== ''
      ? coerceSettingText(definition, override)
      : (layers.map(archiveEnabledValue).find((candidate) => candidate !== undefined) ?? definition.default);
  const error = settingValueError(definition, value);
  if (error)
    throw new Error(`Invalid ${override !== undefined && override !== '' ? definition.env : definition.key}: ${error}`);
  return value as boolean;
}
