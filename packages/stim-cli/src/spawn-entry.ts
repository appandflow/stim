import { realpathSync } from 'node:fs';
import { basename, dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stimBuildDigest } from '@stim-cli/core/state';
import { STIM_VERSION } from './stim-version.ts';

export type SpawnEntryName = 'cli' | 'supervisor-run' | 'collector-run' | 'web-run' | 'macos-run' | 'stimd-thread';

const DEV_ENTRIES: Record<SpawnEntryName, string> = {
  cli: '../bin/cli.ts',
  'supervisor-run': './supervisor/run.ts',
  'collector-run': './collector/run.ts',
  'web-run': './web/run.ts',
  'macos-run': './macos/run.ts',
  'stimd-thread': './stimd/threads.ts',
};

export function spawnEntry(name: SpawnEntryName): string {
  const here = fileURLToPath(import.meta.url);
  if (basename(dirname(here)) === 'src') {
    return fileURLToPath(new URL(DEV_ENTRIES[name], import.meta.url));
  }
  return join(dirname(here), `${name}.mjs`);
}

export interface StimBuild {
  /**
   * Whether this Stim runs from an installed package: its code, symlinks resolved, sits under a `node_modules`
   * directory. A checkout's own `dist`, `npm link`, `pnpm link --global` and a run from source are development builds.
   */
  installed: boolean;
  /** The digest of an installed build's code; null for a development build. */
  digest: string | null;
  version: string;
}

/** The Stim these entries belong to. */
export function stimBuild(): StimBuild {
  const dir = dirname(fileURLToPath(import.meta.url));
  let installed = false;
  try {
    installed = realpathSync(dir).split(sep).includes('node_modules');
  } catch {}
  return { installed, digest: installed ? stimBuildDigest(dir) : null, version: STIM_VERSION };
}
