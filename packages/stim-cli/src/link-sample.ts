import { lstat, open, readdir } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { diskUsageLinksFile, readDiskUsageLinks } from '@stim-cli/core/state';
import { writeCacheFile } from './cache-file.ts';
import { treeSignature } from './private-size.ts';
import { TREE_DOT_DIRS } from './workspace/dependency-edits.ts';
import { ARTIFACT_DIRS } from './workspace/regenerable-dirs.ts';
import { answered, hungRead, Unanswered } from './workspace/bounded-read.ts';

const PACKAGES = 12;
const FILES_PER_PACKAGE = 3;
const MIN_FILES = 20;
const MIN_PACKAGES = 5;
const LINKED_SHARE = 0.9;
const SAMPLE_TIMEOUT_MS = 2000;
const VERDICT_MAX_AGE_MS = 6 * 60 * 60_000;
const MODULES_MAX_BYTES = 1024 * 1024;
/** What a native build writes inside a package it builds in place: its own bytes, never store links. */
const BUILT_IN_PLACE = [...ARTIFACT_DIRS.build, 'android/.cxx', 'ios/build', 'apple/.DerivedData'];
const NATIVE_ROOTS = [...new Set(BUILT_IN_PLACE.map((relative) => relative.split('/')[0] ?? ''))];

type Kind = 'directory' | 'file' | 'other';

/** The reads a link sample makes; tests inject them. */
export interface LinkSampleIo {
  entries: (path: string) => Promise<{ name: string; kind: Kind }[]>;
  /** Without following a symlink: what it is, its link count, and its device and inode. */
  lstat: (path: string) => Promise<{ kind: Kind; nlink: number; dev: number; ino: number }>;
  /** The first `bytes` bytes of a file as text. */
  head: (path: string, bytes: number) => Promise<string>;
}

const kindOf = (entry: { isDirectory: () => boolean; isFile: () => boolean }): Kind =>
  entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other';

const REAL_IO: LinkSampleIo = {
  entries: async (path) =>
    (await readdir(path, { withFileTypes: true })).map((entry) => ({ name: entry.name, kind: kindOf(entry) })),
  lstat: async (path) => {
    const info = await lstat(path);
    return { kind: kindOf(info), nlink: info.nlink, dev: info.dev, ino: info.ino };
  },
  head: async (path, bytes) => {
    const file = await open(path, 'r');
    try {
      const { size } = await file.stat();
      const buffer = Buffer.alloc(Math.min(size, bytes));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      return buffer.toString('utf8', 0, bytesRead);
    } finally {
      await file.close();
    }
  },
};

/**
 * The pnpm store `.modules.yaml` in the tree at `path` records (`storeDir`, written as JSON by recent pnpm and as YAML by
 * older ones), when it is a directory outside the tree: its path and device.
 */
async function pnpmStore(
  path: string,
  read: <T>(label: string, start: () => Promise<T>) => Promise<T | null>,
  io: LinkSampleIo,
): Promise<{ dir: string; dev: number } | null> {
  const modules = join(path, '.modules.yaml');
  const text = await read(modules, () => io.head(modules, MODULES_MAX_BYTES));
  const recorded = text && /(?:^|[{,\s])"?storeDir"?\s*:\s*"?([^",\n]+?)"?\s*(?:,|\n|}|$)/.exec(text)?.[1];
  if (!recorded) return null;
  const dir = resolve(path, recorded);
  if (dir === path || dir.startsWith(`${path}${sep}`)) return null;
  const info = await read(dir, () => io.lstat(dir));
  return info?.kind === 'directory' ? { dir, dev: info.dev } : null;
}

/** `@scope+name@1.0.0(peer@2)` names the package `@scope/name` in pnpm's virtual store. */
function pnpmPackage(entry: string): string | null {
  const at = entry.indexOf('@', entry.startsWith('@') ? 1 : 0);
  return at > 0 ? entry.slice(0, at).replace('+', '/') : null;
}

function spread<T>(items: readonly T[], count: number): T[] {
  if (items.length <= count) return [...items];
  const picked = new Set(
    Array.from({ length: count }, (_, index) => Math.floor(((index + 0.5) * items.length) / count)),
  );
  return items.filter((_, index) => picked.has(index));
}

async function takeSample(
  path: string,
  io: LinkSampleIo,
  signal?: AbortSignal,
): Promise<{ linked: number; sampled: number; packages: number; store: string | null } | 'timeout'> {
  const deadline = Date.now() + SAMPLE_TIMEOUT_MS;
  const read = async <T>(label: string, start: () => Promise<T>): Promise<T | null> => {
    signal?.throwIfAborted();
    const left = deadline - Date.now();
    if (left <= 0) throw new Unanswered('the sample ran out of time');
    try {
      return await answered(label, start, left);
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof Unanswered) throw error;
      return null;
    }
  };
  const entries = async (dir: string) => (await read(dir, () => io.entries(dir))) ?? [];
  const isDir = async (target: string) => (await read(target, () => io.lstat(target)))?.kind === 'directory';
  const builtInPlace = async (dir: string): Promise<boolean> => {
    for (const root of NATIVE_ROOTS) {
      if (!(await isDir(join(dir, root)))) continue;
      for (const relative of BUILT_IN_PLACE.filter((candidate) => candidate.split('/')[0] === root))
        if (relative === root || (await isDir(join(dir, relative)))) return true;
    }
    return false;
  };
  const filesOf = async (dir: string, found: readonly { name: string; kind: Kind }[]): Promise<string[]> => {
    const files = found.filter(({ kind }) => kind === 'file').map(({ name }) => join(dir, name));
    for (const sub of found.filter(({ kind }) => kind === 'directory').slice(0, 2)) {
      if (files.length >= FILES_PER_PACKAGE) break;
      const inner = join(dir, sub.name);
      for (const entry of await entries(inner)) if (entry.kind === 'file') files.push(join(inner, entry.name));
    }
    return files.slice(0, FILES_PER_PACKAGE);
  };
  try {
    const none = { linked: 0, sampled: 0, packages: 0, store: null };
    const top = await entries(path);
    const caches = top.some(
      ({ name, kind }) => kind === 'directory' && name.startsWith('.') && ![...TREE_DOT_DIRS, '.bin'].includes(name),
    );
    if (caches) return none;
    const store = await pnpmStore(path, read, io);
    if (!store) return none;
    const virtual = top.some(({ name, kind }) => name === '.pnpm' && kind === 'directory')
      ? (await entries(join(path, '.pnpm'))).flatMap(({ name, kind }) => {
          const pkg = kind === 'directory' && name !== 'node_modules' ? pnpmPackage(name) : null;
          return pkg ? [join(path, '.pnpm', name, 'node_modules', pkg)] : [];
        })
      : [];
    const pnpm = virtual.length > 0;
    const dirs = pnpm ? virtual : [];
    for (const { name, kind } of pnpm ? [] : top) {
      if (kind !== 'directory' || name.startsWith('.')) continue;
      if (!name.startsWith('@')) dirs.push(join(path, name));
      else
        for (const scoped of await entries(join(path, name)))
          if (scoped.kind === 'directory') dirs.push(join(path, name, scoped.name));
    }
    for (const dir of dirs) if (await builtInPlace(dir)) return { ...none, store: store.dir };
    const seen = new Set<string>();
    let linked = 0;
    let packages = 0;
    for (const dir of spread(dirs.toSorted(), PACKAGES)) {
      if (pnpm && (await read(dir, () => io.lstat(dir)))?.kind !== 'directory') continue;
      const found = await entries(dir);
      let counted = false;
      for (const file of await filesOf(dir, found)) {
        const info = await read(file, () => io.lstat(file));
        const id = info && `${info.dev}:${info.ino}`;
        if (info?.kind !== 'file' || !id || seen.has(id)) continue;
        seen.add(id);
        counted = true;
        if (info.nlink > 1 && info.dev === store.dev) linked++;
      }
      if (counted) packages++;
    }
    return { linked, sampled: seen.size, packages, store: store.dir };
  } catch (error) {
    if (error instanceof Unanswered) return 'timeout';
    throw error;
  }
}

/**
 * Whether the dependency tree at `path` is mostly hard links into a pnpm store outside it, from the link counts of a few
 * dozen regular files spread over its packages (under `.pnpm/*\/node_modules/*` for pnpm's isolated layout, its
 * top-level and scoped folders otherwise), read without following a symlink and within SAMPLE_TIMEOUT_MS in all: the
 * counts when `.modules.yaml` names a store directory outside the tree, at least MIN_FILES distinct files from
 * MIN_PACKAGES packages were read, and LINKED_SHARE of them have more than one link on the store's device, else null. A
 * tree with a dot directory at its root other than a package manager's own (a cache such as `.cache`), or with any
 * package that holds output a native build wrote in place (BUILT_IN_PLACE), is not links. A link count shows that
 * another name holds the file's data, not where that name is, so the store is the evidence that the other name is
 * outside the tree, and this is never a measurement. A verdict is recorded with the install signature and reused for
 * VERDICT_MAX_AGE_MS while the signature holds; a `links` verdict also needs its store to still be a directory.
 */
export async function hardLinkSample(
  path: string,
  signal?: AbortSignal,
  io: LinkSampleIo = REAL_IO,
): Promise<{ linked: number; sampled: number } | null> {
  const signature = treeSignature(path);
  if (signature === null) return null;
  const recorded = readDiskUsageLinks(path);
  if (recorded?.signature === signature && Date.now() - Date.parse(recorded.sampledAt) < VERDICT_MAX_AGE_MS) {
    if (recorded.verdict !== 'links') return null;
    const store = recorded.store;
    if (store && (await storeStands(store, io))) return { linked: recorded.linked, sampled: recorded.sampled };
  }
  if (hungRead() !== null) return null;
  const sampledAt = new Date().toISOString();
  const sample = await takeSample(path, io, signal);
  const counts = sample === 'timeout' ? { linked: 0, sampled: 0 } : { linked: sample.linked, sampled: sample.sampled };
  const verdict =
    sample === 'timeout'
      ? 'timeout'
      : sample.sampled >= MIN_FILES && sample.packages >= MIN_PACKAGES && sample.linked >= sample.sampled * LINKED_SHARE
        ? 'links'
        : 'other';
  const store = sample !== 'timeout' && sample.store ? { store: sample.store } : {};
  writeCacheFile(diskUsageLinksFile(path), { path, signature, sampledAt, verdict, ...counts, ...store });
  return verdict === 'links' ? counts : null;
}

async function storeStands(store: string, io: LinkSampleIo): Promise<boolean> {
  if (hungRead() !== null) return false;
  try {
    return (await answered(store, () => io.lstat(store), SAMPLE_TIMEOUT_MS)).kind === 'directory';
  } catch {
    return false;
  }
}
