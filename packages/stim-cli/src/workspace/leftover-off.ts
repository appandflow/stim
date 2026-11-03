import { LEFTOVER_OFF, loadConfig, settingDefinition } from '@stim-cli/core/state';
import { GOVERNED_COMMANDS } from '../daemon/mode.ts';
import { findProjectRoot } from './project.ts';
import { projectSettingsContext, settingsLayers, settingValueAt, type SettingsLayer } from './settings.ts';

export interface LeftoverOff {
  key: string;
  file: string;
  message: string;
  remedy: string;
}

/**
 * The old values in `layers` that turned a mechanism off and would now leave it at a default that acts. `machine` is
 * the machine config, which holds the machine-only settings no layer carries.
 */
export function leftoverOffSettings(layers: readonly SettingsLayer[], machine: unknown): LeftoverOff[] {
  return Object.entries(LEFTOVER_OFF).flatMap(([key, rule]) => {
    const settled = [machine, ...layers.map((layer) => layer.settings)].some(
      (settings) => settingValueAt(settings, rule.key) !== undefined,
    );
    if (rule.kept && settled) return [];
    const target = settingDefinition(rule.key);
    return layers.flatMap((layer) => {
      if (!rule.scopes.includes(layer.scope)) return [];
      const value = settingValueAt(layer.settings, key);
      const off = value === undefined ? null : rule.off(value);
      if (off === null) return [];
      const scope =
        target && target.scopes.length > 1 && target.scopes.includes(layer.scope) ? ` --scope ${layer.scope}` : '';
      const set = `stim settings set ${rule.key} ${off}${scope}`;
      const shown = `${key} ${JSON.stringify(value)} in ${layer.file}`;
      const fallback = `${rule.key} would apply at its default (${String(target?.default)})`;
      return [
        rule.kept
          ? {
              key,
              file: layer.file,
              message: `${shown} ${rule.kept}, so ${fallback}; ${rule.key} ${off} keeps what it did.`,
              remedy: `Run \`${set}\` to keep it, or \`stim settings unset ${key} --scope ${layer.scope}\` to take the default.`,
            }
          : {
              key,
              file: layer.file,
              message: `${shown} is no longer read by Stim, so ${fallback}; ${rule.key} ${off} keeps what it did.`,
              remedy: `Run \`${set}\`, then \`stim settings unset ${key}\`.`,
            },
      ];
    });
  });
}

/**
 * The refusal for a command the daemon, the pressure ladder or automatic maintenance governs while a config layer it
 * loads from `cwd` still holds an old value that turned one of them off; null otherwise, and when the config cannot
 * be read, which the command reports itself.
 */
export function leftoverOffRefusal(
  command: string,
  cwd: string = process.cwd(),
): { code: 'STIM_BAD_ARG'; message: string; remedy: string } | null {
  if (!GOVERNED_COMMANDS.has(command)) return null;
  let found: LeftoverOff[];
  try {
    const root = findProjectRoot(cwd);
    found = leftoverOffSettings(settingsLayers(root ? projectSettingsContext(root) : {}), loadConfig());
  } catch {
    return null;
  }
  if (!found.length) return null;
  return {
    code: 'STIM_BAD_ARG',
    message: found.map((entry) => entry.message).join(' '),
    remedy: `${found.map((entry) => entry.remedy).join(' ')} Then run the command again.`,
  };
}
