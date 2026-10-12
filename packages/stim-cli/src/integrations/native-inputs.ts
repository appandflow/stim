import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, readlink, realpath } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { manifestDigest } from '../offload/manifest.ts';

interface NativeInput {
  name: string;
  path: string;
  optional?: boolean;
  admit?: (relative: string) => boolean;
}

interface NativeInputEntry {
  path: string;
  kind: string;
  sha256: string;
}

export interface NativeInputSnapshot {
  hash: string;
  entries: NativeInputEntry[];
  parameters: unknown;
}

export class NativeInputError extends Error {}

export async function fingerprintNativeInputs(
  inputs: readonly NativeInput[],
  {
    excluded = [],
    ignoredDirectoryMarkers = [],
    parameters,
    signal,
  }: {
    excluded?: readonly string[];
    ignoredDirectoryMarkers?: readonly string[];
    parameters: unknown;
    signal?: AbortSignal;
  },
): Promise<NativeInputSnapshot> {
  const exclusions = excluded.map((path) => resolve(path));
  const directoryMarkers = new Set(ignoredDirectoryMarkers.map((path) => resolve(path)));
  const entries: NativeInputEntry[] = [];
  const names = new Set<string>();
  const isExcluded = (path: string) =>
    exclusions.some((output) => path === output || path.startsWith(`${output}${sep}`));
  let admit: NativeInput['admit'];
  const record = (path: string, kind: string, content: string | Buffer = '') => {
    entries.push({ path, kind, sha256: createHash('sha256').update(content).digest('hex') });
  };
  const walk = async (
    absolute: string,
    logical: string,
    ancestors: ReadonlySet<string>,
    optional = false,
    relative: string | null = null,
  ): Promise<void> => {
    signal?.throwIfAborted();
    let stat;
    try {
      stat = await lstat(absolute);
    } catch (error) {
      if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        record(logical, 'absent');
        return;
      }
      throw error;
    }
    if (stat.isSymbolicLink()) {
      const target = await readlink(absolute);
      const resolved = resolve(dirname(absolute), target);
      if (isExcluded(resolved)) throw new NativeInputError(`Native input ${logical} links into an excluded output.`);
      if (ancestors.has(absolute)) throw new NativeInputError(`Native input ${logical} contains a link cycle.`);
      record(logical, 'link', target);
      await walk(resolved, `${logical}/@target`, new Set([...ancestors, absolute]));
    } else if (stat.isDirectory()) {
      const canonical = await realpath(absolute);
      if (ancestors.has(canonical)) throw new NativeInputError(`Native input ${logical} contains a directory cycle.`);
      if (!directoryMarkers.has(absolute)) record(logical, 'directory');
      const next = new Set([...ancestors, canonical]);
      for (const name of (await readdir(absolute)).toSorted()) {
        const child = join(absolute, name);
        const childRelative = relative === null ? null : relative ? `${relative}/${name}` : name;
        if (isExcluded(child) || (childRelative !== null && admit && !admit(childRelative))) continue;
        await walk(child, `${logical}/${name}`, next, false, childRelative);
      }
    } else if (stat.isFile()) {
      const digest = createHash('sha256');
      for await (const chunk of createReadStream(absolute, { signal })) digest.update(chunk);
      entries.push({ path: logical, kind: `file:${stat.mode & 0o111}`, sha256: digest.digest('hex') });
    } else {
      throw new NativeInputError(`Native input ${logical} is not a file, directory or symbolic link.`);
    }
  };
  try {
    for (const input of inputs) {
      if (!input.name || names.has(input.name)) throw new NativeInputError('Native input names must be unique.');
      names.add(input.name);
      const path = resolve(input.path);
      if (isExcluded(path)) throw new NativeInputError(`Native input ${input.name} is also an excluded output.`);
      admit = input.admit;
      await walk(path, input.name, new Set(), input.optional, '');
    }
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof NativeInputError) throw error;
    throw new NativeInputError(`Could not read native build inputs: ${(error as Error).message}`, { cause: error });
  }
  signal?.throwIfAborted();
  const sorted = entries.toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const hash = createHash('sha256')
    .update('stim-native-inputs-v1\0')
    .update(JSON.stringify(parameters))
    .update('\0')
    .update(manifestDigest(sorted))
    .digest('hex');
  return { hash, entries: sorted, parameters };
}
