import { realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { relative, sep } from 'node:path';

const TEMPORARY = ['/tmp', '/var/tmp', '/var/folders'];

interface Roots {
  home: string;
  temps: readonly string[];
}

function defaultRoots(): Roots {
  return { home: homedir(), temps: [tmpdir(), ...TEMPORARY] };
}

function real(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

// @ref LLP 0004#scope -- other tools own worktrees under temp and home dot-folders
/**
 * Whether a path lies under the system temporary directory, or under a dot-folder directly inside the home directory
 * (`~/.codex`, `~/.config`, `~/.exact`): other tools own what is there, so Stim never acts on it. A path that does not
 * resolve counts as protected.
 */
export function isProtectedLocation(path: string, roots: Roots = defaultRoots()): boolean {
  const target = real(path);
  if (target === null) return true;
  const inside = (folder: string) => target === folder || target.startsWith(`${folder}${sep}`);
  if (roots.temps.some((folder) => inside(real(folder) ?? folder))) return true;
  const home = real(roots.home) ?? roots.home;
  return inside(home) && relative(home, target).split(sep)[0]?.startsWith('.') === true;
}
