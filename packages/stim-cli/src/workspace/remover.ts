import { randomUUID } from 'node:crypto';
import { readFileSync, statSync, type Stats } from 'node:fs';
import { chmod, lstat, readdir, realpath, rename, rmdir, unlink } from 'node:fs/promises';
import { basename, dirname, join, sep } from 'node:path';

/** One delete the delete child runs: `path` and everything below it, on device `dev` only. */
export interface RmJob {
  id: number;
  op: 'rm';
  path: string;
  dev: number;
}

/** How a delete ended. `left` lists what the remover did not remove because of its rules. */
export type DeleteOutcome =
  | { done: { left: string[] } }
  | { kept: string }
  | { failed: { code: string | null; message: string; path: string | null } }
  | { cancelled: { left: string[] } };

/** Raised to stop a delete and keep the rest of the tree, with the reason as message. */
class KeepTree extends Error {}

interface Identity {
  dev: number;
  ino: number;
}

const errorCode = (error: unknown): string | undefined =>
  error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined;

const same = (a: Identity, b: Identity) => a.dev === b.dev && a.ino === b.ino;

async function stillInside(path: string): Promise<void> {
  const parent = dirname(path);
  if ((await realpath(parent).catch(() => null)) !== parent)
    throw new KeepTree(`${parent} no longer resolves to itself, so the delete stopped`);
}

/**
 * Reads Linux's `/proc/self/mountinfo`, where a bind mount keeps the device number of the volume it exposes, so the
 * `st_dev` checks cannot see it; null where there is no such file.
 */
export const LINUX_MOUNT_INFO: (() => string) | null =
  process.platform === 'linux' ? () => readFileSync('/proc/self/mountinfo', 'utf8') : null;

/** Why a mount point lies at or under `target` by `mountInfo`, or null when none does. */
export function mountedUnder(target: string, mountInfo: (() => string) | null): string | null {
  if (!mountInfo) return null;
  let text: string;
  try {
    text = mountInfo();
  } catch (error) {
    return `the mounts cannot be read: ${error instanceof Error ? error.message : error}`;
  }
  for (const line of text.split('\n')) {
    const field = line.split(' ')[4];
    if (!field) continue;
    const point = field.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
    if (point === target || point.startsWith(`${target}/`)) return `${point} is a mount point`;
  }
  return null;
}

/** How the walk names the entry it acts on, and how it enters and leaves a directory. */
interface Anchor {
  name(path: string): Promise<string>;
  list(path: string): string;
  /** Renames the entry `raw` of directory `dir`, whose name is not valid UTF-8, to an ASCII name, and returns that. */
  rename(dir: string, raw: Buffer): Promise<string>;
  enter(path: string, seen: Identity): void;
  leave(parent: Identity): void;
}

const asciiName = () => `.stim-delete-${randomUUID()}`;

/**
 * In the caller's thread, where the working directory is not the walk's to change: every call takes the absolute path,
 * after a check that its parent still resolves to itself.
 */
const byPath: Anchor = {
  async name(path) {
    await stillInside(path);
    return path;
  },
  list: (path) => path,
  async rename(dir, raw) {
    const to = asciiName();
    await stillInside(join(dir, to));
    await rename(Buffer.concat([Buffer.from(`${dir}${sep}`), raw]), join(dir, to));
    return to;
  },
  enter() {},
  leave() {},
};

/** The process working directory, which only the delete child may change: it is process-wide. */
export interface WorkingDirectory {
  chdir(path: string): void;
  current(): string;
}

/**
 * In the delete child: the walk works inside the directory it checked, with single-component names. Entering compares
 * the new working directory with the directory seen before it, and leaving compares the parent with the one recorded, so
 * a directory swapped for a link after its check is never acted through.
 */
const byWorkingDirectory = (cwd: WorkingDirectory): Anchor => ({
  name: async (path) => basename(path),
  list: () => '.',
  async rename(_dir, raw) {
    const to = asciiName();
    await rename(raw, to);
    return to;
  },
  enter(path, seen) {
    cwd.chdir(basename(path));
    if (!same(statSync('.'), seen))
      throw new KeepTree(`${path} was replaced while it was deleted, so the delete stopped`);
  },
  leave(parent) {
    cwd.chdir('..');
    if (!same(statSync('.'), parent))
      throw new KeepTree('a directory above the delete was replaced while it ran, so the delete stopped');
  },
});

interface RemoveOptions {
  dev: number;
  anchor: Anchor;
  signal: AbortSignal;
  removed?: () => void;
}

/**
 * Removes `path`, inside the directory `parent`, deepest first. A symbolic link is unlinked and never followed, a
 * directory on a device other than `dev` is not entered, a directory without owner read or write permission gets them
 * once entered (one without owner search permission gets its mode set by name first: the one call made before the
 * anchor, which a link swapped in after the `lstat` would redirect to the link target), an
 * entry whose name is not valid UTF-8 is renamed to an ASCII name in its directory first, and a directory goes once it
 * is empty. A path already gone counts as removed. Returns the
 * paths it left: directories on another device, and a directory refilled or replaced meanwhile.
 */
async function removeInPlace(path: string, parent: Identity, options: RemoveOptions): Promise<string[]> {
  options.signal.throwIfAborted();
  const { anchor } = options;
  const name = await anchor.name(path);
  const stat: Stats | null = await lstat(name).catch((error: unknown) => {
    if (errorCode(error) === 'ENOENT') return null;
    throw error;
  });
  if (!stat) return [];
  if (!stat.isDirectory()) {
    await unlink(name).catch((error: unknown) => {
      if (errorCode(error) !== 'ENOENT') throw error;
    });
    options.removed?.();
    return [];
  }
  if (stat.dev !== options.dev) return [path];
  if (!(stat.mode & 0o100)) await chmod(name, stat.mode | 0o700);
  anchor.enter(path, stat);
  const left: string[] = [];
  try {
    if ((stat.mode & 0o600) !== 0o600) await chmod(anchor.list(path), stat.mode | 0o700);
    for (const raw of await readdir(anchor.list(path), { encoding: 'buffer' })) {
      const decoded = raw.toString();
      const child = Buffer.from(decoded).equals(raw) ? decoded : await anchor.rename(path, raw);
      left.push(...(await removeInPlace(join(path, child), stat, options)));
    }
  } finally {
    anchor.leave(parent);
  }
  if (left.length) return left;
  try {
    await rmdir(await anchor.name(path));
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOTEMPTY' || code === 'EEXIST' || code === 'ENOTDIR') return [path];
    if (code !== 'ENOENT') throw error;
  }
  options.removed?.();
  return [];
}

/**
 * Runs one `rm` job. `path` must be canonical up to its parent and on device `dev`; a path that moved, or one on another
 * device, is kept. With `cwd`, which only the delete child passes, the walk changes the working directory and the child
 * runs one job at a time; the caller's thread passes none and checks each path instead.
 */
export async function runRmJob(
  job: RmJob,
  signal: AbortSignal,
  {
    cwd,
    removed,
    mountInfo = LINUX_MOUNT_INFO,
  }: { cwd?: WorkingDirectory; removed?: () => void; mountInfo?: (() => string) | null } = {},
): Promise<DeleteOutcome> {
  let start: string | undefined;
  try {
    start = cwd?.current();
    await stillInside(job.path);
    // @ref LLP 0007#a-delete-child-holds-the-claim-of-the-tree-it-deletes -- never into a bind mount
    const mounted = mountedUnder(job.path, mountInfo);
    if (mounted) return { kept: mounted };
    const parent = await lstat(dirname(job.path));
    const stat = await lstat(job.path).catch(() => null);
    if (stat && stat.dev !== job.dev) return { kept: `${job.path} is no longer on the device it was planned on` };
    if (cwd) {
      cwd.chdir(dirname(job.path));
      if (!same(statSync('.'), parent)) return { kept: `${dirname(job.path)} was replaced before the delete started` };
    }
    const anchor = cwd ? byWorkingDirectory(cwd) : byPath;
    return { done: { left: await removeInPlace(job.path, parent, { dev: job.dev, anchor, signal, removed }) } };
  } catch (error) {
    if (signal.aborted) return { cancelled: { left: [job.path] } };
    if (error instanceof KeepTree) return { kept: error.message };
    const path = error instanceof Error && 'path' in error && typeof error.path === 'string' ? error.path : null;
    return {
      failed: { code: errorCode(error) ?? null, message: error instanceof Error ? error.message : String(error), path },
    };
  } finally {
    if (cwd && start !== undefined)
      try {
        cwd.chdir(start);
      } catch {}
  }
}
