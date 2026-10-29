import { existsSync } from 'node:fs';
import { readdir, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { isJsonObject } from '@stim-cli/core/state';
import { workspaceDir } from '../workspace/paths.ts';
import { readWorkspaceState, updateWorkspaceState } from '../workspace/workspace-state.ts';

const RECORDED_BUILDS_KEY = 'recordedBuilds';

export interface RecordedBuild {
  appPath: string;
  bundleId: string | null;
  builtAt: string;
}

export function recordedBuildKey(selectors: {
  platform: 'ios' | 'android';
  scheme?: string | null;
  configuration?: string | null;
}): string {
  const configuration = selectors.configuration ?? (selectors.platform === 'ios' ? 'Debug' : 'debug');
  return [selectors.platform, selectors.scheme ?? '', configuration].join('|');
}

export function recordBuild(root: string, key: string, build: Omit<RecordedBuild, 'builtAt'>): void {
  updateWorkspaceState(root, (state) => ({
    ...state,
    [RECORDED_BUILDS_KEY]: {
      ...(isJsonObject(state[RECORDED_BUILDS_KEY]) ? state[RECORDED_BUILDS_KEY] : {}),
      [key]: { ...build, builtAt: new Date().toISOString() },
    },
  }));
}

/** Callers must hold the workspace native-run lock, so no other build or recorded-build install is using a copy. */
export async function pruneArtifactCopies(
  root: string,
  platform: 'ios' | 'android' | 'macos',
  keep: string,
  warn: (line: string) => void,
): Promise<void> {
  const artifacts = join(workspaceDir(root), 'artifacts');
  const recorded = readWorkspaceState(root)?.[RECORDED_BUILDS_KEY];
  const kept = new Set([basename(keep)]);
  for (const entry of isJsonObject(recorded) ? Object.values(recorded) : [])
    if (isJsonObject(entry) && typeof entry.appPath === 'string') kept.add(basename(dirname(entry.appPath)));
  try {
    const entries = await readdir(artifacts, { withFileTypes: true });
    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && entry.name.startsWith(`${platform}-`) && !kept.has(entry.name))
        .map((entry) => rm(join(artifacts, entry.name), { recursive: true, force: true })),
    );
  } catch (error) {
    warn(`could not remove older app copies: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function readRecordedBuild(root: string, key: string): RecordedBuild | null {
  const recorded = readWorkspaceState(root)?.[RECORDED_BUILDS_KEY];
  const entry = isJsonObject(recorded) ? recorded[key] : null;
  if (!isJsonObject(entry) || typeof entry.appPath !== 'string' || !existsSync(entry.appPath)) return null;
  return {
    appPath: entry.appPath,
    bundleId: typeof entry.bundleId === 'string' ? entry.bundleId : null,
    builtAt: typeof entry.builtAt === 'string' ? entry.builtAt : '',
  };
}

const NO_RECORDED_BUILD = 'STIM_NO_RECORDED_BUILD';

export interface RecordedBuildRefusal {
  code: string;
  message: string;
  remedy: string;
}

export function lookupRecordedBuild(
  requested: boolean | undefined,
  root: string,
  selectors: { platform: 'ios' | 'android'; scheme?: string | null; configuration?: string | null },
): { build: RecordedBuild | null; refusal: RecordedBuildRefusal | null } {
  if (!requested) return { build: null, refusal: null };
  const build = readRecordedBuild(root, recordedBuildKey(selectors));
  if (build) return { build, refusal: null };
  const described = [selectors.scheme && `scheme ${selectors.scheme}`, selectors.configuration]
    .filter(Boolean)
    .join(', ');
  return {
    build: null,
    refusal: {
      code: NO_RECORDED_BUILD,
      message: `No recorded ${selectors.platform} build${described ? ` (${described})` : ''} exists for this checkout, so there is no app to install.`,
      remedy: 'Build the app first with the same selectors, then run again.',
    },
  };
}
