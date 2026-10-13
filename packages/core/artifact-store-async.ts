import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { artifactIn, type StoreArtifactOptions } from './artifact-store.ts';

export interface AsyncStoreArtifactOptions extends Omit<StoreArtifactOptions, 'runFile'> {
  /** Resolves after the copy and its owned child work have ended. */
  runFile: (file: string, args: string[]) => Promise<unknown>;
  signal?: AbortSignal;
}

/** Awaits copying before atomic publication; cancellation before publication preserves the previous entry. */
export async function storeArtifactAsync(
  dest: string,
  buildPath: string,
  { runFile, overwrite = false, writeMetadata, onRenameError, signal }: AsyncStoreArtifactOptions,
): Promise<string | null> {
  signal?.throwIfAborted();
  const existing = artifactIn(dest);
  if (existing && !overwrite) return existing;

  const token = randomUUID();
  const staging = `${dest}.staging-${token}`;
  const replaced = `${dest}.replaced-${token}`;
  const target = join(staging, basename(buildPath));
  await mkdir(staging, { recursive: true });
  try {
    signal?.throwIfAborted();
    try {
      await runFile('cp', ['-c', '-R', buildPath, target]);
    } catch {
      signal?.throwIfAborted();
      await rm(target, { recursive: true, force: true });
      signal?.throwIfAborted();
      await runFile('cp', ['-R', buildPath, target]);
    }
    signal?.throwIfAborted();
    await writeMetadata?.(staging);
    signal?.throwIfAborted();

    const published = artifactIn(dest);
    if (published && !overwrite) return published;
    mkdirSync(dirname(dest), { recursive: true });
    if (existsSync(dest)) renameSync(dest, replaced);
    try {
      renameSync(staging, dest);
    } catch (error) {
      try {
        renameSync(replaced, dest);
      } catch {}
      if (!onRenameError) throw error;
      await onRenameError(staging);
    }
    return artifactIn(dest);
  } finally {
    await rm(staging, { recursive: true, force: true });
    await rm(replaced, { recursive: true, force: true });
  }
}
