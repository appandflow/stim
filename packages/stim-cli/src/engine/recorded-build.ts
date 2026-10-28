import { existsSync } from 'node:fs';
import { isJsonObject } from '@stim-cli/core/state';
import { readWorkspaceState, updateWorkspaceState } from '../workspace/workspace-state.ts';

const RECORDED_BUILDS_KEY = 'recordedBuilds';

/** The app a finished `build` left in the workspace for `run` to install as is. */
export interface RecordedBuild {
  appPath: string;
  bundleId: string | null;
  builtAt: string;
}

/** Selectors a build and a run both resolve the same way; arch and ABI are not run selectors. */
export function recordedBuildKey(selectors: {
  platform: 'ios' | 'android';
  scheme?: string | null;
  configuration?: string | null;
}): string {
  return [selectors.platform, selectors.scheme ?? '', selectors.configuration ?? ''].join('|');
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

/** The recorded build for these selectors whose app is still on disk, else null. */
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

export const NO_RECORDED_BUILD = 'STIM_NO_RECORDED_BUILD';

export function noRecordedBuildFailure(
  platform: 'ios' | 'android',
  selectors: { scheme?: string | null; configuration?: string | null },
): {
  code: string;
  message: string;
  remedy: string;
  details: { platform: string; scheme: string | null; configuration: string | null };
} {
  const described = [
    selectors.scheme && `scheme ${selectors.scheme}`,
    selectors.configuration && selectors.configuration,
  ]
    .filter(Boolean)
    .join(', ');
  return {
    code: NO_RECORDED_BUILD,
    message: `No recorded ${platform} build${described ? ` (${described})` : ''} exists for this checkout, so there is no app to install.`,
    remedy: 'Build the app first with the same selectors, then run again.',
    details: { platform, scheme: selectors.scheme ?? null, configuration: selectors.configuration ?? null },
  };
}
