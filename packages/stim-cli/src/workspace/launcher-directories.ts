import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

/**
 * Where the executables a person installs by linking them live: the PATH directories of the process, and the per-user
 * bin folders a daemon started by launchd, with its minimal PATH, does not list: `~/.local/bin` and `~/bin` (user
 * links), `~/.cargo/bin` (cargo install), `~/.bun/bin` (bun), `~/.volta/bin` (Volta), `~/Library/pnpm` (pnpm's global
 * bin), the active nvm bin (`NVM_BIN`), and `/usr/local/bin` and `/opt/homebrew/bin` (Homebrew).
 */
export function launcherDirectories(env: NodeJS.ProcessEnv): string[] {
  const home = homedir();
  const extra = [
    join(home, '.local', 'bin'),
    join(home, 'bin'),
    join(home, '.cargo', 'bin'),
    join(home, '.bun', 'bin'),
    join(home, '.volta', 'bin'),
    join(home, 'Library', 'pnpm'),
    ...(env.NVM_BIN ? [env.NVM_BIN] : []),
    '/usr/local/bin',
    '/opt/homebrew/bin',
  ];
  return [...new Set([...(env.PATH ?? '').split(delimiter).filter(Boolean), ...extra])];
}
