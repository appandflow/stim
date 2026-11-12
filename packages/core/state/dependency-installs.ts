import { isJsonObject, readJsonObject } from './json-file.ts';
import { dependencyInstallFile } from './paths.ts';

/** A file in a dependency tree found changed after the install, as it was when found. */
export interface DependencyEditFile {
  rel: string;
  mtimeMs: number;
  size: number;
}

/** The files maintenance found changed in a dependency tree after its install. */
export interface DependencyEdits {
  /** The tree's install signature when it was walked; a reinstall or a fresh copy changes it. */
  signature: string;
  files: DependencyEditFile[];
  /** False when the walk stopped listing at its limit, so more files may have changed. */
  complete: boolean;
  at: string;
}

/** Changed files maintenance or a removal copied out of a tree before deleting it. */
export interface DependencySavedEdits {
  dir: string;
  restore: string;
  at: string;
  count: number;
}

export interface DependencyInstallRecord {
  tree: string;
  /** When the last install or warm copy Stim ran into the tree finished, in epoch milliseconds. */
  installedAt: number | null;
  /** The reference the last acting check compared the tree's files with, in epoch milliseconds. */
  reference: number | null;
  edits: DependencyEdits | null;
  saved: DependencySavedEdits[];
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readFiles(value: unknown): DependencyEditFile[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((file) =>
    isJsonObject(file) &&
    typeof file.rel === 'string' &&
    typeof file.mtimeMs === 'number' &&
    typeof file.size === 'number'
      ? [{ rel: file.rel, mtimeMs: file.mtimeMs, size: file.size }]
      : [],
  );
}

function readEdits(value: unknown): DependencyEdits | null {
  if (!isJsonObject(value) || typeof value.signature !== 'string' || typeof value.at !== 'string') return null;
  const files = readFiles(value.files);
  return files.length ? { signature: value.signature, files, complete: value.complete !== false, at: value.at } : null;
}

function readSaved(value: unknown): DependencySavedEdits[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) =>
    isJsonObject(entry) &&
    typeof entry.dir === 'string' &&
    typeof entry.restore === 'string' &&
    typeof entry.at === 'string' &&
    typeof entry.count === 'number'
      ? [{ dir: entry.dir, restore: entry.restore, at: entry.at, count: entry.count }]
      : [],
  );
}

export function readDependencyInstall(tree: string): DependencyInstallRecord | null {
  const record = readJsonObject(dependencyInstallFile(tree));
  if (!isJsonObject(record) || record.tree !== tree) return null;
  return {
    tree,
    installedAt: numberOrNull(record.installedAt),
    reference: numberOrNull(record.reference),
    edits: readEdits(record.edits),
    saved: readSaved(record.saved),
  };
}
