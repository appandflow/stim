import { lstat, readdir } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import { answered, Unanswered } from './bounded-read.ts';
import { isKeypairName } from './cargo-target.ts';
import { absent } from './scan-rules.ts';

const PROTECTED_WALK_MS = 15_000;
const MAX_PROTECTED_ENTRIES = 500_000;
const INCOMPLETE = 'its files could not all be checked for keypairs and pnpm patches';

/**
 * Why deleting the folder at `path` would delete what no rebuild or reinstall restores, or null. One walk of it, never
 * through a link or onto another volume, outside `.git`, and into a node_modules only for its `.pnpm_patches`, looks
 * for a `*-keypair.json` in any letter case, a non-empty `.pnpm_patches` in a node_modules, and a `deploy` link in a
 * `target` folder. A folder that cannot be read, another volume, more than MAX_PROTECTED_ENTRIES entries or a walk past
 * PROTECTED_WALK_MS keeps the folder too.
 */
export async function protectedPathHold(path: string, signal?: AbortSignal): Promise<string | null> {
  const started = performance.now();
  const left = () => Math.max(1, PROTECTED_WALK_MS - (performance.now() - started));
  const list = (dir: string) => answered(dir, () => readdir(dir, { withFileTypes: true }), left(), signal);
  const device = async (dir: string) => (await answered(dir, () => lstat(dir), left(), signal)).dev;
  const patched = async (modules: string) => {
    try {
      return (await list(join(modules, '.pnpm_patches'))).length > 0;
    } catch (error) {
      if (absent(error)) return false;
      throw error;
    }
  };
  let entries = 0;
  try {
    const dev = await device(path);
    const queue = [path];
    for (let dir = queue.pop(); dir !== undefined; dir = queue.pop()) {
      if (performance.now() - started > PROTECTED_WALK_MS) throw new Unanswered('timed out');
      if (dir !== path && (await device(dir)) !== dev)
        return `its ${relative(path, dir)} is on another volume, which the check for keypairs does not enter`;
      for (const entry of await list(dir)) {
        if (++entries > MAX_PROTECTED_ENTRIES) return `${INCOMPLETE}: it holds over ${MAX_PROTECTED_ENTRIES} entries`;
        const rel = relative(path, join(dir, entry.name));
        if (isKeypairName(entry.name) && !entry.isDirectory())
          return `its ${rel} is a Solana keypair, which a rebuild does not recreate`;
        if (entry.name === 'deploy' && entry.isSymbolicLink() && basename(dir) === 'target')
          return `its ${rel} is a link, which can lead to a Solana keypair`;
        if (!entry.isDirectory() || entry.name === '.git') continue;
        if (entry.name !== 'node_modules') queue.push(join(dir, entry.name));
        else if (await patched(join(dir, entry.name)))
          return `it has an unfinished pnpm patch in ${rel}/.pnpm_patches; run pnpm patch-commit or delete it`;
      }
    }
  } catch (error) {
    signal?.throwIfAborted();
    return error instanceof Unanswered
      ? `${INCOMPLETE} within ${PROTECTED_WALK_MS / 1000} s`
      : `${INCOMPLETE}: one cannot be read`;
  }
  return null;
}
