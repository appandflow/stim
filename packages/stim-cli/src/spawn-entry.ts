import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type SpawnEntryName = 'cli' | 'supervisor-run' | 'collector-run' | 'web-run' | 'macos-run' | 'daemon-run';

const DEV_ENTRIES: Record<SpawnEntryName, string> = {
  cli: '../bin/cli.ts',
  'supervisor-run': './supervisor/run.ts',
  'collector-run': './collector/run.ts',
  'web-run': './web/run.ts',
  'macos-run': './macos/run.ts',
  'daemon-run': './daemon/run.ts',
};

export function spawnEntry(name: SpawnEntryName): string {
  const here = fileURLToPath(import.meta.url);
  if (basename(dirname(here)) === 'src') {
    return fileURLToPath(new URL(DEV_ENTRIES[name], import.meta.url));
  }
  return join(dirname(here), `${name}.mjs`);
}
