import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { withDirLock } from './dir-lock.ts';

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
