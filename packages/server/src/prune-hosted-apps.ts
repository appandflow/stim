import { readdirSync, realpathSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { withDirLock } from '@stim-cli/core';
import { deviceHostArea, hostedAppAttempt, readHostedApp } from '@stim-cli/core/state';

/** Runs only after a replacement install has completed, including the macOS worker's previous-process teardown. */
export function pruneHostedApps(session: string, current: string): void {
  const requested = deviceHostArea(session);
  const area = join(realpathSync(dirname(requested)), basename(requested));
  const apps = join(area, 'apps');
  const blobs = join(area, 'blobs');
  withDirLock(`${blobs}.lock`, () => {
    for (const path of [area, apps, blobs])
      if (realpathSync(path) !== path) throw new Error('Hosted app storage resolves outside its owned area.');
    const records = readdirSync(apps, { withFileTypes: true })
      .filter((entry) => hostedAppAttempt(entry.name))
      .map((entry) => {
        if (!entry.isDirectory()) throw new Error('A hosted app attempt is not an owned directory.');
        return readHostedApp(session, entry.name);
      });
    if (records.find((record) => record.attempt === current)?.state !== 'installed')
      throw new Error('The replacement app installation is unresolved.');
    const obsolete = records.filter((record) => record.attempt !== current && record.state === 'installed');
    const kept = records.filter((record) => record.attempt === current || record.state !== 'installed');
    const referenced = new Set(
      kept.flatMap((record) => [record.manifest.sha256, ...record.files.map((f) => f.sha256)]),
    );
    const unused = kept.every((record) => record.files.length > 0)
      ? readdirSync(blobs, { withFileTypes: true }).filter(
          (entry) => entry.isFile() && /^[a-f0-9]{64}$/.test(entry.name) && !referenced.has(entry.name),
        )
      : [];
    for (const record of obsolete) {
      const path = join(apps, record.attempt);
      if (realpathSync(path) !== path) throw new Error('The obsolete hosted app resolves outside its owned area.');
      rmSync(path, { recursive: true });
    }
    for (const entry of unused) rmSync(join(blobs, entry.name));
  });
}
