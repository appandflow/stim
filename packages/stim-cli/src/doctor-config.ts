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

export function checkMachineSettings({
  settings,
  layers,
  projectRoot,
  optimizations = null,
  reportedElsewhere = [],
  exists = existsSync,
}: {
  settings: SettingsObject;
  layers: SettingsLayer[];
  projectRoot: string;
  optimizations?: Optimizations | null;
  reportedElsewhere?: readonly string[];
  exists?: (path: string) => boolean;
}): Finding[] {
  const findings: Finding[] = [];

  for (const key of PATH_SETTINGS) {
    if (reportedElsewhere.includes(key)) continue;
    const entry = settingOrigin(layers, key);
    if (!entry || typeof entry.value !== 'string' || entry.value.trim() === '') continue;
    const value = entry.value.trim();
    const path = isAbsolute(value) ? value : resolve(projectRoot, value);
    if (exists(path)) continue;
    findings.push({
      level: 'note',
      title: 'A setting points at a path that is not there',
      detail:
        `${key} in ${entry.file} names ${path}, which does not exist. ` +
        'A command that reads it reports the missing file, not the setting that named it.',
      fix: `Point ${key} at the path it should name, or remove it from ${entry.file}.`,
    });
  }

  const fallback = optimizations?.android.compilerCacheFallback;
  const fallbackEntry = fallback ? settingOrigin(layers, fallback.key) : null;
  if (fallback && optimizations && (fallback.fromEnvironment || typeof fallbackEntry?.value === 'string')) {
    const companion = fallback.key === 'optimizations.android.compilerCache';
    findings.push({
      level: 'note',
      title: companion
        ? 'A setting needs a companion this config does not supply'
        : 'A setting holds a value Stim cannot use',
      detail: compilerCacheFallbackMessage({
        fallback,
        compilerCache: optimizations.android.compilerCache === 'none' ? 'none' : 'ccache',
        file: fallbackEntry?.file ?? null,
      }),
      fix: companion
        ? 'Set optimizations.android.casToolchain to the toolchain JSON manifest, or set optimizations.android.compilerCache to ccache.'
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
