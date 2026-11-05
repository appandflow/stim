import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

export function bundledStim(): { cli: string; version: string } {
  const manifest = createRequire(import.meta.url).resolve('stim/package.json');
  const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as { version: string; bin: { stim: string } };
  return { cli: join(dirname(manifest), pkg.bin.stim), version: pkg.version };
}
