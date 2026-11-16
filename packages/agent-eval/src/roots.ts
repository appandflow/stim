import { realpathSync } from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import type { Roots } from './types.ts';

export function resolveRoots(env: NodeJS.ProcessEnv): Roots {
  const override = env.STIM_EVAL_HOME;
  const home = override ?? userInfo().homedir;
  return {
    home,
    claudeProjects: join(home, '.claude', 'projects'),
    claudeTmp: override ? join(home, 'claude-tmp') : `/tmp/claude-${userInfo().uid}`,
    codexHome: env.CODEX_HOME && !override ? env.CODEX_HOME : join(home, '.codex'),
  };
}

function canonical(path: string): string {
  const absolute = resolve(path);
  const rest: string[] = [];
  let probe = absolute;
  for (;;) {
    try {
      return join(realpathSync(probe), ...rest.toReversed());
    } catch {
      const parent = dirname(probe);
      if (parent === probe) return absolute;
      rest.push(probe.slice(parent.length + 1));
      probe = parent;
    }
  }
}

function inside(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}${sep}`);
}

export function checkOutput(out: string, home: string, checkout: string, temporary: string): string {
  const target = canonical(out);
  const refuse = (): never => {
    throw new Error(
      `--out must lie inside the home folder ${home}, outside the checkout and outside the temporary directory, because the agents are denied the home and can read the rest: ${out}`,
    );
  };
  if (!inside(target, canonical(home)) || target === canonical(home)) refuse();
  for (const root of [canonical(checkout), canonical(temporary)]) if (inside(target, root)) refuse();
  return target;
}
