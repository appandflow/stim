import { userInfo } from 'node:os';
import { join, sep } from 'node:path';
import type { Roots } from './types.ts';

export function productionRoots(env: NodeJS.ProcessEnv): Roots {
  const { homedir, uid } = userInfo();
  const codexHome = env.CODEX_HOME ?? join(homedir, '.codex');
  if (!codexHome.startsWith(`${homedir}${sep}`))
    throw new Error(`CODEX_HOME must be inside the home folder ${homedir}, which the agents are denied: ${codexHome}`);
  return {
    home: homedir,
    claudeProjects: join(homedir, '.claude', 'projects'),
    claudeTmp: `/tmp/claude-${uid}`,
    codexHome,
  };
}

export function resultsRoot(roots: Roots): string {
  return join(roots.home, '.stim-agent-eval', 'results');
}
