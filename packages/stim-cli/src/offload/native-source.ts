import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fingerprintNativeInputs } from '../integrations/native-inputs.ts';
import { manifestDigest } from './manifest.ts';
import { getExecutor } from '../exec.ts';
import type { NativeInputSnapshot } from '../integrations/native-inputs.ts';

export interface NativeTransferFile {
  path: string;
  kind: 'file' | 'exec' | 'link' | 'directory';
  size: number;
  sha256: string;
}

function* repositoryInputs(
  snapshot: NativeInputSnapshot,
): Generator<{ entry: NativeInputSnapshot['entries'][number]; path: string }> {
  const links = snapshot.entries.filter((entry) => entry.kind === 'link').map((entry) => `${entry.path}/@target`);
  for (const entry of snapshot.entries) {
    if (entry.path === 'repository') continue;
    if (!entry.path.startsWith('repository/'))
      throw new Error('Native offload requires every input to be inside the repository.');
    if (links.some((link) => entry.path === link || entry.path.startsWith(`${link}/`))) continue;
    yield { entry, path: entry.path.slice('repository/'.length) };
  }
}

const absentInput = (path: string): Error =>
  new Error(`Native input ${path} is ignored or absent from the source transfer; it was not uploaded.`);

/** Throws the same membership refusal as nativeTransferManifest, from the git-visible paths alone. */
export function checkNativeTransferMembership(snapshot: NativeInputSnapshot, visible: ReadonlySet<string>): void {
  for (const { entry, path } of repositoryInputs(snapshot))
    if (entry.kind !== 'directory' && !visible.has(path)) throw absentInput(path);
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
  for (const { entry, path } of repositoryInputs(snapshot)) {
    if (entry.kind === 'directory') {
      selected.push({ path, kind: 'directory', size: 0, sha256: empty });
      continue;
    }
    const file = files.get(path);
    if (!file) throw absentInput(path);
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

/** The exact source a build needs: tracked and untracked, not ignored, as `git ls-files -co --exclude-standard`. */
export function sourceManifest(repoRoot: string, strict = false): NativeTransferFile[] {
  const files: NativeTransferFile[] = [];
  for (const path of gitVisiblePaths(repoRoot)) {
    const absolute = join(repoRoot, path);
    let stat;
    try {
      stat = lstatSync(absolute);
    } catch (error) {
      if (strict && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      continue;
    }
    if (stat.isSymbolicLink()) {
      const target = Buffer.from(readlinkSync(absolute));
      files.push({
        path,
        kind: 'link',
        size: target.length,
        sha256: createHash('sha256').update(target).digest('hex'),
      });
    } else if (stat.isFile()) {
      const content = readFileSync(absolute);
      files.push({
        path,
        kind: stat.mode & 0o111 ? 'exec' : 'file',
        size: content.length,
        sha256: createHash('sha256').update(content).digest('hex'),
      });
    } else if (strict)
      throw new Error(`Native source ${path} is not a file or link; transfer submodule contents explicitly.`);
  }
  return files;
}

export function gitVisiblePaths(repoRoot: string): Set<string> {
  const listed = getExecutor().runFile('git', ['-C', repoRoot, 'ls-files', '-z', '-co', '--exclude-standard'], {
    untrimmed: true,
    timeoutMs: 120_000,
  });
  return new Set(listed.split('\0').filter(Boolean));
}
