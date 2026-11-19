import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { diskUsageLinksFile, readDiskUsageLinks } from '@stim-cli/core/state';
import { writeCacheFile } from './cache-file.ts';
import { treeSignature } from './private-size.ts';
import { answered, hungRead, Unanswered } from './workspace/bounded-read.ts';

const PACKAGES = 12;
const FILES_PER_PACKAGE = 3;
const MIN_FILES = 20;
const MIN_PACKAGES = 5;
const LINKED_SHARE = 0.9;
const SAMPLE_TIMEOUT_MS = 2000;
const TIMEOUT_RETRY_MS = 6 * 60 * 60_000;

type Kind = 'directory' | 'file' | 'other';

/** The reads a link sample makes; tests inject them. */
export interface LinkSampleIo {
  entries: (path: string) => Promise<{ name: string; kind: Kind }[]>;
  /** Without following a symlink: what it is, its link count, and its device and inode. */
  lstat: (path: string) => Promise<{ kind: Kind; nlink: number; id: string }>;
}

const kindOf = (entry: { isDirectory: () => boolean; isFile: () => boolean }): Kind =>
  entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other';

const REAL_IO: LinkSampleIo = {
  entries: async (path) =>
    (await readdir(path, { withFileTypes: true })).map((entry) => ({ name: entry.name, kind: kindOf(entry) })),
  lstat: async (path) => {
    const info = await lstat(path);
    return { kind: kindOf(info), nlink: info.nlink, id: `${info.dev}:${info.ino}` };
  },
};

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
): Promise<{ linked: number; sampled: number; packages: number } | 'timeout'> {
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
  const filesOf = async (dir: string): Promise<string[]> => {
    const found = await entries(dir);
    const files = found.filter(({ kind }) => kind === 'file').map(({ name }) => join(dir, name));
    for (const sub of found.filter(({ kind }) => kind === 'directory').slice(0, 2)) {
      if (files.length >= FILES_PER_PACKAGE) break;
      const inner = join(dir, sub.name);
      for (const entry of await entries(inner)) if (entry.kind === 'file') files.push(join(inner, entry.name));
    }
    return files.slice(0, FILES_PER_PACKAGE);
  };
  try {
    const top = await entries(path);
    if (top.some(({ name }) => name === '.pnpm-store')) return { linked: 0, sampled: 0, packages: 0 };
    const store = top.some(({ name, kind }) => name === '.pnpm' && kind === 'directory')
      ? (await entries(join(path, '.pnpm'))).flatMap(({ name, kind }) => {
          const pkg = kind === 'directory' && name !== 'node_modules' ? pnpmPackage(name) : null;
          return pkg ? [join(path, '.pnpm', name, 'node_modules', pkg)] : [];
        })
      : [];
    const pnpm = store.length > 0;
    const dirs = pnpm
      ? store
      : top
          .filter(({ name, kind }) => kind === 'directory' && !name.startsWith('.'))
          .map(({ name }) => join(path, name));
    const seen = new Set<string>();
    let linked = 0;
    let packages = 0;
    for (const dir of spread(dirs.toSorted(), PACKAGES)) {
      if (pnpm && (await read(dir, () => io.lstat(dir)))?.kind !== 'directory') continue;
      let counted = false;
      for (const file of await filesOf(dir)) {
        const info = await read(file, () => io.lstat(file));
        if (info?.kind !== 'file' || seen.has(info.id)) continue;
        seen.add(info.id);
        counted = true;
        if (info.nlink > 1) linked++;
      }
      if (counted) packages++;
    }
    return { linked, sampled: seen.size, packages };
  } catch (error) {
    if (error instanceof Unanswered) return 'timeout';
    throw error;
  }
}

/**
 * Whether the dependency tree at `path` is mostly hard links, from the link counts of a few dozen regular files spread
 * over its packages (under `.pnpm/*\/node_modules/*` for pnpm's isolated layout, its top-level folders otherwise), read without following
 * a symlink and within SAMPLE_TIMEOUT_MS in all: the counts when at least MIN_FILES distinct files from MIN_PACKAGES
 * packages were read and LINKED_SHARE of them have more than one link, else null. The verdict is recorded with the
 * install signature and reused until it changes; one whose reads did not answer is retried after TIMEOUT_RETRY_MS. A tree
 * that holds a `.pnpm-store` keeps its store inside it, so it is never links. A link count shows that another name holds the file's data, not where that name is, so this is never a measurement.
 */
export async function hardLinkSample(
  path: string,
  signal?: AbortSignal,
  io: LinkSampleIo = REAL_IO,
): Promise<{ linked: number; sampled: number } | null> {
  const signature = treeSignature(path);
  if (signature === null) return null;
  const recorded = readDiskUsageLinks(path);
  if (
    recorded?.signature === signature &&
    (recorded.verdict !== 'timeout' || Date.now() - Date.parse(recorded.sampledAt) < TIMEOUT_RETRY_MS)
  )
    return recorded.verdict === 'links' ? { linked: recorded.linked, sampled: recorded.sampled } : null;
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
  writeCacheFile(diskUsageLinksFile(path), { path, signature, sampledAt, verdict, ...counts });
  return verdict === 'links' ? counts : null;
}
