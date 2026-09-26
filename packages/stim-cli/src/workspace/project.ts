import { existsSync, readFileSync, realpathSync } from 'fs';
import { basename, join, dirname, resolve } from 'path';
import { type ProjectRecord, loadConfig, findEnclosingWorktreeRoot, getProject, isPathPrefix } from './config.ts';
import { repoRoot } from './worktree.ts';

interface PackageJson {
  scripts?: Record<string, unknown>;
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
}

interface AnyJson {
  expo?: {
    [key: string]: unknown;
  };
  extra?: { eas?: unknown };
  [key: string]: unknown;
}

export interface ResolveResult {
  found: string | null;
  error?: string;
}

/**
 * The realpath of `name`'s package.json in the nearest `node_modules` at or above `projectRoot`.
 * Unlike `require.resolve`, it ignores `NODE_PATH`, which pnpm's bin shims point at the workspace's
 * hidden hoist directory holding every member's dependencies.
 */
export function resolvePackageJson(projectRoot: string, name: string): string | null {
  for (let dir = resolve(projectRoot); ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name, 'package.json');
    if (existsSync(candidate)) return realpathSync(candidate);
    if (dirname(dir) === dir) return null;
  }
}

export function isPackageResolvable(projectRoot: string, name: string): boolean {
  return resolvePackageJson(projectRoot, name) !== null;
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
  message: 'Not in a React Native project (no package.json found).',
  remedy: 'Run this from the app directory -- the one holding package.json.',
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

export function findProjectRoot(startDir: string): string | null {
  let dir: string;
  try {
    dir = realpathSync(resolve(startDir));
  } catch {
    dir = resolve(startDir);
  }
  while (true) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function findServerWorkspace(startDir: string): { root: string; from: string | null } | null {
  const nearest = findProjectRoot(startDir);
  if (!nearest) return null;
  if (appProjectProblem(nearest)?.kind !== 'not-an-app') return { root: nearest, from: null };
  if (Object.keys(getProject(nearest)?.ports ?? {}).length) return { root: nearest, from: null };
  const top = repoRoot(nearest);
  if (!top) return { root: nearest, from: null };
  const worktree = expandedRealpath(top);
  const apps = Object.keys(loadConfig()?.projects ?? {}).filter((path) => {
    if (path === nearest || !isPathPrefix(worktree, expandedRealpath(path)) || appProjectProblem(path) !== null)
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

function loadPackageJson(projectRoot: string): { pkg: PackageJson | null; parseError: string | null } {
  const p = join(projectRoot, 'package.json');
  if (!existsSync(p)) return { pkg: null, parseError: null };
  try {
    return { pkg: JSON.parse(readFileSync(p, 'utf-8')), parseError: null };
  } catch (error) {
    return { pkg: null, parseError: (error as Error)?.message || String(error) };
  }
}

function readPackageJson(projectRoot: string): PackageJson | null {
  return loadPackageJson(projectRoot).pkg;
}

const APP_DEPENDENCIES = ['react-native', 'expo'];

export interface AppProjectProblem {
  kind: 'not-an-app' | 'unreadable';
  message: string;
  remedy: string;
}

export function declaresAppDependency(pkg: unknown): boolean {
  if (!pkg || typeof pkg !== 'object') return false;
  const { dependencies, devDependencies } = pkg as PackageJson;
  const deps = { ...dependencies, ...devDependencies };
  return APP_DEPENDENCIES.some((name) => name in deps);
}

export function appProjectProblem(projectRoot: string): AppProjectProblem | null {
  const file = join(projectRoot, 'package.json');
  const { pkg, parseError } = loadPackageJson(projectRoot);
  if (parseError)
    return {
      kind: 'unreadable',
      message: `${file} is not valid JSON (${parseError}), so Stim cannot tell whether this is a React Native or Expo app.`,
      remedy: `Fix the JSON in ${file} -- an unfinished edit or a merge conflict leaves it unparseable -- then run the command again.`,
    };
  if (declaresAppDependency(pkg)) return null;
  return {
    kind: 'not-an-app',
    message: `${file} depends on neither react-native nor expo, so this is not a React Native or Expo app.`,
    remedy:
      'Run this from the app directory -- the one whose package.json depends on react-native or expo -- or from that directory inside a worktree.',
  };
}

export function detectIsExpo(projectRoot: string): boolean {
  const pkg = readPackageJson(projectRoot);
  const iosScript = pkg?.scripts?.ios;
  if (typeof iosScript === 'string') {
    if (/\bexpo\s+run:ios\b/.test(iosScript)) return true;
    if (/\breact-native\s+run-ios\b/.test(iosScript)) return false;
  }
  if (!pkg) return false;
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const hasExpoDep = 'expo' in deps;
  const resolvable = () => isPackageResolvable(projectRoot, 'expo');
  if (!hasExpoDep && !resolvable()) return false;

  const appJson = readAppJson(projectRoot);
  if (appJson?.expo) return true;
  const text = readAppConfigText(projectRoot);
  if (text && /\b(?:from\s+['"]expo['"]|expo\/config|ExpoConfig)\b/.test(text)) return true;
  if (hasExpoDep && resolvable()) return true;
  if (looksLikeExpoConfig(appJson)) return true;
  if (podfileUsesExpoModules(projectRoot)) return true;
  return false;
}

function looksLikeExpoConfig(appJson: AnyJson | null): boolean {
  if (!appJson || typeof appJson !== 'object' || Array.isArray(appJson)) return false;
  if (appJson.expo) return true;
  const keys = [
    'slug',
    'plugins',
    'sdkVersion',
    'experiments',
    'runtimeVersion',
    'updates',
    'buildCacheProvider',
    'assetBundlePatterns',
    'splash',
    'orientation',
    'userInterfaceStyle',
  ];
  if (keys.some((key) => appJson[key] !== undefined)) return true;
  return Boolean(appJson.extra && typeof appJson.extra === 'object' && appJson.extra.eas);
}

function podfileUsesExpoModules(projectRoot: string): boolean {
  const p = join(projectRoot, 'ios', 'Podfile');
  if (!existsSync(p)) return false;
  try {
    return /^[^#\n]*use_expo_modules!/m.test(readFileSync(p, 'utf-8'));
  } catch {
    return false;
  }
}

export function readAppJson(projectRoot: string): AnyJson | null {
  const p = join(projectRoot, 'app.json');
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf-8'));
  } catch {
    return null;
  }
}

export function readAppConfigText(projectRoot: string): string | null {
  for (const name of ['app.config.js', 'app.config.ts', 'app.config.cjs', 'app.config.mjs']) {
    const p = join(projectRoot, name);
    if (existsSync(p)) {
      try {
        return readFileSync(p, 'utf-8');
      } catch {}
    }
  }
  return null;
}
