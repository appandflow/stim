import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The Stim package this code was built into: the `stim` package around this chunk's `dist`, so a net thread runs its
 * own build's CLI; from source, the workspace's `stim`.
 */
export function bundledStim(): { cli: string; version: string } {
  const own = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
  const manifest =
    existsSync(own) && JSON.parse(readFileSync(own, 'utf8')).name === 'stim'
      ? own
      : createRequire(import.meta.url).resolve('stim/package.json');
  const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as { version: string; bin: { stim: string } };
  return { cli: join(dirname(manifest), pkg.bin.stim), version: pkg.version };
}
