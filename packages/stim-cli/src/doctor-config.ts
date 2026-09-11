import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { configCorruptRepair } from './config.ts';
import type { Finding } from './doctor.ts';
import { compilerCacheFallbackMessage, type Optimizations } from './optimizations.ts';
import {
  mergeSettingsLayers,
  PATH_SETTINGS,
  settingOrigin,
  settingsLayers,
  unknownSettingKeys,
  type SettingsLayer,
} from './settings.ts';
import type { SettingsObject } from './types.ts';

export interface MachineSettings {
  settings: SettingsObject;
  layers: SettingsLayer[];
  corrupt: Finding | null;
}

export function readMachineSettings(context: {
  projectPath?: string | null;
  gitCommonDir?: string | null;
  repoRoot?: string | null;
}): MachineSettings {
  try {
    const layers = settingsLayers(context);
    return { settings: mergeSettingsLayers(layers.map((layer) => layer.settings)), layers, corrupt: null };
  } catch (error) {
    if ((error as { code?: string }).code !== 'STIM_CONFIG_CORRUPT') throw error;
    return {
      settings: {},
      layers: [],
      corrupt: {
        level: 'note',
        title: 'The Stim config is not valid JSON',
        detail: `${String((error as Error).message).split('\n')[0]}. Every setting and device record lives in that file, so no other machine-level check can run until it parses.`,
        fix: configCorruptRepair(),
      },
    };
  }
}

const PATH_SETTING_ENVIRONMENT: Readonly<Record<string, string>> = {
  'optimizations.android.casToolchain': 'STIM_ANDROID_CAS_TOOLCHAIN',
};

export function checkMachineSettings({
  settings,
  layers,
  projectRoot,
  optimizations = null,
  reportedElsewhere = [],
  exists = existsSync,
  env = process.env,
}: {
  settings: SettingsObject;
  layers: SettingsLayer[];
  projectRoot: string;
  optimizations?: Optimizations | null;
  reportedElsewhere?: readonly string[];
  exists?: (path: string) => boolean;
  env?: NodeJS.ProcessEnv;
}): Finding[] {
  const findings: Finding[] = [];

  const fallback = optimizations?.android.compilerCacheFallback ?? null;
  const fallbackEntry = fallback ? settingOrigin(layers, fallback.key) : null;
  const reported = fallback && (fallback.fromEnvironment || fallbackEntry) ? fallback : null;
  const skip = new Set(reportedElsewhere);
  if (reported) skip.add(reported.key);

  for (const key of PATH_SETTINGS) {
    const variable = PATH_SETTING_ENVIRONMENT[key];
    if (skip.has(key) || (variable && skip.has(variable))) continue;
    const override = variable ? env[variable] : undefined;
    if (variable && override) {
      const named = missingPath(override, projectRoot, exists);
      if (named)
        findings.push({
          level: 'note',
          title: 'An environment variable points at a path that is not there',
          detail: `${variable} in the environment names ${named}, which does not exist.`,
          fix: `Point ${variable} at the path it should name, or unset it.`,
        });
      continue;
    }
    const entry = settingOrigin(layers, key);
    if (!entry || typeof entry.value !== 'string') continue;
    const named = missingPath(entry.value, projectRoot, exists);
    if (!named) continue;
    findings.push({
      level: 'note',
      title: 'A setting points at a path that is not there',
      detail: `${key} in ${entry.file} names ${named}, which does not exist.`,
      fix: `Point ${key} at the path it should name, or remove it from ${entry.file}.`,
    });
  }

  if (reported && optimizations) {
    const companion = reported.key === 'optimizations.android.compilerCache';
    findings.push({
      level: 'note',
      title: companion
        ? 'A setting needs a companion this config does not supply'
        : reported.fromEnvironment
          ? 'An environment variable holds a value Stim cannot use'
          : 'A setting holds a value Stim cannot use',
      detail: compilerCacheFallbackMessage({
        fallback: reported,
        compilerCache: optimizations.android.compilerCache === 'none' ? 'none' : 'ccache',
        file: fallbackEntry?.file ?? null,
      }),
      fix: companion
        ? 'Set optimizations.android.casToolchain to the toolchain JSON manifest, or set optimizations.android.compilerCache to ccache.'
        : reported.fromEnvironment
          ? 'Point STIM_ANDROID_CAS_TOOLCHAIN at an absolute path to the toolchain JSON manifest, or unset it.'
          : 'Set optimizations.android.casToolchain to an absolute path to the toolchain JSON manifest, or remove it.',
    });
  }

  for (const key of unknownSettingKeys(settings)) {
    const file = settingOrigin(layers, key)?.file ?? null;
    findings.push({
      level: 'note',
      title: 'A key in the config is inert',
      detail: `${key}${file ? ` in ${file}` : ''} is not read by Stim, so its value changes nothing.`,
      fix: `Remove ${key}${file ? ` from ${file}` : ''}, or run \`stim guide settings\` for the name that replaced it.`,
    });
  }

  return findings;
}

function missingPath(value: string, projectRoot: string, exists: (path: string) => boolean): string | null {
  if (value.trim() === '') return null;
  const path = isAbsolute(value) ? value : resolve(projectRoot, value);
  if (exists(path)) return null;
  return value === value.trim() ? path : JSON.stringify(path);
}
