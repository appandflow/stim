import { realpathSync } from 'fs';
import { basename, resolve } from 'path';
import { type ProjectRecord, loadConfig, findEnclosingWorktreeRoot, getProject, isPathPrefix } from './config.ts';
import { projectRegistry } from '../integrations/projects.ts';
import type { ProjectRegistry } from '../integrations/project-registry.ts';
export {
  appProjectProblem,
  detectIsExpo,
  detectTutorial,
  isPackageResolvable,
  readAppConfigText,
  readAppJson,
  resolvePackageJson,
} from './project-files.ts';
export const findProjectRoot: ProjectRegistry['findProjectRoot'] = projectRegistry.findProjectRoot;
export const projectProblem: ProjectRegistry['projectProblem'] = projectRegistry.projectProblem;
export const isMobileProject: ProjectRegistry['isMobileProject'] = projectRegistry.isMobileProject;
import { repoRoot } from './worktree.ts';

export function projectShortcut(path: string, proj: ProjectRecord | null | undefined): string {
  if (proj?.label) return proj.label;
  const rootPath = findEnclosingWorktreeRoot(path);
  if (rootPath && rootPath !== path) {
    const rootLabel = projectShortcut(rootPath, getProject(rootPath));
    const base = path.split('/').pop() || path;
    return `${rootLabel}/${base}`;
  }
  return path.split('/').pop() || path;
}

export function ownedDeviceLabel(projectPath: string): string {
  const app = realpathSync(projectPath);
  const root = repoRoot(app);
  const appLabel = basename(app);
  if (!root) return appLabel;
  const worktreeLabel = basename(realpathSync(root));
  return worktreeLabel === appLabel ? appLabel : `${worktreeLabel}-${appLabel}`;
}

export const NO_PROJECT_REFUSAL = {
  code: 'STIM_NO_PROJECT',
  message: 'No supported app project was found from this directory.',
  remedy: 'Run this from the directory of a supported app.',
};

type ServerWorkspace = { root: string; from: string | null };

function startServerWorkspace(
  startDir: string,
  registry: ProjectRegistry,
): { found: ServerWorkspace | null } | { nearest: string } {
  const nearest = registry.findProjectRoot(startDir);
  if (!nearest) return { found: null };
  if (registry.keepsWorkspace(nearest)) return { found: { root: nearest, from: null } };
  if (Object.keys(getProject(nearest)?.ports ?? {}).length) return { found: { root: nearest, from: null } };
  return { nearest };
}

function sameRepositoryApps(nearest: string, top: string, registry: ProjectRegistry): string[] {
  const worktree = expandedRealpath(top);
  return Object.keys(loadConfig()?.projects ?? {}).filter(
    (path) => path !== nearest && isPathPrefix(worktree, expandedRealpath(path)) && registry.isMobileProject(path),
  );
}

function chooseServerWorkspace(
  nearest: string,
  top: string,
  candidates: string[],
  owners: (string | null)[],
): ServerWorkspace {
  const worktree = expandedRealpath(top);
  const apps = candidates.filter((_, index) => {
    const owner = owners[index];
    return owner !== null && owner !== undefined && expandedRealpath(owner) === worktree;
  });
  return apps.length === 1 ? { root: apps[0]!, from: nearest } : { root: nearest, from: null };
}

export function findServerWorkspace(
  startDir: string,
  registry: ProjectRegistry = projectRegistry,
): ServerWorkspace | null {
  const start = startServerWorkspace(startDir, registry);
  if ('found' in start) return start.found;
  const top = repoRoot(start.nearest);
  if (!top) return { root: start.nearest, from: null };
  const candidates = sameRepositoryApps(start.nearest, top, registry);
  return chooseServerWorkspace(start.nearest, top, candidates, candidates.map(repoRoot));
}

/** `findCommandWorkspace` with the repository roots read by `repoRootOf`, so no Git call blocks the event loop. */
export async function findCommandWorkspaceAsync(
  startDir: string,
  repoRootOf: (dir: string) => Promise<string | null>,
  note: (line: string) => void,
): Promise<string | null> {
  const start = startServerWorkspace(startDir, projectRegistry);
  if ('found' in start) return start.found?.root ?? null;
  const top = await repoRootOf(start.nearest);
  if (!top) return start.nearest;
  const candidates = sameRepositoryApps(start.nearest, top, projectRegistry);
  const workspace = chooseServerWorkspace(
    start.nearest,
    top,
    candidates,
    await Promise.all(candidates.map(repoRootOf)),
  );
  if (workspace.from) noteWorkspace(workspace, note);
  return workspace.root;
}

function noteWorkspace(workspace: ServerWorkspace, note: (line: string) => void): void {
  note(`Using the Stim workspace ${workspace.root}: ${workspace.from} is not a React Native or Expo app.`);
}

export function findCommandWorkspace(
  startDir: string,
  note: (line: string) => void = (line) => console.error(line),
): string | null {
  const workspace = findServerWorkspace(startDir);
  if (workspace?.from) noteWorkspace(workspace, note);
  return workspace?.root ?? null;
}

// Registry keys can hold Windows 8.3 short names (RUNNER~1) that git never prints; only the native realpath
// expands them.
function expandedRealpath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}
