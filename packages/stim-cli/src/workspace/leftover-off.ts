import { LEFTOVER_OFF, loadConfig, settingDefinition } from '@stim-cli/core/state';
import { GOVERNED_COMMANDS } from '../daemon/mode.ts';
import { getConfigPath } from './config.ts';
import { findProjectRoot } from './project.ts';
import { projectSettingsContext, settingsLayers, settingValueAt, type SettingsLayer } from './settings.ts';

export interface LeftoverOff {
  key: string;
  file: string;
  title: string;
  message: string;
  /** Whether start, ios, android, web, macos, revive and gc refuse while it is there; doctor reports every one. */
  refuses: boolean;
  /** The command that keeps the old behavior through the replacement, or null when a layer already sets it. */
  set: string | null;
  unset: string;
  remedy: string;
}

/** Where the replacement `key` is set and to what, as `from <variable>` or `in <file>`. */
function appliedValue(
  key: string,
  layers: readonly SettingsLayer[],
  machine: unknown,
  env: NodeJS.ProcessEnv,
): { value: unknown; where: string } | null {
  const variable = settingDefinition(key)?.env;
  const fromEnv = variable ? env[variable]?.trim() : undefined;
  if (variable && fromEnv) return { value: fromEnv, where: `from ${variable}` };
  for (const layer of layers) {
    const value = settingValueAt(layer.settings, key);
    if (value !== undefined) return { value, where: `in ${layer.file}` };
  }
  const value = settingValueAt(machine, key);
  if (value === undefined) return null;
  return { value, where: `in ${layers.find((layer) => layer.scope === 'machine')?.file ?? getConfigPath()}` };
}

/**
 * The old values in `layers` that turned a mechanism off and would now leave it at a default that acts. `machine` is
 * the machine config, which holds the machine-only settings no layer carries.
 */
export function leftoverOffSettings(
  layers: readonly SettingsLayer[],
  machine: unknown,
  env: NodeJS.ProcessEnv,
): LeftoverOff[] {
  return Object.entries(LEFTOVER_OFF).flatMap(([key, rule]) => {
    const applied = appliedValue(rule.key, layers, machine, env);
    if (rule.kept && applied) return [];
    const target = settingDefinition(rule.key);
    const fallback = String(target?.default);
    return layers.flatMap((layer): LeftoverOff[] => {
      if (!rule.scopes.includes(layer.scope)) return [];
      const value = settingValueAt(layer.settings, key);
      const off = value === undefined ? null : rule.off(value);
      if (off === null) return [];
      const scope =
        target && target.scopes.length > 1 && target.scopes.includes(layer.scope) ? ` --scope ${layer.scope}` : '';
      const shown = `${key} ${JSON.stringify(value)} in ${layer.file}`;
      if (rule.kept) {
        const unset = `stim settings unset ${key} --scope ${layer.scope}`;
        return [
          {
            key,
            file: layer.file,
            title: `${key} ${rule.kept}`,
            message: `${shown} ${rule.kept}, so ${rule.key} applies at its default (${fallback}).`,
            refuses: false,
            set: null,
            unset,
            remedy: `Run \`stim settings set ${rule.key} ${off}${scope}\` to turn ${rule.key} off too, \`stim settings set ${rule.key} ${fallback}${scope}\` to keep ${rule.key} at its default and ${key} at ${JSON.stringify(value)}, or \`${unset}\` to put ${key} back to its default.`,
          },
        ];
      }
      const unset = `stim settings unset ${key}`;
      const set = applied ? null : `stim settings set ${rule.key} ${off}${scope}`;
      return [
        {
          key,
          file: layer.file,
          title: `${key} in the config turned off what Stim now does by default`,
          message: applied
            ? `${shown} is no longer read by Stim; ${rule.key} is ${JSON.stringify(applied.value)} ${applied.where}.`
            : `${shown} is no longer read by Stim, so ${rule.key} would apply at its default (${fallback}); ${rule.key} ${off} keeps what it did.`,
          refuses: true,
          set,
          unset,
          remedy: set ? `Run \`${set}\`, then \`${unset}\`.` : `Run \`${unset}\`.`,
        },
      ];
    });
  });
}

/**
 * The refusal for a command the daemon, the pressure ladder or automatic maintenance governs while a config layer it
 * loads from `cwd` still holds a removed setting's old value that turned one of them off; null otherwise, and when the
 * config cannot be read, which the command reports itself.
 */
export function leftoverOffRefusal(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): { code: 'STIM_BAD_ARG'; message: string; remedy: string } | null {
  if (!GOVERNED_COMMANDS.has(command)) return null;
  let found: LeftoverOff[];
  try {
    const root = findProjectRoot(cwd);
    found = leftoverOffSettings(settingsLayers(root ? projectSettingsContext(root) : {}), loadConfig(), env).filter(
      (entry) => entry.refuses,
    );
  } catch {
    return null;
  }
  if (!found.length) return null;
  const steps = [
    ...new Set([...found.flatMap((entry) => (entry.set ? [entry.set] : [])), ...found.map((entry) => entry.unset)]),
  ];
  return {
    code: 'STIM_BAD_ARG',
    message: found.map((entry) => entry.message).join(' '),
    remedy: `Run, in order: ${steps.map((step) => `\`${step}\``).join(', ')}. Then run the command again.`,
  };
}
