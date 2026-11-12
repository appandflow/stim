import { existsSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ensurePrivateDir, withDirLock } from '@stim-cli/core';
import { isOnMountedVolume, listMountedVolumes } from '../fs-util.ts';
import {
  dependencyInstallDir,
  dependencyInstallFile,
  readDependencyInstall,
  readJsonObject,
  type DependencyInstallRecord,
} from '@stim-cli/core/state';

/**
 * Whether an absent tree is shown gone rather than on a volume that is not mounted. On Linux the mounted volumes Stim
 * lists are only `/`, so there its parent directory must still exist.
 */
function goneFromMountedVolume(tree: string, volumes: string[]): boolean {
  return (process.platform !== 'linux' || existsSync(dirname(tree))) && isOnMountedVolume(tree, volumes);
}

/** Rewrites the record of `tree` under its lock; a null update deletes it. */
export function updateDependencyInstall(
  tree: string,
  update: (record: DependencyInstallRecord) => DependencyInstallRecord | null,
): void {
  const file = dependencyInstallFile(tree);
  ensurePrivateDir(dirname(file));
  withDirLock(`${file}.lock`, () => {
    const next = update(
      readDependencyInstall(tree) ?? { tree, installedAt: null, reference: null, edits: null, saved: [] },
    );
    if (!next) {
      rmSync(file, { force: true });
      return;
    }
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, file);
  });
}

/**
 * Drops saved copies retention removed from the dependency records, and the records of trees that are gone with no
 * saved copy left.
 */
export function pruneDependencyInstallRecords(): void {
  let names: string[];
  try {
    names = readdirSync(dependencyInstallDir()).filter((name) => name.endsWith('.json'));
  } catch {
    return;
  }
  const volumes = listMountedVolumes();
  for (const name of names) {
    const tree = readJsonObject(join(dependencyInstallDir(), name))?.tree;
    if (typeof tree !== 'string') continue;
    try {
      updateDependencyInstall(tree, (record) => {
        const saved = record.saved.filter((entry) => existsSync(join(entry.dir, 'manifest.json')));
        // @ref LLP 0002#fail-closed -- an absent tree on an unmounted volume is not proof it is gone
        if (!saved.length && !existsSync(tree) && goneFromMountedVolume(tree, volumes)) return null;
        return { ...record, saved };
      });
    } catch {}
  }
}
