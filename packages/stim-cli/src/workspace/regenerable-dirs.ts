import { lstatSync } from 'node:fs';
import { join, relative } from 'node:path';
import { canonicalPath } from '../commands/gc/paths.ts';
import { gitQuiet } from './git.ts';

export type ArtifactKind = 'build' | 'dependencies';

/** Directories that hold only what a build or an install regenerates, relative to an app or package root. */
export const ARTIFACT_DIRS: Record<ArtifactKind, readonly string[]> = {
  build: ['ios/build', 'android/app/build', 'android/build', 'android/.gradle', '.build'],
  dependencies: ['node_modules', 'ios/Pods'],
};

/** The existing real directories of `kind` directly under `root`, never through a link. */
export function regenerableDirsOf(root: string, kind: ArtifactKind): string[] {
  return ARTIFACT_DIRS[kind]
    .map((dir) => join(root, dir))
    .filter((path) => {
      try {
        return lstatSync(path).isDirectory();
      } catch {
        return false;
      }
    });
}

/** Why `path`, inside the checkout at `root`, must not be deleted as a regenerable directory, or null when it may. */
export function regenerableDirProblem(root: string, path: string): string | null {
  const rel = relative(root, path);
  try {
    if (!lstatSync(path).isDirectory()) return 'it is not a directory';
  } catch {
    return 'it is gone';
  }
  if (canonicalPath(path) !== join(canonicalPath(root), rel))
    return 'it or a directory above it is a link, or it lies outside its project';
  const tracked = gitQuiet(root, ['ls-files', '--', rel]);
  if (tracked === null) return 'git cannot tell whether it holds tracked files';
  if (tracked.trim()) return 'it holds files git tracks';
  if (gitQuiet(root, ['check-ignore', '-q', '--', `${rel}/`]) === null) return 'git does not ignore it';
  return null;
}
