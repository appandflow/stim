import { lstat, open, readdir } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { withDirLockAsync } from '@stim-cli/core';
import { diskUsageLinksFile, diskUsageNativeFile, readDiskUsageLinks, readJsonObject } from '@stim-cli/core/state';
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
const LOCK_WAIT_MS = 200;
const MIN_READ_MS = 500;
const MODULES_END_BYTES = 64 * 1024;
/** What a native build writes inside a package it builds in place: its own bytes, never store links. */
const BUILT_IN_PLACE = [...ARTIFACT_DIRS.build, 'android/.cxx', 'ios/build', 'apple/.DerivedData'];
const NATIVE_ROOTS = [...new Set(BUILT_IN_PLACE.map((relative) => relative.split('/')[0] ?? ''))];

type Kind = 'directory' | 'file' | 'other';

/** The reads a link sample makes; tests inject them. */
export interface LinkSampleIo {
  entries: (path: string) => Promise<{ name: string; kind: Kind }[]>;
  /** Without following a symlink: what it is, its link count, and its device and inode. */
  lstat: (path: string) => Promise<{ kind: Kind; nlink: number; dev: number; ino: number }>;
  /** The whole lines within the first and the last `bytes` bytes of a file, or the whole file when it is no longer than twice that. */
  ends: (path: string, bytes: number) => Promise<string>;
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
  ends: async (path, bytes) => {
    const file = await open(path, 'r');
    try {
      const { size } = await file.stat();
      const chunk = async (position: number, length: number) => {
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await file.read(buffer, 0, length, position);
        return buffer.toString('utf8', 0, bytesRead);
      };
      if (size <= 2 * bytes) return await chunk(0, size);
      const head = await chunk(0, bytes);
      const tail = await chunk(size - bytes, bytes);
      return `${head.slice(0, head.lastIndexOf('\n') + 1)}${tail.slice(tail.indexOf('\n') + 1 || tail.length)}`;
    } finally {
      await file.close();
    }
  },
};

type Read = <T>(label: string, start: () => Promise<T>) => Promise<T | null>;

/**
 * Reads through the shared bounded reader until `budgetMs` from now or `until`, whichever is first, each given what is
 * left of that to answer, and none started with less than MIN_READ_MS left, so a read that does not answer in time had
 * at least that long before it becomes the pending one: null for a read that failed, `Unanswered` thrown for one that
 * did not answer or could not start.
 */
function boundedReads(budgetMs: number, until: number, signal?: AbortSignal): Read {
  const deadline = Math.min(Date.now() + budgetMs, until);
  return async (label, start) => {
    signal?.throwIfAborted();
    const left = deadline - Date.now();
    if (left < MIN_READ_MS) throw new Unanswered('the reads ran out of time');
    try {
      return await answered(label, start, left);
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof Unanswered) throw error;
      return null;
    }
  };
}

const absent = (error: unknown) =>
  error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR');

async function orTimeout<T>(work: () => Promise<T>): Promise<T | 'timeout'> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof Unanswered) return 'timeout';
    throw error;
  }
}

/**
 * The pnpm store `.modules.yaml` in the tree at `path` records (`storeDir`, written as JSON by recent pnpm and as YAML by
 * older ones, with sorted keys, so near the end of a large file), when it is a directory outside the tree: its path and
 * device.
 */
async function pnpmStore(path: string, read: Read, io: LinkSampleIo): Promise<{ dir: string; dev: number } | null> {
  const modules = join(path, '.modules.yaml');
  const text = await read(modules, () => io.ends(modules, MODULES_END_BYTES));
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
  until: number,
  signal?: AbortSignal,
): Promise<{ linked: number; sampled: number; packages: number; store: string | null; dirs: string[] } | 'timeout'> {
  const read = boundedReads(SAMPLE_TIMEOUT_MS, until, signal);
  const entries = async (dir: string) => (await read(dir, () => io.entries(dir))) ?? [];
  const filesOf = async (dir: string, found: readonly { name: string; kind: Kind }[]): Promise<string[]> => {
    const files = found.filter(({ kind }) => kind === 'file').map(({ name }) => join(dir, name));
    for (const sub of found.filter(({ kind }) => kind === 'directory').slice(0, 2)) {
      if (files.length >= FILES_PER_PACKAGE) break;
      const inner = join(dir, sub.name);
      for (const entry of await entries(inner)) if (entry.kind === 'file') files.push(join(inner, entry.name));
    }
    return files.slice(0, FILES_PER_PACKAGE);
  };
  return orTimeout(async () => {
    const none = { linked: 0, sampled: 0, packages: 0, store: null, dirs: [] };
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
    const sorted = dirs.toSorted();
    const seen = new Set<string>();
    let linked = 0;
    let packages = 0;
    for (const dir of spread(sorted, PACKAGES)) {
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
    return { linked, sampled: seen.size, packages, store: store.dir, dirs: sorted };
  });
}

/**
 * Writes what `next` makes of the record in `file` under the file's lock, waiting at most LOCK_WAIT_MS and never past
 * `until`: the record written, or null when the lock was not had in time or could not be taken. Only an abort throws.
 */
async function writeLocked<T extends object>(
  file: string,
  next: (current: Record<string, unknown> | null) => T,
  until: number,
  signal?: AbortSignal,
): Promise<T | null> {
  try {
    return await withDirLockAsync(
      `${file}.lock`,
      () => {
        const record = next(readJsonObject(file));
        writeCacheFile(file, record);
        return record;
      },
      {
        waitMs: Math.max(0, Math.min(LOCK_WAIT_MS, until - Date.now())),
        ensureParent: () => mkdirSync(dirname(file), { recursive: true }),
        signal,
      },
    );
  } catch {
    signal?.throwIfAborted();
    return null;
  }
}

/**
 * How far the search of a tree's sorted package list for native project folders (NATIVE_ROOTS) went: the last package
 * it listed, what it found, and whether it reached the end.
 */
interface NativeRoots {
  last: string | null;
  roots: string[];
  complete: boolean;
}

function nativeRootsOf(entry: Record<string, unknown> | null, path: string, signature: string): NativeRoots | null {
  if (!entry || entry.path !== path || entry.signature !== signature) return null;
  const { last, roots, complete } = entry;
  return (last === null || typeof last === 'string') &&
    Array.isArray(roots) &&
    roots.every((root) => typeof root === 'string') &&
    typeof complete === 'boolean'
    ? { last, roots, complete }
    : null;
}

/**
 * Lists the packages `dirs` (sorted) after the last one `from` listed, for SAMPLE_TIMEOUT_MS, and records how far it
 * went unless another listing recorded more: it stops at a package whose listing failed other than by being absent, so
 * the next listing starts there. Null when the record's lock was not had in time.
 */
async function findNativeRoots(
  path: string,
  signature: string,
  dirs: readonly string[],
  from: NativeRoots | null,
  io: LinkSampleIo,
  until: number,
  signal?: AbortSignal,
): Promise<NativeRoots | null> {
  const read = boundedReads(SAMPLE_TIMEOUT_MS, until, signal);
  const roots = [...(from?.roots ?? [])];
  let last = from?.last ?? null;
  await orTimeout(async () => {
    for (const dir of dirs) {
      if (last !== null && dir <= last) continue;
      const found = await read(dir, async () => {
        try {
          return await io.entries(dir);
        } catch (error) {
          if (absent(error)) return [];
          throw error;
        }
      });
      if (found === null) return;
      for (const { name, kind } of found)
        if (kind === 'directory' && NATIVE_ROOTS.includes(name)) roots.push(join(dir, name));
      last = dir;
    }
  });
  const mine = { last, roots, complete: !dirs.some((dir) => last === null || dir > last) };
  const written = await writeLocked(
    diskUsageNativeFile(path),
    (current) => {
      const theirs = nativeRootsOf(current, path, signature);
      const ahead =
        theirs && (theirs.complete || (theirs.last !== null && (mine.last === null || theirs.last > mine.last)));
      return { path, signature, ...(ahead ? theirs : mine) };
    },
    until,
    signal,
  );
  return written && { last: written.last, roots: written.roots, complete: written.complete };
}

/**
 * Whether a native build wrote output (BUILT_IN_PLACE) under any of `roots`, from one listing of each root (and of a
 * folder in it a build output path goes through, or of the package for a `.build` root), within SAMPLE_TIMEOUT_MS: `timeout` when that could not be told, from
 * a read that did not answer or failed other than by the folder being absent.
 */
async function builtInPlace(
  roots: readonly string[],
  io: LinkSampleIo,
  until: number,
  signal?: AbortSignal,
): Promise<boolean | 'timeout'> {
  const read = boundedReads(SAMPLE_TIMEOUT_MS, until, signal);
  const folders = async (dir: string): Promise<Set<string> | null> => {
    const found = await read(dir, async () => {
      try {
        return await io.entries(dir);
      } catch (error) {
        if (absent(error)) return [];
        throw error;
      }
    });
    return found && new Set(found.flatMap(({ name, kind }) => (kind === 'directory' ? [name] : [])));
  };
  return orTimeout(async () => {
    for (const root of roots) {
      const paths = BUILT_IN_PLACE.map((relative) => relative.split('/')).filter(([first]) => first === basename(root));
      const listed = new Map<string, Set<string> | null>();
      for (const [first = '', ...rest] of paths) {
        const parts = rest.length ? rest : [first];
        let dir = rest.length ? root : dirname(root);
        let found = true;
        for (const part of parts) {
          if (!listed.has(dir)) listed.set(dir, await folders(dir));
          const names = listed.get(dir);
          if (!names) return 'timeout';
          if (!names.has(part)) {
            found = false;
            break;
          }
          dir = join(dir, part);
        }
        if (found) return true;
      }
    }
    return false;
  });
}

/**
 * Whether the dependency tree at `path` is mostly hard links into a pnpm store outside it, from the link counts of a few
 * dozen regular files spread over its packages (under `.pnpm/*\/node_modules/*` for pnpm's isolated layout, its
 * top-level and scoped folders otherwise), read without following a symlink and within SAMPLE_TIMEOUT_MS: the counts
 * when `.modules.yaml` names a store directory outside the tree, at least MIN_FILES distinct files from MIN_PACKAGES
 * packages were read, LINKED_SHARE of them have more than one link on the store's device, and no package holds output a
 * native build wrote in place (BUILT_IN_PLACE), else null. A tree with a dot directory at its root other than a package
 * manager's own (a cache such as `.cache`) is not links. A link count shows that another name holds the file's data, not
 * where that name is, so the store is the evidence that the other name is outside the tree, and this is never a
 * measurement. A verdict is recorded with the install signature and reused for VERDICT_MAX_AGE_MS while the signature
 * holds; a `links` verdict also needs its store to still be a directory.
 *
 * The packages holding a native project folder (NATIVE_ROOTS) are listed once per install signature, SAMPLE_TIMEOUT_MS
 * at a time from where the last listing stopped, and only once a sample finds links; until the list is complete there
 * is no `links` verdict. Every use of a `links` verdict checks the build output folders of those packages first, within
 * SAMPLE_TIMEOUT_MS, so a build after the sample ends it. A `.build` folder is checked only in a package listed with a
 * native project folder, and build output outside those folders (such as React Native built from source) is not seen.
 * No read starts after `until`, and a sample cut short by it records no verdict. Both records are written under their
 * lock; when it is not had in time, there is no verdict and nothing is written.
 */
export async function hardLinkSample(
  path: string,
  signal?: AbortSignal,
  io: LinkSampleIo = REAL_IO,
  until: number = Infinity,
): Promise<{ linked: number; sampled: number } | null> {
  const signature = treeSignature(path);
  if (signature === null) return null;
  const recorded = readDiskUsageLinks(path);
  const fresh =
    recorded?.signature === signature && Date.now() - Date.parse(recorded.sampledAt) < VERDICT_MAX_AGE_MS
      ? recorded
      : null;
  if (fresh && fresh.verdict !== 'links') return null;
  if (hungRead() !== null) return null;
  const sampledAt = new Date().toISOString();
  const write = async (
    verdict: 'links' | 'other' | 'timeout',
    counts: { linked: number; sampled: number },
    store?: string,
  ): Promise<boolean> =>
    (await writeLocked(
      diskUsageLinksFile(path),
      () => ({ path, signature, sampledAt, verdict, ...counts, ...(store ? { store } : {}) }),
      until,
      signal,
    )) !== null;
  let native = nativeRootsOf(readJsonObject(diskUsageNativeFile(path)), path, signature);
  if (fresh && native?.complete) {
    const built = await builtInPlace(native.roots, io, until, signal);
    if (built === 'timeout') return null;
    if (built) {
      await write('other', { linked: 0, sampled: 0 }, fresh.store);
      return null;
    }
    if (fresh.store && (await storeStands(fresh.store, io, until)))
      return { linked: fresh.linked, sampled: fresh.sampled };
  }
  const sample = await takeSample(path, io, until, signal);
  if (sample === 'timeout') {
    if (Date.now() < until) await write('timeout', { linked: 0, sampled: 0 });
    return null;
  }
  const counts = { linked: sample.linked, sampled: sample.sampled };
  const store = sample.store ?? undefined;
  if (sample.sampled < MIN_FILES || sample.packages < MIN_PACKAGES || sample.linked < sample.sampled * LINKED_SHARE) {
    await write('other', counts, store);
    return null;
  }
  if (!native?.complete) native = await findNativeRoots(path, signature, sample.dirs, native, io, until, signal);
  if (!native?.complete) return null;
  const built = await builtInPlace(native.roots, io, until, signal);
  if (built === 'timeout') return null;
  return (await write(built ? 'other' : 'links', counts, store)) && !built ? counts : null;
}

async function storeStands(store: string, io: LinkSampleIo, until: number): Promise<boolean> {
  const left = Math.min(until - Date.now(), SAMPLE_TIMEOUT_MS);
  if (hungRead() !== null || left < MIN_READ_MS) return false;
  try {
    return (await answered(store, () => io.lstat(store), left)).kind === 'directory';
  } catch {
    return false;
  }
}
