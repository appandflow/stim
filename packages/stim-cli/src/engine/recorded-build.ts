import { existsSync } from 'node:fs';
import { isJsonObject } from '@stim-cli/core/state';
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
