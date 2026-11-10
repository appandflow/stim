import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import type { Provenance } from './index-store.ts';
import { byCodeUnit, canonicalJson, sha256, type Input } from './key.ts';

const EXPO_ENTRY_POINTS = ['@expo/cli', '@expo/prebuild-config', '@expo/config-plugins'];

function manifest(dir: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    return typeof value === 'object' && value !== null ? { ...value } : {};
  } catch {
    return {};
  }
}

/** Where Node finds package `name` from `from`, by the node_modules lookup, whatever the package exports. */
export function findPackage(from: string, name: string): string | null {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return realpathSync.native(candidate);
    if (dirname(dir) === dir) return null;
  }
}

/** The root of the installed package a path under `node_modules` belongs to. */
export function packageRoot(path: string): string | null {
  const segments = path.split(sep);
  const at = segments.lastIndexOf('node_modules');
  const scope = segments[at + 1]?.startsWith('@') ? 1 : 0;
  return at === -1 || segments.length < at + 2 + scope ? null : segments.slice(0, at + 2 + scope).join(sep);
}

/** The installed package a path under `node_modules` belongs to, when that directory is a named package. */
export function installedPackage(path: string): string | null {
  const root = packageRoot(path);
  return root && typeof manifest(root).name === 'string' ? root : null;
}

export function projectPackagePath(project: string, path: string): boolean {
  const actual = installedPackage(path);
  const name = actual && packageIdentity(actual)?.name;
  return Boolean(actual && name && findPackage(project, name) === actual);
}

/**
 * The packages that run when `expo prebuild` applies mods or React Native codegen runs, and their direct
 * dependencies. Their code runs after config evaluation, so no trace sees it. Transitive dependencies are left out:
 * they reach Metro and the CLIs, and would turn every lockfile refresh into a native miss.
 */
export function entryPoints(root: string, expo: string | null): { dirs: string[]; missing: string[] } {
  const dirs = new Set<string>();
  const missing = new Set<string>();
  const add = (from: string, name: string, withDependencies: boolean) => {
    const dir = findPackage(from, name);
    if (!dir) return void missing.add(name);
    dirs.add(dir);
    const dependencies = withDependencies ? manifest(dir).dependencies : null;
    for (const dependency of Object.keys(dependencies && typeof dependencies === 'object' ? dependencies : {}))
      add(dir, dependency, false);
  };
  if (expo) {
    dirs.add(expo);
    add(expo, 'expo-modules-autolinking', false);
    for (const name of EXPO_ENTRY_POINTS) add(expo, name, true);
  }
  const reactNative = findPackage(root, 'react-native');
  if (reactNative) {
    dirs.add(reactNative);
    add(reactNative, '@react-native/codegen', true);
    add(reactNative, '@react-native/gradle-plugin', false);
  }
  return { dirs: [...dirs], missing: [...missing] };
}

/** A package's `name` and `version` from its `package.json`, or null when it names none. */
export function packageIdentity(dir: string): { name: string; version: string } | null {
  const { name, version } = manifest(dir);
  return typeof name === 'string' ? { name, version: typeof version === 'string' ? version : '' } : null;
}

/**
 * One row per package name: its installed versions with the lockfile's integrity, `resolved` and patch hash, sorted.
 * A copy hashed by content (not a registry tarball, or an origin the lockfile reader cannot tell) carries the digest
 * of its native files instead and marks the row's `mode`. A name that does not resolve hashes an empty list.
 */
export function packageRows(
  identities: Iterable<{ name: string; version: string; provenance?: Provenance; content?: string }>,
  missing: Iterable<string> = [],
): Input[] {
  const versions = new Map<string, Set<string>>();
  const labels = new Map<string, Set<string>>();
  const byContent = new Set<string>();
  for (const name of missing) versions.set(name, versions.get(name) ?? new Set());
  for (const { name, version, provenance, content } of identities) {
    const known = versions.get(name) ?? new Set();
    const { mode = 'identity', integrity = null, resolved = null, patch = null } = provenance ?? {};
    known.add(canonicalJson(content ? [version, null, null, null, content] : [version, integrity, resolved, patch]));
    if (mode === 'content') byContent.add(name);
    versions.set(name, known);
    labels.set(name, (labels.get(name) ?? new Set()).add(version));
  }
  return [...versions].map(([name, set]) => {
    const sorted = [...set].toSorted(byCodeUnit);
    return {
      name: `package:${name}`,
      kind: 'package',
      hash: sha256(canonicalJson({ name, versions: sorted })),
      version: [...(labels.get(name) ?? [])].toSorted(byCodeUnit).join(' '),
      mode: byContent.has(name) ? 'content' : 'identity',
    };
  });
}
