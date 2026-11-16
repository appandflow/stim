import { resolve } from 'node:path';
import { newBuildEndMarkerFile } from '@stim-cli/core/state';
import { writeCacheFile } from './cache-file.ts';

/**
 * Marks the folders a local native build of the workspace at `root` wrote as stale, for the daemon to measure. `root`
 * is the project root the command already holds; no filesystem read of the workspace happens here, so a stalled mount
 * cannot block the command after its compile. The daemon only walks a root that equals its own canonical path. It writes
 * one small file and never throws or prints: a failed write leaves the folders to the regular measurements.
 */
export function markBuildEnded(root: string): void {
  try {
    const path = resolve(root);
    writeCacheFile(newBuildEndMarkerFile(path), { path, markedAt: Date.now() });
  } catch {}
}
