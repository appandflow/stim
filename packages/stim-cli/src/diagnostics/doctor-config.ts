import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { configCorruptRepair } from '../workspace/config.ts';
import type { Finding } from './doctor.ts';
import { configSettingRefusal, envSettingRefusal } from '../workspace/settings-payload.ts';
import { compilerCacheFallbackMessage, type CompilerCacheFallback, type Optimizations } from '../optimizations.ts';
import {
  mergeSettingsLayers,
  removedSettingFindings,
  PATH_SETTINGS,
  readCommittedSettings,
  SETTINGS_WITH_RESOLVE_TIME_FALLBACK,
  settingOrigin,
  settingsLayers,
  settingValueAt,
  unknownSettingKeys,
  type SettingsLayer,
} from '../workspace/settings.ts';
import { REMOVED_SETTINGS, replacementAdvice, settingDefinition, type SettingsObject } from '@stim-cli/core/state';

export interface MachineSettings {
  settings: SettingsObject;
  layers: SettingsLayer[];
  repositoryLayer?: SettingsLayer | null;
  corrupt: Finding | null;
}

export function readMachineSettings(context: {
  projectPath?: string | null;
  gitCommonDir?: string | null;
  repoRoot?: string | null;
}): MachineSettings {
  try {
    const layers = settingsLayers(context);
    const repositoryLayer =
      context.projectPath && context.repoRoot && context.repoRoot !== context.projectPath
        ? {
            scope: 'committed' as const,
            file: join(context.repoRoot, '.stim.json'),
            settings: readCommittedSettings(context.repoRoot),
          }
        : null;
    return {
      settings: mergeSettingsLayers(layers.map((layer) => layer.settings)),
      layers,
      repositoryLayer,
      corrupt: null,
    };
  } catch (error) {
    if ((error as { code?: string }).code !== 'STIM_CONFIG_CORRUPT') throw error;
    return {
      settings: {},
      layers: [],
      corrupt: {
        level: 'note',
        title: 'The Stim config is not a valid JSON object',
        detail: `${String((error as Error).message).split('\n')[0]}. Every setting and device record lives in that file, so no other machine-level check can run until it parses.`,
        fix: configCorruptRepair(),
      },
    };
  }
}

const PATH_SETTINGS_TRIMMED_BY_THEIR_CONSUMER: ReadonlySet<string> = new Set(['android.keystore']);

export function checkMachineSettings({
  settings,
  layers,
  repositoryLayer = null,
  projectRoot,
  optimizations = null,
  reportedElsewhere = [],
  exists = existsSync,
  env = process.env,
  remoteBuild,
  machineConfig = null,
}: {
  settings: SettingsObject;
  layers: SettingsLayer[];
  repositoryLayer?: SettingsLayer | null;
  projectRoot: string;
  optimizations?: Optimizations | null;
  reportedElsewhere?: readonly string[];
  exists?: (path: string) => boolean;
  env?: NodeJS.ProcessEnv;
  remoteBuild?: unknown;
  /** The machine config, for the machine-only settings no layer carries. */
  machineConfig?: unknown;
}): Finding[] {
  const findings: Finding[] = [];

  const fallback = optimizations?.android.compilerCacheFallback ?? null;
  const fallbackEntry = fallback ? settingOrigin(layers, fallback.key) : null;
  const attributed = fallback && (fallback.fromEnvironment || fallbackEntry) ? fallback : null;
  const reported = attributed?.manifest && !exists(attributed.manifest) ? null : attributed;
  const skip = new Set(reportedElsewhere);
  if (reported) skip.add(reported.key);
  if (!optimizations) for (const key of SETTINGS_WITH_RESOLVE_TIME_FALLBACK) skip.add(key);

  for (const key of PATH_SETTINGS) {
    const variable = settingDefinition(key)?.env;
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
    const named = missingPath(entry.value, projectRoot, exists, PATH_SETTINGS_TRIMMED_BY_THEIR_CONSUMER.has(key));
    if (!named) continue;
    findings.push({
      level: 'note',
      title: 'A setting points at a path that is not there',
      detail: `${key} in ${entry.file} names ${named}, which does not exist.`,
      fix: `Point ${key} at the path it should name, or remove it from ${entry.file}.`,
    });
  }

  if (reported && optimizations) {
    findings.push(compilerCacheFinding({ fallback: reported, optimizations, file: fallbackEntry?.file ?? null }));
  }

  const leftovers = removedSettingFindings(layers, machineConfig, env);
  for (const leftover of leftovers)
    findings.push({
      level: 'cost',
      title: leftover.title,
      detail: leftover.refuses
        ? `${leftover.message} start, ios, android, web, macos, revive and gc refuse to run while it is there.`
        : leftover.message,
      fix: leftover.remedy,
    });

  const holders = repositoryLayer ? [...layers, repositoryLayer] : layers;
  const unknownKeys = new Set([
    ...unknownSettingKeys(settings),
    ...(repositoryLayer ? unknownSettingKeys(repositoryLayer.settings) : []),
  ]);
  for (const key of unknownKeys) {
    for (const holder of holders.filter((layer) => settingValueAt(layer.settings, key) !== undefined)) {
      const file = holder.file;
      if (leftovers.some((leftover) => leftover.key === key && leftover.file === file)) continue;
      findings.push({
        level: 'note',
        title: 'A key in the config is inert',
        detail: `${key} in ${file} is not read by Stim, so its value changes nothing.`,
        fix: `Remove ${key} from ${file}.`,
      });
    }
  }

  const buildValueRefusal = configSettingRefusal('remote.build', remoteBuild);
  if (buildValueRefusal)
    findings.push({
      level: 'cost',
      title: 'A setting has the wrong type',
      detail: buildValueRefusal.message,
      fix: buildValueRefusal.remedy,
    });
  const buildEnvRefusal = envSettingRefusal('remote.build', env);
  if (buildEnvRefusal)
    findings.push({
      level: 'cost',
      title: 'A setting has the wrong type',
      detail: buildEnvRefusal.message,
      fix: buildEnvRefusal.remedy,
    });

  for (const [key, replaced] of REMOVED_SETTINGS) {
    const name = replaced.env;
    if (!name || !env[name]?.trim()) continue;
    const raw = (env[name] ?? '').trim();
    const advice = replacementAdvice(key, /^\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw);
    const instead = replaced.key ? settingDefinition(replaced.key)?.env : undefined;
    const refusal = replaced.refuses
      ? ' start, ios, android, web, macos, revive and gc refuse to run while it is set.'
      : '';
    findings.push({
      level: replaced.refuses ? 'cost' : 'note',
      title: replaced.key ? `${name} was replaced by ${replaced.key}` : `${name} is no longer read by Stim`,
      detail: replaced.key
        ? `${name} is not read by Stim, so ${replaced.key} applies, at its default until you set it.${refusal}`
        : `${name} sets ${key}, which is no longer read by Stim: ${replaced.replacement}.${refusal}`,
      fix: replaced.key
        ? `${advice?.command ? `Run \`${advice.command}\`` : `Set ${replaced.key}`}${replaced.refuses && instead ? ` or set ${instead}` : ''}, then unset ${name}.`
        : `Unset ${name}.`,
    });
  }

  return findings;
}

function compilerCacheFinding({
  fallback,
  optimizations,
  file,
}: {
  fallback: CompilerCacheFallback;
  optimizations: Optimizations;
  file: string | null;
}): Finding {
  const detail = compilerCacheFallbackMessage({
    fallback,
    compilerCache: optimizations.android.compilerCache === 'none' ? 'none' : 'ccache',
    file,
  });
  if (fallback.key === 'optimizations.android.compilerCache')
    return {
      level: 'note',
      title: 'A setting needs a companion this config does not supply',
      detail,
      fix: 'Set optimizations.android.casToolchain to the toolchain JSON manifest, or set optimizations.android.compilerCache to ccache.',
    };
  const title = fallback.fromEnvironment
    ? 'An environment variable holds a value Stim cannot use'
    : 'A setting holds a value Stim cannot use';
  if (fallback.manifest)
    return {
      level: 'note',
      title,
      detail,
      fix: `Repair ${fallback.manifest}, or ${fallback.fromEnvironment ? `unset ${fallback.key}` : `remove ${fallback.key}${file ? ` from ${file}` : ''}`}.`,
    };
  return {
    level: 'note',
    title,
    detail,
    fix: fallback.fromEnvironment
      ? 'Point STIM_ANDROID_CAS_TOOLCHAIN at an absolute path to the toolchain JSON manifest, or unset it.'
      : 'Set optimizations.android.casToolchain to an absolute path to the toolchain JSON manifest, or remove it.',
  };
}

function missingPath(
  value: string,
  projectRoot: string,
  exists: (path: string) => boolean,
  trim = false,
): string | null {
  const opened = trim ? value.trim() : value;
  if (opened.trim() === '') return null;
  const path = isAbsolute(opened) ? opened : resolve(projectRoot, opened);
  if (exists(path)) return null;
  return opened === opened.trim() ? path : JSON.stringify(path);
}
