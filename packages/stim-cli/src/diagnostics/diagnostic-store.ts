import { randomUUID } from 'node:crypto';
import { existsSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { withDirLockAsync } from '@stim-cli/core';

/** Publishes an immutable diagnostic snapshot without blocking on content writes or lock contention. */
export async function writeDiagnosticOnceAsync(path: string, content: string, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { flag: 'wx', signal });
    await withDirLockAsync(
      `${path}.lock`,
      () => {
        signal?.throwIfAborted();
        if (!existsSync(path)) renameSync(temporary, path);
      },
      { waitMs: 100, pollMs: 10 },
    );
  } finally {
    await unlink(temporary).catch(() => {});
  }
}
