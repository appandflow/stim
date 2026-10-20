import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, relative, sep } from 'node:path';
import { projectNodeBin } from './toolchain.ts';

const LOCKFILES = ['pnpm-lock.yaml', 'yarn.lock', 'package-lock.json'] as const;

/**
 * The lockfile that governs the project at `project` inside `root`: the first one found from that directory up to
 * `root`, as package managers resolve their own. `dir` is relative to `root`, `.` for `root` itself.
 */
export function dependencyLockfile(root: string, project = '.'): { dir: string; file: string } | null {
  let dir = normalize(project);
  while (true) {
    const file = LOCKFILES.find((name) => existsSync(join(root, dir, name)));
    if (file) return { dir, file };
    if (dir === '.') return null;
    dir = dirname(dir);
  }
}

/**
 * The existing worker install command and marker identity for the lockfile that governs the project at `project`.
 * `dir` is where the install runs, relative to `root`, and `marker` names the area file that records the install
 * there, so each install directory of a repository keeps its own. The marker identity also names the major of the
 * Node `projectNodeBin` picks for the project's pin, or `path` when it picks none, so that native addons are rebuilt
 * when the pinned Node changes major.
 */
export function dependencyInstall(
  root: string,
  project = '.',
  env: NodeJS.ProcessEnv = process.env,
): {
  command: 'pnpm' | 'yarn' | 'npm';
  args: string[];
  dir: string;
  marker: string;
  lockfile: string;
  digest: string;
} | null {
  const selected = dependencyLockfile(root, project);
  if (!selected) return null;
  const { dir, file } = selected;
  const command = file === 'pnpm-lock.yaml' ? 'pnpm' : file === 'yarn.lock' ? 'yarn' : 'npm';
  const args = command === 'npm' ? ['ci'] : ['install', '--frozen-lockfile'];
  const bytes = readFileSync(join(root, dir, file));
  const node = projectNodeBin(join(root, project), env, undefined, root)?.version.split('.')[0] ?? 'path';
  return {
    command,
    args,
    dir,
    marker:
      dir === '.'
        ? 'dependencies'
        : `dependencies-${createHash('sha256').update(dir.split(sep).join('/')).digest('hex').slice(0, 16)}`,
    lockfile: createHash('sha256').update(bytes).digest('hex'),
    digest: createHash('sha256').update(bytes).update(JSON.stringify(args)).update(`node ${node}`).digest('hex'),
  };
}

/** Whether the worker can reuse this project's dependency install without running the package manager. */
export function reusableDependencies(
  area: string,
  project: string,
  lockfile: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  try {
    const root = realpathSync(join(area, 'src'));
    const selected = realpathSync(join(root, project));
    const path = relative(root, selected);
    if (path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) return false;
    const install = dependencyInstall(root, path, env);
    return (
      install?.lockfile === lockfile &&
      existsSync(join(selected, 'node_modules')) &&
      readFileSync(join(area, install.marker), 'utf8') === install.digest
    );
  } catch {
    return false;
  }
}
