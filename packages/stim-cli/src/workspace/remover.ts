import { statSync, type Stats } from 'node:fs';
import { chmod, lstat, readdir, realpath, rmdir, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

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

/** How the walk names the entry it acts on, and how it enters and leaves a directory. */
interface Anchor {
  name(path: string): Promise<string>;
  list(path: string): string;
  enter(path: string, seen: Identity): void;
  leave(parent: Identity): void;
}

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
 * directory on a device other than `dev` is not entered, a directory without owner read, write or search permission gets
 * them before it is listed, and a directory goes once it is empty. A path already gone counts as removed. Returns the
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
  if ((stat.mode & 0o700) !== 0o700) await chmod(name, stat.mode | 0o700);
  anchor.enter(path, stat);
  const left: string[] = [];
  try {
    for (const child of await readdir(anchor.list(path)))
      left.push(...(await removeInPlace(join(path, child), stat, options)));
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
  { cwd, removed }: { cwd?: WorkingDirectory; removed?: () => void } = {},
): Promise<DeleteOutcome> {
  const start = cwd?.current();
  try {
    await stillInside(job.path);
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
