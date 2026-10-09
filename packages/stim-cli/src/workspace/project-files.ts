import { existsSync, readFileSync, realpathSync } from 'fs';
import { dirname, join, resolve } from 'path';

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

export function loadPackageJson(projectRoot: string): { pkg: PackageJson | null; parseError: string | null } {
  const p = join(projectRoot, 'package.json');
  if (!existsSync(p)) return { pkg: null, parseError: null };
  try {
    return { pkg: JSON.parse(readFileSync(p, 'utf-8')), parseError: null };
  } catch (error) {
    return { pkg: null, parseError: (error as Error)?.message || String(error) };
  }
}

export function readPackageJson(projectRoot: string): PackageJson | null {
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

export function appProjectProblem(
  projectRoot: string,
  { pkg, parseError }: ReturnType<typeof loadPackageJson> = loadPackageJson(projectRoot),
): AppProjectProblem | null {
  const file = join(projectRoot, 'package.json');
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

export function detectTutorial(appJson: AnyJson | null): { version: number } | undefined {
  const extra = appJson?.expo?.extra;
  const version =
    typeof extra === 'object' && extra !== null ? (extra as { stimTutorial?: unknown }).stimTutorial : null;
  return typeof version === 'number' && Number.isInteger(version) && version > 0 ? { version } : undefined;
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
