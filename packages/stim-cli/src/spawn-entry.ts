import { realpathSync } from 'node:fs';
import { basename, dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stimBuildDigest } from '@stim-cli/core/state';

export type SpawnEntryName =
  | 'cli'
  | 'supervisor-run'
  | 'collector-run'
  | 'web-run'
  | 'macos-run'
  | 'daemon-run'
  | 'passes-run';

const DEV_ENTRIES: Record<SpawnEntryName, string> = {
  cli: '../bin/cli.ts',
  'supervisor-run': './supervisor/run.ts',
  'collector-run': './collector/run.ts',
  'web-run': './web/run.ts',
  'macos-run': './macos/run.ts',
  'daemon-run': './daemon/run.ts',
  'passes-run': './daemon/passes-run.ts',
};

export function spawnEntry(name: SpawnEntryName): string {
  const here = fileURLToPath(import.meta.url);
  if (basename(dirname(here)) === 'src') {
    return fileURLToPath(new URL(DEV_ENTRIES[name], import.meta.url));
  }
  return join(dirname(here), `${name}.mjs`);
}

/** The digest of the built Stim these entries belong to; null when Stim runs from source. */
export function stimBuild(): string | null {
  return stimBuildDigest(dirname(fileURLToPath(import.meta.url)));
}

/**
 * Whether this Stim runs from an installed package: its code, symlinks resolved, sits under a `node_modules`
 * directory, as in an npm or pnpm global install or a project dependency. A checkout's own `dist` and a run from
 * source are development builds.
 */
export function installedBuild(): boolean {
  try {
    return realpathSync(dirname(fileURLToPath(import.meta.url)))
      .split(sep)
      .includes('node_modules');
  } catch {
    return false;
  }
}
