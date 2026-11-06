import { existsSync, readdirSync, utimesSync } from 'node:fs';
import { join } from 'node:path';

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
