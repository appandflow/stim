import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync } from 'node:fs';
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

export function fingerprintNativeInputs(
  inputs: readonly NativeInput[],
  {
    excluded = [],
    ignoredDirectoryMarkers = [],
    parameters,
  }: { excluded?: readonly string[]; ignoredDirectoryMarkers?: readonly string[]; parameters: unknown },
): NativeInputSnapshot {
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
  const walk = (
    absolute: string,
    logical: string,
    ancestors: ReadonlySet<string>,
    optional = false,
    relative: string | null = null,
  ) => {
    let stat;
    try {
      stat = lstatSync(absolute);
    } catch (error) {
      if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        record(logical, 'absent');
        return;
      }
      throw error;
    }
    if (stat.isSymbolicLink()) {
      const target = readlinkSync(absolute);
      const resolved = resolve(dirname(absolute), target);
      if (isExcluded(resolved)) throw new NativeInputError(`Native input ${logical} links into an excluded output.`);
      if (ancestors.has(absolute)) throw new NativeInputError(`Native input ${logical} contains a link cycle.`);
      record(logical, 'link', target);
      walk(resolved, `${logical}/@target`, new Set([...ancestors, absolute]));
    } else if (stat.isDirectory()) {
      const canonical = realpathSync(absolute);
      if (ancestors.has(canonical)) throw new NativeInputError(`Native input ${logical} contains a directory cycle.`);
      if (!directoryMarkers.has(absolute)) record(logical, 'directory');
      const next = new Set([...ancestors, canonical]);
      for (const name of readdirSync(absolute).toSorted()) {
        const child = join(absolute, name);
        const childRelative = relative === null ? null : relative ? `${relative}/${name}` : name;
        if (isExcluded(child) || (childRelative !== null && admit && !admit(childRelative))) continue;
        walk(child, `${logical}/${name}`, next, false, childRelative);
      }
    } else if (stat.isFile()) {
      record(logical, `file:${stat.mode & 0o111}`, readFileSync(absolute));
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
      walk(path, input.name, new Set(), input.optional, '');
    }
  } catch (error) {
    if (error instanceof NativeInputError) throw error;
    throw new NativeInputError(`Could not read native build inputs: ${(error as Error).message}`, { cause: error });
  }
  const sorted = entries.toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const hash = createHash('sha256')
    .update('stim-native-inputs-v1\0')
    .update(JSON.stringify(parameters))
    .update('\0')
    .update(manifestDigest(sorted))
    .digest('hex');
  return { hash, entries: sorted, parameters };
}
