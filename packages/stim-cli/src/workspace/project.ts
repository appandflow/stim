import { realpathSync } from 'fs';
import { basename, resolve } from 'path';
import { type ProjectRecord, loadConfig, findEnclosingWorktreeRoot, getProject, isPathPrefix } from './config.ts';
import { projectRegistry } from '../integrations/projects.ts';
import type { ProjectRegistry } from '../integrations/project-registry.ts';
export {
  appProjectProblem,
  declaresAppDependency,
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

export interface ResolveResult {
  found: string | null;
  error?: string;
}

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

export function resolveRegisteredProject(arg?: string | null): ResolveResult {
  const cfg = loadConfig();
  const projects = cfg?.projects || {};

  if (!arg) {
    const root = findProjectRoot(process.cwd());
    if (!root) return { found: null, error: NO_PROJECT_REFUSAL.message };
    if (!projects[root])
      return {
        found: null,
        error: `No Stim entry for ${root}. Run \`stim start\` or \`stim ios\` there first.`,
      };
    return { found: root };
  }

  let abs: string;
  try {
    abs = realpathSync(resolve(arg));
  } catch {
    abs = resolve(arg);
  }
  if (projects[abs]) return { found: abs };
  if (projects[arg]) return { found: arg };

  const matches = Object.keys(projects).filter((p) => projectShortcut(p, projects[p]) === arg);
  if (matches.length === 1) {
    const only = matches[0];
    if (only !== undefined) return { found: only };
  }
  if (matches.length > 1) {
    return {
      found: null,
      error: `Multiple projects share the shortcut "${arg}": ${matches.join(', ')}. Pass the absolute path or set a unique --label.`,
    };
  }

  return {
    found: null,
    error: `No registered project matches "${arg}". See \`stim status\` for the list.`,
  };
}

export function findServerWorkspace(
  startDir: string,
  registry: ProjectRegistry = projectRegistry,
): { root: string; from: string | null } | null {
  const nearest = registry.findProjectRoot(startDir);
  if (!nearest) return null;
  if (registry.keepsWorkspace(nearest)) return { root: nearest, from: null };
  if (Object.keys(getProject(nearest)?.ports ?? {}).length) return { root: nearest, from: null };
  const top = repoRoot(nearest);
  if (!top) return { root: nearest, from: null };
  const worktree = expandedRealpath(top);
  const apps = Object.keys(loadConfig()?.projects ?? {}).filter((path) => {
    if (path === nearest || !isPathPrefix(worktree, expandedRealpath(path)) || !registry.isMobileProject(path))
      return false;
    const owner = repoRoot(path);
    return owner !== null && expandedRealpath(owner) === worktree;
  });
  return apps.length === 1 ? { root: apps[0]!, from: nearest } : { root: nearest, from: null };
}

export function findCommandWorkspace(
  startDir: string,
  note: (line: string) => void = (line) => console.error(line),
): string | null {
  const workspace = findServerWorkspace(startDir);
  if (workspace?.from)
    note(`Using the Stim workspace ${workspace.root}: ${workspace.from} is not a React Native or Expo app.`);
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
