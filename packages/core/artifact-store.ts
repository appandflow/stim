import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, utimesSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

export function artifactIn(dir: string): string | null {
  if (!existsSync(dir)) return null;
  let found;
  try {
    found = readdirSync(dir).find((f) => f.endsWith('.app') || f.endsWith('.apk'));
  } catch {
    return null;
  }
  return found ? join(dir, found) : null;
}

export function resolveArtifact(dir: string): string | null {
  const hit = artifactIn(dir);
  if (!hit) return null;
  try {
    utimesSync(dir, new Date(), new Date());
  } catch {}
  return hit;
}

export interface StoreArtifactOptions {
  runFile: (file: string, args: string[]) => unknown;
  overwrite?: boolean;
  writeMetadata?: (stagingDir: string) => void;
  onRenameError?: (stagingDir: string) => void;
}

export function storeArtifact(
  dest: string,
  buildPath: string,
  { runFile, overwrite = false, writeMetadata, onRenameError }: StoreArtifactOptions,
): string | null {
  const existing = artifactIn(dest);
  if (existing && !overwrite) return existing;

  const staging = `${dest}.staging-${process.pid}`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  try {
    runFile('cp', ['-c', '-R', buildPath, join(staging, basename(buildPath))]);
  } catch {
    runFile('cp', ['-R', buildPath, join(staging, basename(buildPath))]);
  }

  writeMetadata?.(staging);
  mkdirSync(dirname(dest), { recursive: true });
  rmSync(dest, { recursive: true, force: true });
  try {
    renameSync(staging, dest);
  } catch (error) {
    if (!onRenameError) throw error;
    onRenameError(staging);
  }
  return artifactIn(dest);
}
