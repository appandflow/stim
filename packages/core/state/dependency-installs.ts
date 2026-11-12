import { isJsonObject, readJsonObject } from './json-file.ts';
import { dependencyInstallFile } from './paths.ts';

/** The files maintenance found changed in a dependency tree after its install, as of the tree's install signature. */
export interface DependencyEdits {
  /** The tree's install signature when it was walked; a reinstall or a fresh copy changes it. */
  signature: string;
  count: number;
  /** False when the walk stopped listing at its limit, so more files may have changed. */
  complete: boolean;
  /** The first changed files, relative to the tree. */
  files: string[];
  at: string;
}

export interface DependencyInstallRecord {
  tree: string;
  /** When the last install or warm copy Stim ran into the tree finished, in epoch milliseconds. */
  installedAt: number | null;
  edits: DependencyEdits | null;
}

function readEdits(value: unknown): DependencyEdits | null {
  if (
    !isJsonObject(value) ||
    typeof value.signature !== 'string' ||
    typeof value.count !== 'number' ||
    typeof value.at !== 'string' ||
    !Array.isArray(value.files)
  )
    return null;
  return {
    signature: value.signature,
    count: value.count,
    complete: value.complete !== false,
    files: value.files.filter((file): file is string => typeof file === 'string'),
    at: value.at,
  };
}

export function readDependencyInstall(tree: string): DependencyInstallRecord | null {
  const record = readJsonObject(dependencyInstallFile(tree));
  if (!isJsonObject(record) || record.tree !== tree) return null;
  return {
    tree,
    installedAt: typeof record.installedAt === 'number' ? record.installedAt : null,
    edits: readEdits(record.edits),
  };
}
