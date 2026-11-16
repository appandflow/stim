import { chmodSync, mkdirSync, realpathSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join, sep } from 'node:path';
import type { Roots } from './types.ts';

export function productionRoots(): Roots {
  const { homedir, uid } = userInfo();
  return {
    home: homedir,
    claudeProjects: join(homedir, '.claude', 'projects'),
    claudeTmp: `/tmp/claude-${uid}`,
    codexHome: join(homedir, '.codex'),
  };
}

function inside(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}${sep}`);
}

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

export function requireConfined(path: string, home: string, what: string, readable: string[]): string {
  const real = realpathSync(path);
  const realHome = realpathSync(home);
  if (real === realHome || !inside(real, realHome))
    throw new Error(
      `${what} resolves to ${real}, which must be inside the home folder ${realHome}, denied to the agents`,
    );
  const exposed = readable.find((each) => inside(real, canonical(each)));
  if (exposed) throw new Error(`${what} resolves to ${real}, inside ${exposed}, which the agents can read`);
  return real;
}

export function prepareResultsRoot(roots: Roots, readable: string[]): string {
  const root = join(roots.home, '.stim-agent-eval', 'results');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  return requireConfined(root, roots.home, 'the results directory', readable);
}
