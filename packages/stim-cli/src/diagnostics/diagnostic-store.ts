import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { withDirLockAsync } from '@stim-cli/core';
import { withDirLock } from '../dir-lock.ts';

/** Publishes an immutable diagnostic snapshot atomically; existing evidence wins. */
export function writeDiagnosticOnce(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  withDirLock(
    `${path}.lock`,
    () => {
      if (existsSync(path)) return;
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        writeFileSync(temporary, content, { flag: 'wx' });
        renameSync(temporary, path);
      } finally {
        try {
          unlinkSync(temporary);
        } catch {}
      }
    },
    { waitMs: 100, pollMs: 10 },
  );
}

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
