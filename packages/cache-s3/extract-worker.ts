import { createReadStream } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { extract } from 'tar';

process.once('message', async ({ archive, staging }: { archive: string; staging: string }) => {
  try {
    let invalidLink = false;
    await pipeline(
      createReadStream(archive),
      extract({
        cwd: staging,
        strict: true,
        filter(path, entry) {
          if (!('type' in entry)) return true;
          if (entry.type !== 'SymbolicLink' && entry.type !== 'Link') return true;
          const link = entry.linkpath ?? '';
          const target = resolve(staging, entry.type === 'SymbolicLink' ? dirname(path) : '', link);
          const root = relative(staging, resolve(staging, path)).split(sep)[0];
          const outside = relative(resolve(staging, root ?? ''), target);
          if (isAbsolute(link) || outside === '..' || outside.startsWith(`..${sep}`)) {
            invalidLink = true;
            return false;
          }
          return true;
        },
      }),
    );
    if (invalidLink) throw new Error('The S3 build entry contains a link outside the artifact.');
    process.send?.({ value: true }, () => process.exit(0));
  } catch (error) {
    process.send?.(
      {
        error: {
          message: error instanceof Error ? error.message : String(error),
          ...(error instanceof Error && 'code' in error && typeof error.code === 'string' ? { code: error.code } : {}),
        },
      },
      () => process.exit(1),
    );
  }
});
