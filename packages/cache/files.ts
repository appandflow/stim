import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { link, lstat, mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { FileCacheCapability } from './provider.ts';

/** Opaque immutable files in a caller-owned directory, with atomic publication and cancellable downloads. */
export function createFilesystemFileCache(
  directory: string,
): FileCacheCapability & Required<Pick<FileCacheCapability, 'stat'>> {
  const entry = (key: string) => join(directory, createHash('sha256').update(key).digest('hex'));
  const present: NonNullable<FileCacheCapability['stat']> = async ({ key, signal }) => {
    signal.throwIfAborted();
    try {
      const info = await lstat(entry(key));
      signal.throwIfAborted();
      return info.isFile() ? { size: info.size } : null;
    } catch (error) {
      if ((error instanceof Error && 'code' in error ? error.code : undefined) === 'ENOENT') return null;
      throw error;
    }
  };
  return {
    stat: present,
    async resolve({ key, destinationDir, signal }) {
      if (!(await present({ key, signal }))) return null;
      const temporary = join(destinationDir, `${randomUUID()}.partial`);
      const complete = join(destinationDir, `${randomUUID()}.cache`);
      try {
        await mkdir(destinationDir, { recursive: true, mode: 0o700 });
        await pipeline(createReadStream(entry(key)), createWriteStream(temporary, { flags: 'wx', mode: 0o600 }), {
          signal,
        });
        signal.throwIfAborted();
        await rename(temporary, complete);
        return complete;
      } catch (error) {
        signal.throwIfAborted();
        if ((error instanceof Error && 'code' in error ? error.code : undefined) === 'ENOENT') return null;
        throw error;
      } finally {
        await rm(temporary, { force: true });
      }
    },
    async store({ key, sourcePath, overwrite, signal }) {
      signal.throwIfAborted();
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const temporary = join(directory, `${randomUUID()}.partial`);
      try {
        await pipeline(createReadStream(sourcePath), createWriteStream(temporary, { flags: 'wx', mode: 0o600 }), {
          signal,
        });
        signal.throwIfAborted();
        if (overwrite) await rename(temporary, entry(key));
        else {
          try {
            await link(temporary, entry(key));
          } catch (error) {
            if ((error instanceof Error && 'code' in error ? error.code : undefined) !== 'EEXIST') throw error;
          }
        }
      } finally {
        await rm(temporary, { force: true });
      }
    },
  };
}
