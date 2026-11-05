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
  const replaced = `${dest}.replaced-${process.pid}`;
  const target = join(staging, basename(buildPath));
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  try {
    try {
      runFile('cp', ['-c', '-R', buildPath, target]);
    } catch {
      rmSync(target, { recursive: true, force: true });
      runFile('cp', ['-R', buildPath, target]);
    }
    writeMetadata?.(staging);

    const published = artifactIn(dest);
    if (published && !overwrite) {
      rmSync(staging, { recursive: true, force: true });
      return published;
    }
    mkdirSync(dirname(dest), { recursive: true });
    rmSync(replaced, { recursive: true, force: true });
    if (existsSync(dest)) renameSync(dest, replaced);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }

  try {
    renameSync(staging, dest);
  } catch (error) {
    try {
      renameSync(replaced, dest);
    } catch {}
    if (!onRenameError) {
      rmSync(staging, { recursive: true, force: true });
      rmSync(replaced, { recursive: true, force: true });
      throw error;
    }
    onRenameError(staging);
  }
  rmSync(replaced, { recursive: true, force: true });
  return artifactIn(dest);
}
