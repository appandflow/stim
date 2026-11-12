import { realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { relative, resolve, sep } from 'node:path';

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

const TEMPORARY = ['/tmp', '/var/tmp', '/var/folders'];

/**
 * Whether a path lies under the system temporary directory, or under a dot-folder directly inside the home directory
 * (`~/.codex`, `~/.config`, `~/.exact`): other tools own what is there, so Stim never acts on it.
 */
export function isProtectedLocation(path: string): boolean {
  const target = real(path);
  const inside = (folder: string) => target === folder || target.startsWith(`${folder}${sep}`);
  if ([tmpdir(), ...TEMPORARY].some((folder) => inside(real(folder)))) return true;
  const home = real(homedir());
  if (!inside(home)) return false;
  return relative(home, target).split(sep)[0]?.startsWith('.') === true;
}
