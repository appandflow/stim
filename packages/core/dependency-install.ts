import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';

/** The existing worker install command and marker identity for a repository's selected lockfile. */
export function dependencyInstall(
  root: string,
  packageName: string | null,
): { command: 'pnpm' | 'yarn' | 'npm'; args: string[]; lockfile: string; digest: string } | null {
  const file = ['pnpm-lock.yaml', 'yarn.lock', 'package-lock.json'].find((name) => existsSync(join(root, name)));
  if (!file) return null;
  const command = file === 'pnpm-lock.yaml' ? 'pnpm' : file === 'yarn.lock' ? 'yarn' : 'npm';
  const args =
    command === 'pnpm'
      ? ['install', '--frozen-lockfile', ...(packageName ? ['--filter', `${packageName}...`] : [])]
      : command === 'yarn'
        ? ['install', '--frozen-lockfile']
        : ['ci'];
  const bytes = readFileSync(join(root, file));
  return {
    command,
    args,
    lockfile: createHash('sha256').update(bytes).digest('hex'),
    digest: createHash('sha256').update(bytes).update(JSON.stringify(args)).digest('hex'),
  };
}

/** Whether the worker can reuse this project's dependency install without running the package manager. */
export function reusableDependencies(
  area: string,
  project: string,
  packageName: string | null,
  lockfile: string,
): boolean {
  try {
    const root = realpathSync(join(area, 'src'));
    const selected = realpathSync(join(root, project));
    const path = relative(root, selected);
    if (path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) return false;
    const install = dependencyInstall(root, packageName);
    return (
      install?.lockfile === lockfile &&
      existsSync(join(selected, 'node_modules')) &&
      readFileSync(join(area, 'dependencies'), 'utf8') === install.digest
    );
  } catch {
    return false;
  }
}
