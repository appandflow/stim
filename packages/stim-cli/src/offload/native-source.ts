import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readlink, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fingerprintNativeInputs } from '../integrations/native-inputs.ts';
import { manifestDigest } from './manifest.ts';
import { gitAsync } from '../workspace/git.ts';
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
  for (const { entry, path } of repositoryInputs(snapshot)) {
    if (entry.kind === 'directory' || visible.has(path)) continue;
    for (let index = path.indexOf('/'); index !== -1; index = path.indexOf('/', index + 1))
      if (visible.has(path.slice(0, index)))
        throw new Error(
          `Native input ${path} is inside the git submodule ${path.slice(0, index)}; submodules are not transferred.`,
        );
    throw absentInput(path);
  }
}

export async function nativeTransferManifest(
  root: string,
  snapshot: NativeInputSnapshot,
  visible: readonly NativeTransferFile[],
  signal?: AbortSignal,
): Promise<NativeTransferFile[]> {
  const files = new Map(visible.map((file) => [file.path, file]));
  signal?.throwIfAborted();
  root = await realpath(root);
  const selected: NativeTransferFile[] = [];
  const empty = createHash('sha256').update('').digest('hex');
  for (const { entry, path } of repositoryInputs(snapshot)) {
    signal?.throwIfAborted();
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
      const target = await readlink(link);
      const destination = relative(root, await realpath(resolve(dirname(link), target)));
      if (isAbsolute(target) || isAbsolute(destination) || destination === '..' || destination.startsWith(`..${sep}`))
        throw new Error(`Native input ${path} has a link that cannot be relocated inside the repository.`);
    }
  }
  return selected.toSorted((a, b) => a.path.localeCompare(b.path));
}

export async function verifyNativeTransfer(
  root: string,
  files: readonly NativeTransferFile[],
  digest: string,
  ignoredDirectoryMarkers: readonly string[] = [],
): Promise<boolean> {
  const snapshot = await fingerprintNativeInputs([{ name: 'repository', path: root }], {
    excluded: [join(root, '.git')],
    ignoredDirectoryMarkers,
    parameters: null,
  });
  return manifestDigest(await nativeTransferManifest(root, snapshot, files)) === digest;
}

/** SHA-256 and byte count of one regular file, streamed without blocking the caller. */
export async function nativeFileDigest(path: string, signal?: AbortSignal): Promise<{ size: number; sha256: string }> {
  const hash = createHash('sha256');
  let size = 0;
  try {
    for await (const chunk of createReadStream(path, { signal })) {
      hash.update(chunk);
      size += chunk.length;
    }
  } finally {
    signal?.throwIfAborted();
  }
  return { size, sha256: hash.digest('hex') };
}

/** The exact source a build needs: tracked and untracked, not ignored, as `git ls-files -co --exclude-standard`. */
export async function sourceManifest(
  repoRoot: string,
  strict = false,
  signal?: AbortSignal,
): Promise<NativeTransferFile[]> {
  const files: NativeTransferFile[] = [];
  for (const path of await gitVisiblePaths(repoRoot, signal)) {
    signal?.throwIfAborted();
    const absolute = join(repoRoot, path);
    let stat;
    try {
      stat = await lstat(absolute);
    } catch (error) {
      if (strict && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      continue;
    }
    if (stat.isSymbolicLink()) {
      const target = Buffer.from(await readlink(absolute));
      files.push({
        path,
        kind: 'link',
        size: target.length,
        sha256: createHash('sha256').update(target).digest('hex'),
      });
    } else if (stat.isFile()) {
      files.push({ path, kind: stat.mode & 0o111 ? 'exec' : 'file', ...(await nativeFileDigest(absolute, signal)) });
    } else if (strict)
      throw new Error(`Native source ${path} is not a file or link; transfer submodule contents explicitly.`);
  }
  signal?.throwIfAborted();
  return files;
}

export async function gitVisiblePaths(repoRoot: string, signal?: AbortSignal): Promise<Set<string>> {
  const listed = await gitAsync(repoRoot, ['ls-files', '-z', '-co', '--exclude-standard'], {
    untrimmed: true,
    timeoutMs: 120_000,
    signal,
  });
  return new Set(listed.split('\0').filter(Boolean));
}
