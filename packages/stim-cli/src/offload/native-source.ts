import { createHash } from 'node:crypto';
import { readlinkSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fingerprintNativeInputs } from '../integrations/native-inputs.ts';
import { manifestDigest } from './manifest.ts';
import type { NativeInputSnapshot } from '../integrations/native-inputs.ts';

export interface NativeTransferFile {
  path: string;
  kind: 'file' | 'exec' | 'link' | 'directory';
  size: number;
  sha256: string;
}

export function nativeTransferManifest(
  root: string,
  snapshot: NativeInputSnapshot,
  visible: readonly NativeTransferFile[],
): NativeTransferFile[] {
  const files = new Map(visible.map((file) => [file.path, file]));
  root = realpathSync(root);
  const selected: NativeTransferFile[] = [];
  const empty = createHash('sha256').update('').digest('hex');
  const links = snapshot.entries.filter((entry) => entry.kind === 'link').map((entry) => `${entry.path}/@target`);
  for (const entry of snapshot.entries) {
    if (entry.path === 'repository') continue;
    if (!entry.path.startsWith('repository/'))
      throw new Error('Native offload requires every input to be inside the repository.');
    const path = entry.path.slice('repository/'.length);
    if (links.some((link) => entry.path === link || entry.path.startsWith(`${link}/`))) continue;
    if (entry.kind === 'directory') {
      selected.push({ path, kind: 'directory', size: 0, sha256: empty });
      continue;
    }
    const file = files.get(path);
    if (!file)
      throw new Error(`Native input ${path} is ignored or absent from the source transfer; it was not uploaded.`);
    const kind = entry.kind === 'file:0' ? 'file' : entry.kind === 'file:73' ? 'exec' : entry.kind;
    if (kind !== file.kind || entry.sha256 !== file.sha256)
      throw new Error(`Native input ${path} changed or has an unsupported executable mode.`);
    selected.push(file);
    if (kind === 'link') {
      const link = join(root, path);
      const target = readlinkSync(link);
      const destination = relative(root, realpathSync(resolve(dirname(link), target)));
      if (isAbsolute(target) || isAbsolute(destination) || destination === '..' || destination.startsWith(`..${sep}`))
        throw new Error(`Native input ${path} has a link that cannot be relocated inside the repository.`);
    }
  }
  return selected.toSorted((a, b) => a.path.localeCompare(b.path));
}

export function verifyNativeTransfer(
  root: string,
  files: readonly NativeTransferFile[],
  digest: string,
  ignoredDirectoryMarkers: readonly string[] = [],
): boolean {
  const snapshot = fingerprintNativeInputs([{ name: 'repository', path: root }], {
    excluded: [join(root, '.git')],
    ignoredDirectoryMarkers,
    parameters: null,
  });
  return manifestDigest(nativeTransferManifest(root, snapshot, files)) === digest;
}
