import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isJsonObject, trashRoot } from '@stim-cli/core/state';
import { releaseClaim, tryAcquireClaim } from '../ownership-claim.ts';
import { filesystemDevice } from '../temporary.ts';
import { answered, Unanswered } from './bounded-read.ts';
import { TRASH_CLAIMS, TRASH_MANIFEST } from './worktree-trash.ts';

export const ITEM_TRASH_PREFIX = 'item-';

interface ItemTrashManifest {
  kind: 'gc-item';
  createdAt: string;
  source:
    | { kind: 'cache'; id: string }
    | { kind: 'archive'; id: string; part?: 'logs' | 'recordings' | 'agentActions' };
  bytes: number;
}

export async function readItemTrash(dir: string): Promise<ItemTrashManifest | null> {
  try {
    const value: unknown = JSON.parse(await readFile(join(dir, TRASH_MANIFEST), 'utf8'));
    if (!isJsonObject(value) || value.kind !== 'gc-item' || typeof value.createdAt !== 'string') return null;
    const source = value.source;
    if (!isJsonObject(source) || typeof source.id !== 'string' || !source.id) return null;
    if (source.kind !== 'cache' && source.kind !== 'archive') return null;
    const part = source.part;
    if (
      source.kind === 'archive' &&
      (!/^[\w-][\w.-]{0,199}$/.test(source.id) ||
        (part !== undefined && part !== 'logs' && part !== 'recordings' && part !== 'agentActions'))
    )
      return null;
    if (typeof value.bytes !== 'number' || !Number.isFinite(value.bytes) || value.bytes < 0) return null;
    const typed: ItemTrashManifest['source'] =
      source.kind === 'cache'
        ? { kind: 'cache', id: source.id }
        : {
            kind: 'archive',
            id: source.id,
            ...(part === 'logs' || part === 'recordings' || part === 'agentActions' ? { part } : {}),
          };
    return { kind: 'gc-item', createdAt: value.createdAt, source: typed, bytes: value.bytes };
  } catch {
    return null;
  }
}

/** Moves only the directory tree its caller already selected and locked; false leaves the existing in-place delete responsible. */
export async function stageItemTrash(
  path: string,
  bytes: number,
  source: ItemTrashManifest['source'],
  signal?: AbortSignal,
): Promise<boolean> {
  signal?.throwIfAborted();
  if (process.platform === 'win32') return false;
  let dir: string | undefined;
  let claim;
  let moved = false;
  try {
    if (!(await lstat(path)).isDirectory()) return false;
    await mkdir(trashRoot(), { recursive: true });
    if (filesystemDevice(path) !== filesystemDevice(trashRoot())) return false;
    dir = await mkdtemp(join(trashRoot(), ITEM_TRASH_PREFIX));
    const attempt = tryAcquireClaim({ root: join(dir, TRASH_CLAIMS), mode: 'exclusive', label: 'item trash' });
    claim = attempt.acquired;
    if (!claim) {
      if (attempt.pending) releaseClaim(attempt.pending);
      return false;
    }
    const manifest: ItemTrashManifest = { kind: 'gc-item', createdAt: new Date().toISOString(), source, bytes };
    await writeFile(join(dir, TRASH_MANIFEST), `${JSON.stringify(manifest)}\n`);
    await mkdir(join(dir, 'entries'));
    signal?.throwIfAborted();
    await rename(path, join(dir, 'entries', 'payload'));
    moved = true;
    return true;
  } catch {
    signal?.throwIfAborted();
    return false;
  } finally {
    if (claim) releaseClaim(claim);
    if (dir && !moved) await rm(dir, { recursive: true, force: true });
  }
}

/** Typed manifest estimates and the oldest verified payload, without walking or sizing contents. */
export async function itemTrashInventory(signal?: AbortSignal): Promise<{
  count: number;
  bytes: number;
  oldest?: { path: string; createdAt: string };
}> {
  const read = <T>(path: string, start: () => Promise<T>) => (signal ? answered(path, start, 3_000, signal) : start());
  const missing = () => {
    signal?.throwIfAborted();
    return null;
  };
  const metadata = (path: string) =>
    read(path, () => lstat(path)).catch((error: unknown) => {
      if (error instanceof Unanswered) throw error;
      return missing();
    });
  let count = 0;
  let bytes = 0;
  let oldest: { path: string; createdAt: string } | undefined;
  const root = trashRoot();
  const verifiedRoot = (await metadata(root))?.isDirectory() === true;
  const names = await read(root, () => readdir(root)).catch((error: unknown) => {
    if (error instanceof Unanswered) throw error;
    missing();
    return [];
  });
  for (const name of names) {
    if (!name.startsWith(ITEM_TRASH_PREFIX)) continue;
    const dir = join(root, name);
    if (!(await metadata(dir))?.isDirectory()) continue;
    const manifest = await read(dir, () => readItemTrash(dir));
    if (!manifest) continue;
    count++;
    const payload = await metadata(join(dir, 'entries', 'payload'));
    if (payload) bytes += manifest.bytes;
    const created = Date.parse(manifest.createdAt);
    if (!verifiedRoot || !payload?.isDirectory() || !Number.isFinite(created)) continue;
    if (!(await metadata(join(dir, 'entries')))?.isDirectory()) continue;
    if (!(await metadata(join(dir, TRASH_MANIFEST)))?.isFile()) continue;
    if (!oldest || created < Date.parse(oldest.createdAt)) oldest = { path: dir, createdAt: manifest.createdAt };
  }
  return { count, bytes, ...(oldest ? { oldest } : {}) };
}

/** Pending estimates from typed manifests, without walking or sizing their contents. */
export async function pendingItemTrash(): Promise<{ count: number; bytes: number }> {
  const { count, bytes } = await itemTrashInventory();
  return { count, bytes };
}
