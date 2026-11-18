import {
  loadConfig,
  leftoverDaemonMode,
  REMOVED_SETTINGS,
  settingDefinition,
  type Config,
  type DaemonMode,
} from '@stim-cli/core/state';

const MODE = settingDefinition('daemon.mode');

const DAEMON_MODES: readonly DaemonMode[] = ['on', 'report', 'off'];

export function parseDaemonMode(value: unknown): DaemonMode | null {
  return DAEMON_MODES.find((mode) => mode === value) ?? null;
}

/** `daemon.mode` in `config`, else the `off` or `report` a 1.x `maintenance.mode` left in it, else null. */
function machineDaemonMode(config: Config | null | undefined): DaemonMode | null {
  return parseDaemonMode(config?.daemon?.mode) ?? leftoverDaemonMode(config, {});
}

/** The machine setting `daemon.mode`, else a leftover `maintenance.mode`, or null when neither is usable. */
export function configuredDaemonMode(): DaemonMode | null {
  try {
    return machineDaemonMode(loadConfig());
  } catch {
    return null;
  }
}

/** The cap a leftover `maintenance.mode` puts on a stimd that neither `STIM_DAEMON` nor `daemon.mode` governs. */
export function leftoverDaemonCap(env: NodeJS.ProcessEnv = process.env): DaemonMode | null {
  try {
    return leftoverDaemonMode(loadConfig(), env);
  } catch {
    return null;
  }
}

/** Whichever of two modes acts less: off, then report, then on. */
export function stricterDaemonMode(a: DaemonMode, b: DaemonMode): DaemonMode {
  return DAEMON_MODES.indexOf(a) >= DAEMON_MODES.indexOf(b) ? a : b;
}

/** `daemon.mode` from `STIM_DAEMON` in `env`, else off in CI, else the machine setting in `config`, else on. */
export function daemonMode(env: NodeJS.ProcessEnv = process.env, config?: Config | null): DaemonMode {
  const fromEnv = MODE?.env ? parseDaemonMode(env[MODE.env]) : null;
  if (fromEnv) return fromEnv;
  if (env.CI) return 'off';
  return (config === undefined ? configuredDaemonMode() : machineDaemonMode(config)) ?? 'on';
}

/** Whether this command may start stimd: `daemon.mode` is not off. */
export function spawnsDaemon(env: NodeJS.ProcessEnv = process.env): boolean {
  return daemonMode(env) !== 'off';
}

export const GOVERNED_COMMANDS: ReadonlySet<string> = new Set([
  'start',
  'ios',
  'android',
  'web',
  'macos',
  'revive',
  'gc',
]);

/**
 * The refusal for a command the daemon, the pressure ladder or automatic maintenance governs while the environment
 * still sets a removed setting's variable, such as `STIM_MAINTENANCE`, naming what replaced each; null otherwise.
 */
export function removedEnvironmentRefusal(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): { code: 'STIM_BAD_ARG'; message: string; remedy: string } | null {
  if (!GOVERNED_COMMANDS.has(command)) return null;
  const found = [...REMOVED_SETTINGS].flatMap(([key, replaced]) =>
    replaced.refuses && replaced.env && env[replaced.env]?.trim() ? [{ key, env: replaced.env, replaced }] : [],
  );
  if (!found.length) return null;
  const replaced = found.map(({ key, env: name, replaced: entry }) => {
    const target = entry.key ? settingDefinition(entry.key) : null;
    const instead = target?.env ? `${target.env} (${entry.replacement})` : entry.replacement;
    return `${name} (${key}) was removed; use ${instead}`;
  });
  return {
    code: 'STIM_BAD_ARG',
    message: `${replaced.join('. ')}.`,
    remedy: `Unset ${found.map(({ env: name }) => name).join(', ')}, then run the command again; \`stim guide settings\` lists what replaced each.`,
  };
}
