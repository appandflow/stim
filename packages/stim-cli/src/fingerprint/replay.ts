import { lstatSync, readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve, win32 } from 'node:path';
import type { BuildFingerprintSource } from '@stim-cli/core/protocol';
import { findPackage } from './closure.ts';
import { gitLocation } from './git-index.ts';
import { installRoot, nativeDirectory, type StaticTarget } from './inputs.ts';
import { canonicalJson, sha256, type Input, type Uncertain } from './key.ts';
import { canonicalPodfileLock } from './podfile-lock.ts';
import { contentHash, symlinkHash, within, type Roots } from './walk.ts';

const ABSENT = sha256(canonicalJson(['absent']));
const MAX_FILES = 50_000;
const MAX_BYTES = 2 * 1024 ** 3;

export function resolveReplayEnvPath(name: string, roots: Roots): string | null {
  if (name.startsWith('outside:') || isAbsolute(name) || win32.isAbsolute(name) || /^[A-Za-z]:/.test(name)) return null;
  let boundary = roots.project;
  let relative = name;
  if (name.startsWith('<install>/')) {
    boundary = roots.install;
    relative = name.slice('<install>/'.length);
  } else if (name.startsWith('npm:')) {
    boundary = join(roots.project, 'node_modules');
    relative = name.slice('npm:'.length);
  }
  if (!relative || relative.split(/[\\/]/).some((part) => !part || part === '..')) return null;
  const path = resolve(boundary, relative);
  return within(path, boundary) ? path : null;
}

function sourcePath(name: string, roots: Roots): { path: string; boundary: string } | null {
  if (name.startsWith('outside:')) return null;
  let boundary = roots.project;
  let relative = name;
  if (name.startsWith('<install>/')) {
    boundary = roots.install;
    relative = name.slice('<install>/'.length);
  } else if (name.startsWith('npm:')) {
    const parts = name.slice(4).split('/');
    const packageName = parts[0]?.startsWith('@') ? parts.splice(0, 2).join('/') : parts.shift();
    const dir = packageName && findPackage(roots.project, packageName);
    if (!dir) return null;
    boundary = dir;
    relative = parts.join('/');
  }
  if (
    !relative ||
    isAbsolute(relative) ||
    relative.split(/[\\/]/).some((part) => !part || part === '.' || part === '..')
  )
    return null;
  const path = resolve(boundary, relative);
  return within(path, boundary) ? { path, boundary } : null;
}

export function fingerprintSyncFiles(project: string, inputs: readonly Input[]): string[] | Uncertain {
  const root = realpathSync.native(project);
  const roots = { project: root, install: installRoot(root) };
  const top = gitLocation(root)?.top;
  if (!top) return { uncertain: 'the project is not in a Git work tree' };
  const files: string[] = [];
  for (const input of inputs) {
    if (input.kind !== 'file' || /^(?:npm|exists|dir|tree|virtual):/.test(input.name)) continue;
    const found = sourcePath(input.name, roots);
    if (!found) return { uncertain: `cannot locate fingerprint input ${input.name}` };
    const stat = lstatSync(found.path, { throwIfNoEntry: false });
    if (!stat) continue;
    const parent = realpathSync.native(join(found.path, '..'));
    if (!within(parent, top)) return { uncertain: `fingerprint input ${input.name} is outside the repository` };
    if (!stat.isFile() && !stat.isSymbolicLink()) return { uncertain: `fingerprint input ${input.name} is not a file` };
    files.push(found.path);
  }
  return files;
}

/** Re-hashes only the file names declared by the client; a missing or unsafe path cannot become a cache hit. */
export function replayFiles(
  sources: readonly BuildFingerprintSource[],
  roots: Roots,
  target: StaticTarget,
): Input[] | Uncertain {
  const files = sources.filter((source) => source.kind === 'file' && !/^(?:exists|dir|tree|virtual):/.test(source.id));
  if (files.length > MAX_FILES) return { uncertain: 'the fingerprint file list exceeds the file limit' };
  const nativeDir = nativeDirectory(roots.project, target);
  const podfileLock = join(nativeDir, 'Podfile.lock');
  let bytes = 0;
  const hash = (path: string, size: number): string => {
    bytes += size;
    if (bytes > MAX_BYTES) throw new Error('the fingerprint file list exceeds the byte limit');
    return target.platform === 'ios' && path === podfileLock
      ? sha256(canonicalPodfileLock(readFileSync(path, 'utf8'), join(nativeDir, 'Pods'), roots.project))
      : contentHash(path, size);
  };
  try {
    return files.map((source) => {
      const found = sourcePath(source.id, roots);
      if (!found) throw new Error(`cannot resolve fingerprint input ${source.id}`);
      const { path, boundary } = found;
      const allowed = (real: string) =>
        within(real, boundary) || within(real, roots.project) || within(real, roots.install);
      let result = ABSENT;
      const stat = lstatSync(path, { throwIfNoEntry: false });
      if (stat) {
        const parent = realpathSync.native(join(path, '..'));
        if (!allowed(parent)) throw new Error(`fingerprint input ${source.id} escapes its root`);
        if (stat.isSymbolicLink()) {
          const text = readlinkSync(path);
          let actual: string | null = null;
          try {
            actual = realpathSync.native(path);
          } catch {}
          const targetStat = actual ? statSync(actual, { throwIfNoEntry: false }) : undefined;
          if (actual && !allowed(actual)) throw new Error(`fingerprint input ${source.id} links outside its root`);
          if (targetStat?.isFile() && actual) {
            const targetHash = hash(actual, targetStat.size);
            result = source.hash === targetHash ? targetHash : symlinkHash(text, targetHash);
          } else if (targetStat?.isDirectory()) result = symlinkHash(text);
          else if (source.hash !== ABSENT) result = symlinkHash(text, null);
        } else if (stat.isFile()) result = hash(path, stat.size);
        else throw new Error(`fingerprint input ${source.id} is not a file`);
      }
      return { name: source.id, kind: 'file' as const, hash: result };
    });
  } catch (error) {
    return { uncertain: error instanceof Error ? error.message : String(error) };
  }
}
