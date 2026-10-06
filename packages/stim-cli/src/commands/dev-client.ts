import { dirname, join } from 'node:path';
import { pickDevClientScheme, readBundleSchemes } from '../engine/app-schemes.ts';
import { isJsonObject, readJsonObject } from '@stim-cli/core/state';
import { isPackageResolvable, resolvePackageJson } from '../workspace/project.ts';

export { schemesFromInfoPlist, pickDevClientScheme } from '../engine/app-schemes.ts';

export function devClientScheme(
  root: string,
  appPath: string | null = null,
  { exec = null }: { exec?: import('../exec.ts').Executor | null } = {},
): string | undefined {
  if (!hasDevClient(root)) return undefined;
  const fromBundle = pickDevClientScheme(readBundleSchemes(appPath, { exec }));
  if (fromBundle) return fromBundle;
  const app = readJsonObject(join(root, 'app.json'));
  const expo = app?.expo;
  const raw = (isJsonObject(expo) ? expo.scheme : undefined) ?? app?.scheme ?? null;
  const scheme = Array.isArray(raw) ? raw.find((s) => typeof s === 'string' && s.trim() !== '') : raw;
  if (typeof scheme !== 'string' || scheme.trim() === '') return undefined;
  return scheme.trim();
}

function hasDevClient(root: string): boolean {
  const pkg = readJsonObject(join(root, 'package.json'));
  const declared = [pkg?.dependencies, pkg?.devDependencies].some(
    (deps) => isJsonObject(deps) && 'expo-dev-client' in deps,
  );
  if (declared) return true;
  return isPackageResolvable(root, 'expo-dev-client');
}

/**
 * Whether `version` of expo-dev-launcher reads the `disableFab=1` and `disableAutoLaunch=1` launch
 * URL params (expo/expo#49651, first published in 58.0.0; no 58.0.0 prerelease carries it).
 */
export function devLauncherReadsDevMenuParams(version: string | null): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)(-.+)?$/.exec(version?.trim() ?? '');
  if (!match) return false;
  const [major, minor, patch] = match.slice(1, 4).map(Number) as [number, number, number];
  if (major !== 58) return major > 58;
  return minor > 0 || patch > 0 || match[4] === undefined;
}

export function devClientTakesDevMenuParams(root: string): boolean {
  return devLauncherReadsDevMenuParams(installedDevLauncherVersion(root));
}

function installedDevLauncherVersion(root: string): string | null {
  const devClient = resolvePackageJson(root, 'expo-dev-client');
  const launcher = resolvePackageJson(devClient ? dirname(devClient) : root, 'expo-dev-launcher');
  const version = launcher ? readJsonObject(launcher)?.version : null;
  return typeof version === 'string' ? version : null;
}
